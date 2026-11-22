import { useState } from 'react'
import { Cpu, Download, FolderOpen, Gauge, Plug, Power, RefreshCw, Sparkles, Waves } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { STRIP_ORDER } from '../../data/defaults'
import { useUi } from '../../store/useUi'
import { connectAiSidecar, disconnectAiSidecar, pingAiSidecar } from '../../lib/engineControl'
import { Knob } from '../controls/Knob'
import { Switch } from '../controls/Switch'
import { Select } from '../controls/Select'
import { AiConfig } from './AiConfig'

const MODES = [
  { id: 'off', label: 'OFF', hint: 'Тракт без ИИ' },
  { id: 'dsp', label: 'DSP', hint: 'Только DSP-пресеты' },
  { id: 'ai', label: 'AI', hint: 'Только конверсия' },
  { id: 'hybrid', label: 'HYBRID', hint: 'DSP + конверсия' },
] as const

const VOICE_PRESETS = [
  { id: 'monster', name: 'Монстр', pitch: -7, formant: -5, mix: 100, hint: 'Глубокий, тяжёлый, страшный' },
  { id: 'demon', name: 'Демон', pitch: -10, formant: -7, mix: 95, hint: 'Максимально низкий и злой' },
  { id: 'giant', name: 'Великан', pitch: -4, formant: -3, mix: 100, hint: 'Большой и спокойный' },
  { id: 'child', name: 'Ребёнок', pitch: 5, formant: 4, mix: 100, hint: 'Высокий детский голос' },
  { id: 'girl', name: 'Женский', pitch: 3, formant: 3, mix: 100, hint: 'Мягкий женский тембр' },
  { id: 'alien', name: 'Пришелец', pitch: 8, formant: 6, mix: 100, hint: 'Тонкий и странный' },
  { id: 'robot', name: 'Робот', pitch: 0, formant: 4, mix: 100, hint: 'Металлический оттенок', robot: true },
  { id: 'whisper', name: 'Шёпот', pitch: 1, formant: 5, mix: 100, hint: 'Воздушный, тихий' },
] as const

export function AiPanel() {
  const ai = useMixer((s) => s.ai)
  const models = useMixer((s) => s.aiModels)
  const status = useMixer((s) => s.status)
  const strips = useMixer((s) => s.strips)
  const setAi = useMixer((s) => s.setAi)
  const notify = useUi((s) => s.notify)

  const model = models.find((m) => m.id === ai.modelId)
  const mode = ai.enabled ? ai.mode : 'off'
  const link = status.ai
  const connected = link.state === 'ready'
  const [busy, setBusy] = useState(false)

  const converterConfig = () => ({
    model: ai.modelId,
    pitch: ai.pitch,
    formant: ai.formant,
    index_rate: ai.indexRate,
    mix: ai.mix / 100,
    chunk_ms: ai.chunkMs,
    crossfade_ms: ai.crossfadeMs,
    gpu_index: ai.gpuIndex,
    denoise: ai.denoise,
    gate_db: ai.gateDb,
  })

  const connect = async () => {
    setBusy(true)
    const result = await connectAiSidecar(converterConfig())
    setBusy(false)
    if (result.ok) setAi({ local: false, enabled: true, mode: 'ai' })
    notify(
      result.ok
        ? `Sidecar подключён · ${result.ai?.backend ?? 'unknown'}`
        : result.error ?? 'Не удалось подключить sidecar',
    )
  }

  const disconnect = async () => {
    setBusy(true)
    const result = await disconnectAiSidecar()
    setBusy(false)
    if (result.ok) setAi({ local: true, mode: 'dsp' })
    notify(result.ok ? 'Sidecar отключён · включён локальный голос' : result.error ?? 'Не удалось отключить sidecar')
  }

  const applyVoice = (preset: (typeof VOICE_PRESETS)[number]) => {
    setAi({
      enabled: true,
      mode: 'dsp',
      local: true,
      source: ai.source ?? 'hw1',
      pitch: preset.pitch,
      formant: preset.formant,
      mix: preset.mix,
      robot: 'robot' in preset ? Boolean(preset.robot) : false,
    })
    notify(`Голос: ${preset.name}`)
  }

  const ping = async () => {
    setBusy(true)
    const result = await pingAiSidecar()
    setBusy(false)
    notify(
      result.ok
        ? `Sidecar отвечает · ${result.ai?.roundtripMs?.toFixed(1) ?? '—'} мс`
        : result.error ?? 'Sidecar не ответил',
    )
  }

  return (
    <>
      <div className="ai-hero">
        <div className="ai-hero-title">
          <Sparkles size={15} className="spark" />
          NEXUS VOICE AI
          <span className="pill" style={{ marginLeft: 'auto' }}>
            {ai.local ? 'LOCAL DSP' : 'RVC v2'}
          </span>
        </div>
        <div className="ai-hero-sub">
          Локальная конверсия тембра. Аудио не покидает машину.
        </div>
        <div className="ai-status">
          <span
            className={`dot ${connected ? 'good' : link.state === 'error' ? 'bad' : ''}`}
            style={{
              width: 6,
              height: 6,
              borderRadius: 99,
              background: connected ? 'var(--good)' : link.state === 'error' ? 'var(--bad)' : 'var(--muted, #8b8b9a)',
            }}
          />
          <span>
            <b>{link.backend}</b> · {link.state === 'offline' ? 'sidecar не подключён' : link.state} · RTF{' '}
            {connected ? link.rtf.toFixed(2) : model ? model.rtf.toFixed(2) : '—'}
          </span>
        </div>
      </div>

      <section className="fx-block voice-lab">
        <header className="fx-block-head">
          <span className="fx-icon"><Waves size={13} /></span>
          <span className="fx-title">Локальные голоса</span>
          <span className="fx-sub">{ai.local && ai.enabled ? 'DSP · реальное время' : 'выключено'}</span>
          <Switch
            on={ai.local}
            onChange={(value) => setAi({ local: value, enabled: value || ai.enabled, mode: value ? 'dsp' : ai.mode })}
            ariaLabel="Локальный голос"
          />
        </header>
        <div className="fx-block-body">
          <div className="voice-preset-grid">
            {VOICE_PRESETS.map((preset) => {
              const active = ai.enabled && ai.local && ai.pitch === preset.pitch && ai.formant === preset.formant
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`voice-preset${active ? ' on' : ''}`}
                  onClick={() => applyVoice(preset)}
                  title={preset.hint}
                >
                  <span className="voice-preset-name">{preset.name}</span>
                  <span className="voice-preset-meta">{preset.pitch > 0 ? '+' : ''}{preset.pitch} st · formant {preset.formant > 0 ? '+' : ''}{preset.formant}</span>
                </button>
              )
            })}
            <button
              type="button"
              className={`voice-preset off${!ai.enabled || !ai.local ? ' on' : ''}`}
              onClick={() => setAi({ enabled: false, local: false })}
            >
              <span className="voice-preset-name">Без эффекта</span>
              <span className="voice-preset-meta">обычный голос</span>
            </button>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="ai-source">Источник голоса</label>
            <Select
              value={ai.source ?? 'hw1'}
              options={STRIP_ORDER.slice(0, 6).map((id) => ({
                value: id,
                label: `${strips[id]?.name ?? id} · ${strips[id]?.deviceId || 'нет устройства'}`,
              }))}
              onChange={(val) => setAi({ source: val as typeof ai.source })}
            />
          </div>
          <p className="tiny faint" style={{ margin: '8px 0 0', lineHeight: 1.45 }}>
            Работает сразу, без Python и скачивания моделей. Для тонкой настройки — PITCH, FORMANT и MIX ниже.
          </p>
        </div>
      </section>

      <AiConfig />

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <Plug size={13} />
          </span>
          <span className="fx-title">Локальный sidecar</span>
          <span className="fx-sub">{connected ? link.backend : link.state.toUpperCase()}</span>
        </header>
        <div className="fx-block-body">
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <span className="tiny faint">{link.endpoint}</span>
            <span className="tag">
              {link.sampleRate} Hz · {link.chunkFrames} кадров
            </span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {connected ? (
              <button type="button" className="btn small grow" onClick={disconnect} disabled={busy}>
                <Power size={12} /> Отключить
              </button>
            ) : (
              <button type="button" className="btn small grow" onClick={connect} disabled={busy}>
                <Plug size={12} /> Подключить sidecar
              </button>
            )}
            <button
              type="button"
              className="btn small"
              onClick={ping}
              disabled={busy || !connected}
              title="Проверить связь (ping)"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <p className="tiny faint" style={{ margin: '8px 0 0', lineHeight: 1.45 }}>
            {link.message}
          </p>
          {link.model ? (
            <p className="tiny faint" style={{ margin: '4px 0 0' }}>
              Модель: <span className="accent">{link.model}</span>
            </p>
          ) : null}
        </div>
      </section>

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <Waves size={13} />
          </span>
          <span className="fx-title">Режим тракта</span>
          <span className="fx-sub">{ai.enabled ? ai.mode.toUpperCase() : 'BYPASS'}</span>
          <Switch on={ai.enabled} onChange={(value) => setAi({ enabled: value })} ariaLabel="Включить ИИ-голос" />
        </header>
        <div className="fx-block-body">
          <div className="seg" style={{ width: '100%' }}>
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.hint}
                className={mode === item.id ? 'on' : ''}
                style={{ flex: 1 }}
                onClick={() => {
                  if (item.id === 'off') setAi({ enabled: false, local: false })
                  else setAi({ enabled: true, mode: item.id, local: item.id === 'dsp' })
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <Cpu size={13} />
          </span>
          <span className="fx-title">Модель голоса</span>
          <span className="fx-sub">{models.filter((m) => m.installed).length} установлено</span>
        </header>
        <div className="fx-block-body">
          <div className="model-list">
            {models.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`model-card${item.id === ai.modelId ? ' on' : ''}`}
                onClick={() => {
                  setAi({ modelId: item.id })
                  if (!item.installed) notify(`«${item.name}» ещё не скачана — нажмите «СКАЧАТЬ»`)
                }}
              >
                <span className="model-avatar">{item.name.slice(0, 1)}</span>
                <span className="model-info">
                  <span className="model-name">{item.name}</span>
                  <span className="model-meta">
                    <span>{item.language}</span>
                    <span>·</span>
                    <span>{(item.sampleRate / 1000).toFixed(0)} kHz</span>
                    <span>·</span>
                    <span>{item.sizeMb} MB</span>
                    <span>·</span>
                    <span className="tag">RTF {item.rtf.toFixed(2)}</span>
                  </span>
                </span>
                <span className="model-install" style={item.installed ? { color: 'var(--good)' } : undefined}>
                  {item.installed ? '✓' : 'СКАЧАТЬ'}
                </span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn small grow" onClick={() => notify('Импорт модели: выберите .onnx + .index в диалоге')}>
              <Download size={12} /> Импорт модели
            </button>
            <button type="button" className="btn small" onClick={() => notify('Папка моделей: %APPDATA%\\Nexus-Mixer\\models')}>
              <FolderOpen size={12} />
            </button>
          </div>
        </div>
      </section>

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <Gauge size={13} />
          </span>
          <span className="fx-title">Параметры конверсии</span>
          <span className="fx-sub">{ai.chunkMs} ms chunk</span>
        </header>
        <div className="fx-block-body">
          <div className="knob-row">
            <Knob
              label="PITCH"
              value={ai.pitch}
              min={-24}
              max={24}
              step={1}
              unit=" st"
              defaultValue={0}
              format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(0)} st`}
              onChange={(value) => setAi({ pitch: value })}
            />
            <Knob
              label="FORMANT"
              value={ai.formant}
              min={-12}
              max={12}
              step={0.5}
              unit=" st"
              defaultValue={0}
              onChange={(value) => setAi({ formant: value })}
            />
            <Knob
              label="MIX"
              value={ai.mix}
              min={0}
              max={100}
              step={1}
              unit="%"
              defaultValue={100}
              onChange={(value) => setAi({ mix: value })}
            />
          </div>
          <div className="knob-row" style={{ marginTop: 10 }}>
            <Knob
              label="INDEX"
              value={ai.indexRate}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.75}
              format={(value) => value.toFixed(2)}
              onChange={(value) => setAi({ indexRate: value })}
            />
            <Knob
              label="GATE"
              value={ai.gateDb}
              min={-90}
              max={0}
              step={1}
              unit=" dB"
              defaultValue={-55}
              onChange={(value) => setAi({ gateDb: value })}
            />
            <Knob
              label="X-FADE"
              value={ai.crossfadeMs}
              min={0}
              max={200}
              step={5}
              unit=" ms"
              defaultValue={40}
              onChange={(value) => setAi({ crossfadeMs: value })}
            />
            <Knob
              label="EXTRA CTX"
              value={ai.extraContext}
              min={0}
              max={20}
              step={1}
              unit=" fr"
              defaultValue={2}
              onChange={(value) => setAi({ extraContext: value })}
            />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="ai-chunk">Размер чанка</label>
            <Select
              value={String(ai.chunkMs)}
              options={[
                { value: '40', label: '40 ms — минимальная задержка' },
                { value: '80', label: '80 ms' },
                { value: '120', label: '120 ms — баланс' },
                { value: '160', label: '160 ms' },
                { value: '240', label: '240 ms' },
                { value: '320', label: '320 ms — максимальное качество' },
              ]}
              onChange={(val) => setAi({ chunkMs: Number(val) as typeof ai.chunkMs })}
            />
          </div>

          <div className="field" style={{ marginTop: 9 }}>
            <label htmlFor="ai-gpu">Устройство инференса</label>
            <Select
              value={String(ai.gpuIndex)}
              options={[
                { value: '0', label: 'GPU 0 — CUDA' },
                { value: '1', label: 'GPU 1 — CUDA' },
                { value: '-1', label: 'CPU — медленно, но совместимо' },
              ]}
              onChange={(val) => setAi({ gpuIndex: Number(val) })}
            />
          </div>

          <div className="toggle-row">
            <span className="t-label">Шумоподавление до конверсии</span>
            <Switch on={ai.denoise} onChange={(value) => setAi({ denoise: value })} ariaLabel="Шумоподавление" />
          </div>
        </div>
      </section>

      <div className="ai-warning">
        В Discord / OBS выберите вход <span className="accent">Nexus Cable B1</span>, направьте микрофон
        на шину B1 — и включите локальный голос выше. Sidecar не обязателен.
      </div>
    </>
  )
}
