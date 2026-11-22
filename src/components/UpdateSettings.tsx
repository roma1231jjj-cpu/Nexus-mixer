import { RefreshCw } from 'lucide-react'
import { useUpdater } from '../store/useUpdater'

export function UpdateSettings() {
  const status = useUpdater((s) => s.status)
  const version = useUpdater((s) => s.version)
  const progress = useUpdater((s) => s.progress)
  const error = useUpdater((s) => s.error)
  const check = useUpdater((s) => s.check)
  const download = useUpdater((s) => s.download)
  const install = useUpdater((s) => s.install)

  const label =
    status === 'checking'
      ? 'Проверяем GitHub…'
      : status === 'current'
        ? 'Установлена актуальная версия'
        : status === 'available'
          ? `Доступна версия ${version}`
          : status === 'downloading'
            ? `Скачивание ${progress}%`
            : status === 'ready'
              ? `Версия ${version} скачана`
              : status === 'installing'
                ? 'Установка…'
                : status === 'error'
                  ? error ?? 'Ошибка проверки'
                  : 'Проверка обновлений'

  return (
    <div className="update-settings">
      <div className="update-settings-row">
        <span className={`dot ${status === 'current' ? 'good' : status === 'error' ? 'bad' : ''}`} />
        <span>{label}</span>
      </div>
      <div className="update-settings-actions">
        {status === 'available' ? (
          <button type="button" className="btn small grow" onClick={() => void download()}>
            Скачать
          </button>
        ) : null}
        {status === 'ready' ? (
          <button type="button" className="btn small grow" onClick={() => void install()}>
            Установить
          </button>
        ) : null}
        <button
          type="button"
          className="btn small"
          onClick={() => void check()}
          disabled={status === 'checking' || status === 'downloading' || status === 'installing'}
          title="Проверить обновления"
        >
          <RefreshCw size={12} /> Проверить
        </button>
      </div>
    </div>
  )
}
