import { useRef } from 'react'
import { useMixer, isStripAudible, stripVcaState } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { BUS_ORDER, STRIP_ORDER } from '../data/defaults'
import { useMeter } from '../audio/useMeter'
import { dbLabel } from '../lib/format'
import type { BusId, StripId } from '../types'
import { BusMeter } from './controls/StereoMeter'
import { HFader } from './controls/HFader'
import { DeviceSelect } from './controls/DeviceSelect'

/** Which strips are currently audible on this bus. */
function activeSources(busId: BusId, strips: Record<StripId, any>, soloActive: boolean, vcaGroups: any[], ids: StripId[]) {
  return ids
    .filter((sid) => {
      const vca = stripVcaState(sid, vcaGroups)
      return strips[sid].routing[busId].on && isStripAudible(strips[sid], soloActive, vca.mute)
    })
    .map((sid) => strips[sid].name)
}

/** Physical outputs keep the device name: it is the actual hardware label. */
const isLockedName = (id: BusId) => id.startsWith('A')

export function Bus({ id, variant = 'cable' }: { id: BusId; variant?: 'main' | 'cable' }) {
  const bus = useMixer((s) => s.buses[id])
  const selected = useMixer((s) => s.selectionKind === 'bus' && s.selectedBusId === id)
  const setBus = useMixer((s) => s.setBus)
  const selectBus = useMixer((s) => s.selectBus)
  const openRack = useUi((s) => s.openRack)
  const soloActive = useMixer((s) => s.soloActive)
  const vcaGroups = useMixer((s) => s.vcaGroups)
  const strips = useMixer((s) => s.strips)
  const devices = useMixer((s) => s.devices)
  const sourceCount = useMixer((s) => s.sourceCount)

  const visibleStrips = STRIP_ORDER.slice(0, sourceCount)
  const sources = activeSources(id, strips, soloActive, vcaGroups, visibleStrips)
  const busIndex = BUS_ORDER.indexOf(id)
  const meter = useMeter(Boolean(bus.deviceId) && !bus.mute && sources.length > 0, busIndex + 20, 'horizontal', {
    kind: 'bus',
    index: busIndex,
  })
  const device = devices.find((item) => item.id === bus.deviceId)
  const locked = isLockedName(id)
  const nameBeforeEdit = useRef(bus.name)
  const cancelNameEdit = useRef(false)

  const select = () => selectBus(id)
  const openFx = () => {
    selectBus(id)
    openRack('fx')
  }

  return (
    <article
      className={`bus bus-${variant}${selected ? ' selected' : ''}${bus.deviceId ? '' : ' unassigned'}`}
      style={{ '--bus-color': bus.color } as React.CSSProperties}
      onClick={(event) => {
        const control = event.target instanceof Element && event.target.closest('button, input, select, .device-select')
        // A single click only selects the output. Opening the rack from the
        // whole card caused accidental "headphone settings" popups when the
        // user aimed for a mute/fader control; the FX button is deliberate.
        if (!control) select()
      }}
      aria-label={`Шина ${bus.name}`}
    >
      <header className="bus-head">
        <span className="bus-badge" aria-hidden="true">{bus.id}</span>
        <span className={`bus-led${bus.deviceId ? ' on' : ''}`} aria-hidden="true" />
        {locked ? (
          <span
            className="bus-name-static"
            data-tip={`${bus.name} · имя физического устройства закреплено`}
          >
            {bus.name}
          </span>
        ) : (
          <input
            className="bus-name-input"
            value={bus.name}
            spellCheck={false}
            maxLength={28}
            aria-label={`Название шины ${bus.id}`}
            onClick={(event) => event.stopPropagation()}
            onFocus={() => {
              nameBeforeEdit.current = bus.name
              select()
            }}
            onChange={(event) => setBus(id, { name: event.target.value })}
            onBlur={(event) => {
              if (cancelNameEdit.current) {
                cancelNameEdit.current = false
                return
              }
              const next = event.target.value.trim()
              setBus(id, { name: next || `Кабель ${id.slice(1)}` })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelNameEdit.current = true
                setBus(id, { name: nameBeforeEdit.current })
                event.currentTarget.blur()
              }
            }}
          />
        )}
        <span className="bus-db">{dbLabel(bus.gainDb)}</span>
      </header>

      <div className="bus-device-row">
        <DeviceSelect
          value={bus.deviceId}
          devices={devices}
          kinds={variant === 'main' ? ['output'] : ['virtual-playback']}
          onChange={(deviceId) => setBus(id, { deviceId })}
          ariaLabel={`Устройство выхода ${bus.name}`}
          emptyLabel={variant === 'main' ? 'Выход не назначен' : 'Кабель не установлен'}
          tone={variant === 'main' ? 'output' : 'cable'}
        />
      </div>

      <div className="bus-fader-row">
        <HFader
          value={bus.gainDb}
          onChange={(value) => setBus(id, { gainDb: value })}
          color={bus.color}
          ariaLabel={`Громкость ${bus.name}`}
          hint={`${bus.id} · ${bus.name}${device ? ` · ${device.name}` : ' · устройство не назначено'}`}
        />
        <BusMeter left={meter.left} right={meter.right} />
      </div>

      <footer className="bus-foot">
        <div
          className="bus-sources"
          data-tip={sources.length > 0 ? `Сюда идёт: ${sources.join(', ')}` : 'Никто не направлен в этот выход'}
        >
          {visibleStrips.map((sid) => (
            <span
              key={sid}
              className={`bus-src-dot${strips[sid].routing[id].on ? ' on' : ''}`}
              style={{ '--dot-color': strips[sid].color } as React.CSSProperties}
              aria-hidden="true"
            />
          ))}
          <span className="bus-device">
            {device ? device.name.replace(/\s*\(.*\)$/, '') : 'no device'}
          </span>
        </div>

        <div className="bus-actions">
          <button
            type="button"
            className={`mini-toggle mute${bus.mute ? ' on' : ''}`}
            aria-pressed={bus.mute}
            data-tip="Заглушить этот выход"
            onClick={(event) => {
              event.stopPropagation()
              setBus(id, { mute: !bus.mute })
            }}
          >
            M
          </button>
          {variant === 'main' ? (
            <>
              <button
                type="button"
                className={`mini-toggle${bus.mono ? ' on' : ''}`}
                aria-pressed={bus.mono}
                data-tip="Моно — объединить каналы"
                onClick={(event) => {
                  event.stopPropagation()
                  setBus(id, { mono: !bus.mono })
                }}
              >
                MONO
              </button>
              <button
                type="button"
                className={`mini-toggle${bus.dim ? ' on' : ''}`}
                aria-pressed={bus.dim}
                data-tip="Dim −20 dB"
                onClick={(event) => {
                  event.stopPropagation()
                  setBus(id, { dim: !bus.dim })
                }}
              >
                DIM
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="mini-toggle"
            data-tip="Настроить звук этого выхода"
            onClick={(event) => {
              event.stopPropagation()
              openFx()
            }}
          >
            FX
          </button>
        </div>
      </footer>
    </article>
  )
}
