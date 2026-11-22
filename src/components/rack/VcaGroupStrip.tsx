import { HFader } from '../controls/HFader'
import { X } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { dbLabel } from '../../lib/format'
import type { VcaGroup } from '../../types'

export function VcaGroupStrip({ group, onRemove }: { group: VcaGroup; onRemove?: () => void }) {
  const setVcaGain = useMixer((s) => s.setVcaGain)
  const setVcaMute = useMixer((s) => s.setVcaMute)
  const vcaRename = useMixer((s) => s.vcaRename)

  return (
    <div className="vca-group" style={{ '--vca-color': group.color, '--bus-color': group.color } as React.CSSProperties}>
      <div className="vca-head">
        <span className="vca-dot" style={{ background: group.color, boxShadow: `0 0 8px ${group.color}` }} />
        <input
          className="vca-name"
          value={group.name}
          onChange={(event) => vcaRename(group.id, event.target.value)}
          aria-label="Название VCA-группы"
        />
        <span className="vca-count" title="Каналов в группе">{group.strips.length}</span>
        <span className="vca-db">{dbLabel(group.gainDb)} dB</span>
        <button
          type="button"
          className={`mini-toggle mute${group.mute ? ' on' : ''}`}
          aria-pressed={group.mute}
          onClick={() => setVcaMute(group.id, !group.mute)}
          title="Mute группы"
        >
          M
        </button>
        {onRemove ? (
          <button type="button" className="vca-remove" aria-label="Удалить группу" onClick={onRemove} title="Удалить группу">
            <X size={10} />
          </button>
        ) : null}
      </div>
      <div className="vca-fader-row">
        <HFader
          value={group.gainDb}
          color={group.color}
          ariaLabel={`Громкость VCA ${group.name}`}
          onChange={(value) => setVcaGain(group.id, value)}
        />
      </div>
    </div>
  )
}
