/**
 * Tauri window controls.
 *
 * The UI also runs in a plain browser (`npm run dev`) where there is no Tauri
 * runtime. Every helper resolves to `false` in that case so the caller can
 * show a toast instead of throwing.
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type TauriWindow = import('@tauri-apps/api/window').Window

let current: Promise<TauriWindow | null> | null = null

async function currentWindow(): Promise<TauriWindow | null> {
  if (!isTauri) return null
  if (!current) {
    current = import('@tauri-apps/api/window')
      .then((mod) => mod.getCurrentWindow())
      .catch(() => null)
  }
  return current
}

export const windowControls = {
  available: isTauri,

  async minimize(): Promise<boolean> {
    const win = await currentWindow()
    if (!win) return false
    await win.minimize()
    return true
  },

  async toggleMaximize(): Promise<boolean> {
    const win = await currentWindow()
    if (!win) return false
    await win.toggleMaximize()
    return true
  },

  async close(): Promise<boolean> {
    const win = await currentWindow()
    if (!win) return false
    await win.close()
    return true
  },
}

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close'
