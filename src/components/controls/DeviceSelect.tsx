import { ChevronDown, Cable, Mic, Volume2 } from 'lucide-react'
import type { AudioDevice } from '../../types'

type DeviceKind = AudioDevice['kind']

interface DeviceSelectProps {
  value: string
  devices: AudioDevice[]
  kinds: DeviceKind[]
  onChange: (id: string) => void
  ariaLabel: string
  emptyLabel: string
  tone?: 'input' | 'output' | 'cable'
}

/**
 * Native endpoint picker.
 *
 * A native <select> is deliberate here: the cards clip their content, and an
 * absolutely-positioned custom menu would be cut off inside the console. The
 * native popup also keeps long WASAPI names readable.
 */
export function DeviceSelect({
  value,
  devices,
  kinds,
  onChange,
  ariaLabel,
  emptyLabel,
  tone = 'input',
}: DeviceSelectProps) {
  const options = devices.filter(
    (device) =>
      kinds.includes(device.kind) &&
      // The 16-channel VB-CABLE render endpoint conflicts with the normal
      // stereo cable; keep it out of the menu unless it is already assigned.
      !(device.kind === 'virtual-playback' && /16\s*ch/i.test(device.name)),
  )
  const known = options.some((device) => device.id === value)
  const current = devices.find((device) => device.id === value)
  const Icon = tone === 'cable' ? Cable : tone === 'output' ? Volume2 : Mic

  return (
    <label
      className={`device-select device-select-${tone}`}
      data-tip={ariaLabel}
      onClick={(event) => event.stopPropagation()}
    >
      <Icon size={12} strokeWidth={1.8} aria-hidden="true" />
      <select
        value={value}
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {!known && current ? <option value={value}>{current.name}</option> : null}
        {!known && !current && value ? <option value={value}>{value}</option> : null}
        {options.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name}
          </option>
        ))}
      </select>
      <ChevronDown size={11} strokeWidth={1.8} aria-hidden="true" />
    </label>
  )
}
