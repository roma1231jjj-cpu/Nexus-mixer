import { useState } from 'react'
import { AlertTriangle, BookOpen, Cpu, HardDrive, Info, Palette, Power, RefreshCw, Settings, ShieldCheck, X } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { engineBridge } from '../lib/engineBridge'
import { startEngine, stopEngine } from '../lib/engineControl'
import { Switch } from './controls/Switch'
import { Select } from './controls/Select'
import { BUS_ORDER } from '../data/defaults'
import { UpdateSettings } from './UpdateSettings'

export function SettingsDrawer() {
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
    if (!result.ok) notify(result.error ?? 'Ошибка аудиодвижка')
    else notify(result.status?.running ? 'Аудиодвижок запущен' : 'Аудиодвижок остановлен')
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={() => setOpen(false)} />
      <aside className="drawer glass-strong" aria-label="Настройки">
        <header className="drawer-head">
          <Settings size={16} className="accent" />
          <div>
            <h2>Настройки</h2>
            <div className="sub">Nexus-Mixer · v0.3.0</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              setOpen(false)
              useUi.getState().setGuideOpen(true)
            }}
            aria-label="Открыть инструкцию"
            data-tip="Открыть инструкцию"
          >
            <BookOpen size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть" data-tip="Закрыть настройки (Esc)">
            <X size={15} />
          </button>
        </header>

        <div className="drawer-body">
          <section className="settings-group">
            <span className="section-label">
              <Cpu size={12} /> Аудиодвижок
            </span>
            <div className="setting-row">
              <span className="s-label">API</span>
              <Select
                value={engine.api}
                options={[
                  { value: 'wasapi-shared', label: 'WASAPI Shared' },
                  { value: 'wasapi-exclusive', label: 'WASAPI Exclusive' },
                  { value: 'asio', label: 'ASIO' },
                  { value: 'wdm-ks', label: 'WDM-KS (низкая задержка)' },
                ]}
                onChange={(val) => setEngine({ api: val as typeof engine.api })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">Частота дискретизации</span>
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
              <span className="s-label">Буфер</span>
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
              <span className="s-label">Каналы виртуальных шин</span>
              <Select
                value={String(engine.virtualChannels)}
                options={[
                  { value: '2', label: '2.0 стерео' },
                  { value: '6', label: '5.1' },
                  { value: '8', label: '7.1' },
                ]}
                onChange={(val) => setEngine({ virtualChannels: Number(val) as typeof engine.virtualChannels })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">Clock master</span>
              <Select
                value={engine.clockMaster}
                options={[
                  { value: 'A1', label: 'A1 · Наушники' },
                  { value: 'A2', label: 'A2 · Наушники 2' },
                  { value: 'A3', label: 'A3 · Колонки' },
                  ...BUS_ORDER.filter((id) => id.startsWith('B')).map((id) => ({ value: id, label: id })),
                ]}
                onChange={(val) => setEngine({ clockMaster: val as typeof engine.clockMaster })}
              />
            </div>
            <div className="setting-row">
              <span className="s-label">
                Защита от дропаутов
                <span className="s-hint"> · доп. буфер, мс</span>
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
                  Задержка: <b>{latency.toFixed(1)} мс</b>
                  {status.running && runtimeInfo ? ` · буфер ${runtimeInfo.bufferSize}` : ''}
                </div>
                <div>
                  CPU <b>{status.cpuPercent.toFixed(1)}%</b> · xruns <b>{status.xruns}</b> · SR{' '}
                  <b>{status.sampleRate.toLocaleString('ru-RU')}</b>
                </div>
                {status.running && runtimeInfo ? (
                  <div>
                    Потоки: <b>{runtimeInfo.inputStreams} in</b> / <b>{runtimeInfo.outputStreams} out</b>
                  </div>
                ) : null}
              </div>
              {engineBridge.available ? (
                <button
                  type="button"
                  className={`btn small ${status.running ? 'danger' : 'primary'}`}
                  onClick={toggleEngine}
                  disabled={busy}
                  title={status.running ? 'Остановить аудиодвижок' : 'Запустить аудиодвижок'}
                >
                  <Power size={12} />
                  {busy ? '…' : status.running ? 'Стоп' : 'Запуск'}
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
                Реальный движок доступен в desktop-сборке; в браузере работает симуляция телеметрии.
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
              <HardDrive size={12} /> Виртуальные аудиокабели
            </span>
            <div className="driver-card">
              <div className="d-title">
                <ShieldCheck size={14} className={status.driver.installed ? 'good' : 'warn'} />
                Virtual Audio Cable · {status.driver.installed ? 'активен' : 'не установлен'}
              </div>
              <div className="d-text">
                {status.driver.installed
                  ? status.driver.message
                  : 'Кабель не найден. Виртуальные шины работают в режиме эмуляции — звук остаётся внутри приложения.'}
                <br /><br />
                <b>Что это?</b> Каждый виртуальный кабель создаёт пару устройств: <b>Input</b> (куда Nexus отправляет звук) и <b>Output</b> (откуда приложения его забирают как микрофон).
              </div>

              {/* Список обнаруженных кабелей */}
              {status.driver.installed && status.driver.cableEndpoints.length > 0 ? (
                <div className="cable-endpoints">
                  <div className="cable-ep-header">Обнаруженные кабели:</div>
                  {status.driver.cableEndpoints.map((name, i) => (
                    <div key={i} className="cable-ep-item">
                      <span className={`pill good`} style={{ height: 18, padding: '0 6px', fontSize: 8 }}>
                        <i className="dot" />кабель {i + 1}
                      </span>
                      <span className="cable-ep-name">{name}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* Карта шин → кабели */}
              <div className="cable-bus-map">
                <div className="cable-ep-header">Назначение шин:</div>
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
                          нет кабеля
                        </span>
                      ) : isB2 ? (
                        <span className="pill warn" style={{ height: 16, padding: '0 5px', fontSize: 7.5 }}>
                          нужен второй кабель
                        </span>
                      ) : (
                        <span className="pill good" style={{ height: 16, padding: '0 5px', fontSize: 7.5 }}>
                          <i className="dot" />готов
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
                      notify('Виртуальные кабели уже установлены. Для переустановки запустите установщик VAC (vac471.exe) или VBCABLE_Setup_x64.exe от администратора.')
                    } else {
                      notify(
                        '1. Скачайте VBCABLE_Driver_Pack с vb-audio.com\n' +
                        '2. Запустите VBCABLE_Setup_x64.exe от администратора\n' +
                        '3. Нажмите «Install Driver» и перезагрузите ПК',
                      )
                    }
                  }}
                >
                  {status.driver.installed ? 'Проверить' : 'Как установить'}
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setOpen(false)
                    useUi.getState().setGuideOpen(true)
                  }}
                >
                  Инструкция
                </button>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <span className="section-label">
              <Palette size={12} /> Интерфейс и поведение
            </span>
            <div className="setting-row">
              <span className="s-label">Тема</span>
              <div className="seg">
                <button type="button" className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>
                  Тёмная
                </button>
                <button type="button" className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>
                  Светлая
                </button>
              </div>
            </div>
            <div className="toggle-row">
              <span className="t-label">Следовать за устройствами Windows по умолчанию</span>
              <Switch
                on={engine.followDefaultDevices}
                onChange={(value) => setEngine({ followDefaultDevices: value })}
                ariaLabel="Следовать за устройствами по умолчанию"
              />
            </div>
            <div className="toggle-row">
              <span className="t-label">Работать в трее при закрытии окна</span>
              <Switch
                on={engine.runInTray}
                onChange={(value) => setEngine({ runInTray: value })}
                ariaLabel="Работать в трее"
              />
            </div>
            <div className="toggle-row">
              <span className="t-label">
                Запускать вместе с Windows <span className="s-hint">· скоро</span>
              </span>
              <Switch
                on={engine.startWithWindows}
                onChange={(value) => setEngine({ startWithWindows: value })}
                ariaLabel="Автозапуск"
                disabled
              />
            </div>
          </section>

          <section className="settings-group">
            <span className="section-label">
              <RefreshCw size={12} /> Обновления
            </span>
            <UpdateSettings />
          </section>

          <section className="settings-group">
            <span className="section-label">
              <Info size={12} /> О приложении
            </span>
            <div className="about-card">
              <div className="about-title">
                Nexus-<b>Mixer</b>
              </div>
              <p>
                Виртуальный аудиомикшер с DSP-цепочками и локальной ИИ-конверсией голоса. Полный аналог Voicemeeter
                Banana с современным интерфейсом.
              </p>
              <div className="about-meta">
                <span>Nexus × АутSquad</span>
                <span>0.3.0 · Tauri 2 · Rust</span>
              </div>
              <button
                type="button"
                className="btn danger small"
                onClick={() => {
                  if (window.confirm('Сбросить все каналы, пресеты и макросы к заводским настройкам?')) {
                    resetAll()
                    notify('Настройки сброшены')
                  }
                }}
              >
                Сбросить всё
              </button>
            </div>
          </section>
        </div>
      </aside>
    </>
  )
}
