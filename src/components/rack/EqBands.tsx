import type { EqBand, EqBandType } from '../../types'
import { clamp, formatHz } from '../../lib/format'
import { Select } from '../controls/Select'

const TYPES: { value: EqBandType; label: string }[] = [
  { value: 'peaking', label: 'PEAK' },
  { value: 'lowshelf', label: 'LSH' },
  { value: 'highshelf', label: 'HSH' },
  { value: 'highpass', label: 'HPF' },
  { value: 'lowpass', label: 'LPF' },
]

export function EqBands({
  bands,
  color,
  onChange,
}: {
  bands: EqBand[]
  color: string
  onChange: (bandId: string, patch: Partial<EqBand>) => void
}) {
  return (
    <div className="band-list">
      <div className="band-head">
        <span />
        <span>type</span>
        <span>freq</span>
        <span>gain</span>
        <span>q</span>
      </div>
      {bands.map((band, index) => {
        const isFilter = band.type === 'highpass' || band.type === 'lowpass'
        return (
          <div className="band-row" key={band.id}>
            <button
              type="button"
              className={`band-enable${band.enabled ? ' on' : ''}`}
              aria-label={`Полоса ${index + 1}`}
              aria-pressed={band.enabled}
              onClick={() => onChange(band.id, { enabled: !band.enabled })}
              title={`${formatHz(band.freq)} Hz · ${band.gain.toFixed(1)} dB · Q ${band.q.toFixed(1)}`}
            />
            <Select
              value={band.type}
              options={TYPES}
              onChange={(val) => onChange(band.id, { type: val as EqBandType })}
              small
            />
            <label className="band-field" style={{ borderColor: band.enabled ? color : undefined }}>
              <input
                type="number"
                min={20}
                max={20000}
                step={10}
                value={Math.round(band.freq)}
                aria-label={`Частота полосы ${index + 1}`}
                onChange={(event) => {
                  const value = Number.parseFloat(event.target.value)
                  if (Number.isFinite(value)) onChange(band.id, { freq: clamp(value, 20, 20000) })
                }}
              />
              <span>Hz</span>
            </label>
            <label className="band-field">
              <input
                type="number"
                min={-24}
                max={24}
                step={0.5}
                value={Number(band.gain.toFixed(1))}
                disabled={isFilter}
                aria-label={`Усиление полосы ${index + 1}`}
                onChange={(event) => {
                  const value = Number.parseFloat(event.target.value)
                  if (Number.isFinite(value)) onChange(band.id, { gain: clamp(value, -24, 24) })
                }}
                style={isFilter ? { opacity: 0.35 } : undefined}
              />
              <span>dB</span>
            </label>
            <label className="band-field">
              <input
                type="number"
                min={0.1}
                max={18}
                step={0.1}
                value={Number(band.q.toFixed(1))}
                aria-label={`Добротность полосы ${index + 1}`}
                onChange={(event) => {
                  const value = Number.parseFloat(event.target.value)
                  if (Number.isFinite(value)) onChange(band.id, { q: clamp(value, 0.1, 18) })
                }}
              />
              <span>Q</span>
            </label>
          </div>
        )
      })}
    </div>
  )
}
