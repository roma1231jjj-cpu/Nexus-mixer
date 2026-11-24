import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { Strip } from './components/Strip'
import { Bus } from './components/Bus'
import { MultiSelectBar } from './components/MultiSelectBar'
import { StatusBar } from './components/StatusBar'
import { AddSourceDialog } from './components/AddSourceDialog'
import { PanelSkeleton } from './components/PanelSkeleton'
import { TooltipLayer } from './components/TooltipLayer'
import { UpdateBanner } from './components/UpdateBanner'
import { STRIP_ORDER, BUS_ORDER } from './data/defaults'
import { useEngineBridge } from './lib/useEngineBridge'
import { MidiLearnProvider } from './lib/midiLearnContext'
import { useMixer } from './store/useMixer'
import { useUi } from './store/useUi'
import { useUpdater } from './store/useUpdater'
import { translate, useT, useLang, LOCALES } from './i18n'
import { syncLocalizedDefaults } from './i18n/syncNames'

const RoutingMatrix = lazy(() => import('./components/RoutingMatrix'))
const RackDock = lazy(() => import('./components/rack/RackDock'))
const SettingsDrawer = lazy(() => import('./components/SettingsDrawer'))
const ShortcutsSheet = lazy(() => import('./components/ShortcutsSheet'))
const GuideSheet = lazy(() => import('./components/GuideSheet'))
const CableSetupDialog = lazy(() => import('./components/CableSetupDialog'))

const A_BUSES = BUS_ORDER.filter((id) => id.startsWith('A'))
const B_BUSES = BUS_ORDER.filter((id) => id.startsWith('B'))

const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

const shortcutCode = (key: string): string => {
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return ''
}

const matchesShortcut = (event: KeyboardEvent, shortcut: string): boolean => {
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return false
  const key = parts[parts.length - 1]
  const needCtrl = parts.includes('ctrl')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  const sameModifiers = event.ctrlKey === needCtrl && event.shiftKey === needShift && event.altKey === needAlt
  if (!sameModifiers) return false
  const code = shortcutCode(key)
  if (code) return event.code === code
  return event.key.toLowerCase() === key
}

export default function App() {
  useEngineBridge()
  const t = useT()
  const lang = useLang((s) => s.lang)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [addSourceOpen, setAddSourceOpen] = useState(false)
  const [cableSetupOpen, setCableSetupOpen] = useState(false)
  const matrixWasOpen = useRef(false)

  const matrixOpen = useMixer((s) => s.matrixOpen)
  const sourceCount = useMixer((s) => s.sourceCount)
  const setSettingsOpen = useMixer((s) => s.setSettingsOpen)
  const settingsOpen = useMixer((s) => s.settingsOpen)
  const setMatrixOpen = useMixer((s) => s.setMatrixOpen)

  useEffect(() => {
    if (matrixWasOpen.current && !matrixOpen) {
      document.querySelector('.board')?.scrollTo({ top: 0, behavior: 'smooth' })
    }
    matrixWasOpen.current = matrixOpen
  }, [matrixOpen])
  const setRackTab = useMixer((s) => s.setRackTab)
  const selectStrip = useMixer((s) => s.selectStrip)
  const selectBus = useMixer((s) => s.selectBus)
  const macros = useMixer((s) => s.macros)
  const runMacro = useMixer((s) => s.runMacro)
  const rackOpen = useUi((s) => s.rackOpen)
  const guideOpen = useUi((s) => s.guideOpen)
  const toast = useUi((s) => s.toast)
  const visibleStrips = STRIP_ORDER.slice(0, sourceCount)

  // The rack is docked on wide screens and becomes a drawer below 1460 px.
  // Start with it closed on smaller displays so the console is fully visible.
  useEffect(() => {
    syncLocalizedDefaults(lang)
  }, [lang])

  useEffect(() => {
    if (window.innerWidth < 1460) useUi.getState().setRackOpen(false)
  }, [])

  // Automatic update check shortly after the audio UI settles. Failures stay
  // silent here; the settings section exposes a manual retry with details.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void useUpdater.getState().check(true)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [])

  // Only one modal surface at a time. Before this, the settings drawer could
  // open behind the rack scrim and the matrix could cover the rack silently.
  useEffect(() => {
    if (matrixOpen) {
      useUi.getState().setRackOpen(false)
      setSettingsOpen(false)
    }
  }, [matrixOpen, setSettingsOpen])

  useEffect(() => {
    if (settingsOpen) {
      useUi.getState().setRackOpen(false)
      setMatrixOpen(false)
    }
  }, [settingsOpen, setMatrixOpen])

  // Deep links: ?strip=hw2&tab=ai or ?bus=B1&drawer=settings
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tab = params.get('tab')
    if (tab === 'fx' || tab === 'ai' || tab === 'macros' || tab === 'record' || tab === 'sound' || tab === 'groups') {
      setRackTab(tab)
      useUi.getState().setRackOpen(true)
    }
    const strip = params.get('strip')
    if (strip && (STRIP_ORDER as string[]).includes(strip)) selectStrip(strip as (typeof STRIP_ORDER)[number])
    const bus = params.get('bus')
    if (bus && (BUS_ORDER as string[]).includes(bus)) selectBus(bus as (typeof BUS_ORDER)[number])
    if (params.get('drawer') === 'settings') setSettingsOpen(true)
  }, [setRackTab, selectStrip, selectBus, setSettingsOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
        setShortcutsOpen(false)
        setMatrixOpen(false)
        useUi.getState().setGuideOpen(false)
        useUi.getState().setRackOpen(false)
        return
      }
      if (event.key === 'F1') {
        event.preventDefault()
        useUi.getState().setGuideOpen(true)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShortcutsOpen((prev) => !prev)
        return
      }
      if (isTyping(event.target)) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        const state = useMixer.getState()
        const strip = state.strips[state.selectedStripId]
        state.savePreset(`${strip.name} · ${new Date().toLocaleTimeString(LOCALES[lang], { hour: '2-digit', minute: '2-digit' })}`)
        useUi.getState().notify(translate(lang, 'app.presetSaved'))
        return
      }
      for (const macro of macros) {
        if (macro.shortcut && matchesShortcut(event, macro.shortcut)) {
          event.preventDefault()
          runMacro(macro.id)
          return
        }
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (event.code === 'KeyC') {
        const state = useMixer.getState()
        state.setMatrixOpen(!state.matrixOpen)
        return
      }
      if (event.code === 'KeyR') {
        useUi.getState().openRack('ai')
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [macros, runMacro, setSettingsOpen, setMatrixOpen, lang])

  return (
    <MidiLearnProvider key={lang}>
      <div className="app-shell">
        <TitleBar />
        <Toolbar />

        <div className="workspace">
          {rackOpen ? <button type="button" className="rack-scrim" aria-label={t('app.closePanel')} onClick={() => useUi.getState().toggleRack()} /> : null}
          <main className="board">
            <MultiSelectBar />

            <section className="section-strips" aria-label={t('app.sourcesAria')}>
              <div className="section-bar">
                <span className="section-label">{t('app.sources')}</span>
                <span className="section-count">{sourceCount} / {STRIP_ORDER.length}</span>
                <span className="section-hint">{t('app.sourcesHint')}</span>
                <button
                  type="button"
                  className="add-source-btn"
                  onClick={() => setAddSourceOpen(true)}
                  disabled={sourceCount >= STRIP_ORDER.length}
                >
                  <Plus size={14} /> {t('app.add')}
                </button>
              </div>
              <div className="strips" style={{ '--strip-count': visibleStrips.length } as React.CSSProperties}>
                {visibleStrips.map((id) => (
                  <Strip key={id} id={id} />
                ))}
              </div>
            </section>

            <section className="section-buses" aria-label={t('app.outputsAria')}>
              <div className="section-bar">
                <span className="section-label">{t('app.outputs')}</span>
                <span className="section-count">{A_BUSES.length}</span>
                <span className="section-hint">{t('app.physical')}</span>
              </div>
              <div className="outputs-main">
                {A_BUSES.map((id) => (
                  <Bus key={id} id={id} variant="main" />
                ))}
              </div>

              <div className="cable-bay-head">
                <span className="section-label">{t('app.cables')}</span>
                <span className="section-count">{B_BUSES.length}</span>
                <span className="section-hint">{t('app.cablesHint')}</span>
                <button type="button" className="add-source-btn" onClick={() => setCableSetupOpen(true)}>
                  {t('app.setupCables')}
                </button>
              </div>
              <div className="outputs-cables">
                {B_BUSES.map((id) => (
                  <Bus key={id} id={id} variant="cable" />
                ))}
              </div>
            </section>

          </main>

          {matrixOpen ? (
            <Suspense fallback={<PanelSkeleton variant="matrix" />}>
              <RoutingMatrix />
            </Suspense>
          ) : null}

          {rackOpen ? (
            <Suspense fallback={<PanelSkeleton />}>
              <RackDock onClose={() => useUi.getState().toggleRack()} />
            </Suspense>
          ) : null}
        </div>

        <StatusBar />
      </div>

      {settingsOpen ? (
        <Suspense fallback={<PanelSkeleton variant="drawer" />}>
          <SettingsDrawer />
        </Suspense>
      ) : null}
      <AddSourceDialog open={addSourceOpen} onClose={() => setAddSourceOpen(false)} />
      {cableSetupOpen ? (
        <Suspense fallback={<PanelSkeleton variant="dialog" />}>
          <CableSetupDialog open={cableSetupOpen} onClose={() => setCableSetupOpen(false)} />
        </Suspense>
      ) : null}
      {shortcutsOpen ? (
        <Suspense fallback={<PanelSkeleton variant="drawer" />}>
          <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      ) : null}
      {guideOpen ? (
        <Suspense fallback={<PanelSkeleton variant="drawer" />}>
          <GuideSheet />
        </Suspense>
      ) : null}
      <TooltipLayer />
      <UpdateBanner />

      {toast ? (
        <div className="toast glass-strong" role="status">
          <Check size={14} className="good" />
          {toast.text}
        </div>
      ) : null}
    </MidiLearnProvider>
  )
}