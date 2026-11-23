import {
  useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { t } from '../../i18n'

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  className?: string
  style?: React.CSSProperties
  small?: boolean
  placeholder?: string
  hint?: string
}

export function Select({ options, value, onChange, className = '', style, small, placeholder, hint }: SelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selected = options.find((option) => option.value === value)

  return (
    <div ref={ref} className={`custom-select${small ? ' small' : ''} ${className}`} style={style}>
      <button
        type="button"
        className="custom-select-trigger"
        data-tip={hint}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="custom-select-value">{selected ? selected.label : (placeholder ?? t('common.choose'))}</span>
        <ChevronDown size={small ? 10 : 12} className="custom-select-chevron" />
      </button>

      {open ? (
        <div className="custom-select-dropdown" role="listbox">
          {options.map((option) => {
            const disabled = option.disabled ?? false
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`custom-select-option${option.value === value ? ' on' : ''}${disabled ? ' disabled' : ''}`}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
