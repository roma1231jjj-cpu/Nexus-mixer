/**
 * Lightweight, render-free meter transport.
 *
 * The Rust engine is polled from `useEngineBridge`; values land here and are
 * read by the `useMeter` animation loop. Using a module-level store avoids a
 * React re-render for every meter frame (20–30 updates per second).
 */

import type { MeterLevels } from '../types'
import { BUS_ORDER, STRIP_ORDER } from '../data/defaults'

export type MeterKind = 'strip' | 'bus'

export interface MeterSource {
  kind: MeterKind
  /** Zero-based index into `STRIP_ORDER` / `BUS_ORDER`. */
  index: number
}

const SILENCE_DB = -120
const METER_FLOOR_DB = -60

let live = false
let frame: MeterLevels = {
  strips: Array.from({ length: STRIP_ORDER.length }, () => SILENCE_DB),
  buses: Array.from({ length: BUS_ORDER.length }, () => SILENCE_DB),
}

/** True once the desktop bridge has delivered at least one meter frame. */
export function hasLiveMeters(): boolean {
  return live
}

/** Called by the bridge poller. `null` means the engine is stopped. */
export function publishMeterLevels(levels: MeterLevels | null): void {
  live = true
  if (!levels) {
    frame = {
      strips: Array.from({ length: STRIP_ORDER.length }, () => SILENCE_DB),
      buses: Array.from({ length: BUS_ORDER.length }, () => SILENCE_DB),
    }
    return
  }
  frame = levels
}

/**
 * Target meter position in 0..1 for the requested channel, or `null` when the
 * UI should fall back to the browser simulation.
 */
export function meterTarget(source: MeterSource | undefined): number | null {
  if (!live) return null
  if (!source) return 0
  const levels = source.kind === 'strip' ? frame.strips : frame.buses
  const db = levels[source.index] ?? SILENCE_DB
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
}
