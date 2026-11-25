/**
 * Nexus-Mixer — core domain model.
 *
 * The shape of this model is mirrored 1:1 by the Rust engine in `src-tauri`.
 * Anything the UI can change must be expressible as a plain JSON patch so the
 * Tauri bridge can forward it to the audio thread without custom serialization.
 */

export type Theme = 'studio' | 'dark' | 'light'

export type StripId = 'hw1' | 'hw2' | 'hw3' | 'hw4' | 'hw5' | 'hw6' | 'vaio' | 'aux'
export type BusId = 'A1' | 'A2' | 'A3' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7' | 'B8' | 'B9' | 'B10' | 'B11' | 'B12'
export type ChannelId = StripId | BusId
export type StripKind = 'hardware' | 'virtual'
export type BusKind = 'physical' | 'virtual'

export type EngineApi = 'wasapi-shared' | 'wasapi-exclusive' | 'asio' | 'wdm-ks'
export type AiMode = 'off' | 'dsp' | 'ai' | 'hybrid'

export type EqBandType = 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass'

export interface EqBand {
  id: string
  type: EqBandType
  /** Center / corner frequency in Hz. */
  freq: number
  /** Gain in dB, -24..+24. Ignored by highpass/lowpass. */
  gain: number
  /** Q / resonance, 0.1..18. */
  q: number
  enabled: boolean
}

export interface GateFx {
  enabled: boolean
  /** dBFS, -90..0 */
  threshold: number
  /** ms, 0.1..100 */
  attack: number
  /** ms, 0..500 */
  hold: number
  /** ms, 5..2000 */
  release: number
  /** Attenuation applied when closed, dB, -90..0 */
  range: number
}

export interface CompressorFx {
  enabled: boolean
  /** dBFS, -60..0 */
  threshold: number
  /** 1..20 */
  ratio: number
  /** ms, 0.1..250 */
  attack: number
  /** ms, 5..2000 */
  release: number
  /** dB, 0..24 */
  makeup: number
  /** dB, 0..24 */
  knee: number
}

export interface DeEsserFx {
  enabled: boolean
  /** Hz, 2000..12000 */
  frequency: number
  /** dBFS, -60..0 */
  threshold: number
  /** 0..100 % */
  amount: number
}

export interface SaturatorFx {
  enabled: boolean
  /** 0..100 % */
  drive: number
  /** 0..100 % */
  mix: number
  /** -100..100 % (dark ↔ bright) */
  tone: number
}

export interface StripFx {
  gate: GateFx
  compressor: CompressorFx
  eq: EqBand[]
  deesser: DeEsserFx
  saturator: SaturatorFx
}

export interface LimiterFx {
  enabled: boolean
  /** dBFS, -12..0 */
  ceiling: number
  /** ms, 5..1000 */
  release: number
}

export interface BusFx {
  eq: EqBand[]
  limiter: LimiterFx
  /** Bus delay for speaker alignment, ms, 0..500 */
  delayMs: number
  /** Stereo width, 0..200 % */
  width: number
}

export interface Route {
  on: boolean
  /** Send level in dB, -60..+12. */
  levelDb: number
}

export type Routing = Record<BusId, Route>

export interface Strip {
  id: StripId
  kind: StripKind
  name: string
  /** WASAPI / ASIO endpoint id. Empty means "not assigned". */
  deviceId: string
  color: string
  /** Input gain, dB, -60..+12. */
  gainDb: number
  /** -1..1 */
  pan: number
  mute: boolean
  solo: boolean
  cue: boolean
  mono: boolean
  /** Invert phase 180°. */
  phase: boolean
  /** 48V phantom power (only meaningful for hardware inputs). */
  phantom: boolean
  /** -20..+20 dB, tilt of the AI/DSP voice stage. */
  voiceTiltDb: number
  routing: Routing
  fx: StripFx
  /** Selected AI preset for this strip, if any. */
  aiPresetId: string | null
}

export interface Bus {
  id: BusId
  kind: BusKind
  name: string
  deviceId: string
  color: string
  /** Output gain, dB, -60..+12. */
  gainDb: number
  mute: boolean
  mono: boolean
  /** Dim -20 dB. */
  dim: boolean
  fx: BusFx
}

export interface AudioDevice {
  id: string
  name: string
  kind: 'input' | 'output' | 'virtual-playback' | 'virtual-capture'
  api: EngineApi
  channels: number
  sampleRate: number
  isDefault: boolean
  online: boolean
}

export interface EngineSettings {
  api: EngineApi
  sampleRate: 44100 | 48000 | 88200 | 96000 | 192000
  /** Frames per callback. */
  bufferSize: 64 | 128 | 256 | 512 | 1024 | 2048
  /** Preferred channel layout for virtual buses. */
  virtualChannels: 2 | 6 | 8
  /** Dropout protection: extra buffering in ms. */
  safetyMs: number
  /** Lock engine clock to the first output device. */
  clockMaster: BusId
  /** Follow Windows default device changes automatically. */
  followDefaultDevices: boolean
  /** Keep engine running when the window is hidden. */
  runInTray: boolean
  /** Start engine with Windows. */
  startWithWindows: boolean
}

export interface RecorderSettings {
  enabled: boolean
  /** Output folder, empty = Music/Nexus-Mixer. */
  directory: string
  format: 'wav' | 'flac' | 'mp3'
  bitDepth: 16 | 24 | 32
  /** Which buses to record. */
  buses: BusId[]
  /** Split into files every N minutes, 0 = single file. */
  splitMinutes: number
}

export interface AiSettings {
  enabled: boolean
  mode: AiMode
  /** Input channel the voice stage listens to. */
  source: StripId
  /** Use the built-in DSP voice engine (no Python sidecar required). */
  local: boolean
  /** Ring-modulate the wet voice for the robot preset. */
  robot: boolean
  /** RVC model id from the model library. */
  modelId: string
  /** Semitones, -24..+24. */
  pitch: number
  /** RVC index rate, 0..1. */
  indexRate: number
  /** Formant shift, -12..+12. */
  formant: number
  /** Processing chunk in ms, lower = less latency, more artifacts. */
  chunkMs: 40 | 80 | 120 | 160 | 240 | 320
  /** Extra context frames to reduce boundary artifacts. */
  extraContext: number
  /** Crossfade between chunks, ms. */
  crossfadeMs: number
  /** GPU device, -1 = CPU. */
  gpuIndex: number
  /** Denoise the dry signal before conversion. */
  denoise: boolean
  /** Blend dry/wet, 0..100 %. */
  mix: number
  /** Bypass conversion when input is below this level (dBFS). */
  gateDb: number
}

export interface AiVoiceModel {
  id: string
  name: string
  author: string
  language: string
  /** Sample rate the model was trained at. */
  sampleRate: number
  sizeMb: number
  installed: boolean
  /** Rough realtime factor on the current machine (>1 = faster than realtime). */
  rtf: number
  tags: string[]
}

export interface Preset {
  id: string
  name: string
  category: 'voice' | 'music' | 'broadcast' | 'fx' | 'ai' | 'custom'
  description: string
  /** Partial strip FX applied on top of the current values. */
  fx: Partial<StripFx>
  ai?: Partial<AiSettings>
  builtin: boolean
}

export interface MacroAction {
  type: 'mute' | 'route' | 'preset' | 'ai' | 'gain' | 'panic'
  target?: StripId
  bus?: BusId
  value?: number | boolean | string
}

export interface Macro {
  id: string
  label: string
  color: string
  /** Keyboard shortcut, e.g. "Ctrl+Shift+1". */
  shortcut: string
  action: MacroAction
  momentary: boolean
}

export interface VcaGroup {
  id: string
  name: string
  color: string
  /** Strip IDs assigned to this group */
  strips: StripId[]
  /** Master gain in dB, -60..+12 */
  gainDb: number
  mute: boolean
}

export interface DriverStatus {
  installed: boolean
  version: string | null
  signed: boolean
  testMode: boolean
  endpoints: number
  /** Names of individual cable endpoints detected, e.g. ["CABLE Input (VB-Audio Virtual Cable)"] */
  cableEndpoints: string[]
  message: string
}

/** Control-plane state of the local Voice AI sidecar. */
export type AiState = 'offline' | 'loading' | 'ready' | 'error'

export interface AiStatus {
  state: AiState
  /** Backend reported by the sidecar: `passthrough`, `onnx`, … */
  backend: string
  model: string | null
  sampleRate: number
  chunkFrames: number
  /** Realtime factor reported by the sidecar (>1 = faster than realtime). */
  rtf: number
  /** `host:port` the client is connected (or trying to connect) to. */
  endpoint: string
  message: string
  /** Measured ping round-trip, null until the link has been probed. */
  roundtripMs: number | null
}

export interface EngineStatus {
  running: boolean
  api: EngineApi
  sampleRate: number
  bufferSize: number
  latencyMs: number
  cpuPercent: number
  xruns: number
  /** Frames rendered by the master callback; watchdog for the UI. */
  frames: number
  driver: DriverStatus
  /** Convenience mirrors of `ai.state` / `ai.backend`. */
  aiStatus: AiState
  aiBackend: string
  ai: AiStatus
}

/** Non-fatal details returned by `get_engine_info` while streams are live. */
export interface RuntimeInfo {
  sampleRate: number
  bufferSize: number
  inputStreams: number
  outputStreams: number
  warnings: string[]
}

/** Peak levels in dBFS, indexed like `STRIP_ORDER` / `BUS_ORDER`. */
export interface MeterLevels {
  strips: number[]
  buses: number[]
}

/** Live WAV recorder state from `get_recorder_status`. */
export interface RecorderStatus {
  recording: boolean
  file: string | null
  seconds: number
  droppedFrames: number
  /** Last start/write error. Survives settings edits until a start succeeds. */
  error: string | null
  /** Take notice: a stable code (`splitBySize`) or a backend message. */
  notice: string | null
  /** Buses of the take in progress, empty while no file is open. */
  buses: BusId[]
  /** Bit depth of the take in progress, 0 while no file is open. */
  bitDepth: number
  /** Settings were changed mid-take and apply to the next session. */
  pendingChanges: boolean
}

export interface MixerState {
  strips: Record<StripId, Strip>
  buses: Record<BusId, Bus>
  devices: AudioDevice[]
  status: EngineStatus
  /** Live WASAPI graph details; null until the engine reports them. */
  runtimeInfo: RuntimeInfo | null
  /** Live recorder telemetry; null while the engine is stopped. */
  recorderStatus: RecorderStatus | null
  engine: EngineSettings
  recorder: RecorderSettings
  ai: AiSettings
  aiModels: AiVoiceModel[]
  presets: Preset[]
  macros: Macro[]
  vcaGroups: VcaGroup[]
  /** Master-bus EQ applied to every output after its own processing. */
  masterEq: EqBand[]
  masterEqEnabled: boolean
  /** Global output trim, dB. */
  masterGainDb: number
  theme: Theme
  /** Number of source cards visible on the console (5..8). */
  sourceCount: number
  selectedStripId: StripId
  selectedBusId: BusId
  selectionKind: 'strip' | 'bus'
  rackTab: 'fx' | 'ai' | 'macros' | 'record' | 'sound' | 'groups'
  matrixOpen: boolean
  settingsOpen: boolean
  /** null = auto (follow selected strip) */
  soloActive: boolean
  /** True when any strip has cue enabled. */
  cueActive: boolean
  multiSelectedStripIds: StripId[]
}
