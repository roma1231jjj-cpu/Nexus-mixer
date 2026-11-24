import { useCallback, useEffect, useRef } from 'react'
import { Mic, Music2, Globe, Monitor, Gamepad2, AudioLines } from 'lucide-react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'
import { STRIP_ORDER } from '../data/defaults'
import { useMeter } from '../audio/useMeter'
import { FADER_MAX, FADER_MIN, dbLabel, panLabel } from '../lib/format'
import type { StripId } from '../types'
import { StereoMeter } from './controls/StereoMeter'
import { DeviceSelect } from './controls/DeviceSelect'
import { StripRouting } from './StripRouting'
import { useT } from '../i18n'

const ICONS: Record<StripId, typeof Mic> = {
  hw1: Mic,
  hw2: Music2,
  hw3: Globe,
  hw4: AudioLines,
  hw5: AudioLines,
  hw6: AudioLines,
  vaio: Monitor,
  aux: Gamepad2,
}

const SCALE = [12, 0, -12, -24, -36, -48, -60]

const scalePos = (value: number) => ((FADER_MAX - value) / (FADER_MAX - FADER_MIN)) * 100

export function Strip({ id }: { id: StripId }) {
  const t = useT()
  const strip = useMixer((s) => s.strips[id])
  const selected = useMixer((s) => s.selectionKind === 'strip' && s.selectedStripId === id)
  const multiSelected = useMixer((s) => s.multiSelectedStripIds.includes(id))
  const setStrip = useMixer((s) => s.setStrip)
  const selectStrip = useMixer((s) => s.selectStrip)
  const openRack = useUi((s) => s.openRack)
  const devices = useMixer((s) => s.devices)
  const sourceCount = useMixer((s) => s.sourceCount)
  const sliderRef = useRef<HTMLInputElement>(null)
  const gainRef = useRef(strip.gainDb)
  gainRef.current = strip.gainDb

  useEffect(() => {
    const el = sliderRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const delta = event.deltaY < 0 ? 0.5 : -0.5
      const next = Math.min(FADER_MAX, Math.max(FADER_MIN, Math.round((gainRef.current + delta) * 10) / 10))
      if (next !== gainRef.current) setStrip(id, { gainDb: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [id, setStrip])

  const handleStripClick = useCallback((e: React.MouseEvent) => {
    const visible = STRIP_ORDER.slice(0, sourceCount)
    if (!visible.includes(id)) return
    if (e.ctrlKey || e.metaKey) {
      const current = useMixer.getState().multiSelectedStripIds
      if (current.includes(id)) {
        useMixer.getState().setMultiSelectedStripIds(current.filter((sid) => sid !== id))
      } else {
        useMixer.getState().setMultiSelectedStripIds([...current.filter((sid) => visible.includes(sid)), id])
      }
      e.stopPropagation()
    } else if (e.shiftKey && useMixer.getState().multiSelectedStripIds.length > 0) {
      const currentSelected = useMixer.getState().multiSelectedStripIds
      const lastSelected = currentSelected[currentSelected.length - 1]
      const lastIdx = visible.indexOf(lastSelected)
      const thisIdx = visible.indexOf(id)
      if (lastIdx < 0 || thisIdx < 0) {
        useMixer.getState().setMultiSelectedStripIds([id])
        e.stopPropagation()
        return
      }
      const from = Math.min(lastIdx, thisIdx)
      const to = Math.max(lastIdx, thisIdx)
      useMixer.getState().setMultiSelectedStripIds(visible.slice(from, to + 1))
      e.stopPropagation()
    } else {
      useMixer.getState().clearMultiSelection()
      selectStrip(id)
    }
  }, [id, selectStrip, sourceCount])

  const index = STRIP_ORDER.indexOf(id)
  // Show the input meter even while muted: it is a gain-staging aid, and a
  // dead-looking strip when mute is on feels like a broken fader.
  const meter = useMeter(Boolean(strip.deviceId), index + 1, 'vertical', { kind: 'strip', index })
  const chain = [
    strip.fx.gate.enabled ? 'GATE' : null,
    strip.fx.compressor.enabled ? 'COMP' : null,
    strip.fx.eq.some((band) => band.enabled) ? 'EQ' : null,
    strip.fx.deesser.enabled ? 'DE-ESS' : null,
    strip.fx.saturator.enabled ? 'SAT' : null,
  ].filter((item): item is string => Boolean(item))

  const Icon = ICONS[id]
  const nameLocked = id === 'hw1'
  const nameBeforeEdit = useRef(strip.name)
  const cancelNameEdit = useRef(false)

  const selectAndFx = () => {
    selectStrip(id)
    openRack('fx')
  }

  return (
    <article
      className={`strip${selected ? ' selected' : ''}${multiSelected ? ' multi-selected' : ''}`}
      style={{ '--strip-color': strip.color } as React.CSSProperties}
      onClick={handleStripClick}
      aria-label={t('strip.aria', { name: strip.name })}
      aria-selected={selected}
    >
      <header className="strip-head">
        <Icon size={13} className="strip-icon" strokeWidth={1.8} />
        {nameLocked ? (
          <span className="strip-name static" data-tip={t('strip.nameLockedTip')}>
            {strip.name}
          </span>
        ) : (
          <input
            className="strip-name"
            value={strip.name}
            aria-label={t('strip.nameAria')}
            spellCheck={false}
            maxLength={24}
            onChange={(event) => setStrip(id, { name: event.target.value })}
            onFocus={() => {
              nameBeforeEdit.current = strip.name
              selectStrip(id)
            }}
            onBlur={(event) => {
              if (cancelNameEdit.current) {
                cancelNameEdit.current = false
                return
              }
              setStrip(id, { name: event.target.value.trim() || t('strip.defaultName') })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelNameEdit.current = true
                setStrip(id, { name: nameBeforeEdit.current })
                event.currentTarget.blur()
              }
            }}
          />
        )}
        <span className="strip-level" data-tip={t('strip.gainTip')}>{dbLabel(strip.gainDb)}</span>
      </header>

      <div className="strip-body">
        <div className="strip-meters">
          <StereoMeter meter={meter} />
        </div>

        <div className="strip-fader">
          <div className="strip-scale" aria-hidden="true">
            {SCALE.map((value) => (
              <span key={value} style={{ top: `${scalePos(value)}%` }}>{value > 0 ? `+${value}` : value}</span>
            ))}
          </div>
          <div className="strip-track">
            <input type="range" className="strip-slider" ref={sliderRef} min={FADER_MIN} max={FADER_MAX} step={0.5}
              value={strip.gainDb} data-tip={t('strip.volumeTip', { level: dbLabel(strip.gainDb) })}
              onChange={(e) => setStrip(id, { gainDb: parseFloat(e.target.value) })} />
          </div>
        </div>

        <div className="strip-rail">
          <StripRouting id={id} />
        </div>
      </div>

      <div className="strip-foot">
        <div className="strip-pan" data-tip={t('strip.panTip', { value: panLabel(strip.pan) })}>
          <span className="strip-pan-caption">PAN</span>
          <input type="range" className="pan-slider" min={-1} max={1} step={0.01}
            value={strip.pan} aria-label={t('strip.panAria')}
            onChange={(e) => setStrip(id, { pan: parseFloat(e.target.value) })}
            onDoubleClick={() => setStrip(id, { pan: 0 })} />
          <span className={`strip-pan-value${strip.pan < -0.005 ? ' L' : strip.pan > 0.005 ? ' R' : ' C'}`}>
            {panLabel(strip.pan)}
          </span>
        </div>

        <div className="strip-fx-flags" data-tip={chain.length ? t('strip.chainTip', { chain: chain.join(', ') }) : t('strip.noChain')}>
          {chain.length > 0 ? <span>FX {chain.length}</span> : null}
        </div>
      </div>

      <div className="strip-device-row">
        <DeviceSelect
          value={strip.deviceId}
          devices={devices}
          kinds={['input', 'virtual-capture']}
          onChange={(deviceId) => setStrip(id, { deviceId })}
          ariaLabel={t('strip.inputDevice', { name: strip.name })}
          emptyLabel={t('strip.noInput')}
          tone="input"
        />
      </div>

      <div className="strip-actions">
        <button type="button" className={`mini-toggle mute${strip.mute ? ' on' : ''}`}
          aria-pressed={strip.mute} data-tip={t('strip.muteTip')}
          onClick={(e) => { e.stopPropagation(); setStrip(id, { mute: !strip.mute }) }}>M</button>
        <button type="button" className={`mini-toggle solo${strip.solo ? ' on' : ''}`}
          aria-pressed={strip.solo} data-tip={t('strip.soloTip')}
          onClick={(e) => { e.stopPropagation(); setStrip(id, { solo: !strip.solo }) }}>S</button>
        <button type="button" className={`mini-toggle${strip.mono ? ' on' : ''}`}
          aria-pressed={strip.mono} data-tip={t('strip.monoTip')}
          onClick={(e) => { e.stopPropagation(); setStrip(id, { mono: !strip.mono }) }}>MONO</button>
        <button type="button" className="mini-toggle" data-tip={t('strip.fxTip')}
          onClick={selectAndFx}>FX</button>
      </div>
    </article>
  )
}
