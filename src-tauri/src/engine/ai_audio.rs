//! Realtime Voice AI audio path — dry/wet exchange with the local sidecar.
//!
//! The audio callback never touches the network. Instead:
//!
//! - the mixer graph taps the selected source strip (post-DSP) and forwards the
//!   sample through the AI path;
//! - a dedicated `nexus-ai` thread drains the dry ring, batches mono frames
//!   into fixed chunks, ships `[A seq payload]` frames to the sidecar and pushes
//!   the converted chunks into a wet ring through the crossfade ramp;
//! - the master callback pops wet audio from the wet ring, crossfades it against
//!   the incoming dry signal and mixes it into the bus graph.
//!
//! Every failure mode degrades to dry audio: a stalled sidecar, a dropped chunk
//! or a socket error simply leaves the wet ring empty, and the callback renders
//! dry audio instead of clicking.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use serde_json::Value;

use super::ai::{AiClient, KIND_AUDIO, KIND_JSON, KIND_PING, KIND_PONG};
use super::buffer::SpscRing;

/// How many chunks the wet ring may hold before the callback gives up on wet
/// audio and renders dry instead of stalling.
pub const MAX_BACKLOG: u32 = 4;

// ---------------------------------------------------------------------------
// Runtime parameters
// ---------------------------------------------------------------------------

/// Allocation-free copy of the AI conversion parameters, published through the
/// same bounded channel as the mixer graph params.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AiRuntimeParams {
    pub enabled: bool,
    pub chunk_frames: u32,
    pub pitch: f32,
    pub formant: f32,
    pub index_rate: f32,
    pub mix: f32,
    pub crossfade_frames: u32,
    pub max_backlog: u32,
    pub gate_db: f32,
}

impl Default for AiRuntimeParams {
    fn default() -> Self {
        Self {
            enabled: false,
            chunk_frames: 5_760,
            pitch: 0.0,
            formant: 0.0,
            index_rate: 48_000.0,
            mix: 1.0,
            crossfade_frames: 1_920,
            max_backlog: MAX_BACKLOG,
            gate_db: -55.0,
        }
    }
}

impl AiRuntimeParams {
    pub fn mix(&self) -> f32 {
        self.mix.clamp(0.0, 1.0)
    }

    fn crossfade_step(&self) -> f32 {
        if self.crossfade_frames > 0 {
            1.0 / self.crossfade_frames as f32
        } else {
            1.0
        }
    }
}

/// Chunk geometry derived from the sample rate and millisecond settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiLayout {
    pub chunk_frames: u32,
    pub crossfade_frames: u32,
}

impl AiLayout {
    pub fn from_parts(sample_rate: u32, chunk_ms: u64, crossfade_ms: u64) -> Self {
        let rate = sample_rate.max(1) as u64;
        let chunk = (rate * chunk_ms / 1000).clamp(160, 15_360) as u32;
        let crossfade = (rate * crossfade_ms / 1000).clamp(0, chunk as u64 / 2) as u32;
        Self {
            chunk_frames: chunk,
            crossfade_frames: crossfade,
        }
    }
}

// ---------------------------------------------------------------------------
// Shared realtime state — atomics only, safe from the audio callback
// ---------------------------------------------------------------------------

/// Lock-free telemetry for the realtime AI path.
#[derive(Debug, Default)]
pub struct AiRealtimeStats {
    pub underruns: AtomicU64,
    pub overruns: AtomicU64,
    pub chunks_sent: AtomicU64,
    pub chunks_returned: AtomicU64,
    pub chunks_dropped: AtomicU64,
    pub last_roundtrip_us: AtomicU64,
    rtf_milli: AtomicU64,
}

impl AiRealtimeStats {
    pub fn rtf(&self) -> f32 {
        self.rtf_milli.load(Ordering::Relaxed) as f32 / 1_000.0
    }

    fn note_rtf(&self, rtf: f32) {
        let milli = (rtf.clamp(0.0, 100.0) * 1_000.0) as u64;
        let previous = self.rtf_milli.load(Ordering::Relaxed);
        let blended = if previous == 0 {
            milli
        } else {
            (previous * 3 + milli) / 4
        };
        self.rtf_milli.store(blended, Ordering::Relaxed);
    }
}

/// Atomic handles shared by the callback, the control thread and the AI thread.
#[derive(Clone)]
pub struct AiShared {
    pub gate: Arc<AtomicBool>,
    pub epoch: Arc<AtomicU32>,
    pub mix: Arc<AtomicU32>,
    pub mix_step: Arc<AtomicU32>,
    pub stats: Arc<AiRealtimeStats>,
    pub source_db: Arc<AtomicU32>,
    applied: Arc<Mutex<Option<Value>>>,
}

/// Shared AI state used by the master callback and the `nexus-ai` thread.
#[derive(Clone)]
pub struct AiAudioState {
    pub dry: Arc<SpscRing>,
    pub wet: Arc<SpscRing>,
    pub gate: Arc<AtomicBool>,
    pub epoch: Arc<AtomicU32>,
    pub mix: Arc<AtomicU32>,
    pub mix_step: Arc<AtomicU32>,
    pub stats: Arc<AiRealtimeStats>,
    pub source_db: Arc<AtomicU32>,
}

impl AiAudioState {
    pub fn new(dry: Arc<SpscRing>, wet: Arc<SpscRing>, shared: AiShared) -> Self {
        Self {
            dry,
            wet,
            gate: shared.gate,
            epoch: shared.epoch,
            mix: shared.mix,
            mix_step: shared.mix_step,
            stats: shared.stats,
            source_db: shared.source_db,
        }
    }

    /// Push one source frame into the dry ring. Called from the mixer graph
    /// before the wet mix, so the AI thread can chunk it later.
    pub fn push_source(&self, left: f32, right: f32) {
        let _ = self.dry.push_slice(&[left, right]);
    }

    pub fn source_db(&self) -> f32 {
        f32::from_bits(self.source_db.load(Ordering::Relaxed))
    }

    /// Discard one buffered wet frame. Called instead of [`Self::process`] while
    /// the source strip is not audible, so a muted strip never reaches the
    /// sidecar and stale wet audio cannot play back after unmuting.
    pub fn skip_frame(&self) {
        if self.wet.available_read() >= 2 {
            let _ = self.wet.pop_frame_or_silence();
        }
    }

    /// Mix one source frame into the bus graph through the AI path. Returns the
    /// frame the mixer should route onwards. Without a source slot, with the AI
    /// path disabled, or when the wet ring has no audio yet, the dry frame is
    /// returned unchanged (dry fallback / passthrough).
    pub fn process(&self, source_slot: Option<usize>, dry_l: f32, dry_r: f32) -> (f32, f32) {
        let Some(slot) = source_slot else {
            return (dry_l, dry_r);
        };
        if slot >= super::graph::STRIPS {
            return (dry_l, dry_r);
        }
        if !self.gate.load(Ordering::Acquire) {
            return (dry_l, dry_r);
        }
        if self.wet.available_read() < 2 {
            self.stats.underruns.fetch_add(1, Ordering::Relaxed);
            return (dry_l, dry_r);
        }
        let mix = f32::from_bits(self.mix.load(Ordering::Relaxed));
        let (wet_l, wet_r) = self.wet.pop_frame_or_silence();
        let wet = (wet_l + wet_r) * 0.5;
        (
            dry_l * (1.0 - mix) + wet * mix,
            dry_r * (1.0 - mix) + wet * mix,
        )
    }
}

/// Live AI telemetry surfaced through `EngineStatus.ai`.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiTelemetry {
    pub active: bool,
    pub chunks_sent: u64,
    pub chunks_returned: u64,
    pub chunks_dropped: u64,
    pub underruns: u64,
    pub overruns: u64,
    pub rtf: f32,
    pub buffered_frames: u32,
    pub latency_ms: f32,
    pub source_db: f32,
    pub last_roundtrip_ms: f32,
}

impl AiTelemetry {
    pub fn from_shared(
        active: bool,
        stats: &AiRealtimeStats,
        sample_rate: u32,
        source_db: f32,
        buffered_frames: u32,
    ) -> Self {
        let rate = sample_rate.max(1) as f32;
        Self {
            active,
            chunks_sent: stats.chunks_sent.load(Ordering::Relaxed),
            chunks_returned: stats.chunks_returned.load(Ordering::Relaxed),
            chunks_dropped: stats.chunks_dropped.load(Ordering::Relaxed),
            underruns: stats.underruns.load(Ordering::Relaxed),
            overruns: stats.overruns.load(Ordering::Relaxed),
            rtf: stats.rtf().max(0.01),
            buffered_frames,
            latency_ms: buffered_frames as f32 / rate * 1000.0,
            source_db,
            last_roundtrip_ms: stats.last_roundtrip_us.load(Ordering::Relaxed) as f32 / 1_000.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Control handle
// ---------------------------------------------------------------------------

/// Handle for the realtime AI thread. The thread owns chunk scheduling and the
/// crossfade ramp; all shared state is atomic or `Arc`-shared.
pub struct AiEngine {
    shared: AiShared,
    params_tx: Sender<AiRuntimeParams>,
    stop_tx: Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AiEngine {
    pub fn spawn(
        dry: Arc<SpscRing>,
        wet: Arc<SpscRing>,
        ai: Arc<AiClient>,
        params: AiRuntimeParams,
        sample_rate: u32,
    ) -> Self {
        let (params_tx, params_rx) = bounded::<AiRuntimeParams>(32);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let shared = AiShared {
            gate: Arc::new(AtomicBool::new(params.enabled)),
            epoch: Arc::new(AtomicU32::new(0)),
            mix: Arc::new(AtomicU32::new(0)),
            mix_step: Arc::new(AtomicU32::new(1)),
            stats: Arc::new(AiRealtimeStats::default()),
            source_db: Arc::new(AtomicU32::new(0)),
            applied: Arc::new(Mutex::new(None)),
        };

        let thread_shared = shared.clone();
        let thread = thread::Builder::new()
            .name("nexus-ai".into())
            .spawn(move || {
                run_ai(
                    dry,
                    wet,
                    ai,
                    thread_shared,
                    params_rx,
                    stop_rx,
                    sample_rate.max(1) as f32,
                );
            })
            .expect("failed to spawn nexus-ai thread");

        Self {
            shared,
            params_tx,
            stop_tx,
            thread: Some(thread),
        }
    }

    pub fn gate(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.shared.gate)
    }

    pub fn stats(&self) -> Arc<AiRealtimeStats> {
        Arc::clone(&self.shared.stats)
    }

    pub fn source_db(&self) -> Arc<AtomicU32> {
        Arc::clone(&self.shared.source_db)
    }

    pub fn mix(&self) -> Arc<AtomicU32> {
        Arc::clone(&self.shared.mix)
    }

    pub fn mix_step(&self) -> Arc<AtomicU32> {
        Arc::clone(&self.shared.mix_step)
    }

    pub fn epoch(&self) -> Arc<AtomicU32> {
        Arc::clone(&self.shared.epoch)
    }

    /// Callback-side view of this engine, sharing the rings and atomics.
    pub fn state(&self, dry: Arc<SpscRing>, wet: Arc<SpscRing>) -> AiAudioState {
        AiAudioState::new(dry, wet, self.shared.clone())
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.shared.gate.store(enabled, Ordering::Release);
    }

    /// Arm (or disarm) the whole path with a full parameter snapshot.
    pub fn arm(&self, enabled: bool, params: AiRuntimeParams) {
        self.shared.gate.store(enabled, Ordering::Release);
        let _ = self.params_tx.try_send(params);
    }

    pub fn telemetry(&self, sample_rate: u32, buffered_frames: u32) -> AiTelemetry {
        let source_db = f32::from_bits(self.shared.source_db.load(Ordering::Relaxed));
        AiTelemetry::from_shared(
            self.shared.gate.load(Ordering::Acquire),
            &self.shared.stats,
            sample_rate,
            source_db,
            buffered_frames,
        )
    }

    pub fn applied_config(&self) -> Value {
        self.shared.applied.lock().take().unwrap_or(Value::Null)
    }
}

impl Drop for AiEngine {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Thread loop
// ---------------------------------------------------------------------------

fn run_ai(
    dry: Arc<SpscRing>,
    wet: Arc<SpscRing>,
    ai: Arc<AiClient>,
    shared: AiShared,
    params_rx: Receiver<AiRuntimeParams>,
    stop_rx: Receiver<()>,
    sample_rate: f32,
) {
    let AiShared {
        gate,
        epoch,
        mix,
        mix_step,
        stats,
        source_db,
        applied,
    } = shared;
    let mut params = AiRuntimeParams::default();
    let mut buffer: Vec<f32> = Vec::with_capacity(8192);
    let mut scratch = vec![0.0_f32; 16_384];
    let mut seq: u32 = 0;
    let mut last_source = Instant::now();

    while stop_rx.try_recv().is_err() {
        while let Ok(next) = params_rx.try_recv() {
            params = next;
            buffer.clear();
            seq = seq.wrapping_add(7);
            let _ = applied.lock().take();
        }

        if !params.enabled || !gate.load(Ordering::Acquire) {
            if last_source.elapsed() > Duration::from_millis(250) {
                last_source = Instant::now();
                source_db.store(0.0_f32.to_bits(), Ordering::Relaxed);
            }
            thread::sleep(Duration::from_millis(2));
            continue;
        }

        let chunk_frames = params.chunk_frames.max(1) as usize;
        let needed_frames = chunk_frames.saturating_sub(buffer.len());
        if scratch.len() < needed_frames * 2 {
            scratch.resize(needed_frames * 2, 0.0);
        }

        while buffer.len() < chunk_frames {
            let want = (chunk_frames - buffer.len()) * 2;
            let read = dry.pop_slice(&mut scratch[..want]);
            if read < 2 {
                break;
            }
            for index in 0..read / 2 {
                buffer.push((scratch[index * 2] + scratch[index * 2 + 1]) * 0.5);
            }
        }

        if buffer.len() < chunk_frames {
            if last_source.elapsed() > Duration::from_millis(250) {
                last_source = Instant::now();
                source_db.store(0.0_f32.to_bits(), Ordering::Relaxed);
            }
            thread::sleep(Duration::from_millis(2));
            continue;
        }

        let chunk: Vec<f32> = buffer.drain(..chunk_frames).collect();
        let peak = chunk.iter().fold(0.0_f32, |acc, s| acc.max(s.abs()));
        source_db.store(linear_to_db(peak).to_bits(), Ordering::Relaxed);
        let step = params.crossfade_step();
        let sent_seq = seq;

        mix.store(0.0_f32.to_bits(), Ordering::Relaxed);
        mix_step.store(step.to_bits(), Ordering::Relaxed);
        epoch.store(sent_seq, Ordering::Release);

        let started = Instant::now();
        if ai.send_audio(sent_seq, &chunk).is_err() {
            stats.chunks_dropped.fetch_add(1, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(50));
            continue;
        }
        stats.chunks_sent.fetch_add(1, Ordering::Relaxed);
        seq = seq.wrapping_add(1);

        let deadline = started + Duration::from_millis(400);
        let mut returned = false;
        while !returned && Instant::now() < deadline {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match ai.recv_event() {
                Ok((KIND_AUDIO, payload)) => {
                    if payload.len() >= 4 && (payload.len() - 4) % 4 == 0 {
                        let response_seq =
                            u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                        if response_seq == sent_seq {
                            let mut index = 4usize;
                            let mut mix_value = f32::from_bits(mix.load(Ordering::Relaxed));
                            while index + 4 <= payload.len() {
                                let sample = f32::from_le_bytes([
                                    payload[index],
                                    payload[index + 1],
                                    payload[index + 2],
                                    payload[index + 3],
                                ]);
                                index += 4;
                                let next = if mix_value < 1.0 {
                                    (mix_value + step).min(1.0)
                                } else {
                                    1.0
                                };
                                mix_value = next;
                                mix.store(next.to_bits(), Ordering::Relaxed);
                                let _ = wet.push_slice(&[sample, sample]);
                            }
                            stats.chunks_returned.fetch_add(1, Ordering::Relaxed);
                            returned = true;
                            break;
                        }
                    }
                }
                Ok((kind, payload)) if kind == KIND_JSON => {
                    let _ = payload;
                }
                Ok((KIND_PING, _)) => {
                    let _ = ai.send_ping();
                }
                Ok((KIND_PONG, _)) => {}
                Ok(_) => break,
                Err(_) => break,
            }
        }

        if returned {
            let elapsed = started.elapsed().as_secs_f32();
            let chunk_seconds = chunk_frames as f32 / sample_rate.max(1.0);
            if chunk_seconds > 0.0 {
                let rtf = chunk_seconds / elapsed.max(1e-4);
                stats.note_rtf(rtf);
                stats
                    .last_roundtrip_us
                    .store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
            }
        } else {
            stats.chunks_dropped.fetch_add(1, Ordering::Relaxed);
            wet.clear();
        }
    }
}

/// Linear amplitude to dBFS.
fn linear_to_db(value: f32) -> f32 {
    (20.0 * value.abs().max(1e-6).log10()).clamp(-96.0, 0.0)
}

/// Convert the mixer snapshot's `ai` block into realtime AI parameters. Only
/// `ai` / `hybrid` modes with the AI stage enabled arm the converter.
pub fn params_from_snapshot(value: &Value, sample_rate: u32) -> AiRuntimeParams {
    let mut params = AiRuntimeParams::default();
    if let Some(ai) = value.get("ai") {
        let mode = ai.get("mode").and_then(Value::as_str).unwrap_or("off");
        params.enabled = ai.get("enabled").and_then(Value::as_bool).unwrap_or(false)
            && matches!(mode, "ai" | "hybrid");
        let layout = AiLayout::from_parts(
            sample_rate,
            ai.get("chunkMs").and_then(Value::as_u64).unwrap_or(160),
            ai.get("crossfadeMs").and_then(Value::as_u64).unwrap_or(40),
        );
        params.chunk_frames = layout.chunk_frames;
        params.crossfade_frames = layout.crossfade_frames;
        params.pitch = ai.get("pitch").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        params.formant = ai.get("formant").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        params.index_rate = ai
            .get("indexRate")
            .and_then(Value::as_f64)
            .unwrap_or(48_000.0) as f32;
        params.mix = ai.get("mix").and_then(Value::as_f64).unwrap_or(100.0) as f32 / 100.0;
        params.gate_db = ai.get("gateDb").and_then(Value::as_f64).unwrap_or(-55.0) as f32;
        params.max_backlog = MAX_BACKLOG;
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_clamps_chunk_and_crossfade() {
        let layout = AiLayout::from_parts(48_000, 160, 400);
        assert_eq!(layout.chunk_frames, 7_680);
        assert_eq!(layout.crossfade_frames, 3_840);
    }

    #[test]
    fn ai_telemetry_reports_buffered_frames_as_latency() {
        let stats = AiRealtimeStats::default();
        let telemetry = AiTelemetry::from_shared(true, &stats, 48_000, linear_to_db(1e-6), 2_880);
        assert!(telemetry.active);
        assert!((telemetry.latency_ms - 60.0).abs() < 0.01);
    }
}
