import { useMemo, useState } from 'react'
import { Radio, Sliders, Trash2 } from 'lucide-react'
import { useMidiLearn } from '../lib/midiLearnContext'
import { useMixer } from '../store/useMixer'
import { BUS_ORDER, STRIP_ORDER } from '../data/defaults'
import { Select } from './controls/Select'
import { useT, type TKey } from '../i18n'
import { RichText } from './RichText'

const PARAMS = [
  { value: 'gainDb', label: 'Level', min: -60, max: 12 },
  { value: 'pan', label: 'Pan', min: -1, max: 1 },
  { value: 'mute', label: 'Mute', min: 0, max: 1 },
  { value: 'solo', label: 'Solo', min: 0, max: 1 },
]

const STATUS_LABEL: Record<string, TKey> = {
  unsupported: 'midi.unsupported',
  idle: 'midi.idle',
  connecting: 'midi.connecting',
  ready: 'midi.ready',
  denied: 'midi.denied',
}

export function MidiLearnPanel() {
  const t = useT()
  const { mappings, isLearning, learningTarget, midiStatus, inputCount, startLearn, cancelLearn, removeMapping, injectCc, connectMidi } =
    useMidiLearn()
  const strips = useMixer((s) => s.strips)
  const buses = useMixer((s) => s.buses)

  const [scope, setScope] = useState<'strip' | 'bus'>('strip')
  const [channelId, setChannelId] = useState<string>('hw1')
  const [param, setParam] = useState('gainDb')

  const params = useMemo(
    () => (scope === 'strip' ? PARAMS : PARAMS.filter((item) => item.value !== 'pan' && item.value !== 'solo')),
    [scope],
  )

  const channelOptions =
    scope === 'strip'
      ? STRIP_ORDER.map((id) => ({ value: id, label: strips[id].name }))
      : BUS_ORDER.map((id) => ({ value: id, label: `${id} · ${buses[id].name}` }))

  const beginLearn = () => {
    const definition = params.find((item) => item.value === param) ?? params[0]
    startLearn(`${scope}.${definition.value}`, channelId, definition.min, definition.max)
  }

  return (
    <section className={`midi-panel${isLearning ? ' learning' : ''}`}>
      <header className="midi-head">
        <Sliders size={13} />
        <span className="midi-title">MIDI Learn</span>
        <span className={`midi-status ${midiStatus}`}>
          <i className="dot" />
          {t(STATUS_LABEL[midiStatus] ?? 'midi.idle')}
          {midiStatus === 'ready' ? ` · ${inputCount} in` : ''}
        </span>
        {(midiStatus === 'idle' || midiStatus === 'denied') && (
          <button type="button" className="btn small" onClick={connectMidi}>
            {t('midi.connect')}
          </button>
        )}
        <span className="midi-count">{mappings.length}</span>
      </header>

      <div className="midi-form">
        <Select
          value={scope}
          options={[
            { value: 'strip', label: t('midi.scope.strip') },
            { value: 'bus', label: t('midi.scope.bus') },
          ]}
          onChange={(value) => {
            const next = value as 'strip' | 'bus'
            setScope(next)
            setChannelId(next === 'strip' ? 'hw1' : 'A1')
            if (next === 'bus' && (param === 'pan' || param === 'solo')) setParam('gainDb')
          }}
          small
        />
        <Select value={channelId} options={channelOptions} onChange={setChannelId} small />
        <Select value={param} options={params} onChange={setParam} small />
        {isLearning ? (
          <button type="button" className="btn small danger" onClick={cancelLearn}>
            {t('midi.cancel')}
          </button>
        ) : (
          <button type="button" className="btn small primary" onClick={beginLearn}>
            <Radio size={11} /> Learn
          </button>
        )}
      </div>

      {isLearning && learningTarget ? (
        <div className="midi-learn-hint">
          <RichText text={t('midi.learnHint', { target: learningTarget.target })} />
        </div>
      ) : null}

      <div className="midi-test">
        <span>TEST CC#1</span>
        <input
          type="range"
          min={0}
          max={127}
          step={1}
          defaultValue={64}
          onChange={(event) => injectCc(1, Number(event.target.value), 0)}
          aria-label={t('midi.testCc', { n: 1 })}
        />
        <span>CC#7</span>
        <input
          type="range"
          min={0}
          max={127}
          step={1}
          defaultValue={64}
          onChange={(event) => injectCc(7, Number(event.target.value), 0)}
          aria-label={t('midi.testCc', { n: 7 })}
        />
      </div>

      {mappings.length > 0 ? (
        <div className="midi-list">
          {mappings.map((mapping) => (
            <div key={mapping.id} className="midi-row">
              <span className="midi-cc">CC#{mapping.cc}</span>
              <span className="midi-target">
                {mapping.target} · {mapping.channelId}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={t('midi.remove')}
                onClick={() => removeMapping(mapping.id)}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="midi-empty">{t('midi.empty')}</p>
      )}
    </section>
  )
}
