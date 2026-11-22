//! Lock-free single-producer / single-consumer ring buffer for audio frames.
//!
//! Input callbacks push interleaved stereo samples, the output callback pops
//! them. No locks, no allocation after construction, no blocking. If the
//! consumer falls behind, `push_slice` simply drops the excess and reports how
//! many samples were written — the caller counts that as an overrun.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Interleaved stereo samples per frame.
pub const CHANNELS: usize = 2;

pub struct SpscRing {
    buffer: Box<[UnsafeCell<f32>]>,
    mask: usize,
    head: AtomicUsize,
    tail: AtomicUsize,
}

// The producer only writes `[tail, tail + n)` and the consumer only reads
// `[head, head + n)`. The two ranges never overlap, so sharing the buffer
// between the two threads is sound as long as indices are published with
// Release/Acquire ordering.
unsafe impl Sync for SpscRing {}
unsafe impl Send for SpscRing {}

impl SpscRing {
    /// `capacity_frames` is rounded up to the next power of two.
    pub fn new(capacity_frames: usize) -> Self {
        let requested = capacity_frames.max(1) * CHANNELS;
        let capacity = requested.next_power_of_two();
        let buffer: Vec<UnsafeCell<f32>> = (0..capacity).map(|_| UnsafeCell::new(0.0)).collect();
        Self {
            buffer: buffer.into_boxed_slice(),
            mask: capacity - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    #[inline]
    pub fn capacity(&self) -> usize {
        self.buffer.len()
    }

    #[inline]
    pub fn available_read(&self) -> usize {
        let tail = self.tail.load(Ordering::Acquire);
        let head = self.head.load(Ordering::Relaxed);
        tail.wrapping_sub(head)
    }

    #[inline]
    pub fn available_write(&self) -> usize {
        self.capacity() - self.available_read()
    }

    /// Producer side. Returns the number of samples actually written.
    #[inline]
    pub fn push_slice(&self, data: &[f32]) -> usize {
        let head = self.head.load(Ordering::Acquire);
        let tail = self.tail.load(Ordering::Relaxed);
        let free = self.capacity() - tail.wrapping_sub(head);
        let count = data.len().min(free);

        for (offset, sample) in data[..count].iter().enumerate() {
            let index = tail.wrapping_add(offset) & self.mask;
            // SAFETY: this index is inside the producer's exclusive range.
            unsafe {
                *self.buffer[index].get() = *sample;
            }
        };

        // Publish the samples only after they are fully written.
        self.tail.store(tail.wrapping_add(count), Ordering::Release);
        count
    }

    /// Consumer side. Returns the number of samples actually read.
    #[inline]
    pub fn pop_slice(&self, out: &mut [f32]) -> usize {
        let tail = self.tail.load(Ordering::Acquire);
        let head = self.head.load(Ordering::Relaxed);
        let available = tail.wrapping_sub(head);
        let count = out.len().min(available);

        for (offset, slot) in out[..count].iter_mut().enumerate() {
            let index = head.wrapping_add(offset) & self.mask;
            // SAFETY: this index is inside the consumer's exclusive range.
            unsafe {
                *slot = *self.buffer[index].get();
            }
        }

        self.head.store(head.wrapping_add(count), Ordering::Release);
        count
    }

    /// Consumer-side convenience: pops one stereo frame, filling silence when
    /// the buffer is empty.
    #[inline]
    pub fn pop_frame_or_silence(&self) -> (f32, f32) {
        let mut frame = [0.0_f32; CHANNELS];
        let read = self.pop_slice(&mut frame);
        if read == CHANNELS {
            (frame[0], frame[1])
        } else {
            (0.0, 0.0)
        }
    }

    pub fn clear(&self) {
        self.head.store(0, Ordering::Release);
        self.tail.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_is_rounded_up() {
        let ring = SpscRing::new(10);
        assert_eq!(ring.capacity(), 32);
        assert_eq!(ring.available_write(), 32);
        assert_eq!(ring.available_read(), 0);
    }

    #[test]
    fn push_and_pop_roundtrip() {
        let ring = SpscRing::new(8);
        let written = ring.push_slice(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(written, 4);
        let mut out = [0.0; 4];
        assert_eq!(ring.pop_slice(&mut out), 4);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(ring.available_read(), 0);
    }

    #[test]
    fn overrun_drops_excess() {
        let ring = SpscRing::new(2);
        let written = ring.push_slice(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(written, 4);
        assert_eq!(ring.available_write(), 0);
    }

    #[test]
    fn underrun_fills_silence() {
        let ring = SpscRing::new(4);
        ring.push_slice(&[0.5, -0.5]);
        let (l, r) = ring.pop_frame_or_silence();
        assert_eq!((l, r), (0.5, -0.5));
        let (l, r) = ring.pop_frame_or_silence();
        assert_eq!((l, r), (0.0, 0.0));
    }

    #[test]
    fn wraps_around() {
        let ring = SpscRing::new(2);
        let mut out = [0.0; 4];
        for generation in 0..10 {
            let data = [generation as f32, generation as f32 + 0.5, generation as f32 + 0.25, generation as f32 + 0.75];
            assert_eq!(ring.push_slice(&data), 4);
            assert_eq!(ring.pop_slice(&mut out), 4);
            assert_eq!(out, data);
        }
    }
}
