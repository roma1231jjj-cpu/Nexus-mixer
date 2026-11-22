import type { EqBand } from '../../types'
import { eqPath } from '../../lib/eqCurve'

export function EqMini({
  bands,
  color,
  sampleRate,
  id,
  hint,
}: {
  bands: EqBand[]
  color: string
  sampleRate: number
  id: string
  hint?: string
}) {
  const line = eqPath(bands, 100, 34, sampleRate)
  const area = `${line} L100,17 L0,17 Z`
  const gradientId = `eq-grad-${id}`

  return (
    <div className="eq-mini" aria-hidden="true" data-tip={hint}>
      <div className="zero" />
      <svg viewBox="0 0 100 34" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="50%" stopColor={color} stopOpacity="0.06" />
            <stop offset="100%" stopColor={color} stopOpacity="0.28" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
