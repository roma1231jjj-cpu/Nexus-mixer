import { useEffect, useRef, type CSSProperties, type PointerEvent } from 'react'
import { X } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { BUS_ORDER, STRIP_ORDER } from '../data/defaults'
import { FADER_MAX, FADER_MIN, clamp, dbLabel } from '../lib/format'
import type { BusId, StripId } from '../types'
import { translate, useLang, useT } from '../i18n'

function MatrixCell({ stripId, bus }: { stripId: StripId; bus: BusId }) {
  const route = useMixer((s) => s.strips[stripId].routing[bus])
  const color = useMixer((s) => s.strips[stripId].color)
  const setRoute = useMixer((s) => s.setRoute)
  const toggleRoute = useMixer((s) => s.toggleRoute)
  const lang = useLang((s) => s.lang)
  const drag = useRef<{ y: number; level: number; moved: boolean } | null>(null)

  const sendPercent = route.on
    ? ((clamp(route.levelDb, FADER_MIN, FADER_MAX) - FADER_MIN) / (FADER_MAX - FADER_MIN)) * 100
    : 0

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, level: route.levelDb, moved: false }
  }

  return (
    <button
      type="button"
      className={`matrix-cell${route.on ? ' on' : ''}${bus === 'B1' ? ' group-start' : ''}`}
      style={{ '--row-color': color, '--send': `${sendPercent}%` } as CSSProperties}
      aria-pressed={route.on}
      aria-label={`${stripId} → ${bus}`}
      data-tip={translate(lang, 'matrix.cellTip', { bus, state: translate(lang, route.on ? 'matrix.on' : 'matrix.off'), level: route.levelDb.toFixed(1) })}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (!drag.current) return
        const dy = drag.current.y - event.clientY
        if (Math.abs(dy) > 3) drag.current.moved = true
        if (!drag.current.moved) return
        const level = clamp(Math.round((drag.current.level + dy * 0.5) * 10) / 10, FADER_MIN, FADER_MAX)
        setRoute(stripId, bus, { levelDb: level, on: true })
      }}
      onPointerUp={() => {
        if (drag.current && !drag.current.moved) toggleRoute(stripId, bus)
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggleRoute(stripId, bus)
        }
      }}
    >
      <span>{route.on ? dbLabel(route.levelDb) : ''}</span>
    </button>
  )
}

export function RoutingMatrix() {
  const t = useT()
  const strips = useMixer((s) => s.strips)
  const buses = useMixer((s) => s.buses)
  const sourceCount = useMixer((s) => s.sourceCount)
  const setMatrixOpen = useMixer((s) => s.setMatrixOpen)
  const selectStrip = useMixer((s) => s.selectStrip)
  const matrixRef = useRef<HTMLElement>(null)
  const visibleStrips = STRIP_ORDER.slice(0, sourceCount)

  useEffect(() => {
    matrixRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  return (
    <div className="matrix-overlay" onMouseDown={() => setMatrixOpen(false)}>
      <section
        className="matrix"
        ref={matrixRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('matrix.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
      <div className="matrix-head">
        <span className="section-label" style={{ flex: '0 0 auto' }}>
          {t('matrix.title')}
        </span>
        <span className="hint">{t('matrix.hint')}</span>
        <button type="button" className="icon-btn matrix-close" onClick={() => setMatrixOpen(false)} aria-label={t('matrix.close')}>
          <X size={18} />
        </button>
      </div>
      <div className="matrix-grid">
        <span />
        {BUS_ORDER.map((bus) => {
          const busName = buses[bus]?.name ?? bus
          return (
            <span key={bus} className={`matrix-col-label${bus === 'B1' ? ' group-start' : ''}`} data-tip={`${bus}: ${busName}`}>
              {bus}<sup>{busName}</sup>
            </span>
          )
        })}
        {visibleStrips.map((id) => {
          const strip = strips[id]
          return (
            <div key={id} style={{ display: 'contents' }}>
              <button
                type="button"
                className="matrix-row-label"
                style={{ '--row-color': strip.color, background: 'none', padding: 0, textAlign: 'left' } as CSSProperties}
                onClick={() => selectStrip(id)}
                data-tip={t('matrix.selectChannel', { name: strip.name })}
              >
                <i />
                {strip.name}
              </button>
              {BUS_ORDER.map((bus) => (
                <MatrixCell key={bus} stripId={id} bus={bus} />
              ))}
            </div>
          )
        })}
      </div>
      </section>
    </div>
  )
}
