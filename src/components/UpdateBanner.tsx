import { Download, RefreshCw, Rocket, X } from 'lucide-react'
import { useUpdater } from '../store/useUpdater'

export function UpdateBanner() {
  const status = useUpdater((s) => s.status)
  const version = useUpdater((s) => s.version)
  const currentVersion = useUpdater((s) => s.currentVersion)
  const progress = useUpdater((s) => s.progress)
  const error = useUpdater((s) => s.error)
  const hidden = useUpdater((s) => s.hidden)
  const check = useUpdater((s) => s.check)
  const download = useUpdater((s) => s.download)
  const install = useUpdater((s) => s.install)
  const dismiss = useUpdater((s) => s.dismiss)

  if (hidden || status === 'idle' || status === 'checking' || status === 'current') return null

  return (
    <aside className={`update-banner ${status}`} role="status" aria-live="polite">
      <div className="update-banner-head">
        <span className="update-icon">
          {status === 'ready' ? <Rocket size={14} /> : status === 'error' ? <RefreshCw size={14} /> : <Download size={14} />}
        </span>
        <div className="update-copy">
          <b>
            {status === 'available' && `Nexus-Mixer ${version} доступен`}
            {status === 'downloading' && `Скачивание ${version}`}
            {status === 'ready' && `Nexus-Mixer ${version} готов`}
            {status === 'installing' && 'Запуск установщика…'}
            {status === 'error' && 'Не удалось проверить обновление'}
          </b>
          <span>
            {status === 'available' && 'Новая версия уже на GitHub. Можно скачать фоном.'}
            {status === 'downloading' && `${progress}% · приложение продолжает работать`}
            {status === 'ready' && 'Установка закроет приложение и перезапустит его.'}
            {status === 'installing' && 'Не закрывайте окно установщика.'}
            {status === 'error' && (error ?? 'Проверьте подключение и повторите.')}
          </span>
        </div>
        <button type="button" className="icon-btn update-dismiss" onClick={dismiss} aria-label="Скрыть уведомление">
          <X size={14} />
        </button>
      </div>

      {status === 'downloading' ? (
        <div className="update-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      <div className="update-actions">
        {status === 'available' ? (
          <button type="button" className="btn small grow" onClick={() => void download()}>
            <Download size={12} /> Скачать обновление
          </button>
        ) : null}
        {status === 'ready' ? (
          <button type="button" className="btn small grow" onClick={() => void install()}>
            <Rocket size={12} /> Установить и перезапустить
          </button>
        ) : null}
        {status === 'error' ? (
          <button type="button" className="btn small grow" onClick={() => void check()}>
            <RefreshCw size={12} /> Повторить
          </button>
        ) : null}
        {currentVersion && status !== 'ready' ? <span className="update-current">сейчас {currentVersion}</span> : null}
      </div>
    </aside>
  )
}
