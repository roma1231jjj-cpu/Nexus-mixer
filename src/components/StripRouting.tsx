import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useMixer } from '../store/useMixer'
import { BUS_ORDER } from '../data/defaults'
import type { BusId, StripId } from '../types'

const A_BUSES: BusId[] = BUS_ORDER.filter((bus) => bus.startsWith('A'))
const B_BUSES: BusId[] = BUS_ORDER.filter((bus) => bus.startsWith('B'))

export function StripRouting({ id }: { id: StripId }) {
  const routing = useMixer((s) => s.strips[id].routing)
  const color = useMixer((s) => s.strips[id].color)
  const buses = useMixer((s) => s.buses)
  const toggleRoute = useMixer((s) => s.toggleRoute)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const activeB = B_BUSES.filter((bus) => routing[bus].on)

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const width = 308
    const up = rect.bottom + 240 > window.innerHeight
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: up ? rect.top - 6 : rect.bottom + 6,
      up,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const tint = { '--strip-color': color } as CSSProperties

  return (
    <div className="strip-routing" style={tint}>
      {A_BUSES.map((bus) => (
        <button
          key={bus}
          type="button"
          className={`route-chip${routing[bus].on ? ' on' : ''}`}
          aria-pressed={routing[bus].on}
          data-tip={`${bus} · ${buses[bus].name}`}
          onClick={(event) => {
            event.stopPropagation()
            toggleRoute(id, bus)
          }}
        >
          <span className="route-chip-id">{bus}</span>
          <span className="route-chip-name">{buses[bus].name}</span>
        </button>
      ))}

      <button
        ref={buttonRef}
        type="button"
        className={`route-chip route-chip-b${activeB.length > 0 ? ' on' : ''}${open ? ' open' : ''}`}
        aria-pressed={activeB.length > 0}
        aria-expanded={open}
        data-tip={`Кабельные выходы B1–B12 · включено ${activeB.length}`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <span className="route-chip-id">B</span>
        <span className="route-chip-name">
          {activeB.length > 0 ? `${activeB.length} из ${B_BUSES.length}` : 'кабели'}
        </span>
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              className="route-pop"
              style={{
                ...tint,
                left: pos.left,
                top: pos.top,
                transform: pos.up ? 'translateY(-100%)' : undefined,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="route-pop-head">
                <span>Кабельные выходы</span>
                <span className="route-pop-sub">
                  {activeB.length} из {B_BUSES.length}
                </span>
              </div>
              <div className="route-pop-grid">
                {B_BUSES.map((bus) => {
                  const route = routing[bus]
                  const dead = !buses[bus].deviceId
                  return (
                    <button
                      key={bus}
                      type="button"
                      className={`route-cell${route.on ? ' on' : ''}${dead ? ' dead' : ''}`}
                      aria-pressed={route.on}
                      data-tip={dead ? `${bus} · ${buses[bus].name} — кабель не назначен` : `${bus} · ${buses[bus].name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleRoute(id, bus)
                      }}
                    >
                      <span className="route-cell-id">{bus}</span>
                      <span className="route-cell-name">{buses[bus].name}</span>
                    </button>
                  )
                })}
              </div>
              <div className="route-pop-foot">Клик — включить или выключить. Уровень посыла — в матрице.</div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
