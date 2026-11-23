import type { ReactNode } from 'react'
import { Activity, AudioWaveform, Flame, Gauge, Scissors, SlidersHorizontal, Sparkles, Save } from 'lucide-react'
import type { BusId, Strip } from '../../types'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { Knob } from '../controls/Knob'
import { Switch } from '../controls/Switch'
import { EqEditor } from '../controls/EqEditor'
import { EqBands } from './EqBands'
import { HelpTip } from '../controls/HelpTip'
import { Select } from '../controls/Select'
import { BUS_ORDER } from '../../data/defaults'
import { useT, useLocale } from '../../i18n'

function FxBlock({
  icon,
  title,
  sub,
  enabled,
  onToggle,
  help,
  children,
}: {
  icon: ReactNode
  title: string
  sub: string
  enabled?: boolean
  onToggle?: (value: boolean) => void
  help?: string
  children: ReactNode
}) {
  const t = useT()
  return (
    <section className={`fx-block${enabled === false ? ' disabled' : ''}`}>
      <header className="fx-block-head">
        <span className="fx-icon">{icon}</span>
        <span className="fx-title">{title}</span>
        {help ? <HelpTip text={help} /> : null}
        <span className="fx-sub">{sub}</span>
        {onToggle ? (
          <Switch on={Boolean(enabled)} onChange={onToggle} ariaLabel={t('rack.enable', { title })} />
        ) : null}
      </header>
      <div className="fx-block-body">{children}</div>
    </section>
  )
}

const sign = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)}`

const BUS_LABELS = (id: BusId): string => id

export function StripFx({ strip }: { strip: Strip }) {
  const t = useT()
  const locale = useLocale()
  const setStrip = useMixer((s) => s.setStrip)
  const setStripFx = useMixer((s) => s.setStripFx)
  const setStripEqBand = useMixer((s) => s.setStripEqBand)
  const setRoute = useMixer((s) => s.setRoute)
  const toggleRoute = useMixer((s) => s.toggleRoute)
  const savePreset = useMixer((s) => s.savePreset)
  const sampleRate = useMixer((s) => s.engine.sampleRate)
  const devices = useMixer((s) => s.devices)
  const openRack = useUi((s) => s.openRack)
  const notify = useUi((s) => s.notify)

  const { gate, compressor, deesser, saturator, eq } = strip.fx
  const eqAny = eq.some((band) => band.enabled)

  const toggleEq = (value: boolean) => {
    setStripFx(strip.id, { eq: eq.map((band) => ({ ...band, enabled: value })) })
  }

  return (
    <>
      <FxBlock
        icon={<SlidersHorizontal size={13} />}
        title={t('fx.preamp')}
        sub={t('fx.preampSub', { kind: strip.kind === 'virtual' ? t('fx.kind.virtual') : t('fx.kind.hardware') })}
      >
        <div className="knob-row">
          <Knob
            label="GAIN"
            value={strip.gainDb}
            min={-60}
            max={12}
            step={0.5}
            unit=" dB"
            defaultValue={0}
            onChange={(value) => setStrip(strip.id, { gainDb: value })}
          />
          <Knob
            label="PAN"
            value={strip.pan}
            min={-1}
            max={1}
            step={0.01}
            defaultValue={0}
            format={(value) => (Math.abs(value) < 0.005 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`)}
            onChange={(value) => setStrip(strip.id, { pan: value })}
          />
          <Knob
            label="TILT"
            value={strip.voiceTiltDb}
            min={-20}
            max={20}
            step={0.5}
            unit=" dB"
            defaultValue={0}
            onChange={(value) => setStrip(strip.id, { voiceTiltDb: value })}
          />
        </div>
        <div className="fx-switches">
          <button
            type="button"
            className={`mini-toggle${strip.mono ? ' on' : ''}`}
            onClick={() => setStrip(strip.id, { mono: !strip.mono })}
          >
            MONO
          </button>
          <button
            type="button"
            className={`mini-toggle${strip.phase ? ' on' : ''}`}
            onClick={() => setStrip(strip.id, { phase: !strip.phase })}
          >
            Ø PHASE
          </button>
          <button
            type="button"
            className={`mini-toggle${strip.phantom ? ' on' : ''}`}
            disabled={strip.kind === 'virtual'}
            onClick={() => setStrip(strip.id, { phantom: !strip.phantom })}
          >
            +48V
          </button>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor={`device-${strip.id}`}>{t('fx.input')}</label>
          <Select
            value={strip.deviceId}
            options={[
              { value: '', label: t('fx.notAssigned') },
              ...devices
                .filter((device) => device.kind === 'input' || device.kind === 'virtual-capture')
                .map((device) => ({ value: device.id, label: device.name })),
            ]}
            onChange={(value) => setStrip(strip.id, { deviceId: value })}
          />
        </div>
      </FxBlock>

      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <SlidersHorizontal size={13} />
          </span>
          <span className="fx-title">{t('fx.sends')}</span>
          <span className="fx-sub">{t('fx.sendsSub')}</span>
        </header>
        <div className="fx-block-body">
          <div className="routing-sends">
            {BUS_ORDER.map((busId) => {
              const route = strip.routing[busId]
              return (
                <div key={busId} className="send-cell">
                  <button
                    type="button"
                    className={`send-on-btn${route.on ? ' on' : ' off'}`}
                    onClick={() => toggleRoute(strip.id, busId)}
                  >
                    {BUS_LABELS(busId)}
                  </button>
                  <Knob
                    label="LEVEL"
                    value={route.levelDb}
                    min={-60}
                    max={12}
                    step={0.5}
                    unit=" dB"
                    color={busId === 'A1' || busId === 'A2' || busId === 'A3' ? 'var(--good)' : 'var(--blue)'}
                    defaultValue={0}
                    disabled={!route.on}
                    size={28}
                    onChange={(value) => setRoute(strip.id, busId, { levelDb: value })}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <FxBlock
        icon={<Activity size={13} />}
        title={t('fx.gate')}
        sub={gate.enabled ? `${gate.threshold.toFixed(0)} dB · ${gate.range.toFixed(0)} dB` : t('fx.bypass')}
        enabled={gate.enabled}
        onToggle={(value) => setStripFx(strip.id, { gate: { ...gate, enabled: value } })}
        help={t('fx.gateHelp')}
      >
        <div className="knob-row">
          <Knob
            label="THRESH"
            value={gate.threshold}
            min={-90}
            max={0}
            step={1}
            unit=" dB"
            defaultValue={-48}
            onChange={(value) => setStripFx(strip.id, { gate: { ...gate, threshold: value } })}
          />
          <Knob
            label="RANGE"
            value={gate.range}
            min={-90}
            max={0}
            step={1}
            unit=" dB"
            defaultValue={-60}
            onChange={(value) => setStripFx(strip.id, { gate: { ...gate, range: value } })}
          />
          <Knob
            label="ATTACK"
            value={gate.attack}
            min={0.1}
            max={100}
            step={0.1}
            unit=" ms"
            defaultValue={5}
            onChange={(value) => setStripFx(strip.id, { gate: { ...gate, attack: value } })}
          />
          <Knob
            label="HOLD"
            value={gate.hold}
            min={0}
            max={500}
            step={1}
            unit=" ms"
            defaultValue={80}
            onChange={(value) => setStripFx(strip.id, { gate: { ...gate, hold: value } })}
          />
          <Knob
            label="RELEASE"
            value={gate.release}
            min={5}
            max={2000}
            step={5}
            unit=" ms"
            defaultValue={220}
            onChange={(value) => setStripFx(strip.id, { gate: { ...gate, release: value } })}
          />
        </div>
      </FxBlock>

      <FxBlock
        icon={<Gauge size={13} />}
        title={t('fx.compressor')}
        sub={
          compressor.enabled
            ? `${compressor.threshold.toFixed(0)} dB · ${compressor.ratio.toFixed(1)}:1 · ${sign(compressor.makeup)}`
            : t('fx.bypass')
        }
        enabled={compressor.enabled}
        onToggle={(value) => setStripFx(strip.id, { compressor: { ...compressor, enabled: value } })}
        help={t('fx.compressorHelp')}
      >
        <div className="knob-row">
          <Knob
            label="THRESH"
            value={compressor.threshold}
            min={-60}
            max={0}
            step={0.5}
            unit=" dB"
            defaultValue={-18}
            onChange={(value) => setStripFx(strip.id, { compressor: { ...compressor, threshold: value } })}
          />
          <Knob
            label="RATIO"
            value={compressor.ratio}
            min={1}
            max={20}
            step={0.1}
            unit=":1"
            defaultValue={3}
            format={(value) => `${value.toFixed(1)}:1`}
            onChange={(value) => setStripFx(strip.id, { compressor: { ...compressor, ratio: value } })}
          />
          <Knob
            label="KNEE"
            value={compressor.knee}
            min={0}
            max={24}
            step={0.5}
            unit=" dB"
            defaultValue={6}
            onChange={(value) => setStripFx(strip.id, { compressor: { ...compressor, knee: value } })}
          />
        </div>
        <div className="knob-row">
          <Knob
            label="ATTACK"
            value={compressor.attack}
            min={0.1}
            max={250}
            step={0.1}
            unit=" ms"
            defaultValue={12}
            onChange={(value) => setStripFx(strip.id, { compressor: { ...compressor, attack: value } })}
          />
          <Knob
            label="RELEASE"
            value={compressor.release}
            min={5}
            max={2000}
            step={5}
            unit=" ms"
            defaultValue={180}
            onChange={(value) => setStripFx(strip.id, { compressor: { ...compressor, release: value } })}
          />
          <Knob
            label="MAKEUP"
            value={compressor.makeup}
            min={0}
            max={24}
            step={0.5}
            unit=" dB"
            defaultValue={3}
            onChange={(value) => setStripFx(strip.id, { compressor: { ...compressor, makeup: value } })}
          />
        </div>
        {/* Makeup gain is a real parameter; live gain reduction is not exposed by
            the engine yet, so we do not fake a GR meter. */}
        <div className="fx-section-divider">{t('fx.makeupGain')}</div>
        <div className="gr-meter" style={{ '--gr': `${Math.min(compressor.makeup, 24) / 24 * 100}%` } as never}>
          <div className="gr-meter-fill" />
        </div>
        <div className="fx-stats">
          <span><b>Ratio</b> {compressor.ratio.toFixed(1)}:1</span>
          <span className="stat-good"><b>Makeup</b> +{compressor.makeup.toFixed(1)} dB</span>
          <span><b>Knee</b> {compressor.knee.toFixed(1)} dB</span>
        </div>
      </FxBlock>

      <FxBlock
        icon={<AudioWaveform size={13} />}
        title={t('fx.equalizer')}
        sub={t('fx.bands', { on: eq.filter((band) => band.enabled).length, total: 10 })}
        enabled={eqAny}
        onToggle={toggleEq}
      >
        <EqEditor
          bands={eq}
          sampleRate={sampleRate}
          color={strip.color}
          onBandChange={(bandId, patch) => setStripEqBand(strip.id, bandId, patch)}
        />
        <div className="eq-hint">
          <span>20 Hz</span>
          <span>1 kHz</span>
          <span>20 kHz</span>
        </div>
        <EqBands
          bands={eq}
          color={strip.color}
          onChange={(bandId, patch) => setStripEqBand(strip.id, bandId, patch)}
        />
      </FxBlock>

      <FxBlock
        icon={<Scissors size={13} />}
        title={t('fx.deesser')}
        sub={deesser.enabled ? `${(deesser.frequency / 1000).toFixed(1)} kHz · ${deesser.amount}%` : t('fx.bypass')}
        enabled={deesser.enabled}
        onToggle={(value) => setStripFx(strip.id, { deesser: { ...deesser, enabled: value } })}
        help={t('fx.deesserHelp')}
      >
        <div className="knob-row">
          <Knob
            label="FREQ"
            value={deesser.frequency}
            min={2000}
            max={12000}
            step={50}
            format={(value) => `${(value / 1000).toFixed(1)}k`}
            defaultValue={6500}
            onChange={(value) => setStripFx(strip.id, { deesser: { ...deesser, frequency: value } })}
          />
          <Knob
            label="THRESH"
            value={deesser.threshold}
            min={-60}
            max={0}
            step={1}
            unit=" dB"
            defaultValue={-30}
            onChange={(value) => setStripFx(strip.id, { deesser: { ...deesser, threshold: value } })}
          />
          <Knob
            label="AMOUNT"
            value={deesser.amount}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={45}
            onChange={(value) => setStripFx(strip.id, { deesser: { ...deesser, amount: value } })}
          />
        </div>
      </FxBlock>

      <FxBlock
        icon={<Flame size={13} />}
        title={t('fx.saturator')}
        sub={saturator.enabled ? `${saturator.drive}% drive · ${saturator.mix}% mix` : t('fx.bypass')}
        enabled={saturator.enabled}
        onToggle={(value) => setStripFx(strip.id, { saturator: { ...saturator, enabled: value } })}
        help={t('fx.saturatorHelp')}
      >
        <div className="knob-row">
          <Knob
            label="DRIVE"
            value={saturator.drive}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={22}
            onChange={(value) => setStripFx(strip.id, { saturator: { ...saturator, drive: value } })}
          />
          <Knob
            label="TONE"
            value={saturator.tone}
            min={-100}
            max={100}
            step={1}
            unit="%"
            defaultValue={0}
            onChange={(value) => setStripFx(strip.id, { saturator: { ...saturator, tone: value } })}
          />
          <Knob
            label="MIX"
            value={saturator.mix}
            min={0}
            max={100}
            step={1}
            unit="%"
            defaultValue={30}
            onChange={(value) => setStripFx(strip.id, { saturator: { ...saturator, mix: value } })}
          />
        </div>
      </FxBlock>

      <div className="fx-footer">
        <button
          type="button"
          className="btn"
          onClick={() => {
            savePreset(`${strip.name} · ${new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`)
            notify(t('fx.presetSaved'))
          }}
        >
          <Save size={13} /> {t('fx.savePreset')}
        </button>
        <button type="button" className="btn primary" onClick={() => openRack('ai')}>
          <Sparkles size={13} /> {t('fx.aiVoice')}
        </button>
      </div>
    </>
  )
}
