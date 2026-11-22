import { useMixer } from '../store/useMixer'

export function MultiSelectBar() {
  const multiSelected = useMixer((s) => s.multiSelectedStripIds)
  const strips = useMixer((s) => s.strips)
  const setStrip = useMixer((s) => s.setStrip)

  if (multiSelected.length < 2) return null

  return (
    <div className="multi-bar">
      <span className="multi-count">{multiSelected.length} канала</span>
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
        Снять
      </button>
    </div>
  )
}
