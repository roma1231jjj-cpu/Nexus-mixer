export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Fader travel is linear in dB, -60…+12. */
export const FADER_MIN = -60
export const FADER_MAX = 12
export const FADER_RANGE = FADER_MAX - FADER_MIN

export const gainToPercent = (db: number): number => ((clamp(db, FADER_MIN, FADER_MAX) - FADER_MIN) / FADER_RANGE) * 100
export const percentToGain = (percent: number): number => FADER_MIN + (clamp(percent, 0, 100) / 100) * FADER_RANGE

export const dbLabel = (db: number): string =>
  db <= FADER_MIN + 0.05 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`

export const panLabel = (pan: number): string => {
  if (Math.abs(pan) < 0.005) return 'C'
  const side = pan < 0 ? 'L' : 'R'
  return `${side}${Math.round(Math.abs(pan) * 100)}`
}

export const formatHz = (hz: number): string =>
  hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${Math.round(hz)}`

export const formatTime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h > 0 ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export const uid = (prefix = 'id'): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** Smooth logarithmic mapping used by the EQ editors. */
export const freqToX = (freq: number, width: number): number => {
  const min = Math.log10(20)
  const max = Math.log10(20000)
  return ((Math.log10(clamp(freq, 20, 20000)) - min) / (max - min)) * width
}

export const xToFreq = (x: number, width: number): number => {
  const min = Math.log10(20)
  const max = Math.log10(20000)
  const t = clamp(x / width, 0, 1)
  return Math.round(10 ** (min + t * (max - min)))
}
