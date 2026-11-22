/**
 * Undo / Redo — history stack for FX parameter changes
 */

import { useRef, useCallback, useState } from 'react'
import type { StripFx, BusFx } from '../types'

/* ──────────────────── types ──────────────────── */

export interface FxSnapshot {
  stripFx: Record<string, StripFx>
  busFx: Record<string, BusFx>
}

export interface UndoRedoStore {
  /** Past states (index 0 = oldest) */
  past: FxSnapshot[]
  /** Future states (index 0 = most recent undo) */
  future: FxSnapshot[]
}

const MAX_HISTORY = 50

/* ──────────────────── hook ──────────────────── */

export function useUndoRedo() {
  const stack = useRef<UndoRedoStore>({ past: [], future: [] })
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const updateFlags = useCallback(() => {
    const s = stack.current
    setCanUndo(s.past.length > 0)
    setCanRedo(s.future.length > 0)
  }, [])

  const capture = useCallback((snapshot: FxSnapshot) => {
    stack.current.past.push({
      stripFx: structuredClone(snapshot.stripFx) as Record<string, StripFx>,
      busFx: structuredClone(snapshot.busFx) as Record<string, BusFx>,
    })
    if (stack.current.past.length > MAX_HISTORY) stack.current.past.shift()
    stack.current.future = []
    updateFlags()
  }, [updateFlags])

  const undo = useCallback((currentStripFx: Record<string, StripFx>, currentBusFx: Record<string, BusFx>): FxSnapshot | null => {
    const { past, future } = stack.current
    if (past.length === 0) return null
    const prev = past.pop()!
    // Push current state to future
    future.push({
      stripFx: structuredClone(currentStripFx) as Record<string, StripFx>,
      busFx: structuredClone(currentBusFx) as Record<string, BusFx>,
    })
    updateFlags()
    return prev
  }, [updateFlags])

  const redo = useCallback((currentStripFx: Record<string, StripFx>, currentBusFx: Record<string, BusFx>): FxSnapshot | null => {
    const { past, future } = stack.current
    if (future.length === 0) return null
    const next = future.pop()!
    past.push({
      stripFx: structuredClone(currentStripFx) as Record<string, StripFx>,
      busFx: structuredClone(currentBusFx) as Record<string, BusFx>,
    })
    updateFlags()
    return next
  }, [updateFlags])

  return { capture, undo, redo, canUndo, canRedo }
}