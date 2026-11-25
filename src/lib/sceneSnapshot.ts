/**
 * Scene Snapshots — save & load full mixer state (all strips, buses, FX, routing)
 */

import type { AiSettings, Bus, BusFx, EngineSettings, EqBand, Strip, StripFx, VcaGroup } from '../types'
import { STRIP_ORDER, BUS_ORDER } from '../data/defaults'
import type { MixerStore } from '../store/useMixer'

/* ──────────────────── types ──────────────────── */

export interface SceneSnapshot {
  id: string
  name: string
  /** ISO timestamp */
  savedAt: string
  strips: Record<string, {
    gainDb: number
    pan: number
    mute: boolean
    solo: boolean
    mono: boolean
    phase: boolean
    voiceTiltDb: number
    fx: StripFx
    routing: Record<string, { on: boolean; levelDb: number }>
    /** Optional for snapshots created before cue/phantom/preset capture. */
    cue?: boolean
    phantom?: boolean
    aiPresetId?: string | null
  }>
  buses: Record<string, { gainDb: number; mute: boolean; mono: boolean; dim: boolean; fx: BusFx }>
  /** Optional for snapshots created before the master section existed. */
  masterEq?: EqBand[]
  masterEqEnabled?: boolean
  masterGainDb?: number
  vcaGroups?: VcaGroup[]
  /** Optional for snapshots created before devices/names/engine were captured. */
  names?: { strips: Record<string, string>; buses: Record<string, string> }
  devices?: { strips: Record<string, string>; buses: Record<string, string> }
  engine?: EngineSettings
  ai?: AiSettings
}

export type SceneStore = SceneSnapshot[]

const STORAGE_KEY = 'nexus-mixer.scenes'

/* ──────────────────── capture ──────────────────── */

export function captureSnapshot(name: string, state: MixerStore): SceneSnapshot {
  const strips: SceneSnapshot['strips'] = {} as SceneSnapshot['strips']
  for (const id of STRIP_ORDER) {
    const s = state.strips[id]
    strips[id] = {
      gainDb: s.gainDb,
      pan: s.pan,
      mute: s.mute,
      solo: s.solo,
      mono: s.mono,
      phase: s.phase,
      voiceTiltDb: s.voiceTiltDb,
      fx: structuredClone(s.fx),
      routing: structuredClone(s.routing) as SceneSnapshot['strips'][string]['routing'],
      cue: s.cue,
      phantom: s.phantom,
      aiPresetId: s.aiPresetId,
    }
  }

  const buses: SceneSnapshot['buses'] = {} as SceneSnapshot['buses']
  for (const id of BUS_ORDER) {
    const b = state.buses[id]
    buses[id] = {
      gainDb: b.gainDb,
      mute: b.mute,
      mono: b.mono,
      dim: b.dim,
      fx: structuredClone(b.fx),
    }
  }

  const stripNames: Record<string, string> = {}
  const stripDevices: Record<string, string> = {}
  for (const id of STRIP_ORDER) {
    stripNames[id] = state.strips[id].name
    stripDevices[id] = state.strips[id].deviceId
  }
  const busNames: Record<string, string> = {}
  const busDevices: Record<string, string> = {}
  for (const id of BUS_ORDER) {
    busNames[id] = state.buses[id].name
    busDevices[id] = state.buses[id].deviceId
  }

  return {
    id: `scene-${Date.now().toString(36)}`,
    name,
    savedAt: new Date().toISOString(),
    strips,
    buses,
    masterEq: structuredClone(state.masterEq),
    masterEqEnabled: state.masterEqEnabled,
    masterGainDb: state.masterGainDb,
    vcaGroups: structuredClone(state.vcaGroups),
    names: { strips: stripNames, buses: busNames },
    devices: { strips: stripDevices, buses: busDevices },
    engine: structuredClone(state.engine),
    ai: structuredClone(state.ai),
  }
}

/* ──────────────────── apply ──────────────────── */

export function applySnapshot(
  snapshot: SceneSnapshot,
  ctx: {
    setStrip: (id: string, patch: Partial<Strip>) => void
    setStripFx: (id: string, patch: Partial<StripFx>) => void
    setBus: (id: string, patch: Partial<Bus>) => void
    setBusFx: (id: string, patch: Partial<BusFx>) => void
    setBusEqBand: (id: string, bandId: string, patch: Record<string, unknown>) => void
    setStripEqBand: (id: string, bandId: string, patch: Record<string, unknown>) => void
    toggleRoute: (id: string, bus: string) => void
    setRoute: (id: string, bus: string, patch: { on: boolean; levelDb: number }) => void
    setMasterEqBand: (bandId: string, patch: Partial<EqBand>) => void
    setMasterEqEnabled: (enabled: boolean) => void
    setMasterGainDb: (gainDb: number) => void
    setVcaGroups: (groups: VcaGroup[]) => void
    setEngine: (patch: Partial<EngineSettings>) => void
    setAi: (patch: Partial<AiSettings>) => void
  },
): string[] {
  const details: string[] = []

  for (const id of STRIP_ORDER) {
    const data = snapshot.strips[id]
    if (!data) continue
    const patch: Partial<Strip> = {
      gainDb: data.gainDb,
      pan: data.pan,
      mute: data.mute,
      solo: data.solo,
      mono: data.mono,
      phase: data.phase,
      voiceTiltDb: data.voiceTiltDb,
    }
    if (typeof data.cue === 'boolean') patch.cue = data.cue
    if (typeof data.phantom === 'boolean') patch.phantom = data.phantom
    if (snapshot.names?.strips[id]) patch.name = snapshot.names.strips[id]
    if (snapshot.devices?.strips[id] !== undefined) patch.deviceId = snapshot.devices.strips[id]
    if ('aiPresetId' in data) {
      patch.aiPresetId = typeof data.aiPresetId === 'string' ? data.aiPresetId : null
    }
    ctx.setStrip(id, patch)
    ctx.setStripFx(id, structuredClone(data.fx) as StripFx)

    // Restore routing
    for (const [busId, route] of Object.entries(data.routing)) {
      ctx.setRoute(id, busId, { on: route.on, levelDb: route.levelDb })
    }

    details.push(`${id}: restored`)
  }

  if (snapshot.masterEq) {
    for (const band of snapshot.masterEq) {
      ctx.setMasterEqBand(band.id, band)
    }
    if (typeof snapshot.masterEqEnabled === 'boolean') ctx.setMasterEqEnabled(snapshot.masterEqEnabled)
    if (typeof snapshot.masterGainDb === 'number') ctx.setMasterGainDb(snapshot.masterGainDb)
  }
  if (snapshot.vcaGroups) ctx.setVcaGroups(structuredClone(snapshot.vcaGroups))
  if (snapshot.engine) ctx.setEngine(structuredClone(snapshot.engine))
  if (snapshot.ai) ctx.setAi(structuredClone(snapshot.ai))

  for (const id of BUS_ORDER) {
    const data = snapshot.buses[id]
    if (!data) continue
    ctx.setBus(id, {
      gainDb: data.gainDb,
      mute: data.mute,
      mono: data.mono,
      dim: data.dim,
      ...(snapshot.names?.buses[id] ? { name: snapshot.names.buses[id] } : {}),
      ...(snapshot.devices?.buses[id] !== undefined ? { deviceId: snapshot.devices.buses[id] } : {}),
    })
    ctx.setBusFx(id, structuredClone(data.fx) as BusFx)
    details.push(`${id}: restored`)
  }

  return details
}

/* ───────────────────── storage ──────────────────── */

export function loadScenes(): SceneStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SceneStore) : []
  } catch { return [] }
}

/** Returns false when the browser refused to store the scene list. */
export function saveScenes(scenes: SceneStore): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenes))
    return true
  } catch {
    return false
  }
}

export function deleteScene(scenes: SceneStore, id: string): SceneStore {
  return scenes.filter((s) => s.id !== id)
}