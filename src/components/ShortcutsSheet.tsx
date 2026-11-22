import { Keyboard, X } from 'lucide-react'

const SHORTCUTS = [
  { keys: 'F1', desc: 'Открыть инструкцию' },
  { keys: 'Esc', desc: 'Закрыть настройки / панели' },
  { keys: 'Ctrl+K', desc: 'Показать этот список' },
  { keys: 'Ctrl+S', desc: 'Сохранить пресет выбранного канала' },
  { keys: 'Ctrl+Z', desc: 'Отменить последнее изменение FX' },
  { keys: 'Ctrl+Shift+Z', desc: 'Повторить отменённое изменение FX' },
  { keys: '↑ / ↓', desc: 'Изменить значение крутилки (с фокусом)' },
  { keys: 'Double-click', desc: 'Сбросить крутилку/фейдер по умолчанию' },
  { keys: 'C', desc: 'Показать/скрыть матрицу маршрутизации' },
  { keys: 'R', desc: 'Открыть панель Voice' },
]

interface ShortcutsSheetProps {
  open: boolean
  onClose: () => void
}

export function ShortcutsSheet({ open, onClose }: ShortcutsSheetProps) {
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
          <h2>Горячие клавиши</h2>
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
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{sc.desc}</span>
                <kbd>{sc.keys}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
