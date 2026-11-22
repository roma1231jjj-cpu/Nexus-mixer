import type { EqBand } from '../types'
import { clamp, freqToX } from './format'

interface Biquad {
  b0: number
  b1: number
  b2: number
  a0: number
  a1: number
  a2: number
}

/** RBJ audio-EQ-cookbook coefficients. */
const coefficients = (band: EqBand, fs: number): Biquad | null => {
  const freq = clamp(band.freq, 10, fs / 2 - 100)
  const w0 = (2 * Math.PI * freq) / fs
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const q = Math.max(0.05, band.q)

  switch (band.type) {
    case 'peaking': {
      const A = 10 ** (band.gain / 40)
      const alpha = sin / (2 * q)
      return {
        b0: 1 + alpha * A,
        b1: -2 * cos,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cos,
        a2: 1 - alpha / A,
      }
    }
    case 'lowshelf': {
      const A = 10 ** (band.gain / 40)
      const alpha = (sin / 2) * Math.SQRT2
      const sqrtA = Math.sqrt(A)
      return {
        b0: A * (A + 1 - (A - 1) * cos + 2 * sqrtA * alpha),
        b1: 2 * A * (A - 1 - (A + 1) * cos),
        b2: A * (A + 1 - (A - 1) * cos - 2 * sqrtA * alpha),
        a0: A + 1 + (A - 1) * cos + 2 * sqrtA * alpha,
        a1: -2 * (A - 1 + (A + 1) * cos),
        a2: A + 1 + (A - 1) * cos - 2 * sqrtA * alpha,
      }
    }
    case 'highshelf': {
      const A = 10 ** (band.gain / 40)
      const alpha = (sin / 2) * Math.SQRT2
      const sqrtA = Math.sqrt(A)
      return {
        b0: A * (A + 1 + (A - 1) * cos + 2 * sqrtA * alpha),
        b1: -2 * A * (A - 1 + (A + 1) * cos),
        b2: A * (A + 1 + (A - 1) * cos - 2 * sqrtA * alpha),
        a0: A + 1 - (A - 1) * cos + 2 * sqrtA * alpha,
        a1: 2 * (A - 1 - (A + 1) * cos),
        a2: A + 1 - (A - 1) * cos - 2 * sqrtA * alpha,
      }
    }
    case 'highpass': {
      const alpha = sin / (2 * q)
      return {
        b0: (1 + cos) / 2,
        b1: -(1 + cos),
        b2: (1 + cos) / 2,
        a0: 1 + alpha,
        a1: -2 * cos,
        a2: 1 - alpha,
      }
    }
    case 'lowpass': {
      const alpha = sin / (2 * q)
      return {
        b0: (1 - cos) / 2,
        b1: 1 - cos,
        b2: (1 - cos) / 2,
        a0: 1 + alpha,
        a1: -2 * cos,
        a2: 1 - alpha,
      }
    }
    default:
      return null
  }
}

const magnitudeDb = (c: Biquad, freq: number, fs: number): number => {
  const w = (2 * Math.PI * freq) / fs
  const cos1 = Math.cos(w)
  const sin1 = Math.sin(w)
  const cos2 = Math.cos(2 * w)
  const sin2 = Math.sin(2 * w)
  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2
  const numIm = -(c.b1 * sin1 + c.b2 * sin2)
  const denRe = c.a0 + c.a1 * cos1 + c.a2 * cos2
  const denIm = -(c.a1 * sin1 + c.a2 * sin2)
  const num = Math.hypot(numRe, numIm)
  const den = Math.hypot(denRe, denIm) || 1e-12
  return 20 * Math.log10(Math.max(num / den, 1e-6))
}

export interface EqPoint {
  x: number
  y: number
  db: number
  freq: number
}

const DB_RANGE = 24
const PAD = 2

export const eqResponse = (
  bands: EqBand[],
  width: number,
  height: number,
  sampleRate: number,
  steps = 96,
): EqPoint[] => {
  const active = bands.filter((b) => b.enabled).map((b) => ({ band: b, coeffs: coefficients(b, sampleRate) }))
  const points: EqPoint[] = []
  const minLog = Math.log10(20)
  const maxLog = Math.log10(20000)
  for (let i = 0; i <= steps; i += 1) {
    const freq = 10 ** (minLog + ((maxLog - minLog) * i) / steps)
    let db = 0
    for (const { coeffs } of active) {
      if (!coeffs) continue
      db += magnitudeDb(coeffs, freq, sampleRate)
    }
    db = clamp(db, -DB_RANGE, DB_RANGE)
    points.push({
      x: (i / steps) * width,
      y: height / 2 - (db / DB_RANGE) * (height / 2 - PAD),
      db,
      freq,
    })
  }
  return points
}

export const eqPath = (bands: EqBand[], width: number, height: number, sampleRate: number): string => {
  const points = eqResponse(bands, width, height, sampleRate, 72)
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

export const bandNode = (band: EqBand, width: number, height: number): { x: number; y: number } => ({
  x: freqToX(band.freq, width),
  y: height / 2 - (clamp(band.gain, -DB_RANGE, DB_RANGE) / DB_RANGE) * (height / 2 - PAD),
})

export const EQ_DB_RANGE = DB_RANGE
