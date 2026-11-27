import { useState } from 'react'
import { AlertTriangle, BookOpen, Cpu, HardDrive, Info, Languages, Palette, Power, RefreshCw, Settings, ShieldCheck, X } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { engineBridge } from '../lib/engineBridge'
import { startEngine, stopEngine } from '../lib/engineControl'
import { Switch } from './controls/Switch'
import { Select } from './controls/Select'
import { BUS_ORDER } from '../data/defaults'
import { UpdateSettings } from './UpdateSettings'
import { RichText } from './RichText'
import { useT, useLang, useLocale } from '../i18n'

export function SettingsDrawer() {
  const t = useT()
  const locale = useLocale()
  const lang = useLang((s) => s.lang)
  const setLang = useLang((s) => s.setLang)
  const open = useMixer((s) => s.settingsOpen)
  const setOpen = useMixer((s) => s.setSettingsOpen)
  const engine = useMixer((s) => s.engine)
  const setEngine = useMixer((s) => s.setEngine)
  const status = useMixer((s) => s.status)
  const runtimeInfo = useMixer((s) => s.runtimeInfo)
  const theme = useMixer((s) => s.theme)
  const buses = useMixer((s) => s.buses)
  const setTheme = useMixer((s) => s.setTheme)
  const resetAll = useMixer((s) => s.resetAll)
  const notify = useUi((s) => s.notify)
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const latency = status.latencyMs

  const toggleEngine = async () => {
    if (busy) return
    setBusy(true)
    const result = status.running ? await stopEngine() : await startEngine()
    setBusy(false)
    if (!result.ok) notify(result.error ?? t('status.engineError'))
    else notify(result.status?.running ? t('status.engineStarted') : t('status.engineStopped'))
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={() => setOpen(false)} />
      <aside className="drawer glass-strong" aria-label={t('settings.title')}>
        <header className="drawer-head">
          <Settings size={16} className="accent" />
          <div>
            <h2>{t('settings.title')}</h2>
            <div className="sub">Nexus-Mixer · v0.5.3</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              setOpen(false)
              useUi.getState().setGuideOpen(true)
            }}
            aria-label={t('settings.openGuide')}
            data-tip={t('settings.openGuide')}
          >
            <BookOpen size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label={t('settings.closeAria')} data-tip={t('settings.closeTip')}>
            <X size={15} />
          </button>
        </header>

        <div className="drawer-body">
          <section className="settings-group">
            <span className="section-label">
              <Cpu size={12} /> {t('settings.engine')}
            </span>
            <div className="setting-row">
              <span className="s-label">{t('settings.api')}</span>
              <Select
                value={engine.api}
                options={[
                  { value: 'wasapi-shared', label: 'WASAPI Shared' },
                  { value: 'wasapi-exclusive', label: 'WASAPI Exclusive' },
                  { value: 'asio', label: 'ASIO' },
                  { value: 'wdm-ks', label: t('settings.wdmLowLatency') },
                ]}
                onChange={(val) => setEngine({ api: val as typeof engine.api })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">{t('settings.sampleRate')}</span>
              <Select
                value={String(engine.sampleRate)}
                options={[
                  { value: '44100', label: '44 100 Hz' },
                  { value: '48000', label: '48 000 Hz' },
                  { value: '88200', label: '88 200 Hz' },
                  { value: '96000', label: '96 000 Hz' },
                  { value: '192000', label: '192 000 Hz' },
                ]}
                onChange={(val) => setEngine({ sampleRate: Number(val) as typeof engine.sampleRate })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">{t('settings.buffer')}</span>
              <Select
                value={String(engine.bufferSize)}
                options={[64, 128, 256, 512, 1024, 2048].map((size) => ({
                  value: String(size),
                  label: `${size} frames · ≈${((size / engine.sampleRate) * 1000).toFixed(1)} ms`,
                }))}
                onChange={(val) => setEngine({ bufferSize: Number(val) as typeof engine.bufferSize })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">{t('settings.virtualChannels')}</span>
              <Select
                value={String(engine.virtualChannels)}
                options={[
                  { value: '2', label: t('settings.channels.stereo') },
                  { value: '6', label: '5.1' },
                  { value: '8', label: '7.1' },
                ]}
                onChange={(val) => setEngine({ virtualChannels: Number(val) as typeof engine.virtualChannels })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">{t('settings.clockMaster')}</span>
              <Select
                value={engine.clockMaster}
                options={[
                  { value: 'A1', label: t('settings.busOption', { id: 'A1', name: t('data.bus.hp1') }) },
                  { value: 'A2', label: t('settings.busOption', { id: 'A2', name: t('data.bus.hp2') }) },
                  { value: 'A3', label: t('settings.busOption', { id: 'A3', name: t('data.bus.speakers') }) },
                  ...BUS_ORDER.filter((id) => id.startsWith('B')).map((id) => ({ value: id, label: id })),
                ]}
                onChange={(val) => setEngine({ clockMaster: val as typeof engine.clockMaster })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">
                {t('settings.safety')}
                <span className="s-hint"> {t('settings.safetyHint')}</span>
              </span>
              <input
                className="text-input"
                style={{ width: 72 }}
                type="number"
                min={0}
                max={50}
                value={engine.safetyMs}
                onChange={(event) => setEngine({ safetyMs: Math.max(0, Math.min(50, Number(event.target.value) || 0)) })}
              />
            </div>
            <div className="transport">
              <div className="tp-info">
                <div>
                  {t('settings.latencyLabel')} <b>{t('settings.latencyMs', { ms: latency.toFixed(1) })}</b>
                  {status.running && runtimeInfo ? t('settings.bufferOf', { size: runtimeInfo.bufferSize }) : ''}
                </div>
                <div>
                  CPU <b>{status.cpuPercent.toFixed(1)}%</b> · xruns <b>{status.xruns}</b> · SR{' '}
                  <b>{status.sampleRate.toLocaleString(locale)}</b>
                </div>
                {status.running && runtimeInfo ? (
                  <div>
                    {t('settings.streams')}{' '}
                    <b>
                      {t('settings.streamsValue', {
                        input: runtimeInfo.inputStreams,
                        output: runtimeInfo.outputStreams,
                      })}
                    </b>
                  </div>
                ) : null}
              </div>
              {engineBridge.available ? (
                <button
                  type="button"
                  className={`btn small ${status.running ? 'danger' : 'primary'}`}
                  onClick={toggleEngine}
                  disabled={busy}
                  title={status.running ? t('status.stopTip') : t('status.startTip')}
                >
                  <Power size={12} />
                  {busy ? '…' : status.running ? t('settings.stop') : t('settings.start')}
                </button>
              ) : (
                <span className={`pill ${status.running ? 'good' : 'bad'}`}>
                  <i className="dot" />
                  {status.running ? 'DEMO' : 'STOP'}
                </span>
              )}
            </div>
            {!engineBridge.available ? (
              <p className="s-hint" style={{ marginTop: 8 }}>
                {t('settings.demoNote')}
              </p>
            ) : null}
            {status.running && runtimeInfo && runtimeInfo.warnings.length > 0 ? (
              <ul className="engine-warnings">
                {runtimeInfo.warnings.map((warning) => (
                  <li key={warning}>
                    <AlertTriangle size={11} />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="settings-group">
            <span className="section-label">
              <HardDrive size={12} /> {t('settings.cables')}
            </span>
            <div className="driver-card">
              <div className="d-title">
                <ShieldCheck size={14} className={status.driver.installed ? 'good' : 'warn'} />
                {t('settings.vacTitle', { state: status.driver.installed ? t('settings.vacActive') : t('settings.vacMissing') })}
              </div>
              <div className="d-text">
                {status.driver.installed
                  ? status.driver.cableEndpoints.length > 0
                    ? t('settings.cableActiveText', { names: status.driver.cableEndpoints.join(', ') })
                    : t('settings.cableInstalledNoDevices')
                  : t('settings.cableMissingText')}
                <br /><br />
                <RichText text={t('settings.cableWhat')} />
              </div>

              {status.driver.installed && status.driver.cableEndpoints.length > 0 ? (
                <div className="cable-endpoints">
                  <div className="cable-ep-header">{t('settings.foundCables')}</div>
                  {status.driver.cableEndpoints.map((name, i) => (
                    <div key={i} className="cable-ep-item">
                      <span className={`pill good`} style={{ height: 18, padding: '0 6px', fontSize: 8 }}>
                        <i className="dot" />{t('settings.cableN', { n: i + 1 })}
                      </span>
                      <span className="cable-ep-name">{name}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="cable-bus-map">
                <div className="cable-ep-header">{t('settings.busMap')}</div>
                {BUS_ORDER.filter((id) => id.startsWith('B')).map((busId) => {
                  const bus = buses[busId]
                  const hasDevice = bus.deviceId && bus.deviceId.length > 0
                  const isB2 = busId === 'B2'
                  const idx = parseInt(busId.slice(1))
                  return (
                    <div key={busId} className={`cable-bus-row${!hasDevice && idx >= 3 ? ' unused' : ''}`}>
                      <span className="cable-bus-id">{busId}</span>
                      <span className="cable-bus-name">{bus.name}</span>
                      {hasDevice ? (
                        <span className="pill good" style={{ height: 16, padding: '0 5px', fontSize: 7.5 }}>
                          <i className="dot" />{bus.deviceId}
                        </span>
                      ) : idx >= 3 ? (
                        <span className="pill" style={{ height: 16, padding: '0 5px', fontSize: 7.5, opacity: 0.4 }}>
                          {t('settings.noCable')}
                        </span>
                      ) : isB2 ? (
                        <span className="pill warn" style={{ height: 16, padding: '0 5px', fontSize: 7.5 }}>
                          {t('settings.needCable')}
                        </span>
                      ) : (
                        <span className="pill good" style={{ height: 16, padding: '0 5px', fontSize: 7.5 }}>
                          <i className="dot" />{t('settings.ready')}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="d-actions">
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => {
                    if (status.driver.installed) {
                      notify(t('settings.installedNotice'))
                    } else {
                      notify(t('settings.installSteps'))
                    }
                  }}
                >
                  {status.driver.installed ? t('settings.check') : t('settings.howToInstall')}
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setOpen(false)
                    useUi.getState().setGuideOpen(true)
                  }}
                >
                  {t('settings.guide')}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <span className="section-label">
              <Palette size={12} /> {t('settings.interface')}
            </span>
            <div className="setting-row">
              <span className="s-label">{t('settings.theme')}</span>
              <div className="seg theme-switcher">
                <button type="button" className={theme === 'studio' ? 'on' : ''} onClick={() => setTheme('studio')} title={t('settings.themeStudioTip')}>
                  Nexus-Studio
                </button>
                <button type="button" className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')} title={t('settings.themeDarkTip')}>
                  Nexus-Noir
                </button>
                <button type="button" className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')} title={t('settings.themeLightTip')}>
                  Nexus-Frost
                </button>
              </div>
            </div>
            <div className="setting-row">
              <span className="s-label">
                <Languages size={12} /> {t('settings.language')}
              </span>
              <div className="seg lang-switcher lang-seg">
                <button type="button" className={lang === 'ru' ? 'on' : ''} onClick={() => setLang('ru')}>
                  {t('settings.langRu')}
                </button>
                <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
                  {t('settings.langEn')}
                </button>
              </div>
            </div>
            <div className="toggle-row">
              <span className="t-label">{t('settings.followDefault')}</span>
              <Switch
                on={engine.followDefaultDevices}
                onChange={(value) => setEngine({ followDefaultDevices: value })}
                ariaLabel={t('settings.followDefaultAria')}
              />
            </div>
            <div className="toggle-row">
              <span className="t-label">{t('settings.tray')}</span>
              <Switch
                on={engine.runInTray}
                onChange={(value) => setEngine({ runInTray: value })}
                ariaLabel={t('settings.trayAria')}
              />
            </div>
            <div className="toggle-row">
              <span className="t-label">
                {t('settings.autostart')} <span className="s-hint">{t('settings.soon')}</span>
              </span>
              <Switch
                on={engine.startWithWindows}
                onChange={(value) => setEngine({ startWithWindows: value })}
                ariaLabel={t('settings.autostartAria')}
                disabled
              />
            </div>
          </section>

          <section className="settings-group">
            <span className="section-label">
              <RefreshCw size={12} /> {t('settings.updates')}
            </span>
            <UpdateSettings />
          </section>

          <section className="settings-group">
            <span className="section-label">
              <Info size={12} /> {t('settings.about')}
            </span>
            <div className="about-card">
              <div className="about-title">
                Nexus-<b>Mixer</b>
              </div>
              <p>{t('settings.aboutText')}</p>
              <div className="about-meta">
                <span>{t('brand.sign')}</span>
                <span>0.5.3 · Tauri 2 · Rust</span>
              </div>
              <button
                type="button"
                className="btn danger small"
                onClick={() => {
                  if (window.confirm(t('settings.resetConfirm'))) {
                    resetAll()
                    notify(t('settings.resetDone'))
                  }
                }}
              >
                {t('settings.resetAll')}
              </button>
            </div>
          </section>
        </div>
      </aside>
    </>
  )
}

export default SettingsDrawer