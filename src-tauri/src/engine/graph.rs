//! Mixer graph: 5 strips → routing matrix → 5 buses.
//!
//! The graph is allocation-free after construction. Parameter changes arrive as
//! a plain serde snapshot (the same JSON the UI already persists) and are
//! applied at a block boundary by [`MixerGraph::apply_params`].
//!
//! Signal order per strip:
//! `mono → pan/gain → phase → gate → compressor → EQ → de-esser → saturator → tilt`.
//! Per bus:
//! `EQ → delay → width → gain/dim → mono → mute → limiter`.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};

use super::ai_audio::AiAudioState;
use super::dsp::{
    apply_width, db_to_linear, linear_to_db, pan_gains, Biquad, BiquadCoeffs, Compressor,
    CompressorParams, DeEsser, DeEsserParams, FilterKind, Gate, GateParams, Limiter, LimiterParams,
    PitchShifter, Saturator, SaturatorParams,
};
use super::recorder::RecorderParams;

pub const STRIPS: usize = 8;
pub const BUSES: usize = 15;
pub const EQ_BANDS: usize = 10;

pub const STRIP_IDS: [&str; STRIPS] = ["hw1", "hw2", "hw3", "vaio", "aux", "hw4", "hw5", "hw6"];
pub const BUS_IDS: [&str; BUSES] = [
    "A1", "A2", "A3", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12",
];

// ---------------------------------------------------------------------------
// Wire format (camelCase, mirrors src/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MixerParams {
    pub strips: BTreeMap<String, StripParams>,
    pub buses: BTreeMap<String, BusParams>,
    pub recorder: RecorderParams,
    /// Master-bus EQ, applied to every output after bus processing.
    pub master_eq: Vec<EqBandSnapshot>,
    pub master_gain_db: f32,
    /// Voice AI stage. Only the fields needed to decide whether the realtime
    /// path is armed live here; the conversion parameters travel separately.
    pub ai: AiBlock,
}

/// Subset of the UI `AiSettings` snapshot the audio graph cares about.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiBlock {
    pub enabled: bool,
    pub mode: String,
    /// Input channel the voice stage listens to. Defaults to the microphone.
    pub source: String,
    /// Local DSP pitch shift in semitones.
    pub pitch: f32,
    /// Local formant tilt in semitones (approximated with a shelf).
    pub formant: f32,
    /// Wet/dry mix, 0..1.
    pub mix: f32,
    /// Use the built-in pitch stage instead of the Python sidecar.
    pub local: bool,
    /// Ring-modulate the wet voice (robot preset).
    pub robot: bool,
}

impl AiBlock {
    fn source_slot(&self) -> Option<usize> {
        if !self.enabled {
            return None;
        }
        let fallback = if self.source.is_empty() {
            "hw1"
        } else {
            self.source.as_str()
        };
        STRIP_IDS.iter().position(|id| *id == fallback)
    }

    /// Strip the realtime *sidecar* path converts. Local DSP never opens it.
    pub fn sidecar_slot(&self) -> Option<usize> {
        if self.local || !matches!(self.mode.as_str(), "ai" | "hybrid") {
            return None;
        }
        self.source_slot()
    }

    /// Strip the built-in local voice stage converts.
    pub fn voice_slot(&self) -> Option<usize> {
        if self.local {
            self.source_slot()
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StripParams {
    pub device_id: String,
    pub gain_db: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub mono: bool,
    pub phase: bool,
    pub voice_tilt_db: f32,
    /// Gain offset contributed by the strip's VCA group.
    pub vca_gain_db: f32,
    /// Mute state contributed by the strip's VCA group.
    pub vca_mute: bool,
    pub routing: BTreeMap<String, RouteParams>,
    pub fx: StripFxParams,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RouteParams {
    pub on: bool,
    pub level_db: f32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StripFxParams {
    pub gate: GateSnapshot,
    pub compressor: CompressorSnapshot,
    pub eq: Vec<EqBandSnapshot>,
    pub deesser: DeEsserSnapshot,
    pub saturator: SaturatorSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GateSnapshot {
    pub enabled: bool,
    pub threshold: f32,
    pub attack: f32,
    pub hold: f32,
    pub release: f32,
    pub range: f32,
}

impl Default for GateSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: -48.0,
            attack: 5.0,
            hold: 80.0,
            release: 220.0,
            range: -60.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressorSnapshot {
    pub enabled: bool,
    pub threshold: f32,
    pub ratio: f32,
    pub attack: f32,
    pub release: f32,
    pub makeup: f32,
    pub knee: f32,
}

impl Default for CompressorSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: -18.0,
            ratio: 3.0,
            attack: 12.0,
            release: 180.0,
            makeup: 3.0,
            knee: 6.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeEsserSnapshot {
    pub enabled: bool,
    pub frequency: f32,
    pub threshold: f32,
    pub amount: f32,
}

impl Default for DeEsserSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: 6500.0,
            threshold: -30.0,
            amount: 45.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaturatorSnapshot {
    pub enabled: bool,
    pub drive: f32,
    pub mix: f32,
    pub tone: f32,
}

impl Default for SaturatorSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            drive: 22.0,
            mix: 30.0,
            tone: 0.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqBandSnapshot {
    #[serde(rename = "type")]
    pub kind: String,
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
    pub enabled: bool,
}

impl Default for EqBandSnapshot {
    fn default() -> Self {
        Self {
            kind: "peaking".into(),
            freq: 1_000.0,
            gain: 0.0,
            q: 1.0,
            enabled: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BusParams {
    pub device_id: String,
    pub gain_db: f32,
    pub mute: bool,
    pub mono: bool,
    pub dim: bool,
    pub fx: BusFxParams,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BusFxParams {
    pub eq: Vec<EqBandSnapshot>,
    pub limiter: LimiterSnapshot,
    pub delay_ms: f32,
    pub width: f32,
}

impl Default for BusFxParams {
    fn default() -> Self {
        Self {
            eq: Vec::new(),
            limiter: LimiterSnapshot::default(),
            delay_ms: 0.0,
            width: 100.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LimiterSnapshot {
    pub enabled: bool,
    pub ceiling: f32,
    pub release: f32,
}

impl Default for LimiterSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            ceiling: -1.0,
            release: 80.0,
        }
    }
}

fn filter_kind(name: &str) -> FilterKind {
    match name {
        "lowshelf" => FilterKind::LowShelf,
        "highshelf" => FilterKind::HighShelf,
        "highpass" => FilterKind::HighPass,
        "lowpass" => FilterKind::LowPass,
        _ => FilterKind::Peaking,
    }
}

// ---------------------------------------------------------------------------
// Allocation-free runtime parameters
// ---------------------------------------------------------------------------

/// One EQ band in the exact form the audio thread consumes.
#[derive(Debug, Clone, Copy)]
pub struct EqRuntime {
    pub kind: FilterKind,
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
    pub enabled: bool,
}

impl Default for EqRuntime {
    fn default() -> Self {
        Self {
            kind: FilterKind::Peaking,
            freq: 1_000.0,
            gain: 0.0,
            q: 1.0,
            enabled: false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StripRuntime {
    pub gain_db: f32,
    pub pan: f32,
    pub phase: bool,
    pub mono: bool,
    pub mute: bool,
    pub solo: bool,
    pub tilt_db: f32,
    pub misc_gain_db: f32,
    pub routing: [f32; BUSES],
    pub gate_enabled: bool,
    pub gate: GateParams,
    pub compressor_enabled: bool,
    pub compressor: CompressorParams,
    pub eq: [EqRuntime; EQ_BANDS],
    pub deesser_enabled: bool,
    pub deesser: DeEsserParams,
    pub saturator_enabled: bool,
    pub saturator: SaturatorParams,
}

impl Default for StripRuntime {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            pan: 0.0,
            phase: false,
            mono: false,
            mute: false,
            solo: false,
            tilt_db: 0.0,
            misc_gain_db: 0.0,
            routing: [0.0; BUSES],
            gate_enabled: false,
            gate: GateParams::default(),
            compressor_enabled: false,
            compressor: CompressorParams::default(),
            eq: [EqRuntime::default(); EQ_BANDS],
            deesser_enabled: false,
            deesser: DeEsserParams::default(),
            saturator_enabled: false,
            saturator: SaturatorParams::default(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BusRuntime {
    pub gain_db: f32,
    pub mute: bool,
    pub mono: bool,
    pub dim: bool,
    /// Percent, 0..200.
    pub width: f32,
    pub delay_ms: f32,
    pub limiter_enabled: bool,
    pub limiter: LimiterParams,
    pub eq: [EqRuntime; EQ_BANDS],
}

impl Default for BusRuntime {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            mute: false,
            mono: false,
            dim: false,
            width: 100.0,
            delay_ms: 0.0,
            limiter_enabled: false,
            limiter: LimiterParams::default(),
            eq: [EqRuntime::default(); EQ_BANDS],
        }
    }
}

/// Fixed-size, `Copy` snapshot handed to the audio thread through a channel.
/// Dropping it never touches the heap.
#[derive(Debug, Clone, Copy)]
pub struct GraphParams {
    pub strips: [StripRuntime; STRIPS],
    pub buses: [BusRuntime; BUSES],
    pub solo_active: bool,
    pub master_eq: [EqRuntime; EQ_BANDS],
    pub master_gain_db: f32,
    /// Strip the AI path converts, or `None` when it is bypassed.
    pub ai_source: Option<usize>,
    /// Strip the local pitch/voice stage converts.
    pub voice_source: Option<usize>,
    pub voice_pitch: f32,
    pub voice_formant: f32,
    pub voice_mix: f32,
    pub voice_robot: bool,
}

impl Default for GraphParams {
    fn default() -> Self {
        Self {
            strips: [StripRuntime::default(); STRIPS],
            buses: [BusRuntime::default(); BUSES],
            solo_active: false,
            master_eq: [EqRuntime::default(); EQ_BANDS],
            master_gain_db: 0.0,
            ai_source: None,
            voice_source: None,
            voice_pitch: 0.0,
            voice_formant: 0.0,
            voice_mix: 1.0,
            voice_robot: false,
        }
    }
}

impl MixerParams {
    /// Convert the UI snapshot into the allocation-free runtime form.
    /// Runs on the control thread.
    pub fn to_graph(&self) -> GraphParams {
        let strips = std::array::from_fn(|index| match self.strips.get(STRIP_IDS[index]) {
            Some(strip) => strip.to_runtime(),
            None => StripRuntime::default(),
        });
        let buses = std::array::from_fn(|index| match self.buses.get(BUS_IDS[index]) {
            Some(bus) => bus.to_runtime(),
            None => BusRuntime::default(),
        });
        let master_eq = std::array::from_fn(|index| match self.master_eq.get(index) {
            Some(band) => EqRuntime {
                kind: filter_kind(&band.kind),
                freq: band.freq,
                gain: band.gain,
                q: band.q,
                enabled: band.enabled,
            },
            None => EqRuntime::default(),
        });
        GraphParams {
            strips,
            buses,
            solo_active: self.strips.values().any(|strip| strip.solo),
            master_eq,
            master_gain_db: self.master_gain_db,
            ai_source: self.ai.sidecar_slot(),
            voice_source: self.ai.voice_slot(),
            voice_pitch: self.ai.pitch,
            voice_formant: self.ai.formant,
            voice_mix: (self.ai.mix / 100.0).clamp(0.0, 1.0),
            voice_robot: self.ai.robot,
        }
    }
}

impl StripParams {
    fn to_runtime(&self) -> StripRuntime {
        let mut routing = [0.0; BUSES];
        for (index, id) in BUS_IDS.iter().enumerate() {
            if let Some(route) = self.routing.get(*id) {
                if route.on && route.level_db > -60.0 {
                    routing[index] = db_to_linear(route.level_db);
                }
            }
        }

        let mut eq = [EqRuntime::default(); EQ_BANDS];
        for (index, slot) in eq.iter_mut().enumerate() {
            if let Some(band) = self.fx.eq.get(index) {
                *slot = EqRuntime {
                    kind: filter_kind(&band.kind),
                    freq: band.freq,
                    gain: band.gain,
                    q: band.q,
                    enabled: band.enabled,
                };
            }
        }

        StripRuntime {
            gain_db: self.gain_db,
            pan: self.pan,
            phase: self.phase,
            mono: self.mono,
            mute: self.mute || self.vca_mute,
            solo: self.solo,
            tilt_db: self.voice_tilt_db,
            misc_gain_db: self.vca_gain_db,
            routing,
            gate_enabled: self.fx.gate.enabled,
            gate: GateParams {
                threshold_db: self.fx.gate.threshold,
                attack_ms: self.fx.gate.attack,
                hold_ms: self.fx.gate.hold,
                release_ms: self.fx.gate.release,
                range_db: self.fx.gate.range,
                hysteresis_db: 3.0,
            },
            compressor_enabled: self.fx.compressor.enabled,
            compressor: CompressorParams {
                threshold_db: self.fx.compressor.threshold,
                ratio: self.fx.compressor.ratio,
                attack_ms: self.fx.compressor.attack,
                release_ms: self.fx.compressor.release,
                makeup_db: self.fx.compressor.makeup,
                knee_db: self.fx.compressor.knee,
            },
            eq,
            deesser_enabled: self.fx.deesser.enabled,
            deesser: DeEsserParams {
                frequency: self.fx.deesser.frequency,
                threshold_db: self.fx.deesser.threshold,
                amount: self.fx.deesser.amount,
            },
            saturator_enabled: self.fx.saturator.enabled,
            saturator: SaturatorParams {
                drive: self.fx.saturator.drive,
                mix: self.fx.saturator.mix,
                tone: self.fx.saturator.tone,
            },
        }
    }
}

impl BusParams {
    fn to_runtime(&self) -> BusRuntime {
        let mut eq = [EqRuntime::default(); EQ_BANDS];
        for (index, slot) in eq.iter_mut().enumerate() {
            if let Some(band) = self.fx.eq.get(index) {
                *slot = EqRuntime {
                    kind: filter_kind(&band.kind),
                    freq: band.freq,
                    gain: band.gain,
                    q: band.q,
                    enabled: band.enabled,
                };
            }
        }

        BusRuntime {
            gain_db: self.gain_db,
            mute: self.mute,
            mono: self.mono,
            dim: self.dim,
            width: self.fx.width,
            delay_ms: self.fx.delay_ms,
            limiter_enabled: self.fx.limiter.enabled,
            limiter: LimiterParams {
                ceiling_db: self.fx.limiter.ceiling,
                release_ms: self.fx.limiter.release,
            },
            eq,
        }
    }
}

// ---------------------------------------------------------------------------
// Strip
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ChannelChain {
    gate: Gate,
    gate_enabled: bool,
    compressor: Compressor,
    compressor_enabled: bool,
    eq: [Biquad; EQ_BANDS],
    eq_enabled: [bool; EQ_BANDS],
    deesser: DeEsser,
    deesser_enabled: bool,
    saturator: Saturator,
    saturator_enabled: bool,
    tilt: Biquad,
}

impl ChannelChain {
    fn new(sample_rate: f32) -> Self {
        Self {
            gate: Gate::new(sample_rate, GateParams::default()),
            gate_enabled: false,
            compressor: Compressor::new(sample_rate, CompressorParams::default()),
            compressor_enabled: false,
            eq: [Biquad::default(); EQ_BANDS],
            eq_enabled: [false; EQ_BANDS],
            deesser: DeEsser::new(sample_rate, DeEsserParams::default()),
            deesser_enabled: false,
            saturator: Saturator::new(sample_rate, SaturatorParams::default()),
            saturator_enabled: false,
            tilt: Biquad::default(),
        }
    }

    fn configure(&mut self, strip: &StripRuntime, sample_rate: f32) {
        self.gate_enabled = strip.gate_enabled;
        self.gate.set_params(strip.gate);

        self.compressor_enabled = strip.compressor_enabled;
        self.compressor.set_params(strip.compressor);

        for index in 0..EQ_BANDS {
            let band = strip.eq[index];
            self.eq_enabled[index] = band.enabled;
            self.eq[index].set_coeffs(BiquadCoeffs::design(
                band.kind,
                sample_rate,
                band.freq,
                band.gain,
                band.q,
            ));
        }

        self.deesser_enabled = strip.deesser_enabled;
        self.deesser.set_params(strip.deesser);

        self.saturator_enabled = strip.saturator_enabled;
        self.saturator.set_params(strip.saturator);

        self.tilt.set_coeffs(BiquadCoeffs::design(
            FilterKind::HighShelf,
            sample_rate,
            1_200.0,
            strip.tilt_db.clamp(-20.0, 20.0),
            0.7,
        ));
    }

    #[inline]
    fn process(&mut self, mut sample: f32) -> f32 {
        if self.gate_enabled {
            sample = self.gate.process(sample);
        }
        if self.compressor_enabled {
            sample = self.compressor.process(sample);
        }
        for index in 0..EQ_BANDS {
            if self.eq_enabled[index] {
                sample = self.eq[index].process(sample);
            }
        }
        if self.deesser_enabled {
            sample = self.deesser.process(sample);
        }
        if self.saturator_enabled {
            sample = self.saturator.process(sample);
        }
        self.tilt.process(sample)
    }
}

#[derive(Debug, Clone)]
pub struct StripChain {
    channels: [ChannelChain; 2],
    gain_db: f32,
    pan: f32,
    phase: bool,
    mono: bool,
    pub mute: bool,
    pub solo: bool,
    pub routing: [f32; BUSES],
}

impl StripChain {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            channels: std::array::from_fn(|_| ChannelChain::new(sample_rate)),
            gain_db: 0.0,
            pan: 0.0,
            phase: false,
            mono: false,
            mute: false,
            solo: false,
            routing: [0.0; BUSES],
        }
    }

    pub fn configure(&mut self, strip: &StripRuntime, sample_rate: f32) {
        self.gain_db = strip.gain_db + strip.misc_gain_db;
        self.pan = strip.pan;
        self.phase = strip.phase;
        self.mono = strip.mono;
        self.mute = strip.mute;
        self.solo = strip.solo;
        self.routing = strip.routing;

        for channel in &mut self.channels {
            channel.configure(strip, sample_rate);
        }
    }

    #[inline]
    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let (mut left, mut right) = if self.mono {
            let mid = (left + right) * 0.5;
            (mid, mid)
        } else {
            (left, right)
        };

        if self.phase {
            left = -left;
            right = -right;
        }

        let gain = db_to_linear(self.gain_db);
        let (pan_left, pan_right) = pan_gains(self.pan);
        left = self.channels[0].process(left * gain * pan_left);
        right = self.channels[1].process(right * gain * pan_right);
        (left, right)
    }

    pub fn reset(&mut self) {
        for channel in &mut self.channels {
            channel.gate.reset();
            channel.compressor.reset();
            for band in &mut channel.eq {
                band.reset();
            }
            channel.deesser.reset();
            channel.saturator.reset();
            channel.tilt.reset();
        }
    }
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct BusChannel {
    eq: [Biquad; EQ_BANDS],
    eq_enabled: [bool; EQ_BANDS],
    limiter: Limiter,
    limiter_enabled: bool,
    delay: Vec<f32>,
    delay_index: usize,
    delay_samples: usize,
}

impl BusChannel {
    fn new(sample_rate: f32) -> Self {
        // 500 ms of headroom, the maximum the UI exposes.
        let delay_len = (sample_rate.max(1.0) * 0.5).ceil() as usize + 1;
        Self {
            eq: [Biquad::default(); EQ_BANDS],
            eq_enabled: [false; EQ_BANDS],
            limiter: Limiter::new(sample_rate, LimiterParams::default()),
            limiter_enabled: false,
            delay: vec![0.0; delay_len],
            delay_index: 0,
            delay_samples: 0,
        }
    }

    fn configure(&mut self, bus: &BusRuntime, sample_rate: f32) {
        for index in 0..EQ_BANDS {
            let band = bus.eq[index];
            self.eq_enabled[index] = band.enabled;
            self.eq[index].set_coeffs(BiquadCoeffs::design(
                band.kind,
                sample_rate,
                band.freq,
                band.gain,
                band.q,
            ));
        }

        self.limiter_enabled = bus.limiter_enabled;
        self.limiter.set_params(bus.limiter);

        let samples = (bus.delay_ms.max(0.0) * 0.001 * sample_rate) as usize;
        self.delay_samples = samples.min(self.delay.len().saturating_sub(1));
    }

    #[inline]
    fn process_eq(&mut self, mut sample: f32) -> f32 {
        for index in 0..EQ_BANDS {
            if self.eq_enabled[index] {
                sample = self.eq[index].process(sample);
            }
        }
        sample
    }

    #[inline]
    fn process_delay(&mut self, sample: f32) -> f32 {
        if self.delay_samples == 0 {
            return sample;
        }
        let len = self.delay.len();
        let read = (self.delay_index + len - self.delay_samples) % len;
        let delayed = self.delay[read];
        self.delay[self.delay_index] = sample;
        self.delay_index = (self.delay_index + 1) % len;
        delayed
    }

    fn reset(&mut self) {
        for band in &mut self.eq {
            band.reset();
        }
        self.limiter.reset();
        self.delay.fill(0.0);
        self.delay_index = 0;
    }
}

#[derive(Debug, Clone)]
pub struct BusChain {
    channels: [BusChannel; 2],
    gain_db: f32,
    pub mute: bool,
    mono: bool,
    dim: bool,
    width: f32,
}

impl BusChain {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            channels: std::array::from_fn(|_| BusChannel::new(sample_rate)),
            gain_db: 0.0,
            mute: false,
            mono: false,
            dim: false,
            width: 1.0,
        }
    }

    pub fn configure(&mut self, bus: &BusRuntime, sample_rate: f32) {
        self.gain_db = bus.gain_db;
        self.mute = bus.mute;
        self.mono = bus.mono;
        self.dim = bus.dim;
        self.width = (bus.width / 100.0).clamp(0.0, 2.0);
        for channel in &mut self.channels {
            channel.configure(bus, sample_rate);
        }
    }

    #[inline]
    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let mut left = self.channels[0].process_eq(left);
        let mut right = self.channels[1].process_eq(right);

        left = self.channels[0].process_delay(left);
        right = self.channels[1].process_delay(right);

        let (mut left, mut right) = apply_width(left, right, self.width);

        let gain = db_to_linear(self.gain_db + if self.dim { -20.0 } else { 0.0 });
        left *= gain;
        right *= gain;

        if self.mono {
            let mid = (left + right) * 0.5;
            left = mid;
            right = mid;
        }

        if self.mute {
            left = 0.0;
            right = 0.0;
        }

        if self.channels[0].limiter_enabled {
            left = self.channels[0].limiter.process(left);
        }
        if self.channels[1].limiter_enabled {
            right = self.channels[1].limiter.process(right);
        }

        (left, right)
    }

    pub fn reset(&mut self) {
        for channel in &mut self.channels {
            channel.reset();
        }
    }
}

// ---------------------------------------------------------------------------
// Local realtime voice stage
// ---------------------------------------------------------------------------

/// Stereo wrapper around the granular pitch shifter plus a gentle formant
/// shelf. The stage is deliberately small and lock-free: it lives on the
/// control thread's stack during parameter changes and on the audio thread
/// during rendering.
struct VoiceFx {
    left: PitchShifter,
    right: PitchShifter,
    shelf_left: Biquad,
    shelf_right: Biquad,
    sample_rate: f32,
    pitch: f32,
    formant: f32,
    mix: f32,
    robot: bool,
    robot_phase: f32,
    enabled: bool,
}

impl VoiceFx {
    fn new(sample_rate: f32) -> Self {
        let sample_rate = sample_rate.max(1.0);
        let mut voice = Self {
            left: PitchShifter::new(sample_rate),
            right: PitchShifter::new(sample_rate),
            shelf_left: Biquad::default(),
            shelf_right: Biquad::default(),
            sample_rate,
            pitch: 0.0,
            formant: 0.0,
            mix: 1.0,
            robot: false,
            robot_phase: 0.0,
            enabled: false,
        };
        voice.configure(false, 0.0, 0.0, 1.0, false);
        voice
    }

    fn configure(&mut self, enabled: bool, pitch: f32, formant: f32, mix: f32, robot: bool) {
        self.enabled = enabled;
        self.pitch = pitch.clamp(-24.0, 24.0);
        self.formant = formant.clamp(-12.0, 12.0);
        self.mix = mix.clamp(0.0, 1.0);
        self.robot = robot;
        let ratio = 2.0_f32.powf(self.pitch / 12.0);
        self.left.set_ratio(ratio);
        self.right.set_ratio(ratio);
        let shelf = BiquadCoeffs::design(
            FilterKind::HighShelf,
            self.sample_rate,
            1_200.0,
            self.formant * 0.7,
            0.7,
        );
        self.shelf_left.set_coeffs(shelf);
        self.shelf_right.set_coeffs(shelf);
    }

    #[inline]
    fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        if !self.enabled || self.mix <= 0.0 {
            return (left, right);
        }
        let mut wet_left = self.shelf_left.process(self.left.process(left));
        let mut wet_right = self.shelf_right.process(self.right.process(right));
        if self.robot {
            self.robot_phase = (self.robot_phase
                + 2.0 * std::f32::consts::PI * 70.0 / self.sample_rate)
                .rem_euclid(2.0 * std::f32::consts::PI);
            let carrier = 0.55 + 0.45 * self.robot_phase.sin();
            wet_left *= carrier;
            wet_right *= carrier;
        }
        let dry = 1.0 - self.mix;
        (
            left * dry + wet_left * self.mix,
            right * dry + wet_right * self.mix,
        )
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
        self.shelf_left.reset();
        self.shelf_right.reset();
    }
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

pub struct MixerGraph {
    sample_rate: f32,
    strips: [StripChain; STRIPS],
    buses: [BusChain; BUSES],
    /// Master EQ runs on both output channels of every bus. Each bus needs its
    /// own filter state: sharing it would advance the filter five times per
    /// sample and detune the response.
    master_eq_left: [[Biquad; EQ_BANDS]; BUSES],
    master_eq_right: [[Biquad; EQ_BANDS]; BUSES],
    master_eq_enabled: [bool; EQ_BANDS],
    master_gain_db: f32,
    solo_active: bool,
    bus_accumulator: [(f32, f32); BUSES],
    strip_peak: [f32; STRIPS],
    bus_peak: [f32; BUSES],
    /// Taps the source strip through the realtime AI path when armed.
    ai: Option<AiAudioState>,
    /// Index of the strip the AI path converts (post-DSP signal).
    ai_source: Option<usize>,
    /// Local pitch/formant stage (selected input only).
    voice: VoiceFx,
    voice_source: Option<usize>,
}

impl MixerGraph {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sample_rate.max(1.0);
        Self {
            sample_rate,
            strips: std::array::from_fn(|_| StripChain::new(sample_rate)),
            buses: std::array::from_fn(|_| BusChain::new(sample_rate)),
            master_eq_left: [[Biquad::default(); EQ_BANDS]; BUSES],
            master_eq_right: [[Biquad::default(); EQ_BANDS]; BUSES],
            master_eq_enabled: [false; EQ_BANDS],
            master_gain_db: 0.0,
            solo_active: false,
            bus_accumulator: [(0.0, 0.0); BUSES],
            strip_peak: [0.0; STRIPS],
            bus_peak: [0.0; BUSES],
            ai: None,
            ai_source: None,
            voice: VoiceFx::new(sample_rate),
            voice_source: None,
        }
    }

    /// Arm the realtime AI path on `source_slot`. Passing `None` bypasses it.
    pub fn configure_ai(&mut self, source_slot: Option<usize>, ai: Option<AiAudioState>) {
        self.ai_source = source_slot;
        self.ai = ai;
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// Apply a UI snapshot. Called by the audio thread between blocks, so it
    /// must not allocate: all buffers were sized at construction and
    /// [`GraphParams`] is `Copy`.
    pub fn apply_params(&mut self, params: &GraphParams) {
        self.solo_active = params.solo_active;
        self.ai_source = params.ai_source;
        self.voice_source = params.voice_source;
        self.voice.configure(
            params.voice_source.is_some(),
            params.voice_pitch,
            params.voice_formant,
            params.voice_mix,
            params.voice_robot,
        );
        for (index, strip) in params.strips.iter().enumerate() {
            self.strips[index].configure(strip, self.sample_rate);
        }
        for (index, bus) in params.buses.iter().enumerate() {
            self.buses[index].configure(bus, self.sample_rate);
        }
        for index in 0..EQ_BANDS {
            let band = params.master_eq[index];
            self.master_eq_enabled[index] = band.enabled;
            let coeffs =
                BiquadCoeffs::design(band.kind, self.sample_rate, band.freq, band.gain, band.q);
            for bus in 0..BUSES {
                self.master_eq_left[bus][index].set_coeffs(coeffs);
                self.master_eq_right[bus][index].set_coeffs(coeffs);
            }
        }
        self.master_gain_db = params.master_gain_db;
    }

    #[inline]
    pub fn process_frame(&mut self, inputs: &[(f32, f32); STRIPS]) -> [(f32, f32); BUSES] {
        self.process_frame_with_extras(
            inputs,
            &[(0.0, 0.0); STRIPS],
            &[(0.0, 0.0); BUSES],
            (0.0, 0.0),
            usize::MAX,
        )
    }

    /// Same as [`Self::process_frame`] but sums external sources (sound pads)
    /// into the strip inputs, the bus sums and the master sum. Extras are added
    /// *before* the stage they target, so pad audio runs through the same EQ,
    /// compressor, VCA, routing and master processing as any other signal.
    #[inline]
    pub fn process_frame_with_extras(
        &mut self,
        inputs: &[(f32, f32); STRIPS],
        strip_extra: &[(f32, f32); STRIPS],
        bus_extra: &[(f32, f32); BUSES],
        master_extra: (f32, f32),
        master_bus: usize,
    ) -> [(f32, f32); BUSES] {
        self.bus_accumulator.fill((0.0, 0.0));

        for (index, ((input, extra), strip)) in inputs
            .iter()
            .zip(strip_extra.iter())
            .zip(self.strips.iter_mut())
            .enumerate()
        {
            let (mut out_left, mut out_right) = strip.process(input.0 + extra.0, input.1 + extra.1);
            if self.voice_source == Some(index) {
                let (wet_left, wet_right) = self.voice.process(out_left, out_right);
                out_left = wet_left;
                out_right = wet_right;
            }
            let (mute, solo, routing) = (strip.mute, strip.solo, strip.routing);
            let audible = !(mute || (self.solo_active && !solo));

            if self.ai_source == Some(index) {
                if let Some(ai) = self.ai.as_ref() {
                    if ai.gate.load(Ordering::Acquire) {
                        if audible {
                            let _ = ai.dry.push_slice(&[out_left, out_right]);
                            let (left, right) = ai.process(Some(index), out_left, out_right);
                            out_left = left;
                            out_right = right;
                        } else {
                            ai.skip_frame();
                        }
                    }
                }
            }

            let peak = out_left.abs().max(out_right.abs());
            if peak > self.strip_peak[index] {
                self.strip_peak[index] = peak;
            }

            if !audible {
                continue;
            }

            for (bus, send) in routing.iter().enumerate() {
                if *send != 0.0 {
                    self.bus_accumulator[bus].0 += out_left * *send;
                    self.bus_accumulator[bus].1 += out_right * *send;
                }
            }
        }

        if master_bus < BUSES {
            self.bus_accumulator[master_bus].0 += master_extra.0;
            self.bus_accumulator[master_bus].1 += master_extra.1;
        }
        for (bus, extra) in bus_extra.iter().enumerate() {
            self.bus_accumulator[bus].0 += extra.0;
            self.bus_accumulator[bus].1 += extra.1;
        }

        let mut outputs = [(0.0, 0.0); BUSES];
        for (bus, out) in outputs.iter_mut().enumerate() {
            let (mut left, mut right) =
                self.buses[bus].process(self.bus_accumulator[bus].0, self.bus_accumulator[bus].1);
            for index in 0..EQ_BANDS {
                if self.master_eq_enabled[index] {
                    left = self.master_eq_left[bus][index].process(left);
                    right = self.master_eq_right[bus][index].process(right);
                }
            }
            let master_gain = db_to_linear(self.master_gain_db);
            left *= master_gain;
            right *= master_gain;
            let peak = left.abs().max(right.abs());
            if peak > self.bus_peak[bus] {
                self.bus_peak[bus] = peak;
            }
            *out = (left, right);
        }
        outputs
    }

    /// Copy accumulated peaks into the shared meter bank and reset them.
    pub fn publish_meters(&mut self, meters: &MeterBank) {
        for index in 0..STRIPS {
            meters.strips[index].store(
                linear_to_db(self.strip_peak[index]).to_bits(),
                Ordering::Relaxed,
            );
            self.strip_peak[index] = 0.0;
        }
        for index in 0..BUSES {
            meters.buses[index].store(
                linear_to_db(self.bus_peak[index]).to_bits(),
                Ordering::Relaxed,
            );
            self.bus_peak[index] = 0.0;
        }
    }

    pub fn reset(&mut self) {
        for strip in &mut self.strips {
            strip.reset();
        }
        for bus in &mut self.buses {
            bus.reset();
        }
        for bus in &mut self.master_eq_left {
            for band in bus {
                band.reset();
            }
        }
        for bus in &mut self.master_eq_right {
            for band in bus {
                band.reset();
            }
        }
        self.voice.reset();
        self.bus_accumulator = [(0.0, 0.0); BUSES];
        self.strip_peak = [0.0; STRIPS];
        self.bus_peak = [0.0; BUSES];
    }
}

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterLevels {
    pub strips: [f32; STRIPS],
    pub buses: [f32; BUSES],
}

pub struct MeterBank {
    strips: [AtomicU32; STRIPS],
    buses: [AtomicU32; BUSES],
}

impl Default for MeterBank {
    fn default() -> Self {
        Self::new()
    }
}

impl MeterBank {
    pub fn new() -> Self {
        Self {
            strips: std::array::from_fn(|_| AtomicU32::new(linear_to_db(0.0).to_bits())),
            buses: std::array::from_fn(|_| AtomicU32::new(linear_to_db(0.0).to_bits())),
        }
    }

    pub fn snapshot(&self) -> MeterLevels {
        MeterLevels {
            strips: std::array::from_fn(|index| {
                f32::from_bits(self.strips[index].load(Ordering::Relaxed))
            }),
            buses: std::array::from_fn(|index| {
                f32::from_bits(self.buses[index].load(Ordering::Relaxed))
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn strip_with_route(bus: &str) -> StripParams {
        let mut strip = StripParams::default();
        strip.routing.insert(
            bus.into(),
            RouteParams {
                on: true,
                level_db: 0.0,
            },
        );
        strip
    }

    fn bus_default() -> BusParams {
        BusParams::default()
    }

    fn params_with_strip(id: &str, strip: StripParams) -> MixerParams {
        let mut params = MixerParams::default();
        params.strips.insert(id.into(), strip);
        params.buses.insert("A1".into(), bus_default());
        params
    }

    fn silence() -> [(f32, f32); STRIPS] {
        [(0.0, 0.0); STRIPS]
    }

    #[test]
    fn ai_path_arms_and_bypasses_from_snapshot() {
        let mut params = MixerParams {
            ai: AiBlock {
                enabled: true,
                mode: "hybrid".into(),
                ..AiBlock::default()
            },
            ..MixerParams::default()
        };
        let armed = params.to_graph();
        let mic = STRIP_IDS.iter().position(|id| *id == "hw1");
        assert_eq!(armed.ai_source, mic);

        let mut graph = MixerGraph::new(SR);
        graph.apply_params(&armed);
        assert_eq!(graph.ai_source, mic);

        params.ai = AiBlock {
            enabled: true,
            mode: "dsp".into(),
            ..AiBlock::default()
        };
        graph.apply_params(&params.to_graph());
        assert_eq!(graph.ai_source, None);
        assert_eq!(graph.voice_source, None);

        params.ai = AiBlock {
            enabled: false,
            mode: "ai".into(),
            ..AiBlock::default()
        };
        graph.apply_params(&params.to_graph());
        assert_eq!(graph.ai_source, None);
    }

    #[test]
    fn silence_stays_silent() {
        let mut graph = MixerGraph::new(SR);
        graph.apply_params(&MixerParams::default().to_graph());
        for _ in 0..128 {
            let out = graph.process_frame(&silence());
            for frame in out {
                assert_eq!(frame, (0.0, 0.0));
            }
        }
    }

    #[test]
    fn routes_input_to_selected_bus() {
        let mut graph = MixerGraph::new(SR);
        graph.apply_params(&params_with_strip("hw1", strip_with_route("A1")).to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        let out = graph.process_frame(&inputs);

        // Center pan is -3 dB on each side: 0.5 * cos(pi/4).
        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
        assert!((out[0].0 - expected).abs() < 1e-3, "left = {}", out[0].0);
        assert!((out[0].1 - expected).abs() < 1e-3, "right = {}", out[0].1);
        assert_eq!(out[1], (0.0, 0.0));
    }

    #[test]
    fn closed_route_is_silent() {
        let mut graph = MixerGraph::new(SR);
        let mut params = MixerParams::default();
        let mut strip = strip_with_route("A1");
        strip.routing.insert(
            "A1".into(),
            RouteParams {
                on: false,
                level_db: 0.0,
            },
        );
        params.strips.insert("hw1".into(), strip);
        graph.apply_params(&params.to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        assert_eq!(graph.process_frame(&inputs)[0], (0.0, 0.0));
    }

    #[test]
    fn mute_silences_strip() {
        let mut graph = MixerGraph::new(SR);
        let mut strip = strip_with_route("A1");
        strip.mute = true;
        graph.apply_params(&params_with_strip("hw1", strip).to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        assert_eq!(graph.process_frame(&inputs)[0], (0.0, 0.0));
    }

    #[test]
    fn solo_mutes_other_strips() {
        let mut graph = MixerGraph::new(SR);
        let mut params = MixerParams::default();
        let solo = {
            let mut strip = strip_with_route("A1");
            strip.solo = true;
            strip
        };
        params.strips.insert("hw2".into(), solo);
        params.strips.insert("hw1".into(), strip_with_route("A1"));
        graph.apply_params(&params.to_graph());

        let mut only_first = silence();
        only_first[0] = (0.5, 0.5);
        assert_eq!(graph.process_frame(&only_first)[0], (0.0, 0.0));

        let mut only_second = silence();
        only_second[1] = (0.5, 0.5);
        assert!(graph.process_frame(&only_second)[0].0 > 0.3);
    }

    #[test]
    fn bus_mute_silences_output() {
        let mut graph = MixerGraph::new(SR);
        let mut params = params_with_strip("hw1", strip_with_route("A1"));
        let mut bus = bus_default();
        bus.mute = true;
        params.buses.insert("A1".into(), bus);
        graph.apply_params(&params.to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        assert_eq!(graph.process_frame(&inputs)[0], (0.0, 0.0));
    }

    #[test]
    fn pan_left_moves_signal_to_left() {
        let mut graph = MixerGraph::new(SR);
        let mut strip = strip_with_route("A1");
        strip.pan = -1.0;
        graph.apply_params(&params_with_strip("hw1", strip).to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        let out = graph.process_frame(&inputs);
        assert!(out[0].0 > 0.45, "left = {}", out[0].0);
        assert!(out[0].1.abs() < 1e-3, "right = {}", out[0].1);
    }

    #[test]
    fn mono_collapses_stereo() {
        let mut graph = MixerGraph::new(SR);
        let mut strip = strip_with_route("A1");
        strip.mono = true;
        graph.apply_params(&params_with_strip("hw1", strip).to_graph());

        let mut inputs = silence();
        inputs[0] = (1.0, -1.0);
        let out = graph.process_frame(&inputs);
        assert!(out[0].0.abs() < 1e-3);
        assert!(out[0].1.abs() < 1e-3);
    }

    #[test]
    fn bus_gain_is_applied() {
        let mut graph = MixerGraph::new(SR);
        let mut params = params_with_strip("hw1", strip_with_route("A1"));
        let mut bus = bus_default();
        bus.gain_db = -6.0;
        params.buses.insert("A1".into(), bus);
        graph.apply_params(&params.to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        let out = graph.process_frame(&inputs);
        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2 * db_to_linear(-6.0);
        assert!((out[0].0 - expected).abs() < 1e-3);
    }

    #[test]
    fn meters_report_signal_level() {
        let mut graph = MixerGraph::new(SR);
        graph.apply_params(&params_with_strip("hw1", strip_with_route("A1")).to_graph());
        let meters = MeterBank::new();

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        for _ in 0..8 {
            graph.process_frame(&inputs);
        }
        graph.publish_meters(&meters);
        let levels = meters.snapshot();

        assert!(levels.strips[0] > -12.0, "strip = {}", levels.strips[0]);
        assert!(levels.buses[0] > -12.0, "bus = {}", levels.buses[0]);
        assert!(levels.strips[1] < -100.0);
    }

    #[test]
    fn local_voice_shifts_the_microphone_up() {
        let mut params = MixerParams {
            ai: AiBlock {
                enabled: true,
                mode: "dsp".into(),
                source: "hw1".into(),
                local: true,
                pitch: 12.0,
                formant: 0.0,
                mix: 100.0,
                robot: false,
            },
            ..MixerParams::default()
        };
        params.strips.insert("hw1".into(), strip_with_route("A1"));
        params.buses.insert("A1".into(), bus_default());
        assert_eq!(
            params.to_graph().voice_source,
            STRIP_IDS.iter().position(|id| *id == "hw1")
        );

        let mut graph = MixerGraph::new(SR);
        graph.apply_params(&params.to_graph());
        let mut previous = 0.0f32;
        let mut crossings = 0usize;
        for index in 0..48_000 {
            let sample = (2.0 * std::f32::consts::PI * 200.0 * index as f32 / SR).sin() * 0.4;
            let mut inputs = silence();
            inputs[0] = (sample, sample);
            let out = graph.process_frame(&inputs)[0].0;
            if index > 12_000 && previous <= 0.0 && out > 0.0 {
                crossings += 1;
            }
            previous = out;
        }
        let measured = crossings as f32 / ((48_000 - 12_000) as f32 / SR);
        assert!((measured - 400.0).abs() < 40.0, "measured = {measured} Hz");
    }

    #[test]
    fn config_json_is_accepted() {
        let json = r#"{
            "strips": {
                "hw1": {
                    "deviceId": "in:mic",
                    "gainDb": 3.0,
                    "pan": -0.25,
                    "mute": false,
                    "solo": false,
                    "mono": false,
                    "phase": false,
                    "voiceTiltDb": 2.0,
                    "routing": { "A1": { "on": true, "levelDb": -3.0 } },
                    "fx": {
                        "gate": { "enabled": true, "threshold": -52, "attack": 5, "hold": 80, "release": 220, "range": -70 },
                        "compressor": { "enabled": true, "threshold": -20, "ratio": 3.5, "attack": 8, "release": 160, "makeup": 4, "knee": 6 },
                        "eq": [
                            { "type": "peaking", "freq": 2200, "gain": 3, "q": 1.2, "enabled": true }
                        ],
                        "deesser": { "enabled": true, "frequency": 6500, "threshold": -30, "amount": 45 },
                        "saturator": { "enabled": false, "drive": 22, "mix": 30, "tone": 0 }
                    }
                }
            },
            "buses": {
                "A1": {
                    "deviceId": "out:speakers",
                    "gainDb": -2.0,
                    "mute": false,
                    "mono": false,
                    "dim": false,
                    "fx": {
                        "eq": [],
                        "limiter": { "enabled": true, "ceiling": -1, "release": 80 },
                        "delayMs": 12.0,
                        "width": 120
                    }
                }
            }
        }"#;

        let params: MixerParams = serde_json::from_str(json).expect("snapshot must deserialize");
        let mut graph = MixerGraph::new(SR);
        graph.apply_params(&params.to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        // Must not panic and must produce a finite signal.
        let out = graph.process_frame(&inputs);
        assert!(out[0].0.is_finite() && out[0].1.is_finite());
    }

    #[test]
    fn limiter_caps_bus_output() {
        let mut graph = MixerGraph::new(SR);
        let mut strip = strip_with_route("A1");
        strip.gain_db = 12.0;
        let mut params = params_with_strip("hw1", strip);
        let mut bus = bus_default();
        bus.fx.limiter.enabled = true;
        bus.fx.limiter.ceiling = -6.0;
        params.buses.insert("A1".into(), bus);
        graph.apply_params(&params.to_graph());

        let ceiling = db_to_linear(-6.0);
        let mut peak = 0.0_f32;
        for index in 0..20_000 {
            let sample = (2.0 * std::f32::consts::PI * 440.0 * index as f32 / SR).sin() * 0.9;
            let mut inputs = silence();
            inputs[0] = (sample, sample);
            let out = graph.process_frame(&inputs);
            if index > 4_000 {
                peak = peak.max(out[0].0.abs());
            }
        }
        assert!(peak <= ceiling + 0.08, "peak = {peak}, ceiling = {ceiling}");
    }

    #[test]
    fn meter_silence_is_minus_120_db() {
        let meters = MeterBank::new();
        let levels = meters.snapshot();
        assert!((levels.strips[0] - linear_to_db(0.0)).abs() < 1e-6);
    }

    #[test]
    fn vca_trim_and_mute_are_applied() {
        let mut graph = MixerGraph::new(SR);
        let mut strip = strip_with_route("A1");
        strip.vca_gain_db = -6.0;
        graph.apply_params(&params_with_strip("hw1", strip.clone()).to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        let out = graph.process_frame(&inputs);
        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2 * db_to_linear(-6.0);
        assert!((out[0].0 - expected).abs() < 2e-3, "left = {}", out[0].0);

        strip.vca_mute = true;
        graph.apply_params(&params_with_strip("hw1", strip).to_graph());
        let out = graph.process_frame(&inputs);
        assert_eq!(out[0], (0.0, 0.0));
    }

    #[test]
    fn master_gain_is_applied_after_bus_processing() {
        let mut graph = MixerGraph::new(SR);
        let mut params = params_with_strip("hw1", strip_with_route("A1"));
        params.master_gain_db = -6.0;
        graph.apply_params(&params.to_graph());

        let mut inputs = silence();
        inputs[0] = (0.5, 0.5);
        let out = graph.process_frame(&inputs);
        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2 * db_to_linear(-6.0);
        assert!((out[0].0 - expected).abs() < 2e-3, "left = {}", out[0].0);
    }

    #[test]
    fn master_highpass_removes_low_tone() {
        let mut params = params_with_strip("hw1", strip_with_route("A1"));
        params.master_eq.push(EqBandSnapshot {
            kind: "highpass".into(),
            freq: 4_000.0,
            gain: 0.0,
            q: 0.7,
            enabled: true,
        });

        let measure = |with_eq: bool| {
            let mut graph = MixerGraph::new(SR);
            let mut p = params.clone();
            if !with_eq {
                p.master_eq[0].enabled = false;
            }
            graph.apply_params(&p.to_graph());
            let mut energy = 0.0_f32;
            for index in 0..12_000 {
                let sample = (2.0 * std::f32::consts::PI * 110.0 * index as f32 / SR).sin() * 0.5;
                let mut inputs = silence();
                inputs[0] = (sample, sample);
                let out = graph.process_frame(&inputs);
                if index > 4_000 {
                    energy += out[0].0 * out[0].0;
                }
            }
            energy
        };

        let bypass = measure(false);
        let filtered = measure(true);
        assert!(
            filtered < bypass * 0.05,
            "filtered = {filtered}, bypass = {bypass}"
        );
    }
}
