import {
  useRef, type CSSProperties, type PointerEvent } from 'react'
import { FADER_MAX, FADER_MIN, clamp } from '../../lib/format'
import { t } from '../../i18n'

interface HFaderProps {
  value: number
  onChange: (value: number) => void
  color?: string
  min?: number
  max?: number
  ariaLabel?: string
  hint?: string
}

export function HFader({ value, onChange, color, min = FADER_MIN, max = FADER_MAX, ariaLabel = t('tip.level'), hint }: HFaderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const position = ((clamp(value, min, max) - min) / (max - min)) * 100
  const commit = (next: number) => onChange(clamp(Math.round(next * 10) / 10, min, max))

  const update = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const percent = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
    commit(min + (percent / 100) * (max - min))
  }

  return (
    <div
      ref={ref}
      className="hfader"
      style={{ '--bus-color': color ?? 'var(--accent)' } as CSSProperties}
      data-tip={hint ?? t('tip.dragReset', { label: ariaLabel })}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      onPointerDown={(event) => {
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        update(event)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        update(event)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        commit(0)
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 2 : 0.5
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          commit(value + step)
          event.preventDefault()
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          commit(value - step)
          event.preventDefault()
        }
      }}
    >
      <div className="hfader-track" aria-hidden="true">
        <div className="hfader-fill" style={{ width: `${position}%` }} />
      </div>
      <div className="hfader-thumb" style={{ left: `${position}%` }} aria-hidden="true" />
    </div>
  )
}
