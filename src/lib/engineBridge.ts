/**
 * Tauri ⇄ audio engine bridge.
 *
 * In the browser (`npm run dev`) every call resolves to `null`, so the UI falls
 * back to its simulated telemetry. Inside the desktop shell the same calls hit
 * the Rust commands declared in `src-tauri/src/lib.rs`.
 *
 * The wire format is the camelCase shape already used by `src/types.ts`; the
 * Rust models use `#[serde(rename_all = "camelCase")]` so no translation layer
 * is needed.
 */

import type {
  AiSettings,
  AiStatus,
  AudioDevice,
  Bus,
  BusId,
  EngineSettings,
  EngineStatus,
  EqBand,
  MeterLevels,
  MixerState,
  RecorderSettings,
  RecorderStatus,
  RuntimeInfo,
  Strip,
  StripId,
} from '../types'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let invokePromise: Promise<InvokeFn | null> | null = null
let lastErrorText: string | null = null

const errorText = (error: unknown): string => {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

async function getInvoke(): Promise<InvokeFn | null> {
  if (!isTauri) return null
  if (!invokePromise) {
    invokePromise = import('@tauri-apps/api/core')
      .then((mod) => mod.invoke as InvokeFn)
      .catch(() => null)
  }
  return invokePromise
}

export interface CallResult<T> {
  ok: boolean
  value: T | null
  error: string | null
}

/**
 * Every call carries its own error. Sharing one `lastErrorText` meant a
 * background poll could wipe the message before the caller read it.
 */
async function callResult<T>(cmd: string, args?: Record<string, unknown>): Promise<CallResult<T>> {
  const invoke = await getInvoke()
  if (!invoke) return { ok: false, value: null, error: 'desktop only' }
  try {
    return { ok: true, value: await invoke<T>(cmd, args), error: null }
  } catch (error) {
    const message = errorText(error)
    console.error(`[engineBridge] ${cmd} failed`, error)
    return { ok: false, value: null, error: message }
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const result = await callResult<T>(cmd, args)
  if (!result.ok) lastErrorText = result.error
  return result.value
}

/** Message from the most recent failed invoke, if any (kept for old callers). */
export function getLastEngineError(): string | null {
  return lastErrorText
}

/** Baked-in VCA result so the audio thread does not need to know about groups. */
export type SnapshotStrip = Strip & { vcaGainDb: number; vcaMute: boolean }

/** Everything the audio thread needs to render one block. */
export interface MixerSnapshot {
  strips: Record<StripId, SnapshotStrip>
  buses: Record<BusId, Bus>
  engine: EngineSettings
  recorder: RecorderSettings
  ai: AiSettings
  masterEq: EqBand[]
  masterEqEnabled: boolean
  masterGainDb: number
}

export function snapshotOf(state: MixerState): MixerSnapshot {
  const strips = Object.fromEntries(
    (Object.keys(state.strips) as StripId[]).map((id) => {
      const strip = state.strips[id]
      const group = state.vcaGroups.find((candidate) => candidate.strips.includes(id))
      return [id, { ...strip, vcaGainDb: group?.gainDb ?? 0, vcaMute: group?.mute ?? false }]
    }),
  ) as Record<StripId, SnapshotStrip>

  return {
    strips,
    buses: state.buses,
    engine: state.engine,
    recorder: state.recorder,
    ai: state.ai,
    // Disabled master bands are sent bypassed: the engine only sees the
    // effective state, while the UI remembers the user's curve.
    masterEq: state.masterEqEnabled
      ? state.masterEq
      : state.masterEq.map((band) => ({ ...band, enabled: false })),
    masterEqEnabled: state.masterEqEnabled,
    masterGainDb: state.masterGainDb,
  }
}

export const engineBridge = {
  /** True inside the Tauri webview, false in a plain browser. */
  available: isTauri,

  listDevices(): Promise<AudioDevice[] | null> {
    return call<AudioDevice[]>('list_audio_devices')
  },

  getStatus(): Promise<EngineStatus | null> {
    return call<EngineStatus>('get_engine_status')
  },

  setEngineConfig(engine: EngineSettings): Promise<EngineStatus | null> {
    return call<EngineStatus>('set_engine_config', { config: engine })
  },

  setMixerState(snapshot: MixerSnapshot): Promise<null> {
    return call<null>('set_mixer_state', { snapshot })
  },

  getMeterLevels(): Promise<MeterLevels | null> {
    return call<MeterLevels>('get_meter_levels')
  },

  getEngineInfo(): Promise<RuntimeInfo | null> {
    return call<RuntimeInfo>('get_engine_info')
  },

  getRecorderStatus(): Promise<RecorderStatus | null> {
    return call<RecorderStatus>('get_recorder_status')
  },

  renameVirtualCables(): Promise<string | null> {
    return call<string>('rename_virtual_cables')
  },

  start(): Promise<EngineStatus | null> {
    return call<EngineStatus>('start_engine')
  },

  stop(): Promise<EngineStatus | null> {
    return call<EngineStatus>('stop_engine')
  },

  /** Cached sidecar status; also embedded in `EngineStatus`. */
  getAiStatus(): Promise<AiStatus | null> {
    return call<AiStatus>('get_ai_status')
  },

  /**
   * Connect to the local sidecar. `config` is forwarded as a `configure`
   * message after the handshake (model, pitch, chunk size, …).
   */
  connectAi(config?: Record<string, unknown>): Promise<AiStatus | null> {
    return call<AiStatus>('connect_ai_sidecar', { config })
  },

  disconnectAi(): Promise<AiStatus | null> {
    return call<AiStatus>('disconnect_ai_sidecar')
  },

  pingAi(): Promise<AiStatus | null> {
    return call<AiStatus>('ping_ai_sidecar')
  },

  configureAi(config: Record<string, unknown>): Promise<AiStatus | null> {
    return call<AiStatus>('configure_ai_sidecar', { config })
  },

  /* ── sound pads: real audio goes through the mixer graph ── */

  /**
   * Upload decoded PCM (interleaved f32).
   *
   * The samples travel as base64 of the little-endian f32 bytes: a JSON array
   * of 480 000 floats would be ~9 MB of text and take hundreds of milliseconds
   * to format and parse, while the byte payload is ~2.5 MB and decodes in Rust
   * in a few milliseconds.
   */
  padLoad(id: string, sampleRate: number, channels: number, data: Float32Array): Promise<CallResult<null>> {
    return callResult<null>('pad_load', { id, sampleRate, channels, data: encodePcmBase64(data) })
  },

  padUnload(id: string): Promise<CallResult<null>> {
    return callResult<null>('pad_unload', { id })
  },

  padPlay(id: string, params: PadPlayParams): Promise<CallResult<null>> {
    return callResult<null>('pad_play', { id, params })
  },

  padUpdate(id: string, params: PadPlayParams): Promise<CallResult<null>> {
    return callResult<null>('pad_update', { id, params })
  },

  padStop(id: string): Promise<CallResult<null>> {
    return callResult<null>('pad_stop', { id })
  },

  padStopAll(): Promise<CallResult<null>> {
    return callResult<null>('pad_stop_all')
  },

  padLevels(): Promise<CallResult<Record<string, number>>> {
    return callResult<Record<string, number>>('pad_levels')
  },

  padLoaded(): Promise<CallResult<string[]>> {
    return callResult<string[]>('pad_loaded')
  },

  /** Method with its own error channel, for callers that must not guess. */
  callResult,
}

/** Base64 of the raw little-endian f32 bytes, built in chunks. */
function encodePcmBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** Parameters accepted by `pad_play` / `pad_update`. */
export interface PadPlayParams {
  volume: number
  pan: number
  loop: boolean
  pitch: number
  /** `master`, a strip id (`A2`) or a bus id (`B1`). */
  target: string
  /** Start delay in milliseconds, used by the sequencer for tight timing. */
  delayMs?: number
}
