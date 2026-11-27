import { create } from 'zustand'
import { t } from '../i18n'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  AiSettings,
  Bus,
  BusId,
  BusFx,
  EngineSettings,
  EqBand,
  Macro,
  MacroAction,
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
  /** Momentary macros: capture the state, apply, then restore on release. */
  pressMacro: (id: string) => void
  releaseMacro: (id: string) => void

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

/** Mute states captured before a PANIC press, restored by the next press. */
let panicSnapshot: Record<StripId, boolean> | null = null

/** Per-macro state captured while a momentary macro is held. */
interface MomentarySnapshot {
  strips: Record<StripId, Strip>
  ai: MixerState['ai']
  action: MacroAction
  /** Preset macros resolve their target when pressed; store it for release. */
  presetTargetId?: StripId
  /** AI keys a preset actually changed, so release does not clobber other fields. */
  aiKeys?: string[]
}

const momentarySnapshots = new Map<string, MomentarySnapshot>()

/** Same target/action: the second press must share the first baseline. */
function sameMomentaryTarget(a: MacroAction, b: MacroAction): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'panic' || a.type === 'ai') return true
  if (a.type === 'route') return a.target === b.target && a.bus === b.bus
  if (a.type === 'preset') return a.target === b.target && a.value === b.value
  return a.target === b.target
}

/** A held macro that owns the same mute state as this strip. */
function muteOwnedByHeld(stripId: StripId, held: MomentarySnapshot[]): boolean {
  return held.some(
    (snap) => snap.action.type === 'panic' || (snap.action.type === 'mute' && snap.action.target === stripId),
  )
}

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
        if (!strip) return
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
          ...(stripId ? {} : { selectedStripId: targetId }),
        })
      },

      savePreset: (name) => {
        const state = get()
        const strip = state.strips[state.selectedStripId]
        const preset: Preset = {
          id: `user-${Date.now().toString(36)}`,
          name: name.trim() || t('preset.defaultName'),
          category: 'custom',
          description: t('preset.savedFrom', { name: strip.name }),
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
            // Toggling "any unmuted -> mute everyone" lost the previous mute
            // state: the second press unmuted microphones the user had muted
            // on purpose. Remember the exact state and restore it instead.
            if (panicSnapshot) {
              // Restore only mute, so channel edits made after PANIC survive.
              const mutes = panicSnapshot
              set((current) => ({
                strips: Object.fromEntries(
                  Object.entries(current.strips).map(([key, strip]) => [
                    key,
                    { ...strip, mute: mutes[key as StripId] ?? strip.mute },
                  ]),
                ) as Record<StripId, Strip>,
              }))
              panicSnapshot = null
              return
            }
            panicSnapshot = Object.fromEntries(
              Object.entries(state.strips).map(([key, strip]) => [key, strip.mute]),
            ) as Record<StripId, boolean>
            const strips = Object.fromEntries(
              Object.entries(state.strips).map(([key, strip]) => [key, { ...strip, mute: true }]),
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
            if (typeof action.value === 'string') get().applyPreset(action.value, action.target)
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

      pressMacro: (id) => {
        if (momentarySnapshots.has(id)) return
        const state = get()
        const macro = state.macros.find((m) => m.id === id)
        if (!macro) return
        const held = [...momentarySnapshots.values()]
        const same = held.find((snap) => sameMomentaryTarget(snap.action, macro.action))
        let baseStrips = same?.strips ?? state.strips
        const baseAi = same?.ai ?? state.ai
        // A second macro starts from the first macro's baseline, not from the
        // value the first macro just applied. Otherwise releasing the pair in
        // the wrong order makes the original value disappear.
        if (macro.action.type === 'panic' && !same) {
          for (const snap of held) {
            if (snap.action.type !== 'mute' || !snap.action.target) continue
            const target = snap.action.target
            baseStrips = {
              ...baseStrips,
              [target]: { ...baseStrips[target], mute: snap.strips[target]?.mute ?? baseStrips[target].mute },
            }
          }
        }
        if (macro.action.type === 'mute' && macro.action.target && !same) {
          const panic = held.find((snap) => snap.action.type === 'panic')
          if (panic) {
            const target = macro.action.target
            baseStrips = {
              ...baseStrips,
              [target]: { ...baseStrips[target], mute: panic.strips[target]?.mute ?? baseStrips[target].mute },
            }
          }
        }
        const preset =
          macro.action.type === 'preset' && typeof macro.action.value === 'string'
            ? state.presets.find((item) => item.id === macro.action.value)
            : undefined
        const presetTargetId =
          macro.action.type === 'preset' ? macro.action.target ?? state.selectedStripId : undefined
        // A held macro behaves like a hardware button: it *activates* its
        // action, and releasing restores exactly what was there before.
        momentarySnapshots.set(id, {
          strips: baseStrips,
          ai: baseAi,
          action: macro.action,
          presetTargetId,
          aiKeys: preset?.ai ? Object.keys(preset.ai) : undefined,
        })
        const action = macro.action
        switch (action.type) {
          case 'panic': {
            const strips = Object.fromEntries(
              Object.entries(state.strips).map(([key, strip]) => [key, { ...strip, mute: true }]),
            ) as Record<StripId, Strip>
            set({ strips })
            break
          }
          case 'mute': {
            if (!action.target) return
            set({ strips: { ...state.strips, [action.target]: { ...state.strips[action.target], mute: true } } })
            break
          }
          case 'route': {
            if (!action.target || !action.bus) return
            const strip = state.strips[action.target]
            if (!strip.routing[action.bus]?.on) get().toggleRoute(action.target, action.bus)
            break
          }
          case 'preset': {
            if (typeof action.value === 'string') get().applyPreset(action.value, action.target)
            break
          }
          case 'ai': {
            set({ ai: { ...state.ai, enabled: true } })
            break
          }
          case 'gain': {
            if (!action.target || typeof action.value !== 'number') return
            get().setStrip(action.target, { gainDb: action.value })
            break
          }
        }
      },

      releaseMacro: (id) => {
        const snapshot = momentarySnapshots.get(id)
        if (!snapshot) return
        momentarySnapshots.delete(id)
        const held = [...momentarySnapshots.values()]
        const action = snapshot.action
        // Restore only the fields this macro owns. A field another held macro
        // still owns must keep that macro's value, not this snapshot's.
        if (action.type === 'panic') {
          if (held.some((snap) => snap.action.type === 'panic')) return
          set((current) => ({
            strips: Object.fromEntries(
              Object.entries(current.strips).map(([key, strip]) => {
                const stripId = key as StripId
                if (muteOwnedByHeld(stripId, held)) return [key, strip]
                return [key, { ...strip, mute: snapshot.strips[stripId]?.mute ?? strip.mute }]
              }),
            ) as Record<StripId, Strip>,
          }))
          return
        }
        if (action.type === 'mute') {
          if (!action.target || muteOwnedByHeld(action.target, held)) return
          const before = snapshot.strips[action.target]
          if (!before) return
          set((current) => ({
            strips: {
              ...current.strips,
              [action.target as StripId]: { ...current.strips[action.target as StripId], mute: before.mute },
            },
          }))
          return
        }
        if (action.type === 'gain') {
          if (!action.target) return
          if (held.some((snap) => snap.action.type === 'gain' && snap.action.target === action.target)) return
          const before = snapshot.strips[action.target]
          if (!before) return
          set((current) => ({
            strips: {
              ...current.strips,
              [action.target as StripId]: { ...current.strips[action.target as StripId], gainDb: before.gainDb },
            },
          }))
          return
        }
        if (action.type === 'route') {
          if (!action.target || !action.bus) return
          if (held.some((snap) => snap.action.type === 'route' && snap.action.target === action.target && snap.action.bus === action.bus)) return
          const before = snapshot.strips[action.target]?.routing[action.bus]
          if (!before) return
          set((current) => {
            const strip = current.strips[action.target as StripId]
            return {
              strips: {
                ...current.strips,
                [action.target as StripId]: {
                  ...strip,
                  routing: { ...strip.routing, [action.bus as string]: before },
                },
              },
            }
          })
          return
        }
        if (action.type === 'ai') {
          if (held.some((snap) => snap.action.type === 'ai' || (snap.aiKeys?.length ?? 0) > 0)) return
          set((current) => ({ ai: { ...current.ai, enabled: snapshot.ai.enabled } }))
          return
        }
        if (action.type === 'preset') {
          const target = snapshot.presetTargetId
          if (!target) return
          if (held.some((snap) => snap.action.type === 'preset' && snap.presetTargetId === target)) return
          const before = snapshot.strips[target]
          if (!before) return
          const restoreAi =
            (snapshot.aiKeys?.length ?? 0) > 0 &&
            !held.some((snap) => snap.action.type === 'ai' || (snap.aiKeys?.length ?? 0) > 0)
          set((current) => {
            const strips = {
              ...current.strips,
              [target]: { ...current.strips[target], fx: structuredClone(before.fx), aiPresetId: before.aiPresetId },
            }
            if (!restoreAi) return { strips }
            const ai = { ...current.ai } as unknown as Record<string, unknown>
            const beforeAi = snapshot.ai as unknown as Record<string, unknown>
            for (const key of snapshot.aiKeys ?? []) ai[key] = beforeAi[key]
            return { strips, ai: ai as unknown as MixerState['ai'] }
          })
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
          // Migration: older saves keep 5 buses (A1-B2), the new ones keep 15 (A1-B12)
          // Add the missing B3-B12 buses and their routes.
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
