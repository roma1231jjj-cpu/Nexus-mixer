/**
 * Sound Bank — audio sample library & Web Audio playback
 */

export interface SoundSample {
  id: string
  name: string
  /** File size in bytes */
  size: number
  /** Duration in seconds (estimated from file) */
  duration: number
  /** Audio buffer decoded from file */
  buffer: AudioBuffer | null
  /** Sample rate of the audio */
  sampleRate: number
  /** TARGET stripId to route the sound to ('' = none) */
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

export interface SoundPadState {
  /** Is this sample currently playing? */
  playing: boolean
  /** Gain node for real-time volume control */
  gainNode: GainNode | null
  /** Source node for stopping */
  sourceNode: AudioBufferSourceNode | null
}

const STORAGE_KEY = 'nexus-mixer.soundbank'

/* ──────────────────── generate ID ──────────────────── */

let _counter = 0
export const uid = (): string => `snd-${Date.now().toString(36)}-${(++_counter).toString(36)}`

/* ──────────────────── default samples ──────────────────── */

export const PAD_COLORS = [
  '#f43f5e', '#ec4899', '#a855f7', '#6366f1',
  '#3b82f6', '#06b6d4', '#10b981', '#84cc16',
  '#eab308', '#f59e0b', '#f97316', '#ef4444',
]

/* ──────────────────── storage ──────────────────── */

export function loadSamples(): Omit<SoundSample, 'buffer'>[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveSamples(samples: Omit<SoundSample, 'buffer'>[]): void {
  try {
    // Don't store AudioBuffer in localStorage — it's not serializable
    const clean = samples.map((s: any) => { const { buffer: _, ...rest } = s; return rest })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch { /* ignore */ }
}

/* ──────────────────── decode audio ──────────────────── */

export async function decodeAudioFile(
  file: File,
  audioCtx: AudioContext,
): Promise<{ sample: Omit<SoundSample, 'buffer'>; buffer: AudioBuffer }> {
  const arrayBuffer = await file.arrayBuffer()
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)

  const sample: Omit<SoundSample, 'buffer'> = {
    id: uid(),
    name: file.name.replace(/\.[^/.]+$/, ''),
    size: file.size,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    targetStrip: '',
    targetBus: '',
    volume: 0.8,
    pan: 0,
    loop: false,
    pitchShift: 0,
    color: PAD_COLORS[Math.floor(Math.random() * PAD_COLORS.length)],
    addedAt: Date.now(),
  }

  return { sample, buffer: audioBuffer }
}

/* ──────────────────── play sample ──────────────────── */

export function playSample(
  audioCtx: AudioContext,
  buffer: AudioBuffer,
  destNode: AudioNode,
  params: {
    volume: number
    pan: number
    loop: boolean
    pitchShift: number
    startOffset?: number
  },
): { gainNode: GainNode; sourceNode: AudioBufferSourceNode } {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  source.loop = params.loop
  source.loopStart = 0
  source.loopEnd = buffer.duration

  // Pitch shift via detune (cents)
  source.detune.value = params.pitchShift * 100

  // Volume
  const gain = audioCtx.createGain()
  gain.gain.value = params.volume

  // Pan
  const panner = audioCtx.createStereoPanner()
  panner.pan.value = params.pan

  // Connect: source → gain → panner → destination
  source.connect(gain)
  gain.connect(panner)
  panner.connect(destNode)

  // Start playback
  source.start(0, params.startOffset ?? 0)

  return { gainNode: gain, sourceNode: source }
}
