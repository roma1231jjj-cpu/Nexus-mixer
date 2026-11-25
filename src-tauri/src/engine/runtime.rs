//! WASAPI backend: capture threads → ring buffers → mixer graph → playback.
//!
//! One output stream is the clock master. Its callback pulls one stereo frame
//! from every input ring, runs the graph once, writes its own bus directly and
//! forwards the other buses through per-bus rings to follower output streams.
//! This keeps a single graph instance and a single clock, which matters because
//! WASAPI callbacks run on independent threads.
//!
//! Endpoints that do not expose F32 are opened with the raw stream API and
//! converted per block; endpoints that cannot run the master rate are
//! resampled. Both conversions happen in preallocated scratch buffers, and the
//! resampler step is trimmed from the measured ring occupancy so two hardware
//! clocks cannot drift into an XRUN over a long session.
//!
//! All heap allocation happens before `Stream::play()`; the callbacks only
//! touch atomics, rings and preallocated DSP state.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, InputCallbackInfo, OutputCallbackInfo, SampleFormat, SampleRate, Stream,
    StreamConfig, SupportedStreamConfig, SupportedStreamConfigRange,
};
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use serde::Serialize;

use super::ai::AiClient;
use super::ai_audio::{AiAudioState, AiEngine, AiTelemetry};
use super::buffer::SpscRing;
use super::devices;
use super::dsp::{DriftControl, StereoResampler};
use super::graph::{
    GraphParams, MeterBank, MeterLevels, MixerGraph, MixerParams, BUSES, BUS_IDS, STRIPS, STRIP_IDS,
};
use super::model::EngineConfig;
use super::pads::{PadBank, PadRenderer};
use super::recorder::{RecorderHandle, RecorderParams, RecorderRing, RecorderStatus, TAP_CHANNELS};

// ---------------------------------------------------------------------------
// Stats & info
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct EngineStats {
    underruns: AtomicU64,
    /// Smoothed callback period in frames, measured from WASAPI timestamps.
    /// Zero until the first two callbacks have happened.
    period_frames: AtomicU64,
    overruns: AtomicU64,
    frames: AtomicU64,
    /// DSP load in parts-per-million of the callback deadline (100% = 1_000_000).
    cpu_ppm: AtomicU64,
}

impl EngineStats {
    pub fn xruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed) + self.overruns.load(Ordering::Relaxed)
    }

    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }

    /// Actual callback period the device is running at. `None` before the
    /// second callback, or when the device rejected a fixed buffer and we have
    /// not measured it yet.
    pub fn period_frames(&self) -> Option<u32> {
        let value = self.period_frames.load(Ordering::Relaxed);
        if value == 0 {
            None
        } else {
            Some(value.min(u32::MAX as u64) as u32)
        }
    }

    pub fn cpu_percent(&self) -> f32 {
        self.cpu_ppm.load(Ordering::Relaxed) as f32 / 10_000.0
    }

    /// Drop counters collected while the graph was being opened. Starting a
    /// dozen endpoints takes longer than one callback period, so those warmup
    /// underruns are not audible and must not look like a broken stream.
    pub fn reset(&self) {
        self.underruns.store(0, Ordering::Relaxed);
        self.overruns.store(0, Ordering::Relaxed);
        self.frames.store(0, Ordering::Relaxed);
        self.cpu_ppm.store(0, Ordering::Relaxed);
        self.period_frames.store(0, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub input_streams: usize,
    pub output_streams: usize,
    pub warnings: Vec<String>,
    pub buffer_fallback: bool,
}

impl RuntimeInfo {
    pub fn latency_ms(&self) -> f32 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.buffer_size as f32 / self.sample_rate as f32 * 1000.0
    }
}

// ---------------------------------------------------------------------------
// Engine runtime handle
// ---------------------------------------------------------------------------

pub struct EngineRuntime {
    stop_tx: Sender<()>,
    params_tx: Sender<GraphParams>,
    meters: Arc<MeterBank>,
    stats: Arc<EngineStats>,
    recorder: RecorderHandle,
    info: RuntimeInfo,
    thread: Option<JoinHandle<()>>,
    ai_engine: AiEngine,
}

impl EngineRuntime {
    /// Build the streams on a dedicated thread and wait until they are playing.
    ///
    /// `snapshot` is the JSON published by the UI (`MixerParams` shape). `ai` is
    /// the control-plane client shared with the UI, so the realtime AI path and
    /// the AI panel talk through one connection.
    pub fn start(
        config: &EngineConfig,
        snapshot: &serde_json::Value,
        ai: Arc<AiClient>,
        pads: Arc<PadBank>,
    ) -> Result<Self> {
        let params: MixerParams = if snapshot.is_null() {
            MixerParams::default()
        } else {
            serde_json::from_value(snapshot.clone()).context("invalid mixer snapshot")?
        };

        let initial = params.to_graph();
        let plan = DevicePlan::from_params(&params);
        let recorder_params = params.recorder.clone();
        let config = config.clone();
        let recorder = RecorderHandle::new(config.sample_rate);
        let recorder_tap = recorder.tap();

        let ai_params = super::ai_audio::params_from_snapshot(snapshot, config.sample_rate);
        let dry_ai = Arc::new(SpscRing::new(
            ((config.sample_rate as usize) / 10).max(512) * 2,
        ));
        let wet_ai = Arc::new(SpscRing::new(
            ((config.sample_rate as usize) / 10).max(1024) * 4,
        ));
        let ai_engine = AiEngine::spawn(
            dry_ai.clone(),
            wet_ai.clone(),
            ai,
            ai_params,
            config.sample_rate,
        );
        let ai_state = ai_engine.state(dry_ai, wet_ai);

        let (ready_tx, ready_rx) = bounded::<Result<RuntimeInfo, String>>(1);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let (params_tx, params_rx) = bounded::<GraphParams>(32);

        // One receiver per engine start: stopping the engine closes the
        // sender, so pad commands fail honestly instead of piling up.
        let pad_renderer = PadRenderer::new(pads.attach(), config.sample_rate as f32);
        let meters = Arc::new(MeterBank::new());
        let stats = Arc::new(EngineStats::default());
        let thread_meters = Arc::clone(&meters);
        let thread_stats = Arc::clone(&stats);

        let thread = std::thread::Builder::new()
            .name("nexus-audio".into())
            .spawn(move || {
                match build_engine(
                    &config,
                    initial,
                    EngineBuild {
                        pads: pad_renderer,
                        plan,
                        params_rx,
                        meters: thread_meters,
                        stats: thread_stats,
                        recorder_tap,
                        ai: Some(ai_state),
                    },
                ) {
                    Ok((streams, info)) => {
                        let _ = ready_tx.send(Ok(info));
                        // Keep the streams alive until stop is requested.
                        let _ = stop_rx.recv();
                        drop(streams);
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("{error:#}")));
                    }
                }
            })
            .context("failed to spawn the audio thread")?;

        match ready_rx.recv_timeout(Duration::from_secs(45)) {
            Ok(Ok(info)) => {
                recorder.set_sample_rate(info.sample_rate);
                recorder.configure(recorder_params);
                Ok(Self {
                    stop_tx,
                    params_tx,
                    meters,
                    stats,
                    recorder,
                    info,
                    thread: Some(thread),
                    ai_engine,
                })
            }
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(anyhow!(message))
            }
            Err(_) => {
                // The thread may still be probing a stuck endpoint. Dropping the
                // sender makes its `recv()` return immediately once it gets there.
                drop(stop_tx);
                Err(anyhow!("audio engine did not start within 45 seconds"))
            }
        }
    }

    /// Publish new graph parameters. Never blocks the UI: if the queue is full,
    /// the update is dropped and the next one will be applied.
    pub fn send_params(&self, params: GraphParams) {
        let _ = self.params_tx.try_send(params);
    }

    /// Re-arm the realtime AI path from a UI snapshot without restarting the
    /// streams. Called on every mixer state publish, so toggling the AI stage or
    /// changing model parameters takes effect immediately.
    pub fn publish_ai(&self, snapshot: &serde_json::Value) {
        let params = super::ai_audio::params_from_snapshot(snapshot, self.info.sample_rate);
        self.ai_engine.arm(params.enabled, params);
    }

    pub fn ai_telemetry(&self) -> AiTelemetry {
        self.ai_engine.telemetry(self.info.sample_rate, 0)
    }

    pub fn meters(&self) -> MeterLevels {
        self.meters.snapshot()
    }

    pub fn info(&self) -> &RuntimeInfo {
        &self.info
    }

    pub fn stats(&self) -> &EngineStats {
        &self.stats
    }

    pub fn set_recorder(&self, params: RecorderParams) {
        self.recorder.configure(params);
    }

    pub fn recorder_status(&self) -> RecorderStatus {
        self.recorder.status()
    }
}

impl Drop for EngineRuntime {
    fn drop(&mut self) {
        let _ = self.stop_tx.try_send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Device plan
// ---------------------------------------------------------------------------

struct DevicePlan {
    inputs: [Option<String>; STRIPS],
    outputs: [Option<String>; BUSES],
}

/// Everything the audio thread needs besides the config and graph snapshot.
struct EngineBuild {
    pads: PadRenderer,
    plan: DevicePlan,
    params_rx: Receiver<GraphParams>,
    meters: Arc<MeterBank>,
    stats: Arc<EngineStats>,
    recorder_tap: Arc<RecorderRing>,
    ai: Option<AiAudioState>,
}

impl DevicePlan {
    fn from_params(params: &MixerParams) -> Self {
        Self {
            inputs: std::array::from_fn(|index| {
                params
                    .strips
                    .get(STRIP_IDS[index])
                    .map(|strip| strip.device_id.clone())
                    .filter(|id| !id.is_empty())
            }),
            outputs: std::array::from_fn(|index| {
                params
                    .buses
                    .get(BUS_IDS[index])
                    .map(|bus| bus.device_id.clone())
                    .filter(|id| !id.is_empty())
            }),
        }
    }
}

struct ResolvedOutput {
    bus: usize,
    device: cpal::Device,
    name: String,
}

// ---------------------------------------------------------------------------
// Stream construction
// ---------------------------------------------------------------------------

fn stream_error(error: cpal::StreamError) {
    tracing::error!(%error, "audio stream error");
    eprintln!("[stream_error] {}", error);
}

fn find_device(host: &cpal::Host, raw: &str, input: bool) -> Option<cpal::Device> {
    let devices: Vec<cpal::Device> = if input {
        host.input_devices().ok()?.collect()
    } else {
        host.output_devices().ok()?.collect()
    };
    let names: Vec<String> = devices
        .iter()
        .map(|device| device.name().unwrap_or_default())
        .collect();
    // `raw` is the id without its `in:`/`out:` prefix, so two endpoints with the
    // same friendly name stay distinguishable through the `#N` suffix.
    let index = devices::match_name(&names, raw)?;
    devices.into_iter().nth(index)
}

/// Score of a supported range. Higher is better: an exact sample rate beats a
/// different one, F32 beats a format that needs conversion, stereo beats mono.
/// `None` when the format cannot be converted to or from f32 at all.
fn range_score(range: &SupportedStreamConfigRange, sample_rate: u32) -> Option<u32> {
    if !convertible(range.sample_format()) {
        return None;
    }
    let covers =
        sample_rate >= range.min_sample_rate().0 && sample_rate <= range.max_sample_rate().0;
    let rate = if covers { 1_000 } else { 0 };
    let format = if range.sample_format() == SampleFormat::F32 {
        100
    } else {
        0
    };
    let channels = match range.channels() {
        2 => 30,
        1 => 20,
        _ => 10,
    };
    Some(rate + format + channels)
}

/// Best convertible config for `sample_rate`.
///
/// With `exact_only` any range that does not cover the requested rate is
/// rejected. Otherwise the closest rate the device does support is used and the
/// caller has to resample — that is what keeps a 44.1 kHz capture pin in the
/// graph instead of silently dropping the channel.
fn pick_config(
    device: &cpal::Device,
    sample_rate: u32,
    input: bool,
    exact_only: bool,
) -> Option<SupportedStreamConfig> {
    let ranges: Vec<SupportedStreamConfigRange> = if input {
        device.supported_input_configs().ok()?.collect()
    } else {
        device.supported_output_configs().ok()?.collect()
    };
    let mut best: Option<(u32, u32, SupportedStreamConfigRange)> = None;
    for range in ranges {
        let Some(score) = range_score(&range, sample_rate) else {
            continue;
        };
        let covers =
            sample_rate >= range.min_sample_rate().0 && sample_rate <= range.max_sample_rate().0;
        if exact_only && !covers {
            continue;
        }
        let rate = sample_rate.clamp(range.min_sample_rate().0, range.max_sample_rate().0);
        let distance = rate.abs_diff(sample_rate);
        let better = match &best {
            None => true,
            Some((best_score, best_distance, _)) => {
                score > *best_score || (score == *best_score && distance < *best_distance)
            }
        };
        if better {
            best = Some((score, distance, range));
        }
    }
    let (_, _, range) = best?;
    let rate = sample_rate.clamp(range.min_sample_rate().0, range.max_sample_rate().0);
    // `with_sample_rate` panics on an out-of-range rate; the clamp above makes
    // that impossible, and the checked variant keeps it impossible if the host
    // reports inconsistent bounds.
    range.try_with_sample_rate(SampleRate(rate))
}

/// Config at exactly `sample_rate`; the clock master must not be resampled.
fn pick_config_at(
    device: &cpal::Device,
    sample_rate: u32,
    input: bool,
) -> Option<SupportedStreamConfig> {
    pick_config(device, sample_rate, input, true)
}

/// Best config at any rate. Used for follower endpoints and for captures that
/// cannot follow the master clock.
fn pick_config_best(
    device: &cpal::Device,
    sample_rate: u32,
    input: bool,
) -> Option<SupportedStreamConfig> {
    pick_config(device, sample_rate, input, false)
}

/// Requested rate first, otherwise anything the endpoint does support — some
/// hosts report no ranges at all, so the device default is the last resort.
fn pick_config_preferred(
    device: &cpal::Device,
    sample_rate: u32,
    input: bool,
) -> Option<SupportedStreamConfig> {
    if let Some(config) = pick_config_best(device, sample_rate, input) {
        return Some(config);
    }
    let default = if input {
        device.default_input_config().ok()?
    } else {
        device.default_output_config().ok()?
    };
    convertible(default.sample_format()).then_some(default)
}

// ---------------------------------------------------------------------------
// Sample format plumbing
// ---------------------------------------------------------------------------

/// Formats the engine can convert to and from f32. Anything else is rejected
/// while picking a config, not when the stream is being opened.
fn convertible(format: SampleFormat) -> bool {
    matches!(
        format,
        SampleFormat::F32
            | SampleFormat::I16
            | SampleFormat::U16
            | SampleFormat::I32
            | SampleFormat::F64
    )
}

/// Raw callbacks are converted in chunks of at most this many frames, which
/// caps the scratch buffer at [`SCRATCH_SAMPLES`] f32 samples.
const MAX_BLOCK_FRAMES: usize = 4_096;
/// Channels a chunk may carry before the chunk shrinks instead.
const MAX_CHANNELS: usize = 8;
/// Conversion scratch space, allocated once per stream before `play()`.
const SCRATCH_SAMPLES: usize = MAX_BLOCK_FRAMES * MAX_CHANNELS;

/// Samples of one callback converted to f32, starting at `offset`.
fn read_samples(data: &cpal::Data, offset: usize, out: &mut [f32]) -> bool {
    let wanted = out.len();
    let done = match data.sample_format() {
        SampleFormat::F32 => convert_in::<f32>(data, offset, out, |value| value),
        SampleFormat::I16 => convert_in::<i16>(data, offset, out, super::dsp::i16_to_f32),
        SampleFormat::U16 => convert_in::<u16>(data, offset, out, super::dsp::u16_to_f32),
        SampleFormat::I32 => convert_in::<i32>(data, offset, out, super::dsp::i32_to_f32),
        SampleFormat::F64 => convert_in::<f64>(data, offset, out, super::dsp::f64_to_f32),
        _ => return false,
    };
    done == wanted
}

fn convert_in<T: cpal::SizedSample>(
    data: &cpal::Data,
    offset: usize,
    out: &mut [f32],
    to_f32: impl Fn(T) -> f32,
) -> usize {
    let Some(samples) = data.as_slice::<T>() else {
        return 0;
    };
    let end = offset.saturating_add(out.len()).min(samples.len());
    if offset >= end {
        return 0;
    }
    for (slot, sample) in out.iter_mut().zip(&samples[offset..end]) {
        *slot = to_f32(*sample);
    }
    end - offset
}

/// Writes f32 samples into the host buffer, converting to its own format.
fn write_samples(data: &mut cpal::Data, offset: usize, source: &[f32]) -> bool {
    let wanted = source.len();
    let done = match data.sample_format() {
        SampleFormat::F32 => convert_out::<f32>(data, offset, source, |value| value),
        SampleFormat::I16 => convert_out::<i16>(data, offset, source, super::dsp::f32_to_i16),
        SampleFormat::U16 => convert_out::<u16>(data, offset, source, super::dsp::f32_to_u16),
        SampleFormat::I32 => convert_out::<i32>(data, offset, source, super::dsp::f32_to_i32),
        SampleFormat::F64 => convert_out::<f64>(data, offset, source, super::dsp::f32_to_f64),
        _ => return false,
    };
    done == wanted
}

fn convert_out<T: cpal::SizedSample>(
    data: &mut cpal::Data,
    offset: usize,
    source: &[f32],
    from_f32: impl Fn(f32) -> T,
) -> usize {
    let Some(samples) = data.as_slice_mut::<T>() else {
        return 0;
    };
    let end = offset.saturating_add(source.len()).min(samples.len());
    if offset >= end {
        return 0;
    }
    for (slot, value) in samples[offset..end].iter_mut().zip(source) {
        *slot = from_f32(*value);
    }
    end - offset
}

fn build_input_stream<F>(
    device: &cpal::Device,
    supported: &SupportedStreamConfig,
    make_callback: F,
) -> Result<Stream>
where
    F: FnOnce() -> Box<dyn FnMut(&[f32], &InputCallbackInfo) + Send>,
{
    let format = supported.sample_format();
    if !convertible(format) {
        bail!("вход отдаёт {format:?}, конвертация не поддерживается");
    }
    let config = supported.config();
    let channels = (supported.channels() as usize).max(1);
    let frames_per_chunk = (SCRATCH_SAMPLES / channels).clamp(1, MAX_BLOCK_FRAMES);
    let mut callback = make_callback();
    let mut scratch = vec![0.0_f32; frames_per_chunk * channels];

    device
        .build_input_stream_raw(
            &config,
            format,
            move |data: &cpal::Data, info: &InputCallbackInfo| {
                let total = data.len() / channels;
                let mut frame = 0;
                while frame < total {
                    let frames = (total - frame).min(frames_per_chunk);
                    let samples = frames * channels;
                    let offset = frame * channels;
                    if !read_samples(data, offset, &mut scratch[..samples]) {
                        return;
                    }
                    callback(&scratch[..samples], info);
                    frame += frames;
                }
            },
            stream_error,
            None,
        )
        .map_err(|error| anyhow!("input stream: {error}"))
}

/// WASAPI shared mode sometimes rejects an explicit buffer size. The probe uses
/// a throwaway silent stream, so the real renderer — which can only be built
/// once — is never consumed by an attempt that fails.
fn accepts_fixed_buffer(
    device: &cpal::Device,
    config: &StreamConfig,
    format: SampleFormat,
) -> bool {
    device
        .build_output_stream_raw(
            config,
            format,
            |_: &mut cpal::Data, _: &OutputCallbackInfo| {},
            stream_error,
            None,
        )
        .is_ok()
}

fn build_output_stream<F>(
    device: &cpal::Device,
    supported: &SupportedStreamConfig,
    buffer_size: u32,
    make_callback: F,
) -> Result<(Stream, bool)>
where
    F: FnOnce() -> Box<dyn FnMut(&mut [f32], &OutputCallbackInfo) + Send>,
{
    let format = supported.sample_format();
    if !convertible(format) {
        bail!("выход принимает {format:?}, конвертация не поддерживается");
    }
    let mut config: StreamConfig = supported.config();
    config.buffer_size = BufferSize::Fixed(buffer_size.max(32));

    let fallback = !accepts_fixed_buffer(device, &config, format);
    if fallback {
        config.buffer_size = BufferSize::Default;
    }

    let mut callback = make_callback();
    let channels = (supported.channels() as usize).max(1);
    let frames_per_chunk = (SCRATCH_SAMPLES / channels).clamp(1, MAX_BLOCK_FRAMES);
    let mut scratch = vec![0.0_f32; frames_per_chunk * channels];

    let stream = device
        .build_output_stream_raw(
            &config,
            format,
            move |data: &mut cpal::Data, info: &OutputCallbackInfo| {
                let total = data.len() / channels;
                let mut frame = 0;
                while frame < total {
                    let frames = (total - frame).min(frames_per_chunk);
                    let samples = frames * channels;
                    let offset = frame * channels;
                    scratch[..samples].fill(0.0);
                    callback(&mut scratch[..samples], info);
                    if !write_samples(data, offset, &scratch[..samples]) {
                        return;
                    }
                    frame += frames;
                }
            },
            stream_error,
            None,
        )
        .map_err(|error| anyhow!("output stream: {error}"))?;
    Ok((stream, fallback))
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/// One follower output plus a resampler from the master clock to the endpoint's
/// native rate. The M8 speakers, for example, only accept 44.1 kHz while the
/// headphones run at 48 kHz; keeping one clock and resampling the follower
/// avoids skipping that bus entirely.
///
/// The resampler also carries the clock-drift trim: the step is multiplied by
/// the factor derived from the measured fill of this bus ring, so a follower
/// whose hardware clock runs slightly slow or fast drains exactly as many
/// frames as the master produces. At nominal rates the same path drops or
/// repeats a single interpolated frame instead of letting the ring creep into
/// an overrun.
#[derive(Clone)]
struct FollowerSink {
    ring: Arc<SpscRing>,
    resampler: StereoResampler,
    drift: DriftControl,
    /// Set by the engine right after this follower's stream starts playing.
    /// Until then the ring has no consumer, so pushing would only fill it up
    /// and bake that saturated level into the drift baseline.
    armed: Arc<AtomicBool>,
    live: bool,
}

impl FollowerSink {
    fn new(
        ring: Arc<SpscRing>,
        source_rate: u32,
        target_rate: u32,
        prime_frames: usize,
        armed: Arc<AtomicBool>,
    ) -> Self {
        Self {
            ring,
            resampler: StereoResampler::new(source_rate, target_rate),
            drift: DriftControl::priming(prime_frames),
            armed,
            live: false,
        }
    }

    /// Called once per master callback. The ring occupancy is the only honest
    /// signal about how fast the follower endpoint really runs: the nominal
    /// rates differ by a few ppm which no timestamp exposes.
    fn trim(&mut self, frames: usize) {
        if !self.live {
            if !self.armed.load(Ordering::Relaxed) {
                return;
            }
            self.live = true;
        }
        let capacity = self.ring.capacity().max(1) as f32;
        let fill = self.ring.available_read() as f32 / capacity;
        let factor = self.drift.update(fill, frames);
        self.resampler
            .set_step(self.resampler.nominal_step() * factor);
    }

    #[inline]
    fn push(&mut self, frame: (f32, f32), stats: &EngineStats) {
        if !self.live {
            return;
        }
        let ring = &self.ring;
        self.resampler.push_frame(frame, |left, right| {
            if ring.push_slice(&[left, right]) != 2 {
                stats.overruns.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
}

struct MasterRenderer {
    graph: MixerGraph,
    pads: PadRenderer,
    input_rings: [Option<Arc<SpscRing>>; STRIPS],
    bus_sinks: [Option<FollowerSink>; BUSES],
    params_rx: Receiver<GraphParams>,
    meters: Arc<MeterBank>,
    stats: Arc<EngineStats>,
    recorder: Option<Arc<RecorderRing>>,
    master_bus: usize,
    channels: usize,
    /// Frames of silence emitted before the graph starts pulling input, so a
    /// non-zero safety buffer is a real buffer and not only a latency number.
    warmup: usize,
    last_callback: Option<Instant>,
}

impl MasterRenderer {
    /// Track the real callback period. A device that rejected the fixed buffer
    /// runs at its own size, and the UI used to keep showing the requested one.
    fn measure_period(&mut self, now: Instant) {
        if let Some(previous) = self.last_callback {
            let seconds = now.duration_since(previous).as_secs_f64();
            self.last_callback = Some(now);
            let rate = self.graph.sample_rate() as f64;
            if seconds > 0.0 && rate > 0.0 {
                let frames = (seconds * rate).round();
                if frames > 0.0 && frames < rate as f64 {
                    let previous = self.stats.period_frames.load(Ordering::Relaxed);
                    let blended = if previous == 0 {
                        frames as u64
                    } else {
                        (previous * 7 + frames as u64) / 8
                    };
                    self.stats.period_frames.store(blended, Ordering::Relaxed);
                }
            }
        } else {
            self.last_callback = Some(now);
        }
    }

    fn process(&mut self, data: &mut [f32]) {
        let started = Instant::now();
        self.measure_period(started);
        while let Ok(params) = self.params_rx.try_recv() {
            self.graph.apply_params(&params);
        }

        self.pads.drain();
        let channels = self.channels.max(1);
        let frames = data.len() / channels;
        let mut input_underrun = false;

        // One occupancy measurement per callback is enough to track a clock
        // mismatch, and it keeps the trim far below one ppm per audio frame.
        for sink in self.bus_sinks.iter_mut().flatten() {
            sink.trim(frames);
        }

        let mut first_frame = 0;
        if self.warmup > 0 {
            let skip = self.warmup.min(frames);
            self.warmup -= skip;
            for value in data.iter_mut().take(skip * channels) {
                *value = 0.0;
            }
            first_frame = skip;
        }

        for frame in first_frame..frames {
            let mut inputs = [(0.0_f32, 0.0_f32); STRIPS];
            for (slot, ring) in self.input_rings.iter().enumerate() {
                if let Some(ring) = ring {
                    if ring.available_read() < 2 {
                        input_underrun = true;
                    } else {
                        inputs[slot] = ring.pop_frame_or_silence();
                    }
                }
            }

            let mut strip_extra = [(0.0_f32, 0.0_f32); STRIPS];
            let mut bus_extra = [(0.0_f32, 0.0_f32); BUSES];
            let mut master_extra = (0.0_f32, 0.0_f32);
            self.pads
                .render_frame(&mut strip_extra, &mut bus_extra, &mut master_extra);

            let buses = self.graph.process_frame_with_extras(
                &inputs,
                &strip_extra,
                &bus_extra,
                master_extra,
                self.master_bus,
            );

            if let Some(recorder) = &self.recorder {
                let mut tap = [0.0_f32; TAP_CHANNELS];
                for bus in 0..BUSES {
                    tap[bus * 2] = buses[bus].0;
                    tap[bus * 2 + 1] = buses[bus].1;
                }
                let _ = recorder.push_frame(&tap);
            }

            for (bus, bus_frame) in buses.iter().enumerate() {
                if bus == self.master_bus {
                    continue;
                }
                if let Some(sink) = &mut self.bus_sinks[bus] {
                    sink.push(*bus_frame, &self.stats);
                }
            }

            let (left, right) = buses[self.master_bus];
            let base = frame * channels;
            if channels == 1 {
                data[base] = (left + right) * 0.5;
            } else {
                data[base] = left;
                data[base + 1] = right;
                for channel in 2..channels {
                    data[base + channel] = 0.0;
                }
            }
        }

        self.pads.finish_block();
        if input_underrun && self.warmup == 0 {
            self.stats.underruns.fetch_add(1, Ordering::Relaxed);
        }
        self.graph.publish_meters(&self.meters);
        self.stats
            .frames
            .fetch_add(frames as u64, Ordering::Relaxed);

        let sample_rate = self.graph.sample_rate();
        if frames > 0 && sample_rate > 0.0 {
            let deadline_us = frames as f64 / sample_rate as f64 * 1_000_000.0;
            let used_us = started.elapsed().as_secs_f64() * 1_000_000.0;
            let ppm =
                ((used_us / deadline_us.max(1.0)) * 1_000_000.0).clamp(0.0, 10_000_000.0) as u64;
            // Smooth out single-block jitter so the UI shows a readable value.
            let previous = self.stats.cpu_ppm.load(Ordering::Relaxed);
            let blended = if previous == 0 {
                ppm
            } else {
                (previous * 7 + ppm) / 8
            };
            self.stats.cpu_ppm.store(blended, Ordering::Relaxed);
        }
    }
}

struct FollowerRenderer {
    ring: Arc<SpscRing>,
    stats: Arc<EngineStats>,
    channels: usize,
}

impl FollowerRenderer {
    fn process(&mut self, data: &mut [f32]) {
        let channels = self.channels.max(1);
        let frames = data.len() / channels;
        let mut underrun = false;

        for frame in 0..frames {
            if self.ring.available_read() < 2 {
                underrun = true;
            }
            let (left, right) = self.ring.pop_frame_or_silence();
            let base = frame * channels;
            if channels == 1 {
                data[base] = (left + right) * 0.5;
            } else {
                data[base] = left;
                data[base + 1] = right;
                for channel in 2..channels {
                    data[base + channel] = 0.0;
                }
            }
        }

        if underrun {
            self.stats.underruns.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

fn build_engine(
    config: &EngineConfig,
    initial: GraphParams,
    build: EngineBuild,
) -> Result<(Vec<Stream>, RuntimeInfo)> {
    let EngineBuild {
        mut pads,
        plan,
        params_rx,
        meters,
        stats,
        recorder_tap,
        ai,
    } = build;
    let host = cpal::default_host();
    let mut warnings = Vec::new();

    // --- output endpoints ---------------------------------------------------
    let mut outputs = Vec::new();
    for (bus, id) in BUS_IDS.iter().enumerate() {
        let Some(device_id) = plan.outputs[bus].as_deref() else {
            continue;
        };
        let Some(name) = device_id.strip_prefix("out:") else {
            warnings.push(format!("{id}: ожидался id вида out:<name>"));
            continue;
        };
        match find_device(&host, name, false) {
            Some(device) => outputs.push(ResolvedOutput {
                bus,
                device,
                name: name.to_string(),
            }),
            None => warnings.push(format!("{id}: устройство «{name}» не найдено")),
        }
    }

    if outputs.is_empty() {
        // A fresh install (or a persisted snapshot from the browser mock) may
        // reference endpoints that do not exist on this machine. Falling back
        // to the Windows default output keeps the engine usable; the warning
        // is surfaced in the settings drawer.
        match host.default_output_device() {
            Some(device) => {
                let name = device.name().unwrap_or_else(|_| "Windows default output".into());
                warnings.push(format!(
                    "ни одна шина не привязана к доступному выходу — использую «{name}» по умолчанию"
                ));
                outputs.push(ResolvedOutput {
                    bus: BUS_IDS
                        .iter()
                        .position(|id| *id == config.clock_master)
                        .unwrap_or(0),
                    device,
                    name,
                });
            }
            None => bail!(
                "не выбрано ни одного выходного устройства — назначьте устройство хотя бы одной шине A1–B2"
            ),
        }
    }

    // Opening two WASAPI client streams on the same endpoint is allowed by the
    // API but produces drift and duplicated clocking. Keep the first bus and
    // report the skipped one instead.
    let mut used_names: Vec<String> = Vec::new();
    outputs.retain(|output| {
        if used_names
            .iter()
            .any(|name| name.eq_ignore_ascii_case(&output.name))
        {
            warnings.push(format!(
                "{}: устройство «{}» уже занято другой шиной — шина пропущена",
                BUS_IDS[output.bus], output.name
            ));
            false
        } else {
            used_names.push(output.name.clone());
            true
        }
    });

    let preferred_bus = BUS_IDS
        .iter()
        .position(|id| *id == config.clock_master)
        .unwrap_or(0);
    let mut master_position = outputs
        .iter()
        .position(|output| output.bus == preferred_bus)
        .unwrap_or(0);

    // A 44.1 kHz default speaker would drag the whole graph to 44.1 kHz, and
    // many USB microphones plus VAC capture pins only expose 48 kHz. When the
    // selected master cannot run at the requested rate, promote another output
    // that can instead of silently losing every input.
    if pick_config_at(&outputs[master_position].device, config.sample_rate, false).is_none() {
        if let Some(position) = outputs
            .iter()
            .position(|output| pick_config_at(&output.device, config.sample_rate, false).is_some())
        {
            if position != master_position {
                warnings.push(format!(
                    "{}: не поддерживает {} Гц — мастер перенесён на «{}»",
                    BUS_IDS[outputs[master_position].bus],
                    config.sample_rate,
                    outputs[position].name
                ));
                master_position = position;
            }
        }
    }

    outputs.swap(0, master_position);
    let master = outputs.remove(0);

    let master_config = pick_config_preferred(&master.device, config.sample_rate, false)
        .ok_or_else(|| {
            anyhow!(
                "шина-мастер «{}» не поддерживает ни один конвертируемый формат вывода",
                master.name
            )
        })?;
    let clock_rate = master_config.sample_rate().0;
    let buffer_size = config.buffer_size.max(32);
    let master_channels = master_config.channels() as usize;
    // The pad renderer was built with the *requested* rate, but the master may
    // have settled on another one; pad pitch is derived from this value.
    pads.set_sample_rate(clock_rate as f32);
    if master_config.sample_format() != SampleFormat::F32 {
        warnings.push(format!(
            "{}: мастер работает в формате {:?}, конвертация из f32",
            BUS_IDS[master.bus],
            master_config.sample_format()
        ));
    }

    // --- input endpoints ----------------------------------------------------
    // `safetyMs` used to change only the latency number. It now sizes the
    // capture rings and the silent warmup below, i.e. it really adds buffer.
    let safety_frames = (clock_rate as u64 * config.safety_ms as u64 / 1_000) as usize;
    let input_capacity = (clock_rate as usize / 2).max(1_024) + safety_frames * 2;
    let mut input_rings: [Option<Arc<SpscRing>>; STRIPS] = std::array::from_fn(|_| None);
    let mut input_streams = Vec::new();
    let mut used_inputs: Vec<String> = Vec::new();

    for (slot, id) in STRIP_IDS.iter().enumerate() {
        let Some(device_id) = plan.inputs[slot].as_deref() else {
            continue;
        };
        let Some(name) = device_id.strip_prefix("in:") else {
            warnings.push(format!("{id}: ожидался id вида in:<name>"));
            continue;
        };
        if used_inputs
            .iter()
            .any(|used| used.eq_ignore_ascii_case(name))
        {
            warnings.push(format!(
                "{id}: вход «{name}» уже используется другим каналом — канал оставлен без входа"
            ));
            continue;
        }
        let Some(device) = find_device(&host, name, true) else {
            warnings.push(format!("{id}: вход «{name}» не найден"));
            continue;
        };
        // A capture pin that cannot run the master rate is no longer dropped:
        // the best config it does support is used and resampled to the master
        // clock inside its own callback.
        let Some(supported) = pick_config_preferred(&device, clock_rate, true) else {
            warnings.push(format!(
                "{id}: вход «{name}» не поддерживает ни один конвертируемый формат"
            ));
            continue;
        };
        let source_rate = supported.sample_rate().0;
        if source_rate != clock_rate {
            warnings.push(format!(
                "{id}: вход работает на {source_rate} Гц, ресемплинг в {clock_rate} Гц"
            ));
        }
        if supported.sample_format() != SampleFormat::F32 {
            warnings.push(format!(
                "{id}: вход «{name}» отдаёт {:?}, конвертация в f32",
                supported.sample_format()
            ));
        }

        let channels = supported.channels() as usize;
        let ring = Arc::new(SpscRing::new(input_capacity));
        let ring_factory = Arc::clone(&ring);
        let stats_factory = Arc::clone(&stats);
        let prime_frames = clock_rate as usize;

        let stream = build_input_stream(&device, &supported, || {
            let ring = Arc::clone(&ring_factory);
            let stats = Arc::clone(&stats_factory);
            let mut resampler = StereoResampler::new(source_rate, clock_rate);
            let mut drift = DriftControl::priming(prime_frames);
            let channels = channels.max(1);
            Box::new(move |data: &[f32], _: &InputCallbackInfo| {
                let frames = data.len() / channels;
                if frames == 0 {
                    return;
                }
                // Occupancy of the ring this callback feeds, measured before
                // writing so the trim reacts to the drift, not to the block
                // that is about to be pushed.
                let capacity = ring.capacity().max(1) as f32;
                let fill = ring.available_read() as f32 / capacity;
                let factor = drift.update(fill, frames);
                resampler.set_step(resampler.nominal_step() * factor);

                for frame in 0..frames {
                    let base = frame * channels;
                    let sample = if channels == 1 {
                        (data[base], data[base])
                    } else {
                        (data[base], data[base + 1])
                    };
                    resampler.push_frame(sample, |left, right| {
                        if ring.push_slice(&[left, right]) != 2 {
                            stats.overruns.fetch_add(1, Ordering::Relaxed);
                        }
                    });
                }
            })
        })
        .with_context(|| format!("не удалось открыть вход «{name}»"))?;

        // Do not start capture yet: opening a dozen output streams can take
        // longer than the input ring, and filling it before the master runs
        // would register a burst of overruns. The input streams are played
        // after the master and follower outputs are alive.
        used_inputs.push(name.to_string());
        input_streams.push(stream);
        input_rings[slot] = Some(ring);
    }

    if input_streams.is_empty() {
        warnings.push("нет доступных входных устройств — шины будут в тишине".into());
    }

    // --- bus rings for follower outputs ------------------------------------
    // Resolve follower formats *before* the master stream starts so we never
    // pump audio into a ring that no output will ever drain. When an endpoint
    // only supports another sample rate (common for USB microphones with a
    // 44.1 kHz headphone output), keep it and resample from the master clock.
    let mut followers = Vec::new();
    let mut bus_sinks: [Option<FollowerSink>; BUSES] = std::array::from_fn(|_| None);
    for output in outputs {
        let Some(supported) = pick_config_preferred(&output.device, clock_rate, false) else {
            warnings.push(format!(
                "{}: «{}» не поддерживает ни {clock_rate} Гц, ни другой конвертируемый формат — шина пропущена",
                BUS_IDS[output.bus], output.name
            ));
            continue;
        };
        let target_rate = supported.sample_rate().0;
        if target_rate != clock_rate {
            warnings.push(format!(
                "{}: выход «{}» работает на {target_rate} Гц — включён ресемплер с {clock_rate} Гц",
                BUS_IDS[output.bus], output.name
            ));
        }
        if supported.sample_format() != SampleFormat::F32 {
            warnings.push(format!(
                "{}: «{}» работает в формате {:?}, конвертация из f32",
                BUS_IDS[output.bus],
                output.name,
                supported.sample_format()
            ));
        }
        let bus_capacity = (target_rate as usize / 10).max(512);
        let ring = Arc::new(SpscRing::new(bus_capacity));
        let armed = Arc::new(AtomicBool::new(false));
        bus_sinks[output.bus] = Some(FollowerSink::new(
            Arc::clone(&ring),
            clock_rate,
            target_rate,
            clock_rate as usize,
            Arc::clone(&armed),
        ));
        followers.push((output, supported, ring, armed));
    }

    // --- master output ------------------------------------------------------
    let input_factory = input_rings.clone();
    let bus_factory = bus_sinks.clone();
    let params_factory = params_rx.clone();
    let meters_factory = Arc::clone(&meters);
    let stats_factory = Arc::clone(&stats);
    let recorder_factory = Arc::clone(&recorder_tap);
    let pad_factory = Mutex::new(Some(pads));
    let master_bus = master.bus;

    let master_stream = build_output_stream(&master.device, &master_config, buffer_size, || {
        let mut renderer = MasterRenderer {
            graph: {
                let mut graph = MixerGraph::new(clock_rate as f32);
                graph.configure_ai(None, ai.clone());
                graph.apply_params(&initial);
                graph
            },
            // `build_output_stream` builds this renderer exactly once: the
            // buffer-size probe above uses its own throwaway callback.
            pads: pad_factory
                .lock()
                .take()
                .expect("pad renderer is only built once"),
            input_rings: input_factory.clone(),
            bus_sinks: bus_factory.clone(),
            params_rx: params_factory.clone(),
            meters: Arc::clone(&meters_factory),
            stats: Arc::clone(&stats_factory),
            recorder: Some(Arc::clone(&recorder_factory)),
            master_bus,
            channels: master_channels,
            warmup: safety_frames,
            last_callback: None,
        };
        Box::new(move |data: &mut [f32], _: &OutputCallbackInfo| renderer.process(data))
    })
    .with_context(|| format!("не удалось открыть выход «{}»", master.name))?;
    let (master_stream, mut buffer_fallback) = master_stream;
    if buffer_fallback {
        tracing::warn!(
            bus = BUS_IDS[master_bus],
            buffer_size,
            "master rejected the fixed WASAPI buffer — using the system size"
        );
        warnings.push(format!(
            "{}: WASAPI отклонил буфер {buffer_size} кадров — используется системный размер (задержка может отличаться)",
            BUS_IDS[master_bus]
        ));
    }

    master_stream
        .play()
        .with_context(|| format!("не удалось запустить выход «{}»", master.name))?;
    let mut output_streams = vec![master_stream];

    // --- follower outputs ---------------------------------------------------
    for (output, supported, ring, armed) in followers {
        let channels = supported.channels() as usize;
        let stats_factory = Arc::clone(&stats);
        let ring_factory = ring.clone();

        let stream = build_output_stream(&output.device, &supported, buffer_size, || {
            let mut renderer = FollowerRenderer {
                ring: ring_factory.clone(),
                stats: Arc::clone(&stats_factory),
                channels,
            };
            Box::new(move |data: &mut [f32], _: &OutputCallbackInfo| renderer.process(data))
        })
        .with_context(|| format!("не удалось открыть выход «{}»", output.name))?;
        let (stream, fallback) = stream;
        if fallback {
            buffer_fallback = true;
            tracing::warn!(
                bus = BUS_IDS[output.bus],
                buffer_size,
                "output rejected the fixed WASAPI buffer — using the system size"
            );
            warnings.push(format!(
                "{}: «{}» отклонил буфер {buffer_size} кадров — используется системный размер",
                BUS_IDS[output.bus], output.name
            ));
        }

        stream
            .play()
            .with_context(|| format!("не удалось запустить выход «{}»", output.name))?;
        // The master may start pushing into this bus ring from now on: its
        // occupancy measurements only make sense with a live consumer.
        armed.store(true, Ordering::Relaxed);
        output_streams.push(stream);
    }

    // Capture starts last, once the master is already consuming frames, so the
    // input rings never overflow while WASAPI is still opening outputs.
    for stream in &input_streams {
        stream
            .play()
            .with_context(|| "не удалось запустить входной поток")?;
    }

    // Let the first callbacks prime every follower ring (44.1 kHz USB outputs
    // can underrun for a moment), then zero the warmup counters so the status
    // bar starts at XRUN 0 on a healthy graph.
    std::thread::sleep(Duration::from_millis(2000));
    stats.reset();

    let info = RuntimeInfo {
        sample_rate: clock_rate,
        buffer_size,
        input_streams: input_streams.len(),
        output_streams: output_streams.len(),
        warnings,
        buffer_fallback,
    };

    let mut streams = input_streams;
    streams.extend(output_streams);
    Ok((streams, info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn stamp() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    }

    /// Manual smoke test: `cargo test -p nexus-mixer engine_starts -- --ignored`.
    /// Opens the Windows default output in shared mode and renders silence.
    #[test]
    #[ignore = "requires a real WASAPI output endpoint"]
    fn engine_starts_with_default_device() {
        let config = EngineConfig::default();
        let runtime = EngineRuntime::start(
            &config,
            &serde_json::Value::Null,
            Arc::new(AiClient::new()),
            Arc::new(PadBank::new()),
        )
        .expect("engine start");
        assert!(runtime.info().output_streams >= 1);
        std::thread::sleep(Duration::from_millis(300));
        assert!(runtime.stats().frames() > 0, "master callback did not run");
        drop(runtime);
    }

    /// Manual end-to-end smoke test with the Windows default microphone and
    /// speakers. It does not assert that the mic carries signal (it may be
    /// muted by Windows privacy settings), only that capture/playback streams
    /// open and the realtime graph keeps producing finite meters.
    #[test]
    #[ignore = "requires real WASAPI input and output endpoints"]
    fn engine_opens_capture_and_playback() {
        let host = cpal::default_host();
        let Some(input) = host.default_input_device() else {
            eprintln!("no default input — skipped");
            return;
        };
        let Some(output) = host.default_output_device() else {
            eprintln!("no default output — skipped");
            return;
        };
        let input_name = input.name().expect("input name");
        let output_name = output.name().expect("output name");
        let config = EngineConfig::default();
        let expects_input = pick_config_at(&input, config.sample_rate, true).is_some();
        let recording_dir = std::env::temp_dir().join(format!(
            "nexus-engine-rec-{}-{}",
            std::process::id(),
            stamp()
        ));

        let snapshot = serde_json::json!({
            "strips": {
                "hw1": {
                    "deviceId": format!("in:{input_name}"),
                    "routing": { "A1": { "on": true, "levelDb": 0.0 } }
                }
            },
            "buses": {
                "A1": { "deviceId": format!("out:{output_name}") }
            },
            "recorder": {
                "enabled": true,
                "directory": recording_dir.display().to_string(),
                "format": "wav",
                "bitDepth": 24,
                "buses": ["A1"],
                "splitMinutes": 0
            }
        });

        let runtime = EngineRuntime::start(
            &config,
            &snapshot,
            Arc::new(AiClient::new()),
            Arc::new(PadBank::new()),
        )
        .expect("engine start");
        eprintln!(
            "streams: {} in / {} out; warnings: {:?}",
            runtime.info().input_streams,
            runtime.info().output_streams,
            runtime.info().warnings
        );
        assert_eq!(runtime.info().output_streams, 1);
        if expects_input {
            assert_eq!(
                runtime.info().input_streams,
                1,
                "default input was not opened"
            );
        }

        std::thread::sleep(Duration::from_millis(400));
        assert!(runtime.stats().frames() > 0, "master callback did not run");
        let levels = runtime.meters();
        assert!(levels.strips.iter().all(|level| level.is_finite()));
        assert!(levels.buses.iter().all(|level| level.is_finite()));

        let recorder = runtime.recorder_status();
        assert!(recorder.recording, "recorder did not start: {recorder:?}");
        let path = recorder.file.clone().expect("recording path");
        drop(runtime);

        let bytes = std::fs::read(&path).expect("recorded wav");
        assert!(bytes.len() > 44, "recorded wav has no payload");
        assert_eq!(&bytes[0..4], b"RIFF");
        let _ = std::fs::remove_dir_all(&recording_dir);
    }
}
