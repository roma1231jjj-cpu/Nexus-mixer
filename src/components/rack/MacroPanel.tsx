import { useState } from 'react'
import { Plus, Trash2, Zap } from 'lucide-react'
import type { MacroAction } from '../../types'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { BUS_ORDER, STRIP_ORDER } from '../../data/defaults'
import { Select } from '../controls/Select'

const ACTION_TYPES: { value: MacroAction['type']; label: string }[] = [
  { value: 'panic', label: 'Panic mute all' },
  { value: 'mute', label: 'Mute канал' },
  { value: 'route', label: 'Маршрут на шину' },
  { value: 'preset', label: 'Пресет' },
  { value: 'ai', label: 'AI вкл/выкл' },
  { value: 'gain', label: 'Гейн канала' },
]

export function MacroPanel() {
  const macros = useMixer((s) => s.macros)
  const presets = useMixer((s) => s.presets)
  const strips = useMixer((s) => s.strips)
  const runMacro = useMixer((s) => s.runMacro)
  const addMacro = useMixer((s) => s.addMacro)
  const updateMacro = useMixer((s) => s.updateMacro)
  const removeMacro = useMixer((s) => s.removeMacro)
  const notify = useUi((s) => s.notify)
  const [pressed, setPressed] = useState<string | null>(null)

  return (
    <>
      <span className="section-label">Macro buttons · {macros.length}</span>
      <p className="tiny faint" style={{ margin: 0, lineHeight: 1.5 }}>
        Нажмите макрос, чтобы выполнить действие. Горячие клавиши работают, пока окно
        Nexus-Mixer активно; кнопки с режимом Momentary срабатывают на удержание.
      </p>

      <div className="macro-grid">
        {macros.map((macro) => (
          <button
            key={macro.id}
            type="button"
            className={`macro-card${pressed === macro.id ? ' pressed' : ''}`}
            style={{ '--macro-color': macro.color } as React.CSSProperties}
            onPointerDown={() => {
              if (!macro.momentary) return
              setPressed(macro.id)
              runMacro(macro.id)
              notify(`«${macro.label}» · удержание`)
            }}
            onPointerUp={() => {
              if (!macro.momentary || pressed !== macro.id) return
              setPressed(null)
              runMacro(macro.id)
            }}
            onPointerLeave={() => {
              if (!macro.momentary || pressed !== macro.id) return
              setPressed(null)
              runMacro(macro.id)
            }}
            onClick={() => {
              if (macro.momentary) return
              runMacro(macro.id)
              notify(`Макрос «${macro.label}» выполнен`)
            }}
            title={macro.momentary ? `${macro.action.type} · momentary` : macro.action.type}
          >
            <span className="m-type">{macro.action.type}</span>
            <span className="m-label">{macro.label}</span>
            <span className="m-key">{macro.shortcut || 'без клавиши'}</span>
          </button>
        ))}
        <button type="button" className="macro-card add" onClick={addMacro}>
          <Plus size={15} />
          <span className="m-key">Добавить</span>
        </button>
      </div>

      <span className="section-label">Настройка макросов</span>
      <div className="macro-editors">
        {macros.map((macro) => (
          <div className="macro-editor" key={macro.id}>
            <div className="macro-editor-head">
              <Zap size={12} style={{ color: macro.color }} />
              <input
                className="text-input grow"
                value={macro.label}
                aria-label="Название макроса"
                onChange={(event) => updateMacro(macro.id, { label: event.target.value })}
              />
              <button type="button" className="icon-btn" aria-label="Удалить макрос" onClick={() => removeMacro(macro.id)}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="macro-editor-grid">
              <Select
                value={macro.action.type}
                options={ACTION_TYPES}
                onChange={(val) => updateMacro(macro.id, { action: { ...macro.action, type: val as MacroAction['type'] } })}
                small
              />

              {macro.action.type === 'mute' || macro.action.type === 'gain' ? (
                <Select
                  value={macro.action.target ?? ''}
                  options={[
                    { value: '', label: '— канал —' },
                    ...STRIP_ORDER.map((id) => ({ value: id, label: strips[id].name })),
                  ]}
                  onChange={(val) => updateMacro(macro.id, { action: { ...macro.action, target: val as typeof macro.action.target } })}
                  small
                />
              ) : null}

              {macro.action.type === 'route' ? (
                <>
                  <Select
                    value={macro.action.target ?? ''}
                    options={[
                      { value: '', label: '— канал —' },
                      ...STRIP_ORDER.map((id) => ({ value: id, label: strips[id].name })),
                    ]}
                    onChange={(val) => updateMacro(macro.id, {
                      action: { ...macro.action, target: val as typeof macro.action.target },
                    })}
                    small
                  />
                  <Select
                    value={macro.action.bus ?? 'B1'}
                    options={BUS_ORDER.map((bus) => ({ value: bus, label: bus }))}
                    onChange={(val) => updateMacro(macro.id, {
                      action: { ...macro.action, bus: val as typeof macro.action.bus },
                    })}
                    small
                  />
                </>
              ) : null}

              {macro.action.type === 'preset' ? (
                <Select
                  value={typeof macro.action.value === 'string' ? macro.action.value : ''}
                  options={[
                    { value: '', label: '— пресет —' },
                    ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
                  ]}
                  onChange={(val) => updateMacro(macro.id, { action: { ...macro.action, value: val } })}
                  small
                />
              ) : null}

              {macro.action.type === 'gain' ? (
                <input
                  className="text-input"
                  type="number"
                  min={-60}
                  max={12}
                  step={0.5}
                  value={typeof macro.action.value === 'number' ? macro.action.value : 0}
                  aria-label="Гейн"
                  onChange={(event) =>
                    updateMacro(macro.id, { action: { ...macro.action, value: Number(event.target.value) } })
                  }
                />
              ) : null}

              <input
                className="text-input"
                value={macro.shortcut}
                placeholder="Ctrl+Shift+1"
                aria-label="Горячая клавиша"
                onChange={(event) => updateMacro(macro.id, { shortcut: event.target.value })}
              />
              <label className="checkline" style={{ gridColumn: '1 / -1', fontSize: 10, marginTop: 2 }}>
                <input
                  type="checkbox"
                  checked={macro.momentary}
                  onChange={(event) => updateMacro(macro.id, { momentary: event.target.checked })}
                  style={{ accentColor: 'var(--accent)' }}
                />
                Momentary (удержание — активно, отпускание — отключает)
              </label>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
