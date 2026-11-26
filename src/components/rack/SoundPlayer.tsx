import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Music, Square, Upload, Disc3, Radio, Anchor, Trash2, Volume2, AlertTriangle } from 'lucide-react'
import { Sequencer } from './Sequencer'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { Knob } from '../controls/Knob'
import { Switch } from '../controls/Switch'
import { STRIP_ORDER, BUS_ORDER } from '../../data/defaults'
import {
  loadSamples,
  saveSamples,
  saveSampleBlob,
  loadSampleBlob,
  deleteSampleBlob,
  decodeAudioBlob,
  toInterleaved,
  playPreview,
  type SoundSample,
  type SoundPadState,
} from '../../lib/soundBank'
import { engineBridge, type PadPlayParams } from '../../lib/engineBridge'
import { Select } from '../controls/Select'
import { useT } from '../../i18n'

/* ──────────────────── preview bus (engine offline) ──────────────────── */

let previewCtx: AudioContext | null = null
let previewGain: GainNode | null = null

function getPreviewCtx(): AudioContext {
  if (!previewCtx || previewCtx.state === 'closed') {
    previewCtx = new AudioContext()
    previewGain = previewCtx.createGain()
    previewGain.gain.value = 1
    previewGain.connect(previewCtx.destination)
  }
  if (previewCtx.state === 'suspended') void previewCtx.resume()
  return previewCtx
}

function previewDestination(): AudioNode {
  getPreviewCtx()
  return previewGain ?? previewCtx!.destination
}

export function getSoundMasterVolume(): number {
  return previewGain?.gain.value ?? 1
}

export function setSoundMasterVolume(v: number) {
  if (previewGain) previewGain.gain.value = v
}

const EMPTY_PAD_STATE: SoundPadState = {
  playing: false,
  engine: false,
  level: 0,
  gainNode: null,
  pannerNode: null,
  sourceNode: null,
}

export function SoundPlayer() {
  const t = useT()
  const strips = useMixer((s) => s.strips) as Record<string, import('../../types').Strip>
  const engineRunning = useMixer((s) => s.status.running)
  const notify = useUi((s) => s.notify)

  const [samples, setSamples] = useState<SoundSample[]>(() => loadSamples())
  const [padStates, setPadStates] = useState<Record<string, SoundPadState>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [masterVolume, setMasterVolume] = useState(1)
  const [dragOver, setDragOver] = useState(false)
  const [seqOpen, setSeqOpen] = useState(false)
  const [missing, setMissing] = useState<Record<string, boolean>>({})
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  const [enginePads, setEnginePads] = useState<Record<string, boolean>>({})

  const fileInputRef = useRef<HTMLInputElement>(null)
  const repairInputRef = useRef<HTMLInputElement>(null)
  const repairTargetRef = useRef<string | null>(null)
  const samplesRef = useRef<SoundSample[]>(samples)
  const buffersRef = useRef<Record<string, AudioBuffer>>({})
  const padStatesRef = useRef<Record<string, SoundPadState>>({})
  const masterRef = useRef(masterVolume)
  const engineRunningRef = useRef(engineRunning)
  /** Set once syncEngineBank exists; a late decode calls it again. */
  const syncEngineRef = useRef<() => void>(() => {})

  samplesRef.current = samples
  padStatesRef.current = padStates
  masterRef.current = masterVolume
  engineRunningRef.current = engineRunning

  const setPadState = useCallback((id: string, next: Partial<SoundPadState>) => {
    setPadStates((prev) => {
      const merged = { ...EMPTY_PAD_STATE, ...prev[id], ...next }
      return { ...prev, [id]: merged }
    })
  }, [])

  /* ────────── metadata persistence ────────── */

  useEffect(() => {
    if (!saveSamples(samples)) notify(t('pad.storageFailed'))
  }, [samples, notify, t])

  /* ────────── decode payloads once per launch ────────── */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const sample of samplesRef.current) {
        if (buffersRef.current[sample.id]) continue
        const blob = await loadSampleBlob(sample.id)
        if (cancelled || !blob) {
          if (!cancelled && !blob) setMissing((prev) => ({ ...prev, [sample.id]: true }))
          continue
        }
        try {
          const ctx = getPreviewCtx()
          const decoded = await decodeAudioBlob(sample.id, sample.name, blob, ctx)
          if (cancelled) return
          buffersRef.current[sample.id] = decoded.buffer
          setMissing((prev) => ({ ...prev, [sample.id]: false }))
          // The first bank sync may have run before this decode finished.
          syncEngineRef.current()
        } catch {
          if (!cancelled) {
            setMissing((prev) => ({ ...prev, [sample.id]: true }))
            notify(t('pad.decodeFailed', { name: sample.name }))
          }
        }
      }
      if (!cancelled) {
        const broken = samplesRef.current.filter((sample) => missingIds(sample.id))
        if (broken.length > 0) notify(t('pad.missingPayloads', { n: broken.length }))
      }
    })()

    function missingIds(id: string): boolean {
      return !buffersRef.current[id] && !loadable(id)
    }
    function loadable(id: string): boolean {
      return samplesRef.current.some((sample) => sample.id === id)
    }

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ────────── engine sync ────────── */

  const uploadToEngine = useCallback(
    async (id: string, buffer: AudioBuffer): Promise<boolean> => {
      if (!engineBridge.available) return false
      setUploading((prev) => ({ ...prev, [id]: true }))
      try {
        const pcm = toInterleaved(buffer)
        const result = await engineBridge.padLoad(id, Math.round(buffer.sampleRate), 2, pcm)
        if (!result.ok) {
          notify(t('pad.engineUploadFailed', { error: result.error ?? '' }))
          return false
        }
        setEnginePads((prev) => ({ ...prev, [id]: true }))
        return true
      } finally {
        setUploading((prev) => ({ ...prev, [id]: false }))
      }
    },
    [notify, t]
  )

  // Upload anything the engine does not have yet. The bank survives engine
  // stop/start, but not an app restart, so this runs on mount and whenever the
  // engine comes back.
  const syncEngineBank = useCallback(async () => {
    if (!engineBridge.available) return
    const loaded = await engineBridge.padLoaded()
    const known = new Set(loaded.ok ? loaded.value ?? [] : [])
    setEnginePads(Object.fromEntries([...known].map((id) => [id, true])))
    for (const sample of samplesRef.current) {
      if (known.has(sample.id)) continue
      const buffer = buffersRef.current[sample.id]
      if (!buffer) continue
      await uploadToEngine(sample.id, buffer)
    }
  }, [uploadToEngine])

  syncEngineRef.current = () => {
    if (engineBridge.available) void syncEngineBank()
  }

  useEffect(() => {
    if (!engineBridge.available) return
    void syncEngineBank()
  }, [syncEngineBank])

  useEffect(() => {
    if (engineRunning) void syncEngineBank()
  }, [engineRunning, syncEngineBank])

  /* ────────── cleanup ────────── */

  useEffect(() => {
    return () => {
      Object.values(padStatesRef.current).forEach((state) => {
        if (!state.playing || state.engine) return
        try {
          state.sourceNode?.stop()
        } catch {
          /* already stopped */
        }
      })
      const ctx = previewCtx
      previewCtx = null
      previewGain = null
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    }
  }, [])

  /* ────────── routing helpers ────────── */

  const targetOf = useCallback(
    (sample: SoundSample): string => {
      if (sample.targetStrip) return sample.targetStrip
      if (sample.targetBus) return sample.targetBus
      return 'master'
    },
    []
  )

  const paramsOf = useCallback(
    (sample: SoundSample, delayMs = 0): PadPlayParams => ({
      volume: sample.volume * masterRef.current,
      pan: sample.pan,
      loop: sample.loop,
      pitch: sample.pitchShift,
      target: targetOf(sample),
      delayMs,
    }),
    [targetOf]
  )

  /* ────────── file upload ────────── */

  const decodeAndStore = async (files: FileList): Promise<void> => {
    const ctx = getPreviewCtx()
    const started: SoundSample[] = []
    for (let index = 0; index < files.length; index++) {
      const file = files[index]
      if (!file.type.startsWith('audio/')) {
        notify(t('pad.notAudio', { name: file.name }))
        continue
      }
      const id = `snd-${Date.now().toString(36)}-${index}${Math.random().toString(36).slice(2, 6)}`
      const stored = await saveSampleBlob(id, file)
      if (!stored) notify(t('pad.storageFailed'))
      try {
        const decoded = await decodeAudioBlob(id, file.name.replace(/\.[^/.]+$/, ''), file, ctx)
        buffersRef.current[id] = decoded.buffer
        started.push(decoded.sample)
        setMissing((prev) => ({ ...prev, [id]: false }))
        await uploadToEngine(id, decoded.buffer)
      } catch {
        // Do not leave an invisible blob behind when decoding failed.
        if (stored) await deleteSampleBlob(id)
        notify(t('pad.decodeFailed', { name: file.name }))
      }
    }
    if (started.length > 0) {
      setSamples((prev) => [...prev, ...started])
      notify(t('pad.loaded', { n: started.length }))
    }
  }

  const handleFiles = (files: FileList) => void decodeAndStore(files)

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) handleFiles(event.target.files)
    event.target.value = ''
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = () => setDragOver(false)
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    if (event.dataTransfer.files) handleFiles(event.dataTransfer.files)
  }

  /* ────────── re-attach a missing payload ────────── */

  const askRepair = (id: string) => {
    repairTargetRef.current = id
    repairInputRef.current?.click()
  }

  const handleRepairInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const id = repairTargetRef.current
    event.target.value = ''
    repairTargetRef.current = null
    if (!file || !id) return
    if (!file.type.startsWith('audio/')) {
      notify(t('pad.notAudio', { name: file.name }))
      return
    }
    try {
      const ctx = getPreviewCtx()
      const decoded = await decodeAudioBlob(id, file.name.replace(/\.[^/.]+$/, ''), file, ctx)
      buffersRef.current[id] = decoded.buffer
      if (!(await saveSampleBlob(id, file))) {
        notify(t('pad.storageFailed'))
        return
      }
      setMissing((prev) => ({ ...prev, [id]: false }))
      setSamples((prev) =>
        prev.map((sample) =>
          sample.id === id
            ? {
                ...sample,
                name: decoded.sample.name,
                size: decoded.sample.size,
                duration: decoded.sample.duration,
                sampleRate: decoded.sample.sampleRate,
                channels: decoded.sample.channels,
              }
            : sample
        )
      )
      await uploadToEngine(id, decoded.buffer)
      notify(t('pad.restored', { name: decoded.sample.name }))
    } catch {
      notify(t('pad.decodeFailed', { name: file.name }))
    }
  }

  /* ────────── preview voice ────────── */

  const stopPreview = useCallback((id: string) => {
    const state = padStatesRef.current[id]
    if (!state || state.engine) return
    try {
      state.sourceNode?.stop()
    } catch {
      /* already stopped */
    }
    setPadState(id, {
      playing: false,
      sourceNode: null,
      gainNode: null,
      pannerNode: null,
      level: 0,
    })
  }, [setPadState])

  const startPreview = useCallback(
    (sample: SoundSample, buffer: AudioBuffer) => {
      const ctx = getPreviewCtx()
      stopPreview(sample.id)
      const nodes = playPreview(ctx, buffer, previewDestination(), {
        // previewGain already carries the master level; applying it twice
        // made 50% master sound like 25%.
        volume: sample.volume,
        pan: sample.pan,
        loop: sample.loop,
        pitchShift: sample.pitchShift,
      })
      // Real meter for the preview voice instead of an invented number.
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      nodes.gainNode.connect(analyser)
      const meterData = new Float32Array(analyser.fftSize)
      const meter = window.setInterval(() => {
        const state = padStatesRef.current[sample.id]
        if (!state?.playing || state.engine) {
          window.clearInterval(meter)
          return
        }
        analyser.getFloatTimeDomainData(meterData)
        let peak = 0
        for (const value of meterData) peak = Math.max(peak, Math.abs(value))
        setPadState(sample.id, { level: peak })
      }, 90)

      nodes.sourceNode.onended = () => {
        window.clearInterval(meter)
        setPadState(sample.id, {
          playing: false,
          sourceNode: null,
          gainNode: null,
          pannerNode: null,
          level: 0,
        })
      }
      setPadState(sample.id, {
        playing: true,
        engine: false,
        sourceNode: nodes.sourceNode,
        gainNode: nodes.gainNode,
        pannerNode: nodes.pannerNode,
        level: 0,
      })
    },
    [setPadState, stopPreview]
  )

  /* ────────── playback ────────── */

  const trigger = useCallback(
    (id: string, delayMs = 0): boolean => {
      const sample = samplesRef.current.find((item) => item.id === id)
      if (!sample) return false
      const buffer = buffersRef.current[sample.id]
      if (!buffer) {
        notify(t('pad.missingFile', { name: sample.name }))
        setMissing((prev) => ({ ...prev, [sample.id]: true }))
        return false
      }
      if (engineRunningRef.current && enginePads[sample.id]) {
        void engineBridge.padPlay(sample.id, paramsOf(sample, delayMs)).then((result) => {
          if (result.ok) {
            setPadState(sample.id, { playing: true, engine: true, level: 0 })
            return
          }
          // Engine refused (halted between polls, sample not uploaded, …):
          // fall back to the preview bus and say so instead of silence.
          notify(t('pad.engineFallback', { error: result.error ?? '' }))
          startPreview(sample, buffer)
        })
        return true
      }
      startPreview(sample, buffer)
      return true
    },
    [enginePads, notify, paramsOf, setPadState, startPreview, t]
  )

  const stopPad = useCallback(
    (id: string) => {
      const state = padStatesRef.current[id]
      if (!state?.playing) return
      if (state.engine) {
        void engineBridge.padStop(id)
        setPadState(id, { playing: false, level: 0 })
      } else {
        stopPreview(id)
      }
    },
    [setPadState, stopPreview]
  )

  const handlePadClick = (sample: SoundSample) => {
    if (missing[sample.id]) {
      askRepair(sample.id)
      return
    }
    const state = padStatesRef.current[sample.id]
    if (state?.playing) stopPad(sample.id)
    else trigger(sample.id)
  }

  const handleStopAll = () => {
    Object.keys(padStatesRef.current).forEach((id) => {
      const state = padStatesRef.current[id]
      if (!state?.playing) return
      if (state.engine) void engineBridge.padStop(id)
      else {
        try {
          state.sourceNode?.stop()
        } catch {
          /* already stopped */
        }
      }
    })
    if (engineBridge.available) void engineBridge.padStopAll()
    setPadStates({})
  }

  const handleUpdate = (id: string, patch: Partial<SoundSample>) => {
    setSamples((prev) => {
      const next = prev.map((sample) => (sample.id === id ? { ...sample, ...patch } : sample))
      const updated = next.find((sample) => sample.id === id)
      if (updated) {
        const state = padStatesRef.current[id]
        if (state?.playing && state.engine) {
          void engineBridge.padUpdate(id, paramsOf(updated))
        } else if (state?.playing && state.gainNode && state.pannerNode) {
          // Preview nodes accept volume and pan live; loop and pitch need a new
          // source node, so the voice is restarted at the current settings.
          state.gainNode.gain.value = updated.volume
          state.pannerNode.pan.value = updated.pan
          const restart =
            (patch.loop !== undefined && patch.loop !== state.sourceNode?.loop) ||
            patch.pitchShift !== undefined
          if (restart) {
            const buffer = buffersRef.current[id]
            if (buffer) startPreview(updated, buffer)
          }
        }
      }
      return next
    })
  }

  const handleDelete = (id: string) => {
    const state = padStatesRef.current[id]
    if (state?.playing) stopPad(id)
    if (engineBridge.available) void engineBridge.padUnload(id)
    void deleteSampleBlob(id)
    delete buffersRef.current[id]
    setEnginePads((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setSamples((prev) => prev.filter((sample) => sample.id !== id))
    setPadStates((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (selectedId === id) setSelectedId(null)
  }

  /* ────────── levels (engine) ────────── */

  useEffect(() => {
    if (!engineBridge.available || !engineRunning) return
    const timer = window.setInterval(() => {
      void engineBridge.padLevels().then((result) => {
        if (!result.ok || !result.value) return
        const levels = result.value
        setPadStates((prev) => {
          let changed = false
          const next: Record<string, SoundPadState> = { ...prev }
          for (const id of Object.keys(next)) {
            const state = next[id]
            if (!state.engine) continue
            const level = levels[id] ?? 0
            if (level > 0 && !state.playing) {
              next[id] = { ...state, playing: true, level }
              changed = true
            } else if (level <= 0 && state.playing && state.level > 0) {
              // One-shot finished: the engine no longer reports a peak.
              next[id] = { ...state, playing: false, level: 0 }
              changed = true
            } else if (Math.abs(level - state.level) > 0.01) {
              next[id] = { ...state, level }
              changed = true
            }
          }
          return changed ? next : prev
        })
      })
    }, 120)
    return () => window.clearInterval(timer)
  }, [engineRunning])

  useEffect(() => {
    if (previewGain) previewGain.gain.value = masterVolume
    // Engine pads scale through their own volume parameter.
    for (const sample of samplesRef.current) {
      const state = padStatesRef.current[sample.id]
      if (state?.playing && state.engine) void engineBridge.padUpdate(sample.id, paramsOf(sample))
    }
  }, [masterVolume, paramsOf])

  /* ────────── render ────────── */

  const selected = selectedId ? samples.find((sample) => sample.id === selectedId) ?? null : null
  const playingCount = Object.values(padStates).filter((state) => state.playing).length
  const engineReady = engineBridge.available && engineRunning && samples.length > 0

  const stripOptions = useMemo(
    () => [{ value: '', label: t('pad.master') }, ...STRIP_ORDER.map((id) => ({ value: id, label: strips[id].name }))],
    [strips, t]
  )

  return (
    <section
      className={`fx-block${dragOver ? ' drag-over' : ''}`}
      style={{ marginTop: 0 }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="fx-block-head">
        <span className="fx-icon">
          <Music size={13} />
        </span>
        <span className="fx-title">Pads</span>
        <span className="fx-sub">
          {t('pad.samples', { n: samples.length })}
          {playingCount > 0 ? t('pad.playing', { n: playingCount }) : ''}
        </span>
        <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={handleStopAll} title={t('pad.stop')}>
          <Square size={11} />
        </button>
      </header>
      <div className="fx-block-body">
        <input ref={fileInputRef} type="file" accept="audio/*" multiple style={{ display: 'none' }} onChange={handleFileInput} />
        <input ref={repairInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleRepairInput} />

        <div className="pad-routing-notice" data-on={engineReady ? '1' : '0'}>
          {engineReady ? (
            <span>{t('pad.engineOn', { n: Object.values(enginePads).filter(Boolean).length })}</span>
          ) : (
            <span className="row" style={{ gap: 4, alignItems: 'center' }}>
              <AlertTriangle size={10} />
              {engineBridge.available ? t('pad.engineOff') : t('pad.browserOnly')}
            </span>
          )}
        </div>

        <div className="pad-toolbar">
          <button type="button" className="btn pad-upload" onClick={() => fileInputRef.current?.click()}>
            <Upload size={12} /> {t('pad.upload')}
          </button>
          <div className="pad-master-volume">
            <Volume2 size={10} style={{ color: 'var(--faint)' }} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={masterVolume}
              onChange={(event) => {
                const value = parseFloat(event.target.value)
                setMasterVolume(value)
                setSoundMasterVolume(value)
              }}
              style={{ flex: 1, height: 3, accentColor: 'var(--accent)' }}
              title={t('pad.masterVolume', { n: Math.round(masterVolume * 100) })}
            />
            <span className="pad-master-value">{Math.round(masterVolume * 100)}%</span>
          </div>
          {samples.length > 0 && (
            <button type="button" className="btn small pad-stop" onClick={handleStopAll}>
              <Square size={11} /> {t('pad.stop')}
            </button>
          )}
        </div>

        {samples.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3, marginBottom: 8 }}>
            {samples.map((sample) => {
              const state = padStates[sample.id]
              const isPlaying = state?.playing ?? false
              const isSelected = selectedId === sample.id
              const isMissing = Boolean(missing[sample.id])
              const busy = Boolean(uploading[sample.id])
              const level = Math.min(1, state?.level ?? 0)
              return (
                <button
                  key={sample.id}
                  type="button"
                  className="mini-toggle"
                  style={{
                    height: 48,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    padding: '2px 4px',
                    background: isPlaying ? sample.color : isSelected ? sample.color + '33' : undefined,
                    borderColor: isMissing ? 'var(--warn)' : isPlaying || isSelected ? sample.color : undefined,
                    borderWidth: isSelected ? 2 : 1,
                    boxShadow: isPlaying ? `0 0 20px ${sample.color}aa, inset 0 0 20px ${sample.color}44` : undefined,
                    color: isPlaying ? '#fff' : undefined,
                    transition: 'all 0.06s',
                    overflow: 'hidden',
                  }}
                  onClick={() => handlePadClick(sample)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setSelectedId(isSelected ? null : sample.id)
                  }}
                  title={
                    isMissing
                      ? t('pad.missingFile', { name: sample.name })
                      : busy
                        ? t('pad.uploadingEngine')
                        : sample.name
                  }
                >
                  <span
                    style={{
                      fontSize: 7.5,
                      fontWeight: 700,
                      letterSpacing: 0.02,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                      lineHeight: 1.1,
                    }}
                  >
                    {sample.name}
                  </span>
                  <span style={{ fontSize: 6.5, fontFamily: 'var(--font-mono)', opacity: 0.6 }}>
                    {isMissing ? t('pad.noFile') : `${sample.duration.toFixed(1)}s`}
                  </span>
                  <div
                    style={{
                      width: '100%',
                      height: 2,
                      borderRadius: 1,
                      background: isPlaying ? 'rgba(255,255,255,0.3)' : 'var(--stroke)',
                      marginTop: 1,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${level * 100}%`,
                        background: '#fff',
                        borderRadius: 1,
                        transition: 'width 0.08s linear',
                      }}
                    />
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div
            className="empty"
            style={{
              padding: '20px 12px',
              border: dragOver ? '2px dashed var(--accent)' : '2px dashed var(--stroke)',
              borderRadius: 8,
              background: dragOver ? 'var(--accent-soft)' : undefined,
              transition: 'all 0.15s',
            }}
          >
            <Music size={24} style={{ marginBottom: 6, opacity: 0.3 }} />
            <div>{t('pad.empty')}</div>
            <div style={{ fontSize: 9, marginTop: 4, color: 'var(--faint)' }}>{t('pad.formats')}</div>
          </div>
        )}

        {selected && (
          <div style={{ marginTop: 4, padding: 8, borderRadius: 8, border: '1px solid var(--stroke)', background: 'var(--panel-inset)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Disc3 size={12} style={{ color: selected.color }} />
              <span style={{ fontSize: 11, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.name}
              </span>
              <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
                {selected.duration.toFixed(1)}s · {(selected.sampleRate / 1000).toFixed(0)}kHz
              </span>
              {missing[selected.id] && (
                <button type="button" className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => askRepair(selected.id)} title={t('pad.repair')}>
                  <AlertTriangle size={10} />
                </button>
              )}
              <button type="button" className="icon-btn" style={{ width: 20, height: 20, color: 'var(--bad)' }} onClick={() => handleDelete(selected.id)}>
                <Trash2 size={10} />
              </button>
            </div>

            <div className="knob-row compact" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <Knob
                label="VOL"
                value={selected.volume}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
                defaultValue={0.8}
                size={36}
                color={selected.color}
                onChange={(value) => handleUpdate(selected.id, { volume: value })}
              />
              <Knob
                label="PAN"
                value={selected.pan}
                min={-1}
                max={1}
                step={0.01}
                format={(value) => (Math.abs(value) < 0.005 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`)}
                defaultValue={0}
                size={36}
                color={selected.color}
                onChange={(value) => handleUpdate(selected.id, { pan: value })}
              />
              <Knob
                label="PITCH"
                value={selected.pitchShift}
                min={-12}
                max={12}
                step={1}
                unit=" st"
                defaultValue={0}
                size={36}
                color={selected.color}
                onChange={(value) => handleUpdate(selected.id, { pitchShift: value })}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <label className="checkline" style={{ fontSize: 10 }}>
                <Switch on={selected.loop} onChange={(value) => handleUpdate(selected.id, { loop: value })} ariaLabel={t('pad.loopAria')} />
                Loop
              </label>

              <div style={{ flex: 1 }} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Radio size={11} style={{ color: 'var(--faint)' }} />
                <Select
                  value={selected.targetStrip}
                  options={stripOptions}
                  onChange={(value) => handleUpdate(selected.id, { targetStrip: value, targetBus: '' })}
                  small
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Anchor size={11} style={{ color: 'var(--faint)' }} />
                <Select
                  value={selected.targetBus}
                  options={[{ value: '', label: '—' }, ...BUS_ORDER.map((id) => ({ value: id, label: id }))]}
                  onChange={(value) => handleUpdate(selected.id, { targetBus: value, targetStrip: '' })}
                  small
                />
              </div>
            </div>
            <div className="hint-line" style={{ marginTop: 4, fontSize: 9 }}>
              {engineReady
                ? t('pad.routeHint', { target: selected.targetStrip || selected.targetBus || t('pad.master') })
                : t('pad.routeHintOffline')}
            </div>
          </div>
        )}

        {samples.length > 0 && !selected && (
          <div style={{ fontSize: 9, color: 'var(--faint)', marginTop: 4, textAlign: 'center' }}>{t('pad.hint')}</div>
        )}

        {samples.length > 0 && (
          <>
            <button type="button" className="btn small" style={{ width: '100%', marginTop: 4 }} onClick={() => setSeqOpen((prev) => !prev)}>
              <Music size={11} /> {seqOpen ? t('pad.hideSequencer') : t('pad.sequencer')}
            </button>
            {seqOpen && (
              <Sequencer
                sampleIds={samples.map((sample) => sample.id)}
                sampleNames={Object.fromEntries(samples.map((sample) => [sample.id, sample.name]))}
                sampleColors={Object.fromEntries(samples.map((sample) => [sample.id, sample.color]))}
                onTrigger={(id, delayMs) => {
                  trigger(id, delayMs)
                }}
                onStop={(id) => stopPad(id)}
              />
            )}
          </>
        )}
      </div>
    </section>
  )
}

export default SoundPlayer
