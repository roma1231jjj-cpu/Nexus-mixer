import { useCallback, useEffect, useRef } from 'react'
import { useMixer } from '../store/useMixer'
import {
  captureMixer,
  mixerFingerprint,
  useUndoRedo,
  type MixerSnapshotState,
} from './undoRedo'

const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Wires mixer changes into the undo history.
 *
 * Every editable parameter is covered now (faders, pan, mute/solo, routing,
 * names, FX, buses, master EQ/gain, VCA). The pre-change state is captured once
 * per burst of edits and committed after the user pauses, so Ctrl+Z restores
 * the value a control had before the drag.
 */
export function useUndoRedoIntegration() {
  const { capture, undo, redo, canUndo, canRedo } = useUndoRedo()
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<MixerSnapshotState | null>(null)
  const applyingRef = useRef(false)
  const fingerprintRef = useRef<string>('')

  useEffect(() => {
    const state = useMixer.getState()
    fingerprintRef.current = mixerFingerprint(state)

    const unsubscribe = useMixer.subscribe((next) => {
      if (applyingRef.current) return
      const fingerprint = mixerFingerprint(next)
      if (fingerprint === fingerprintRef.current) return
      // Remember only the state before the first change of this burst.
      if (!pendingRef.current) {
        pendingRef.current = captureMixer(useMixer.getState())
      }
      fingerprintRef.current = fingerprint
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

  const currentSnapshot = useCallback((): MixerSnapshotState => captureMixer(useMixer.getState()), [])

  const applySnapshot = useCallback((snapshot: MixerSnapshotState) => {
    const state = useMixer.getState()
    applyingRef.current = true
    try {
      for (const [id, data] of Object.entries(snapshot.strips)) {
        const stripId = id as Parameters<typeof state.setStrip>[0]
        state.setStrip(stripId, {
          name: data.name,
          gainDb: data.gainDb,
          pan: data.pan,
          mute: data.mute,
          solo: data.solo,
          mono: data.mono,
          phase: data.phase,
          voiceTiltDb: data.voiceTiltDb,
        })
        state.setStripFx(stripId, structuredClone(data.fx))
        for (const [busId, route] of Object.entries(data.routing)) {
          state.setRoute(stripId, busId as Parameters<typeof state.setRoute>[1], {
            on: route.on,
            levelDb: route.levelDb,
          })
        }
      }
      for (const [id, data] of Object.entries(snapshot.buses)) {
        const busId = id as Parameters<typeof state.setBus>[0]
        state.setBus(busId, {
          gainDb: data.gainDb,
          mute: data.mute,
          mono: data.mono,
          dim: data.dim,
        })
        state.setBusFx(busId, structuredClone(data.fx))
      }
      for (const band of snapshot.masterEq) {
        state.setMasterEqBand(band.id, band)
      }
      state.setMasterEqEnabled(snapshot.masterEqEnabled)
      state.setMasterGainDb(snapshot.masterGainDb)
      state.setVcaGroups(structuredClone(snapshot.vcaGroups))
    } finally {
      fingerprintRef.current = mixerFingerprint(useMixer.getState())
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
    const snapshot = undo(currentSnapshot())
    if (!snapshot) return false
    applySnapshot(snapshot)
    return true
  }, [flushPending, undo, currentSnapshot, applySnapshot])

  const handleRedo = useCallback(() => {
    flushPending()
    const snapshot = redo(currentSnapshot())
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
