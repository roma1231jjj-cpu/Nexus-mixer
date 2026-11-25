/**
 * Undo / Redo — history for every mixer parameter the user can touch.
 *
 * The first version only remembered channel and bus FX, so Ctrl+Z after moving
 * a fader (or muting a channel, or editing the master EQ) did nothing or jumped
 * to an unrelated FX state. The snapshot now covers faders, pan, mute, solo,
 * routing, names, FX, bus state, master EQ/gain and VCA groups.
 */

import { useCallback, useRef, useState } from 'react'
import type { Bus, BusFx, EqBand, Strip, StripFx, VcaGroup } from '../types'
import { BUS_ORDER, STRIP_ORDER } from '../data/defaults'

export interface StripSnapshot {
  name: string
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  mono: boolean
  phase: boolean
  voiceTiltDb: number
  fx: StripFx
  routing: Record<string, { on: boolean; levelDb: number }>
}

export interface BusSnapshot {
  gainDb: number
  mute: boolean
  mono: boolean
  dim: boolean
  fx: BusFx
}

export interface MixerSnapshotState {
  strips: Record<string, StripSnapshot>
  buses: Record<string, BusSnapshot>
  masterEq: EqBand[]
  masterEqEnabled: boolean
  masterGainDb: number
  vcaGroups: VcaGroup[]
}

/** Kept as an alias so existing imports keep working. */
export type FxSnapshot = MixerSnapshotState

export interface UndoRedoStore {
  past: MixerSnapshotState[]
  future: MixerSnapshotState[]
}

const MAX_HISTORY = 50

type MixerSource = {
  strips: Record<string, Strip>
  buses: Record<string, Bus>
  masterEq: EqBand[]
  masterEqEnabled: boolean
  masterGainDb: number
  vcaGroups: VcaGroup[]
}

export function captureMixer(state: MixerSource): MixerSnapshotState {
  const strips: Record<string, StripSnapshot> = {}
  for (const id of STRIP_ORDER) {
    const strip = state.strips[id]
    if (!strip) continue
    strips[id] = {
      name: strip.name,
      gainDb: strip.gainDb,
      pan: strip.pan,
      mute: strip.mute,
      solo: strip.solo,
      mono: strip.mono,
      phase: strip.phase,
      voiceTiltDb: strip.voiceTiltDb,
      fx: structuredClone(strip.fx) as StripFx,
      routing: structuredClone(strip.routing) as StripSnapshot['routing'],
    }
  }
  const buses: Record<string, BusSnapshot> = {}
  for (const id of BUS_ORDER) {
    const bus = state.buses[id]
    if (!bus) continue
    buses[id] = {
      gainDb: bus.gainDb,
      mute: bus.mute,
      mono: bus.mono,
      dim: bus.dim,
      fx: structuredClone(bus.fx) as BusFx,
    }
  }
  return {
    strips,
    buses,
    masterEq: structuredClone(state.masterEq),
    masterEqEnabled: state.masterEqEnabled,
    masterGainDb: state.masterGainDb,
    vcaGroups: structuredClone(state.vcaGroups),
  }
}

/**
 * Fingerprint of everything undo covers. Device lists, meters and engine
 * status deliberately stay out of it: a status poll must not create a history
 * entry, and a re-plugged interface should not be undone with Ctrl+Z.
 */
export function mixerFingerprint(state: MixerSource): string {
  return JSON.stringify(captureMixer(state))
}

export function useUndoRedo() {
  const stack = useRef<UndoRedoStore>({ past: [], future: [] })
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const updateFlags = useCallback(() => {
    setCanUndo(stack.current.past.length > 0)
    setCanRedo(stack.current.future.length > 0)
  }, [])

  const clone = (snapshot: MixerSnapshotState): MixerSnapshotState =>
    structuredClone(snapshot) as MixerSnapshotState

  const capture = useCallback(
    (snapshot: MixerSnapshotState) => {
      const { past, future } = stack.current
      const current = past[past.length - 1]
      if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return
      past.push(clone(snapshot))
      if (past.length > MAX_HISTORY) past.shift()
      future.length = 0
      updateFlags()
    },
    [updateFlags]
  )

  const undo = useCallback(
    (current: MixerSnapshotState): MixerSnapshotState | null => {
      const { past, future } = stack.current
      if (past.length === 0) return null
      const previous = past.pop()!
      future.push(clone(current))
      updateFlags()
      return previous
    },
    [updateFlags]
  )

  const redo = useCallback(
    (current: MixerSnapshotState): MixerSnapshotState | null => {
      const { past, future } = stack.current
      if (future.length === 0) return null
      const next = future.pop()!
      past.push(clone(current))
      updateFlags()
      return next
    },
    [updateFlags]
  )

  const reset = useCallback(() => {
    stack.current = { past: [], future: [] }
    updateFlags()
  }, [updateFlags])

  return { capture, undo, redo, canUndo, canRedo, reset }
}
