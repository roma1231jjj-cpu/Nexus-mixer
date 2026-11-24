import { useEffect, useRef, useState, useCallback } from 'react'
import { Music, Square, Upload, Disc3, Radio, Anchor, Trash2, Volume2 } from 'lucide-react'
import { Sequencer } from './Sequencer'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { Knob } from '../controls/Knob'
import { Switch } from '../controls/Switch'
import { STRIP_ORDER, BUS_ORDER } from '../../data/defaults'
import {
  loadSamples,
  saveSamples,
  decodeAudioFile,
  playSample,
  type SoundSample,
  type SoundPadState,
} from '../../lib/soundBank'
import { Select } from '../controls/Select'
import { useT } from '../../i18n'

/* ──────────────────── Master volume for sound player ──────────────────── */

let _masterGain: GainNode | null = null
function getMasterGain(ctx: AudioContext): GainNode {
  if (!_masterGain || _masterGain.context !== ctx) {
    _masterGain = ctx.createGain()
    _masterGain.gain.value = 1
    _masterGain.connect(ctx.destination)
  }
  return _masterGain
}

export function getSoundMasterVolume(): number {
  return _masterGain?.gain.value ?? 1
}

export function setSoundMasterVolume(v: number) {
  if (_masterGain) _masterGain.gain.value = v
}

/* ──────────────────── Component ──────────────────── */

export function SoundPlayer() {
  const t = useT()
  const strips = useMixer((s) => s.strips) as Record<string, import('../../types').Strip>
  const buses = useMixer((s) => s.buses) as Record<string, import('../../types').Bus>
  const notify = useUi((s) => s.notify)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const [samples, setSamples] = useState<Omit<SoundSample, 'buffer'>[]>(() => loadSamples())
  const [buffers, setBuffers] = useState<Record<string, AudioBuffer>>({})
  const [padStates, setPadStates] = useState<Record<string, SoundPadState>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [masterVolume, setMasterVolume] = useState(1)
  const [dragOver, setDragOver] = useState(false)
  const [seqOpen, setSeqOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const padStatesRef = useRef<Record<string, SoundPadState>>({})

  // Init AudioContext on first interaction
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext()
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume()
    }
    return audioCtxRef.current
  }, [])

  // Save samples to localStorage when they change
  useEffect(() => {
    saveSamples(samples)
  }, [samples])

  // Pads are read from a ref so cleanup and callbacks never depend on the
  // current pad state (an effect that re-ran on every change used to close the
  // shared AudioContext whenever a sample was added or re-routed).
  useEffect(() => {
    padStatesRef.current = padStates
  }, [padStates])

  // Clean up on unmount only
  useEffect(() => {
    return () => {
      Object.values(padStatesRef.current).forEach((ps) => {
        if (!ps.playing) return
        try { ps.sourceNode?.stop() } catch { /* already stopped */ }
      })
      const ctx = audioCtxRef.current
      audioCtxRef.current = null
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    }
  }, [])

  /* ────────── file upload ────────── */

  const handleFiles = async (files: FileList) => {
    if (files.length === 0) return
    const ctx = getAudioCtx()
    const newSamples: Omit<SoundSample, 'buffer'>[] = []
    const newBuffers: Record<string, AudioBuffer> = {}

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!file.type.startsWith('audio/')) {
        notify(t('pad.notAudio', { name: file.name }))
        continue
      }
      try {
        const { sample, buffer } = await decodeAudioFile(file, ctx)
        newSamples.push(sample)
        newBuffers[sample.id] = buffer
      } catch {
        notify(t('pad.decodeFailed', { name: file.name }))
      }
    }

    if (newSamples.length > 0) {
      setSamples((prev) => [...prev, ...newSamples])
      setBuffers((prev) => ({ ...prev, ...newBuffers }))
      notify(t('pad.loaded', { n: newSamples.length }))
    }
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files)
    e.target.value = ''
  }

  // Drag & Drop
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true) }
  const handleDragLeave = () => setDragOver(false)
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files)
  }

  /* ────────── playback ────────── */

  const handlePlay = (id: string) => {
    const idx = samples.findIndex((s) => s.id === id)
    const sample = samples[idx]
    if (!sample) return
    const buffer = buffers[sample.id]
    if (!buffer) return

    const ctx = getAudioCtx()
    const state = padStates[sample.id]

    // If already playing, stop it
    if (state?.playing) {
      try { state.sourceNode?.stop() } catch { /* ignore */ }
      setPadStates((prev) => ({
        ...prev,
        [sample.id]: { playing: false, sourceNode: null, gainNode: null },
      }))
      return
    }

    // Route through master gain
    const master = getMasterGain(ctx)

    // If a target strip is selected, route through its gain/mute/solo
    let dest: AudioNode = master
    if (sample.targetStrip) {
      // Create a gain node that follows the strip's volume
      const stripGain = ctx.createGain()
      const strip = strips[sample.targetStrip]
      const audible = !strip.mute && (!Object.values(strips).some((s) => s.solo) || strip.solo)
      stripGain.gain.value = audible ? 10 ** ((strip.gainDb + 0) / 20) : 0
      stripGain.connect(master)
      dest = stripGain
    } else if (sample.targetBus) {
      const busGain = ctx.createGain()
      const bus = buses[sample.targetBus]
      busGain.gain.value = bus.mute ? 0 : 10 ** ((bus.gainDb + (bus.dim ? -20 : 0)) / 20)
      busGain.connect(master)
      dest = busGain
    }

    const { gainNode, sourceNode } = playSample(ctx, buffer, dest, {
      volume: sample.volume,
      pan: sample.pan,
      loop: sample.loop,
      pitchShift: sample.pitchShift,
    })

    sourceNode.onended = () => {
      setPadStates((prev) => ({
        ...prev,
        [sample.id]: { playing: false, sourceNode: null, gainNode: null },
      }))
    }

    setPadStates((prev) => ({
      ...prev,
      [sample.id]: { playing: true, gainNode, sourceNode },
    }))
  }

  const handleStopAll = () => {
    Object.values(padStatesRef.current).forEach((ps) => {
      if (ps.playing) {
        try { ps.sourceNode?.stop() } catch { /* ignore */ }
      }
    })
    setPadStates({})
  }

  const handleUpdate = (id: string, patch: Partial<Omit<SoundSample, 'buffer'>>) => {
    setSamples((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const handleDelete = (id: string) => {
    const sample = samples.find((s) => s.id === id)
    if (!sample) return
    const state = padStates[sample.id]
    if (state?.playing) {
      try { state.sourceNode?.stop() } catch { /* ignore */ }
    }
    setSamples((prev) => prev.filter((s) => s.id !== id))
    setBuffers((prev) => {
      const next = { ...prev }
      delete next[sample.id]
      return next
    })
    setPadStates((prev) => {
      const next = { ...prev }
      delete next[sample.id]
      return next
    })
    if (selectedId === id) setSelectedId(null)
  }

  const selected = selectedId ? samples.find((s) => s.id === selectedId) ?? null : null
  const playingCount = Object.values(padStates).filter((ps) => ps.playing).length

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
        <span className="fx-sub">{t('pad.samples', { n: samples.length })}{playingCount > 0 ? t('pad.playing', { n: playingCount }) : ''}</span>
        <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={handleStopAll} title="Stop All">
          <Square size={11} />
        </button>
      </header>
      <div className="fx-block-body">
        {/* Upload + Master Volume */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
          <button
            type="button"
            className="btn"
            style={{ flex: 1, height: 28 }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={12} /> {t('pad.upload')}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, width: 100 }}>
            <Volume2 size={10} style={{ color: 'var(--faint)' }} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={masterVolume}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setMasterVolume(v)
                setSoundMasterVolume(v)
              }}
              style={{ flex: 1, height: 3, accentColor: 'var(--accent)' }}
              title={t('pad.masterVolume', { n: Math.round(masterVolume * 100) })}
            />
            <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--faint)', width: 30, textAlign: 'right' }}>
              {Math.round(masterVolume * 100)}%
            </span>
          </div>
          {samples.length > 0 && (
            <button type="button" className="btn small" onClick={handleStopAll}>
              <Square size={11} /> {t('pad.stop')}
            </button>
          )}
        </div>

        {/* Pad grid, like on real hardware */}
        {samples.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3, marginBottom: 8 }}>
            {samples.map((sample) => {
              const state = padStates[sample.id]
              const isPlaying = state?.playing ?? false
              const isSelected = selectedId === sample.id
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
                    background: isPlaying
                      ? sample.color
                      : isSelected
                        ? sample.color + '33'
                        : undefined,
                    borderColor: isPlaying || isSelected ? sample.color : undefined,
                    borderWidth: isSelected ? 2 : 1,
                    boxShadow: isPlaying ? `0 0 20px ${sample.color}aa, inset 0 0 20px ${sample.color}44` : undefined,
                    color: isPlaying ? '#fff' : undefined,
                    transition: 'all 0.06s',
                    overflow: 'hidden',
                  }}
                  onClick={() => handlePlay(sample.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setSelectedId(isSelected ? null : sample.id)
                  }}
                >
                  <span style={{
                    fontSize: 7.5,
                    fontWeight: 700,
                    letterSpacing: 0.02,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                    lineHeight: 1.1,
                  }}>
                    {sample.name}
                  </span>
                  <span style={{
                    fontSize: 6.5,
                    fontFamily: 'var(--font-mono)',
                    opacity: 0.6,
                  }}>
                    {sample.duration.toFixed(1)}s
                  </span>
                  {/* Mini peak indicator */}
                  <div style={{
                    width: '100%',
                    height: 2,
                    borderRadius: 1,
                    background: isPlaying ? 'rgba(255,255,255,0.3)' : 'var(--stroke)',
                    marginTop: 1,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: isPlaying ? `${Math.random() * 40 + 10}%` : '0%',
                      background: '#fff',
                      borderRadius: 1,
                      transition: 'width 0.05s linear',
                    }} />
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

        {/* Selected sample detail panel */}
        {selected && (
          <div style={{
            marginTop: 4,
            padding: 8,
            borderRadius: 8,
            border: '1px solid var(--stroke)',
            background: 'var(--panel-inset)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Disc3 size={12} style={{ color: selected.color }} />
              <span style={{ fontSize: 11, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.name}
              </span>
              <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
                {(selected.duration).toFixed(1)}s · {(selected.sampleRate / 1000).toFixed(0)}kHz
              </span>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 20, height: 20, color: 'var(--bad)' }}
                onClick={() => handleDelete(selected.id)}
              >
                <Trash2 size={10} />
              </button>
            </div>

            <div className="knob-row compact" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <Knob
                label="VOL"
                value={selected.volume}
                min={0}
                max={1}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                defaultValue={0.8}
                size={36}
                color={selected.color}
                onChange={(v) => handleUpdate(selected.id, { volume: v })}
              />
              <Knob
                label="PAN"
                value={selected.pan}
                min={-1}
                max={1}
                step={0.01}
                format={(v) => Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`}
                defaultValue={0}
                size={36}
                color={selected.color}
                onChange={(v) => handleUpdate(selected.id, { pan: v })}
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
                onChange={(v) => handleUpdate(selected.id, { pitchShift: v })}
              />
              <Knob
                label="DURATION"
                value={selected.duration}
                min={0}
                max={Math.max(selected.duration * 2, 1)}
                step={0.1}
                format={(v) => `${v.toFixed(1)}s`}
                defaultValue={selected.duration}
                size={36}
                disabled
                onChange={() => {}}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <label className="checkline" style={{ fontSize: 10 }}>
                <Switch
                  on={selected.loop}
                  onChange={(v) => handleUpdate(selected.id, { loop: v })}
                  ariaLabel={t('pad.loopAria')}
                />
                Loop
              </label>

              <div style={{ flex: 1 }} />

              {/* Target Strip */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Radio size={11} style={{ color: 'var(--faint)' }} />
                <Select
                  value={selected.targetStrip}
                  options={[
                    { value: '', label: t('pad.master') },
                    ...STRIP_ORDER.map((id) => ({ value: id, label: strips[id].name })),
                  ]}
                  onChange={(val) => handleUpdate(selected.id, { targetStrip: val, targetBus: '' })}
                  small
                />
              </div>

              {/* Target Bus */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Anchor size={11} style={{ color: 'var(--faint)' }} />
                <Select
                  value={selected.targetBus}
                  options={[
                    { value: '', label: '—' },
                    ...BUS_ORDER.map((id) => ({ value: id, label: id })),
                  ]}
                  onChange={(val) => handleUpdate(selected.id, { targetBus: val, targetStrip: '' })}
                  small
                />
              </div>
            </div>
          </div>
        )}

        {/* Help text */}
        {samples.length > 0 && !selected && (
          <div style={{ fontSize: 9, color: 'var(--faint)', marginTop: 4, textAlign: 'center' }}>
            {t('pad.hint')}
          </div>
        )}

        {/* Sequencer */}
        {samples.length > 0 && (
          <>
            <button
              type="button"
              className="btn small"
              style={{ width: '100%', marginTop: 4 }}
              onClick={() => setSeqOpen((prev) => !prev)}
            >
              <Music size={11} /> {seqOpen ? t('pad.hideSequencer') : t('pad.sequencer')}
            </button>
            {seqOpen && (
              <Sequencer
                sampleIds={samples.map((s) => s.id)}
                sampleNames={Object.fromEntries(samples.map((s) => [s.id, s.name]))}
                sampleColors={Object.fromEntries(samples.map((s) => [s.id, s.color]))}
                onTrigger={(id) => {
                  const idx = samples.findIndex((s) => s.id === id)
                  if (idx >= 0) handlePlay(id)
                }}
                onStop={(id) => {
                  const state = padStatesRef.current[id]
                  if (state?.playing) {
                    try { state.sourceNode?.stop() } catch { /* ignore */ }
                    setPadStates((prev) => ({ ...prev, [id]: { playing: false, sourceNode: null, gainNode: null } }))
                  }
                }}
              />
            )}
          </>
        )}
      </div>
    </section>
  )
}

export default SoundPlayer
