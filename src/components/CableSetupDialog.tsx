import { useState } from 'react'
import { Cable, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { BUS_ORDER } from '../data/defaults'
import { engineBridge } from '../lib/engineBridge'
import { DeviceSelect } from './controls/DeviceSelect'
import { useT } from '../i18n'
import { RichText } from './RichText'

const B_BUSES = BUS_ORDER.filter((id) => id.startsWith('B'))

export function CableSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
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
      notify(t('cable.renameDesktopOnly'))
      return
    }
    setBusy(true)
    const result = await engineBridge.renameVirtualCables()
    setBusy(false)
    if (result) {
      notify(result)
      window.setTimeout(() => window.location.reload(), 1400)
    } else {
      notify(t('cable.renameCancelled'))
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog cable-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('cable.aria')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <span className="dialog-icon"><Cable size={18} /></span>
          <div>
            <h2>{t('cable.title')}</h2>
            <p>{t('cable.sub')}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body cable-dialog-body">
          <div className={`cable-status${connected >= 12 ? ' ready' : ''}`}>
            <div>
              <b>{t('cable.connected', { n: connected })}</b>
              <span>{t('cable.connectedLabel')}</span>
            </div>
            <div className="cable-status-meta">
              <span>{t('cable.endpoints', { n: virtual.length })}</span>
              <span>{driver.installed ? t('cable.driverFound') : t('cable.driverMissing')}</span>
            </div>
          </div>

          <p className="dialog-note">
            <RichText text={t('cable.note')} />
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
                    ariaLabel={t('cable.mapAria', { name: bus.name })}
                    emptyLabel={t('cable.notConnected')}
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
            title={t('cable.refreshTip')}
          >
            <RefreshCw size={14} /> {t('cable.refresh')}
          </button>
          <button type="button" className="btn primary" onClick={rename} disabled={busy}>
            <ShieldCheck size={14} /> {busy ? t('cable.renameBusy') : t('cable.rename')}
          </button>
        </footer>
      </section>
    </div>
  )
}
