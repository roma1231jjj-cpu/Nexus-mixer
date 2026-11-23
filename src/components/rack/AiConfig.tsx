import { useState, type KeyboardEvent } from 'react'
import { RotateCcw, Sparkles, Wand2 } from 'lucide-react'
import type { EqBand } from '../../types'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { parseIntent, applyIntents, type ParsedIntent } from '../../lib/intentParser'
import { useT } from '../../i18n'

export function AiConfig() {
  const t = useT()
  const strip = useMixer((s) => s.strips[s.selectedStripId])
  const bus = useMixer((s) => s.buses[s.selectedBusId])
  const selectionKind = useMixer((s) => s.selectionKind)
  const setStrip = useMixer((s) => s.setStrip)
  const setStripFx = useMixer((s) => s.setStripFx)
  const setStripEqBand = useMixer((s) => s.setStripEqBand)
  const setBus = useMixer((s) => s.setBus)
  const setBusFx = useMixer((s) => s.setBusFx)
  const setBusEqBand = useMixer((s) => s.setBusEqBand)
  const notify = useUi((s) => s.notify)

  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ParsedIntent[] | null>(null)
  const [appliedSummary, setAppliedSummary] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const target = selectionKind === 'strip' ? strip : bus

  const findDisabledStripBand = (stripId: string): string | null => {
    const state = useMixer.getState()
    const s = state.strips[stripId as keyof typeof state.strips]
    if (!s) return null
    const band = (s as unknown as { fx: { eq: { id: string; enabled: boolean }[] } }).fx.eq.find((b) => !b.enabled)
    return band?.id ?? null
  }

  const findDisabledBusBand = (busId: string): string | null => {
    const state = useMixer.getState()
    const b = state.buses[busId as keyof typeof state.buses]
    if (!b) return null
    const band = (b as unknown as { fx: { eq: { id: string; enabled: boolean }[] } }).fx.eq.find((band) => !band.enabled)
    return band?.id ?? null
  }

  const handleAnalyze = () => {
    if (!text.trim()) return
    const intents = parseIntent(text)
    setParsed(intents)
    setAppliedSummary(null)
  }

  const handleApply = () => {
    if (!parsed || parsed.length === 0) return
    setBusy(true)

    const ctx = {
      setStrip: (id: string, patch: Record<string, unknown>) =>
        setStrip(id as Parameters<typeof setStrip>[0], patch as Parameters<typeof setStrip>[1]),
      setStripFx: (id: string, patch: Record<string, unknown>) =>
        setStripFx(id as Parameters<typeof setStripFx>[0], patch as Parameters<typeof setStripFx>[1]),
      setStripEqBand: (id: string, bandId: string, patch: Partial<EqBand>) =>
        setStripEqBand(id as Parameters<typeof setStripEqBand>[0], bandId, patch),
      setBusFx: (id: string, patch: Record<string, unknown>) =>
        setBusFx(id as Parameters<typeof setBusFx>[0], patch as Parameters<typeof setBusFx>[1]),
      setBusEqBand: (id: string, bandId: string, patch: Partial<EqBand>) =>
        setBusEqBand(id as Parameters<typeof setBusEqBand>[0], bandId, patch),
      setBus: (id: string, patch: Record<string, unknown>) =>
        setBus(id as Parameters<typeof setBus>[0], patch as Parameters<typeof setBus>[1]),
      findDisabledStripBand,
      findDisabledBusBand,
      notify,
    }

    const result = applyIntents(parsed, strip, bus, ctx)
    setAppliedSummary(result.summary)
    notify(result.summary)
    setBusy(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleAnalyze()
    }
  }

  const handleReset = () => {
    setText('')
    setParsed(null)
    setAppliedSummary(null)
  }

  return (
    <section className="fx-block" style={{ marginTop: 0 }}>
      <header className="fx-block-head">
        <span className="fx-icon">
          <Wand2 size={13} />
        </span>
        <span className="fx-title">{t('cfg.title')}</span>
        <span className="fx-sub">{target?.name ?? '—'}</span>
      </header>
      <div className="fx-block-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="text-input"
            style={{
              minHeight: 60,
              resize: 'vertical',
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: 'var(--font-ui)',
            }}
            placeholder={selectionKind === 'strip' ? t('cfg.placeholder') : t('cfg.placeholderBus')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn"
              disabled={!text.trim()}
              onClick={handleAnalyze}
              style={{ flex: 1 }}
            >
              <Wand2 size={13} /> {t('cfg.analyze')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!parsed || parsed.length === 0 || busy}
              onClick={handleApply}
              style={{ flex: 1 }}
            >
              <Sparkles size={13} /> {busy ? '…' : t('cfg.apply')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!text && !parsed}
              onClick={handleReset}
              title={t('cfg.clear')}
            >
              <RotateCcw size={13} />
            </button>
          </div>

          {/* Parsed intents */}
          {parsed && parsed.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div className="fx-section-divider">{t('cfg.recognized')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {parsed.map((intent, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 6,
                      padding: '5px 8px',
                      borderRadius: 6,
                      background: 'var(--accent-soft)',
                      border: '1px solid var(--stroke)',
                    }}
                  >
                    <Sparkles size={11} style={{ marginTop: 2, color: 'var(--accent-bright)', flex: '0 0 auto' }} />
                    <div>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
                        «{intent.keyword}»
                      </div>
                      {intent.changes.map((change, j) => (
                        <div key={j} style={{ fontSize: 10, color: 'var(--muted)', paddingLeft: 4 }}>
                          {t(change.descriptionKey)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No intents found */}
          {parsed && parsed.length === 0 && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
                background: 'color-mix(in srgb, var(--warn) 8%, transparent)',
                color: 'var(--warn)',
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              {t('cfg.nothing')}
            </div>
          )}

          {/* Applied summary */}
          {appliedSummary && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid color-mix(in srgb, var(--good) 35%, transparent)',
                background: 'color-mix(in srgb, var(--good) 8%, transparent)',
                color: 'var(--good)',
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              {appliedSummary}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
