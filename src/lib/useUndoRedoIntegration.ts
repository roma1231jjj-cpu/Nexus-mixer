import { useCallback, useEffect, useRef } from 'react'
import { useMixer } from '../store/useMixer'
import { useUndoRedo, type FxSnapshot } from './undoRedo'
import type { StripFx, BusFx, Strip, Bus } from '../types'

const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/** Snapshot the FX state of every channel in a given mixer snapshot. */
const snapshotFx = (state: {
  strips: Record<string, Strip>
  buses: Record<string, Bus>
}): FxSnapshot => {
  const stripFx: Record<string, StripFx> = {}
  const busFx: Record<string, BusFx> = {}
  for (const [id, strip] of Object.entries(state.strips)) {
    stripFx[id] = structuredClone(strip.fx) as StripFx
  }
  for (const [id, bus] of Object.entries(state.buses)) {
    busFx[id] = structuredClone(bus.fx) as BusFx
  }
  return { stripFx, busFx }
}

const fxChanged = (
  state: { strips: Record<string, Strip>; buses: Record<string, Bus> },
  previous: { strips: Record<string, Strip>; buses: Record<string, Bus> },
): boolean => {
  for (const id of Object.keys(state.strips)) {
    if (state.strips[id]?.fx !== previous.strips[id]?.fx) return true
  }
  for (const id of Object.keys(state.buses)) {
    if (state.buses[id]?.fx !== previous.buses[id]?.fx) return true
  }
  return false
}

/**
 * Wires FX changes into the undo history.
 *
 * The *pre-change* state is captured once per burst of parameter edits and
 * committed after the user pauses. This is what makes Ctrl+Z restore the value
 * the control had before the drag instead of re-applying the latest one.
 */
export function useUndoRedoIntegration() {
  const { capture, undo, redo, canUndo, canRedo } = useUndoRedo()
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<FxSnapshot | null>(null)
  const applyingRef = useRef(false)

  useEffect(() => {
    const unsubscribe = useMixer.subscribe((state, previous) => {
      if (applyingRef.current) return
      if (!fxChanged(state, previous)) return

      // Remember only the state before the first change of this burst.
      if (!pendingRef.current) pendingRef.current = snapshotFx(previous)

      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        if (pendingRef.current) capture(pendingRef.current)
        pendingRef.current = null
        timerRef.current = null
      }, 320)
    })

    return () => {
      unsubscribe()
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [capture])

  const currentSnapshot = useCallback((): FxSnapshot => {
    const state = useMixer.getState()
    return snapshotFx(state)
  }, [])

  const applySnapshot = useCallback((snapshot: FxSnapshot) => {
    const state = useMixer.getState()
    applyingRef.current = true
    try {
      for (const [id, fx] of Object.entries(snapshot.stripFx)) {
        state.setStripFx(id as Parameters<typeof state.setStripFx>[0], structuredClone(fx) as StripFx)
      }
      for (const [id, fx] of Object.entries(snapshot.busFx)) {
        state.setBusFx(id as Parameters<typeof state.setBusFx>[0], structuredClone(fx) as BusFx)
      }
    } finally {
      applyingRef.current = false
    }
  }, [])

  const flushPending = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) capture(pending)
  }, [capture])

  const handleUndo = useCallback(() => {
    flushPending()
    const current = currentSnapshot()
    const snapshot = undo(current.stripFx, current.busFx)
    if (!snapshot) return false
    applySnapshot(snapshot)
    return true
  }, [flushPending, undo, currentSnapshot, applySnapshot])

  const handleRedo = useCallback(() => {
    flushPending()
    const current = currentSnapshot()
    const snapshot = redo(current.stripFx, current.busFx)
    if (!snapshot) return false
    applySnapshot(snapshot)
    return true
  }, [flushPending, redo, currentSnapshot, applySnapshot])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        handleUndo()
      } else if (
        (event.metaKey || event.ctrlKey) &&
        (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))
      ) {
        event.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleUndo, handleRedo])

  return { handleUndo, handleRedo, flushPending, canUndo, canRedo }
}
