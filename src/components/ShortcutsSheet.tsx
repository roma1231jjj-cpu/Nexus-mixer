import { Keyboard, X } from 'lucide-react'
import { useT, type TKey } from '../i18n'

const SHORTCUTS: { keys: string; desc: TKey }[] = [
  { keys: 'F1', desc: 'shortcuts.f1' },
  { keys: 'Esc', desc: 'shortcuts.esc' },
  { keys: 'Ctrl+K', desc: 'shortcuts.ctrlK' },
  { keys: 'Ctrl+S', desc: 'shortcuts.ctrlS' },
  { keys: 'Ctrl+Z', desc: 'shortcuts.ctrlZ' },
  { keys: 'Ctrl+Shift+Z', desc: 'shortcuts.ctrlShiftZ' },
  { keys: '↑ / ↓', desc: 'shortcuts.arrows' },
  { keys: 'Double-click', desc: 'shortcuts.dbl' },
  { keys: 'C', desc: 'shortcuts.c' },
  { keys: 'R', desc: 'shortcuts.r' },
]

interface ShortcutsSheetProps {
  open: boolean
  onClose: () => void
}

export function ShortcutsSheet({ open, onClose }: ShortcutsSheetProps) {
  const t = useT()
  if (!open) return null

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div
        className="drawer"
        style={{
          width: 'min(380px, calc(100vw - 20px))',
          maxHeight: 'min(500px, calc(100vh - 40px))',
        }}
      >
        <header className="drawer-head">
          <Keyboard size={15} className="accent" />
          <h2>{t('shortcuts.title')}</h2>
          <button type="button" className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="drawer-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SHORTCUTS.map((sc) => (
              <div
                key={sc.keys}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '5px 8px',
                  borderRadius: 6,
                  background: 'var(--panel-inset)',
                  border: '1px solid var(--stroke-soft)',
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t(sc.desc)}</span>
                <kbd>{sc.keys}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

export default ShortcutsSheet
