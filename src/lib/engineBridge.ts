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

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const invoke = await getInvoke()
  if (!invoke) return null
  lastErrorText = null
  try {
    return await invoke<T>(cmd, args)
  } catch (error) {
    lastErrorText = errorText(error)
    console.error(`[engineBridge] ${cmd} failed`, error)
    return null
  }
}

/** Message from the most recent failed invoke, if any. */
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
}
