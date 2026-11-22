import { useEffect, useRef } from 'react'
import { clamp } from '../lib/format'
import { meterTarget, type MeterSource } from './meterBus'

export interface MeterRefs {
  left: React.RefObject<HTMLSpanElement | null>
  right: React.RefObject<HTMLSpanElement | null>
  peakLeft: React.RefObject<HTMLSpanElement | null>
  peakRight: React.RefObject<HTMLSpanElement | null>
  db: React.RefObject<HTMLSpanElement | null>
}

/**
 * Drives a stereo meter from the real engine when the Tauri bridge is live and
 * falls back to a deterministic voice-like simulation in the browser.
 *
 * `source` selects a strip/bus from the latest `get_meter_levels` snapshot.
 * The DOM contract is identical in both modes, so components never branch.
 */
export const useMeter = (
  active: boolean,
  seed = 0,
  orientation: 'vertical' | 'horizontal' = 'vertical',
  source?: MeterSource,
): MeterRefs => {
  const left = useRef<HTMLSpanElement | null>(null)
  const right = useRef<HTMLSpanElement | null>(null)
  const peakLeft = useRef<HTMLSpanElement | null>(null)
  const peakRight = useRef<HTMLSpanElement | null>(null)
  const db = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let raf = 0
    let levelL = 0
    let levelR = 0
    let holdL = 0
    let holdR = 0
    let last = 0

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 33) return
      last = now
      const t = now / 1000

      let targetL = 0
      let targetR = 0
      if (active) {
        const real = meterTarget(source)
        if (real !== null) {
          targetL = real
          targetR = real
        } else {
          const voice =
            0.52 +
            0.22 * Math.sin(t * 2.1 + seed * 1.7) +
            0.12 * Math.sin(t * 5.3 + seed * 2.3) +
            0.07 * Math.sin(t * 11.9 + seed * 3.1)
          const syllables = Math.pow(Math.max(0, Math.sin(t * 3.4 + seed)), 2.5) * 0.24
          targetL = clamp(voice + syllables + (Math.random() - 0.5) * 0.05, 0.02, 1)
          targetR = clamp(voice + syllables * 0.92 + (Math.random() - 0.5) * 0.05, 0.02, 1)
        }
      }

      const attack = 0.55
      const release = 0.14
      levelL = targetL > levelL ? levelL + (targetL - levelL) * attack : levelL + (targetL - levelL) * release
      levelR = targetR > levelR ? levelR + (targetR - levelR) * attack : levelR + (targetR - levelR) * release

      holdL = Math.max(levelL, holdL - 0.006)
      holdR = Math.max(levelR, holdR - 0.006)

      // Idle, unassigned channels do not need DOM writes at 30 fps. This keeps
      // the 12-cable bay from scheduling pointless style recalculations.
      if (!active && levelL < 0.001 && levelR < 0.001 && holdL < 0.001 && holdR < 0.001) return

      if (orientation === 'horizontal') {
        if (left.current) left.current.style.transform = `scaleX(${levelL.toFixed(3)})`
        if (right.current) right.current.style.transform = `scaleX(${levelR.toFixed(3)})`
      } else {
        if (left.current) left.current.style.height = `${(levelL * 100).toFixed(1)}%`
        if (right.current) right.current.style.height = `${(levelR * 100).toFixed(1)}%`
        if (peakLeft.current) peakLeft.current.style.bottom = `${(holdL * 100).toFixed(1)}%`
        if (peakRight.current) peakRight.current.style.bottom = `${(holdR * 100).toFixed(1)}%`
      }

      if (db.current) {
        const peakDb = -60 + holdL * 60
        db.current.textContent = holdL < 0.01 ? 'PK −∞' : `PK ${peakDb > 0 ? '+' : ''}${peakDb.toFixed(1)}`
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, seed, orientation, source?.kind, source?.index])

  return { left, right, peakLeft, peakRight, db }
}
