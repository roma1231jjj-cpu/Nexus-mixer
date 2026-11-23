import { useRef } from 'react'
import { VolumeX } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { windowControls, type WindowAction } from '../lib/window'
import { HFader } from './controls/HFader'
import { dbLabel } from '../lib/format'
import { useT } from '../i18n'

export function TitleBar() {
  const t = useT()
  const masterGainDb = useMixer((s) => s.masterGainDb)
  const sourceCount = useMixer((s) => s.sourceCount)
  const setMasterGainDb = useMixer((s) => s.setMasterGainDb)
  const notify = useUi((s) => s.notify)
  const isMuted = masterGainDb <= -60
  const restoreGain = useRef(0)

  const runWindowAction = (action: WindowAction) => {
    void windowControls[action]()
      .then((handled) => {
        if (!handled) notify(t('titlebar.windowUnsupported'))
      })
      .catch(() => notify(t('titlebar.windowFailed')))
  }

  const toggleMasterMute = () => {
    if (isMuted) {
      setMasterGainDb(restoreGain.current)
    } else {
      restoreGain.current = masterGainDb
      setMasterGainDb(-60)
    }
  }

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true">
          <img src="/icon.svg" alt="" width={34} height={34} />
        </span>
        <span className="brand-name">
          Nexus<span>Mixer</span>
        </span>
        <span className="brand-sign">{t('brand.sign')}</span>
      </div>

      <div className="titlebar-center" aria-hidden="true">
        <span>{t('titlebar.centerIn', { count: sourceCount })}</span>
        <i />
        <span>{t('titlebar.centerOut')}</span>
        <i />
        <span>{t('titlebar.centerCable')}</span>
      </div>

      <div className="titlebar-right">
        <div className="master-cluster no-drag">
          <span className="master-label">{t('titlebar.master')}</span>
          <HFader
            value={masterGainDb}
            onChange={setMasterGainDb}
            min={-60}
            max={12}
            ariaLabel={t('titlebar.gainAria')}
            hint={t('titlebar.gainHint')}
          />
          <span className={`master-db${isMuted ? ' muted' : ''}`}>{dbLabel(masterGainDb)}</span>
          <button
            type="button"
            className={`master-mute${isMuted ? ' on' : ''}`}
            onClick={toggleMasterMute}
            aria-label={isMuted ? t('titlebar.muteOn') : t('titlebar.muteOff')}
            data-tip={isMuted ? t('titlebar.muteTipOn') : t('titlebar.muteTipOff')}
            data-tip-pos="bottom"
          >
            <VolumeX size={13} />
            <span>{isMuted ? 'OFF' : 'MUTE'}</span>
          </button>
        </div>

        <div className="win-controls">
          <button type="button" className="win-btn" aria-label={t('titlebar.minimize')} onClick={() => runWindowAction('minimize')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="win-btn" aria-label={t('titlebar.maximize')} onClick={() => runWindowAction('toggleMaximize')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="2" y="2" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
            </svg>
          </button>
          <button type="button" className="win-btn close" aria-label={t('titlebar.close')} onClick={() => runWindowAction('close')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
