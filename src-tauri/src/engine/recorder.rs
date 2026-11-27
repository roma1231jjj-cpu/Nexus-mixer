//! Post-fader WAV recorder.
//!
//! The audio callback pushes the fifteen processed stereo buses into a lock-free
//! ring; a dedicated writer thread drains it, selects the buses requested by the
//! UI and writes a standard PCM/float WAV file. No allocation, file I/O or
//! locking happens on the realtime thread.
//!
//! Settings are split in two groups:
//!
//! * `enabled` is the transport flag. Turning it on opens the file, turning it
//!   off drains the queue and finalizes the header. It is the only thing that
//!   may start a new file.
//! * everything else (buses, bit depth, folder, split interval) is a session
//!   setting. It is snapshotted when the file is opened, so editing it during a
//!   take never restarts or fragments the file — it applies to the next
//!   session. `RecorderStatus::pending_changes` tells the UI about that.
//!
//! Segments roll over automatically before the RIFF 4 GiB limit, even when
//! time-based splitting is off, and the roll happens on an exact frame
//! boundary so nothing is repeated or skipped.
//!
//! An empty bus mask is an error: it never falls back to A1.
//!
//! v0.1 deliberately supports WAV only. FLAC/MP3 are accepted by the UI but
//! are written as WAV with an explanatory status notice until encoders land.

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

use super::graph::{BUSES, BUS_IDS};

/// Interleaved stereo samples per captured frame: all buses.
pub const TAP_CHANNELS: usize = BUSES * 2;

/// Frames pulled from the ring per writer wake-up.
const BATCH_FRAMES: usize = 4_096;
/// Bytes buffered before one `write` call reaches the `BufWriter`.
const FLUSH_BYTES: usize = 256 * 1024;

/// A RIFF data chunk stores its size in a 32-bit field, and the RIFF chunk size
/// (`36 + data`) is 32-bit too, so the payload is capped 36 bytes below the
/// type limit. Anything above overflows the header.
const RIFF_MAX_DATA_BYTES: u64 = 0xFFFF_FFFF - 36;
/// Segments roll this far below the hard limit, so a final drain of the queue
/// can never push a segment over the limit.
const RIFF_ROLL_MARGIN_BYTES: u64 = 16 * 1024 * 1024;

/// Status notice code: the file was split because it reached the RIFF limit.
pub const NOTICE_SPLIT_BY_SIZE: &str = "splitBySize";

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
    /// Notice for the current take: a stable code (`splitBySize`) or a
    /// ready-to-show backend message.
    pub notice: Option<String>,
    /// Buses of the take in progress, empty when no file is open.
    pub buses: Vec<String>,
    /// Bit depth of the take in progress, 0 when no file is open.
    pub bit_depth: u16,
    /// The UI settings differ from the running take and apply after it stops.
    pub pending_changes: bool,
}

impl Default for RecorderStatus {
    fn default() -> Self {
        Self {
            recording: false,
            file: None,
            seconds: 0.0,
            dropped_frames: 0,
            error: None,
            notice: None,
            buses: Vec::new(),
            bit_depth: 0,
            pending_changes: false,
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

    /// Frames waiting in the ring right now.
    fn queued(&self) -> u64 {
        let tail = self.tail.load(Ordering::Acquire);
        let head = self.head.load(Ordering::Relaxed);
        tail.wrapping_sub(head)
    }

    fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// Session snapshot
// ---------------------------------------------------------------------------

/// Settings frozen when a file is opened. Changing the UI settings afterwards
/// leaves this untouched until the next session starts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionSpec {
    mask: u32,
    bits: u16,
    sample_rate: u32,
    split_minutes: u32,
    directory: String,
    format: String,
}

impl SessionSpec {
    fn selected(&self) -> Vec<usize> {
        (0..BUSES)
            .filter(|index| self.mask & (1 << index) != 0)
            .collect()
    }

    fn channels(&self) -> u16 {
        self.selected().len() as u16 * 2
    }

    fn frame_bytes(&self) -> u64 {
        self.channels() as u64 * self.bits as u64 / 8
    }

    fn bus_ids(&self) -> Vec<String> {
        bus_ids(self.mask)
    }
}

fn bus_mask(buses: &[String]) -> u32 {
    let mut mask = 0u32;
    for bus in buses {
        if let Some(index) = BUS_IDS.iter().position(|id| id == bus) {
            mask |= 1 << index;
        }
    }
    mask
}

fn bus_ids(mask: u32) -> Vec<String> {
    BUS_IDS
        .iter()
        .enumerate()
        .filter(|(index, _)| mask & (1 << index) != 0)
        .map(|(_, id)| (*id).to_string())
        .collect()
}

fn format_notice(spec: &SessionSpec) -> Option<String> {
    if spec.format.eq_ignore_ascii_case("wav") {
        None
    } else {
        Some(format!(
            "формат {} пока не поддерживается — пишется WAV",
            spec.format.to_uppercase()
        ))
    }
}

// ---------------------------------------------------------------------------
// Shared control block
// ---------------------------------------------------------------------------

struct Shared {
    shutdown: AtomicBool,
    /// Bumped only when the user explicitly starts recording, or when a start
    /// that already failed may be retried with the corrected settings.
    generation: AtomicU64,
    enabled: AtomicBool,
    /// Set when the last start attempt could not open a file.
    start_failed: AtomicBool,
    bus_mask: AtomicU32,
    bit_depth: AtomicU32,
    split_minutes: AtomicU32,
    sample_rate: AtomicU32,
    directory: Mutex<String>,
    format: Mutex<String>,
    file: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    notice: Mutex<Option<String>>,
    /// Spec of the take in progress; `None` while no file is open.
    active: Mutex<Option<SessionSpec>>,
    recording: AtomicBool,
    frames_written: AtomicU64,
}

impl Shared {
    fn new(sample_rate: u32) -> Self {
        Self {
            shutdown: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            enabled: AtomicBool::new(false),
            start_failed: AtomicBool::new(false),
            bus_mask: AtomicU32::new(1),
            bit_depth: AtomicU32::new(24),
            split_minutes: AtomicU32::new(0),
            sample_rate: AtomicU32::new(sample_rate),
            directory: Mutex::new(String::new()),
            format: Mutex::new("wav".into()),
            file: Mutex::new(None),
            error: Mutex::new(None),
            notice: Mutex::new(None),
            active: Mutex::new(None),
            recording: AtomicBool::new(false),
            frames_written: AtomicU64::new(0),
        }
    }

    fn apply(&self, params: &RecorderParams) {
        let before = self.pending_spec();
        // An empty mask is stored as-is: the writer refuses to open a file and
        // reports it instead of silently recording A1.
        let mask = bus_mask(&params.buses);
        let was_enabled = self.enabled.swap(params.enabled, Ordering::AcqRel);
        self.bus_mask.store(mask, Ordering::Release);
        self.bit_depth
            .store(params.bit_depth as u32, Ordering::Release);
        self.split_minutes
            .store(params.split_minutes, Ordering::Release);
        *self.directory.lock() = params.directory.clone();
        *self.format.lock() = params.format.clone();

        // The last error is deliberately left alone: only a successful start
        // (or the user) may clear it.
        if params.enabled && !was_enabled {
            self.generation.fetch_add(1, Ordering::AcqRel);
        } else if params.enabled
            && self.start_failed.load(Ordering::Acquire)
            && before != self.pending_spec()
        {
            // No file is open (the start failed), so correcting the settings
            // may retry instead of waiting for another click.
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
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

    /// Settings as they are in the UI right now; used for the next session and
    /// to tell the UI that the running take uses older values.
    fn pending_spec(&self) -> SessionSpec {
        SessionSpec {
            mask: self.mask(),
            bits: self.bits(),
            sample_rate: self.sample_rate().max(1),
            split_minutes: self.split_minutes(),
            directory: self.directory.lock().clone(),
            format: self.format.lock().clone(),
        }
    }

    fn status(&self) -> RecorderStatus {
        let frames = self.frames_written.load(Ordering::Relaxed);
        let rate = self.sample_rate().max(1) as f64;
        let active = self.active.lock().clone();
        let pending_changes = active
            .as_ref()
            .is_some_and(|spec| *spec != self.pending_spec());
        RecorderStatus {
            recording: self.recording.load(Ordering::Acquire),
            file: self.file.lock().clone(),
            seconds: frames as f64 / rate,
            dropped_frames: 0,
            error: self.error.lock().clone(),
            notice: self.notice.lock().clone(),
            buses: active
                .as_ref()
                .map(SessionSpec::bus_ids)
                .unwrap_or_default(),
            bit_depth: active.as_ref().map_or(0, |spec| spec.bits),
            pending_changes,
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

    /// Apply UI settings. Identical snapshots are ignored. Session settings are
    /// stored for the next take; a take in progress keeps its own snapshot.
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
            self.shared
                .sample_rate
                .store(sample_rate, Ordering::Release);
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

/// A segment roll that the control block has to publish.
struct RollEvent {
    reason: RollReason,
    path: String,
}

fn writer_loop(shared: Arc<Shared>, ring: Arc<RecorderRing>) {
    // Starts at zero on purpose: `Shared` is constructed with generation 0, so
    // any bump is a start request that happened after this handle was built.
    // Reading the live value here would race the first `configure` and drop the
    // start request of a recording armed before the thread was scheduled.
    let mut seen_start = 0u64;
    let mut session: Option<Session> = None;
    let mut frame = [0.0f32; TAP_CHANNELS];

    loop {
        let shutting_down = shared.shutdown.load(Ordering::Acquire);
        let generation = shared.generation.load(Ordering::Acquire);
        let requested = shared.enabled();

        if generation != seen_start {
            // A start request is the only reason to open a file. Anything that
            // was still running is closed first, with its queue drained.
            seen_start = generation;
            if let Some(active) = session.take() {
                close_session(&shared, active, &ring, &mut frame);
            }
            shared.recording.store(false, Ordering::Release);

            if requested {
                // Frames captured before the request must not land in the file.
                discard_ring(&ring, &mut frame);
                let spec = shared.pending_spec();
                match Session::open(&spec) {
                    Ok((opened, path)) => {
                        *shared.file.lock() = Some(path);
                        *shared.notice.lock() = format_notice(&spec);
                        *shared.error.lock() = None;
                        *shared.active.lock() = Some(spec);
                        shared.start_failed.store(false, Ordering::Release);
                        shared.frames_written.store(0, Ordering::Relaxed);
                        shared.recording.store(true, Ordering::Release);
                        session = Some(opened);
                    }
                    Err(error) => {
                        *shared.file.lock() = None;
                        *shared.error.lock() = Some(error);
                        *shared.active.lock() = None;
                        shared.start_failed.store(true, Ordering::Release);
                        shared.recording.store(false, Ordering::Release);
                    }
                }
            }
        }

        let mut failed = false;
        if session.is_some() && !requested {
            // Stop requested: drain what the callback already pushed, then
            // finalize the header. Nothing is written after this point.
            let finished = session.take().expect("session checked above");
            close_session(&shared, finished, &ring, &mut frame);
        } else if let Some(active) = session.as_mut() {
            match active.pump(&ring, &mut frame, BATCH_FRAMES) {
                Ok(Some(event)) => {
                    *shared.file.lock() = Some(event.path);
                    if event.reason == RollReason::Size {
                        *shared.notice.lock() = Some(NOTICE_SPLIT_BY_SIZE.into());
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    *shared.error.lock() = Some(error);
                    failed = true;
                }
            }
            shared
                .frames_written
                .store(active.total_frames(), Ordering::Relaxed);
        } else {
            // Idle: drop whatever the tap pushed so a later start never
            // replays stale audio.
            discard_ring(&ring, &mut frame);
        }

        if failed {
            if let Some(broken) = session.take() {
                close_session(&shared, broken, &ring, &mut frame);
            }
        }

        if shutting_down {
            if let Some(active) = session.take() {
                close_session(&shared, active, &ring, &mut frame);
            }
            break;
        }

        std::thread::sleep(Duration::from_millis(4));
    }

    shared.recording.store(false, Ordering::Release);
    shared.shutdown.store(true, Ordering::Release);
}

/// Drain the queue into the file, finalize the header and publish the result.
/// Used for a normal stop, an error, a replaced session and shutdown.
fn close_session(
    shared: &Shared,
    session: Session,
    ring: &RecorderRing,
    frame: &mut [f32; TAP_CHANNELS],
) {
    let (total, drain_error) = session.drain_and_finish(ring, frame);
    shared.frames_written.store(total, Ordering::Relaxed);
    if let Some(error) = drain_error {
        let mut slot = shared.error.lock();
        if slot.is_none() {
            *slot = Some(error);
        }
    }
    *shared.active.lock() = None;
    shared.recording.store(false, Ordering::Release);
}

/// Throw away queued frames (bounded, so a fast tap cannot starve the loop).
fn discard_ring(ring: &RecorderRing, frame: &mut [f32; TAP_CHANNELS]) {
    let limit = ring.queued().min(65_536);
    let mut discarded = 0;
    while discarded < limit && ring.pop_frame(frame) {
        discarded += 1;
    }
}

// ---------------------------------------------------------------------------
// One recording session
// ---------------------------------------------------------------------------

/// Owns the current segment, the frame counter and the byte buffer. Kept free
/// of thread and control-block access so it can be driven directly in tests.
struct Session {
    writer: WavWriter,
    /// Timestamp stem shared by every segment of this session.
    base: u64,
    segment: u32,
    total_frames: u64,
    bytes: Vec<u8>,
}

impl Session {
    fn open(spec: &SessionSpec) -> Result<(Self, String), String> {
        let base = unix_timestamp_ms();
        let (writer, path) = WavWriter::open_session(spec, base, 0)?;
        Ok((Self::wrap(writer, base), path))
    }

    fn wrap(writer: WavWriter, base: u64) -> Self {
        Self {
            writer,
            base,
            segment: 0,
            total_frames: 0,
            bytes: Vec::with_capacity(FLUSH_BYTES),
        }
    }

    fn total_frames(&self) -> u64 {
        self.total_frames
    }

    /// Move up to `budget` queued frames into the file. Returns the new segment
    /// when the segment rolled over.
    fn pump(
        &mut self,
        ring: &RecorderRing,
        frame: &mut [f32; TAP_CHANNELS],
        budget: usize,
    ) -> Result<Option<RollEvent>, String> {
        let mut written = 0usize;
        let mut roll = None;
        while written < budget {
            if !ring.pop_frame(frame) {
                break;
            }
            if self.writer.would_overflow(self.bytes.len()) {
                let _ = self.flush();
                return Err("достигнут предел размера RIFF: кадр не помещается в файл".into());
            }
            self.writer.push_frame(&mut self.bytes, frame);
            self.total_frames += 1;
            written += 1;
            if self.writer.segment_full() {
                roll = Some(self.writer.roll_reason());
                break;
            }
        }
        self.flush()?;
        match roll {
            Some(reason) => Ok(Some(self.roll(reason)?)),
            None => Ok(None),
        }
    }

    /// Close the current segment and open the next one. The switch happens on
    /// an exact frame boundary: the frame that filled the old segment is the
    /// last one in it, the next frame is the first one in the new file.
    fn roll(&mut self, reason: RollReason) -> Result<RollEvent, String> {
        self.flush()?;
        self.writer.finalize()?;
        // The segment counter only advances once the new file really exists.
        let next = self.segment + 1;
        let (writer, path) = self.writer.reopen(self.base, next)?;
        self.writer = writer;
        self.segment = next;
        Ok(RollEvent { reason, path })
    }

    fn flush(&mut self) -> Result<(), String> {
        if self.bytes.is_empty() {
            return Ok(());
        }
        let result = self.writer.write_bytes(&self.bytes);
        self.bytes.clear();
        result
    }

    /// Write everything that was already queued when the take ended, then
    /// finalize the header. Returns the total frame count and a drain error.
    fn drain_and_finish(
        mut self,
        ring: &RecorderRing,
        frame: &mut [f32; TAP_CHANNELS],
    ) -> (u64, Option<String>) {
        let queued = ring.queued();
        let mut drained = 0u64;
        let mut error = None;
        while drained < queued && ring.pop_frame(frame) {
            if self.writer.would_overflow(self.bytes.len()) {
                error =
                    Some("достигнут предел размера RIFF: хвост записи не поместился в файл".into());
                break;
            }
            self.writer.push_frame(&mut self.bytes, frame);
            self.total_frames += 1;
            drained += 1;
        }
        if let Err(flush_error) = self.flush() {
            if error.is_none() {
                error = Some(flush_error);
            }
        }
        if let Err(finalize_error) = self.writer.finalize() {
            if error.is_none() {
                error = Some(finalize_error);
            }
        }
        (self.total_frames, error)
    }

    /// Test hook: open a session with an explicit segment size limit and no
    /// time limit, so the roll logic can be exercised without 4 GiB of data.
    #[cfg(test)]
    fn open_with_segment_limit(
        spec: &SessionSpec,
        segment_frames: u64,
    ) -> Result<(Self, String), String> {
        let base = unix_timestamp_ms();
        let (writer, path) = WavWriter::open_with_limits(spec, base, 0, segment_frames, None)?;
        Ok((Self::wrap(writer, base), path))
    }
}

// ---------------------------------------------------------------------------
// Minimal WAV writer (PCM 16/24, IEEE float 32)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RollReason {
    Time,
    Size,
}

struct WavWriter {
    file: BufWriter<File>,
    spec: SessionSpec,
    channels: u16,
    bits: u16,
    format_tag: u16,
    frame_bytes: u64,
    data_bytes: u64,
    frames: u64,
    /// Frames per segment: the smaller of the time split and the RIFF limit.
    segment_frames: u64,
    /// Frames implied by the RIFF limit; kept so every segment of a session
    /// uses the same limit.
    size_segment_frames: u64,
    /// Frames implied by `split_minutes`, `None` when time splitting is off.
    time_segment_frames: Option<u64>,
    selected: Vec<usize>,
    /// Data size that is currently written into the header, so a finalized
    /// segment that receives a late drain is re-finalized instead of skipped.
    header_bytes: u64,
}

impl WavWriter {
    fn open_session(spec: &SessionSpec, base: u64, segment: u32) -> Result<(Self, String), String> {
        if spec.selected().is_empty() {
            return Err("выберите хотя бы одну шину для записи".into());
        }
        let size_frames =
            ((RIFF_MAX_DATA_BYTES - RIFF_ROLL_MARGIN_BYTES) / spec.frame_bytes().max(1)).max(1);
        let time_frames = match spec.split_minutes {
            0 => None,
            minutes => Some(minutes as u64 * 60 * spec.sample_rate.max(1) as u64),
        };
        Self::open_with_limits(spec, base, segment, size_frames, time_frames)
    }

    fn open_with_limits(
        spec: &SessionSpec,
        base: u64,
        segment: u32,
        size_frames: u64,
        time_frames: Option<u64>,
    ) -> Result<(Self, String), String> {
        if spec.selected().is_empty() {
            return Err("выберите хотя бы одну шину для записи".into());
        }
        let channels = spec.channels();
        let bits = spec.bits;
        let format_tag = if bits == 32 { 3 } else { 1 };
        let suffix = if segment == 0 {
            String::new()
        } else {
            format!("-{segment}")
        };

        // Some Windows profiles redirect or protect the Music known folder.
        // Try the requested location first, then fall back to LocalAppData so
        // recording never fails just because the default folder is unavailable.
        let requested = recording_directory(&spec.directory);
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
        let mut file = BufWriter::with_capacity(64 * 1024, file);
        write_header(
            file.get_mut(),
            channels,
            spec.sample_rate,
            bits,
            format_tag,
            0,
        )
        .map_err(|error| format!("не удалось записать WAV-заголовок: {error}"))?;

        let segment_frames = time_frames
            .map_or(size_frames, |time| time.min(size_frames))
            .max(1);

        Ok((
            Self {
                file,
                spec: spec.clone(),
                channels,
                bits,
                format_tag,
                frame_bytes: channels as u64 * bits as u64 / 8,
                data_bytes: 0,
                frames: 0,
                segment_frames,
                size_segment_frames: size_frames,
                time_segment_frames: time_frames,
                selected: spec.selected(),
                header_bytes: 0,
            },
            path.display().to_string(),
        ))
    }

    /// Open the next segment with the same limits as this one.
    fn reopen(&self, base: u64, segment: u32) -> Result<(Self, String), String> {
        Self::open_with_limits(
            &self.spec,
            base,
            segment,
            self.size_segment_frames,
            self.time_segment_frames,
        )
    }

    /// True when the next frame would have to go to a fresh file.
    fn segment_full(&self) -> bool {
        self.frames >= self.segment_frames
    }

    fn roll_reason(&self) -> RollReason {
        match self.time_segment_frames {
            Some(time) if time <= self.segment_frames => RollReason::Time,
            _ => RollReason::Size,
        }
    }

    /// Hard RIFF ceiling; only reachable if a segment was never rolled.
    fn would_overflow(&self, pending_bytes: usize) -> bool {
        self.data_bytes + pending_bytes as u64 + self.frame_bytes > RIFF_MAX_DATA_BYTES
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

    /// Write the real data size into the header and leave the file cursor at the
    /// end of the payload, so a segment that receives more data afterwards (a
    /// drain after a failed roll) appends instead of overwriting the take.
    fn finalize(&mut self) -> Result<(), String> {
        if self.header_bytes == self.data_bytes {
            return Ok(());
        }
        self.header_bytes = self.data_bytes;
        self.file.flush().map_err(|e| format!("flush WAV: {e}"))?;
        let file = self.file.get_mut();
        write_header(
            file,
            self.channels,
            self.spec.sample_rate,
            self.bits,
            self.format_tag,
            self.data_bytes,
        )
        .map_err(|e| format!("header WAV: {e}"))?;
        file.seek(SeekFrom::Start(44 + self.data_bytes))
            .map_err(|e| format!("seek WAV: {e}"))?;
        file.sync_all().map_err(|e| format!("sync WAV: {e}"))?;
        Ok(())
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        let _ = self.finalize();
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

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
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
    let data_size = data_bytes.min(RIFF_MAX_DATA_BYTES) as u32;

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

    fn temp_directory(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nexus-recorder-{tag}-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        ))
    }

    fn float_spec(directory: &Path) -> SessionSpec {
        SessionSpec {
            mask: 1,
            bits: 32,
            sample_rate: 48_000,
            split_minutes: 0,
            directory: directory.display().to_string(),
            format: "wav".into(),
        }
    }

    /// Read a 32-bit float WAV and verify the header matches the payload.
    fn read_float_wav(path: &Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("wav file");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 32);
        let data_size = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]) as usize;
        assert_eq!(
            data_size + 44,
            bytes.len(),
            "header data size does not match the payload"
        );
        bytes[44..]
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect()
    }

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
    fn empty_bus_mask_is_kept_empty() {
        let shared = Shared::new(48_000);
        shared.apply(&RecorderParams {
            enabled: true,
            buses: Vec::new(),
            ..RecorderParams::default()
        });
        assert_eq!(shared.mask(), 0, "an empty mask must not fall back to A1");
    }

    #[test]
    fn configured_directory_is_used() {
        let path = recording_directory("C:/Temp/Nexus");
        assert_eq!(path, Path::new("C:/Temp/Nexus"));
    }

    #[test]
    fn writer_creates_a_valid_wav_file() {
        let directory = temp_directory("basic");
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
        assert!(status.error.is_none(), "unexpected error: {status:?}");
        assert_eq!(status.buses, vec!["A1".to_string()]);
        assert_eq!(status.bit_depth, 24);
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

    #[test]
    fn stop_drains_the_queue_tail_into_the_file() {
        // Every frame pushed after the take was confirmed must survive the
        // stop: the writer may not finalize the header before the queue is
        // empty (this is the "lost tail" defect).
        let directory = temp_directory("drain");
        let handle = RecorderHandle::new(48_000);
        let tap = handle.tap();
        let params = RecorderParams {
            enabled: true,
            directory: directory.display().to_string(),
            format: "wav".into(),
            bit_depth: 32,
            buses: vec!["A1".into()],
            split_minutes: 0,
        };
        handle.configure(params.clone());
        let mut status = handle.status();
        for _ in 0..100 {
            if status.recording {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            status = handle.status();
        }
        assert!(status.recording, "writer did not start: {status:?}");

        let frames = 20_000u32;
        let mut frame = [0.0f32; TAP_CHANNELS];
        for index in 0..frames {
            frame[0] = index as f32 / frames as f32;
            frame[1] = -(index as f32 / frames as f32);
            assert!(tap.push_frame(&frame), "tap overflowed at {index}");
        }
        // Stop right away, without giving the writer a chance to drain first.
        handle.configure(RecorderParams {
            enabled: false,
            ..params
        });
        let mut settled = handle.status();
        for _ in 0..100 {
            if !settled.recording {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            settled = handle.status();
        }
        let path = settled.file.clone().expect("file path");
        let seconds = settled.seconds;
        drop(handle);

        let samples = read_float_wav(Path::new(&path));
        assert_eq!(
            samples.len(),
            frames as usize * 2,
            "tail frames are missing"
        );
        assert_eq!(samples[0], 0.0);
        let last = (frames - 1) as f32 / frames as f32;
        assert_eq!(samples[samples.len() - 2], last);
        assert_eq!(samples[samples.len() - 1], -last);
        assert!(
            (seconds - frames as f64 / 48_000.0).abs() < 0.001,
            "status seconds {seconds} does not match the frame count"
        );
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn drain_moves_the_whole_queue_and_finalizes_the_header() {
        let directory = temp_directory("drain-unit");
        let spec = float_spec(&directory);
        let (session, path) =
            Session::open_with_segment_limit(&spec, u64::MAX / 1024).expect("open session");
        let ring = RecorderRing::new(1_024);
        let mut frame = [0.0f32; TAP_CHANNELS];
        let frames = 500u32;
        for index in 0..frames {
            frame[0] = index as f32 / frames as f32;
            frame[1] = -(index as f32 / frames as f32);
            assert!(ring.push_frame(&frame));
        }

        let (total, error) = session.drain_and_finish(&ring, &mut frame);
        assert_eq!(total, frames as u64);
        assert!(error.is_none(), "{error:?}");

        let samples = read_float_wav(Path::new(&path));
        assert_eq!(samples.len(), frames as usize * 2);
        let last = (frames - 1) as f32 / frames as f32;
        assert_eq!(samples[samples.len() - 2], last);
        assert_eq!(samples[samples.len() - 1], -last);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn finalize_can_be_repeated_after_more_frames_are_written() {
        // A segment may be finalized and still receive frames (drain after a
        // failed roll). The payload must be appended, not overwritten, and the
        // header must be brought up to date.
        let directory = temp_directory("refinalize");
        let spec = float_spec(&directory);
        let (writer, path) =
            WavWriter::open_session(&spec, unix_timestamp_ms(), 0).expect("open segment");
        let mut session = Session::wrap(writer, 0);
        let mut bytes = Vec::new();
        let mut frame = [0.0f32; TAP_CHANNELS];
        for index in 0..5u32 {
            frame[0] = index as f32 / 64.0;
            session.writer.push_frame(&mut bytes, &frame);
        }
        session.writer.write_bytes(&bytes).expect("write");
        session.writer.finalize().expect("finalize");
        assert_eq!(read_float_wav(Path::new(&path)).len(), 10);

        let mut bytes = Vec::new();
        for index in 5..10u32 {
            frame[0] = index as f32 / 64.0;
            session.writer.push_frame(&mut bytes, &frame);
        }
        session.writer.write_bytes(&bytes).expect("write");
        session.writer.finalize().expect("finalize");
        drop(session);

        let samples = read_float_wav(Path::new(&path));
        assert_eq!(samples.len(), 20);
        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[18], 9.0 / 64.0);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn riff_size_limit_rolls_to_a_new_file_without_gaps() {
        let directory = temp_directory("roll");
        let spec = float_spec(&directory);
        // 10 frames per segment: one bus, 32-bit float => 80 bytes of payload.
        let (mut session, first) =
            Session::open_with_segment_limit(&spec, 10).expect("open session");
        let ring = RecorderRing::new(256);
        let mut frame = [0.0f32; TAP_CHANNELS];
        let ramp = |index: u32| index as f32 / 64.0;
        for index in 0..25u32 {
            frame[0] = ramp(index);
            frame[1] = -ramp(index);
            assert!(ring.push_frame(&frame));
        }

        let mut segments = vec![first];
        let mut rolls = Vec::new();
        while ring.queued() > 0 {
            if let Some(event) = session.pump(&ring, &mut frame, BATCH_FRAMES).expect("pump") {
                assert_eq!(event.reason, RollReason::Size);
                rolls.push(event.path.clone());
                segments.push(event.path);
            }
        }
        let (total, error) = session.drain_and_finish(&ring, &mut frame);
        assert_eq!(total, 25);
        assert!(error.is_none(), "{error:?}");
        assert_eq!(segments.len(), 3, "expected 10 + 10 + 5 frames");
        assert_eq!(rolls.len(), 2);

        // Concatenating the segments must reproduce the input exactly: no
        // frame written twice, none skipped.
        let mut samples = Vec::new();
        for path in &segments {
            samples.extend(read_float_wav(Path::new(path)));
        }
        assert_eq!(samples.len(), 50);
        for index in 0..25usize {
            assert_eq!(samples[index * 2], ramp(index as u32), "frame {index} left");
            assert_eq!(
                samples[index * 2 + 1],
                -ramp(index as u32),
                "frame {index} right"
            );
        }
        assert_eq!(read_float_wav(Path::new(&segments[0])).len(), 20);
        assert_eq!(read_float_wav(Path::new(&segments[1])).len(), 20);
        assert_eq!(read_float_wav(Path::new(&segments[2])).len(), 10);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn parameter_changes_do_not_restart_an_active_take() {
        let directory = temp_directory("live-params");
        let other = temp_directory("live-params-other");
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
        let mut status = handle.status();
        for _ in 0..100 {
            if status.recording {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            status = handle.status();
        }
        assert!(status.recording, "writer did not start: {status:?}");
        let first_file = status.file.clone().expect("file path");

        let frame = [0.05f32; TAP_CHANNELS];
        for _ in 0..480 {
            tap.push_frame(&frame);
        }
        std::thread::sleep(Duration::from_millis(60));

        // Every session setting at once, exactly what the UI does when the
        // user edits the panel mid-take.
        handle.configure(RecorderParams {
            enabled: true,
            directory: other.display().to_string(),
            format: "wav".into(),
            bit_depth: 32,
            buses: vec!["A1".into(), "B1".into()],
            split_minutes: 15,
        });
        for _ in 0..480 {
            tap.push_frame(&frame);
        }
        std::thread::sleep(Duration::from_millis(120));

        let during = handle.status();
        assert_eq!(
            during.file.as_deref(),
            Some(first_file.as_str()),
            "file was replaced"
        );
        assert!(during.recording);
        assert_eq!(during.bit_depth, 24, "take bit depth changed mid-file");
        assert_eq!(
            during.buses,
            vec!["A1".to_string()],
            "take buses changed mid-file"
        );
        assert!(
            during.pending_changes,
            "UI must be told about deferred settings"
        );
        assert!(
            during.seconds >= 0.009,
            "frame counter was reset: {during:?}"
        );

        handle.configure(RecorderParams {
            enabled: false,
            ..params.clone()
        });
        let mut settled = handle.status();
        for _ in 0..100 {
            if !settled.recording {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            settled = handle.status();
        }
        assert!(settled.error.is_none(), "unexpected error: {settled:?}");
        drop(handle);

        let bytes = std::fs::read(&first_file).expect("wav file");
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 24);
        let data_size = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]) as usize;
        assert_eq!(data_size + 44, bytes.len());
        assert!(
            !Path::new(&other).exists(),
            "a second file was opened inside the same take"
        );
        let _ = std::fs::remove_dir_all(&directory);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn empty_bus_mask_fails_the_start_and_keeps_the_error() {
        let directory = temp_directory("empty-mask");
        let handle = RecorderHandle::new(48_000);
        let tap = handle.tap();
        let params = RecorderParams {
            enabled: true,
            directory: directory.display().to_string(),
            format: "wav".into(),
            bit_depth: 24,
            buses: Vec::new(),
            split_minutes: 0,
        };
        handle.configure(params.clone());
        let tap_frame = [0.2f32; TAP_CHANNELS];
        for _ in 0..480 {
            tap.push_frame(&tap_frame);
        }
        std::thread::sleep(Duration::from_millis(150));

        let failed = handle.status();
        assert!(!failed.recording, "recording started with an empty mask");
        assert!(failed.file.is_none());
        let error = failed.error.clone().expect("start error");
        assert!(error.contains("шину"), "unexpected error: {error}");

        // Disarming and editing the settings must not wipe the error.
        handle.configure(RecorderParams {
            enabled: false,
            ..params.clone()
        });
        std::thread::sleep(Duration::from_millis(120));
        let disarmed = handle.status();
        assert_eq!(
            disarmed.error.as_deref(),
            Some(error.as_str()),
            "a settings update wiped the error"
        );

        // A start with a valid mask succeeds and clears it.
        handle.configure(RecorderParams {
            enabled: true,
            directory: directory.display().to_string(),
            format: "wav".into(),
            bit_depth: 24,
            buses: vec!["A1".into()],
            split_minutes: 0,
        });
        std::thread::sleep(Duration::from_millis(200));
        let recovered = handle.status();
        assert!(
            recovered.recording,
            "retry after fixing the mask failed: {recovered:?}"
        );
        assert!(
            recovered.error.is_none(),
            "a successful start must clear the error"
        );

        handle.configure(RecorderParams {
            enabled: false,
            ..params
        });
        drop(handle);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn error_survives_parameter_updates() {
        let shared = Shared::new(48_000);
        *shared.error.lock() = Some("диск заполнен".into());
        shared.apply(&RecorderParams {
            enabled: false,
            buses: vec!["A1".into(), "A2".into()],
            bit_depth: 16,
            ..RecorderParams::default()
        });
        assert_eq!(shared.status().error.as_deref(), Some("диск заполнен"));
    }
}
