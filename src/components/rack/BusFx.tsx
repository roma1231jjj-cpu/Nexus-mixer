import { AudioWaveform, Shield, SlidersHorizontal } from 'lucide-react'
import type { Bus } from '../../types'
import { useMixer } from '../../store/useMixer'
import { Knob } from '../controls/Knob'
import { Switch } from '../controls/Switch'
import { EqEditor } from '../controls/EqEditor'
import { EqBands } from './EqBands'
import { Select } from '../controls/Select'

export function BusFx({ bus }: { bus: Bus }) {
  const setBus = useMixer((s) => s.setBus)
  const setBusFx = useMixer((s) => s.setBusFx)
  const setBusEqBand = useMixer((s) => s.setBusEqBand)
  const sampleRate = useMixer((s) => s.engine.sampleRate)
  const devices = useMixer((s) => s.devices)
  const { eq, limiter, delayMs, width } = bus.fx
  const eqAny = eq.some((band) => band.enabled)

  return (
    <>
      <section className="fx-block">
        <header className="fx-block-head">
          <span className="fx-icon">
            <SlidersHorizontal size={13} />
          </span>
          <span className="fx-title">Output</span>
          <span className="fx-sub">{bus.kind === 'virtual' ? 'virtual bus' : 'physical out'}</span>
        </header>
        <div className="fx-block-body">
          <div className="knob-row">
            <Knob
              label="DELAY"
              value={delayMs}
              min={0}
              max={500}
              step={0.5}
              unit=" ms"
              defaultValue={0}
              onChange={(value) => setBusFx(bus.id, { delayMs: value })}
            />
            <Knob
              label="WIDTH"
              value={width}
              min={0}
              max={200}
              step={1}
              unit="%"
              defaultValue={100}
              onChange={(value) => setBusFx(bus.id, { width: value })}
            />
            <Knob
              label="GAIN"
              value={bus.gainDb}
              min={-60}
              max={12}
              step={0.5}
              unit=" dB"
              defaultValue={0}
              onChange={(value) => useMixer.getState().setBus(bus.id, { gainDb: value })}
            />
          </div>
          {/* Bus mode toggles */}
          <div className="fx-switches">
            <button
              type="button"
              className={`mini-toggle${bus.mute ? ' on mute' : ''}`}
              onClick={() => setBus(bus.id, { mute: !bus.mute })}
            >
              MUTE
            </button>
            <button
              type="button"
              className={`mini-toggle${bus.mono ? ' on' : ''}`}
              onClick={() => setBus(bus.id, { mono: !bus.mono })}
            >
              MONO
            </button>
            <button
              type="button"
              className={`mini-toggle${bus.dim ? ' on' : ''}`}
              onClick={() => setBus(bus.id, { dim: !bus.dim })}
            >
              DIM −20
            </button>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor={`bus-device-${bus.id}`}>Устройство вывода</label>
            <Select
              value={bus.deviceId}
              options={[
                { value: '', label: '— не назначено —' },
                ...devices
                  .filter((device) => device.kind === 'output' || device.kind === 'virtual-playback')
                  .map((device) => ({ value: device.id, label: device.name })),
              ]}
              onChange={(value) => setBus(bus.id, { deviceId: value })}
            />
          </div>
        </div>
      </section>

      <section className={`fx-block${!limiter.enabled ? ' disabled' : ''}`}>
        <header className="fx-block-head">
          <span className="fx-icon">
            <Shield size={13} />
          </span>
          <span className="fx-title">Limiter</span>
          <span className="fx-sub">{limiter.enabled ? `${limiter.ceiling.toFixed(1)} dBFS` : 'bypass'}</span>
          <Switch
            on={limiter.enabled}
            onChange={(value) => setBusFx(bus.id, { limiter: { ...limiter, enabled: value } })}
            ariaLabel="Включить лимитер"
          />
        </header>
        <div className="fx-block-body">
          <div className="knob-row">
            <Knob
              label="CEILING"
              value={limiter.ceiling}
              min={-12}
              max={0}
              step={0.1}
              unit=" dB"
              defaultValue={-1}
              onChange={(value) => setBusFx(bus.id, { limiter: { ...limiter, ceiling: value } })}
            />
            <Knob
              label="RELEASE"
              value={limiter.release}
              min={5}
              max={1000}
              step={5}
              unit=" ms"
              defaultValue={80}
              onChange={(value) => setBusFx(bus.id, { limiter: { ...limiter, release: value } })}
            />
          </div>
          <div className="fx-stats">
            <span><b>Ceiling</b> {limiter.ceiling.toFixed(1)} dBFS</span>
            <span><b>Release</b> {limiter.release} ms</span>
          </div>
        </div>
      </section>

      <section className={`fx-block${!eqAny ? ' disabled' : ''}`}>
        <header className="fx-block-head">
          <span className="fx-icon">
            <AudioWaveform size={13} />
          </span>
          <span className="fx-title">Bus EQ</span>
          <span className="fx-sub">{eq.filter((band) => band.enabled).length}/10 bands</span>
          <Switch
            on={eqAny}
            onChange={(value) => setBusFx(bus.id, { eq: eq.map((band) => ({ ...band, enabled: value })) })}
            ariaLabel="Включить эквалайзер шины"
          />
        </header>
        <div className="fx-block-body">
          <EqEditor
            bands={eq}
            sampleRate={sampleRate}
            color={bus.color}
            onBandChange={(bandId, patch) => setBusEqBand(bus.id, bandId, patch)}
          />
          <div className="eq-hint">
            <span>20 Hz</span>
            <span>1 kHz</span>
            <span>20 kHz</span>
          </div>
          <EqBands
            bands={eq}
            color={bus.color}
            onChange={(bandId, patch) => setBusEqBand(bus.id, bandId, patch)}
          />
        </div>
      </section>

      <div className="fx-note">
        Шина {bus.id} · {bus.kind === 'virtual' ? 'уходит в виртуальный кабель Nexus' : 'физический выход'}
        {bus.fx.delayMs > 0 ? ` · задержка ${bus.fx.delayMs.toFixed(1)} мс` : ''}
        {bus.dim ? ' · DIM активен' : ''}
      </div>
    </>
  )
}
