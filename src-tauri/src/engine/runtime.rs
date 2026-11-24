//! WASAPI backend: capture threads → ring buffers → mixer graph → playback.
//!
//! One output stream is the clock master. Its callback pulls one stereo frame
//! from every input ring, runs the graph once, writes its own bus directly and
//! forwards the other buses through per-bus rings to follower output streams.
//! This keeps a single graph instance and a single clock, which matters because
//! WASAPI callbacks run on independent threads.
//!
//! All heap allocation happens before `Stream::play()`; the callbacks only
//! touch atomics, rings and preallocated DSP state.

use std::sync::atomic::{AtomicU64, Ordering};
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
use serde::Serialize;

use super::ai::AiClient;
use super::ai_audio::{AiAudioState, AiEngine, AiTelemetry};
use super::buffer::SpscRing;
use super::graph::{GraphParams, MeterBank, MeterLevels, MixerGraph, MixerParams, BUSES, BUS_IDS, STRIPS, STRIP_IDS};
use super::model::EngineConfig;
use super::recorder::{RecorderHandle, RecorderParams, RecorderRing, RecorderStatus, TAP_CHANNELS};

// ---------------------------------------------------------------------------
// Stats & info
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct EngineStats {
    underruns: AtomicU64,
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
        let dry_ai = Arc::new(SpscRing::new(((config.sample_rate as usize) / 10).max(512) * 2));
        let wet_ai = Arc::new(SpscRing::new(((config.sample_rate as usize) / 10).max(1024) * 4));
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

fn find_device(host: &cpal::Host, name: &str, input: bool) -> Option<cpal::Device> {
    let by_name = |device: &cpal::Device| device.name().map(|value| value == name).unwrap_or(false);
    let by_name_ci =
        |device: &cpal::Device| device.name().map(|value| value.eq_ignore_ascii_case(name)).unwrap_or(false);

    if input {
        if let Ok(devices) = host.input_devices() {
            if let Some(found) = devices.into_iter().find(by_name) {
                return Some(found);
            }
        }
        host.input_devices().ok()?.into_iter().find(by_name_ci)
    } else {
        if let Ok(devices) = host.output_devices() {
            if let Some(found) = devices.into_iter().find(by_name) {
                return Some(found);
            }
        }
        host.output_devices().ok()?.into_iter().find(by_name_ci)
    }
}

fn range_score(range: &SupportedStreamConfigRange) -> u32 {
    match range.channels() {
        2 => 30,
        1 => 20,
        _ => 10,
    }
}

fn consider_range(
    range: SupportedStreamConfigRange,
    sample_rate: u32,
    best: &mut Option<SupportedStreamConfigRange>,
) {
    if range.sample_format() != SampleFormat::F32 {
        return;
    }
    if sample_rate < range.min_sample_rate().0 || sample_rate > range.max_sample_rate().0 {
        return;
    }
    let better = best.as_ref().map_or(true, |current| range_score(&range) > range_score(current));
    if better {
        *best = Some(range);
    }
}

/// Pick an F32 config at exactly `sample_rate`.
fn pick_config_at(device: &cpal::Device, sample_rate: u32, input: bool) -> Option<SupportedStreamConfig> {
    let mut best = None;
    if input {
        for range in device.supported_input_configs().ok()? {
            consider_range(range, sample_rate, &mut best);
        }
    } else {
        for range in device.supported_output_configs().ok()? {
            consider_range(range, sample_rate, &mut best);
        }
    }
    best.map(|range| range.with_sample_rate(SampleRate(sample_rate)))
}

/// Prefer the requested rate, fall back to the device default. Used only for
/// the clock master, which defines the rate for all other streams.
fn pick_config_preferred(device: &cpal::Device, sample_rate: u32, input: bool) -> Option<SupportedStreamConfig> {
    if let Some(config) = pick_config_at(device, sample_rate, input) {
        return Some(config);
    }
    let default = if input {
        device.default_input_config().ok()?
    } else {
        device.default_output_config().ok()?
    };
    (default.sample_format() == SampleFormat::F32).then_some(default)
}

fn build_input_stream<F>(
    device: &cpal::Device,
    supported: &SupportedStreamConfig,
    mut make_callback: F,
) -> Result<Stream>
where
    F: FnMut() -> Box<dyn FnMut(&[f32], &InputCallbackInfo) + Send>,
{
    let config = supported.config();
    device
        .build_input_stream(&config, make_callback(), stream_error, None)
        .map_err(|error| anyhow!("input stream: {error}"))
}

fn build_output_stream<F>(
    device: &cpal::Device,
    supported: &SupportedStreamConfig,
    buffer_size: u32,
    mut make_callback: F,
) -> Result<(Stream, bool)>
where
    F: FnMut() -> Box<dyn FnMut(&mut [f32], &OutputCallbackInfo) + Send>,
{
    let mut config: StreamConfig = supported.config();
    config.buffer_size = BufferSize::Fixed(buffer_size.max(32));

    // WASAPI shared mode occasionally rejects a fixed buffer. Retry with the
    // device-managed size and report the fallback so the engine can warn.
    if let Ok(stream) = device.build_output_stream(&config, make_callback(), stream_error, None) {
        return Ok((stream, false));
    }

    config.buffer_size = BufferSize::Default;
    device
        .build_output_stream(&config, make_callback(), stream_error, None)
        .map(|stream| (stream, true))
        .map_err(|error| anyhow!("output stream: {error}"))
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/// One follower output plus a linear resampler from the master clock to the
/// endpoint's native rate. The M8 speakers, for example, only accept 44.1 kHz
/// while the headphones run at 48 kHz; keeping one clock and resampling the
/// follower avoids skipping that bus entirely.
#[derive(Clone)]
struct FollowerSink {
    ring: Arc<SpscRing>,
    step: f64,
    next: f64,
    prev: (f32, f32),
    curr: (f32, f32),
    primed: bool,
}

impl FollowerSink {
    fn new(ring: Arc<SpscRing>, source_rate: u32, target_rate: u32) -> Self {
        Self {
            ring,
            step: source_rate.max(1) as f64 / target_rate.max(1) as f64,
            next: 0.0,
            prev: (0.0, 0.0),
            curr: (0.0, 0.0),
            primed: false,
        }
    }

    #[inline]
    fn push(&mut self, frame: (f32, f32), stats: &EngineStats) {
        if !self.primed {
            self.prev = frame;
            self.curr = frame;
            self.primed = true;
        } else {
            self.prev = self.curr;
            self.curr = frame;
        }

        while self.next < 1.0 {
            let t = self.next as f32;
            let left = self.prev.0 + (self.curr.0 - self.prev.0) * t;
            let right = self.prev.1 + (self.curr.1 - self.prev.1) * t;
            if self.ring.push_slice(&[left, right]) != 2 {
                stats.overruns.fetch_add(1, Ordering::Relaxed);
            }
            self.next += self.step;
        }
        self.next -= 1.0;
    }
}

struct MasterRenderer {
    graph: MixerGraph,
    input_rings: [Option<Arc<SpscRing>>; STRIPS],
    bus_sinks: [Option<FollowerSink>; BUSES],
    params_rx: Receiver<GraphParams>,
    meters: Arc<MeterBank>,
    stats: Arc<EngineStats>,
    recorder: Option<Arc<RecorderRing>>,
    master_bus: usize,
    channels: usize,
}

impl MasterRenderer {
    fn process(&mut self, data: &mut [f32]) {
        let started = Instant::now();
        while let Ok(params) = self.params_rx.try_recv() {
            self.graph.apply_params(&params);
        }

        let channels = self.channels.max(1);
        let frames = data.len() / channels;
        let mut input_underrun = false;

        for frame in 0..frames {
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

            let buses = self.graph.process_frame(&inputs);

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

        if input_underrun {
            self.stats.underruns.fetch_add(1, Ordering::Relaxed);
        }
        self.graph.publish_meters(&self.meters);
        self.stats.frames.fetch_add(frames as u64, Ordering::Relaxed);

        let sample_rate = self.graph.sample_rate();
        if frames > 0 && sample_rate > 0.0 {
            let deadline_us = frames as f64 / sample_rate as f64 * 1_000_000.0;
            let used_us = started.elapsed().as_secs_f64() * 1_000_000.0;
            let ppm = ((used_us / deadline_us.max(1.0)) * 1_000_000.0).clamp(0.0, 10_000_000.0) as u64;
            // Smooth out single-block jitter so the UI shows a readable value.
            let previous = self.stats.cpu_ppm.load(Ordering::Relaxed);
            let blended = if previous == 0 { ppm } else { (previous * 7 + ppm) / 8 };
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
        if used_names.iter().any(|name| name.eq_ignore_ascii_case(&output.name)) {
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
        .ok_or_else(|| anyhow!("шина-мастер «{}» не поддерживает F32-вывод", master.name))?;
    let clock_rate = master_config.sample_rate().0;
    let buffer_size = config.buffer_size.max(32);
    let master_channels = master_config.channels() as usize;

    // --- input endpoints ----------------------------------------------------
    let input_capacity = (clock_rate as usize / 2).max(1_024);
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
        if used_inputs.iter().any(|used| used.eq_ignore_ascii_case(name)) {
            warnings.push(format!("{id}: вход «{name}» уже используется другим каналом — канал оставлен без входа"));
            continue;
        }
        let Some(device) = find_device(&host, name, true) else {
            warnings.push(format!("{id}: вход «{name}» не найден"));
            continue;
        };
        let Some(supported) = pick_config_at(&device, clock_rate, true) else {
            warnings.push(format!("{id}: нет F32-входа на {clock_rate} Гц"));
            continue;
        };

        let channels = supported.channels() as usize;
        let ring = Arc::new(SpscRing::new(input_capacity));
        let ring_factory = Arc::clone(&ring);
        let stats_factory = Arc::clone(&stats);

        let stream = build_input_stream(&device, &supported, || {
            let ring = Arc::clone(&ring_factory);
            let stats = Arc::clone(&stats_factory);
            Box::new(move |data: &[f32], _: &InputCallbackInfo| {
                let channels = channels.max(1);
                let frames = data.len() / channels;
                for frame in 0..frames {
                    let base = frame * channels;
                    let (left, right) = if channels == 1 {
                        (data[base], data[base])
                    } else {
                        (data[base], data[base + 1])
                    };
                    if ring.push_slice(&[left, right]) != 2 {
                        stats.overruns.fetch_add(1, Ordering::Relaxed);
                    }
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
                "{}: нет F32-выхода (ни {clock_rate} Гц, ни в формате устройства) — шина пропущена",
                output.name
            ));
            continue;
        };
        let target_rate = supported.sample_rate().0;
        if target_rate != clock_rate {
            warnings.push(format!(
                "{}: выход работает на {target_rate} Гц — включён ресемплер с {clock_rate} Гц",
                output.name
            ));
        }
        let bus_capacity = (target_rate as usize / 10).max(512);
        let ring = Arc::new(SpscRing::new(bus_capacity));
        bus_sinks[output.bus] = Some(FollowerSink::new(Arc::clone(&ring), clock_rate, target_rate));
        followers.push((output, supported, ring));
    }

    // --- master output ------------------------------------------------------
    let input_factory = input_rings.clone();
    let bus_factory = bus_sinks.clone();
    let params_factory = params_rx.clone();
    let meters_factory = Arc::clone(&meters);
    let stats_factory = Arc::clone(&stats);
    let recorder_factory = Arc::clone(&recorder_tap);
    let master_bus = master.bus;

    let master_stream = build_output_stream(&master.device, &master_config, buffer_size, || {
        let mut renderer = MasterRenderer {
            graph: {
                let mut graph = MixerGraph::new(clock_rate as f32);
                graph.configure_ai(None, ai.clone());
                graph.apply_params(&initial);
                graph
            },
            input_rings: input_factory.clone(),
            bus_sinks: bus_factory.clone(),
            params_rx: params_factory.clone(),
            meters: Arc::clone(&meters_factory),
            stats: Arc::clone(&stats_factory),
            recorder: Some(Arc::clone(&recorder_factory)),
            master_bus,
            channels: master_channels,
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
    for (output, supported, ring) in followers {
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
        output_streams.push(stream);
    }

    // Capture starts last, once the master is already consuming frames, so the
    // input rings never overflow while WASAPI is still opening outputs.
    for stream in &input_streams {
        stream.play().with_context(|| "не удалось запустить входной поток")?;
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
        let runtime = EngineRuntime::start(&config, &serde_json::Value::Null, Arc::new(AiClient::new()))
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

        let runtime = EngineRuntime::start(&config, &snapshot, Arc::new(AiClient::new()))
            .expect("engine start");
        eprintln!(
            "streams: {} in / {} out; warnings: {:?}",
            runtime.info().input_streams,
            runtime.info().output_streams,
            runtime.info().warnings
        );
        assert_eq!(runtime.info().output_streams, 1);
        if expects_input {
            assert_eq!(runtime.info().input_streams, 1, "default input was not opened");
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
