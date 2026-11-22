//! Nexus-Mixer audio engine.
//!
//! Layout:
//! - [`model`] — JSON types shared with the UI
//! - [`devices`] — endpoint enumeration (WASAPI via cpal)
//! - [`dsp`] — allocation-free DSP primitives used by the realtime thread
//! - [`state`] — atomics + config published between UI and audio threads
//!
//! The I/O graph (capture ring buffers → per-strip processing → routing matrix
//! → bus processing → playback) lives in the next milestone. Keeping the DSP
//! primitives free of I/O makes them unit-testable without an audio device.

pub mod ai;
pub mod ai_audio;
pub mod buffer;
pub mod devices;
pub mod dsp;
#[cfg(windows)]
pub mod driver;
pub mod graph;
pub mod model;
pub mod recorder;
pub mod runtime;
pub mod state;
