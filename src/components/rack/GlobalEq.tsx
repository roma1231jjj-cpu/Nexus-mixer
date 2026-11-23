import { Waves } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { Knob } from '../controls/Knob'
import { Switch } from '../controls/Switch'
import { EqEditor } from '../controls/EqEditor'
import { EqBands } from './EqBands'
import { SpectrumAnalyzer } from '../controls/SpectrumAnalyzer'
import { HelpTip } from '../controls/HelpTip'
import { useT } from '../../i18n'

/**
 * Master section EQ: applied to every bus after its own processing.
 * State lives in the mixer store and is published to the Rust graph with each
 * snapshot, so it persists and audibly affects the output.
 */
export function GlobalEq() {
  const t = useT()
  const sampleRate = useMixer((s) => s.engine.sampleRate)
  const bands = useMixer((s) => s.masterEq)
  const enabled = useMixer((s) => s.masterEqEnabled)
  const masterGainDb = useMixer((s) => s.masterGainDb)
  const setMasterEqBand = useMixer((s) => s.setMasterEqBand)
  const setMasterEqEnabled = useMixer((s) => s.setMasterEqEnabled)
  const setMasterGainDb = useMixer((s) => s.setMasterGainDb)

  const activeCount = bands.filter((band) => band.enabled).length

  return (
    <section className="fx-block">
      <header className="fx-block-head">
        <span className="fx-icon">
          <Waves size={13} />
        </span>
        <span className="fx-title">Master EQ</span>
        <HelpTip text={t('eq.masterHelp')} />
        <span className="fx-sub">{t('fx.bands', { on: activeCount, total: bands.length })}</span>
        <Switch on={enabled} onChange={setMasterEqEnabled} ariaLabel={t('eq.masterSwitch')} />
      </header>
      <div className="fx-block-body">
        <div className="knob-row">
          <Knob
            label="MASTER GAIN"
            value={masterGainDb}
            min={-24}
            max={12}
            step={0.5}
            unit=" dB"
            defaultValue={0}
            onChange={setMasterGainDb}
          />
        </div>
        <div className={`eq-bypassed${enabled ? ' active' : ''}`}>
          <EqEditor bands={bands} sampleRate={sampleRate} color="var(--accent)" onBandChange={setMasterEqBand} />
          <div className="eq-hint">
            <span>20 Hz</span>
            <span>1 kHz</span>
            <span>20 kHz</span>
          </div>
          <EqBands bands={bands} color="var(--accent)" onChange={setMasterEqBand} />
        </div>
        <div className="spectrum-wrap">
          <div className="spectrum-label">
            <span>OUTPUT SPECTRUM · A1</span>
            <HelpTip text={t('eq.spectrumHelp')} />
          </div>
          <SpectrumAnalyzer active={enabled} width={280} height={54} color="var(--accent)" source={{ kind: 'bus', index: 0 }} />
        </div>
      </div>
    </section>
  )
}
