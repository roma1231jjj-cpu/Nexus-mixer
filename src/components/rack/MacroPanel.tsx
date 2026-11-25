import { useRef, useState } from 'react'
import { Plus, Trash2, Zap } from 'lucide-react'
import type { MacroAction } from '../../types'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { BUS_ORDER, STRIP_ORDER } from '../../data/defaults'
import { Select } from '../controls/Select'
import { useT, type TKey } from '../../i18n'

const ACTION_TYPES: { value: MacroAction['type']; label: TKey }[] = [
  { value: 'panic', label: 'macro.type.panic' },
  { value: 'mute', label: 'macro.type.mute' },
  { value: 'route', label: 'macro.type.route' },
  { value: 'preset', label: 'macro.type.preset' },
  { value: 'ai', label: 'macro.type.ai' },
  { value: 'gain', label: 'macro.type.gain' },
]

export function MacroPanel() {
  const t = useT()
  const macros = useMixer((s) => s.macros)
  const presets = useMixer((s) => s.presets)
  const strips = useMixer((s) => s.strips)
  const runMacro = useMixer((s) => s.runMacro)
  const pressMacro = useMixer((s) => s.pressMacro)
  const releaseMacro = useMixer((s) => s.releaseMacro)
  const addMacro = useMixer((s) => s.addMacro)
  const updateMacro = useMixer((s) => s.updateMacro)
  const removeMacro = useMixer((s) => s.removeMacro)
  const notify = useUi((s) => s.notify)
  const [pressed, setPressed] = useState<string | null>(null)
  const pressedRef = useRef<string | null>(null)

  const beginHold = (id: string, label: string) => {
    if (pressedRef.current) return
    pressedRef.current = id
    setPressed(id)
    pressMacro(id)
    notify(t('macro.holdToast', { label }))
  }

  const endHold = (id: string) => {
    if (pressedRef.current !== id) return
    pressedRef.current = null
    setPressed(null)
    releaseMacro(id)
  }

  return (
    <>
      <span className="section-label">Macro buttons · {macros.length}</span>
      <p className="tiny faint" style={{ margin: 0, lineHeight: 1.5 }}>
        {t('macro.hint')}
      </p>

      <div className="macro-grid">
        {macros.map((macro) => (
          <button
            key={macro.id}
            type="button"
            className={`macro-card${pressed === macro.id ? ' pressed' : ''}`}
            style={{ '--macro-color': macro.color } as React.CSSProperties}
            onPointerDown={(event) => {
              if (!macro.momentary) return
              event.currentTarget.setPointerCapture(event.pointerId)
              beginHold(macro.id, macro.label)
            }}
            onPointerUp={(event) => {
              if (!macro.momentary) return
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              endHold(macro.id)
            }}
            onPointerCancel={(event) => {
              if (!macro.momentary) return
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              endHold(macro.id)
            }}
            onPointerLeave={(event) => {
              if (!macro.momentary) return
              if (event.currentTarget.hasPointerCapture(event.pointerId)) return
              endHold(macro.id)
            }}
            onClick={() => {
              if (macro.momentary) return
              runMacro(macro.id)
              notify(t('macro.done', { label: macro.label }))
            }}
            title={macro.momentary ? `${macro.action.type} · momentary` : macro.action.type}
          >
            <span className="m-type">{macro.action.type}</span>
            <span className="m-label">{macro.label}</span>
            <span className="m-key">{macro.shortcut || t('macro.noKey')}</span>
          </button>
        ))}
        <button type="button" className="macro-card add" onClick={addMacro}>
          <Plus size={15} />
          <span className="m-key">{t('macro.add')}</span>
        </button>
      </div>

      <span className="section-label">{t('macro.editTitle')}</span>
      <div className="macro-editors">
        {macros.map((macro) => (
          <div className="macro-editor" key={macro.id}>
            <div className="macro-editor-head">
              <Zap size={12} style={{ color: macro.color }} />
              <input
                className="text-input grow"
                value={macro.label}
                aria-label={t('macro.labelAria')}
                onChange={(event) => updateMacro(macro.id, { label: event.target.value })}
              />
              <button type="button" className="icon-btn" aria-label={t('macro.remove')} onClick={() => removeMacro(macro.id)}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="macro-editor-grid">
              <Select
                value={macro.action.type}
                options={ACTION_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))}
                onChange={(val) => updateMacro(macro.id, { action: { ...macro.action, type: val as MacroAction['type'] } })}
                small
              />

              {macro.action.type === 'mute' || macro.action.type === 'gain' ? (
                <Select
                  value={macro.action.target ?? ''}
                  options={[
                    { value: '', label: t('macro.channelOption') },
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
                      { value: '', label: t('macro.channelOption') },
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
                <>
                  <Select
                    value={typeof macro.action.value === 'string' ? macro.action.value : ''}
                    options={[
                      { value: '', label: t('macro.presetOption') },
                      ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
                    ]}
                    onChange={(val) => updateMacro(macro.id, { action: { ...macro.action, value: val } })}
                    small
                  />
                  <Select
                    value={macro.action.target ?? ''}
                    options={[
                      { value: '', label: t('macro.channelOption') },
                      ...STRIP_ORDER.map((id) => ({ value: id, label: strips[id].name })),
                    ]}
                    onChange={(val) => updateMacro(macro.id, { action: { ...macro.action, target: val as typeof macro.action.target } })}
                    small
                  />
                </>
              ) : null}

              {macro.action.type === 'gain' ? (
                <input
                  className="text-input"
                  type="number"
                  min={-60}
                  max={12}
                  step={0.5}
                  value={typeof macro.action.value === 'number' ? macro.action.value : 0}
                  aria-label={t('macro.gainAria')}
                  onChange={(event) =>
                    updateMacro(macro.id, { action: { ...macro.action, value: Number(event.target.value) } })
                  }
                />
              ) : null}

              <input
                className="text-input"
                value={macro.shortcut}
                placeholder="Ctrl+Shift+1"
                aria-label={t('macro.shortcutAria')}
                onChange={(event) => updateMacro(macro.id, { shortcut: event.target.value })}
              />
              <label className="checkline" style={{ gridColumn: '1 / -1', fontSize: 10, marginTop: 2 }}>
                <input
                  type="checkbox"
                  checked={macro.momentary}
                  onChange={(event) => updateMacro(macro.id, { momentary: event.target.checked })}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {t('macro.momentary')}
              </label>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
