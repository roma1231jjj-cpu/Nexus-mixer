import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  AiSettings,
  Bus,
  BusId,
  BusFx,
  EngineSettings,
  EqBand,
  Macro,
  MixerState,
  Preset,
  RecorderSettings,
  Route,
  Strip,
  StripFx,
  StripId,
  Theme,
  VcaGroup,
} from '../types'
import { THEME_STORAGE_KEY, BUS_ORDER, STRIP_ORDER, defaultAi, makeBuses, makeInitialState, makeStrips, makeVelvetVoiceFx } from '../data/defaults'

interface MixerActions {
  setTheme: (theme: Theme) => void
  toggleTheme: () => void

  setStrip: (id: StripId, patch: Partial<Strip>) => void
  setStripFx: (id: StripId, patch: Partial<StripFx>) => void
  setStripEqBand: (id: StripId, bandId: string, patch: Partial<EqBand>) => void
  setRoute: (id: StripId, bus: BusId, patch: Partial<Route>) => void
  toggleRoute: (id: StripId, bus: BusId) => void

  setBus: (id: BusId, patch: Partial<Bus>) => void
  setBusFx: (id: BusId, patch: Partial<BusFx>) => void
  setBusEqBand: (id: BusId, bandId: string, patch: Partial<EqBand>) => void

  selectStrip: (id: StripId) => void
  selectBus: (id: BusId) => void
  setMultiSelectedStripIds: (ids: StripId[]) => void
  clearMultiSelection: () => void
  setRackTab: (tab: MixerState['rackTab']) => void
  setMatrixOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void

  setStatus: (patch: Partial<MixerState['status']>) => void
  setRuntimeInfo: (info: MixerState['runtimeInfo']) => void
  setRecorderStatus: (status: MixerState['recorderStatus']) => void
  setEngine: (patch: Partial<EngineSettings>) => void
  setRecorder: (patch: Partial<RecorderSettings>) => void
  setAi: (patch: Partial<AiSettings>) => void
  setMasterEqBand: (bandId: string, patch: Partial<EqBand>) => void
  setMasterEqEnabled: (enabled: boolean) => void
  setMasterGainDb: (gainDb: number) => void

  applyPreset: (presetId: string, stripId?: StripId) => void
  savePreset: (name: string) => void
  deletePreset: (presetId: string) => void

  addMacro: () => void
  updateMacro: (id: string, patch: Partial<Macro>) => void
  removeMacro: (id: string) => void
  runMacro: (id: string) => void

  /** Reveal the next empty source slot and assign an input device. */
  addSource: (deviceId: string, name?: string) => StripId | null

  resetAll: () => void

  setVcaGain: (groupId: string, gainDb: number) => void
  setVcaMute: (groupId: string, mute: boolean) => void
  vcaAddStrip: (groupId: string, stripId: StripId) => void
  vcaRemoveStrip: (groupId: string, stripId: StripId) => void
  vcaRename: (groupId: string, name: string) => void
  setVcaGroups: (groups: VcaGroup[]) => void
}

export type MixerStore = MixerState & MixerActions

const LEGACY_COLORS: Record<string, string> = {
  '#a78bfa': '#c8a15a',
  '#f472b6': '#b98a72',
  '#38bdf8': '#7f97a8',
  '#c084fc': '#8f9a7a',
  '#22d3ee': '#a98fa0',
  '#818cf8': '#8f9a7a',
  '#60a5fa': '#7f97a8',
  '#34d399': '#7f97a8',
  '#f43f5e': '#a98fa0',
  '#fbbf24': '#c8a15a',
}

/** Move the old neon presets onto the muted studio palette once. */
const migrateColor = (color: string): string => LEGACY_COLORS[color.toLowerCase()] ?? color

const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

const withSoloFlag = (strips: Record<StripId, Strip>) => ({
  strips,
  soloActive: Object.values(strips).some((s) => s.solo),
  cueActive: Object.values(strips).some((s) => (s as any).cue),
})

export const useMixer = create<MixerStore>()(
  persist(
    (set, get) => ({
      ...makeInitialState(),

      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
      toggleTheme: () => {
        const order: Theme[] = ['studio', 'dark', 'light']
        const theme = order[(order.indexOf(get().theme) + 1) % order.length]
        applyTheme(theme)
        set({ theme })
      },

      setStrip: (id, patch) =>
        set((state) => {
          const strips = { ...state.strips, [id]: { ...state.strips[id], ...patch } }
          // An endpoint can only feed one capture stream; assigning it here
          // releases it from any other source instead of letting WASAPI reject
          // the duplicate at engine start.
          if (patch.deviceId) {
            for (const other of Object.keys(strips) as StripId[]) {
              if (other !== id && strips[other].deviceId === patch.deviceId) {
                strips[other] = { ...strips[other], deviceId: '' }
              }
            }
          }
          return withSoloFlag(strips)
        }),

      setStripFx: (id, patch) =>
        set((state) => {
          const strip = state.strips[id]
          return {
            strips: { ...state.strips, [id]: { ...strip, fx: { ...strip.fx, ...patch } } },
          }
        }),

      setStripEqBand: (id, bandId, patch) =>
        set((state) => {
          const strip = state.strips[id]
          return {
            strips: {
              ...state.strips,
              [id]: {
                ...strip,
                fx: {
                  ...strip.fx,
                  eq: strip.fx.eq.map((band) => (band.id === bandId ? { ...band, ...patch } : band)),
                },
              },
            },
          }
        }),

      setRoute: (id, bus, patch) =>
        set((state) => {
          const strip = state.strips[id]
          return {
            strips: {
              ...state.strips,
              [id]: { ...strip, routing: { ...strip.routing, [bus]: { ...strip.routing[bus], ...patch } } },
            },
          }
        }),

      toggleRoute: (id, bus) =>
        set((state) => {
          const strip = state.strips[id]
          const current = strip.routing[bus]
          return {
            strips: {
              ...state.strips,
              [id]: {
                ...strip,
                routing: { ...strip.routing, [bus]: { ...current, on: !current.on } },
              },
            },
          }
        }),

      setBus: (id, patch) =>
        set((state) => {
          const buses = { ...state.buses, [id]: { ...state.buses[id], ...patch } }
          if (patch.deviceId) {
            for (const other of Object.keys(buses) as BusId[]) {
              if (other !== id && buses[other].deviceId === patch.deviceId) {
                buses[other] = { ...buses[other], deviceId: '' }
              }
            }
          }
          return { buses }
        }),

      setBusFx: (id, patch) =>
        set((state) => {
          const bus = state.buses[id]
          return { buses: { ...state.buses, [id]: { ...bus, fx: { ...bus.fx, ...patch } } } }
        }),

      setBusEqBand: (id, bandId, patch) =>
        set((state) => {
          const bus = state.buses[id]
          return {
            buses: {
              ...state.buses,
              [id]: {
                ...bus,
                fx: {
                  ...bus.fx,
                  eq: bus.fx.eq.map((band) => (band.id === bandId ? { ...band, ...patch } : band)),
                },
              },
            },
          }
        }),

      selectStrip: (id) => set({ selectedStripId: id, selectionKind: 'strip' }),
      selectBus: (id) => set({ selectedBusId: id, selectionKind: 'bus' }),
      setMultiSelectedStripIds: (ids) => set({ multiSelectedStripIds: ids }),
      clearMultiSelection: () => set({ multiSelectedStripIds: [] }),
      setRackTab: (tab) => set({ rackTab: tab }),
      setMatrixOpen: (matrixOpen) => set({ matrixOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

      setStatus: (patch) => set((state) => ({ status: { ...state.status, ...patch } })),
      setRuntimeInfo: (runtimeInfo) => set({ runtimeInfo }),
      setRecorderStatus: (recorderStatus) => set({ recorderStatus }),
      setEngine: (patch) => set((state) => ({ engine: { ...state.engine, ...patch } })),
      setRecorder: (patch) => set((state) => ({ recorder: { ...state.recorder, ...patch } })),
      setAi: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
      setMasterEqBand: (bandId, patch) =>
        set((state) => ({
          masterEq: state.masterEq.map((band) => (band.id === bandId ? { ...band, ...patch } : band)),
        })),
      setMasterEqEnabled: (masterEqEnabled) => set({ masterEqEnabled }),
      setMasterGainDb: (masterGainDb) => set({ masterGainDb }),

      applyPreset: (presetId, stripId) => {
        const state = get()
        const preset = state.presets.find((p) => p.id === presetId)
        if (!preset) return
        const targetId = stripId ?? state.selectedStripId
        const strip = state.strips[targetId]
        const nextFx: StripFx = {
          gate: { ...strip.fx.gate, ...preset.fx.gate },
          compressor: { ...strip.fx.compressor, ...preset.fx.compressor },
          deesser: { ...strip.fx.deesser, ...preset.fx.deesser },
          saturator: { ...strip.fx.saturator, ...preset.fx.saturator },
          eq: preset.fx.eq ? preset.fx.eq.map((band) => ({ ...band })) : strip.fx.eq,
        }
        set({
          strips: {
            ...state.strips,
            [targetId]: { ...strip, fx: nextFx, aiPresetId: preset.ai ? preset.id : null },
          },
          ai: preset.ai ? { ...state.ai, ...preset.ai } : state.ai,
          selectedStripId: targetId,
        })
      },

      savePreset: (name) => {
        const state = get()
        const strip = state.strips[state.selectedStripId]
        const preset: Preset = {
          id: `user-${Date.now().toString(36)}`,
          name: name.trim() || 'Мой пресет',
          category: 'custom',
          description: `Сохранено с канала ${strip.name}`,
          fx: {
            gate: { ...strip.fx.gate },
            compressor: { ...strip.fx.compressor },
            deesser: { ...strip.fx.deesser },
            saturator: { ...strip.fx.saturator },
            eq: strip.fx.eq.map((band) => ({ ...band })),
          },
          ai: { ...state.ai },
          builtin: false,
        }
        set({ presets: [...state.presets, preset] })
      },

      deletePreset: (presetId) =>
        set((state) => ({ presets: state.presets.filter((p) => p.id !== presetId || p.builtin) })),

      addMacro: () =>
        set((state) => ({
          macros: [
            ...state.macros,
            {
              id: `macro-${Date.now().toString(36)}`,
              label: 'NEW MACRO',
              color: '#a78bfa',
              shortcut: '',
              action: { type: 'mute', target: state.selectedStripId },
              momentary: false,
            },
          ],
        })),

      addSource: (deviceId, name) => {
        const state = get()
        if (state.sourceCount >= STRIP_ORDER.length) return null
        const id = STRIP_ORDER[state.sourceCount]
        const strip = state.strips[id]
        const next: Strip = {
          ...strip,
          deviceId,
          name: name?.trim() || strip.name,
        }
        set({
          strips: { ...state.strips, [id]: next },
          sourceCount: state.sourceCount + 1,
          selectedStripId: id,
          selectionKind: 'strip',
        })
        return id
      },

      updateMacro: (id, patch) =>
        set((state) => ({ macros: state.macros.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),

      removeMacro: (id) => set((state) => ({ macros: state.macros.filter((m) => m.id !== id) })),

      runMacro: (id) => {
        const state = get()
        const macro = state.macros.find((m) => m.id === id)
        if (!macro) return
        const action = macro.action
        switch (action.type) {
          case 'panic': {
            const anyUnmuted = Object.values(state.strips).some((s) => !s.mute)
            const strips = Object.fromEntries(
              Object.entries(state.strips).map(([key, strip]) => [key, { ...strip, mute: anyUnmuted }]),
            ) as Record<StripId, Strip>
            set({ strips })
            break
          }
          case 'mute': {
            if (!action.target) return
            const strip = state.strips[action.target]
            set({ strips: { ...state.strips, [action.target]: { ...strip, mute: !strip.mute } } })
            break
          }
          case 'route': {
            if (!action.target || !action.bus) return
            get().toggleRoute(action.target, action.bus)
            break
          }
          case 'preset': {
            if (typeof action.value === 'string') get().applyPreset(action.value)
            break
          }
          case 'ai': {
            set({ ai: { ...state.ai, enabled: !state.ai.enabled } })
            break
          }
          case 'gain': {
            if (!action.target || typeof action.value !== 'number') return
            get().setStrip(action.target, { gainDb: action.value })
            break
          }
        }
      },

      setVcaGain: (groupId, gainDb) =>
        set((state) => ({
          vcaGroups: state.vcaGroups.map((g) =>
            g.id === groupId ? { ...g, gainDb } : g
          ),
        })),

      setVcaMute: (groupId, mute) =>
        set((state) => ({
          vcaGroups: state.vcaGroups.map((g) =>
            g.id === groupId ? { ...g, mute } : g
          ),
        })),

      vcaAddStrip: (groupId, stripId) =>
        set((state) => ({
          vcaGroups: state.vcaGroups.map((g) => {
            // Remove strip from all groups first (strip can be in at most one group)
            const withoutStrip = { ...g, strips: g.strips.filter((s) => s !== stripId) }
            return g.id === groupId
              ? { ...withoutStrip, strips: [...withoutStrip.strips, stripId] }
              : withoutStrip
          }),
        })),

      vcaRemoveStrip: (groupId, stripId) =>
        set((state) => ({
          vcaGroups: state.vcaGroups.map((g) =>
            g.id === groupId ? { ...g, strips: g.strips.filter((s) => s !== stripId) } : g
          ),
        })),

      vcaRename: (groupId, name) =>
        set((state) => ({
          vcaGroups: state.vcaGroups.map((g) =>
            g.id === groupId ? { ...g, name } : g
          ),
        })),

      setVcaGroups: (vcaGroups) => set({ vcaGroups }),

      resetAll: () => {
        const fresh = makeInitialState()
        set({ ...fresh, theme: get().theme })
      },
    }),
    {
      name: 'nexus-mixer.state',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => {
        const state = persisted as { theme?: Theme }
        // Saved 0.3.x builds used `dark` for the matte studio surface. Promote
        // that save to the new explicit `studio` skin instead of surprising the
        // user with the new glass skin after an update.
        if (!state.theme || state.theme === 'dark') state.theme = 'studio'
        if (state.theme !== 'studio' && state.theme !== 'light') state.theme = 'studio'
        return state
      },
      partialize: (state) => ({
        strips: state.strips,
        sourceCount: state.sourceCount,
        buses: state.buses,
        engine: state.engine,
        recorder: state.recorder,
        ai: state.ai,
        aiModels: state.aiModels,
        presets: state.presets,
        macros: state.macros,
        vcaGroups: state.vcaGroups,
        masterEq: state.masterEq,
        masterEqEnabled: state.masterEqEnabled,
        masterGainDb: state.masterGainDb,
        theme: state.theme,
        selectedStripId: state.selectedStripId,
        selectedBusId: state.selectedBusId,
        selectionKind: state.selectionKind,
        rackTab: state.rackTab,
        matrixOpen: state.matrixOpen,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme)
          // Older saves predate the local voice engine. Fill the new fields
          // instead of letting `undefined` disable the source selector.
          state.ai = { ...defaultAi, ...state.ai }
          if (!state.ai.source) state.ai.source = 'hw1'
          // Миграция: старые сохранения хранят 5 шин (A1-B2), новые — 15 (A1-B12)
          // Добавляем недостающие шины B3-B12 и маршруты для них.
          const freshBuses = makeBuses()
          if (state.buses) {
            for (const id of BUS_ORDER) {
              if (!state.buses[id]) {
                state.buses[id] = freshBuses[id]
              }
            }
          }
          if (state.strips) {
            const freshStrips = makeStrips()
            for (const id of STRIP_ORDER) {
              if (!state.strips[id]) state.strips[id] = freshStrips[id]
            }
            for (const strip of Object.values(state.strips)) {
              strip.color = migrateColor(strip.color)
              if (strip.routing) {
                for (const bus of BUS_ORDER) {
                  if (!strip.routing[bus]) {
                    strip.routing[bus] = { on: false, levelDb: 0 }
                  }
                }
              }
            }
          }
          if (typeof state.sourceCount !== 'number') state.sourceCount = 5
          state.sourceCount = Math.max(5, Math.min(state.sourceCount, STRIP_ORDER.length))
          if (state.buses) {
            for (const bus of Object.values(state.buses)) {
              bus.color = migrateColor(bus.color)
            }
          }
          // Keep the built-in velvet preset in sync with the current hum
          // notches, so recalling it cannot reintroduce the 120 Hz drone.
          if (state.presets) {
            for (const preset of state.presets) {
              if (preset.id === 'velvet') preset.fx = makeVelvetVoiceFx()
            }
          }
        }
      },
    },
  ),
)

/** Effective mute considering the global solo state and its VCA group. */
export const isStripAudible = (strip: Strip, soloActive: boolean, vcaMute = false): boolean =>
  !strip.mute && !vcaMute && (!soloActive || strip.solo)

/** Gain offset and mute contributed by the strip's VCA group. */
export const stripVcaState = (
  stripId: StripId,
  vcaGroups: VcaGroup[],
): { gainDb: number; mute: boolean; group: VcaGroup | null } => {
  const group = vcaGroups.find((candidate) => candidate.strips.includes(stripId)) ?? null
  return { gainDb: group?.gainDb ?? 0, mute: group?.mute ?? false, group }
}

export const selectedStrip = (state: MixerStore): Strip => state.strips[state.selectedStripId]
