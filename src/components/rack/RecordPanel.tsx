import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { BUS_ORDER } from '../../data/defaults'
import { formatTime } from '../../lib/format'
import type { BusId } from '../../types'
import { Select } from '../controls/Select'

export function RecordPanel() {
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
            aria-label={recorder.enabled ? 'Остановить запись' : 'Начать запись'}
            data-tip={recorder.enabled ? 'Остановить запись' : 'Начать запись выбранных шин'}
            onClick={() => {
              setRecorder({ enabled: !recorder.enabled })
              if (!recorder.enabled && !engineRunning) {
                notify('Запись включена. Она начнётся после запуска аудиодвижка')
              } else {
                notify(recorder.enabled ? 'Запись остановлена' : `Запись шин ${recorder.buses.join(', ')} начата`)
              }
            }}
          />
          <div className="rec-info">
            <div className="rec-title">
              {liveRecording ? 'ИДЁТ ЗАПИСЬ' : recorder.enabled ? 'ОЖИДАНИЕ ДВИЖКА' : 'ГОТОВ К ЗАПИСИ'}
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
          <label>Шины для записи</label>
          <div className="rec-buses">
            {BUS_ORDER.map((bus) => (
              <button
                key={bus}
                type="button"
                className={`mini-toggle${recorder.buses.includes(bus) ? ' on' : ''}`}
                onClick={() => toggleBuss(bus)}
                data-tip={`${recorder.buses.includes(bus) ? 'Убрать' : 'Добавить'} шину ${bus} (${buses[bus].name}) ${recorder.buses.includes(bus) ? 'из' : 'в'} запись`}
              >
                {bus}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <div className="field grow">
            <label htmlFor="rec-format">Формат</label>
            <Select
              value={recorder.format}
              options={[
                { value: 'wav', label: 'WAV (без потерь)' },
                { value: 'flac', label: 'FLAC — скоро', disabled: true },
                { value: 'mp3', label: 'MP3 — скоро', disabled: true },
              ]}
              onChange={(val) => setRecorder({ format: val as typeof recorder.format })}
              hint="Формат файла записи"
              small
            />
          </div>
          <div className="field" style={{ width: 92 }}>
            <label htmlFor="rec-depth">Битность</label>
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
          <label htmlFor="rec-dir">Папка назначения</label>
          <div className="field-row">
            <input
              id="rec-dir"
              className="text-input grow"
              placeholder="Музыка / Nexus-Mixer"
              value={recorder.directory}
              onChange={(event) => setRecorder({ directory: event.target.value })}
            />
            <button type="button" className="btn small" onClick={() => notify('Введите полный путь к папке вручную')}>
              <FolderOpen size={12} />
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="rec-split">Разбивать файл каждые</label>
          <Select
            value={String(recorder.splitMinutes)}
            options={[
              { value: '0', label: 'Не разбивать' },
              { value: '15', label: '15 минут' },
              { value: '30', label: '30 минут' },
              { value: '60', label: '60 минут' },
            ]}
            onChange={(val) => setRecorder({ splitMinutes: Number(val) })}
            small
          />
        </div>
      </div>

      <div className="fx-note">
        Запись идёт с выбранных шин после обработки. Сейчас пишется WAV (16/24-bit PCM
        или 32-bit float); FLAC/MP3 появятся вместе с кодеками. Файлы сохраняются
        в указанную папку.
      </div>
    </>
  )
}
