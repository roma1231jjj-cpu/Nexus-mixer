import { useEffect, useState } from 'react'
import {
  BookOpen,
  Command,
  Disc3,
  Layers,
  LayoutGrid,
  Moon,
  Music,
  Languages,
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
import { useT, useLang, useLocale, type TKey } from '../i18n'

const CATEGORY_LABEL: Record<string, TKey> = {
  voice: 'toolbar.category.voice',
  broadcast: 'toolbar.category.broadcast',
  fx: 'toolbar.category.fx',
  ai: 'toolbar.category.ai',
  music: 'toolbar.category.music',
  custom: 'toolbar.category.custom',
}

const RACK_TABS = [
  {
    id: 'fx',
    label: 'FX',
    icon: SlidersHorizontal,
    tip: 'toolbar.tip.fx',
  },
  {
    id: 'ai',
    label: 'Voice',
    icon: Sparkles,
    tip: 'toolbar.tip.ai',
  },
  {
    id: 'macros',
    label: 'Macros',
    icon: Command,
    tip: 'toolbar.tip.macros',
  },
  {
    id: 'record',
    label: 'Rec',
    icon: Disc3,
    tip: 'toolbar.tip.record',
  },
  {
    id: 'sound',
    label: 'Pads',
    icon: Music,
    tip: 'toolbar.tip.sound',
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: Layers,
    tip: 'toolbar.tip.groups',
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: unknown; tip: TKey }>

export function Toolbar() {
  const t = useT()
  const locale = useLocale()
  const lang = useLang((s) => s.lang)
  const toggleLang = useLang((s) => s.toggleLang)
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
        <span className="label">{t('toolbar.preset')}</span>
        <Select
          value={presetId}
          options={[
            ...Object.entries(grouped).flatMap(([category, items]) => [
              {
                value: `__cat__${category}`,
                label: `— ${CATEGORY_LABEL[category] ? t(CATEGORY_LABEL[category]) : category} —`,
                disabled: true,
              },
              ...items.map((preset) => ({ value: preset.id, label: preset.name })),
            ]),
          ]}
          onChange={(val) => {
            if (!val || val.startsWith('__cat__')) return
            setPresetId(val)
            applyPreset(val)
            const preset = presets.find((p) => p.id === val)
            notify(t('toolbar.presetApplied', { preset: preset?.name ?? '', strip: strip.name }))
          }}
          placeholder={t('toolbar.choosePreset')}
        />
      </div>

      <button
        type="button"
        className="icon-btn"
        data-tip={t('toolbar.savePresetTip')}
        data-tip-pos="bottom"
        aria-label={t('toolbar.savePreset')}
        onClick={() => {
          savePreset(`${strip.name} · ${new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`)
          notify(t('app.presetSaved'))
        }}
      >
        <Save size={15} />
      </button>

      <span className="toolbar-sep" />

      <div className="toolbar-group rack-tabs">
        {RACK_TABS.map((item) => {
          const Icon = item.icon as typeof SlidersHorizontal
          const active = rackOpen && rackTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`tool-btn${active ? ' on' : ''}${item.id === 'record' && recorder.enabled ? ' recording' : ''}`}
              onClick={() => openTab(item.id)}
              data-tip={t(item.tip)}
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
        data-tip={t('toolbar.matrixTip')}
        data-tip-pos="bottom"
      >
        <LayoutGrid size={14} />
        <span className="btn-label">{t('toolbar.matrix')}</span>
      </button>

      <div className="toolbar-spacer" />

      <div className="history-group">
        <button
          type="button"
          className="icon-btn"
          disabled={!undoRedo.canUndo}
          onClick={undoRedo.handleUndo}
          aria-label={t('toolbar.undo')}
          data-tip={t('toolbar.undoTip')}
          data-tip-pos="bottom"
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!undoRedo.canRedo}
          onClick={undoRedo.handleRedo}
          aria-label={t('toolbar.redo')}
          data-tip={t('toolbar.redoTip')}
          data-tip-pos="bottom"
        >
          <RotateCw size={15} />
        </button>
      </div>

      <span className="toolbar-sep" />

      <button
        type="button"
        className="lang-btn"
        aria-label={t('toolbar.langAria')}
        data-tip={t('toolbar.lang', { lang: lang.toUpperCase() })}
        data-tip-pos="bottom"
        onClick={toggleLang}
      >
        <Languages size={15} />
        <span>{lang.toUpperCase()}</span>
      </button>

      <button
        type="button"
        className="icon-btn"
        aria-label={t('toolbar.guide')}
        data-tip={t('toolbar.guideTip')}
        data-tip-pos="bottom"
        onClick={() => useUi.getState().setGuideOpen(true)}
      >
        <BookOpen size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('toolbar.settings')}
        data-tip={t('toolbar.settingsTip')}
        data-tip-pos="bottom"
        onClick={() => setSettingsOpen(true)}
      >
        <Settings size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('toolbar.theme')}
        data-tip={t('toolbar.themeTip', {
          theme: theme === 'studio' ? t('theme.studio') : theme === 'dark' ? t('theme.dark') : t('theme.light'),
        })}
        data-tip-pos="bottom"
        onClick={toggleTheme}
      >
        {theme === 'studio' ? <Monitor size={16} /> : theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </div>
  )
}
