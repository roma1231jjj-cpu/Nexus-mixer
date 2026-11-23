import { useState } from 'react'
import { Power } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { engineBridge } from '../lib/engineBridge'
import { startEngine, stopEngine } from '../lib/engineControl'
import { useT, useLocale } from '../i18n'

const API_LABEL: Record<string, string> = {
  'wasapi-shared': 'WASAPI shared',
  'wasapi-exclusive': 'WASAPI exclusive',
  asio: 'ASIO',
  'wdm-ks': 'WDM-KS',
}

export function StatusBar() {
  const t = useT()
  const locale = useLocale()
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
      notify(result.error ?? t('status.engineError'))
      return
    }
    notify(result.status?.running ? t('status.engineStarted') : t('status.engineStopped'))
  }

  return (
    <footer className="statusbar">
      <span className="status-item status-engine" data-tip={t('status.engineTip')}>
        <i className={`status-led${status.running ? ' on' : ''}${busy ? ' pending' : ''}`} />
        <b>
          {!engineBridge.available
            ? t('status.demo')
            : busy
              ? status.running
                ? t('status.stopping')
                : t('status.starting')
              : status.running
                ? t('status.running')
                : t('status.stopped')}
        </b>
      </span>

      {engineBridge.available ? (
        <button
          type="button"
          className={`status-power${status.running ? ' on' : ''}`}
          onClick={toggleEngine}
          disabled={busy}
          data-tip={status.running ? t('status.stopTip') : t('status.startTip')}
        >
          <Power size={10} />
          {busy ? '…' : status.running ? t('status.stop') : t('status.start')}
        </button>
      ) : null}

      <span className="status-item" data-tip={t('status.apiTip')}>{API_LABEL[status.api] ?? status.api}</span>
      <span className="status-item" data-tip={t('status.rateTip')}>
        {status.sampleRate.toLocaleString(locale)} Hz · {status.bufferSize}
      </span>
      <span className="status-item" data-tip={t('status.latencyTip')}>{status.latencyMs.toFixed(1)} ms</span>
      <span className="status-item" data-tip={t('status.cpuTip')}>CPU {status.cpuPercent.toFixed(1)}%</span>
      <span className="status-item" data-tip={t('status.xrunTip')}>XRUN {status.xruns}</span>

      <span className="status-item" data-tip={status.driver.message}>
        <span className={`status-chip${status.driver.installed ? ' good' : ' warn'}`}>
          <i />
          {status.driver.installed ? t('status.cable') : t('status.noCable')}
        </span>
      </span>

      <span className="status-item" data-tip={t('status.voiceTip')}>
        {t('status.voice')} {ai.enabled ? ai.mode.toUpperCase() : t('common.off')}
      </span>

      <span className="status-spacer" />
      <span className="status-signature">Nexus-Mixer 0.4.1</span>
    </footer>
  )
}
