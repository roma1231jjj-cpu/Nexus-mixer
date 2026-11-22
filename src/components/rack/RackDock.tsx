import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { StripFx } from './StripFx'
import { BusFx } from './BusFx'
import { AiPanel } from './AiPanel'
import { MacroPanel } from './MacroPanel'
import { RecordPanel } from './RecordPanel'
import { GlobalEq } from './GlobalEq'
import { ScenePanel } from './ScenePanel'
import { SoundPlayer } from './SoundPlayer'
import { MidiLearnPanel } from '../MidiLearnPanel'
import { VcaPanel } from './VcaPanel'

const TITLES: Record<string, string> = {
  fx: 'Канал',
  ai: 'Nexus Voice AI',
  macros: 'Макросы и сцены',
  record: 'Запись',
  sound: 'Пэды',
  groups: 'Группы VCA',
}

export function RackDock({ onClose }: { onClose: () => void }) {
  const tab = useMixer((s) => s.rackTab)
  const selectionKind = useMixer((s) => s.selectionKind)
  const strip = useMixer((s) => s.strips[s.selectedStripId])
  const bus = useMixer((s) => s.buses[s.selectedBusId])

  const target = selectionKind === 'strip' ? strip : bus
  const title =
    tab === 'fx'
      ? selectionKind === 'strip'
        ? 'Канал'
        : 'Выход'
      : TITLES[tab] ?? 'Рэк'
  const sub =
    tab === 'fx'
      ? selectionKind === 'strip'
        ? `${strip.name} · канал`
        : `${bus.id} · ${bus.name}`
      : tab === 'ai'
        ? 'локально · приватно'
        : tab === 'record'
          ? 'WAV после фейдера'
          : 'сессия'

  let content: ReactNode
  switch (tab) {
    case 'fx':
      content = (
        <>
          <div className="rack-target">
            <span
              className="rack-dot"
              style={{ background: target.color, boxShadow: `0 0 10px ${target.color}` }}
              aria-hidden="true"
            />
            <span className="rack-target-name">{target.name}</span>
            <span className="rack-target-kind">{selectionKind === 'strip' ? 'STRIP' : `BUS ${bus.id}`}</span>
          </div>
          {selectionKind === 'strip' ? <StripFx strip={strip} /> : <BusFx bus={bus} />}
          <MidiLearnPanel />
          <GlobalEq />
        </>
      )
      break
    case 'ai':
      content = <AiPanel />
      break
    case 'macros':
      content = (
        <>
          <MacroPanel />
          <ScenePanel />
        </>
      )
      break
    case 'record':
      content = <RecordPanel />
      break
    case 'sound':
      content = <SoundPlayer />
      break
    case 'groups':
      content = <VcaPanel />
      break
    default:
      content = null
  }

  return (
    <aside className="rack-dock" aria-label="Панель обработки">
      <div className="rack-content">
        <header className="rack-header">
          <div className="rack-header-titles">
            <span className="rack-title">{title}</span>
            <span className="rack-sub">{sub}</span>
          </div>
          <span className="rack-selection-dot" style={{ background: tab === 'fx' ? target.color : 'var(--accent)' }} />
          <button
            type="button"
            className="icon-btn rack-close"
            onClick={onClose}
            aria-label="Закрыть панель"
            data-tip="Закрыть панель (Esc)"
          >
            <X size={16} />
          </button>
        </header>
        <div className="rack-body">{content}</div>
      </div>
    </aside>
  )
}
