/**
 * Intent parser — converts natural-language prompts into mixer parameter changes.
 * Supports Russian + English keywords.
 */

import type { Bus, BusFx, EqBand, Strip, StripFx } from '../types'
import { t, type TKey } from '../i18n'

/* ──────────────────── intent types ──────────────────── */

export interface ParamChange {
  descriptionKey: TKey
  /** Apply this change to the selected strip/bus. Returns list of changed params. */
  apply(strip: Strip, bus: Bus, ctx: ApplyCtx): string[]
}

export interface ApplyCtx {
  setStrip: (id: string, patch: Partial<Strip>) => void
  setStripFx: (id: string, patch: Partial<StripFx>) => void
  setStripEqBand: (id: string, bandId: string, patch: Partial<EqBand>) => void
  setBusFx: (id: string, patch: Partial<BusFx>) => void
  setBusEqBand: (id: string, bandId: string, patch: Partial<EqBand>) => void
  setBus: (id: string, patch: Partial<Bus>) => void
  findDisabledStripBand: (id: string) => string | null
  findDisabledBusBand: (id: string) => string | null
  notify: (msg: string) => void
}

export interface ParsedIntent {
  keyword: string
  changes: ParamChange[]
}

/* ──────────────────── helper: find or create EQ band ──────────────────── */

function findBand(bands: EqBand[], predicate: (b: EqBand) => boolean): EqBand | undefined {
  return bands.find(predicate)
}

/* ──────────────────── intent definitions ──────────────────── */

const INTENTS: { words: string[]; changes: ParamChange[] }[] = [
  /* ─── Bass / Deep ─── */
  {
    words: ['глубок', 'бас', 'низк', 'бум', 'bass', 'deep', 'low', 'boom', 'sub'],
    changes: [
      {
        descriptionKey: 'intent.bass.boost',
        apply(strip, _bus, ctx) {
          const bands = strip.fx.eq
          const existing = findBand(bands, (b) => b.type === 'lowshelf' && b.enabled)
          if (existing) {
            ctx.setStripEqBand(strip.id, existing.id, { gain: Math.min(existing.gain + 4, 24), enabled: true })
            return ['EQ lowshelf gain']
          }
          const id = ctx.findDisabledStripBand(strip.id)
          if (id) {
            ctx.setStripEqBand(strip.id, id, { type: 'lowshelf', freq: 80, gain: 4, q: 0.707, enabled: true })
            return ['EQ new lowshelf 80 Hz +4 dB']
          }
          return []
        },
      },
      {
        descriptionKey: 'intent.bass.cut',
        apply(strip, _bus, ctx) {
          const bands = strip.fx.eq
          const existing = findBand(bands, (b) => b.type === 'highpass' && b.enabled)
          if (existing) {
            ctx.setStripEqBand(strip.id, existing.id, { freq: 40, enabled: true })
            return ['EQ HPF 40 Hz']
          }
          const id = ctx.findDisabledStripBand(strip.id)
          if (id) {
            ctx.setStripEqBand(strip.id, id, { type: 'highpass', freq: 40, gain: 0, q: 0.707, enabled: true })
            return ['EQ new HPF 40 Hz']
          }
          return []
        },
      },
    ],
  },

  /* ─── Echo / Delay ─── */
  {
    words: ['эх', 'задержк', 'реверб', 'echo', 'delay', 'reverb', 'reverberation', 'space'],
    changes: [
      {
        descriptionKey: 'intent.echo.delay',
        apply(_strip, bus, ctx) {
          ctx.setBusFx(bus.id, { delayMs: 90 })
          return ['Bus delay 90 ms']
        },
      },
      {
        descriptionKey: 'intent.echo.width',
        apply(_strip, bus, ctx) {
          ctx.setBusFx(bus.id, { width: 130 })
          return ['Bus width 130%']
        },
      },
    ],
  },

  /* ─── Bright / Air ─── */
  {
    words: ['ярк', 'высок', 'светл', 'воздух', 'bright', 'high', 'air', 'airy', 'shine'],
    changes: [
      {
        descriptionKey: 'intent.bright.shelf',
        apply(strip, _bus, ctx) {
          const bands = strip.fx.eq
          const existing = findBand(bands, (b) => b.type === 'highshelf' && b.enabled)
          if (existing) {
            ctx.setStripEqBand(strip.id, existing.id, { gain: Math.min(existing.gain + 3, 24), enabled: true })
            return ['EQ highshelf gain']
          }
          const id = ctx.findDisabledStripBand(strip.id)
          if (id) {
            ctx.setStripEqBand(strip.id, id, { type: 'highshelf', freq: 10000, gain: 3, q: 0.707, enabled: true })
            return ['EQ new highshelf 10 kHz +3 dB']
          }
          return []
        },
      },
    ],
  },

  /* ─── Clear voice ─── */
  {
    words: ['чист', 'прозрач', 'ясн', 'clear', 'clarity', 'voice', 'vocal', 'понятн'],
    changes: [
      {
        descriptionKey: 'intent.clear.cut',
        apply(strip, _bus, ctx) {
          const bands = strip.fx.eq
          const existing = findBand(bands, (b) => b.type === 'peaking' && b.enabled && Math.abs(b.freq - 300) < 100)
          if (existing) {
            ctx.setStripEqBand(strip.id, existing.id, { gain: Math.max(existing.gain - 3, -24), enabled: true })
            return ['EQ 300 Hz cut']
          }
          const id = ctx.findDisabledStripBand(strip.id)
          if (id) {
            ctx.setStripEqBand(strip.id, id, { type: 'peaking', freq: 300, gain: -3, q: 1.4, enabled: true })
            return ['EQ new peaking 300 Hz -3 dB']
          }
          return []
        },
      },
      {
        descriptionKey: 'intent.clear.presence',
        apply(strip, _bus, ctx) {
          const bands = strip.fx.eq
          const existing = findBand(bands, (b) => b.type === 'peaking' && b.enabled && Math.abs(b.freq - 4000) < 1000)
          if (existing) {
            ctx.setStripEqBand(strip.id, existing.id, { gain: Math.min(existing.gain + 2.5, 24), enabled: true })
            return ['EQ 4 kHz boost']
          }
          const id = ctx.findDisabledStripBand(strip.id)
          if (id) {
            ctx.setStripEqBand(strip.id, id, { type: 'peaking', freq: 4000, gain: 2.5, q: 1.2, enabled: true })
            return ['EQ new peaking 4 kHz +2.5 dB']
          }
          return []
        },
      },
      {
        descriptionKey: 'intent.clear.deesser',
        apply(strip, _bus, ctx) {
          ctx.setStripFx(strip.id, {
            deesser: { ...strip.fx.deesser, enabled: true, frequency: 6500, threshold: -32, amount: 50 },
          })
          return ['De-Esser enabled']
        },
      },
    ],
  },

  /* ─── Noise gate ─── */
  {
    words: ['шум', 'тиш', 'gate', 'noise', 'шип', 'hum', 'фон'],
    changes: [
      {
        descriptionKey: 'intent.noise.gate',
        apply(strip, _bus, ctx) {
          ctx.setStripFx(strip.id, {
            gate: { ...strip.fx.gate, enabled: true, threshold: -54, range: -40, attack: 2, hold: 60, release: 150 },
          })
          return ['Gate enabled (thresh -54 dB, range -40)']
        },
      },
    ],
  },

  /* ─── Louder ─── */
  {
    words: ['громк', 'сильн', 'loud', 'louder', 'volume', 'boost'],
    changes: [
      {
        descriptionKey: 'intent.loud.gain',
        apply(strip, _bus, ctx) {
          ctx.setStrip(strip.id, { gainDb: Math.min(strip.gainDb + 3, 12) })
          return [`Gain +3 dB → ${(strip.gainDb + 3).toFixed(1)} dB`]
        },
      },
    ],
  },

  /* ─── Warm ─── */
  {
    words: ['тепл', 'мягк', 'warm', 'warmth', 'soft', 'уютн', 'лампов'],
    changes: [
      {
        descriptionKey: 'intent.warm.sat',
        apply(strip, _bus, ctx) {
          ctx.setStripFx(strip.id, {
            saturator: {
              ...strip.fx.saturator,
              enabled: true,
              drive: 35,
              tone: -20,
              mix: 30,
            },
          })
          return ['Saturator enabled (drive 35, tone -20, mix 30)']
        },
      },
      {
        descriptionKey: 'intent.warm.lows',
        apply(strip, _bus, ctx) {
          const bands = strip.fx.eq
          const existing = findBand(bands, (b) => b.type === 'lowshelf' && b.enabled)
          if (existing) {
            ctx.setStripEqBand(strip.id, existing.id, { gain: Math.min(existing.gain + 2, 24), enabled: true, freq: 120 })
            return ['EQ lowshelf 120 Hz boost']
          }
          const id = ctx.findDisabledStripBand(strip.id)
          if (id) {
            ctx.setStripEqBand(strip.id, id, { type: 'lowshelf', freq: 120, gain: 2, q: 0.7, enabled: true })
            return ['EQ new lowshelf 120 Hz +2 dB']
          }
          return []
        },
      },
    ],
  },

  /* ─── Compression ─── */
  {
    words: ['сжат', 'плотн', 'compres', 'compressor', 'ровн', 'динамик'],
    changes: [
      {
        descriptionKey: 'intent.comp',
        apply(strip, _bus, ctx) {
          ctx.setStripFx(strip.id, {
            compressor: {
              ...strip.fx.compressor,
              enabled: true,
              threshold: -24,
              ratio: 6,
              knee: 8,
              attack: 8,
              release: 120,
              makeup: 4,
            },
          })
          return ['Compressor enabled (ratio 6:1, thresh -24 dB)']
        },
      },
    ],
  },

  /* ─── Stereo width / Space ─── */
  {
    words: ['простор', 'шир', 'стерео', 'width', 'space', 'wide', 'stereo', 'объем'],
    changes: [
      {
        descriptionKey: 'intent.width',
        apply(_strip, bus, ctx) {
          ctx.setBusFx(bus.id, { width: 140 })
          return ['Bus width 140%']
        },
      },
    ],
  },

  /* ─── Master / final polish ─── */
  {
    words: ['master', 'финал', 'polish', 'мастер', 'выход'],
    changes: [
      {
        descriptionKey: 'intent.limiter',
        apply(_strip, bus, ctx) {
          ctx.setBusFx(bus.id, { limiter: { ...bus.fx.limiter, enabled: true, ceiling: -1.5, release: 80 } })
          return ['Bus limiter enabled (ceiling -1.5 dB)']
        },
      },
    ],
  },

  /* ─── Reset ─── */
  {
    words: ['сброс', 'очист', 'reset', 'clear', 'default', 'начальн'],
    changes: [
      {
        descriptionKey: 'intent.reset',
        apply(strip, _bus, ctx) {
          ctx.setStripFx(strip.id, {
            gate: { ...strip.fx.gate, enabled: false, threshold: -48, range: -60, attack: 5, hold: 80, release: 220 },
            compressor: { ...strip.fx.compressor, enabled: false, threshold: -18, ratio: 3, knee: 6, attack: 12, release: 180, makeup: 3 },
            deesser: { ...strip.fx.deesser, enabled: false, frequency: 6500, threshold: -30, amount: 45 },
            saturator: { ...strip.fx.saturator, enabled: false, drive: 22, tone: 0, mix: 30 },
          })
          return ['All FX reset to defaults']
        },
      },
    ],
  },
]

/* ──────────────────── main parser ──────────────────── */

const NEGATIONS = ['не', 'no', 'без', 'without', 'убери', 'remove', 'stop', 'хватит']

/**
 * Parse a natural-language prompt and return matched intents.
 */
export function parseIntent(text: string): ParsedIntent[] {
  const lower = text.toLowerCase().trim()
  if (!lower) return []

  const results: ParsedIntent[] = []

  for (const intent of INTENTS) {
    let matchedWord: string | null = null
    for (const word of intent.words) {
      if (lower.includes(word)) {
        matchedWord = word
        break
      }
    }
    if (!matchedWord) continue

    // Check negation: if a negation word appears within 3 words before the keyword, skip it.
    const wordIndex = lower.indexOf(matchedWord)
    const before = lower.slice(Math.max(0, wordIndex - 30), wordIndex)
    const isNegated = NEGATIONS.some((neg) => before.includes(neg))
    if (isNegated) continue

    results.push({
      keyword: matchedWord,
      changes: intent.changes,
    })
  }

  return results
}

/**
 * Apply parsed intents to the selected strip/bus.
 * Returns a summary string.
 */
export function applyIntents(
  intents: ParsedIntent[],
  strip: Strip,
  bus: Bus,
  ctx: ApplyCtx,
): { summary: string; details: string[] } {
  const details: string[] = []

  for (const intent of intents) {
    for (const change of intent.changes) {
      const changed = change.apply(strip, bus, ctx)
      details.push(...changed)
    }
  }

  const summary =
    details.length > 0
      ? t('intent.applied', { count: details.length, list: details.join('; ') })
      : t('intent.nothing')

  return { summary, details }
}
