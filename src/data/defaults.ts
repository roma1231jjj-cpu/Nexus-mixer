import type {
  AiSettings,
  AiVoiceModel,
  AudioDevice,
  BusId,
  Bus,
  BusFx,
  CompressorFx,
  DeEsserFx,
  EngineSettings,
  EngineStatus,
  EqBand,
  GateFx,
  Macro,
  MixerState,
  Preset,
  RecorderSettings,
  Routing,
  SaturatorFx,
  Strip,
  StripFx,
  StripId,
  Theme,
  VcaGroup,
} from '../types'
import { t } from '../i18n'

export const STRIP_ORDER: StripId[] = ['hw1', 'hw2', 'hw3', 'vaio', 'aux', 'hw4', 'hw5', 'hw6']
export const BUS_ORDER: BusId[] = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12']
export const THEME_STORAGE_KEY = 'nexus-mixer.theme'

export const makeGate = (over: Partial<GateFx> = {}): GateFx => ({
  enabled: false,
  threshold: -48,
  attack: 5,
  hold: 80,
  release: 220,
  range: -60,
  ...over,
})

export const makeCompressor = (over: Partial<CompressorFx> = {}): CompressorFx => ({
  enabled: false,
  threshold: -18,
  ratio: 3,
  attack: 12,
  release: 180,
  makeup: 3,
  knee: 6,
  ...over,
})

export const makeDeEsser = (over: Partial<DeEsserFx> = {}): DeEsserFx => ({
  enabled: false,
  frequency: 6500,
  threshold: -30,
  amount: 45,
  ...over,
})

export const makeSaturator = (over: Partial<SaturatorFx> = {}): SaturatorFx => ({
  enabled: false,
  drive: 22,
  mix: 30,
  tone: 0,
  ...over,
})

/** 10-band parametric EQ, the default voice-shaping tool of Nexus-Mixer. */
export const makeEq = (): EqBand[] => [
  { id: 'eq-0', type: 'highpass', freq: 60, gain: 0, q: 0.7, enabled: false },
  { id: 'eq-1', type: 'lowshelf', freq: 120, gain: 0, q: 0.8, enabled: true },
  { id: 'eq-2', type: 'peaking', freq: 250, gain: 0, q: 1.1, enabled: true },
  { id: 'eq-3', type: 'peaking', freq: 500, gain: 0, q: 1.1, enabled: true },
  { id: 'eq-4', type: 'peaking', freq: 1000, gain: 0, q: 1.1, enabled: true },
  { id: 'eq-5', type: 'peaking', freq: 2200, gain: 0, q: 1.2, enabled: true },
  { id: 'eq-6', type: 'peaking', freq: 4000, gain: 0, q: 1.2, enabled: true },
  { id: 'eq-7', type: 'peaking', freq: 6500, gain: 0, q: 1.2, enabled: true },
  { id: 'eq-8', type: 'peaking', freq: 10000, gain: 0, q: 1.1, enabled: true },
  { id: 'eq-9', type: 'highshelf', freq: 14000, gain: 0, q: 0.7, enabled: true },
]

/** Master EQ shipped flat so enabling it never changes the sound by default. */
export const makeMasterEq = (): EqBand[] => makeEq().map((band) => ({ ...band, id: band.id.replace('eq-', 'master-') }))

export const makeStripFx = (over: Partial<StripFx> = {}): StripFx => ({
  gate: makeGate(),
  compressor: makeCompressor(),
  eq: makeEq(),
  deesser: makeDeEsser(),
  saturator: makeSaturator(),
  ...over,
})

/** Warm, soft voice chain for budget condensers: tame boom, boxiness and sibilance. */
export const makeVelvetVoiceFx = (): StripFx => {
  const eq: EqBand[] = [
    // 150 Hz keeps the USB condenser's strong mains hum and its harmonics
    // below the voice band; the narrow notches clean up what remains.
    { id: 'eq-0', type: 'highpass', freq: 150, gain: 0, q: 0.7, enabled: true },
    { id: 'eq-1', type: 'peaking', freq: 120, gain: -24, q: 6, enabled: true },
    { id: 'eq-2', type: 'peaking', freq: 240, gain: -18, q: 6, enabled: true },
    { id: 'eq-3', type: 'peaking', freq: 360, gain: -14, q: 8, enabled: true },
    { id: 'eq-4', type: 'lowshelf', freq: 200, gain: 2.5, q: 0.8, enabled: true },
    { id: 'eq-5', type: 'peaking', freq: 2600, gain: 0.8, q: 1.2, enabled: true },
    { id: 'eq-6', type: 'peaking', freq: 4200, gain: -1.2, q: 1.4, enabled: true },
    { id: 'eq-7', type: 'peaking', freq: 6800, gain: -2, q: 1.4, enabled: true },
    { id: 'eq-8', type: 'peaking', freq: 1260, gain: -18, q: 10, enabled: true },
    { id: 'eq-9', type: 'highshelf', freq: 14000, gain: -1.5, q: 0.7, enabled: true },
  ]
  return makeStripFx({
    gate: makeGate({ enabled: true, threshold: -42, attack: 6, hold: 140, release: 360, range: -60 }),
    compressor: makeCompressor({ enabled: true, threshold: -24, ratio: 2.5, attack: 18, release: 180, makeup: 5, knee: 12 }),
    deesser: makeDeEsser({ enabled: true, frequency: 6800, threshold: -32, amount: 45 }),
    saturator: makeSaturator({ enabled: true, drive: 16, mix: 16, tone: -12 }),
    eq,
  })
}

export const makeBusFx = (over: Partial<BusFx> = {}): BusFx => ({
  eq: makeEq(),
  limiter: { enabled: false, ceiling: -1, release: 80 },
  delayMs: 0,
  width: 100,
  ...over,
})

const defaultRouting = (id: StripId): Routing => {
  const r: Routing = {} as Routing
  for (const bus of BUS_ORDER) {
    r[bus] = { on: false, levelDb: 0 }
  }
  // Default routes for the common scenarios
  if (id === 'hw1') r['A1'] = { on: true, levelDb: 0 }        // microphone -> headphones
  if (id === 'hw2') r['A1'] = { on: true, levelDb: 0 }        // music -> headphones
  if (id === 'vaio') r['B1'] = { on: true, levelDb: 0 }        // system -> Discord
  if (id === 'hw3') { r['A1'] = { on: false, levelDb: 0 }; r['B1'] = { on: true, levelDb: 0 } } // browser -> Discord
  if (id === 'aux') { r['A1'] = { on: true, levelDb: 0 }; r['B1'] = { on: true, levelDb: 0 } }  // game -> everywhere
  return r
}

const makeStrip = (id: StripId, patch: Partial<Strip>): Strip => ({
  id,
  kind: id.startsWith('hw') ? 'hardware' : 'virtual',
  name: id,
  deviceId: '',
  color: '#a78bfa',
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  cue: false,
  mono: false,
  phase: false,
  phantom: false,
  voiceTiltDb: 0,
  routing: defaultRouting(id),
  fx: makeStripFx(),
  aiPresetId: null,
  ...patch,
})

export const makeStrips = (): Record<StripId, Strip> => ({
  hw1: makeStrip('hw1', {
    name: t('data.strip.mic'),
    deviceId: 'in:mic-usb',
    color: '#c8a15a',
    fx: makeVelvetVoiceFx(),
  }),
  hw2: makeStrip('hw2', {
    name: t('data.strip.music'),
    deviceId: 'in:line',
    color: '#b98a72',
  }),
  hw3: makeStrip('hw3', {
    name: t('data.strip.browser'),
    deviceId: '',
    color: '#7f97a8',
  }),
  hw4: makeStrip('hw4', {
    name: t('data.strip.in6'),
    deviceId: '',
    color: '#a9b48d',
  }),
  hw5: makeStrip('hw5', {
    name: t('data.strip.in7'),
    deviceId: '',
    color: '#b98b73',
  }),
  hw6: makeStrip('hw6', {
    name: t('data.strip.in8'),
    deviceId: '',
    color: '#a497b0',
  }),
  vaio: makeStrip('vaio', {
    name: t('data.strip.system'),
    deviceId: 'in:vaio-out',
    color: '#8f9a7a',
  }),
  aux: makeStrip('aux', {
    name: t('data.strip.game'),
    deviceId: 'in:aux-out',
    color: '#a98fa0',
  }),
})

const makeBus = (id: BusId, patch: Partial<Bus>): Bus => ({
  id,
  kind: id.startsWith('A') ? 'physical' : 'virtual',
  name: id,
  deviceId: '',
  color: '#a78bfa',
  gainDb: 0,
  mute: false,
  mono: false,
  dim: false,
  fx: makeBusFx(),
  ...patch,
})

export const makeBuses = (): Record<BusId, Bus> => {
  const busDefs: Partial<Record<BusId, Partial<Bus>>> = {
    A1: { name: t('data.bus.hp1'), deviceId: 'out:speakers', color: '#c8a15a' },
    A2: { name: t('data.bus.hp2'), deviceId: '', color: '#8f9a7a' },
    A3: { name: t('data.bus.speakers'), deviceId: '', color: '#7f97a8' },
    B1: { name: t('data.bus.stream'), deviceId: 'out:vaio', color: '#b98a72', fx: makeBusFx({ width: 100 }) },
    B2: { name: t('data.bus.cable2'), deviceId: 'out:aux', color: '#7f97a8' },
    B3: { name: t('data.bus.cable3'), color: '#8f9a7a' },
    B4: { name: t('data.bus.cable4'), color: '#a98fa0' },
    B5: { name: t('data.bus.cable5'), color: '#c8a15a' },
    B6: { name: t('data.bus.cable6'), color: '#b98a72' },
    B7: { name: t('data.bus.cable7'), color: '#7f97a8' },
    B8: { name: t('data.bus.cable8'), color: '#8f9a7a' },
    B9: { name: t('data.bus.cable9'), color: '#a98fa0' },
    B10: { name: t('data.bus.cable10'), color: '#c8a15a' },
    B11: { name: t('data.bus.cable11'), color: '#b98a72' },
    B12: { name: t('data.bus.cable12'), color: '#7f97a8' },
  }
  const result = {} as Record<BusId, Bus>
  for (const id of BUS_ORDER) {
    const patch = busDefs[id] ?? {}
    const bus = makeBus(id, patch)
    // B3+ without a deviceId stays inactive until a cable appears
    bus.deviceId = id.startsWith('B') && parseInt(id.slice(1)) >= 3 ? '' : patch.deviceId ?? ''
    result[id] = bus
  }
  return result
}

export const makeDevices = (): AudioDevice[] => [
  {
    id: 'in:mic-usb',
    name: 'Microphone (Nexus USB Audio)',
    kind: 'input',
    api: 'wasapi-shared',
    channels: 2,
    sampleRate: 48000,
    isDefault: true,
    online: true,
  },
  {
    id: 'in:line',
    name: 'Line In (Realtek HD Audio)',
    kind: 'input',
    api: 'wasapi-shared',
    channels: 2,
    sampleRate: 48000,
    isDefault: false,
    online: true,
  },
  {
    id: 'in:vaio-out',
    name: 'CABLE Output (VB-Audio Virtual Cable)',
    kind: 'virtual-capture',
    api: 'wasapi-shared',
    channels: 2,
    sampleRate: 48000,
    isDefault: false,
    online: true,
  },
  {
    id: 'in:aux-out',
    name: 'CABLE Output 16ch (VB-Audio Virtual Cable)',
    kind: 'virtual-capture',
    api: 'wasapi-shared',
    channels: 16,
    sampleRate: 48000,
    isDefault: false,
    online: true,
  },
  {
    id: 'out:speakers',
    name: 'Speakers (Realtek HD Audio)',
    kind: 'output',
    api: 'wasapi-shared',
    channels: 2,
    sampleRate: 48000,
    isDefault: true,
    online: true,
  },
  {
    id: 'out:headphones',
    name: 'Headphones (Nexus USB Audio)',
    kind: 'output',
    api: 'wasapi-shared',
    channels: 2,
    sampleRate: 48000,
    isDefault: false,
    online: true,
  },
  {
    id: 'out:vaio',
    name: 'CABLE Input (VB-Audio Virtual Cable)',
    kind: 'virtual-playback',
    api: 'wasapi-shared',
    channels: 2,
    sampleRate: 48000,
    isDefault: false,
    online: true,
  },
  {
    id: 'out:aux',
    name: 'CABLE In 16ch (VB-Audio Virtual Cable)',
    kind: 'virtual-playback',
    api: 'wasapi-shared',
    channels: 16,
    sampleRate: 48000,
    isDefault: false,
    online: true,
  },
]

export const defaultEngine: EngineSettings = {
  api: 'wasapi-shared',
  sampleRate: 48000,
  bufferSize: 256,
  virtualChannels: 8,
  safetyMs: 4,
  clockMaster: 'A1',
  followDefaultDevices: false,
  runInTray: true,
  startWithWindows: false,
}

export const defaultRecorder: RecorderSettings = {
  enabled: false,
  directory: '',
  format: 'wav',
  bitDepth: 24,
  buses: ['A1'],
  splitMinutes: 0,
}

export const defaultAi: AiSettings = {
  enabled: false,
  mode: 'dsp',
  source: 'hw1',
  local: false,
  robot: false,
  modelId: 'rvc-aria',
  pitch: 0,
  indexRate: 0.75,
  formant: 0,
  chunkMs: 120,
  extraContext: 2,
  crossfadeMs: 40,
  gpuIndex: 0,
  denoise: true,
  mix: 100,
  gateDb: -55,
}

export const makeAiModels = (): AiVoiceModel[] => [
  {
    id: 'rvc-aria',
    name: 'Aria — Bright Female',
    author: t('data.author.labs'),
    language: 'RU / EN',
    sampleRate: 40000,
    sizeMb: 184,
    installed: true,
    rtf: 0.42,
    tags: ['female', 'stream', 'bright'],
  },
  {
    id: 'rvc-narrator',
    name: 'Narrator — Deep Male',
    author: t('data.author.labs'),
    language: 'RU / EN',
    sampleRate: 40000,
    sizeMb: 196,
    installed: true,
    rtf: 0.38,
    tags: ['male', 'podcast', 'warm'],
  },
  {
    id: 'rvc-radio',
    name: 'Radio Host — FM',
    author: 'Community',
    language: 'RU',
    sampleRate: 40000,
    sizeMb: 172,
    installed: false,
    rtf: 0.51,
    tags: ['male', 'broadcast'],
  },
  {
    id: 'rvc-anime',
    name: 'Anime — Soft',
    author: 'Community',
    language: 'JP / EN',
    sampleRate: 40000,
    sizeMb: 168,
    installed: false,
    rtf: 0.47,
    tags: ['female', 'anime', 'soft'],
  },
]

export const makePresets = (): Preset[] => [
  {
    id: 'flat',
    name: 'Flat / Neutral',
    category: 'voice',
    description: t('data.preset.flat.desc'),
    fx: {
      gate: makeGate(),
      compressor: makeCompressor(),
      deesser: makeDeEsser(),
      saturator: makeSaturator(),
      eq: makeEq(),
    },
    builtin: true,
  },
  {
    id: 'velvet',
    name: t('data.preset.velvet.name'),
    category: 'voice',
    description: t('data.preset.velvet.desc'),
    fx: makeVelvetVoiceFx(),
    builtin: true,
  },
  {
    id: 'streamer',
    name: 'Streamer',
    category: 'voice',
    description: t('data.preset.streamer.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -50, range: -65 }),
      compressor: makeCompressor({ enabled: true, threshold: -22, ratio: 4, attack: 6, release: 140, makeup: 5 }),
      deesser: makeDeEsser({ enabled: true, frequency: 6800, amount: 55 }),
      saturator: makeSaturator({ enabled: true, drive: 18, mix: 22 }),
      eq: makeEq().map((b) => {
        if (b.freq === 120) return { ...b, gain: -2 }
        if (b.freq === 250) return { ...b, gain: -3 }
        if (b.freq === 2200) return { ...b, gain: 2.5 }
        if (b.freq === 4000) return { ...b, gain: 3 }
        if (b.freq === 6500) return { ...b, gain: 1.5 }
        if (b.freq === 10000) return { ...b, gain: 1 }
        return b
      }),
    },
    builtin: true,
  },
  {
    id: 'podcast',
    name: 'Podcast',
    category: 'broadcast',
    description: t('data.preset.podcast.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -55, attack: 10, release: 280, range: -60 }),
      compressor: makeCompressor({ enabled: true, threshold: -24, ratio: 3, attack: 20, release: 240, makeup: 6, knee: 10 }),
      deesser: makeDeEsser({ enabled: true, frequency: 6200, amount: 40 }),
      saturator: makeSaturator({ enabled: true, drive: 12, mix: 18, tone: -20 }),
      eq: makeEq().map((b) => {
        if (b.type === 'highpass') return { ...b, enabled: true, freq: 75 }
        if (b.freq === 120) return { ...b, gain: 2.5 }
        if (b.freq === 250) return { ...b, gain: -1.5 }
        if (b.freq === 4000) return { ...b, gain: -1.5 }
        if (b.freq === 10000) return { ...b, gain: 1.5 }
        return b
      }),
    },
    builtin: true,
  },
  {
    id: 'broadcast',
    name: 'Broadcast FM',
    category: 'broadcast',
    description: t('data.preset.broadcast.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -46, range: -70 }),
      compressor: makeCompressor({ enabled: true, threshold: -30, ratio: 8, attack: 3, release: 90, makeup: 9, knee: 2 }),
      deesser: makeDeEsser({ enabled: true, frequency: 7200, amount: 70 }),
      saturator: makeSaturator({ enabled: true, drive: 45, mix: 40, tone: 10 }),
      eq: makeEq().map((b) => {
        if (b.freq === 250) return { ...b, gain: -4 }
        if (b.freq === 1000) return { ...b, gain: 1.5 }
        if (b.freq === 4000) return { ...b, gain: 4 }
        if (b.freq === 10000) return { ...b, gain: 2 }
        return b
      }),
    },
    builtin: true,
  },
  {
    id: 'whisper',
    name: 'Whisper / ASMR',
    category: 'voice',
    description: t('data.preset.whisper.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -62, attack: 25, release: 400, range: -55 }),
      compressor: makeCompressor({ enabled: true, threshold: -40, ratio: 5, attack: 30, release: 400, makeup: 14, knee: 12 }),
      deesser: makeDeEsser({ enabled: true, frequency: 7800, amount: 35 }),
      saturator: makeSaturator(),
      eq: makeEq().map((b) => (b.freq === 250 ? { ...b, gain: 2 } : b)),
    },
    builtin: true,
  },
  {
    id: 'phone',
    name: 'Phone / Lo-Fi',
    category: 'fx',
    description: t('data.preset.phone.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -50 }),
      compressor: makeCompressor({ enabled: true, threshold: -26, ratio: 6, attack: 5, release: 120, makeup: 8 }),
      deesser: makeDeEsser(),
      saturator: makeSaturator({ enabled: true, drive: 55, mix: 65, tone: 30 }),
      eq: makeEq().map((b) => {
        if (b.freq <= 250) return { ...b, gain: -24, enabled: true }
        if (b.freq >= 6500) return { ...b, gain: -24, enabled: true }
        if (b.freq === 1000) return { ...b, gain: 4 }
        if (b.freq === 2200) return { ...b, gain: 3 }
        return b
      }),
    },
    builtin: true,
  },
  {
    id: 'robot',
    name: 'Robot / FX',
    category: 'fx',
    description: t('data.preset.robot.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -55 }),
      compressor: makeCompressor({ enabled: true, threshold: -28, ratio: 10, attack: 2, release: 60, makeup: 10 }),
      deesser: makeDeEsser({ enabled: true, frequency: 8000, amount: 20 }),
      saturator: makeSaturator({ enabled: true, drive: 90, mix: 85, tone: 60 }),
      eq: makeEq().map((b) => (b.freq === 2200 || b.freq === 4000 ? { ...b, gain: 6 } : b)),
    },
    builtin: true,
  },
  {
    id: 'ai-aria',
    name: 'AI · Aria',
    category: 'ai',
    description: t('data.preset.aiaria.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -52 }),
      compressor: makeCompressor({ enabled: true, threshold: -24, ratio: 4, makeup: 5 }),
      deesser: makeDeEsser({ enabled: true, frequency: 7000, amount: 50 }),
      eq: makeEq(),
      saturator: makeSaturator(),
    },
    ai: { enabled: true, mode: 'hybrid', modelId: 'rvc-aria', mix: 100, chunkMs: 120 },
    builtin: true,
  },
  {
    id: 'ai-narrator',
    name: 'AI · Narrator',
    category: 'ai',
    description: t('data.preset.ainarrator.desc'),
    fx: {
      gate: makeGate({ enabled: true, threshold: -55 }),
      compressor: makeCompressor({ enabled: true, threshold: -26, ratio: 3, makeup: 6 }),
      deesser: makeDeEsser({ enabled: true, frequency: 6200, amount: 35 }),
      eq: makeEq(),
      saturator: makeSaturator({ enabled: true, drive: 10, mix: 12 }),
    },
    ai: { enabled: true, mode: 'ai', modelId: 'rvc-narrator', pitch: -2, chunkMs: 160 },
    builtin: true,
  },
]

export const makeMacros = (): Macro[] => [
  {
    id: 'macro-mute-all',
    label: 'MUTE ALL',
    color: '#f43f5e',
    shortcut: 'Ctrl+Shift+M',
    action: { type: 'panic' },
    momentary: false,
  },
  {
    id: 'macro-preset-streamer',
    label: 'STREAMER',
    color: '#a78bfa',
    shortcut: 'Ctrl+Shift+1',
    action: { type: 'preset', value: 'streamer' },
    momentary: false,
  },
  {
    id: 'macro-ai-toggle',
    label: 'AI VOICE',
    color: '#22d3ee',
    shortcut: 'Ctrl+Shift+A',
    action: { type: 'ai', value: 'toggle' },
    momentary: false,
  },
  {
    id: 'macro-b1',
    label: 'ROUTE B1',
    color: '#f472b6',
    shortcut: 'Ctrl+Shift+B',
    action: { type: 'route', target: 'vaio', bus: 'B1', value: true },
    momentary: false,
  },
]

export const initialEngineStatus: EngineStatus = {
  running: true,
  api: 'wasapi-shared',
  sampleRate: 48000,
  bufferSize: 256,
  latencyMs: 10.7,
  cpuPercent: 6.4,
  xruns: 0,
  frames: 0,
  driver: {
    installed: false,
    version: null,
    signed: false,
    testMode: false,
    endpoints: 0,
    cableEndpoints: [],
    message: t('data.engine.noCable'),
  },
  aiStatus: 'offline',
  aiBackend: 'Nexus AI sidecar',
  ai: {
    state: 'offline',
    backend: 'Nexus AI sidecar',
    model: null,
    sampleRate: 48000,
    chunkFrames: 7680,
    rtf: 1,
    endpoint: '127.0.0.1:47600',
    message: t('data.engine.sidecarOffline'),
    roundtripMs: null,
  },
}

export const makeVcaGroups = (): VcaGroup[] => [
  { id: 'vca-1', name: 'DRUMS', color: '#f43f5e', strips: [], gainDb: 0, mute: false },
  { id: 'vca-2', name: 'VOCALS', color: '#a78bfa', strips: [], gainDb: 0, mute: false },
]

export const makeInitialState = (): Omit<MixerState, 'theme'> & { theme: Theme } => ({
  strips: makeStrips(),
  buses: makeBuses(),
  devices: makeDevices(),
  status: initialEngineStatus,
  runtimeInfo: null,
  recorderStatus: null,
  engine: defaultEngine,
  recorder: defaultRecorder,
  ai: defaultAi,
  aiModels: makeAiModels(),
  presets: makePresets(),
  macros: makeMacros(),
  vcaGroups: makeVcaGroups(),
  masterEq: makeMasterEq(),
  masterEqEnabled: false,
  masterGainDb: 0,
  theme: 'dark',
  sourceCount: 5,
  selectedStripId: 'hw1',
  selectedBusId: 'A1',
  selectionKind: 'strip',
  rackTab: 'fx',
  matrixOpen: false,
  settingsOpen: false,
  soloActive: false,
  cueActive: false,
  multiSelectedStripIds: [] as StripId[],
})
