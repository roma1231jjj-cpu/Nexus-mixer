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
import { useT, type TKey } from '../../i18n'
import { RichText } from '../RichText'

const MODES = [
  { id: 'off', label: 'OFF', hint: 'ai.mode.off' },
  { id: 'dsp', label: 'DSP', hint: 'ai.mode.dsp' },
  { id: 'ai', label: 'AI', hint: 'ai.mode.ai' },
  { id: 'hybrid', label: 'HYBRID', hint: 'ai.mode.hybrid' },
] as const

const VOICE_PRESETS = [
  { id: 'monster', pitch: -7, formant: -5, mix: 100 },
  { id: 'demon', pitch: -10, formant: -7, mix: 95 },
  { id: 'giant', pitch: -4, formant: -3, mix: 100 },
  { id: 'child', pitch: 5, formant: 4, mix: 100 },
  { id: 'girl', pitch: 3, formant: 3, mix: 100 },
  { id: 'alien', pitch: 8, formant: 6, mix: 100 },
  { id: 'robot', pitch: 0, formant: 4, mix: 100, robot: true },
  { id: 'whisper', pitch: 1, formant: 5, mix: 100 },
] as const

const voiceKey = (id: string, part: 'name' | 'hint'): TKey => `voice.${id}.${part}` as TKey

export function AiPanel() {
  const t = useT()
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
        ? t('ai.connected', { backend: result.ai?.backend ?? t('ai.unknown') })
        : result.error ?? t('ai.connectFailed'),
    )
  }

  const disconnect = async () => {
    setBusy(true)
    const result = await disconnectAiSidecar()
    setBusy(false)
    if (result.ok) setAi({ local: true, mode: 'dsp' })
    notify(result.ok ? t('ai.disconnected') : result.error ?? t('ai.disconnectFailed'))
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
    notify(t('ai.voice', { name: t(voiceKey(preset.id, 'name')) }))
  }

  const ping = async () => {
    setBusy(true)
    const result = await pingAiSidecar()
    setBusy(false)
    notify(
      result.ok
        ? t('ai.pong', { ms: result.ai?.roundtripMs?.toFixed(1) ?? '—' })
        : result.error ?? t('ai.noPong'),
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
        <div className="ai-hero-sub">{t('ai.heroSub')}</div>
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
            <b>{link.backend}</b> · {link.state === 'offline' ? t('ai.offlineSidecar') : link.state} · RTF{' '}
            {connected ? link.rtf.toFixed(2) : model ? model.rtf.toFixed(2) : '—'}
          </span>
        </div>
      </div>

      <section className="fx-block voice-lab">
        <header className="fx-block-head">
          <span className="fx-icon"><Waves size={13} /></span>
          <span className="fx-title">{t('ai.localVoices')}</span>
          <span className="fx-sub">{ai.local && ai.enabled ? t('ai.liveDsp') : t('ai.off')}</span>
          <Switch
            on={ai.local}
            onChange={(value) => setAi({ local: value, enabled: value || ai.enabled, mode: value ? 'dsp' : ai.mode })}
            ariaLabel={t('ai.localSwitch')}
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
                  title={t(voiceKey(preset.id, 'hint'))}
                >
                  <span className="voice-preset-name">{t(voiceKey(preset.id, 'name'))}</span>
                  <span className="voice-preset-meta">{preset.pitch > 0 ? '+' : ''}{preset.pitch} st · formant {preset.formant > 0 ? '+' : ''}{preset.formant}</span>
                </button>
              )
            })}
            <button
              type="button"
              className={`voice-preset off${!ai.enabled || !ai.local ? ' on' : ''}`}
              onClick={() => setAi({ enabled: false, local: false })}
            >
              <span className="voice-preset-name">{t('voice.none.name')}</span>
              <span className="voice-preset-meta">{t('voice.none.hint')}</span>
            </button>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="ai-source">{t('ai.source')}</label>
            <Select
              value={ai.source ?? 'hw1'}
              options={STRIP_ORDER.slice(0, 6).map((id) => ({
                value: id,
                label: `${strips[id]?.name ?? id} · ${strips[id]?.deviceId || t('ai.noDevice')}`,
              }))}
              onChange={(val) => setAi({ source: val as typeof ai.source })}
            />
          </div>
          <p className="tiny faint" style={{ margin: '8px 0 0', lineHeight: 1.45 }}>
            {t('ai.voiceNote')}
          </p>
        </div>
      </section>

      <AiConfig />

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <Plug size={13} />
          </span>
          <span className="fx-title">{t('ai.sidecar')}</span>
          <span className="fx-sub">{connected ? link.backend : link.state.toUpperCase()}</span>
        </header>
        <div className="fx-block-body">
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <span className="tiny faint">{link.endpoint}</span>
            <span className="tag">
              {link.sampleRate} Hz · {t('ai.frames', { n: link.chunkFrames })}
            </span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {connected ? (
              <button type="button" className="btn small grow" onClick={disconnect} disabled={busy}>
                <Power size={12} /> {t('ai.disconnect')}
              </button>
            ) : (
              <button type="button" className="btn small grow" onClick={connect} disabled={busy}>
                <Plug size={12} /> {t('ai.connectSidecar')}
              </button>
            )}
            <button
              type="button"
              className="btn small"
              onClick={ping}
              disabled={busy || !connected}
              title={t('ai.pingTip')}
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <p className="tiny faint" style={{ margin: '8px 0 0', lineHeight: 1.45 }}>
            {link.message}
          </p>
          {link.model ? (
            <p className="tiny faint" style={{ margin: '4px 0 0' }}>
              {t('ai.model')} <span className="accent">{link.model}</span>
            </p>
          ) : null}
        </div>
      </section>

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <Waves size={13} />
          </span>
          <span className="fx-title">{t('ai.chainMode')}</span>
          <span className="fx-sub">{ai.enabled ? ai.mode.toUpperCase() : 'BYPASS'}</span>
          <Switch on={ai.enabled} onChange={(value) => setAi({ enabled: value })} ariaLabel={t('ai.aiSwitch')} />
        </header>
        <div className="fx-block-body">
          <div className="seg" style={{ width: '100%' }}>
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                title={t(item.hint)}
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
          <span className="fx-title">{t('ai.voiceModel')}</span>
          <span className="fx-sub">{t('ai.installed', { n: models.filter((m) => m.installed).length })}</span>
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
                  if (!item.installed) notify(t('ai.notDownloaded', { name: item.name }))
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
                  {item.installed ? '✓' : t('ai.download')}
                </span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn small grow" onClick={() => notify(t('ai.importNote'))}>
              <Download size={12} /> {t('ai.importModel')}
            </button>
            <button type="button" className="btn small" onClick={() => notify(t('ai.modelsFolder'))}>
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
          <span className="fx-title">{t('ai.convParams')}</span>
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
            <label htmlFor="ai-chunk">{t('ai.chunkSize')}</label>
            <Select
              value={String(ai.chunkMs)}
              options={[
                { value: '40', label: t('ai.chunk40') },
                { value: '80', label: t('ai.chunk80') },
                { value: '120', label: t('ai.chunk120') },
                { value: '160', label: t('ai.chunk160') },
                { value: '240', label: t('ai.chunk240') },
                { value: '320', label: t('ai.chunk320') },
              ]}
              onChange={(val) => setAi({ chunkMs: Number(val) as typeof ai.chunkMs })}
            />
          </div>

          <div className="field" style={{ marginTop: 9 }}>
            <label htmlFor="ai-gpu">{t('ai.inference')}</label>
            <Select
              value={String(ai.gpuIndex)}
              options={[
                { value: '0', label: t('ai.gpu0') },
                { value: '1', label: t('ai.gpu1') },
                { value: '-1', label: t('ai.cpu') },
              ]}
              onChange={(val) => setAi({ gpuIndex: Number(val) })}
            />
          </div>

          <div className="toggle-row">
            <span className="t-label">{t('ai.denoise')}</span>
            <Switch on={ai.denoise} onChange={(value) => setAi({ denoise: value })} ariaLabel={t('ai.denoiseAria')} />
          </div>
        </div>
      </section>

      <div className="ai-warning">
        <RichText text={t('ai.warning')} />
      </div>
    </>
  )
}

export default AiPanel
