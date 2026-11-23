import { create } from 'zustand'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { t } from '../i18n'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

interface UpdaterState {
  status: UpdateStatus
  version: string | null
  currentVersion: string | null
  notes: string | null
  progress: number
  error: string | null
  hidden: boolean
  checkedAt: number | null
  check: (auto?: boolean) => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  dismiss: () => void
}

let pending: Update | null = null
let bytes = 0
let total = 0

const isDesktop = () => typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: 'idle',
  version: null,
  currentVersion: null,
  notes: null,
  progress: 0,
  error: null,
  hidden: false,
  checkedAt: null,

  check: async (auto = false) => {
    if (!isDesktop()) {
      if (!auto) set({ status: 'error', error: t('updates.desktopOnly') })
      return
    }
    const state = get()
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'installing') return

    set({ status: 'checking', error: null })
    try {
      const update = await check({ timeout: 20_000 })
      if (!update) {
        set({
          status: 'current',
          version: null,
          currentVersion: null,
          notes: null,
          checkedAt: Date.now(),
        })
        return
      }

      if (pending) {
        await pending.close().catch(() => undefined)
      }
      pending = update
      bytes = 0
      total = 0
      set({
        status: 'available',
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? null,
        progress: 0,
        hidden: false,
        checkedAt: Date.now(),
      })

      // "Auto-update" means the package is fetched in the background. The
      // installer itself waits for the user, because replacing the binary
      // closes the app and interrupts audio.
      if (auto) await get().download()
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      })
    }
  },

  download: async () => {
    if (!pending) return
    set({ status: 'downloading', progress: 0, error: null })
    try {
      await pending.download((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
          set({ progress: 0 })
        } else if (event.event === 'Progress') {
          bytes += event.data.chunkLength
          const percent = total > 0 ? Math.min(99, Math.round((bytes / total) * 100)) : 0
          set({ progress: percent })
        } else {
          set({ status: 'ready', progress: 100 })
        }
      })
      // `download` resolves after Finished; keep ready if the event was missed.
      if (get().status === 'downloading') set({ status: 'ready', progress: 100 })
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },

  install: async () => {
    if (!pending) return
    set({ status: 'installing', error: null })
    try {
      // On Windows this starts the signed NSIS updater and exits the app.
      await pending.install({ restartAfterInstall: true })
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },

  dismiss: () => set({ hidden: true }),
}))
