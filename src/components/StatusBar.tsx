import { useState } from 'react'
import { Power } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { engineBridge } from '../lib/engineBridge'
import { startEngine, stopEngine } from '../lib/engineControl'

const API_LABEL: Record<string, string> = {
  'wasapi-shared': 'WASAPI shared',
  'wasapi-exclusive': 'WASAPI exclusive',
  asio: 'ASIO',
  'wdm-ks': 'WDM-KS',
}

export function StatusBar() {
  const status = useMixer((s) => s.status)
  const ai = useMixer((s) => s.ai)
  const notify = useUi((s) => s.notify)
  const [busy, setBusy] = useState(false)

  const toggleEngine = async () => {
    if (busy) return
    setBusy(true)
    const result = status.running ? await stopEngine() : await startEngine()
    setBusy(false)
    if (!result.ok) {
      notify(result.error ?? 'Ошибка аудиодвижка')
      return
    }
    notify(result.status?.running ? 'Аудиодвижок запущен' : 'Аудиодвижок остановлен')
  }

  return (
    <footer className="statusbar">
      <span className="status-item status-engine" data-tip="Состояние аудиодвижка Nexus-Mixer">
        <i className={`status-led${status.running ? ' on' : ''}${busy ? ' pending' : ''}`} />
        <b>
          {!engineBridge.available
            ? 'DEMO'
            : busy
              ? status.running
                ? 'STOPPING…'
                : 'STARTING…'
              : status.running
                ? 'RUNNING'
                : 'STOPPED'}
        </b>
      </span>

      {engineBridge.available ? (
        <button
          type="button"
          className={`status-power${status.running ? ' on' : ''}`}
          onClick={toggleEngine}
          disabled={busy}
          data-tip={status.running ? 'Остановить аудиодвижок' : 'Запустить аудиодвижок'}
        >
          <Power size={10} />
          {busy ? '…' : status.running ? 'STOP' : 'START'}
        </button>
      ) : null}

      <span className="status-item" data-tip="Аудио API">{API_LABEL[status.api] ?? status.api}</span>
      <span className="status-item" data-tip="Частота / буфер">
        {status.sampleRate.toLocaleString('ru-RU')} Hz · {status.bufferSize}
      </span>
      <span className="status-item" data-tip="Задержка">{status.latencyMs.toFixed(1)} ms</span>
      <span className="status-item" data-tip="Загрузка ЦП">CPU {status.cpuPercent.toFixed(1)}%</span>
      <span className="status-item" data-tip="Пропуски (должно быть 0)">XRUN {status.xruns}</span>

      <span className="status-item" data-tip={status.driver.message}>
        <span className={`status-chip${status.driver.installed ? ' good' : ' warn'}`}>
          <i />
          {status.driver.installed ? 'кабель' : 'нет кабеля'}
        </span>
      </span>

      <span className="status-item" data-tip="ИИ-конверсия голоса">
        Voice {ai.enabled ? ai.mode.toUpperCase() : 'off'}
      </span>

      <span className="status-spacer" />
      <span className="status-signature">Nexus-Mixer 0.3.1</span>
    </footer>
  )
}
