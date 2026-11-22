import type { MeterRefs } from '../../audio/useMeter'

/** Two vertical meters fed by `useMeter` refs. */
export function StereoMeter({ meter }: { meter: MeterRefs }) {
  return (
    <div className="meter-pair" aria-hidden="true">
      <div className="meter">
        <span className="meter-fill" ref={meter.left} style={{ height: '0%' }} />
        <span className="meter-peak" ref={meter.peakLeft} style={{ bottom: '0%' }} />
      </div>
      <div className="meter">
        <span className="meter-fill" ref={meter.right} style={{ height: '0%' }} />
        <span className="meter-peak" ref={meter.peakRight} style={{ bottom: '0%' }} />
      </div>
    </div>
  )
}

/** Horizontal stereo meter for bus cards. */
export function BusMeter({
  left,
  right,
}: {
  left: React.RefObject<HTMLSpanElement | null>
  right: React.RefObject<HTMLSpanElement | null>
}) {
  return (
    <div className="bus-meter" aria-hidden="true">
      <span ref={left} style={{ transform: 'scaleX(0)' }} />
      <span ref={right} style={{ transform: 'scaleX(0)' }} />
    </div>
  )
}

/** Narrow vertical meter used beside a bus fader. */
export function BusMeterV({ meter }: { meter: MeterRefs }) {
  return (
    <div className="bus-meter-v" aria-hidden="true">
      <div className="bus-meter-track">
        <span ref={meter.left} />
        <i ref={meter.peakLeft} />
      </div>
      <div className="bus-meter-track">
        <span ref={meter.right} />
        <i ref={meter.peakRight} />
      </div>
    </div>
  )
}
