interface SwitchProps {
  on: boolean
  onChange: (on: boolean) => void
  ariaLabel: string
  disabled?: boolean
}

export function Switch({ on, onChange, ariaLabel, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`switch${on ? ' on' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        onChange(!on)
      }}
    />
  )
}
