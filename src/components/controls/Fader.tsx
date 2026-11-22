import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { FADER_MAX, FADER_MIN, clamp } from '../../lib/format'

interface FaderProps {
  value: number
  onChange: (value: number) => void
  color?: string
  min?: number
  max?: number
  ticks?: number[]
  ariaLabel?: string
  hint?: string
}

const DEFAULT_TICKS = [12, 6, 0, -6, -18, -30, -42, -60]

export function Fader({
  value,
  onChange,
  color,
  min = FADER_MIN,
  max = FADER_MAX,
  ticks = DEFAULT_TICKS,
  ariaLabel = 'Уровень',
  hint,
}: FaderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const position = ((clamp(value, min, max) - min) / (max - min)) * 100
  const commit = (next: number) => onChange(clamp(Math.round(next * 10) / 10, min, max))
  const tickPosition = (tick: number) => ((clamp(tick, min, max) - min) / (max - min)) * 100

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const percent = clamp((1 - (event.clientY - rect.top) / rect.height) * 100, 0, 100)
    commit(min + (percent / 100) * (max - min))
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    updateFromPointer(event)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 2 : 0.5
    if (event.key === 'ArrowUp') {
      commit(value + step)
      event.preventDefault()
    } else if (event.key === 'ArrowDown') {
      commit(value - step)
      event.preventDefault()
    } else if (event.key === 'PageUp') {
      commit(value + 6)
      event.preventDefault()
    } else if (event.key === 'PageDown') {
      commit(value - 6)
      event.preventDefault()
    } else if (event.key === 'Home') {
      commit(min)
      event.preventDefault()
    } else if (event.key === 'End') {
      commit(max)
      event.preventDefault()
    }
  }

  return (
    <div
      ref={ref}
      className="fader"
      style={{ '--strip-color': color ?? 'var(--accent)' } as CSSProperties}
      data-tip={hint ?? `${ariaLabel} — тяните, двойной клик сбрасывает на 0 dB`}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={(event) => {
        event.stopPropagation()
        commit(0)
      }}
      onKeyDown={onKeyDown}
    >
      <div className="fader-ticks" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ top: `${100 - tickPosition(tick)}%` }}>
            {tick > 0 ? `+${tick}` : tick}
          </span>
        ))}
      </div>
      <div className="fader-track" aria-hidden="true">
        <div className="fader-fill" style={{ height: `${position}%` }} />
      </div>
      <div className="fader-thumb" style={{ top: `${100 - position}%` }} aria-hidden="true" />
    </div>
  )
}
