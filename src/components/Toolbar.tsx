import { useEffect, useState } from 'react'
import {
  BookOpen,
  Command,
  Disc3,
  Layers,
  LayoutGrid,
  Moon,
  Music,
  RotateCcw,
  RotateCw,
  Save,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Monitor,
} from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { Select } from './controls/Select'
import { useUndoRedoIntegration } from '../lib/useUndoRedoIntegration'

const CATEGORY_LABEL: Record<string, string> = {
  voice: 'Голос',
  broadcast: 'Бродкаст',
  fx: 'Эффекты',
  ai: 'ИИ-пресеты',
  music: 'Музыка',
  custom: 'Мои пресеты',
}

const RACK_TABS = [
  {
    id: 'fx',
    label: 'FX',
    icon: SlidersHorizontal,
    tip: 'Эффекты выбранного канала или шины',
  },
  {
    id: 'ai',
    label: 'Voice',
    icon: Sparkles,
    tip: 'ИИ-конверсия голоса — открыть панель Voice',
  },
  {
    id: 'macros',
    label: 'Macros',
    icon: Command,
    tip: 'Макро-кнопки и сцены',
  },
  {
    id: 'record',
    label: 'Rec',
    icon: Disc3,
    tip: 'Запись выбранных шин в WAV',
  },
  {
    id: 'sound',
    label: 'Pads',
    icon: Music,
    tip: 'Pads — звуковые эффекты и вставки',
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: Layers,
    tip: 'VCA-группы — один фейдер на несколько каналов',
  },
] as const

export function Toolbar() {
  const presets = useMixer((s) => s.presets)
  const applyPreset = useMixer((s) => s.applyPreset)
  const savePreset = useMixer((s) => s.savePreset)
  const recorder = useMixer((s) => s.recorder)
  const matrixOpen = useMixer((s) => s.matrixOpen)
  const setMatrixOpen = useMixer((s) => s.setMatrixOpen)
  const theme = useMixer((s) => s.theme)
  const toggleTheme = useMixer((s) => s.toggleTheme)
  const setSettingsOpen = useMixer((s) => s.setSettingsOpen)
  const strip = useMixer((s) => s.strips[s.selectedStripId])
  const rackTab = useMixer((s) => s.rackTab)
  const rackOpen = useUi((s) => s.rackOpen)
  const toggleRack = useUi((s) => s.toggleRack)
  const openRack = useUi((s) => s.openRack)
  const notify = useUi((s) => s.notify)
  const undoRedo = useUndoRedoIntegration()
  const [presetId, setPresetId] = useState('')

  useEffect(() => {
    setPresetId('')
  }, [strip.id])

  const grouped = presets.reduce<Record<string, typeof presets>>((acc, preset) => {
    const key = preset.category
    acc[key] = acc[key] ?? []
    acc[key].push(preset)
    return acc
  }, {})

  const openTab = (tab: (typeof RACK_TABS)[number]['id']) => {
    if (rackOpen && rackTab === tab) toggleRack()
    else openRack(tab)
  }

  return (
    <div className="toolbar">
      <div className="preset-select">
        <span className="label">Пресет</span>
        <Select
          value={presetId}
          options={[
            ...Object.entries(grouped).flatMap(([category, items]) => [
              { value: `__cat__${category}`, label: `— ${CATEGORY_LABEL[category] ?? category} —`, disabled: true },
              ...items.map((preset) => ({ value: preset.id, label: preset.name })),
            ]),
          ]}
          onChange={(val) => {
            if (!val || val.startsWith('__cat__')) return
            setPresetId(val)
            applyPreset(val)
            const preset = presets.find((p) => p.id === val)
            notify(`Пресет «${preset?.name ?? ''}» применён к ${strip.name}`)
          }}
          placeholder="Выбрать пресет…"
        />
      </div>

      <button
        type="button"
        className="icon-btn"
        data-tip="Сохранить текущую цепочку как пресет (Ctrl+S)"
        data-tip-pos="bottom"
        aria-label="Сохранить пресет"
        onClick={() => {
          savePreset(`${strip.name} · ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)
          notify('Пресет сохранён в «Мои пресеты»')
        }}
      >
        <Save size={15} />
      </button>

      <span className="toolbar-sep" />

      <div className="toolbar-group rack-tabs">
        {RACK_TABS.map((item) => {
          const Icon = item.icon
          const active = rackOpen && rackTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`tool-btn${active ? ' on' : ''}${item.id === 'record' && recorder.enabled ? ' recording' : ''}`}
              onClick={() => openTab(item.id)}
              data-tip={item.tip}
              data-tip-pos="bottom"
              aria-label={item.label}
              aria-pressed={active}
            >
              <Icon size={14} />
              <span className="btn-label">{item.label}</span>
              {item.id === 'record' ? <span className="rec-dot" /> : null}
            </button>
          )
        })}
      </div>

      <span className="toolbar-sep" />

      <button
        type="button"
        className={`tool-btn${matrixOpen ? ' on' : ''}`}
        onClick={() => setMatrixOpen(!matrixOpen)}
        data-tip="Матрица маршрутизации: какой канал куда идёт (C)"
        data-tip-pos="bottom"
      >
        <LayoutGrid size={14} />
        <span className="btn-label">Матрица</span>
      </button>

      <div className="toolbar-spacer" />

      <div className="history-group">
        <button
          type="button"
          className="icon-btn"
          disabled={!undoRedo.canUndo}
          onClick={undoRedo.handleUndo}
          aria-label="Отменить"
          data-tip="Отменить изменение FX (Ctrl+Z)"
          data-tip-pos="bottom"
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!undoRedo.canRedo}
          onClick={undoRedo.handleRedo}
          aria-label="Повторить"
          data-tip="Повторить изменение FX (Ctrl+Shift+Z)"
          data-tip-pos="bottom"
        >
          <RotateCw size={15} />
        </button>
      </div>

      <span className="toolbar-sep" />

      <button
        type="button"
        className="icon-btn"
        aria-label="Инструкция"
        data-tip="Инструкция — как всё устроено (F1)"
        data-tip-pos="bottom"
        onClick={() => useUi.getState().setGuideOpen(true)}
      >
        <BookOpen size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Настройки"
        data-tip="Настройки: аудио, тема, виртуальные кабели"
        data-tip-pos="bottom"
        onClick={() => setSettingsOpen(true)}
      >
        <Settings size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Сменить тему"
        data-tip={`Тема: ${theme === 'studio' ? 'Nexus-Studio' : theme === 'dark' ? 'Nexus-Noir' : 'Nexus-Frost'} · нажмите, чтобы сменить`}
        data-tip-pos="bottom"
        onClick={toggleTheme}
      >
        {theme === 'studio' ? <Monitor size={16} /> : theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </div>
  )
}
