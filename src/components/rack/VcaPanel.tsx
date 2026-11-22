import { Layers, Plus } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { STRIP_ORDER } from '../../data/defaults'
import { VcaGroupStrip } from './VcaGroupStrip'

export function VcaPanel() {
  const vcaGroups = useMixer((s) => s.vcaGroups)
  const vcaAddStrip = useMixer((s) => s.vcaAddStrip)
  const vcaRemoveStrip = useMixer((s) => s.vcaRemoveStrip)
  const setVcaGroups = useMixer((s) => s.setVcaGroups)
  const strips = useMixer((s) => s.strips)

  const addGroup = () => {
    const palette = ['#f43f5e', '#a78bfa', '#38bdf8', '#34d399', '#f59e0b', '#f472b6']
    const index = vcaGroups.length
    setVcaGroups([
      ...vcaGroups,
      {
        id: `vca-${Date.now().toString(36)}`,
        name: `GROUP ${index + 1}`,
        color: palette[index % palette.length],
        strips: [],
        gainDb: 0,
        mute: false,
      },
    ])
  }

  const removeGroup = (id: string) => {
    setVcaGroups(vcaGroups.filter((group) => group.id !== id))
  }

  return (
    <section className="fx-block" style={{ marginTop: 0 }}>
      <header className="fx-block-head">
        <span className="fx-icon">
          <Layers size={13} />
        </span>
        <span className="fx-title">VCA Groups</span>
        <span className="fx-sub">{vcaGroups.length} groups</span>
      </header>
      <div className="fx-block-body">
        {vcaGroups.map((group) => (
          <div key={group.id} className="vca-card">
            <VcaGroupStrip group={group} onRemove={() => removeGroup(group.id)} />
            <div className="vca-members">
              {STRIP_ORDER.map((sid) => {
                const assigned = group.strips.includes(sid)
                return (
                  <button
                    key={sid}
                    type="button"
                    className={`mini-toggle vca-member${assigned ? ' on' : ''}`}
                    style={
                      assigned
                        ? ({ '--vca-color': group.color } as React.CSSProperties)
                        : undefined
                    }
                    onClick={() =>
                      assigned
                        ? vcaRemoveStrip(group.id, sid)
                        : vcaAddStrip(group.id, sid)
                    }
                  >
                    {strips[sid].name}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <button type="button" className="btn small vca-add" onClick={addGroup}>
          <Plus size={11} /> Новая VCA-группа
        </button>
      </div>
    </section>
  )
}