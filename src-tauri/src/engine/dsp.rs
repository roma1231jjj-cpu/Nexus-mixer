//! Allocation-free DSP primitives for the realtime audio thread.
//!
//! Everything here is designed for per-sample processing inside a WASAPI
//! callback: no heap allocations after construction, no locks, no panics on
//! valid parameters. Coefficients are recomputed on the control thread and
//! handed over through the atomics in [`super::state`]; this module only owns
//! the per-sample math.
//!
//! Signal order per strip is:
//! `gain → phase → gate → compressor → EQ → de-esser → saturator`.
//! Buses run `EQ → delay → width → gain → limiter`.
//!
//! The parameter ranges below mirror the TypeScript model in `src/types.ts`.

use std::f32::consts::PI;

/// Anything quieter than this is treated as digital silence.
pub const SILENCE_DB: f32 = -120.0;

/// `dBFS → linear gain`.
#[inline]
pub fn db_to_linear(db: f32) -> f32 {
    if db <= SILENCE_DB {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

/// `linear gain → dBFS`, clamped at [`SILENCE_DB`].
#[inline]
pub fn linear_to_db(linear: f32) -> f32 {
    if linear <= 0.0 {
        SILENCE_DB
    } else {
        (20.0 * linear.log10()).max(SILENCE_DB)
    }
}

#[inline]
pub fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.max(min).min(max)
}

/// One-pole smoothing coefficient for a time constant in milliseconds.
#[inline]
pub fn time_coeff(ms: f32, sample_rate: f32) -> f32 {
    if ms <= 0.0 || sample_rate <= 0.0 {
        1.0
    } else {
        1.0 - (-1.0 / (ms * 0.001 * sample_rate)).exp()
    }
}

#[inline]
fn sanitize_freq(hz: f32, sample_rate: f32) -> f32 {
    clamp(hz, 10.0, sample_rate * 0.49)
}

// ---------------------------------------------------------------------------
// Biquad
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterKind {
    Peaking,
    LowShelf,
    HighShelf,
    HighPass,
    LowPass,
}

/// Normalized biquad coefficients (`a0` already divided out).
#[derive(Debug, Clone, Copy)]
pub struct BiquadCoeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Default for BiquadCoeffs {
    /// Identity filter: passes the signal untouched.
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

impl BiquadCoeffs {
    /// RBJ Audio EQ Cookbook design.
    ///
    /// `gain_db` is ignored by [`FilterKind::HighPass`] / [`FilterKind::LowPass`].
    pub fn design(kind: FilterKind, sample_rate: f32, freq: f32, gain_db: f32, q: f32) -> Self {
        let sr = sample_rate.max(1.0);
        let f0 = sanitize_freq(freq, sr);
        let q = clamp(q, 0.05, 40.0);
        let w0 = 2.0 * PI * f0 / sr;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        let a = 10.0_f32.powf(clamp(gain_db, -48.0, 48.0) / 40.0);

        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::Peaking => (
                1.0 + alpha * a,
                -2.0 * cos_w0,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w0,
                1.0 - alpha / a,
            ),
            FilterKind::LowShelf => {
                let beta = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 + beta),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 - beta),
                    (a + 1.0) + (a - 1.0) * cos_w0 + beta,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                    (a + 1.0) + (a - 1.0) * cos_w0 - beta,
                )
            }
            FilterKind::HighShelf => {
                let beta = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 + beta),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 - beta),
                    (a + 1.0) - (a - 1.0) * cos_w0 + beta,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                    (a + 1.0) - (a - 1.0) * cos_w0 - beta,
                )
            }
            FilterKind::HighPass => (
                (1.0 + cos_w0) * 0.5,
                -(1.0 + cos_w0),
                (1.0 + cos_w0) * 0.5,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
            FilterKind::LowPass => (
                (1.0 - cos_w0) * 0.5,
                1.0 - cos_w0,
                (1.0 - cos_w0) * 0.5,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
        };

        let inv_a0 = 1.0 / a0;
        Self {
            b0: b0 * inv_a0,
            b1: b1 * inv_a0,
            b2: b2 * inv_a0,
            a1: a1 * inv_a0,
            a2: a2 * inv_a0,
        }
    }
}

/// Direct Form II Transposed biquad.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    coeffs: BiquadCoeffs,
    z1: f32,
    z2: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        Self::new(BiquadCoeffs::default())
    }
}

impl Biquad {
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            coeffs,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Replaces the coefficients without resetting the filter state. Safe to
    /// call between blocks; the small transient is inaudible for EQ moves.
    pub fn set_coeffs(&mut self, coeffs: BiquadCoeffs) {
        self.coeffs = coeffs;
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let c = &self.coeffs;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
}

// ---------------------------------------------------------------------------
// Envelope follower
// ---------------------------------------------------------------------------

/// Peak envelope follower with independent attack/release times.
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeFollower {
    value: f32,
    attack: f32,
    release: f32,
    sample_rate: f32,
    attack_ms: f32,
    release_ms: f32,
}

impl EnvelopeFollower {
    pub fn new(sample_rate: f32, attack_ms: f32, release_ms: f32) -> Self {
        let mut env = Self {
            value: 0.0,
            attack: 0.0,
            release: 0.0,
            sample_rate: sample_rate.max(1.0),
            attack_ms,
            release_ms,
        };
        env.set_times(attack_ms, release_ms);
        env
    }

    pub fn set_times(&mut self, attack_ms: f32, release_ms: f32) {
        self.attack_ms = attack_ms.max(0.0);
        self.release_ms = release_ms.max(0.0);
        self.attack = time_coeff(self.attack_ms, self.sample_rate);
        self.release = time_coeff(self.release_ms, self.sample_rate);
    }

    /// Feed a rectified sample (`x.abs()`), get the smoothed envelope.
    #[inline]
    pub fn process(&mut self, rectified: f32) -> f32 {
        let coeff = if rectified > self.value {
            self.attack
        } else {
            self.release
        };
        self.value += coeff * (rectified - self.value);
        self.value
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.value
    }

    pub fn reset(&mut self) {
        self.value = 0.0;
    }
}

impl Default for EnvelopeFollower {
    fn default() -> Self {
        Self::new(48_000.0, 1.0, 50.0)
    }
}

// ---------------------------------------------------------------------------
// Parameter smoother
// ---------------------------------------------------------------------------

/// Linear ramp towards a target. Use for gain / pan / width changes so the UI
/// can move a fader without zipper noise.
#[derive(Debug, Clone, Copy)]
pub struct Smoothed {
    current: f32,
    target: f32,
    coeff: f32,
}

impl Smoothed {
    pub fn new(initial: f32, sample_rate: f32, ms: f32) -> Self {
        Self {
            current: initial,
            target: initial,
            coeff: time_coeff(ms, sample_rate),
        }
    }

    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    /// Jump immediately (audio start, preset recall in silence).
    pub fn reset(&mut self, value: f32) {
        self.current = value;
        self.target = value;
    }

    #[inline]
    pub fn advance(&mut self) -> f32 {
        self.current += self.coeff * (self.target - self.current);
        self.current
    }

    #[inline]
    pub fn current(&self) -> f32 {
        self.current
    }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateState {
    Open,
    Hold,
    Closed,
}

#[derive(Debug, Clone, Copy)]
pub struct GateParams {
    pub threshold_db: f32,
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub release_ms: f32,
    pub range_db: f32,
    /// dB of hysteresis around the threshold. Prevents chattering.
    pub hysteresis_db: f32,
}

impl Default for GateParams {
    fn default() -> Self {
        Self {
            threshold_db: -45.0,
            attack_ms: 3.0,
            hold_ms: 120.0,
            release_ms: 220.0,
            range_db: -60.0,
            hysteresis_db: 3.0,
        }
    }
}

/// Downward expander with hold. Silent input decays to `range_db`.
#[derive(Debug, Clone)]
pub struct Gate {
    sample_rate: f32,
    params: GateParams,
    detector: EnvelopeFollower,
    state: GateState,
    hold_remaining: u32,
    hold_samples: u32,
    gain: f32,
    attack_coeff: f32,
    release_coeff: f32,
}

impl Gate {
    pub fn new(sample_rate: f32, params: GateParams) -> Self {
        let sr = sample_rate.max(1.0);
        let mut gate = Self {
            sample_rate: sr,
            params,
            detector: EnvelopeFollower::new(sr, 0.2, 20.0),
            state: GateState::Open,
            hold_remaining: 0,
            hold_samples: 0,
            gain: 1.0,
            attack_coeff: 1.0,
            release_coeff: 1.0,
        };
        gate.set_params(params);
        gate
    }

    pub fn set_params(&mut self, params: GateParams) {
        self.params = params;
        self.hold_samples = (params.hold_ms.max(0.0) * 0.001 * self.sample_rate) as u32;
        self.attack_coeff = time_coeff(params.attack_ms, self.sample_rate);
        self.release_coeff = time_coeff(params.release_ms, self.sample_rate);
    }

    pub fn params(&self) -> GateParams {
        self.params
    }

    pub fn state(&self) -> GateState {
        self.state
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let level_db = linear_to_db(self.detector.process(x.abs()));
        let open_threshold = self.params.threshold_db + self.params.hysteresis_db;
        let close_threshold = self.params.threshold_db - self.params.hysteresis_db;

        if level_db >= open_threshold {
            self.state = GateState::Open;
            self.hold_remaining = self.hold_samples;
        } else if level_db >= close_threshold {
            if self.state != GateState::Closed {
                self.state = GateState::Hold;
                self.hold_remaining = self.hold_samples;
            }
        } else if self.hold_remaining > 0 {
            self.hold_remaining -= 1;
            if self.state == GateState::Open {
                self.state = GateState::Hold;
            }
        } else {
            self.state = GateState::Closed;
        }

        let target = if self.state == GateState::Closed {
            db_to_linear(self.params.range_db)
        } else {
            1.0
        };
        let coeff = if target > self.gain {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.gain += coeff * (target - self.gain);
        x * self.gain
    }

    pub fn reset(&mut self) {
        self.detector.reset();
        self.state = GateState::Open;
        self.hold_remaining = 0;
        self.gain = 1.0;
    }
}

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct CompressorParams {
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub knee_db: f32,
}

impl Default for CompressorParams {
    fn default() -> Self {
        Self {
            threshold_db: -18.0,
            ratio: 4.0,
            attack_ms: 12.0,
            release_ms: 160.0,
            makeup_db: 4.0,
            knee_db: 6.0,
        }
    }
}

/// Soft-knee peak compressor working in the dB domain.
#[derive(Debug, Clone)]
pub struct Compressor {
    sample_rate: f32,
    params: CompressorParams,
    detector: EnvelopeFollower,
    gain_db: f32,
    attack_coeff: f32,
    release_coeff: f32,
    makeup_linear: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32, params: CompressorParams) -> Self {
        let sr = sample_rate.max(1.0);
        let mut comp = Self {
            sample_rate: sr,
            params,
            detector: EnvelopeFollower::new(sr, 1.0, 60.0),
            gain_db: 0.0,
            attack_coeff: 1.0,
            release_coeff: 1.0,
            makeup_linear: 1.0,
        };
        comp.set_params(params);
        comp
    }

    pub fn set_params(&mut self, params: CompressorParams) {
        self.params = params;
        self.attack_coeff = time_coeff(params.attack_ms, self.sample_rate);
        self.release_coeff = time_coeff(params.release_ms, self.sample_rate);
        self.makeup_linear = db_to_linear(params.makeup_db);
    }

    pub fn params(&self) -> CompressorParams {
        self.params
    }

    /// Current gain reduction in dB (negative = reducing).
    pub fn gain_db(&self) -> f32 {
        self.gain_db
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let level_db = linear_to_db(self.detector.process(x.abs()));
        let over = level_db - self.params.threshold_db;
        let ratio = clamp(self.params.ratio, 1.0, 40.0);
        let knee = self.params.knee_db.max(0.0);
        let slope = 1.0 - 1.0 / ratio;

        let reduction_db = if over <= -knee * 0.5 {
            0.0
        } else if over < knee * 0.5 {
            let t = over + knee * 0.5;
            slope * t * t / (2.0 * knee.max(1e-6))
        } else {
            slope * over
        };

        let target = -reduction_db + self.params.makeup_db;
        let coeff = if target < self.gain_db {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.gain_db += coeff * (target - self.gain_db);
        x * db_to_linear(self.gain_db)
    }

    pub fn reset(&mut self) {
        self.detector.reset();
        self.gain_db = 0.0;
    }

    /// Static curve, useful for UI transfer-function previews and tests.
    pub fn static_reduction_db(&self, input_db: f32) -> f32 {
        let over = input_db - self.params.threshold_db;
        let ratio = clamp(self.params.ratio, 1.0, 40.0);
        let knee = self.params.knee_db.max(0.0);
        let slope = 1.0 - 1.0 / ratio;
        if over <= -knee * 0.5 {
            0.0
        } else if over < knee * 0.5 {
            let t = over + knee * 0.5;
            slope * t * t / (2.0 * knee.max(1e-6))
        } else {
            slope * over
        }
    }
}

// ---------------------------------------------------------------------------
// De-esser
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct DeEsserParams {
    pub frequency: f32,
    pub threshold_db: f32,
    /// 0..100 %. Scales both sensitivity and maximum reduction.
    pub amount: f32,
}

impl Default for DeEsserParams {
    fn default() -> Self {
        Self {
            frequency: 6500.0,
            threshold_db: -32.0,
            amount: 55.0,
        }
    }
}

/// Split-band de-esser: detects sibilance in the high band and only attenuates
/// that band, leaving the body of the voice untouched.
#[derive(Debug, Clone)]
pub struct DeEsser {
    sample_rate: f32,
    params: DeEsserParams,
    lowpass: Biquad,
    highpass: Biquad,
    detector: EnvelopeFollower,
    reduction_db: f32,
    attack_coeff: f32,
    release_coeff: f32,
}

impl DeEsser {
    pub fn new(sample_rate: f32, params: DeEsserParams) -> Self {
        let sr = sample_rate.max(1.0);
        let mut deesser = Self {
            sample_rate: sr,
            params,
            lowpass: Biquad::default(),
            highpass: Biquad::default(),
            detector: EnvelopeFollower::new(sr, 0.5, 35.0),
            reduction_db: 0.0,
            attack_coeff: time_coeff(0.5, sr),
            release_coeff: time_coeff(35.0, sr),
        };
        deesser.set_params(params);
        deesser
    }

    pub fn set_params(&mut self, params: DeEsserParams) {
        self.params = params;
        let freq = sanitize_freq(params.frequency, self.sample_rate);
        let q = std::f32::consts::FRAC_1_SQRT_2;
        self.lowpass.set_coeffs(BiquadCoeffs::design(
            FilterKind::LowPass,
            self.sample_rate,
            freq,
            0.0,
            q,
        ));
        self.highpass.set_coeffs(BiquadCoeffs::design(
            FilterKind::HighPass,
            self.sample_rate,
            freq,
            0.0,
            q,
        ));
    }

    pub fn params(&self) -> DeEsserParams {
        self.params
    }

    pub fn reduction_db(&self) -> f32 {
        self.reduction_db
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let low = self.lowpass.process(x);
        let high = self.highpass.process(x);
        let high_db = linear_to_db(self.detector.process(high.abs()));
        let over = (high_db - self.params.threshold_db).max(0.0);
        let amount = clamp(self.params.amount, 0.0, 100.0) / 100.0;
        let target = -(over * amount).min(24.0 * amount);
        let coeff = if target < self.reduction_db {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.reduction_db += coeff * (target - self.reduction_db);
        low + high * db_to_linear(self.reduction_db)
    }

    pub fn reset(&mut self) {
        self.lowpass.reset();
        self.highpass.reset();
        self.detector.reset();
        self.reduction_db = 0.0;
    }
}

// ---------------------------------------------------------------------------
// Saturator
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct SaturatorParams {
    /// 0..100 %.
    pub drive: f32,
    /// 0..100 % dry/wet.
    pub mix: f32,
    /// -100..100 %: negative = darker, positive = brighter.
    pub tone: f32,
}

impl Default for SaturatorParams {
    fn default() -> Self {
        Self {
            drive: 25.0,
            mix: 100.0,
            tone: 0.0,
        }
    }
}

/// Soft-clipper with a tilt tone control and full dry/wet blend.
#[derive(Debug, Clone)]
pub struct Saturator {
    params: SaturatorParams,
    tone_lowpass: Biquad,
    dc_block: Biquad,
}

impl Saturator {
    pub fn new(sample_rate: f32, params: SaturatorParams) -> Self {
        let sr = sample_rate.max(1.0);
        let mut sat = Self {
            params,
            tone_lowpass: Biquad::new(BiquadCoeffs::design(
                FilterKind::LowPass,
                sr,
                800.0,
                0.0,
                std::f32::consts::FRAC_1_SQRT_2,
            )),
            dc_block: Biquad::new(BiquadCoeffs::design(
                FilterKind::HighPass,
                sr,
                18.0,
                0.0,
                0.707,
            )),
        };
        sat.set_params(params);
        sat
    }

    pub fn set_params(&mut self, params: SaturatorParams) {
        self.params = params;
    }

    pub fn params(&self) -> SaturatorParams {
        self.params
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let drive = clamp(self.params.drive, 0.0, 100.0) / 100.0;
        let mix = clamp(self.params.mix, 0.0, 100.0) / 100.0;
        let tone = clamp(self.params.tone, -100.0, 100.0) / 100.0;

        let pre_gain = 1.0 + drive * 15.0;
        let driven = (x * pre_gain).tanh();
        // Compensate the level boost so the blend stays roughly unity.
        let compensated = driven * (1.0 / pre_gain.sqrt().max(0.25));

        let low = self.tone_lowpass.process(compensated);
        let high = compensated - low;
        let toned = low * (1.0 - tone * 0.5) + high * (1.0 + tone * 0.5);

        let wet = self.dc_block.process(toned);
        x * (1.0 - mix) + wet * mix
    }

    pub fn reset(&mut self) {
        self.tone_lowpass.reset();
        self.dc_block.reset();
    }
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct LimiterParams {
    pub ceiling_db: f32,
    pub release_ms: f32,
}

impl Default for LimiterParams {
    fn default() -> Self {
        Self {
            ceiling_db: -0.3,
            release_ms: 120.0,
        }
    }
}

/// Lookahead brickwall limiter. The signal is delayed by ~5 ms while the gain
/// is computed from the undelayed signal, so peaks are already attenuated when
/// they reach the output.
#[derive(Debug, Clone)]
pub struct Limiter {
    sample_rate: f32,
    params: LimiterParams,
    envelope: f32,
    release_coeff: f32,
    gain: f32,
    buffer: Vec<f32>,
    index: usize,
}

impl Limiter {
    pub fn new(sample_rate: f32, params: LimiterParams) -> Self {
        let sr = sample_rate.max(1.0);
        let delay = (sr * 0.005).round().max(1.0) as usize;
        let mut limiter = Self {
            sample_rate: sr,
            params,
            envelope: 0.0,
            release_coeff: 1.0,
            gain: 1.0,
            buffer: vec![0.0; delay],
            index: 0,
        };
        limiter.set_params(params);
        limiter
    }

    pub fn set_params(&mut self, params: LimiterParams) {
        self.params = params;
        self.release_coeff = time_coeff(params.release_ms, self.sample_rate);
    }

    pub fn params(&self) -> LimiterParams {
        self.params
    }

    /// Latency introduced by the lookahead, in samples.
    pub fn latency_samples(&self) -> usize {
        self.buffer.len()
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let rectified = x.abs();
        if rectified > self.envelope {
            self.envelope = rectified;
        } else {
            self.envelope += self.release_coeff * (rectified - self.envelope);
        }

        let ceiling = db_to_linear(self.params.ceiling_db);
        let desired = if self.envelope > ceiling && self.envelope > 0.0 {
            ceiling / self.envelope
        } else {
            1.0
        };
        if desired < self.gain {
            self.gain = desired;
        } else {
            self.gain += self.release_coeff * (desired - self.gain);
        }

        let delayed = self.buffer[self.index];
        self.buffer[self.index] = x;
        self.index = (self.index + 1) % self.buffer.len();
        delayed * self.gain
    }

    pub fn reset(&mut self) {
        self.envelope = 0.0;
        self.gain = 1.0;
        self.buffer.fill(0.0);
        self.index = 0;
    }
}

// ---------------------------------------------------------------------------
// Metering helpers
// ---------------------------------------------------------------------------

/// Peak meter with hold + exponential fall-off, used for UI telemetry.
#[derive(Debug, Clone, Copy)]
pub struct PeakMeter {
    peak: f32,
    hold: f32,
    hold_remaining: u32,
    decay: f32,
    hold_samples: u32,
}

impl PeakMeter {
    pub fn new(sample_rate: f32, decay_ms: f32, hold_ms: f32) -> Self {
        let sr = sample_rate.max(1.0);
        Self {
            peak: 0.0,
            hold: 0.0,
            hold_remaining: 0,
            decay: time_coeff(decay_ms.max(0.0), sr),
            hold_samples: (hold_ms.max(0.0) * 0.001 * sr) as u32,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let rectified = x.abs();
        if rectified > self.peak {
            self.peak = rectified;
        } else {
            self.peak += self.decay * (rectified - self.peak);
        }

        if rectified >= self.hold {
            self.hold = rectified;
            self.hold_remaining = self.hold_samples;
        } else if self.hold_remaining > 0 {
            self.hold_remaining -= 1;
        } else {
            self.hold += self.decay * (rectified - self.hold);
        }
        self.peak
    }

    pub fn peak_db(&self) -> f32 {
        linear_to_db(self.peak)
    }

    pub fn hold_db(&self) -> f32 {
        linear_to_db(self.hold)
    }

    pub fn reset(&mut self) {
        self.peak = 0.0;
        self.hold = 0.0;
        self.hold_remaining = 0;
    }
}

impl Default for PeakMeter {
    fn default() -> Self {
        Self::new(48_000.0, 300.0, 800.0)
    }
}

/// Constant-power pan law. Returns `(left, right)` gains for `pan ∈ [-1, 1]`.
#[inline]
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let angle = (clamp(pan, -1.0, 1.0) + 1.0) * 0.25 * PI;
    (angle.cos(), angle.sin())
}

/// Mid/side width control. `width` is 0..2 (0 = mono, 1 = unchanged).
#[inline]
pub fn apply_width(left: f32, right: f32, width: f32) -> (f32, f32) {
    let width = clamp(width, 0.0, 2.0);
    let mid = (left + right) * 0.5;
    let side = (left - right) * 0.5 * width;
    (mid + side, mid - side)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local realtime voice pitch shifter
// ---------------------------------------------------------------------------

/// Grain size for the two-tap pitch shifter. 1024 samples ≈ 21 ms at 48 kHz:
/// short enough for live monitoring, long enough to keep the artefacts behind
/// the voice instead of in front of it.
const VOICE_GRAIN: usize = 1024;
const VOICE_RING: usize = 4096;

/// Small, allocation-free granular pitch shifter used by the local voice
/// presets. It is intentionally a *character* effect, not a studio pitch
/// corrector: two overlapping grains are crossfaded while the read pointer
/// moves at a different speed from the write pointer.
pub struct PitchShifter {
    buffer: Vec<f32>,
    write: usize,
    phase: f32,
    ratio: f32,
}

impl PitchShifter {
    pub fn new(_sample_rate: f32) -> Self {
        Self {
            buffer: vec![0.0; VOICE_RING],
            write: 0,
            phase: 0.0,
            ratio: 1.0,
        }
    }

    pub fn set_ratio(&mut self, ratio: f32) {
        self.ratio = ratio.clamp(0.25, 4.0);
    }

    pub fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.write = 0;
        self.phase = 0.0;
    }

    #[inline]
    fn read_delay(&self, delay: f32) -> f32 {
        let pos = (self.write as f32 - delay).rem_euclid(VOICE_RING as f32);
        let i0 = pos.floor() as usize % VOICE_RING;
        let i1 = (i0 + 1) % VOICE_RING;
        let frac = pos - pos.floor();
        self.buffer[i0] * (1.0 - frac) + self.buffer[i1] * frac
    }

    #[inline]
    pub fn process(&mut self, input: f32) -> f32 {
        self.buffer[self.write] = input;

        if (self.ratio - 1.0).abs() < 1e-4 {
            self.write = (self.write + 1) % VOICE_RING;
            return input;
        }

        let phase = self.phase;
        let delay_a = phase * VOICE_GRAIN as f32;
        let delay_b = ((phase + 0.5).rem_euclid(1.0)) * VOICE_GRAIN as f32;
        let gain_a = (PI * phase).sin().powi(2);
        let gain_b = 1.0 - gain_a;
        let out = self.read_delay(delay_a) * gain_a + self.read_delay(delay_b) * gain_b;

        // A ratio > 1 must shorten the delay, otherwise the read head falls
        // behind the write head and the voice goes down instead of up.
        self.phase = (self.phase + (1.0 - self.ratio) / VOICE_GRAIN as f32).rem_euclid(1.0);
        self.write = (self.write + 1) % VOICE_RING;
        out
    }
}

// ---------------------------------------------------------------------------
// Sample format conversion
// ---------------------------------------------------------------------------
//
// Endpoints that do not expose F32 (typical for older WASAPI drivers in shared
// mode) are opened raw and converted here. Integer formats use the full-scale
// value as the scale factor, so `i16::MIN` maps to exactly -1.0 and `i16::MAX`
// to 32767/32768 instead of 1.0 — that keeps a convert-and-back roundtrip
// lossless. Values outside the range are clipped, never wrapped, and the
// integer casts are saturating, so a NaN from a broken plug-in lands on
// silence instead of a random full-scale sample. F64 passes NaN through: it is
// only a scale change, not a clamp.

/// Full-scale divisor for signed 16-bit audio.
pub const I16_FULL_SCALE: f32 = 32_768.0;
/// Full-scale divisor for signed 32-bit audio.
pub const I32_FULL_SCALE: f64 = 2_147_483_648.0;

#[inline]
pub fn i16_to_f32(value: i16) -> f32 {
    value as f32 / I16_FULL_SCALE
}

#[inline]
pub fn f32_to_i16(value: f32) -> i16 {
    (value * I16_FULL_SCALE).round().clamp(-32_768.0, 32_767.0) as i16
}

#[inline]
pub fn u16_to_f32(value: u16) -> f32 {
    (value as f32 - I16_FULL_SCALE) / I16_FULL_SCALE
}

#[inline]
pub fn f32_to_u16(value: f32) -> u16 {
    ((value * I16_FULL_SCALE).round().clamp(-32_768.0, 32_767.0) as i32 + 32_768) as u16
}

#[inline]
pub fn i32_to_f32(value: i32) -> f32 {
    (value as f64 / I32_FULL_SCALE) as f32
}

/// The f64 math keeps every `i32` distinguishable while scaling; the cast back
/// is saturating, so clipping and NaN are handled without a branch.
#[inline]
pub fn f32_to_i32(value: f32) -> i32 {
    (value as f64 * I32_FULL_SCALE)
        .round()
        .clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

#[inline]
pub fn f64_to_f32(value: f64) -> f32 {
    value.clamp(-1.0, 1.0) as f32
}

#[inline]
pub fn f32_to_f64(value: f32) -> f64 {
    value as f64
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/// Linear-interpolating stereo resampler for the realtime thread.
///
/// `step` counts input frames per output frame: below 1 an input frame yields
/// two outputs (upsampling), above 1 some input frames yield none
/// (downsampling). Because both cases interpolate, a step that drifts by a few
/// ppm moves the signal through a dropped or repeated frame instead of cutting
/// a hard sample.
#[derive(Debug, Clone)]
pub struct StereoResampler {
    nominal_step: f64,
    step: f64,
    position: f64,
    prev: (f32, f32),
    curr: (f32, f32),
    primed: bool,
}

impl StereoResampler {
    pub fn new(source_rate: u32, target_rate: u32) -> Self {
        let nominal = source_rate.max(1) as f64 / target_rate.max(1) as f64;
        Self {
            nominal_step: nominal,
            step: nominal,
            position: 0.0,
            prev: (0.0, 0.0),
            curr: (0.0, 0.0),
            primed: false,
        }
    }

    #[inline]
    pub fn nominal_step(&self) -> f64 {
        self.nominal_step
    }

    /// Current step, i.e. the nominal ratio with the drift trim applied.
    #[inline]
    pub fn step(&self) -> f64 {
        self.step
    }

    /// Sets the step in input frames per output frame. Values outside
    /// `0.001..=1000` are ignored, so a broken measurement cannot stall or
    /// explode the stream.
    #[inline]
    pub fn set_step(&mut self, step: f64) {
        if step.is_finite() && (0.001..=1000.0).contains(&step) {
            self.step = step;
        }
    }

    /// Feeds one input frame and calls `emit` for every output frame produced.
    #[inline]
    pub fn push_frame(&mut self, frame: (f32, f32), mut emit: impl FnMut(f32, f32)) {
        if self.primed {
            self.prev = self.curr;
            self.curr = frame;
        } else {
            // The first frame seeds both ends of the interpolation window, so
            // the first output is the frame itself instead of a ramp from
            // zero.
            self.prev = frame;
            self.curr = frame;
            self.primed = true;
        }

        while self.position < 1.0 {
            let t = self.position as f32;
            emit(
                self.prev.0 + (self.curr.0 - self.prev.0) * t,
                self.prev.1 + (self.curr.1 - self.prev.1) * t,
            );
            self.position += self.step;
        }
        // Only one input frame advances per push, so the position is re-based
        // by a single frame; with a step above 1 the remainder above 1.0 simply
        // means this input frame produced no output.
        self.position -= 1.0;
    }
}

/// Ring-occupancy controller for one resampled stream.
///
/// Two endpoints never share a clock, so a resampler running at the nominal
/// ratio slowly empties or overfills its ring and eventually XRUNs. This turns
/// the measured occupancy into a ±[`DriftControl::MAX_PPM`] ppm trim of the
/// resampler step, moving at most [`DriftControl::SLEW_PPM`] ppm per update, so
/// the correction itself stays inaudible. The caller updates it once per audio
/// callback, which is far slower than one ppm per audio frame.
///
/// `update` returns a factor above 1 when the ring is fuller than the target,
/// meaning "produce fewer output frames per input frame". Both resamplers in
/// this engine sit on the producer side of their ring, so both multiply the
/// nominal step by that factor.
///
/// The target is not a number picked on the control thread: the fill a ring
/// settles on depends on how the host schedules the two callbacks, and a target
/// above it would add latency, one below it would starve the stream. A
/// controller built with [`DriftControl::priming`] therefore measures the
/// occupancy for the first second and then holds exactly that level.
#[derive(Debug, Clone)]
pub struct DriftControl {
    target: Option<f32>,
    sum: f64,
    primed: usize,
    prime_frames: usize,
    ppm: f64,
}

impl DriftControl {
    /// Hard limit of the trim, the usual hardware mismatch is 10–100 ppm.
    pub const MAX_PPM: f64 = 300.0;
    /// Per-update slew limit, i.e. one ppm of step change per audio callback.
    pub const SLEW_PPM: f64 = 1.0;
    /// Occupancy error that asks for the full trim.
    pub const FULL_SCALE_ERROR: f32 = 0.1;
    /// A ring measured empty is held at this floor, so the stream recovers a
    /// little headroom for scheduling jitter instead of running on the edge.
    pub const MIN_TARGET: f32 = 0.01;

    /// Controller with a fixed target.
    pub fn new(target: f32) -> Self {
        Self {
            target: Some(target.clamp(0.0, 1.0)),
            sum: 0.0,
            primed: usize::MAX,
            prime_frames: usize::MAX,
            ppm: 0.0,
        }
    }

    /// Controller that holds the occupancy measured over the first
    /// `prime_frames` frames.
    pub fn priming(prime_frames: usize) -> Self {
        Self {
            target: None,
            sum: 0.0,
            primed: 0,
            prime_frames: prime_frames.max(1),
            ppm: 0.0,
        }
    }

    /// `None` until the priming window is over.
    pub fn target(&self) -> Option<f32> {
        self.target
    }

    pub fn is_primed(&self) -> bool {
        self.target.is_some()
    }

    pub fn set_target(&mut self, target: f32) {
        if target.is_finite() {
            self.target = Some(target.clamp(0.0, 1.0));
        }
    }

    /// Current trim in ppm.
    pub fn ppm(&self) -> f64 {
        self.ppm
    }

    /// `1 + ppm * 1e-6`, the multiplier described on the type.
    pub fn factor(&self) -> f64 {
        1.0 + self.ppm * 1e-6
    }

    /// Feeds one measurement covering `frames` audio frames and returns the new
    /// [`Self::factor`]. Returns 1.0 while the controller is still priming.
    pub fn update(&mut self, fill: f32, frames: usize) -> f64 {
        if !fill.is_finite() {
            return self.factor();
        }
        let Some(target) = self.target else {
            self.sum += fill as f64 * frames.max(1) as f64;
            self.primed += frames.max(1);
            if self.primed >= self.prime_frames {
                let average = (self.sum / self.primed as f64) as f32;
                // A ring that was already overfull when its consumer started
                // would otherwise lock in that latency; half the ring is the
                // most the controller is allowed to hold on to.
                self.target = Some(average.clamp(Self::MIN_TARGET, 0.5));
            }
            return 1.0;
        };
        let error = (fill - target).clamp(-1.0, 1.0);
        let desired = (error / Self::FULL_SCALE_ERROR) as f64 * Self::MAX_PPM;
        let desired = desired.clamp(-Self::MAX_PPM, Self::MAX_PPM);
        let delta = (desired - self.ppm).clamp(-Self::SLEW_PPM, Self::SLEW_PPM);
        self.ppm = (self.ppm + delta).clamp(-Self::MAX_PPM, Self::MAX_PPM);
        self.factor()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn run_sine(process: impl FnMut(f32) -> f32, freq: f32, samples: usize) -> f32 {
        let mut process = process;
        let mut peak = 0.0_f32;
        for i in 0..samples {
            let x = (2.0 * PI * freq * i as f32 / SR).sin() * 0.5;
            let y = process(x);
            // Ignore the first 2000 samples so filters can settle.
            if i > 2_000 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn db_roundtrip() {
        for db in [-60.0, -12.0, -6.0, 0.0, 6.0, 12.0] {
            let roundtrip = linear_to_db(db_to_linear(db));
            assert!((roundtrip - db).abs() < 1e-3, "{db} -> {roundtrip}");
        }
        assert_eq!(db_to_linear(SILENCE_DB), 0.0);
        assert_eq!(linear_to_db(0.0), SILENCE_DB);
    }

    #[test]
    fn lowpass_passes_dc_and_blocks_highs() {
        let coeffs = BiquadCoeffs::design(FilterKind::LowPass, SR, 1_000.0, 0.0, 0.707);
        let mut filter = Biquad::new(coeffs);
        let dc = (0..10_000).map(|_| filter.process(1.0)).last().unwrap();
        assert!((dc - 1.0).abs() < 1e-3, "dc = {dc}");

        let mut filter = Biquad::new(coeffs);
        let peak = run_sine(|x| filter.process(x), 10_000.0, 20_000);
        assert!(peak < 0.05, "10 kHz leaked through 1 kHz LP: {peak}");
    }

    #[test]
    fn highpass_blocks_dc() {
        let mut filter = Biquad::new(BiquadCoeffs::design(
            FilterKind::HighPass,
            SR,
            100.0,
            0.0,
            0.707,
        ));
        let dc = (0..10_000).map(|_| filter.process(1.0)).last().unwrap();
        assert!(dc.abs() < 1e-4, "dc = {dc}");
    }

    #[test]
    fn peaking_band_applies_gain_at_center() {
        let coeffs = BiquadCoeffs::design(FilterKind::Peaking, SR, 1_000.0, 12.0, 1.0);
        let mut filter = Biquad::new(coeffs);
        let input_peak = 0.5;
        let output_peak = run_sine(|x| filter.process(x), 1_000.0, 40_000);
        let gain_db = linear_to_db(output_peak / input_peak);
        assert!((gain_db - 12.0).abs() < 1.0, "gain = {gain_db} dB");
    }

    #[test]
    fn gate_closes_on_silence_and_opens_on_signal() {
        let params = GateParams {
            threshold_db: -40.0,
            hold_ms: 5.0,
            attack_ms: 1.0,
            release_ms: 20.0,
            range_db: -60.0,
            hysteresis_db: 3.0,
        };
        let mut gate = Gate::new(SR, params);

        for _ in 0..10_000 {
            gate.process(0.0);
        }
        assert_eq!(gate.state(), GateState::Closed);
        let silent_out = gate.process(0.0);
        assert!(silent_out.abs() < 1e-3);

        let mut peak = 0.0_f32;
        for i in 0..20_000 {
            let x = (2.0 * PI * 220.0 * i as f32 / SR).sin() * 0.5;
            peak = peak.max(gate.process(x).abs());
        }
        assert_eq!(gate.state(), GateState::Open);
        assert!(peak > 0.4, "gate did not open, peak = {peak}");
    }

    #[test]
    fn compressor_reduces_loud_signal() {
        let params = CompressorParams {
            threshold_db: -24.0,
            ratio: 8.0,
            attack_ms: 1.0,
            release_ms: 50.0,
            makeup_db: 0.0,
            knee_db: 0.0,
        };
        let mut comp = Compressor::new(SR, params);
        let input_peak = 0.8;
        let output_peak = run_sine(|x| comp.process(x), 440.0, 60_000);
        assert!(output_peak < input_peak * 0.5, "peak = {output_peak}");
        assert!(comp.gain_db() < -6.0, "reduction = {}", comp.gain_db());
    }

    #[test]
    fn compressor_static_curve_is_slope_limited() {
        let comp = Compressor::new(
            SR,
            CompressorParams {
                threshold_db: -20.0,
                ratio: 4.0,
                knee_db: 0.0,
                ..CompressorParams::default()
            },
        );
        // 12 dB over threshold at 4:1 → 9 dB of reduction.
        assert!((comp.static_reduction_db(-8.0) - 9.0).abs() < 1e-3);
    }

    #[test]
    fn limiter_respects_ceiling() {
        let mut limiter = Limiter::new(
            SR,
            LimiterParams {
                ceiling_db: -3.0,
                release_ms: 80.0,
            },
        );
        let ceiling = db_to_linear(-3.0);
        let mut peak = 0.0_f32;
        for i in 0..80_000 {
            let x = (2.0 * PI * 300.0 * i as f32 / SR).sin() * 1.5;
            let y = limiter.process(x);
            if i > limiter.latency_samples() {
                peak = peak.max(y.abs());
            }
        }
        assert!(peak <= ceiling + 0.02, "peak = {peak}, ceiling = {ceiling}");
    }

    #[test]
    fn saturator_stays_bounded() {
        let mut sat = Saturator::new(SR, SaturatorParams::default());
        let mut peak = 0.0_f32;
        for i in 0..10_000 {
            let x = if i % 2 == 0 { 2.0 } else { -2.0 };
            peak = peak.max(sat.process(x).abs());
        }
        assert!(peak < 2.0, "peak = {peak}");
    }

    #[test]
    fn deesser_leaves_low_tones_alone() {
        let mut deesser = DeEsser::new(SR, DeEsserParams::default());
        let input_peak = 0.5;
        let output_peak = run_sine(|x| deesser.process(x), 200.0, 40_000);
        assert!(
            (output_peak / input_peak - 1.0).abs() < 0.1,
            "ratio = {}",
            output_peak / input_peak
        );
    }

    #[test]
    fn pan_law_is_constant_power() {
        let (l, r) = pan_gains(0.0);
        assert!((l * l + r * r - 1.0).abs() < 1e-5);
        let (l, r) = pan_gains(-1.0);
        assert!(l > 0.99 && r < 0.01, "left = {l}, right = {r}");
        let (l, r) = pan_gains(1.0);
        assert!(r > 0.99 && l < 0.01, "left = {l}, right = {r}");
    }

    #[test]
    fn width_zero_collapses_to_mono() {
        let (l, r) = apply_width(0.4, -0.2, 0.0);
        assert!((l - r).abs() < 1e-6);
    }

    #[test]
    fn smoothed_reaches_target() {
        let mut smoother = Smoothed::new(0.0, SR, 5.0);
        smoother.set_target(1.0);
        for _ in 0..(SR as usize) {
            smoother.advance();
        }
        assert!((smoother.current() - 1.0).abs() < 1e-3);
    }
    #[test]
    fn i16_roundtrip_is_lossless() {
        for value in [i16::MIN, -32_767, -1, 0, 1, 16_383, 32_767] {
            let roundtrip = f32_to_i16(i16_to_f32(value));
            assert_eq!(roundtrip, value, "i16 {value} -> {roundtrip}");
        }
        assert_eq!(i16_to_f32(i16::MIN), -1.0);
        assert!((i16_to_f32(i16::MAX) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn i16_conversion_clips_instead_of_wrapping() {
        assert_eq!(f32_to_i16(2.0), 32_767);
        assert_eq!(f32_to_i16(-2.0), -32_768);
        assert_eq!(f32_to_i16(1.0), 32_767);
        assert_eq!(f32_to_i16(-1.0), -32_768);
        assert_eq!(f32_to_i16(f32::NAN), 0);
    }

    #[test]
    fn u16_conversion_centres_silence() {
        assert_eq!(u16_to_f32(32_768), 0.0);
        assert_eq!(u16_to_f32(0), -1.0);
        assert_eq!(f32_to_u16(0.0), 32_768);
        assert_eq!(f32_to_u16(-1.0), 0);
        assert_eq!(f32_to_u16(1.0), 65_535);
        assert_eq!(f32_to_u16(9.0), 65_535);
        assert_eq!(f32_to_u16(f32::NAN), 32_768);
        for value in [0u16, 32_768, 65_535, 1_234] {
            assert_eq!(f32_to_u16(u16_to_f32(value)), value, "u16 {value}");
        }
    }

    #[test]
    fn i32_conversion_roundtrips_within_f32_precision() {
        assert_eq!(i32_to_f32(i32::MIN), -1.0);
        for value in [i32::MIN, -1_000_000, -1, 0, 1, 1_000_000, i32::MAX] {
            let roundtrip = f32_to_i32(i32_to_f32(value));
            let tolerance = (value as f64).abs() * 1e-6 + 1.0;
            assert!(
                (roundtrip as f64 - value as f64).abs() <= tolerance,
                "i32 {value} -> {roundtrip}"
            );
        }
        assert_eq!(f32_to_i32(2.0), i32::MAX);
        assert_eq!(f32_to_i32(-2.0), i32::MIN);
        assert_eq!(f32_to_i32(f32::NAN), 0);
    }

    #[test]
    fn f64_conversion_clips_and_passes_through() {
        assert_eq!(f64_to_f32(0.25), 0.25);
        assert_eq!(f64_to_f32(-0.25), -0.25);
        assert_eq!(f64_to_f32(1.5), 1.0);
        assert_eq!(f64_to_f32(-3.0), -1.0);
        assert_eq!(f32_to_f64(-0.75), -0.75);
        assert!(f64_to_f32(f64::NAN).is_nan());
    }

    #[test]
    fn resampler_keeps_a_constant_signal_constant() {
        let mut resampler = StereoResampler::new(44_100, 48_000);
        let mut outputs = 0usize;
        for _ in 0..4_410 {
            resampler.push_frame((0.5, -0.25), |left, right| {
                assert!((left - 0.5).abs() < 1e-6, "left = {left}");
                assert!((right + 0.25).abs() < 1e-6, "right = {right}");
                outputs += 1;
            });
        }
        assert!(outputs >= 4_800 && outputs <= 4_802, "outputs = {outputs}");
    }

    #[test]
    fn resampler_matches_the_rate_ratio() {
        let mut resampler = StereoResampler::new(44_100, 48_000);
        let mut outputs = 0usize;
        let mut finite = true;
        for index in 0..44_100usize {
            let value = (2.0 * PI * 440.0 * index as f32 / 44_100.0).sin() * 0.6;
            resampler.push_frame((value, value), |left, right| {
                finite &= left.is_finite() && right.is_finite();
                outputs += 1;
            });
        }
        assert!(finite, "resampler produced a non-finite sample");
        let expected = 44_100.0 * 48_000.0 / 44_100.0;
        let error = (outputs as f32 - expected).abs();
        assert!(error <= 2.0, "outputs = {outputs}, expected {expected}");
    }

    #[test]
    fn resampler_downsamples_to_the_rate_ratio() {
        let mut resampler = StereoResampler::new(96_000, 48_000);
        let mut outputs = 0usize;
        for index in 0..96_000usize {
            let value = (2.0 * PI * 100.0 * index as f32 / 96_000.0).sin() * 0.5;
            resampler.push_frame((value, value), |_, _| outputs += 1);
        }
        assert!(
            outputs >= 47_998 && outputs <= 48_001,
            "outputs = {outputs}"
        );
    }

    #[test]
    fn resampler_preserves_a_slow_sine() {
        let mut resampler = StereoResampler::new(44_100, 48_000);
        let mut peak = 0.0_f32;
        for index in 0..44_100usize {
            let value = (2.0 * PI * 100.0 * index as f32 / 44_100.0).sin() * 0.5;
            resampler.push_frame((value, value), |left, _| {
                // Skip the priming frame, it is emitted before the first step.
                if index > 10 {
                    peak = peak.max(left.abs());
                }
            });
        }
        assert!((peak - 0.5).abs() < 0.02, "peak = {peak}");
    }

    #[test]
    fn drift_control_holds_the_target() {
        let mut drift = DriftControl::new(0.5);
        for _ in 0..100 {
            assert_eq!(drift.update(0.5, 480), 1.0);
        }
        assert_eq!(drift.ppm(), 0.0);
        assert_eq!(drift.update(f32::NAN, 480), 1.0);
    }

    #[test]
    fn drift_control_priming_locks_the_measured_fill() {
        let mut drift = DriftControl::priming(48_000);
        assert_eq!(drift.target(), None);
        // One second of 480-frame blocks at a 20 % fill must become the target
        // and the controller must not trim during the measurement itself.
        let mut factor = 1.0;
        for _ in 0..100 {
            factor = drift.update(0.2, 480);
            assert_eq!(factor, 1.0);
        }
        let target = drift.target().expect("primed");
        assert!((target - 0.2).abs() < 1e-6, "target = {target}");
        assert_eq!(drift.update(0.2, 480), 1.0);
        for _ in 0..50 {
            factor = drift.update(0.4, 480);
        }
        assert!(factor > 1.0, "fuller ring must trim, got {factor}");
    }

    #[test]
    fn drift_control_priming_keeps_a_floor() {
        let mut drift = DriftControl::priming(10);
        drift.update(0.0, 10);
        assert_eq!(drift.target(), Some(DriftControl::MIN_TARGET));
    }

    #[test]
    fn drift_control_slews_and_stays_bounded() {
        let mut drift = DriftControl::new(0.5);
        let first = drift.update(1.0, 480);
        // One update may move the step by at most one ppm.
        assert!((first - 1.0 - 1e-6).abs() < 1e-12, "first = {first}");
        for _ in 0..2_000 {
            let factor = drift.update(1.0, 480);
            assert!(factor > 1.0);
            assert!(factor <= 1.0 + DriftControl::MAX_PPM * 1e-6 + 1e-12);
        }
        assert!((drift.ppm() - DriftControl::MAX_PPM).abs() < 1e-9);
    }

    #[test]
    fn drift_control_trim_direction_follows_the_occupancy() {
        let mut drift = DriftControl::new(0.5);
        let mut high = 0.0;
        for _ in 0..50 {
            high = drift.update(0.9, 480);
        }
        assert!(
            high > 1.0,
            "full ring must ask for fewer outputs, got {high}"
        );

        let mut drift = DriftControl::new(0.5);
        let mut low = 0.0;
        for _ in 0..200 {
            low = drift.update(0.05, 480);
        }
        assert!(low < 1.0, "empty ring must ask for more outputs, got {low}");
    }

    #[test]
    fn resampler_step_survives_a_trim() {
        let mut resampler = StereoResampler::new(48_000, 48_000);
        let nominal = resampler.nominal_step();
        resampler.set_step(nominal * (1.0 + DriftControl::MAX_PPM * 1e-6));
        let mut outputs = 0usize;
        for index in 0..480_000usize {
            let value = (2.0 * PI * 200.0 * index as f32 / 48_000.0).sin() * 0.5;
            resampler.push_frame((value, value), |left, right| {
                assert!(left.is_finite() && right.is_finite());
                outputs += 1;
            });
        }
        // Ten seconds at the full +300 ppm trim: 480_000 / 1.0003 frames, not
        // a stalled or doubled stream.
        let expected = 480_000.0 / (1.0 + DriftControl::MAX_PPM * 1e-6);
        assert!(
            (outputs as f64 - expected).abs() <= 2.0,
            "outputs = {outputs}"
        );
        resampler.set_step(f64::NAN);
        assert!(resampler.step().is_finite());
    }

    #[test]
    fn drift_control_keeps_a_capture_ring_bounded() {
        // Models the capture path: the device runs 250 ppm fast of the master
        // clock, its callback resamples into a ring of `capacity` frames and
        // the graph drains exactly one block per block. Without the trim the
        // ring walks up by 12 frames per second and eventually overruns.
        let clock = 48_000u32;
        let source = 44_100u32;
        let block = 480usize;
        let capacity = 4_800.0_f64;
        let mut resampler = StereoResampler::new(source, clock);
        let mut drift = DriftControl::priming(clock as usize);
        let mut fill = 0.0_f64;
        let mut carry = 0.0_f64;
        let mut late_overruns = 0usize;
        let mut late_underruns = 0usize;
        let mut late_written = 0.0_f64;
        let mut late_read = 0.0_f64;
        // 60 seconds of audio, the last 30 of which must be clean.
        let blocks = clock as usize * 60 / block;
        for index in 0..blocks {
            let late = index > blocks / 2;
            let factor = drift.update((fill / capacity) as f32, block);
            resampler.set_step(resampler.nominal_step() * factor);

            carry += block as f64 * source as f64 / clock as f64 * (1.0 + 250e-6);
            let frames = carry.floor() as usize;
            carry -= frames as f64;
            for _ in 0..frames {
                resampler.push_frame((0.0, 0.0), |_, _| {
                    if fill + 1.0 <= capacity {
                        fill += 1.0;
                        if late {
                            late_written += 1.0;
                        }
                    } else if late {
                        late_overruns += 1;
                    }
                });
            }

            let drained = fill.min(block as f64);
            if drained < block as f64 && late {
                late_underruns += 1;
            }
            fill -= drained;
            if late {
                late_read += drained;
            }
        }

        assert!(fill >= 0.0 && fill <= capacity, "fill = {fill}");
        assert_eq!(late_overruns, 0, "capture ring overflowed after settling");
        assert_eq!(late_underruns, 0, "capture ring starved after settling");
        // The trim must remove the clock difference: once it has settled, the
        // ring writes and reads the same number of frames.
        let drift_frames = (late_written - late_read).abs();
        assert!(
            drift_frames < block as f64 * 2.0,
            "late drift = {drift_frames} frames"
        );
        // The proportional term holds a persistent fill offset, so it settles
        // inside the trim range instead of reaching the exact mismatch.
        assert!(drift.ppm() > 150.0, "ppm = {}", drift.ppm());
        assert!(drift.ppm() <= DriftControl::MAX_PPM);
    }

    #[test]
    fn pitch_shifter_moves_a_sine_up() {
        let mut shifter = PitchShifter::new(SR);
        shifter.set_ratio(2.0);
        let total = 48_000usize;
        let mut crossings = 0usize;
        let mut previous = 0.0f32;
        for i in 0..total {
            let input = (2.0 * PI * 200.0 * i as f32 / SR).sin() * 0.4;
            let output = shifter.process(input);
            if i > 12_000 && previous <= 0.0 && output > 0.0 {
                crossings += 1;
            }
            previous = output;
        }
        let measured = crossings as f32 / ((total - 12_000) as f32 / SR);
        assert!((measured - 400.0).abs() < 30.0, "measured = {measured} Hz");
    }
}
