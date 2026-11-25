/**
 * High-level engine transport used by UI controls.
 *
 * The low-level bridge is intentionally silent about failures (it returns
 * `null`); these helpers turn that into a human-readable result and keep the
 * Zustand snapshot in sync after start/stop.
 */

import { publishMeterLevels } from '../audio/meterBus'
import { t } from '../i18n'
import { useMixer } from '../store/useMixer'
import type { AiStatus, EngineStatus, RecorderStatus, RuntimeInfo } from '../types'
import { engineBridge, getLastEngineError, snapshotOf } from './engineBridge'

export interface EngineActionResult {
  ok: boolean
  error?: string
  status?: EngineStatus
  info?: RuntimeInfo | null
}

export interface AiActionResult {
  ok: boolean
  error?: string
  ai?: AiStatus
}

export function applyEngineStatus(status: EngineStatus): void {
  useMixer.getState().setStatus({
    running: status.running,
    api: status.api,
    sampleRate: status.sampleRate,
    bufferSize: status.bufferSize,
    latencyMs: status.latencyMs,
    cpuPercent: status.cpuPercent,
    xruns: status.xruns,
    frames: status.frames,
    driver: status.driver,
    aiStatus: status.ai?.state ?? status.aiStatus,
    aiBackend: status.ai?.backend ?? status.aiBackend,
    ai: status.ai,
  })
}

export function applyAiStatus(ai: AiStatus): void {
  useMixer.getState().setStatus({
    ai,
    aiStatus: ai.state,
    aiBackend: ai.backend,
  })
}

export async function connectAiSidecar(
  config?: Record<string, unknown>,
): Promise<AiActionResult> {
  if (!engineBridge.available) {
    return { ok: false, error: t('ai.desktopOnly') }
  }
  // The sidecar handshake derives its chunk size from the last mixer snapshot.
  // Publish the current AI settings first so a fresh launch connects with the
  // chunk size the user actually selected instead of the default.
  await engineBridge.setMixerState(snapshotOf(useMixer.getState()))
  const result = await engineBridge.callResult<AiStatus>('connect_ai_sidecar', { config })
  const ai = result.value
  if (!result.ok || !ai) {
    return { ok: false, error: result.error ?? t('ai.connectError') }
  }
  applyAiStatus(ai)
  return { ok: true, ai }
}

export async function disconnectAiSidecar(): Promise<AiActionResult> {
  if (!engineBridge.available) {
    return { ok: false, error: t('ai.desktopOnly') }
  }
  const result = await engineBridge.callResult<AiStatus>('disconnect_ai_sidecar')
  const ai = result.value
  if (!result.ok || !ai) {
    return { ok: false, error: result.error ?? t('ai.disconnectError') }
  }
  applyAiStatus(ai)
  return { ok: true, ai }
}

export async function pingAiSidecar(): Promise<AiActionResult> {
  if (!engineBridge.available) {
    return { ok: false, error: t('ai.desktopOnly') }
  }
  const ai = await engineBridge.pingAi()
  if (!ai) {
    return { ok: false, error: getLastEngineError() ?? t('ai.pingError') }
  }
  applyAiStatus(ai)
  return { ok: true, ai }
}

export async function refreshEngineInfo(): Promise<RuntimeInfo | null> {
  const info = await engineBridge.getEngineInfo()
  if (info) useMixer.getState().setRuntimeInfo(info)
  return info
}

export async function startEngine(): Promise<EngineActionResult> {
  if (!engineBridge.available) {
    return { ok: false, error: t('engine.desktopOnly') }
  }

  // Always publish the freshest snapshot first: `start_engine` builds the
  // device graph from the last snapshot received by Rust.
  await engineBridge.setMixerState(snapshotOf(useMixer.getState()))
  // Errors travel with the call: a background status poll can no longer wipe
  // the message before it is read.
  const result = await engineBridge.callResult<EngineStatus>('start_engine')
  if (!result.ok || !result.value) {
    return { ok: false, error: result.error ?? t('engine.startFailed') }
  }
  const status = result.value

  applyEngineStatus(status)
  const info = await refreshEngineInfo()
  const recorder = await engineBridge.callResult<RecorderStatus>('get_recorder_status')
  useMixer.getState().setRecorderStatus(recorder.ok ? recorder.value : null)
  return { ok: true, status, info }
}

export async function stopEngine(): Promise<EngineActionResult> {
  if (!engineBridge.available) {
    return { ok: false, error: t('engine.desktopOnly') }
  }

  const result = await engineBridge.callResult<EngineStatus>('stop_engine')
  if (!result.ok || !result.value) {
    return { ok: false, error: result.error ?? t('engine.stopFailed') }
  }
  const status = result.value

  applyEngineStatus(status)
  useMixer.getState().setRuntimeInfo(null)
  useMixer.getState().setRecorderStatus(null)
  publishMeterLevels(null)
  return { ok: true, status }
}

/**
 * Rebuild the device graph without reloading the UI. Used by the hot-plug
 * watcher and the callback watchdog; the mixer snapshot is preserved, so the
 * user does not lose any settings.
 */
export async function restartEngine(): Promise<EngineActionResult> {
  if (!engineBridge.available) {
    return { ok: false, error: t('engine.desktopOnly') }
  }

  const stopped = await engineBridge.callResult<EngineStatus>('stop_engine')
  if (!stopped.ok) {
    // Starting on top of a graph that refused to stop would either fail or
    // leave two runtimes fighting for the same endpoints.
    return { ok: false, error: stopped.error ?? t('engine.stopFailed') }
  }
  useMixer.getState().setRuntimeInfo(null)
  useMixer.getState().setRecorderStatus(null)
  publishMeterLevels(null)
  return startEngine()
}
