import { create } from 'zustand'
import { useMixer } from './useMixer'
import type { MixerState } from '../types'

type RackTab = MixerState['rackTab']

interface UiState {
  rackOpen: boolean
  guideOpen: boolean
  toast: { id: number; text: string } | null
  setRackOpen: (open: boolean) => void
  toggleRack: () => void
  openRack: (tab?: RackTab) => void
  setGuideOpen: (open: boolean) => void
  notify: (text: string) => void
}

let toastCounter = 0

export const useUi = create<UiState>((set) => ({
  rackOpen: false,
  guideOpen: false,
  toast: null,
  setRackOpen: (rackOpen) => {
    if (rackOpen) {
      const mixer = useMixer.getState()
      mixer.setMatrixOpen(false)
      mixer.setSettingsOpen(false)
    }
    set({ rackOpen })
  },
  toggleRack: () =>
    set((s) => {
      if (!s.rackOpen) {
        const mixer = useMixer.getState()
        mixer.setMatrixOpen(false)
        mixer.setSettingsOpen(false)
      }
      return { rackOpen: !s.rackOpen }
    }),
  openRack: (tab) => {
    if (tab) useMixer.getState().setRackTab(tab)
    const mixer = useMixer.getState()
    mixer.setMatrixOpen(false)
    mixer.setSettingsOpen(false)
    set({ rackOpen: true })
  },
  setGuideOpen: (guideOpen) => set({ guideOpen }),
  notify: (text) => {
    const id = ++toastCounter
    set({ toast: { id, text } })
    setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : s))
    }, 2400)
  },
}))
