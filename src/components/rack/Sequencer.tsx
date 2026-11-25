import { Fragment, useState, useEffect, useRef } from 'react'
import { Play, Square, Music } from 'lucide-react'
import { StepSequencerState, createSequencer, toggleStep, STEPS } from '../../lib/sequencer'
import { loadSequencerPattern, saveSequencerPattern } from '../../lib/soundBank'
import { useT } from '../../i18n'

interface SequencerProps {
  sampleIds: string[]
  sampleNames: Record<string, string>
  sampleColors: Record<string, string>
  /** `delayMs` lets the engine start the voice sample-accurately. */
  onTrigger: (sampleId: string, delayMs?: number) => void
  onStop: (sampleId: string) => void
}

export function Sequencer({ sampleIds, sampleNames, sampleColors, onTrigger, onStop }: SequencerProps) {
  const t = useT()
  const [seq, setSeq] = useState<StepSequencerState>(() => {
    const base = createSequencer()
    const stored = loadSequencerPattern()
    return stored ? { ...base, pattern: stored.pattern, bpm: stored.bpm, swing: stored.swing } : base
  })
  const stepTimerRef = useRef<number | null>(null)

  const onTriggerRef = useRef(onTrigger)
  const onStopRef = useRef(onStop)
  const sampleIdsRef = useRef(sampleIds)
  const patternRef = useRef(seq.pattern)
  const bpmRef = useRef(seq.bpm)
  const stepIndexRef = useRef(0)
  const runningRef = useRef(seq.running)

  onTriggerRef.current = onTrigger
  onStopRef.current = onStop
  sampleIdsRef.current = sampleIds
  patternRef.current = seq.pattern
  bpmRef.current = seq.bpm
  runningRef.current = seq.running

  useEffect(() => {
    return () => {
      if (!runningRef.current) return
      runningRef.current = false
      for (const id of sampleIdsRef.current) onStopRef.current(id)
    }
  }, [])

  // Playback loop. Steps are scheduled against `performance.now()` instead of
  // being chained with `setTimeout(interval)` after each callback, so a late
  // timer does not push the whole pattern behind: the next step is always due at
  // `start + n * interval`. The engine receives the remaining delay, so a step
  // that we wake up late still lands on the audio grid.
  useEffect(() => {
    if (!seq.running) return
    let cancelled = false
    let nextDue = performance.now()
    let nextStep = 0
    let timer = 0
    const LOOKAHEAD = 25

    const intervalFor = () => 60000 / Math.max(1, bpmRef.current) / 4

    const fire = (step: number, delayMs: number) => {
      const pattern = patternRef.current
      for (const sampleId of sampleIdsRef.current) {
        if (pattern[sampleId]?.[step]) onTriggerRef.current(sampleId, delayMs)
      }
      setSeq((prev) => (prev.currentStep === step ? prev : { ...prev, currentStep: step }))
    }

    const tick = () => {
      if (cancelled) return
      const now = performance.now()
      // Catch up if the tab was throttled, but never fire more than 4 steps at
      // once — that would be a burst, not music.
      let guard = 0
      while (nextDue <= now + LOOKAHEAD && guard < 4) {
        const delayMs = Math.max(0, nextDue - now)
        fire(nextStep, delayMs)
        nextStep = (nextStep + 1) % STEPS
        nextDue += intervalFor()
        guard++
      }
      if (guard >= 4) nextDue = now + intervalFor()
      timer = window.setTimeout(tick, LOOKAHEAD)
    }

    stepIndexRef.current = 0
    nextDue = performance.now()
    tick()

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [seq.running])

  // Remember the pattern between openings and app restarts.
  useEffect(() => {
    if (!saveSequencerPattern(seq.pattern, seq.bpm, seq.swing)) {
      // Storage can be full or disabled; the pattern still works this session.
    }
  }, [seq.pattern, seq.bpm, seq.swing])

  const handleStart = () => {
    stepIndexRef.current = 0
    setSeq((prev) => ({ ...prev, running: true, currentStep: 0 }))
  }

  const handleStop = () => {
    if (stepTimerRef.current !== null) {
      window.clearTimeout(stepTimerRef.current)
      stepTimerRef.current = null
    }
    setSeq((prev) => ({ ...prev, running: false, currentStep: 0 }))
    for (const id of sampleIdsRef.current) onStopRef.current(id)
  }

  return (
    <div style={{
      marginTop: 8,
      padding: 8,
      borderRadius: 8,
      border: '1px solid var(--stroke)',
      background: 'var(--panel-inset)',
    }}>
      {/* Controls header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Music size={11} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 10, fontWeight: 700 }}>{t('seq.title')}</span>
        <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
          {t('seq.bpm')} {seq.bpm} · {t('seq.step')} {seq.currentStep + 1}/{STEPS}
        </span>
        <div style={{ flex: 1 }} />
        {seq.running ? (
          <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={handleStop} aria-label={t('pad.stop')}>
            <Square size={11} />
          </button>
        ) : (
          <button className="icon-btn" style={{ width: 22, height: 22, color: 'var(--good)' }} onClick={handleStart} aria-label={t('seq.play')}>
            <Play size={11} />
          </button>
        )}
      </div>

      {/* BPM control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 8, color: 'var(--faint)', width: 28 }}>{t('seq.bpm')}</span>
        <input
          type="range"
          min={40}
          max={300}
          step={1}
          value={seq.bpm}
          aria-label={t('seq.bpm')}
          onChange={(e) => setSeq((prev) => ({ ...prev, bpm: parseInt(e.target.value) }))}
          style={{ flex: 1, height: 3, accentColor: 'var(--accent)' }}
        />
        <input
          className="text-input"
          type="number"
          min={40}
          max={300}
          value={seq.bpm}
          aria-label={t('seq.bpm')}
          onChange={(e) => setSeq((prev) => ({ ...prev, bpm: Math.max(40, Math.min(300, parseInt(e.target.value) || 120)) }))}
          style={{ width: 44, height: 20, fontSize: 9, textAlign: 'center' }}
        />
      </div>

      {/* Pattern grid: rows = samples, columns = 16 steps */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `80px repeat(${STEPS}, 1fr)`,
        gap: 1,
        fontSize: 9,
        overflowX: 'auto',
      }}>
        {/* Header row: step numbers */}
        <div style={{ fontSize: 7, color: 'var(--faint)', display: 'flex', alignItems: 'center', paddingLeft: 4 }}>
          {t('seq.lanes')}
        </div>
        {Array.from({ length: STEPS }, (_, step) => (
          <div
            key={step}
            style={{
              textAlign: 'center',
              fontSize: 7,
              fontFamily: 'var(--font-mono)',
              color: step === seq.currentStep ? 'var(--accent-bright)' : 'var(--faint)',
              background: step === seq.currentStep && seq.running ? 'var(--accent-soft)' : undefined,
              borderRadius: 2,
              padding: '1px 0',
            }}
          >
            {step + 1}
          </div>
        ))}

        {/* Rows: one per sample */}
        {sampleIds.map((sid) => (
          <Fragment key={sid}>
            <div
              style={{
                display: 'flex', alignItems: 'center',
                color: sampleColors[sid] ?? 'var(--text)',
                fontSize: 7, fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                paddingRight: 4,
              }}
            >
              {sampleNames[sid] ?? sid}
            </div>
            {Array.from({ length: STEPS }, (_, step) => {
              const lanes = seq.pattern[sid]
              const active = lanes?.[step] ?? false
              return (
                <button
                  key={`${sid}-${step}`}
                  type="button"
                  onClick={() => setSeq((prev) => toggleStep(prev, sid, step))}
                  aria-pressed={active}
                  aria-label={`${sampleNames[sid] ?? sid} · ${t('seq.step')} ${step + 1}`}
                  style={{
                    width: '100%',
                    aspectRatio: '1',
                    borderRadius: 3,
                    border: '1px solid var(--stroke)',
                    background: active
                      ? sampleColors[sid] ?? 'var(--accent)'
                      : step % 4 === 0 ? 'rgba(255,255,255,0.04)' : undefined,
                    boxShadow: active ? `0 0 6px ${sampleColors[sid] ?? 'var(--accent)'}66` : undefined,
                    cursor: 'pointer',
                    transition: 'all 0.06s',
                    padding: 0,
                    minWidth: 12,
                    minHeight: 12,
                  }}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
