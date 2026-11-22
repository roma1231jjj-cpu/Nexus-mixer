import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { clamp } from '../../lib/format'

interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  format?: (value: number) => string
  onChange: (value: number) => void
  defaultValue?: number
  color?: string
  size?: number
  disabled?: boolean
  title?: string
  hint?: string
}

const snap = (value: number, step: number): number => Math.round(value / step) * step

export function Knob({
  label,
  value,
  min,
  max,
  step = 0.1,
  unit = '',
  format,
  onChange,
  defaultValue = 0,
  color,
  size = 40,
  disabled,
  title,
  hint,
}: KnobProps) {
  const drag = useRef<{ y: number; value: number } | null>(null)
  const ratio = clamp((value - min) / (max - min), 0, 1)
  const angle = 135 + ratio * 270
  const rad = (angle * Math.PI) / 180
  const indicatorX = 24 + Math.cos(rad) * 10.5
  const indicatorY = 24 + Math.sin(rad) * 10.5
  const circumference = 2 * Math.PI * 16
  const arcLength = circumference * 0.75

  const display = format ? format(value) : `${value.toFixed(step < 1 ? 1 : 0)}${unit}`

  const commit = (next: number) => onChange(clamp(snap(next, step), min, max))

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, value }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const sensitivity = (max - min) / (event.shiftKey ? 720 : 170)
    commit(drag.current.value + (drag.current.y - event.clientY) * sensitivity)
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const big = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      commit(value + step * big)
      event.preventDefault()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      commit(value - step * big)
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
      className="knob"
      style={{ '--knob-color': color ?? 'var(--accent)' } as CSSProperties}
      data-tip={hint ?? title ?? `${label} — тяните вверх/вниз, двойной клик сбрасывает`}
    >
      <span className="knob-label">{label}</span>
      <div
        className="knob-dial"
        style={{ width: size, height: size }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={display}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          event.stopPropagation()
          commit(defaultValue)
        }}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle className="knob-track" cx="24" cy="24" r="16" transform="rotate(135 24 24)" strokeDasharray={`${arcLength} 999`} />
          <circle
            className="knob-arc"
            cx="24"
            cy="24"
            r="16"
            transform="rotate(135 24 24)"
            strokeDasharray={`${Math.max(0.001, ratio * arcLength)} 999`}
          />
          <circle className="knob-cap" cx="24" cy="24" r="12" />
          <line className="knob-indicator" x1="24" y1="24" x2={indicatorX} y2={indicatorY} />
        </svg>
      </div>
      <span className="knob-value">{display}</span>
    </div>
  )
}
