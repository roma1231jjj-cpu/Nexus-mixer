import type { CSSProperties } from 'react'

type Variant = 'dock' | 'drawer' | 'dialog' | 'matrix'

const bar = (height: number): CSSProperties => ({
  height,
  borderRadius: 'var(--radius-md)',
  background: 'var(--panel-inset)',
  border: '1px solid var(--stroke-soft)',
})

export function PanelSkeleton({ variant = 'dock' }: { variant?: Variant }) {
  if (variant === 'drawer') return <div className="drawer-backdrop" style={{ animation: 'none' }} aria-hidden="true" />
  if (variant === 'dialog') return <div className="dialog-backdrop" style={{ animation: 'none' }} aria-hidden="true" />
  if (variant === 'matrix') return <div className="matrix-overlay" style={{ animation: 'none' }} aria-hidden="true" />

  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0', minHeight: 260 }}
    >
      <div style={bar(30)} />
      <div style={bar(96)} />
      <div style={bar(30)} />
      <div style={bar(56)} />
    </div>
  )
}

export default PanelSkeleton
