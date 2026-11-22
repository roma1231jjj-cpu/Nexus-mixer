import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useMixer } from '../store/useMixer'
import { MidiMapping, loadMappings, saveMappings } from './midiLearn'

export type MidiStatus = 'unsupported' | 'idle' | 'connecting' | 'ready' | 'denied'

interface MidiLearnContextValue {
  mappings: MidiMapping[]
  isLearning: boolean
  learningTarget: { target: string; channelId: string } | null
  midiStatus: MidiStatus
  /** Number of hardware inputs seen by the Web MIDI API. */
  inputCount: number
  /** Call when user right-clicks a control: enter learn mode for this target */
  startLearn: (target: string, channelId: string, min: number, max: number) => void
  /** Cancel learn mode */
  cancelLearn: () => void
  /** Add mapping manually */
  addMapping: (mapping: MidiMapping) => void
  /** Remove mapping */
  removeMapping: (id: string) => void
  /** Get all mappings for a specific target */
  getMappingsFor: (target: string, channelId: string) => MidiMapping[]
  /** Used by the browser test sliders when no hardware is connected. */
  injectCc: (cc: number, value: number, channel?: number) => void
  /** Ask for MIDI access. Called from the panel so startup stays prompt-free. */
  connectMidi: () => void
}

const MidiLearnContext = createContext<MidiLearnContextValue | null>(null)

export function MidiLearnProvider({ children }: { children: React.ReactNode }) {
  const [mappings, setMappings] = useState<MidiMapping[]>(() => loadMappings())
  const [midiStatus, setMidiStatus] = useState<MidiStatus>('idle')
  const [inputCount, setInputCount] = useState(0)
  const [learningTarget, setLearningTarget] = useState<{
    target: string
    channelId: string
    min: number
    max: number
  } | null>(null)
  const learningRef = useRef(learningTarget)
  learningRef.current = learningTarget
  const mappingsRef = useRef(mappings)
  mappingsRef.current = mappings

  // Save mappings on change
  useEffect(() => {
    saveMappings(mappings)
  }, [mappings])

  // Apply a MIDI mapping value to the mixer state
  const applyMapping = useCallback((m: MidiMapping, value: number) => {
    const state = useMixer.getState()
    const parts = m.target.split('.')

    if (parts[0] === 'strip') {
      const sid = m.channelId as Parameters<typeof state.setStrip>[0]
      if (!state.strips[sid]) return
      if (parts[1] === 'gainDb') state.setStrip(sid, { gainDb: value })
      else if (parts[1] === 'pan') state.setStrip(sid, { pan: value })
      else if (parts[1] === 'mute') state.setStrip(sid, { mute: value > 0.5 })
      else if (parts[1] === 'solo') state.setStrip(sid, { solo: value > 0.5 })
    } else if (parts[0] === 'bus') {
      const bid = m.channelId as Parameters<typeof state.setBus>[0]
      if (!state.buses[bid]) return
      if (parts[1] === 'gainDb') state.setBus(bid, { gainDb: value })
      else if (parts[1] === 'mute') state.setBus(bid, { mute: value > 0.5 })
    }
  }, [])

  /** Handle a CC message from hardware or from the built-in test sliders. */
  const handleMidiMessage = useCallback(
    (cc: number, value: number, midiChannel = 0) => {
      const learning = learningRef.current
      if (learning) {
        // Complete the learn
        const mapping: MidiMapping = {
          id: `midi-${Date.now().toString(36)}`,
          target: learning.target,
          channelId: learning.channelId,
          cc,
          midiChannel,
          min: learning.min,
          max: learning.max,
          invert: false,
          learning: false,
        }
        setMappings((prev) => [...prev, mapping])
        setLearningTarget(null)
        return
      }

      // Apply mappings
      for (const m of mappingsRef.current) {
        if (m.cc !== cc) continue
        if (m.midiChannel !== midiChannel && m.midiChannel !== -1) continue
        const normalized = value / 127
        const scaled = m.min + (m.invert ? 1 - normalized : normalized) * (m.max - m.min)
        applyMapping(m, scaled)
      }
    },
    [applyMapping],
  )

  // Real Web MIDI input. Browsers require a permission prompt, so access is
  // requested only when the user opens the MIDI panel and clicks connect — or
  // silently when the permission was already granted earlier.
  const accessRef = useRef<any>(null)

  const bindInputs = useCallback(() => {
    const access = accessRef.current
    if (!access) return
    const inputs = [...access.inputs.values()] as any[]
    setInputCount(inputs.length)
    for (const input of inputs) {
      input.onmidimessage = (event: { data: Uint8Array }) => {
        const [status, data1, data2] = event.data
        const command = status & 0xf0
        if (command !== 0xb0) return
        handleMidiMessage(data1, data2, status & 0x0f)
      }
    }
  }, [handleMidiMessage])

  const connectMidi = useCallback(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> }
    if (!nav.requestMIDIAccess) {
      setMidiStatus('unsupported')
      return
    }
    setMidiStatus('connecting')
    nav
      .requestMIDIAccess()
      .then((result: any) => {
        accessRef.current = result
        bindInputs()
        result.onstatechange = bindInputs
        setMidiStatus('ready')
      })
      .catch(() => setMidiStatus('denied'))
  }, [bindInputs])

  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> }
    if (!nav.requestMIDIAccess) {
      setMidiStatus('unsupported')
      return
    }
    navigator.permissions
      ?.query({ name: 'midi' as PermissionName })
      .then((state) => {
        if (state.state === 'granted') connectMidi()
      })
      .catch(() => {})

    return () => {
      if (accessRef.current) accessRef.current.onstatechange = null
    }
  }, [connectMidi])

  const startLearn = useCallback((target: string, channelId: string, min: number, max: number) => {
    setLearningTarget({ target, channelId, min, max })
  }, [])

  const cancelLearn = useCallback(() => {
    setLearningTarget(null)
  }, [])

  const addMapping = useCallback((mapping: MidiMapping) => {
    setMappings((prev) => [...prev, mapping])
  }, [])

  const removeMapping = useCallback((id: string) => {
    setMappings((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const getMappingsFor = useCallback(
    (target: string, channelId: string) => {
      return mappings.filter((m) => m.target === target && m.channelId === channelId)
    },
    [mappings],
  )

  // Expose the handler for the test sliders and console debugging.
  useEffect(() => {
    ;(window as unknown as { __midiInput?: typeof handleMidiMessage }).__midiInput = handleMidiMessage
    return () => {
      delete (window as unknown as { __midiInput?: typeof handleMidiMessage }).__midiInput
    }
  }, [handleMidiMessage])

  return (
    <MidiLearnContext.Provider
      value={{
        mappings,
        isLearning: learningTarget !== null,
        learningTarget,
        midiStatus,
        inputCount,
        startLearn,
        cancelLearn,
        addMapping,
        removeMapping,
        getMappingsFor,
        injectCc: handleMidiMessage,
        connectMidi,
      }}
    >
      {children}
    </MidiLearnContext.Provider>
  )
}

export function useMidiLearn() {
  const ctx = useContext(MidiLearnContext)
  if (!ctx) throw new Error('useMidiLearn must be used within MidiLearnProvider')
  return ctx
}
