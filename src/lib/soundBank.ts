/**
 * Sound Bank — sample metadata, binary persistence and PCM helpers.
 *
 * Metadata lives in localStorage (small, synchronous, survives downgrades),
 * the audio payload lives in IndexedDB as a Blob. Keeping the file itself is
 * the only way a pad can still play after a restart: an AudioBuffer cannot be
 * serialised, and a "pad" without audio is a dead button.
 */

export interface SoundSample {
  id: string
  name: string
  /** File size in bytes */
  size: number
  /** Duration in seconds */
  duration: number
  /** Sample rate of the audio */
  sampleRate: number
  /** Channels decoded from the file */
  channels: number
  /** TARGET stripId to route the sound to ('' = master) */
  targetStrip: string
  /** TARGET busId */
  targetBus: string
  /** Playback volume 0..1 */
  volume: number
  /** Pan -1..1 */
  pan: number
  /** Loop playback */
  loop: boolean
  /** Pitch shift in semitones */
  pitchShift: number
  /** Color for the pad */
  color: string
  /** When this sample was added */
  addedAt: number
}

/** Runtime playback state of one pad. */
export interface SoundPadState {
  playing: boolean
  /** Voice belongs to the Rust engine (routed through the mixer graph). */
  engine: boolean
  /** Peak level 0..1 from the engine, or computed for the preview voice. */
  level: number
  /** Preview-only nodes. */
  gainNode: GainNode | null
  pannerNode: StereoPannerNode | null
  sourceNode: AudioBufferSourceNode | null
}

const STORAGE_KEY = 'nexus-mixer.soundbank'
const DB_NAME = 'nexus-mixer-soundbank'
const DB_STORE = 'files'
const DB_VERSION = 1

/* ──────────────────── id ──────────────────── */

let _counter = 0
export const uid = (): string => `snd-${Date.now().toString(36)}-${(++_counter).toString(36)}`

export const PAD_COLORS = [
  '#f43f5e', '#ec4899', '#a855f7', '#6366f1',
  '#3b82f6', '#06b6d4', '#10b981', '#84cc16',
  '#eab308', '#f59e0b', '#f97316', '#ef4444',
]

/* ──────────────────── metadata (localStorage) ──────────────────── */

export function loadSamples(): SoundSample[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<SoundSample>[]
    return parsed
      .filter((item) => typeof item?.id === 'string' && typeof item?.name === 'string')
      .map((item) => ({
        id: item.id as string,
        name: item.name as string,
        size: Number(item.size ?? 0),
        duration: Number(item.duration ?? 0),
        sampleRate: Number(item.sampleRate ?? 48000),
        channels: Number(item.channels ?? 2),
        targetStrip: item.targetStrip ?? '',
        targetBus: item.targetBus ?? '',
        volume: Number.isFinite(item.volume) ? Number(item.volume) : 0.8,
        pan: Number.isFinite(item.pan) ? Number(item.pan) : 0,
        loop: Boolean(item.loop),
        pitchShift: Number.isFinite(item.pitchShift) ? Number(item.pitchShift) : 0,
        color: item.color ?? PAD_COLORS[0],
        addedAt: Number(item.addedAt ?? Date.now()),
      }))
  } catch {
    return []
  }
}

/** Returns false when the browser refused to persist (quota, private mode). */
export function saveSamples(samples: SoundSample[]): boolean {
  try {
    const clean = samples.map((sample) => ({ ...sample, buffer: undefined }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
    return true
  } catch {
    return false
  }
}

/* ──────────────────── payload (IndexedDB) ──────────────────── */

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, mode)
      const request = run(tx.objectStore(DB_STORE))
      if (!request) {
        resolve(null)
        return
      }
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Store the original file so the pad can be re-decoded after a restart. */
export async function saveSampleBlob(id: string, file: Blob): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(file, id)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

export async function loadSampleBlob(id: string): Promise<Blob | null> {
  const value = await withStore<Blob>('readonly', (store) => store.get(id))
  return value ?? null
}

export async function deleteSampleBlob(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}

/** Sample ids that actually have a payload on disk. */
export async function storedSampleIds(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
  return (keys ?? []).map(String)
}

/* ──────────────────── decode ──────────────────── */

export async function decodeAudioBlob(
  id: string,
  name: string,
  blob: Blob,
  audioCtx: AudioContext,
): Promise<{ sample: SoundSample; buffer: AudioBuffer }> {
  const arrayBuffer = await blob.arrayBuffer()
  const buffer = await audioCtx.decodeAudioData(arrayBuffer)
  const sample: SoundSample = {
    id,
    name,
    size: blob.size,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    targetStrip: '',
    targetBus: '',
    volume: 0.8,
    pan: 0,
    loop: false,
    pitchShift: 0,
    color: PAD_COLORS[Math.floor(Math.random() * PAD_COLORS.length)],
    addedAt: Date.now(),
  }
  return { sample, buffer }
}

export async function decodeAudioFile(
  file: File,
  audioCtx: AudioContext,
): Promise<{ sample: SoundSample; buffer: AudioBuffer }> {
  return decodeAudioBlob(uid(), file.name.replace(/\.[^/.]+$/, ''), file, audioCtx)
}

/** Interleaved stereo PCM the engine expects (mono is duplicated). */
export function toInterleaved(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels >= 2) {
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    const out = new Float32Array(buffer.length * 2)
    for (let i = 0; i < buffer.length; i++) {
      out[i * 2] = left[i]
      out[i * 2 + 1] = right[i]
    }
    return out
  }
  const mono = buffer.getChannelData(0)
  const out = new Float32Array(buffer.length * 2)
  for (let i = 0; i < buffer.length; i++) {
    out[i * 2] = mono[i]
    out[i * 2 + 1] = mono[i]
  }
  return out
}

/* ──────────────────── preview playback (engine offline) ──────────────────── */

export function playPreview(
  audioCtx: AudioContext,
  buffer: AudioBuffer,
  destNode: AudioNode,
  params: { volume: number; pan: number; loop: boolean; pitchShift: number; startOffset?: number; when?: number },
): { gainNode: GainNode; pannerNode: StereoPannerNode; sourceNode: AudioBufferSourceNode } {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  source.loop = params.loop
  source.loopStart = 0
  source.loopEnd = buffer.duration
  source.detune.value = params.pitchShift * 100

  const gain = audioCtx.createGain()
  gain.gain.value = params.volume
  const panner = audioCtx.createStereoPanner()
  panner.pan.value = params.pan

  source.connect(gain)
  gain.connect(panner)
  panner.connect(destNode)

  const rawOffset = params.startOffset ?? 0
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), buffer.duration) : 0
  const when = params.when && params.when > 0 ? params.when : 0
  source.start(when, offset)

  return { gainNode: gain, pannerNode: panner, sourceNode: source }
}

export const playSample = playPreview

/* ──────────────────── sequencer state (localStorage) ──────────────────── */

const SEQ_KEY = 'nexus-mixer.sequencer'

export function loadSequencerPattern(): { pattern: Record<string, boolean[]>; bpm: number; swing: number } | null {
  try {
    const raw = localStorage.getItem(SEQ_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { pattern?: Record<string, boolean[]>; bpm?: number; swing?: number }
    if (!parsed.pattern) return null
    return {
      pattern: parsed.pattern,
      bpm: Number(parsed.bpm) > 0 ? Number(parsed.bpm) : 120,
      swing: Number(parsed.swing) >= 0 ? Number(parsed.swing) : 0,
    }
  } catch {
    return null
  }
}

export function saveSequencerPattern(pattern: Record<string, boolean[]>, bpm: number, swing: number): boolean {
  try {
    localStorage.setItem(SEQ_KEY, JSON.stringify({ pattern, bpm, swing }))
    return true
  } catch {
    return false
  }
}
