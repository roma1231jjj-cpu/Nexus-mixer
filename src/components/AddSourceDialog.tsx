import { useEffect, useMemo, useRef, useState } from 'react'
import { Mic, Plus, X } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { STRIP_ORDER } from '../data/defaults'
import { DeviceSelect } from './controls/DeviceSelect'

export function AddSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const devices = useMixer((s) => s.devices)
  const strips = useMixer((s) => s.strips)
  const sourceCount = useMixer((s) => s.sourceCount)
  const addSource = useMixer((s) => s.addSource)
  const notify = useUi((s) => s.notify)
  const [deviceId, setDeviceId] = useState('')
  const [name, setName] = useState('')
  const wasOpen = useRef(false)

  const full = sourceCount >= STRIP_ORDER.length
  const nextNumber = sourceCount + 1
  const availableDevices = useMemo(() => {
    const used = new Set(
      STRIP_ORDER.slice(0, sourceCount).map((id) => strips[id].deviceId).filter(Boolean),
    )
    return devices.filter(
      (device) =>
        (device.kind === 'input' || device.kind === 'virtual-capture') && !used.has(device.id),
    )
  }, [devices, strips, sourceCount])

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setDeviceId(availableDevices[0]?.id ?? '')
    setName(`Вход ${nextNumber}`)
  }, [open, availableDevices, nextNumber])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog add-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Добавить источник"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <span className="dialog-icon"><Plus size={17} /></span>
          <div>
            <h2>Добавить источник</h2>
            <p>Свободный вход появится на консоли и в матрице маршрутизации.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body">
          <div className="dialog-field">
            <label htmlFor="add-source-name">Название</label>
            <div className="dialog-text-input">
              <Mic size={15} />
              <input
                id="add-source-name"
                value={name}
                maxLength={24}
                placeholder="Например: Телефон"
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="dialog-field">
            <label>Устройство ввода</label>
            <DeviceSelect
              value={deviceId}
              devices={availableDevices}
              kinds={['input', 'virtual-capture']}
              onChange={setDeviceId}
              ariaLabel="Устройство нового источника"
              emptyLabel="Без устройства — назначить позже"
              tone="input"
            />
          </div>

          <p className="dialog-note">
            {full
              ? 'Все 8 слотов заняты.'
              : `Будет добавлен слот ${nextNumber} из ${STRIP_ORDER.length}.`}
          </p>
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button
            type="button"
            className="btn primary"
            disabled={full}
            onClick={() => {
              const id = addSource(deviceId, name)
              if (id) {
                notify(`Источник «${name.trim() || `Вход ${nextNumber}`}» добавлен`)
                onClose()
              }
            }}
          >
            <Plus size={14} /> Добавить источник
          </button>
        </footer>
      </section>
    </div>
  )
}
