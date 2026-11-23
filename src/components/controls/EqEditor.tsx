import {
  useRef, type PointerEvent } from 'react'
import type { EqBand } from '../../types'
import { t } from '../../i18n'
import { EQ_DB_RANGE, bandNode, eqPath } from '../../lib/eqCurve'
import { clamp, formatHz, freqToX, xToFreq } from '../../lib/format'
import { useSize } from '../../lib/useSize'

interface EqEditorProps {
  bands: EqBand[]
  sampleRate: number
  color: string
  onBandChange: (bandId: string, patch: Partial<EqBand>) => void
}

export function EqEditor({ bands, sampleRate, color, onBandChange }: EqEditorProps) {
  const [ref, size] = useSize<HTMLDivElement>()
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const path = eqPath(bands, width, height, sampleRate)
  const dragRef = useRef<string | null>(null)

  const move = (event: PointerEvent<SVGCircleElement>, band: EqBand) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = clamp(event.clientX - rect.left, 0, rect.width)
    const y = clamp(event.clientY - rect.top, 0, rect.height)
    const freq = xToFreq(x, rect.width)
    if (band.type === 'highpass' || band.type === 'lowpass') {
      const q = 0.3 + (1 - y / rect.height) * 9.7
      onBandChange(band.id, { freq, q: Math.round(q * 100) / 100 })
    } else {
      const gain = EQ_DB_RANGE - (y / rect.height) * 2 * EQ_DB_RANGE
      onBandChange(band.id, { freq, gain: Math.round(gain * 10) / 10 })
    }
  }

  return (
    <div
      className="eq-editor"
      ref={ref}
      title={t('eq.pointTip')}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id="eq-editor-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="50%" stopColor={color} stopOpacity="0.03" />
            <stop offset="100%" stopColor={color} stopOpacity="0.2" />
          </linearGradient>
        </defs>

        {[100, 1000, 10000].map((freq) => (
          <g key={freq}>
            <line
              x1={freqToX(freq, width)}
              y1={0}
              x2={freqToX(freq, width)}
              y2={height}
              stroke="var(--stroke-soft)"
              strokeDasharray="2 4"
            />
            <text x={freqToX(freq, width) + 3} y={height - 4} fontSize={7.5} fill="var(--faint)" fontFamily="var(--font-mono)">
              {formatHz(freq)}
            </text>
          </g>
        ))}

        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="var(--stroke)" strokeDasharray="3 4" />

        <path d={`${path} L${width},${height / 2} L0,${height / 2} Z`} fill="url(#eq-editor-fill)" />
        <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />

        {bands.map((band) => {
          const node = bandNode(band, width, height)
          const label = band.type === 'highpass' || band.type === 'lowpass' ? `${formatHz(band.freq)} · Q${band.q.toFixed(1)}` : `${formatHz(band.freq)} · ${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB`
          return (
            <circle
              key={band.id}
              cx={node.x}
              cy={node.y}
              r={band.enabled ? 5 : 3.5}
              fill={band.enabled ? color : 'var(--panel-solid)'}
              stroke={color}
              strokeWidth={1.3}
              opacity={band.enabled ? 1 : 0.45}
              style={{ cursor: 'grab' }}
              onPointerDown={(event) => {
                event.stopPropagation()
                event.currentTarget.setPointerCapture(event.pointerId)
                dragRef.current = band.id
                move(event, band)
              }}
              onPointerMove={(event) => {
                if (dragRef.current !== band.id) return
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                move(event, band)
              }}
              onPointerUp={() => {
                dragRef.current = null
              }}
              onDoubleClick={(event) => {
                event.stopPropagation()
                onBandChange(band.id, { gain: 0 })
              }}
            >
              <title>{`${band.type.toUpperCase()} · ${label}`}</title>
            </circle>
          )
        })}
      </svg>
    </div>
  )
}
