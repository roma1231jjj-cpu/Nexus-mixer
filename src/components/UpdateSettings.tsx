import { RefreshCw } from 'lucide-react'
import { useUpdater } from '../store/useUpdater'
import { useT } from '../i18n'

export function UpdateSettings() {
  const t = useT()
  const status = useUpdater((s) => s.status)
  const version = useUpdater((s) => s.version)
  const progress = useUpdater((s) => s.progress)
  const error = useUpdater((s) => s.error)
  const check = useUpdater((s) => s.check)
  const download = useUpdater((s) => s.download)
  const install = useUpdater((s) => s.install)

  const label =
    status === 'checking'
      ? t('updates.checking')
      : status === 'current'
        ? t('updates.current')
        : status === 'available'
          ? t('updates.available', { version: version ?? '' })
          : status === 'downloading'
            ? t('updates.downloading', { progress })
            : status === 'ready'
              ? t('updates.ready', { version: version ?? '' })
              : status === 'installing'
                ? t('updates.installing')
                : status === 'error'
                  ? (error ?? t('updates.error'))
                  : t('updates.check')

  return (
    <div className="update-settings">
      <div className="update-settings-row">
        <span className={`dot ${status === 'current' ? 'good' : status === 'error' ? 'bad' : ''}`} />
        <span>{label}</span>
      </div>
      <div className="update-settings-actions">
        {status === 'available' ? (
          <button type="button" className="btn small grow" onClick={() => void download()}>
            {t('updates.download')}
          </button>
        ) : null}
        {status === 'ready' ? (
          <button type="button" className="btn small grow" onClick={() => void install()}>
            {t('updates.install')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn small"
          onClick={() => void check()}
          disabled={status === 'checking' || status === 'downloading' || status === 'installing'}
          title={t('updates.checkTip')}
        >
          <RefreshCw size={12} /> {t('settings.check')}
        </button>
      </div>
    </div>
  )
}
