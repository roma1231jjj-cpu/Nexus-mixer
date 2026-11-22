//! Post-fader WAV recorder.
//!
//! The audio callback pushes the five processed stereo buses into a lock-free
//! ring; a dedicated writer thread drains it, selects the buses requested by
//! the UI and writes a standard PCM/float WAV file. No allocation, file I/O or
//! locking happens on the realtime thread.
//!
//! v0.1 deliberately supports WAV only. FLAC/MP3 are accepted by the UI but
//! are written as WAV with an explanatory status message until encoders land.

use std::cell::UnsafeCell;
use std::fs::{create_dir_all, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::graph::{BUS_IDS, BUSES};

/// Interleaved stereo samples per captured frame: all five buses.
pub const TAP_CHANNELS: usize = BUSES * 2;

// ---------------------------------------------------------------------------
// UI wire format
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecorderParams {
    pub enabled: bool,
    pub directory: String,
    pub format: String,
    pub bit_depth: u16,
    pub buses: Vec<String>,
    pub split_minutes: u32,
}

impl Default for RecorderParams {
    fn default() -> Self {
        Self {
            enabled: false,
            directory: String::new(),
            format: "wav".into(),
            bit_depth: 24,
            buses: vec!["A1".into()],
            split_minutes: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub recording: bool,
    pub file: Option<String>,
    pub seconds: f64,
    pub dropped_frames: u64,
    pub error: Option<String>,
}

impl Default for RecorderStatus {
    fn default() -> Self {
        Self {
            recording: false,
            file: None,
            seconds: 0.0,
            dropped_frames: 0,
            error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Lock-free tap: producer = master callback, consumer = writer thread
// ---------------------------------------------------------------------------

pub struct RecorderRing {
    buffer: Box<[UnsafeCell<f32>]>,
    mask: usize,
    head: AtomicU64,
    tail: AtomicU64,
    dropped: AtomicU64,
}

// Same invariant as `engine::buffer::SpscRing`: the producer owns
// `[tail, tail+n)` and the consumer owns `[head, head+n)`.
unsafe impl Sync for RecorderRing {}
unsafe impl Send for RecorderRing {}

impl RecorderRing {
    fn new(capacity_frames: usize) -> Self {
        let requested = capacity_frames.max(1).next_power_of_two();
        let samples: Vec<UnsafeCell<f32>> = (0..requested * TAP_CHANNELS)
            .map(|_| UnsafeCell::new(0.0))
            .collect();
        Self {
            buffer: samples.into_boxed_slice(),
            mask: requested - 1,
            head: AtomicU64::new(0),
            tail: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    /// Producer side. Returns `false` when the writer is too slow and the
    /// frame was dropped.
    #[inline]
    pub fn push_frame(&self, frame: &[f32; TAP_CHANNELS]) -> bool {
        let head = self.head.load(Ordering::Acquire);
        let tail = self.tail.load(Ordering::Relaxed);
        if tail.wrapping_sub(head) >= (self.mask + 1) as u64 {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let base = (tail as usize & self.mask) * TAP_CHANNELS;
        for (offset, sample) in frame.iter().enumerate() {
            // SAFETY: this frame is inside the producer's exclusive range.
            unsafe {
                *self.buffer[base + offset].get() = *sample;
            }
        }
        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        true
    }

    fn pop_frame(&self, frame: &mut [f32; TAP_CHANNELS]) -> bool {
        let tail = self.tail.load(Ordering::Acquire);
        let head = self.head.load(Ordering::Relaxed);
        if tail.wrapping_sub(head) == 0 {
            return false;
        }
        let base = (head as usize & self.mask) * TAP_CHANNELS;
        for (offset, slot) in frame.iter_mut().enumerate() {
            // SAFETY: this frame is inside the consumer's exclusive range.
            unsafe {
                *slot = *self.buffer[base + offset].get();
            }
        }
        self.head.store(head.wrapping_add(1), Ordering::Release);
        true
    }

    fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// Shared control block
// ---------------------------------------------------------------------------

struct Shared {
    shutdown: AtomicBool,
    generation: AtomicU64,
    enabled: AtomicBool,
    bus_mask: AtomicU32,
    bit_depth: AtomicU32,
    split_minutes: AtomicU32,
    sample_rate: AtomicU32,
    directory: Mutex<String>,
    format: Mutex<String>,
    file: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    recording: AtomicBool,
    frames_written: AtomicU64,
}

impl Shared {
    fn new(sample_rate: u32) -> Self {
        Self {
            shutdown: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            enabled: AtomicBool::new(false),
            bus_mask: AtomicU32::new(1),
            bit_depth: AtomicU32::new(24),
            split_minutes: AtomicU32::new(0),
            sample_rate: AtomicU32::new(sample_rate),
            directory: Mutex::new(String::new()),
            format: Mutex::new("wav".into()),
            file: Mutex::new(None),
            error: Mutex::new(None),
            recording: AtomicBool::new(false),
            frames_written: AtomicU64::new(0),
        }
    }

    fn apply(&self, params: &RecorderParams) {
        let mut mask = 0u32;
        for bus in &params.buses {
            if let Some(index) = BUS_IDS.iter().position(|id| id == bus) {
                mask |= 1 << index;
            }
        }
        if mask == 0 {
            mask = 1; // A1 is always a safe default.
        }
        self.enabled.store(params.enabled, Ordering::Release);
        self.bus_mask.store(mask, Ordering::Release);
        self.bit_depth.store(params.bit_depth as u32, Ordering::Release);
        self.split_minutes.store(params.split_minutes, Ordering::Release);
        *self.directory.lock() = params.directory.clone();
        *self.format.lock() = params.format.clone();
        *self.error.lock() = None;
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    fn mask(&self) -> u32 {
        self.bus_mask.load(Ordering::Acquire)
    }

    fn bits(&self) -> u16 {
        match self.bit_depth.load(Ordering::Acquire) {
            16 => 16,
            32 => 32,
            _ => 24,
        }
    }

    fn split_minutes(&self) -> u32 {
        self.split_minutes.load(Ordering::Acquire)
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Acquire)
    }

    fn status(&self) -> RecorderStatus {
        let frames = self.frames_written.load(Ordering::Relaxed);
        let rate = self.sample_rate().max(1) as f64;
        RecorderStatus {
            recording: self.recording.load(Ordering::Acquire),
            file: self.file.lock().clone(),
            seconds: frames as f64 / rate,
            dropped_frames: 0,
            error: self.error.lock().clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

pub struct RecorderHandle {
    shared: Arc<Shared>,
    ring: Arc<RecorderRing>,
    last: Mutex<RecorderParams>,
    thread: Option<JoinHandle<()>>,
}

impl RecorderHandle {
    pub fn new(sample_rate: u32) -> Self {
        // Two seconds of headroom at the clock rate. The ring is allocated
        // once, before any audio stream starts.
        let ring = Arc::new(RecorderRing::new((sample_rate as usize).max(48_000) * 2));
        let shared = Arc::new(Shared::new(sample_rate));
        let writer_shared = Arc::clone(&shared);
        let writer_ring = Arc::clone(&ring);
        let thread = std::thread::Builder::new()
            .name("nexus-recorder".into())
            .spawn(move || writer_loop(writer_shared, writer_ring))
            .ok();

        Self {
            shared,
            ring,
            last: Mutex::new(RecorderParams::default()),
            thread,
        }
    }

    /// Producer side for the master callback.
    pub fn tap(&self) -> Arc<RecorderRing> {
        Arc::clone(&self.ring)
    }

    /// Apply UI settings. Duplicate snapshots are ignored, so dragging a fader
    /// does not restart an active recording.
    pub fn configure(&self, params: RecorderParams) {
        let mut last = self.last.lock();
        if *last == params {
            return;
        }
        *last = params.clone();
        self.shared.apply(&params);
    }

    pub fn status(&self) -> RecorderStatus {
        let mut status = self.shared.status();
        status.dropped_frames = self.ring.dropped();
        status
    }

    /// The clock master may fall back to a different device rate; align the
    /// WAV header and the "seconds" counter before recording starts.
    pub fn set_sample_rate(&self, sample_rate: u32) {
        if sample_rate > 0 {
            self.shared.sample_rate.store(sample_rate, Ordering::Release);
        }
    }
}

impl Drop for RecorderHandle {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Writer thread
// ---------------------------------------------------------------------------

fn writer_loop(shared: Arc<Shared>, ring: Arc<RecorderRing>) {
    let mut last_generation = 0u64;
    let mut writer: Option<WavWriter> = None;
    let mut split_index = 0u32;
    let mut frame = [0.0f32; TAP_CHANNELS];
    let mut bytes = Vec::with_capacity(4_096 * TAP_CHANNELS * 4);

    loop {
        let shutting_down = shared.shutdown.load(Ordering::Acquire);
        let generation = shared.generation.load(Ordering::Acquire);

        if generation != last_generation {
            last_generation = generation;
            writer = None;
            *shared.file.lock() = None;
            shared.frames_written.store(0, Ordering::Relaxed);
            split_index = 0;
            if shared.enabled() {
                match WavWriter::open(&shared, &ring) {
                    Ok((next, path)) => {
                        writer = Some(next);
                        *shared.file.lock() = Some(path);
                        shared.recording.store(true, Ordering::Release);
                    }
                    Err(error) => {
                        *shared.error.lock() = Some(error);
                        shared.recording.store(false, Ordering::Release);
                    }
                }
            } else {
                shared.recording.store(false, Ordering::Release);
            }
        }

        if let Some(mut active) = writer.take() {
            bytes.clear();
            let mut frames_in_batch = 0usize;
            let mut split_reached = false;
            while frames_in_batch < 4_096 {
                if !ring.pop_frame(&mut frame) {
                    break;
                }
                active.push_frame(&mut bytes, &frame);
                frames_in_batch += 1;
                if active.split_at.is_some_and(|limit| active.frames >= limit) {
                    split_reached = true;
                    break;
                }
            }

            let mut write_error = None;
            if !bytes.is_empty() {
                match active.write_bytes(&bytes) {
                    Ok(()) => shared
                        .frames_written
                        .store(active.frames, Ordering::Relaxed),
                    Err(error) => write_error = Some(error),
                }
            }

            if let Some(error) = write_error {
                *shared.error.lock() = Some(error);
                *shared.file.lock() = None;
                shared.recording.store(false, Ordering::Release);
            } else if split_reached {
                // `active` is dropped here and finalizes the segment.
                split_index += 1;
                shared.frames_written.store(0, Ordering::Relaxed);
                match WavWriter::open_split(&shared, &ring, split_index) {
                    Ok((next, path)) => {
                        writer = Some(next);
                        *shared.file.lock() = Some(path);
                    }
                    Err(error) => {
                        *shared.error.lock() = Some(error);
                        shared.recording.store(false, Ordering::Release);
                    }
                }
            } else {
                writer = Some(active);
            }
        } else {
            // Discard stale audio while idle so enabling recording never
            // replays old samples.
            let mut discarded = 0;
            while discarded < 8_192 && ring.pop_frame(&mut frame) {
                discarded += 1;
            }
        }

        if shutting_down {
            // One last drain so the final few milliseconds reach disk.
            if let Some(mut active) = writer.take() {
                bytes.clear();
                while ring.pop_frame(&mut frame) {
                    active.push_frame(&mut bytes, &frame);
                }
                if !bytes.is_empty() {
                    let _ = active.write_bytes(&bytes);
                }
                shared.frames_written.store(active.frames, Ordering::Relaxed);
            }
            break;
        }

        std::thread::sleep(Duration::from_millis(4));
    }

    shared.recording.store(false, Ordering::Release);
    shared.shutdown.store(true, Ordering::Release);
}

// ---------------------------------------------------------------------------
// Minimal WAV writer (PCM 16/24, IEEE float 32)
// ---------------------------------------------------------------------------

struct WavWriter {
    file: BufWriter<File>,
    channels: u16,
    sample_rate: u32,
    bits: u16,
    format_tag: u16,
    data_bytes: u64,
    frames: u64,
    split_at: Option<u64>,
    selected: Vec<usize>,
}

impl WavWriter {
    fn open(shared: &Shared, _ring: &RecorderRing) -> Result<(Self, String), String> {
        Self::open_split(shared, _ring, 0)
    }

    fn open_split(shared: &Shared, _ring: &RecorderRing, split_index: u32) -> Result<(Self, String), String> {
        let mask = shared.mask();
        let selected: Vec<usize> = (0..BUSES).filter(|index| mask & (1 << index) != 0).collect();
        if selected.is_empty() {
            return Err("не выбрано ни одной шины для записи".into());
        }

        let base = unix_timestamp();
        let suffix = if split_index == 0 {
            String::new()
        } else {
            format!("-{split_index}")
        };

        // Some Windows profiles redirect or protect the Music known folder.
        // Try the requested location first, then fall back to LocalAppData so
        // recording never fails just because the default folder is unavailable.
        let requested = recording_directory(&shared.directory.lock());
        let (file, path) = match open_recording_file(&requested, base, &suffix) {
            Ok(result) => result,
            Err(first_error) => {
                let fallback = fallback_recording_directory();
                open_recording_file(&fallback, base, &suffix).map_err(|second_error| {
                    format!(
                        "не удалось создать запись в {} ({first_error}); запасной путь {} тоже не сработал ({second_error})",
                        requested.display(),
                        fallback.display()
                    )
                })?
            }
        };
        let mut writer = BufWriter::with_capacity(64 * 1024, file);

        let bits = shared.bits();
        let format_tag = if bits == 32 { 3 } else { 1 };
        write_header(
            writer.get_mut(),
            selected.len() as u16 * 2,
            shared.sample_rate(),
            bits,
            format_tag,
            0,
        )
        .map_err(|error| format!("не удалось записать WAV-заголовок: {error}"))?;

        let split_at = match shared.split_minutes() {
            0 => None,
            minutes => Some(minutes as u64 * 60 * shared.sample_rate() as u64),
        };

        let format = shared.format.lock().clone();
        if format != "wav" {
            *shared.error.lock() = Some(format!(
                "формат {} пока не поддерживается — записываю WAV",
                format.to_uppercase()
            ));
        }

        Ok((
            Self {
                file: writer,
                channels: selected.len() as u16 * 2,
                sample_rate: shared.sample_rate(),
                bits,
                format_tag,
                data_bytes: 0,
                frames: 0,
                split_at,
                selected,
            },
            path.display().to_string(),
        ))
    }

    fn push_frame(&mut self, out: &mut Vec<u8>, frame: &[f32; TAP_CHANNELS]) {
        for bus in &self.selected {
            push_sample(out, frame[bus * 2], self.bits);
            push_sample(out, frame[bus * 2 + 1], self.bits);
        }
        self.frames += 1;
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.file
            .write_all(bytes)
            .map_err(|error| format!("ошибка записи WAV: {error}"))?;
        self.data_bytes += bytes.len() as u64;
        Ok(())
    }

    fn finalize(&mut self) {
        let _ = self.file.flush();
        let file = self.file.get_mut();
        let _ = write_header(
            file,
            self.channels,
            self.sample_rate,
            self.bits,
            self.format_tag,
            self.data_bytes,
        );
        let _ = file.sync_all();
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        self.finalize();
    }
}

fn recording_directory(configured: &str) -> PathBuf {
    let configured = configured.trim();
    if !configured.is_empty() {
        return PathBuf::from(configured);
    }
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Music").join("Nexus-Mixer")
}

fn fallback_recording_directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Nexus-Mixer")
        .join("Records")
}

fn open_recording_file(
    directory: &PathBuf,
    base: u64,
    suffix: &str,
) -> Result<(File, PathBuf), String> {
    create_dir_all(directory)
        .map_err(|error| format!("не удалось создать папку {}: {error}", directory.display()))?;
    let path = directory.join(format!("nexus-{base}{suffix}.wav"));
    let file = File::create(&path)
        .map_err(|error| format!("не удалось создать {}: {error}", path.display()))?;
    Ok((file, path))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn push_sample(out: &mut Vec<u8>, sample: f32, bits: u16) {
    let sample = sample.clamp(-1.0, 1.0);
    match bits {
        16 => out.extend_from_slice(&((sample * 32_767.0) as i16).to_le_bytes()),
        32 => out.extend_from_slice(&sample.to_le_bytes()),
        _ => {
            let value = (sample * 8_388_607.0) as i32;
            out.extend_from_slice(&value.to_le_bytes()[..3]);
        }
    }
}

fn write_header(
    file: &mut File,
    channels: u16,
    sample_rate: u32,
    bits: u16,
    format_tag: u16,
    data_bytes: u64,
) -> std::io::Result<()> {
    let bytes_per_sample = bits / 8;
    let block_align = channels * bytes_per_sample;
    let byte_rate = sample_rate * block_align as u32;
    let data_size = data_bytes.min(u32::MAX as u64) as u32;

    file.seek(SeekFrom::Start(0))?;
    file.write_all(b"RIFF")?;
    file.write_all(&(36u32.saturating_add(data_size)).to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&format_tag.to_le_bytes())?;
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&bits.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_size.to_le_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn ring_roundtrips_a_frame() {
        let ring = RecorderRing::new(4);
        let mut frame = [0.0f32; TAP_CHANNELS];
        for (index, sample) in frame.iter_mut().enumerate() {
            *sample = index as f32;
        }
        assert!(ring.push_frame(&frame));
        let mut out = [0.0f32; TAP_CHANNELS];
        assert!(ring.pop_frame(&mut out));
        assert_eq!(out, frame);
        assert!(!ring.pop_frame(&mut out));
    }

    #[test]
    fn ring_drops_when_full() {
        let ring = RecorderRing::new(1);
        let frame = [0.0f32; TAP_CHANNELS];
        assert!(ring.push_frame(&frame));
        assert!(!ring.push_frame(&frame));
        assert_eq!(ring.dropped(), 1);
    }

    #[test]
    fn bus_mask_maps_ui_ids() {
        let shared = Shared::new(48_000);
        shared.apply(&RecorderParams {
            enabled: true,
            buses: vec!["A1".into(), "B1".into()],
            ..RecorderParams::default()
        });
        assert_eq!(shared.mask(), 0b1001);
        assert!(shared.enabled());
    }

    #[test]
    fn configured_directory_is_used() {
        let path = recording_directory("C:/Temp/Nexus");
        assert_eq!(path, Path::new("C:/Temp/Nexus"));
    }

    #[test]
    fn writer_creates_a_valid_wav_file() {
        let directory = std::env::temp_dir().join(format!(
            "nexus-recorder-test-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let handle = RecorderHandle::new(48_000);
        let tap = handle.tap();
        let params = RecorderParams {
            enabled: true,
            directory: directory.display().to_string(),
            format: "wav".into(),
            bit_depth: 24,
            buses: vec!["A1".into()],
            split_minutes: 0,
        };
        handle.configure(params.clone());

        let frame = [0.1f32; TAP_CHANNELS];
        for _ in 0..960 {
            tap.push_frame(&frame);
        }
        std::thread::sleep(Duration::from_millis(180));

        let status = handle.status();
        assert!(status.recording, "writer did not start: {status:?}");
        let path = status.file.expect("file path");
        handle.configure(RecorderParams {
            enabled: false,
            ..params
        });
        drop(handle);

        let bytes = std::fs::read(&path).expect("wav file");
        assert!(bytes.len() > 44, "wav has no payload");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let _ = std::fs::remove_dir_all(&directory);
    }
}
