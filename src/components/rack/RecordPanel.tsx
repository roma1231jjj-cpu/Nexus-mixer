import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { BUS_ORDER } from '../../data/defaults'
import { formatTime } from '../../lib/format'
import type { BusId } from '../../types'
import { Select } from '../controls/Select'
import { useT } from '../../i18n'

export function RecordPanel() {
  const t = useT()
  const recorder = useMixer((s) => s.recorder)
  const recorderStatus = useMixer((s) => s.recorderStatus)
  const setRecorder = useMixer((s) => s.setRecorder)
  const buses = useMixer((s) => s.buses)
  const engineRunning = useMixer((s) => s.status.running)
  const notify = useUi((s) => s.notify)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef<number>(recorder.enabled ? Date.now() : 0)

  useEffect(() => {
    if (!recorder.enabled) {
      setElapsed(0)
      startedAt.current = 0
      return
    }
    if (!startedAt.current) startedAt.current = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [recorder.enabled])

  // Older persisted sessions could select a format the Rust writer does not
  // support yet. Coerce it instead of failing at record time.
  useEffect(() => {
    if (recorder.format !== 'wav') setRecorder({ format: 'wav' })
  }, [recorder.format, setRecorder])

  const toggleBuss = (bus: BusId) => {
    const next = recorder.buses.includes(bus)
      ? recorder.buses.filter((item) => item !== bus)
      : [...recorder.buses, bus]
    setRecorder({ buses: next })
  }

  const liveRecording = recorderStatus?.recording ?? false
  const displaySeconds = liveRecording && recorderStatus ? Math.max(elapsed, Math.floor(recorderStatus.seconds)) : elapsed

  return (
    <>
      <div className="rec-card">
        <div className="rec-top">
          <button
            type="button"
            className={`rec-big${recorder.enabled ? ' recording' : ''}`}
            aria-label={recorder.enabled ? t('rec.stopAria') : t('rec.startAria')}
            data-tip={recorder.enabled ? t('rec.stopAria') : t('rec.startTip')}
            onClick={() => {
              setRecorder({ enabled: !recorder.enabled })
              if (!recorder.enabled && !engineRunning) {
                notify(t('rec.pending'))
              } else {
                notify(recorder.enabled ? t('rec.stopped') : t('rec.started', { buses: recorder.buses.join(', ') }))
              }
            }}
          />
          <div className="rec-info">
            <div className="rec-title">
              {liveRecording ? t('rec.stateLive') : recorder.enabled ? t('rec.stateWaiting') : t('rec.stateReady')}
            </div>
            <div className="rec-time">{formatTime(displaySeconds)}</div>
            <div className="rec-meta">
              {recorder.format.toUpperCase()} · {recorder.bitDepth}-bit · {recorder.buses.length} bus
              {recorderStatus?.droppedFrames ? ` · drop ${recorderStatus.droppedFrames}` : ''}
            </div>
          </div>
        </div>

        {recorderStatus?.file ? (
          <div className="rec-file" title={recorderStatus.file}>
            {recorderStatus.file}
          </div>
        ) : null}
        {recorderStatus?.error ? <div className="rec-error">{recorderStatus.error}</div> : null}

        <div className="field">
          <label>{t('rec.buses')}</label>
          <div className="rec-buses">
            {BUS_ORDER.map((bus) => (
              <button
                key={bus}
                type="button"
                className={`mini-toggle${recorder.buses.includes(bus) ? ' on' : ''}`}
                onClick={() => toggleBuss(bus)}
                data-tip={recorder.buses.includes(bus) ? t('rec.removeBus', { bus, name: buses[bus].name }) : t('rec.addBus', { bus, name: buses[bus].name })}
              >
                {bus}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <div className="field grow">
            <label htmlFor="rec-format">{t('rec.format')}</label>
            <Select
              value={recorder.format}
              options={[
                { value: 'wav', label: t('rec.wavLossless') },
                { value: 'flac', label: `FLAC ${t('rec.soon')}`, disabled: true },
                { value: 'mp3', label: `MP3 ${t('rec.soon')}`, disabled: true },
              ]}
              onChange={(val) => setRecorder({ format: val as typeof recorder.format })}
              hint={t('rec.formatHint')}
              small
            />
          </div>
          <div className="field" style={{ width: 92 }}>
            <label htmlFor="rec-depth">{t('rec.bitDepth')}</label>
            <Select
              value={String(recorder.bitDepth)}
              options={[
                { value: '16', label: '16' },
                { value: '24', label: '24' },
                { value: '32', label: '32 float' },
              ]}
              onChange={(val) => setRecorder({ bitDepth: Number(val) as typeof recorder.bitDepth })}
              small
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="rec-dir">{t('rec.dir')}</label>
          <div className="field-row">
            <input
              id="rec-dir"
              className="text-input grow"
              placeholder={t('rec.dirPlaceholder')}
              value={recorder.directory}
              onChange={(event) => setRecorder({ directory: event.target.value })}
            />
            <button type="button" className="btn small" onClick={() => notify(t('rec.dirNote'))}>
              <FolderOpen size={12} />
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="rec-split">{t('rec.split')}</label>
          <Select
            value={String(recorder.splitMinutes)}
            options={[
              { value: '0', label: t('rec.splitNo') },
              { value: '15', label: t('rec.minutes', { n: 15 }) },
              { value: '30', label: t('rec.minutes', { n: 30 }) },
              { value: '60', label: t('rec.minutes', { n: 60 }) },
            ]}
            onChange={(val) => setRecorder({ splitMinutes: Number(val) })}
            small
          />
        </div>
      </div>

      <div className="fx-note">{t('rec.note')}</div>
    </>
  )
}

export default RecordPanel
