import { useEffect } from 'react'
import { publishMeterLevels } from '../audio/meterBus'
import { BUS_ORDER, STRIP_ORDER } from '../data/defaults'
import { t } from '../i18n'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import type { AudioDevice, BusId, StripId } from '../types'
import { engineBridge, snapshotOf } from './engineBridge'
import { applyAiStatus, applyEngineStatus, refreshEngineInfo, restartEngine } from './engineControl'

/**
 * Point persisted browser-mock ids (`in:mic-usb`, `out:speakers`, …) at real
 * Windows endpoints the first time the desktop app runs on a machine. Empty
 * assignments are preserved so the user can deliberately leave an input off.
 */
const CABLE_PLAN_KEY = 'nexus.cablePlan.v5'

/** `Nexus Cable B7 …` -> 7; anything else (legacy VB-CABLE, 16ch) -> null. */
function cableIndex(name: string): number | null {
  const match = name.match(/Nexus Cable B(\d+)/i)
  return match ? Number(match[1]) : null
}

/** Natural order so B2 comes before B10, unlike a plain locale comparison. */
function byCableNumber(a: AudioDevice, b: AudioDevice): number {
  const ai = cableIndex(a.name)
  const bi = cableIndex(b.name)
  if (ai !== null && bi !== null && ai !== bi) return ai - bi
  if (ai !== null && bi === null) return -1
  if (ai === null && bi !== null) return 1
  return a.name.localeCompare(b.name)
}

function normalizeDevices(devices: AudioDevice[]): void {
  if (devices.length === 0) return
  const known = new Set(devices.map((device) => device.id))
  const physicalInputs = devices.filter((d) => d.kind === 'input')
  const virtualInputs = devices.filter((d) => d.kind === 'virtual-capture').sort(byCableNumber)
  const physicalOutputs = devices.filter((d) => d.kind === 'output')
  // VB-CABLE exposes a second 16-channel "CABLE In 16ch" render endpoint that
  // cannot be opened alongside the normal stereo cable (WASAPI returns
  // AUDCLNT_E_DEVICE_IN_USE). Keep it out of automatic assignment; the user
  // can still pick it manually from a cable's device menu.
  const virtualOutputs = devices
    .filter((d) => d.kind === 'virtual-playback' && !/16\s*ch/i.test(d.name))
    .sort(byCableNumber)
  const numberedCables = new Set(
    virtualOutputs
      .map((device) => cableIndex(device.name))
      .filter((index): index is number => index !== null),
  )
  // Installs that predate VAC have bus Bn pointed at an arbitrary cable. Bind
  // Bn -> Nexus Cable Bn once, then leave manual remapping alone.
  let remapCables = false
  try {
    remapCables = !localStorage.getItem(CABLE_PLAN_KEY)
  } catch {
    remapCables = false
  }

  const state = useMixer.getState()
  const usedInputs = new Set<string>()
  const usedOutputs = new Set<string>()
  const take = (pool: AudioDevice[], used: Set<string>): string => {
    const device = pool.find((candidate) => !used.has(candidate.id))
    if (!device) return ''
    used.add(device.id)
    return device.id
  }

  let stripsChanged = false
  const strips = { ...state.strips }
  const visibleStrips = new Set<StripId>(STRIP_ORDER.slice(0, state.sourceCount))
  for (const id of STRIP_ORDER) {
    const strip = strips[id]
    if (!visibleStrips.has(id)) {
      // Slots beyond the visible source count must not hold capture streams:
      // opening an endpoint for an invisible channel steals it from the slot
      // the user adds later.
      if (strip.deviceId) {
        strips[id] = { ...strip, deviceId: '' }
        stripsChanged = true
      }
      continue
    }

    // Virtual strips read the matching numbered cable: System <- B1,
    // Game <- B2. This is a one-time migration, not a permanent override.
    const virtualSlot = remapCables ? (id === 'vaio' ? 1 : id === 'aux' ? 2 : null) : null
    if (virtualSlot !== null) {
      const expected = virtualInputs.find((device) => cableIndex(device.name) === virtualSlot)
      if (expected && !usedInputs.has(expected.id)) {
        usedInputs.add(expected.id)
        if (strip.deviceId !== expected.id) {
          strips[id] = { ...strip, deviceId: expected.id }
          stripsChanged = true
        }
        continue
      }
    }

    if (strip.deviceId && known.has(strip.deviceId) && !usedInputs.has(strip.deviceId)) {
      usedInputs.add(strip.deviceId)
      continue
    }

    // A device that is currently unplugged keeps its assignment: replacing it
    // with "some other free endpoint" silently moved a microphone to the wrong
    // channel, and the original never came back on replug. The engine reports
    // the missing endpoint as a warning instead.
    if (strip.deviceId && known.has(strip.deviceId) === false) continue

    // An empty assignment is a deliberate choice ("this channel is off").
    // Only the first-run migration fills it in; the old code repopulated every
    // empty slot on each device refresh.
    if (!strip.deviceId) {
      const pool = id === 'vaio' || id === 'aux' ? virtualInputs : physicalInputs
      const preferred = remapCables
        ? id === 'hw1'
          ? pool.find((device) => device.isDefault)
          : undefined
        : undefined
      if (preferred && !usedInputs.has(preferred.id)) {
        usedInputs.add(preferred.id)
        strips[id] = { ...strip, deviceId: preferred.id }
        stripsChanged = true
      }
      continue
    }

    // The id exists but a higher-priority slot already claimed it (duplicate
    // assignment). Leave it alone rather than stealing another endpoint.
    continue
  }

  let busesChanged = false
  const buses = { ...state.buses }
  for (const id of BUS_ORDER) {
    const bus = buses[id as BusId]

    if (id.startsWith('B')) {
      const cableNumber = Number(id.slice(1))
      // Open only the two everyday cables automatically. The remaining VAC
      // lines stay visible and mapped, but opening all twelve at launch makes
      // WASAPI spend ~20 s enumerating them; they open as soon as the user
      // assigns a device to one.
      if (cableNumber > 2 && !bus.deviceId) continue
      const expected = virtualOutputs.find((device) => cableIndex(device.name) === cableNumber)
      // Only the first-run migration may bind Bn to its numbered cable.
      // An empty slot is a deliberate "off", and a temporarily missing manual
      // assignment must return to the same device, not be replaced by the
      // "expected" cable.
      const force = remapCables

      if (expected && !usedOutputs.has(expected.id) && force) {
        usedOutputs.add(expected.id)
        if (bus.deviceId !== expected.id) {
          buses[id as BusId] = { ...bus, deviceId: expected.id }
          busesChanged = true
        }
        continue
      }

      if (bus.deviceId && known.has(bus.deviceId) && !usedOutputs.has(bus.deviceId)) {
        usedOutputs.add(bus.deviceId)
        continue
      }

      // A single-line VB-CABLE fallback is still useful when no numbered VAC
      // lines exist at all. With partial VAC enumeration, never shift the
      // remaining cables onto the wrong B numbers — leave the slot empty and
      // fill it when that line appears.
      if (!expected && numberedCables.size === 0 && !bus.deviceId) {
        const legacy = virtualOutputs.find((device) => cableIndex(device.name) === null)
        if (legacy && !usedOutputs.has(legacy.id)) {
          usedOutputs.add(legacy.id)
          buses[id as BusId] = { ...bus, deviceId: legacy.id }
          busesChanged = true
          continue
        }
      }

      // Keep the assignment of a temporarily missing cable so it reconnects
      // where it was; the engine surfaces it as "device not found".
      continue
    }

    // A2/A3 are spare physical outputs. They caused constant underruns when
    // auto-pointed at a sleeping USB/Bluetooth endpoint; open them only when
    // the user explicitly assigns a device.
    if (id === 'A2' || id === 'A3') {
      if (!bus.deviceId) continue
      if (!known.has(bus.deviceId)) continue
      usedOutputs.add(bus.deviceId)
      continue
    }

    const pool = physicalOutputs
    const forceMaster = remapCables && id === 'A1'
    if (!forceMaster && bus.deviceId && known.has(bus.deviceId) && !usedOutputs.has(bus.deviceId)) {
      usedOutputs.add(bus.deviceId)
      continue
    }

    // Prefer a 48 kHz output for A1 while migrating: a 44.1 kHz headphone
    // endpoint otherwise forces the whole engine to 44.1, and some USB mics
    // (and VAC's capture pins) only expose 48 kHz.
    // An empty master/bus assignment means the user switched that output off.
    // Only the first run picks the Windows default for it.
    if (!bus.deviceId && !remapCables) continue
    if (bus.deviceId && !known.has(bus.deviceId)) continue

    const preferred = forceMaster
      ? physicalOutputs.find((d) => d.isDefault && d.sampleRate >= 48000) ??
        physicalOutputs.find((d) => d.sampleRate >= 48000) ??
        physicalOutputs.find((d) => d.isDefault)
      : id === 'A1'
        ? pool.find((d) => d.isDefault)
        : undefined
    let deviceId = bus.deviceId
    if (!deviceId) {
      if (preferred && !usedOutputs.has(preferred.id)) {
        usedOutputs.add(preferred.id)
        deviceId = preferred.id
      } else {
        deviceId = take(pool, usedOutputs)
      }
    } else {
      usedOutputs.add(deviceId)
    }

    if (deviceId !== bus.deviceId) {
      buses[id as BusId] = { ...bus, deviceId }
      busesChanged = true
    }
  }

  if (stripsChanged) useMixer.setState({ strips })
  if (busesChanged) useMixer.setState({ buses })
  if (remapCables) {
    try {
      localStorage.setItem(CABLE_PLAN_KEY, '1')
    } catch {
      // Private mode / storage disabled: remapping is still safe each launch.
    }
  }
}

/** Device ids currently referenced by the mixer snapshot. */
function referencedDevices(): string[] {
  const state = useMixer.getState()
  return [
    ...Object.values(state.strips).map((strip) => strip.deviceId),
    ...Object.values(state.buses).map((bus) => bus.deviceId),
  ].filter((id): id is string => Boolean(id))
}

/** Stable fingerprint of the endpoint list, including default flags. */
function deviceSignature(devices: AudioDevice[]): string {
  return devices
    .map((device) => `${device.id}|${device.isDefault ? 1 : 0}|${device.online ? 1 : 0}`)
    .sort()
    .join(';')
}

/**
 * Keeps the Rust engine in sync with the Zustand store.
 *
 * - Pushes the mixer snapshot ~60 ms after the last change (coalesces fader
 *   drags into one message per frame batch).
 * - Publishes engine config changes immediately.
 * - Polls status once a second, meters at 20 Hz and runtime warnings every
 *   three seconds.
 * - Refreshes the endpoint list every four seconds. When a configured device
 *   disappears, the graph is rebuilt with fresh fallbacks (hot-plug).
 * - Watches the master callback frame counter; if it freezes while the engine
 *   is marked running, the graph is restarted (USB/Bluetooth drop recovery).
 *
 * The hook is a no-op in a plain browser, where `engineBridge.available` is
 * false.
 */
export function useEngineBridge(): void {
  useEffect(() => {
    if (!engineBridge.available) return

    let cancelled = false
    let flushTimer: number | undefined
    let deviceSignatureValue = ''
    const bridgeStartedAt = performance.now()

    // Restart throttling: never thrash the device graph if an endpoint keeps
    // disappearing and reappearing.
    let restarting = false
    let lastRestartAt = 0
    let deviceRestartTimer: number | undefined
    let missingDevices = new Set<string>()

    const pushSnapshot = () => {
      const state = useMixer.getState()
      void engineBridge.setMixerState(snapshotOf(state))
    }

    const maybeRestart = (reason: string, force = false) => {
      if (restarting || cancelled) return
      const state = useMixer.getState()
      if (!state.status.running) return
      const now = performance.now()
      if (!force && now - lastRestartAt < 15_000) return
      lastRestartAt = now
      restarting = true
      useUi.getState().notify(t('engine.restart', { reason }))
      void restartEngine().then((result) => {
        restarting = false
        if (!result.ok) {
          useUi.getState().notify(result.error ?? t('engine.restartFailed'))
        }
      })
    }

    const refreshDevices = () => {
      void engineBridge.listDevices().then((devices) => {
        if (!devices || cancelled) return
        const signature = deviceSignature(devices)
        if (signature === deviceSignatureValue) return
        const numberedCables = new Set(
          devices
            .filter((device) => device.kind === 'virtual-playback')
            .map((device) => cableIndex(device.name))
            .filter((index): index is number => index !== null),
        ).size
        // Right after Windows restarts Audiosrv, WASAPI briefly reports only a
        // subset of the twelve VAC lines. Normalizing then would shift B10/B11
        // onto the wrong cables forever, so wait for the full set during the
        // first seconds after launch.
        if (numberedCables > 0 && numberedCables < 12 && performance.now() - bridgeStartedAt < 20_000) {
          return
        }
        deviceSignatureValue = signature

        // Detect losses *before* normalization rewrites the assignments.
        const known = new Set(devices.map((device) => device.id))
        const referenced = referencedDevices()
        const lost = referenced.filter((id) => !known.has(id))
        // A device that came back needs a graph rebuild too: normalization
        // kept its id while it was gone, so the plan did not change.
        const returned = [...missingDevices].filter((id) => known.has(id) && referenced.includes(id))
        missingDevices = new Set(lost)

        normalizeDevices(devices)
        useMixer.setState({ devices })

        // Optional Windows default-device following: keep hw1 and A1 glued to
        // the current defaults without touching user-assigned extra channels.
        const current = useMixer.getState()
        if (current.engine.followDefaultDevices) {
          const defaultIn = devices.find(
            (device) => device.isDefault && (device.kind === 'input' || device.kind === 'virtual-capture'),
          )
          const defaultOut = devices.find(
            (device) => device.isDefault && (device.kind === 'output' || device.kind === 'virtual-playback'),
          )
          if (defaultIn && current.strips.hw1.deviceId !== defaultIn.id) {
            current.setStrip('hw1', { deviceId: defaultIn.id })
          }
          if (defaultOut && current.buses.A1.deviceId !== defaultOut.id) {
            current.setBus('A1', { deviceId: defaultOut.id })
          }
        }

        if ((lost.length > 0 || returned.length > 0) && devices.length > 0) {
          maybeRestart(t('engine.reasonLost'))
        }
      })
    }

    const devicePlanSignature = (state: ReturnType<typeof useMixer.getState>) =>
      `${STRIP_ORDER.map((id) => state.strips[id].deviceId).join('|')}#${BUS_ORDER.map(
        (id) => state.buses[id as BusId].deviceId,
      ).join('|')}`
    let devicePlan = devicePlanSignature(useMixer.getState())

    const scheduleDeviceRestart = () => {
      window.clearTimeout(deviceRestartTimer)
      deviceRestartTimer = window.setTimeout(() => {
        maybeRestart(t('engine.reasonChanged'), true)
      }, 450)
    }

    void engineBridge.getStatus().then((status) => {
      if (status && !cancelled) applyEngineStatus(status)
    })
    void engineBridge.setEngineConfig(useMixer.getState().engine).then((status) => {
      if (status && !cancelled) applyEngineStatus(status)
    })
    refreshDevices()

    const unsubscribe = useMixer.subscribe((state, previous) => {
      // Device assignments are part of the WASAPI graph, not of the per-frame
      // GraphParams. Rebuild the streams after the user picks another endpoint.
      const nextDevicePlan = devicePlanSignature(state)
      if (nextDevicePlan !== devicePlan) {
        devicePlan = nextDevicePlan
        if (state.status.running) scheduleDeviceRestart()
      }

      if (state.engine !== previous.engine) {
        void engineBridge.setEngineConfig(state.engine).then((status) => {
          if (status && !cancelled) applyEngineStatus(status)
        })
      }
      if (
        state.strips === previous.strips &&
        state.buses === previous.buses &&
        state.ai === previous.ai &&
        state.recorder === previous.recorder &&
        state.vcaGroups === previous.vcaGroups &&
        state.masterEq === previous.masterEq &&
        state.masterEqEnabled === previous.masterEqEnabled &&
        state.masterGainDb === previous.masterGainDb
      ) {
        return
      }
      window.clearTimeout(flushTimer)
      flushTimer = window.setTimeout(pushSnapshot, 60)
    })

    // Cold start: the store may already hold a persisted state and never change
    // afterwards, so the engine would keep running with an empty mixer snapshot.
    pushSnapshot()

    let lastInfoPoll = 0
    let lastAiPing = 0
    let lastFrames = -1
    let stalledPolls = 0

    const pollStatus = window.setInterval(() => {
      void engineBridge.getStatus().then((status) => {
        if (!status || cancelled) return
        applyEngineStatus(status)

        // Watchdog: a running engine must keep advancing the frame counter.
        if (status.running) {
          if (status.frames === lastFrames) {
            stalledPolls += 1
            if (stalledPolls >= 3) {
              stalledPolls = 0
              maybeRestart(t('engine.reasonStopped'))
            }
          } else {
            stalledPolls = 0
            lastFrames = status.frames
          }
        } else {
          stalledPolls = 0
          lastFrames = -1
        }

        const now = performance.now()
        if (status.running && now - lastInfoPoll > 3000) {
          lastInfoPoll = now
          void refreshEngineInfo()
        }

        // Protocol v1 health-check: an idle sidecar is pinged every five
        // seconds. A silent disconnect flips the cached status to `error`
        // instead of leaving a stale "ready" badge in the AI panel.
        if (status.ai.state === 'ready' && now - lastAiPing > 5000) {
          lastAiPing = now
          void engineBridge.pingAi().then((ai) => {
            if (cancelled) return
            if (ai) {
              applyAiStatus(ai)
            } else {
              void engineBridge.getAiStatus().then((failed) => {
                if (failed && !cancelled) applyAiStatus(failed)
              })
            }
          })
        }
      })
    }, 1000)

    const pollMeters = window.setInterval(() => {
      void engineBridge.getMeterLevels().then((levels) => {
        if (!cancelled) publishMeterLevels(levels)
      })
    }, 50)

    const pollRecorder = window.setInterval(() => {
      void engineBridge.getRecorderStatus().then((status) => {
        if (!cancelled) useMixer.getState().setRecorderStatus(status)
      })
    }, 1000)

    // Device enumeration walks all VAC pins and is expensive; hot-plug does not
    // need four-second precision. The command itself runs off the UI thread.
    const pollDevices = window.setInterval(refreshDevices, 30_000)

    return () => {
      cancelled = true
      window.clearTimeout(flushTimer)
      window.clearTimeout(deviceRestartTimer)
      window.clearInterval(pollStatus)
      window.clearInterval(pollMeters)
      window.clearInterval(pollRecorder)
      window.clearInterval(pollDevices)
      unsubscribe()
    }
  }, [])
}
