import { useState } from 'react'
import { Cable, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { BUS_ORDER } from '../data/defaults'
import { engineBridge } from '../lib/engineBridge'
import { DeviceSelect } from './controls/DeviceSelect'

const B_BUSES = BUS_ORDER.filter((id) => id.startsWith('B'))

export function CableSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const buses = useMixer((s) => s.buses)
  const devices = useMixer((s) => s.devices)
  const driver = useMixer((s) => s.status.driver)
  const setBus = useMixer((s) => s.setBus)
  const notify = useUi((s) => s.notify)
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const virtual = devices.filter(
    (device) => device.kind === 'virtual-playback' && !/16\s*ch/i.test(device.name),
  )
  const connected = B_BUSES.filter((id) => buses[id].deviceId).length

  const rename = async () => {
    if (!engineBridge.available) {
      notify('Переименование доступно только в desktop-сборке')
      return
    }
    setBusy(true)
    const result = await engineBridge.renameVirtualCables()
    setBusy(false)
    if (result) {
      notify(result)
      window.setTimeout(() => window.location.reload(), 1400)
    } else {
      notify('Переименование отменено — нужны права администратора')
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog cable-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Виртуальные кабели"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <span className="dialog-icon"><Cable size={18} /></span>
          <div>
            <h2>Виртуальные кабели</h2>
            <p>Каждый кабель — отдельный выход, который Discord, OBS или игра видят как микрофон.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body cable-dialog-body">
          <div className={`cable-status${connected >= 12 ? ' ready' : ''}`}>
            <div>
              <b>{connected} из 12</b>
              <span>кабелей подключено</span>
            </div>
            <div className="cable-status-meta">
              <span>Windows: {virtual.length} endpoint{virtual.length === 1 ? '' : 's'}</span>
              <span>{driver.installed ? 'Виртуальный кабель найден' : 'Виртуальный кабель не найден'}</span>
            </div>
          </div>

          <p className="dialog-note">
            Для 12 независимых кабелей используется <b>Virtual Audio Cable 4.71</b> (12 линий)
            или VB-CABLE A+B. Nexus переименовывает найденные линии в <b>Nexus Cable B1…B12</b> —
            после этого их можно выбрать в Discord, OBS и играх.
          </p>

          <div className="cable-map">
            {B_BUSES.map((id) => {
              const bus = buses[id]
              return (
                <div className="cable-map-row" key={id}>
                  <span className="cable-map-id">{id}</span>
                  <span className="cable-map-name">{bus.name}</span>
                  <DeviceSelect
                    value={bus.deviceId}
                    devices={devices}
                    kinds={['virtual-playback']}
                    onChange={(deviceId) => setBus(id, { deviceId })}
                    ariaLabel={`Кабель для ${bus.name}`}
                    emptyLabel="Не подключён"
                    tone="cable"
                  />
                </div>
              )
            })}
          </div>
        </div>

        <footer className="dialog-foot cable-dialog-foot">
          <button
            type="button"
            className="btn"
            onClick={() => window.location.reload()}
            title="Перечитать список устройств Windows"
          >
            <RefreshCw size={14} /> Обновить
          </button>
          <button type="button" className="btn primary" onClick={rename} disabled={busy}>
            <ShieldCheck size={14} /> {busy ? 'Ожидание UAC…' : 'Переименовать в Windows'}
          </button>
        </footer>
      </section>
    </div>
  )
}
