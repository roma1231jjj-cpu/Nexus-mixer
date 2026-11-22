import { useState, useEffect, useRef } from 'react'
import { Play, Square, Music } from 'lucide-react'
import { StepSequencerState, createSequencer, toggleStep } from '../../lib/sequencer'

interface SequencerProps {
  sampleIds: string[]
  sampleNames: Record<string, string>
  sampleColors: Record<string, string>
  onTrigger: (sampleId: string) => void
  onStop: (sampleId: string) => void
}

export function Sequencer({ sampleIds, sampleNames, sampleColors, onTrigger, onStop }: SequencerProps) {
  const [seq, setSeq] = useState<StepSequencerState>(createSequencer)
  const stepTimerRef = useRef<number | null>(null)

  // BPM → interval in ms (16th notes)
  const stepInterval = seq.bpm > 0 ? (60000 / seq.bpm / 4) : 200

  // Playback loop
  useEffect(() => {
    if (!seq.running) {
      if (stepTimerRef.current) {
        clearInterval(stepTimerRef.current)
        stepTimerRef.current = null
      }
      return
    }

    const tick = () => {
      setSeq((prev) => {
        const nextStep = (prev.currentStep + 1) % 16
        // Fire samples on this step
        for (const sampleId of sampleIds) {
          const lanes = prev.pattern[sampleId]
          if (lanes && lanes[nextStep]) {
            onTrigger(sampleId)
          } else if (lanes && !lanes[nextStep]) {
            // Optionally stop if not playing this step
          }
        }
        return { ...prev, currentStep: nextStep }
      })
    }

    stepTimerRef.current = window.setInterval(tick, stepInterval)
    return () => { if (stepTimerRef.current) clearInterval(stepTimerRef.current) }
  }, [seq.running, seq.bpm, sampleIds.join(','), onTrigger])

  const handleStart = () => setSeq((prev) => ({ ...prev, running: true, currentStep: 0 }))
  const handleStop = () => {
    setSeq((prev) => ({ ...prev, running: false, currentStep: 0 }))
    // Stop all playing samples
    sampleIds.forEach((id) => onStop(id))
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
        <span style={{ fontSize: 10, fontWeight: 700 }}>Step Sequencer</span>
        <span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
          {seq.bpm} BPM · Step {seq.currentStep + 1}/16
        </span>
        <div style={{ flex: 1 }} />
        {seq.running ? (
          <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={handleStop}>
            <Square size={11} />
          </button>
        ) : (
          <button className="icon-btn" style={{ width: 22, height: 22, color: 'var(--good)' }} onClick={handleStart}>
            <Play size={11} />
          </button>
        )}
      </div>

      {/* BPM control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 8, color: 'var(--faint)', width: 28 }}>BPM</span>
        <input
          type="range"
          min={40}
          max={300}
          step={1}
          value={seq.bpm}
          onChange={(e) => setSeq((prev) => ({ ...prev, bpm: parseInt(e.target.value) }))}
          style={{ flex: 1, height: 3, accentColor: 'var(--accent)' }}
        />
        <input
          className="text-input"
          type="number"
          min={40}
          max={300}
          value={seq.bpm}
          onChange={(e) => setSeq((prev) => ({ ...prev, bpm: Math.max(40, Math.min(300, parseInt(e.target.value) || 120)) }))}
          style={{ width: 44, height: 20, fontSize: 9, textAlign: 'center' }}
        />
      </div>

      {/* Pattern grid: rows = samples, columns = 16 steps */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `80px repeat(16, 1fr)`,
        gap: 1,
        fontSize: 9,
        overflowX: 'auto',
      }}>
        {/* Header row: step numbers */}
        <div style={{ fontSize: 7, color: 'var(--faint)', display: 'flex', alignItems: 'center', paddingLeft: 4 }}>
          Lanes
        </div>
        {Array.from({ length: 16 }, (_, step) => (
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
          <>
            <div
              key={`label-${sid}`}
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
            {Array.from({ length: 16 }, (_, step) => {
              const lanes = seq.pattern[sid]
              const active = lanes?.[step] ?? false
              return (
                <button
                  key={`${sid}-${step}`}
                  type="button"
                  onClick={() => setSeq((prev) => toggleStep(prev, sid, step))}
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
          </>
        ))}
      </div>
    </div>
  )
}
