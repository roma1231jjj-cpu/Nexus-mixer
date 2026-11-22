import { Info } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

interface HelpTipProps {
  text: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

export function HelpTip({ text, side = 'bottom' }: HelpTipProps) {
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!show) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [show])

  return (
    <div ref={ref} style={{ display: 'inline-flex', position: 'relative' }}>
      <button
        type="button"
        className="help-tip-btn"
        onClick={() => setShow(!show)}
        aria-label="Справка"
        title="Что это?"
      >
        <Info size={12} />
      </button>
      {show && (
        <div
          className="help-tip-popup"
          style={{
            position: 'absolute',
            [side === 'bottom' ? 'top' : side === 'top' ? 'bottom' : side]: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: side === 'bottom' ? 4 : 0,
            marginBottom: side === 'top' ? 4 : 0,
            zIndex: 200,
            background: 'var(--panel-solid)',
            border: '1px solid var(--stroke-strong)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 11,
            color: 'var(--text-dim)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            whiteSpace: 'nowrap',
            maxWidth: 280,
            lineHeight: 1.5,
            fontWeight: 500,
            pointerEvents: 'auto',
          }}
          onClick={() => setShow(false)}
        >
          {text}
        </div>
      )}
    </div>
  )
}