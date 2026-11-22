import { useEffect, useState } from 'react'
import { useMixer } from '../store/useMixer'
import { useUi } from '../store/useUi'

type Placement = 'top' | 'bottom'

interface Tip {
  text: string
  x: number
  y: number
  placement: Placement
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const guideOpen = useUi((s) => s.guideOpen)
  const settingsOpen = useMixer((s) => s.settingsOpen)

  useEffect(() => {
    setTip(null)
  }, [guideOpen, settingsOpen])

  useEffect(() => {
    let timer: number | undefined

    const clear = () => {
      window.clearTimeout(timer)
      setTip(null)
    }

    const show = (target: Element) => {
      if (useUi.getState().guideOpen || useMixer.getState().settingsOpen) return
      const text = target.getAttribute('data-tip')
      if (!text) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const rect = target.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        const placement: Placement =
          target.getAttribute('data-tip-pos') === 'bottom' || rect.top < 72 ? 'bottom' : 'top'
        setTip({
          text,
          x: Math.min(Math.max(rect.left + rect.width / 2, 130), window.innerWidth - 130),
          y: placement === 'top' ? rect.top - 9 : rect.bottom + 9,
          placement,
        })
      }, 180)
    }

    const findTarget = (node: EventTarget | null): Element | null => {
      if (!(node instanceof Element)) return null
      return node.closest('[data-tip]')
    }

    const onOver = (event: MouseEvent) => {
      const target = findTarget(event.target)
      if (target) show(target)
    }

    const onOut = (event: MouseEvent) => {
      const target = findTarget(event.target)
      if (!target) return
      const related = event.relatedTarget
      if (related instanceof Node && target.contains(related)) return
      clear()
    }

    const onFocus = (event: FocusEvent) => {
      const target = findTarget(event.target)
      if (target) show(target)
    }

    const onScroll = () => clear()

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', clear)
    document.addEventListener('pointerdown', clear)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', clear)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', clear)
      document.removeEventListener('pointerdown', clear)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', clear)
    }
  }, [])

  if (!tip) return null

  return (
    <div className={`app-tooltip ${tip.placement}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  )
}
