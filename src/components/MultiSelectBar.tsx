import { useMixer } from '../store/useMixer'
import { useT } from '../i18n'

export function MultiSelectBar() {
  const t = useT()
  const multiSelected = useMixer((s) => s.multiSelectedStripIds)
  const strips = useMixer((s) => s.strips)
  const setStrip = useMixer((s) => s.setStrip)

  if (multiSelected.length < 2) return null

  return (
    <div className="multi-bar">
      <span className="multi-count">{t('multi.count', { count: multiSelected.length })}</span>
      <button
        type="button"
        className="mini-toggle"
        onClick={() => {
          multiSelected.forEach((sid) => setStrip(sid, { mute: !strips[sid].mute }))
        }}
      >
        Mute
      </button>
      <button
        type="button"
        className="mini-toggle solo"
        onClick={() => {
          const someSolo = multiSelected.some((sid) => strips[sid].solo)
          multiSelected.forEach((sid) => setStrip(sid, { solo: !someSolo }))
        }}
      >
        Solo
      </button>
      <button
        type="button"
        className="mini-toggle"
        onClick={() => {
          multiSelected.forEach((sid) => setStrip(sid, { gainDb: 0 }))
        }}
      >
        0 dB
      </button>
      <button
        type="button"
        className="mini-toggle"
        onClick={() => useMixer.getState().clearMultiSelection()}
      >
        {t('multi.clear')}
      </button>
    </div>
  )
}
