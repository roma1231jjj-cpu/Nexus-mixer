/**
 * MIDI Learn — mapping storage for Nexus-Mixer.
 *
 * In production this would interface with the Web MIDI API. For now, mappings
 * are stored in localStorage and can be exercised via a test range-slider.
 */

export interface MidiMapping {
  /** Unique ID for this mapping */
  id: string
  /** What to control: 'strip.gainDb' | 'strip.pan' | 'strip.mute' | 'strip.solo' | 'bus.gainDb' | 'bus.mute' | 'fx.compressor.threshold' etc. */
  target: string
  /** Strip ID or Bus ID */
  channelId: string
  /** MIDI CC number (0-127) */
  cc: number
  /** MIDI channel (0-15) */
  midiChannel: number
  /** Min value */
  min: number
  /** Max value */
  max: number
  /** Invert direction */
  invert: boolean
  /** Learn mode: next MIDI message assigns this slot */
  learning: boolean
}

const STORAGE_KEY = 'nexus-mixer.midi-mappings'

export function loadMappings(): MidiMapping[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveMappings(mappings: MidiMapping[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings))
  } catch {
    /* ignore */
  }
}
