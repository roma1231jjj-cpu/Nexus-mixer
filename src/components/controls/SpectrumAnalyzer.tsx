import {
  useEffect, useRef } from 'react'
import { meterTarget } from '../../audio/meterBus'
import { t } from '../../i18n'

interface SpectrumAnalyzerProps {
  /** Width of the canvas. */
  width?: number
  /** Height of the canvas. */
  height?: number
  /** Whether the analyzer is active. */
  active?: boolean
  /** Bar count. */
  barCount?: number
  /** Accent color for the bars. */
  color?: string
  /** Meter source used to estimate the overall energy. */
  source?: { kind: 'strip' | 'bus'; index: number }
}

/**
 * Lightweight spectrum display.
 *
 * The Rust engine exposes peak levels, not FFT frames, so the view draws a
 * stable, voice-shaped spectral silhouette whose energy follows the live meter
 * (or an idle animation in the browser demo). It never creates an AudioContext
 * and therefore cannot interfere with the audio engine or autoplay policy.
 */
export function SpectrumAnalyzer({
  width = 200,
  height = 60,
  active = true,
  barCount = 48,
  color = '#a855f7',
  source = { kind: 'bus', index: 0 },
}: SpectrumAnalyzerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    let smooth = 0
    const data = new Float32Array(barCount)
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    // Canvas cannot parse `var(--token)`; resolve it against the document.
    const resolveColor = (value: string): string => {
      const match = value.match(/^var\((--[\w-]+)\)$/)
      if (!match) return value
      const token = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim()
      return token || '#7c6cff'
    }
    const barColor = resolveColor(color)

    // Stable pseudo-random tilt so the bars look like a real spectrum rather
    // than a single sine wave.
    const seeds = Array.from({ length: barCount }, (_, i) => {
      const t = i / barCount
      const tilt = Math.pow(1 - t, 1.35)
      return { tilt, wobble: Math.sin(i * 1.91) * 0.5 + Math.sin(i * 0.73) * 0.5 }
    })

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = now / 1000
      const live = active ? meterTarget(source) : 0
      const target = active
        ? live === null || live === 0
          ? 0.18 + 0.06 * Math.sin(t * 1.4)
          : Math.max(0.08, live)
        : 0
      smooth += (target - smooth) * 0.12

      ctx.clearRect(0, 0, width, height)

      const gap = 1.5
      const barWidth = (width - gap * (barCount - 1)) / barCount
      for (let i = 0; i < barCount; i++) {
        const seed = seeds[i]
        const wobble = 0.72 + 0.28 * Math.sin(t * (2.2 + i * 0.07) + seed.wobble * 4.2)
        const level = Math.max(0, (smooth * 1.15 * seed.tilt + 0.012) * wobble)
        const value = data[i] + (Math.min(1, level) - data[i]) * 0.28
        data[i] = value
        const barHeight = Math.max(1, value * (height - 4))
        const x = i * (barWidth + gap)
        const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight)
        gradient.addColorStop(0, barColor)
        gradient.addColorStop(0.72, barColor)
        gradient.addColorStop(1, 'rgba(255,255,255,0.75)')
        ctx.globalAlpha = 0.28 + value * 0.72
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.roundRect(x, height - barHeight, barWidth, barHeight, 1.5)
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [width, height, active, barCount, color, source.kind, source.index])

  return (
    <canvas
      ref={canvasRef}
      className="spectrum-canvas"
      style={{ width, height }}
      aria-label={t('spectrum.aria')}
    />
  )
}
