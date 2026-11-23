import { useState } from 'react'
import { Camera, Download, Trash2, Upload } from 'lucide-react'
import { useMixer } from '../../store/useMixer'
import { useUi } from '../../store/useUi'
import { captureSnapshot, applySnapshot, loadScenes, saveScenes, deleteScene, type SceneSnapshot } from '../../lib/sceneSnapshot'
import { useT, useLocale } from '../../i18n'

export function ScenePanel() {
  const t = useT()
  const locale = useLocale()
  const setStrip = useMixer((s) => s.setStrip)
  const setStripFx = useMixer((s) => s.setStripFx)
  const setStripEqBand = useMixer((s) => s.setStripEqBand)
  const setBus = useMixer((s) => s.setBus)
  const setBusFx = useMixer((s) => s.setBusFx)
  const setBusEqBand = useMixer((s) => s.setBusEqBand)
  const setRoute = useMixer((s) => s.setRoute)
  const toggleRoute = useMixer((s) => s.toggleRoute)
  const setMasterEqBand = useMixer((s) => s.setMasterEqBand)
  const setMasterEqEnabled = useMixer((s) => s.setMasterEqEnabled)
  const setMasterGainDb = useMixer((s) => s.setMasterGainDb)
  const setVcaGroups = useMixer((s) => s.setVcaGroups)
  const notify = useUi((s) => s.notify)

  const [scenes, setScenes] = useState<SceneSnapshot[]>(() => loadScenes())
  const [name, setName] = useState('')

  const handleCapture = () => {
    const n = name.trim() || `Scene ${scenes.length + 1}`
    const state = useMixer.getState()
    const snap = captureSnapshot(n, state)
    const updated = [...scenes, snap]
    setScenes(updated)
    saveScenes(updated)
    setName('')
    notify(t('scene.saved', { name: n }))
  }

  const handleApply = (snap: SceneSnapshot) => {
    const details = applySnapshot(snap, {
      setStrip: setStrip as never,
      setStripFx: setStripFx as never,
      setStripEqBand: setStripEqBand as never,
      setBus: setBus as never,
      setBusFx: setBusFx as never,
      setBusEqBand: setBusEqBand as never,
      setRoute: setRoute as never,
      toggleRoute: toggleRoute as never,
      setMasterEqBand: setMasterEqBand as never,
      setMasterEqEnabled: setMasterEqEnabled as never,
      setMasterGainDb: setMasterGainDb as never,
      setVcaGroups: setVcaGroups as never,
    })
    notify(t('scene.loaded', { name: snap.name, count: details.length }))
  }

  const handleExport = (snap: SceneSnapshot) => {
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nexus-scene-${snap.name.replace(/[^a-zA-Zа-яА-Я0-9-_]/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
    notify(t('scene.exported', { name: snap.name }))
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const snap = JSON.parse(text) as SceneSnapshot
        if (!snap.strips || !snap.buses) throw new Error('Invalid format')
        const updated = [...scenes, snap]
        setScenes(updated)
        saveScenes(updated)
        notify(t('scene.imported', { name: snap.name }))
      } catch {
        notify(t('scene.badFile'))
      }
    }
    input.click()
  }

  const handleDelete = (id: string) => {
    const updated = deleteScene(scenes, id)
    setScenes(updated)
    saveScenes(updated)
  }

  return (
    <section className="fx-block" style={{ marginTop: 0 }}>
      <header className="fx-block-head">
        <span className="fx-icon">
          <Camera size={13} />
        </span>
        <span className="fx-title">{t('scene.title')}</span>
        <span className="fx-sub">{t('scene.count', { n: scenes.length })}</span>
      </header>
      <div className="fx-block-body">
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            className="text-input"
            style={{ flex: 1, height: 28, fontSize: 11 }}
            placeholder={t('scene.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCapture() }}
          />
          <button type="button" className="btn primary small" onClick={handleCapture} disabled={!name.trim() && scenes.length < 99}>
            <Camera size={12} /> {t('scene.capture')}
          </button>
          <button type="button" className="btn small" onClick={handleImport} title={t('scene.importTip')}>
            <Upload size={12} />
          </button>
        </div>

        {scenes.length === 0 ? (
          <div className="empty">{t('scene.empty')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {[...scenes].reverse().map((snap) => (
              <div
                key={snap.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 6px',
                  borderRadius: 6,
                  border: '1px solid var(--stroke-soft)',
                  background: 'var(--panel-inset)',
                }}
              >
                <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {snap.name}
                </span>
                <span style={{ fontSize: 8, color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(snap.savedAt).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
                <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => handleApply(snap)} title={t('scene.load')}>
                  <Download size={11} />
                </button>
                <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => handleExport(snap)} title={t('scene.export')}>
                  <Upload size={11} />
                </button>
                <button type="button" className="icon-btn" style={{ width: 22, height: 22, color: 'var(--bad)' }} onClick={() => handleDelete(snap.id)} title={t('scene.delete')}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
