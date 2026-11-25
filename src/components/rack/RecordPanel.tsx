import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { BUS_ORDER } from '../../data/defaults'
import { formatTime } from '../../lib/format'
import type { BusId, RecorderSettings } from '../../types'
import { Select } from '../controls/Select'
import { useT } from '../../i18n'

/** Tauri API is only reachable inside the desktop shell, not in a browser tab. */
const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Notice codes the backend may put into `RecorderStatus.notice`. */
const NOTICE_SPLIT_BY_SIZE = 'splitBySize'

export function RecordPanel() {
  const t = useT()
  const recorder = useMixer((s) => s.recorder)
  const recorderStatus = useMixer((s) => s.recorderStatus)
  const setRecorder = useMixer((s) => s.setRecorder)
  const buses = useMixer((s) => s.buses)
  const engineRunning = useMixer((s) => s.status.running)
  const notify = useUi((s) => s.notify)

  const live = recorderStatus?.recording ?? false
  const noBuses = recorder.buses.length === 0

  // Timer. The backend frame counter is the only time source: a local counter
  // is used strictly until the first status poll arrives (engine just started)
  // and can therefore never run ahead of the file.
  const reserveActive = recorder.enabled && engineRunning && recorderStatus === null
  const [reserve, setReserve] = useState(0)
  useEffect(() => {
    if (!reserveActive) {
      setReserve(0)
      return
    }
    const startedAt = Date.now()
    setReserve(0)
    const timer = window.setInterval(() => {
      setReserve(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [reserveActive])

  // Elapsed time of the take: live from the backend, frozen at the last value
  // after the stop, and never borrowed from a previous take while arming.
  const backendSeconds = live
    ? (recorderStatus?.seconds ?? null)
    : !recorder.enabled && recorderStatus?.file
      ? recorderStatus.seconds
      : null
  const displaySeconds = backendSeconds === null ? reserve : Math.floor(backendSeconds)

  // "Recording started" is reported only once the writer has a file open, and
  // "stopped" only after the backend confirms that the take is closed.
  const confirmedRef = useRef(false)
  const wasLiveRef = useRef(false)
  const errorSeenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!recorderStatus) return
    const file = recorderStatus.file
    if (recorderStatus.recording && file) {
      if (!confirmedRef.current) {
        confirmedRef.current = true
        const recorded = recorderStatus.buses.length ? recorderStatus.buses : recorder.buses
        notify(t('rec.startedFile', { buses: recorded.join(', '), file }))
      }
    } else if (!recorder.enabled) {
      if (wasLiveRef.current) notify(file ? t('rec.stoppedFile', { file }) : t('rec.stopped'))
      confirmedRef.current = false
    }
    wasLiveRef.current = recorderStatus.recording
  }, [recorderStatus, recorder.enabled, recorder.buses, notify, t])

  // The backend keeps the last error until a start succeeds, so surface every
  // new one exactly once.
  useEffect(() => {
    const error = recorderStatus?.error ?? null
    if (error && error !== errorSeenRef.current) notify(error)
    errorSeenRef.current = error
  }, [recorderStatus?.error, notify])

  // Older persisted sessions could select a format the Rust writer does not
  // support yet. Coerce it instead of failing at record time.
  useEffect(() => {
    if (recorder.format !== 'wav') setRecorder({ format: 'wav' })
  }, [recorder.format, setRecorder])

  /**
   * Settings the writer can only apply by opening a file: buses, bit depth,
   * format, folder and the split interval. They are stored right away but the
   * running take keeps its own snapshot, so the user is told about it.
   */
  const applySessionSettings = (patch: Partial<RecorderSettings>) => {
    setRecorder(patch)
    if (recorder.enabled) notify(t('rec.appliesAfterStop'))
  }

  const toggleBus = (bus: BusId) => {
    const next = recorder.buses.includes(bus)
      ? recorder.buses.filter((item) => item !== bus)
      : [...recorder.buses, bus]
    applySessionSettings({ buses: next })
  }

  const toggleRecording = () => {
    if (recorder.enabled) {
      setRecorder({ enabled: false })
      notify(t('rec.stopping'))
      return
    }
    if (noBuses) {
      notify(t('rec.needBus'))
      return
    }
    setRecorder({ enabled: true })
    notify(engineRunning ? t('rec.starting') : t('rec.pending'))
  }

  const pickDirectory = async () => {
    if (!isDesktop) {
      notify(t('rec.dirDesktopOnly'))
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({
        directory: true,
        multiple: false,
        title: t('rec.dirPick'),
        defaultPath: recorder.directory || undefined,
      })
      if (typeof picked !== 'string' || !picked) return
      setRecorder({ directory: picked })
      if (recorder.enabled) notify(t('rec.appliesAfterStop'))
      else notify(t('rec.dirPicked', { path: picked }))
    } catch (error) {
      notify(t('rec.dirFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const title = live
    ? recorder.enabled
      ? t('rec.stateLive')
      : t('rec.stateStopping')
    : recorder.enabled
      ? recorderStatus?.error
        ? t('rec.stateFailed')
        : engineRunning
          ? t('rec.stateStarting')
          : t('rec.stateWaiting')
      : t('rec.stateReady')

  const metaBuses = live && recorderStatus?.buses.length ? recorderStatus.buses : recorder.buses
  const metaBits = live && recorderStatus?.bitDepth ? recorderStatus.bitDepth : recorder.bitDepth
  const notice = recorderStatus?.notice ?? null
  const blocked = noBuses && !recorder.enabled

  return (
    <>
      <div className="rec-card">
        <div className="rec-top">
          <button
            type="button"
            className={`rec-big${live ? ' recording' : ''}`}
            aria-label={recorder.enabled ? t('rec.stopAria') : t('rec.startAria')}
            aria-disabled={blocked}
            disabled={blocked}
            style={blocked ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            data-tip={
              blocked ? t('rec.needBusTip') : recorder.enabled ? t('rec.stopAria') : t('rec.startTip')
            }
            onClick={toggleRecording}
          />
          <div className="rec-info">
            <div className="rec-title">{title}</div>
            <div className="rec-time">{formatTime(displaySeconds)}</div>
            <div className="rec-meta">
              {recorder.format.toUpperCase()} · {metaBits}-bit · {metaBuses.length} bus
              {recorderStatus?.droppedFrames ? ` · drop ${recorderStatus.droppedFrames}` : ''}
            </div>
          </div>
        </div>

        {recorderStatus?.file ? (
          <div className="rec-file" title={recorderStatus.file}>
            {recorderStatus.file}
          </div>
        ) : null}
        {notice ? (
          <div className="rec-file">
            {notice === NOTICE_SPLIT_BY_SIZE ? t('rec.noticeSplitBySize') : notice}
          </div>
        ) : null}
        {recorderStatus?.pendingChanges ? (
          <div className="rec-file">{t('rec.pendingParams')}</div>
        ) : null}
        {recorderStatus?.error ? <div className="rec-error">{recorderStatus.error}</div> : null}
        {noBuses ? <div className="rec-error">{t('rec.needBus')}</div> : null}

        <div className="field">
          <label>{t('rec.buses')}</label>
          <div className="rec-buses">
            {BUS_ORDER.map((bus) => (
              <button
                key={bus}
                type="button"
                className={`mini-toggle${recorder.buses.includes(bus) ? ' on' : ''}`}
                onClick={() => toggleBus(bus)}
                data-tip={
                  recorder.buses.includes(bus)
                    ? t('rec.removeBus', { bus, name: buses[bus].name })
                    : t('rec.addBus', { bus, name: buses[bus].name })
                }
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
              onChange={(val) => applySessionSettings({ format: val as RecorderSettings['format'] })}
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
              onChange={(val) =>
                applySessionSettings({ bitDepth: Number(val) as RecorderSettings['bitDepth'] })
              }
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
            <button
              type="button"
              className="btn small"
              data-tip={t('rec.dirPick')}
              onClick={() => void pickDirectory()}
            >
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
            onChange={(val) => applySessionSettings({ splitMinutes: Number(val) })}
            small
          />
        </div>
      </div>

      <div className="fx-note">{t('rec.note')}</div>
    </>
  )
}

export default RecordPanel
