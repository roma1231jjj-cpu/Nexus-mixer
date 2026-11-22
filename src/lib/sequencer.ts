export interface StepSequencerState {
  running: boolean
  bpm: number
  /** steps 0-15, each step is a set of sample IDs that fire on that beat */
  pattern: Record<string, boolean[]>  // sampleId → [16 booleans]
  currentStep: number
  swing: number  // 0-100% swing
}

export function createSequencer(): StepSequencerState {
  return {
    running: false,
    bpm: 120,
    pattern: {},
    currentStep: 0,
    swing: 0,
  }
}

export function toggleStep(
  state: StepSequencerState,
  sampleId: string,
  stepIndex: number,
): StepSequencerState {
  const lanes = state.pattern[sampleId] ?? Array(16).fill(false)
  lanes[stepIndex] = !lanes[stepIndex]
  return {
    ...state,
    pattern: { ...state.pattern, [sampleId]: [...lanes] },
  }
}

export function clearPattern(
  state: StepSequencerState,
  sampleId?: string,
): StepSequencerState {
  if (sampleId) {
    return {
      ...state,
      pattern: { ...state.pattern, [sampleId]: Array(16).fill(false) },
    }
  }
  return { ...state, pattern: {} }
}
