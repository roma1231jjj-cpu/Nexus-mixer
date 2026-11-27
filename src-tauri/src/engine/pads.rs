//! Sound pad voices rendered inside the mixer graph.
//!
//! The UI decodes a sample with Web Audio and uploads interleaved stereo PCM.
//! The control thread keeps the bank (PCM + last parameters + level atomics),
//! the audio thread receives only `Arc`-owned PCM slices through a channel and
//! mixes them into the strip, bus or master sum **before** that stage's DSP —
//! so a pad really passes through EQ, compressor, VCA, routing and master
//! processing instead of a private Web Audio gain node.
//!
//! No allocation, no locking and no channel re-sizing happens per frame; the
//! renderer only advances preallocated voices.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

use crossbeam_channel::{unbounded, Receiver, Sender, TryRecvError};
use parking_lot::{Mutex, RwLock};

use super::graph::{BUSES, BUS_IDS, STRIPS, STRIP_IDS};

/// Simultaneously sounding pads.
pub const MAX_VOICES: usize = 32;
/// 10 minutes at 96 kHz stereo.
pub const MAX_FRAMES: usize = 96_000 * 60 * 10;
/// Whole bank budget, protects the UI from uploading a 3 GB pack.
pub const MAX_BANK_BYTES: usize = 512 * 1024 * 1024;

/// Where a pad is summed into the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadTarget {
    Master,
    Strip(usize),
    Bus(usize),
}

impl Default for PadTarget {
    fn default() -> Self {
        Self::Master
    }
}

/// `"master"`, a strip id (`hw1`, `vaio`, …) or a bus id (`A1`, `B7`, …).
pub fn parse_target(name: &str) -> Option<PadTarget> {
    let value = name.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("master") {
        return Some(PadTarget::Master);
    }
    if let Some(index) = STRIP_IDS
        .iter()
        .position(|id| id.eq_ignore_ascii_case(value))
    {
        return Some(PadTarget::Strip(index));
    }
    if let Some(index) = BUS_IDS.iter().position(|id| id.eq_ignore_ascii_case(value)) {
        return Some(PadTarget::Bus(index));
    }
    None
}

#[derive(Debug, Clone, Copy)]
pub struct PadParams {
    pub volume: f32,
    pub pan: f32,
    pub loop_play: bool,
    pub pitch: f32,
    pub target: PadTarget,
    pub delay_frames: u32,
}

impl Default for PadParams {
    fn default() -> Self {
        Self {
            volume: 1.0,
            pan: 0.0,
            loop_play: false,
            pitch: 0.0,
            target: PadTarget::Master,
            delay_frames: 0,
        }
    }
}

impl PadParams {
    fn sanitized(mut self) -> Self {
        self.volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 4.0)
        } else {
            1.0
        };
        self.pan = if self.pan.is_finite() {
            self.pan.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        self.pitch = if self.pitch.is_finite() {
            self.pitch.clamp(-24.0, 24.0)
        } else {
            0.0
        };
        self.delay_frames = self.delay_frames.min(96_000 * 5);
        self
    }
}

/// Stable key for a pad id; the audio thread never allocates strings.
pub fn pad_key(id: &str) -> u64 {
    // FNV-1a: deterministic across runs, no dependency, collisions are
    // practically impossible for a few thousand user pad ids.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub enum PadCommand {
    Play {
        key: u64,
        pcm: Arc<[f32]>,
        sample_rate: f32,
        params: PadParams,
        level: Arc<AtomicU32>,
        playing: Arc<AtomicBool>,
    },
    Update {
        key: u64,
        params: PadParams,
    },
    Stop {
        key: u64,
    },
    StopAll,
}

struct Voice {
    key: u64,
    pcm: Arc<[f32]>,
    frames: usize,
    source_rate: f32,
    position: f64,
    step: f64,
    params: PadParams,
    delay: u32,
    level: Arc<AtomicU32>,
    playing: Arc<AtomicBool>,
    peak: f32,
    active: bool,
    started_at: u64,
}

impl Voice {
    fn new(
        key: u64,
        pcm: Arc<[f32]>,
        sample_rate: f32,
        out_rate: f32,
        params: PadParams,
        level: Arc<AtomicU32>,
        playing: Arc<AtomicBool>,
        serial: u64,
    ) -> Self {
        let frames = pcm.len() / 2;
        let rate = if sample_rate > 0.0 {
            sample_rate
        } else {
            out_rate
        };
        let step = if out_rate > 0.0 {
            (rate as f64 / out_rate as f64) * 2f64.powf(params.pitch as f64 / 12.0)
        } else {
            1.0
        };
        Self {
            key,
            pcm,
            frames,
            source_rate: rate,
            position: 0.0,
            step,
            params,
            delay: params.delay_frames,
            level,
            playing,
            peak: 0.0,
            active: frames > 1,
            started_at: serial,
        }
    }

    fn apply(&mut self, params: PadParams, out_rate: f32) {
        let pitch_changed = (params.pitch - self.params.pitch).abs() > f32::EPSILON;
        self.params = params;
        if pitch_changed && out_rate > 0.0 {
            // Recompute from the *source* rate: a 24 kHz pad played at 48 kHz
            // must keep its 2x step when only the pitch changes.
            self.step =
                (self.source_rate as f64 / out_rate as f64) * 2f64.powf(params.pitch as f64 / 12.0);
        }
    }

    /// Advance one output frame and add it to `left`/`right`.
    #[inline]
    fn render(&mut self, left: &mut f32, right: &mut f32) {
        if !self.active {
            return;
        }
        if self.delay > 0 {
            self.delay -= 1;
            return;
        }
        if self.frames < 2 {
            self.active = false;
            return;
        }
        let mut index = self.position as usize;
        if index + 1 >= self.frames {
            if self.params.loop_play {
                // Wrap in one step instead of looping frame by frame on very
                // short samples.
                let span = (self.frames - 1) as f64;
                while self.position >= span {
                    self.position -= span;
                }
                index = self.position as usize;
            } else {
                self.active = false;
                return;
            }
        }
        let frac = (self.position - index as f64) as f32;
        let base = index * 2;
        let sample_l = self.pcm[base] + (self.pcm[base + 2] - self.pcm[base]) * frac;
        let sample_r = self.pcm[base + 1] + (self.pcm[base + 3] - self.pcm[base + 1]) * frac;

        let angle = (self.params.pan + 1.0) * std::f32::consts::FRAC_PI_4;
        let gain_l = self.params.volume * angle.cos();
        let gain_r = self.params.volume * angle.sin();

        let out_l = sample_l * gain_l;
        let out_r = sample_r * gain_r;
        *left += out_l;
        *right += out_r;

        let peak = out_l.abs().max(out_r.abs());
        if peak > self.peak {
            self.peak = peak;
        }

        self.position += self.step;
        if !self.params.loop_play && self.position >= (self.frames - 1) as f64 {
            self.active = false;
        }
    }
}

/// Audio-thread side. Owned by the master renderer.
pub struct PadRenderer {
    voices: Vec<Voice>,
    rx: Receiver<PadCommand>,
    out_rate: f32,
    serial: u64,
}

impl PadRenderer {
    pub fn new(rx: Receiver<PadCommand>, sample_rate: f32) -> Self {
        Self {
            voices: Vec::with_capacity(MAX_VOICES),
            rx,
            out_rate: sample_rate.max(1.0),
            serial: 0,
        }
    }

    fn handle(&mut self, command: PadCommand) {
        match command {
            PadCommand::Play {
                key,
                pcm,
                sample_rate,
                params,
                level,
                playing,
            } => {
                let params = params.sanitized();
                // Retrigger: a second hit restarts the same pad instead of
                // toggling it off, which is what drum pads and the sequencer
                // expect.
                if let Some(existing) = self.voices.iter_mut().find(|voice| voice.key == key) {
                    self.serial += 1;
                    *existing = Voice::new(
                        key,
                        pcm,
                        sample_rate,
                        self.out_rate,
                        params,
                        level,
                        playing,
                        self.serial,
                    );
                    return;
                }
                if self.voices.len() >= MAX_VOICES {
                    // Steal the oldest voice so a new pad is never silently
                    // dropped.
                    if let Some((index, _)) = self
                        .voices
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, voice)| voice.started_at)
                    {
                        self.voices.swap_remove(index);
                    }
                }
                self.serial += 1;
                self.voices.push(Voice::new(
                    key,
                    pcm,
                    sample_rate,
                    self.out_rate,
                    params,
                    level,
                    playing,
                    self.serial,
                ));
            }
            PadCommand::Update { key, params } => {
                let params = params.sanitized();
                let rate = self.out_rate;
                for voice in self.voices.iter_mut().filter(|voice| voice.key == key) {
                    voice.apply(params, rate);
                }
            }
            PadCommand::Stop { key } => {
                for voice in self.voices.iter_mut().filter(|voice| voice.key == key) {
                    voice.active = false;
                }
            }
            PadCommand::StopAll => {
                for voice in self.voices.iter_mut() {
                    voice.active = false;
                }
            }
        }
    }

    /// Drain pending commands once per block. Only runs at block boundaries so
    /// a command is never applied in the middle of a frame.
    pub fn drain(&mut self) {
        loop {
            match self.rx.try_recv() {
                Ok(command) => self.handle(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
    }

    /// Mix one frame into the per-target buffers.
    #[inline]
    pub fn render_frame(
        &mut self,
        strip_extra: &mut [(f32, f32); STRIPS],
        bus_extra: &mut [(f32, f32); BUSES],
        master_extra: &mut (f32, f32),
    ) {
        for voice in self.voices.iter_mut() {
            if !voice.active {
                continue;
            }
            let (mut left, mut right) = (0.0_f32, 0.0_f32);
            voice.render(&mut left, &mut right);
            if left == 0.0 && right == 0.0 {
                continue;
            }
            match voice.params.target {
                PadTarget::Master => {
                    master_extra.0 += left;
                    master_extra.1 += right;
                }
                PadTarget::Strip(index) => {
                    if let Some(slot) = strip_extra.get_mut(index) {
                        slot.0 += left;
                        slot.1 += right;
                    }
                }
                PadTarget::Bus(index) => {
                    if let Some(slot) = bus_extra.get_mut(index) {
                        slot.0 += left;
                        slot.1 += right;
                    }
                }
            }
        }
    }

    /// Publish peaks and drop finished voices. Allocation-free.
    pub fn finish_block(&mut self) {
        for voice in self.voices.iter_mut() {
            let peak = if voice.active { voice.peak } else { 0.0 };
            voice.peak = 0.0;
            voice.level.store(peak.to_bits(), Ordering::Relaxed);
            // Authoritative playback state for the UI. Peak levels stay at
            // zero for silent loops, so they cannot answer "is it playing?".
            voice.playing.store(voice.active, Ordering::Relaxed);
        }
        self.voices.retain(|voice| voice.active);
    }

    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate > 0.0 {
            self.out_rate = sample_rate;
        }
    }

    pub fn active_count(&self) -> usize {
        self.voices.iter().filter(|voice| voice.active).count()
    }
}

struct PadEntry {
    pcm: Arc<[f32]>,
    sample_rate: f32,
    params: PadParams,
    level: Arc<AtomicU32>,
    playing: Arc<AtomicBool>,
    bytes: usize,
}

/// Control-thread side: bank of decoded samples plus the channel into the
/// audio callback.
pub struct PadBank {
    entries: RwLock<HashMap<String, PadEntry>>,
    sender: Mutex<Option<Sender<PadCommand>>>,
    bytes: AtomicUsize,
}

impl Default for PadBank {
    fn default() -> Self {
        Self::new()
    }
}

impl PadBank {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            sender: Mutex::new(None),
            bytes: AtomicUsize::new(0),
        }
    }

    /// Called by the engine when it starts. The returned receiver goes to the
    /// audio thread; the sender stays here.
    pub fn attach(&self) -> Receiver<PadCommand> {
        let (tx, rx) = unbounded();
        *self.sender.lock() = Some(tx);
        rx
    }

    /// Called when the engine stops. Levels fade to zero so the UI does not
    /// leave frozen meters behind.
    pub fn detach(&self) {
        *self.sender.lock() = None;
        for entry in self.entries.read().values() {
            entry.level.store(0.0_f32.to_bits(), Ordering::Relaxed);
            entry.playing.store(false, Ordering::Relaxed);
        }
    }

    pub fn is_attached(&self) -> bool {
        self.sender.lock().is_some()
    }

    fn send(&self, command: PadCommand) -> Result<(), String> {
        let guard = self.sender.lock();
        let sender = guard
            .as_ref()
            .ok_or_else(|| "engine not running".to_string())?;
        sender
            .send(command)
            .map_err(|_| "engine not running".to_string())
    }

    /// Upload decoded PCM. Mono input is duplicated to stereo interleaved.
    pub fn load(
        &self,
        id: String,
        sample_rate: u32,
        channels: u16,
        data: Vec<f32>,
    ) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("пустой идентификатор сэмпла".into());
        }
        if data.is_empty() {
            return Err("сэмпл пустой".into());
        }
        if channels != 1 && channels != 2 {
            return Err(format!("поддерживается 1 или 2 канала, пришло {channels}"));
        }
        let pcm: Vec<f32> = if channels == 1 {
            let mut stereo = Vec::with_capacity(data.len() * 2);
            for sample in data {
                stereo.push(sample);
                stereo.push(sample);
            }
            stereo
        } else {
            data
        };
        if pcm.len() % 2 != 0 {
            return Err("нечётное число отсчётов в стерео-потоке".into());
        }
        let frames = pcm.len() / 2;
        if frames > MAX_FRAMES {
            return Err(format!(
                "сэмпл длиннее {} минут — уменьшите файл",
                MAX_FRAMES / 96_000 / 60
            ));
        }
        let bytes = pcm.len() * std::mem::size_of::<f32>();
        let previous = self
            .entries
            .read()
            .get(&id)
            .map(|entry| entry.bytes)
            .unwrap_or(0);
        let projected = self
            .bytes
            .load(Ordering::Relaxed)
            .saturating_sub(previous)
            .saturating_add(bytes);
        if projected > MAX_BANK_BYTES {
            return Err("банк сэмплов переполнен (512 МБ)".into());
        }

        let entry = PadEntry {
            pcm: Arc::from(pcm.into_boxed_slice()),
            sample_rate: if sample_rate == 0 {
                48_000.0
            } else {
                sample_rate as f32
            },
            params: PadParams::default(),
            level: Arc::new(AtomicU32::new(0.0_f32.to_bits())),
            playing: Arc::new(AtomicBool::new(false)),
            bytes,
        };
        self.bytes.store(projected, Ordering::Relaxed);
        self.entries.write().insert(id, entry);
        Ok(())
    }

    pub fn unload(&self, id: &str) -> Result<(), String> {
        let removed = self.entries.write().remove(id);
        if let Some(entry) = removed {
            self.bytes.fetch_sub(entry.bytes, Ordering::Relaxed);
            let _ = self.send(PadCommand::Stop { key: pad_key(id) });
        }
        Ok(())
    }

    pub fn play(&self, id: &str, params: PadParams) -> Result<(), String> {
        let guard = self.entries.read();
        let entry = guard
            .get(id)
            .ok_or_else(|| "сэмпл не загружен в движок".to_string())?;
        let command = PadCommand::Play {
            key: pad_key(id),
            pcm: Arc::clone(&entry.pcm),
            sample_rate: entry.sample_rate,
            params: params.sanitized(),
            level: Arc::clone(&entry.level),
            playing: Arc::clone(&entry.playing),
        };
        drop(guard);
        self.send(command)?;
        if let Some(entry) = self.entries.write().get_mut(id) {
            entry.params = params.sanitized();
        }
        Ok(())
    }

    pub fn update(&self, id: &str, params: PadParams) -> Result<(), String> {
        if let Some(entry) = self.entries.write().get_mut(id) {
            entry.params = params.sanitized();
        }
        // Updating an idle pad only stores the defaults; that is not an error.
        if self.is_attached() {
            self.send(PadCommand::Update {
                key: pad_key(id),
                params: params.sanitized(),
            })?;
        }
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        if self.is_attached() {
            self.send(PadCommand::Stop { key: pad_key(id) })?;
        }
        Ok(())
    }

    pub fn stop_all(&self) -> Result<(), String> {
        if self.is_attached() {
            self.send(PadCommand::StopAll)?;
        }
        Ok(())
    }

    pub fn levels(&self) -> BTreeMap<String, f32> {
        let guard = self.entries.read();
        guard
            .iter()
            .filter_map(|(id, entry)| {
                let peak = f32::from_bits(entry.level.load(Ordering::Relaxed));
                if peak > 0.0 {
                    Some((id.clone(), peak))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Pads whose voice is currently sounding, including silent loop tails.
    pub fn active(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .entries
            .read()
            .iter()
            .filter(|(_, entry)| entry.playing.load(Ordering::Relaxed))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    pub fn loaded(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.entries.read().keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn defaults(&self, id: &str) -> Option<PadParams> {
        self.entries.read().get(id).map(|entry| entry.params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo(samples: &[(f32, f32)]) -> Vec<f32> {
        samples.iter().flat_map(|(l, r)| [*l, *r]).collect()
    }

    fn render_block(renderer: &mut PadRenderer, frames: usize) {
        let mut strips = [(0.0_f32, 0.0_f32); STRIPS];
        let mut buses = [(0.0_f32, 0.0_f32); BUSES];
        let mut master = (0.0_f32, 0.0_f32);
        for _ in 0..frames {
            renderer.render_frame(&mut strips, &mut buses, &mut master);
        }
        renderer.finish_block();
    }

    #[test]
    fn parse_target_maps_ids() {
        assert_eq!(parse_target(""), Some(PadTarget::Master));
        assert_eq!(parse_target("master"), Some(PadTarget::Master));
        assert_eq!(parse_target("hw1"), Some(PadTarget::Strip(0)));
        assert_eq!(parse_target("vaio"), Some(PadTarget::Strip(3)));
        assert_eq!(parse_target("A2"), Some(PadTarget::Bus(1)));
        assert_eq!(parse_target("b7"), Some(PadTarget::Bus(9)));
        assert_eq!(parse_target("nope"), None);
    }

    #[test]
    fn pad_targets_mix_into_the_right_sum() {
        for (target, strip_index, bus_index) in [
            (PadTarget::Master, None, None),
            (PadTarget::Strip(2), Some(2), None),
            (PadTarget::Bus(3), None, Some(3)),
        ] {
            let bank = PadBank::new();
            let rx = bank.attach();
            bank.load("pad".into(), 48_000, 2, stereo(&[(0.5, 0.25), (0.5, 0.25)]))
                .unwrap();
            let mut renderer = PadRenderer::new(rx, 48_000.0);
            bank.play(
                "pad",
                PadParams {
                    target,
                    ..Default::default()
                },
            )
            .unwrap();
            renderer.drain();
            let mut strips = [(0.0_f32, 0.0_f32); STRIPS];
            let mut buses = [(0.0_f32, 0.0_f32); BUSES];
            let mut master = (0.0_f32, 0.0_f32);
            renderer.render_frame(&mut strips, &mut buses, &mut master);

            if let Some(index) = strip_index {
                assert!(strips[index].0 > 0.0, "{target:?} не попал в канал");
                assert_eq!(master, (0.0, 0.0));
            } else if let Some(index) = bus_index {
                assert!(buses[index].0 > 0.0, "{target:?} не попал в шину");
                assert_eq!(master, (0.0, 0.0));
            } else {
                assert!(master.0 > 0.0, "мастер пуст");
            }
        }
    }

    #[test]
    fn retrigger_restarts_instead_of_toggling() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load(
            "pad".into(),
            48_000,
            2,
            stereo(&[(1.0, 1.0), (0.0, 0.0), (0.0, 0.0)]),
        )
        .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play("pad", PadParams::default()).unwrap();
        renderer.drain();
        render_block(&mut renderer, 2);
        bank.play("pad", PadParams::default()).unwrap();
        renderer.drain();
        assert_eq!(renderer.active_count(), 1);
        let mut strips = [(0.0_f32, 0.0_f32); STRIPS];
        let mut buses = [(0.0_f32, 0.0_f32); BUSES];
        let mut master = (0.0_f32, 0.0_f32);
        renderer.render_frame(&mut strips, &mut buses, &mut master);
        assert!(
            master.0 > 0.0,
            "повторное нажатие не запустило сэмпл заново"
        );
    }

    #[test]
    fn one_shot_stops_at_the_end_and_publishes_level() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load("pad".into(), 48_000, 2, stereo(&[(0.8, 0.8), (0.4, 0.4)]))
            .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play("pad", PadParams::default()).unwrap();
        renderer.drain();
        render_block(&mut renderer, 8);
        assert_eq!(renderer.active_count(), 0);
        assert_eq!(bank.levels().get("pad").copied(), None);
    }

    #[test]
    fn loop_keeps_playing() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load("pad".into(), 48_000, 2, stereo(&[(0.5, 0.5); 4]))
            .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play(
            "pad",
            PadParams {
                loop_play: true,
                ..Default::default()
            },
        )
        .unwrap();
        renderer.drain();
        render_block(&mut renderer, 64);
        assert_eq!(renderer.active_count(), 1);
    }

    #[test]
    fn pitch_and_rate_change_the_step() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load("pad".into(), 24_000, 2, stereo(&[(0.5, 0.5); 64]))
            .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play(
            "pad",
            PadParams {
                pitch: 12.0,
                ..Default::default()
            },
        )
        .unwrap();
        renderer.drain();
        let mut strips = [(0.0_f32, 0.0_f32); STRIPS];
        let mut buses = [(0.0_f32, 0.0_f32); BUSES];
        let mut master = (0.0_f32, 0.0_f32);
        renderer.render_frame(&mut strips, &mut buses, &mut master);
        // 24 kHz source at 48 kHz output with +12 st advances one source frame
        // per output frame.
        assert!(master.0 > 0.0);
    }

    #[test]
    fn delay_frames_are_respected() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load("pad".into(), 48_000, 2, stereo(&[(1.0, 1.0); 8]))
            .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play(
            "pad",
            PadParams {
                delay_frames: 4,
                ..Default::default()
            },
        )
        .unwrap();
        renderer.drain();
        let mut strips = [(0.0_f32, 0.0_f32); STRIPS];
        let mut buses = [(0.0_f32, 0.0_f32); BUSES];
        let mut master = (0.0_f32, 0.0_f32);
        for _ in 0..4 {
            renderer.render_frame(&mut strips, &mut buses, &mut master);
        }
        assert_eq!(master, (0.0, 0.0), "сэмпл зазвучал раньше задержки");
        renderer.render_frame(&mut strips, &mut buses, &mut master);
        assert!(master.0 > 0.0);
    }

    #[test]
    fn update_applies_to_a_playing_voice() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load("pad".into(), 48_000, 2, stereo(&[(1.0, 1.0); 64]))
            .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play(
            "pad",
            PadParams {
                loop_play: true,
                ..Default::default()
            },
        )
        .unwrap();
        renderer.drain();
        render_block(&mut renderer, 2);
        bank.update(
            "pad",
            PadParams {
                loop_play: true,
                volume: 0.0,
                ..Default::default()
            },
        )
        .unwrap();
        renderer.drain();
        let mut strips = [(0.0_f32, 0.0_f32); STRIPS];
        let mut buses = [(0.0_f32, 0.0_f32); BUSES];
        let mut master = (0.0_f32, 0.0_f32);
        renderer.render_frame(&mut strips, &mut buses, &mut master);
        assert_eq!(
            master,
            (0.0, 0.0),
            "громкость не применилась к играющему голосу"
        );
    }

    #[test]
    fn bank_rejects_empty_and_oversized_samples() {
        let bank = PadBank::new();
        assert!(bank.load("".into(), 48_000, 2, vec![0.0, 0.0]).is_err());
        assert!(bank.load("x".into(), 48_000, 2, vec![]).is_err());
        assert!(bank.load("x".into(), 48_000, 3, vec![0.0; 6]).is_err());
        assert!(bank.load("x".into(), 48_000, 2, vec![0.0; 7]).is_err());
        assert!(bank
            .load("x".into(), 48_000, 2, vec![0.0; (MAX_FRAMES + 1) * 2])
            .is_err());
    }

    #[test]
    fn play_requires_attached_engine() {
        let bank = PadBank::new();
        bank.load("pad".into(), 48_000, 2, vec![0.0, 0.0, 0.0, 0.0])
            .unwrap();
        let error = bank.play("pad", PadParams::default()).unwrap_err();
        assert_eq!(error, "engine not running");
        let rx = bank.attach();
        drop(rx);
        assert!(bank.play("pad", PadParams::default()).is_err());
    }

    #[test]
    fn detach_zeroes_levels() {
        let bank = PadBank::new();
        let rx = bank.attach();
        bank.load("pad".into(), 48_000, 2, stereo(&[(1.0, 1.0); 32]))
            .unwrap();
        let mut renderer = PadRenderer::new(rx, 48_000.0);
        bank.play("pad", PadParams::default()).unwrap();
        renderer.drain();
        render_block(&mut renderer, 2);
        assert!(bank.levels().contains_key("pad"));
        bank.detach();
        assert!(bank.levels().is_empty());
    }
}
