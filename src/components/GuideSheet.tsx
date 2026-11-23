import {
  BookOpen,
  Cable,
  Disc3,
  Keyboard,
  Mic,
  Rocket,
  Route,
  SlidersHorizontal,
  Sparkles,
  Split,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useUi } from '../store/useUi'
import { useT, type TKey } from '../i18n'
import { RichText } from './RichText'

type Block =
  | { k: 'p'; t: TKey; cls?: string }
  | { k: 'ul'; items: TKey[] }
  | { k: 'note'; t: TKey; warn?: boolean }
  | { k: 'grid'; items: { t: TKey; p: TKey }[] }
  | { k: 'flow'; items: TKey[] }
  | { k: 'keys'; items: { k: string; kKey?: TKey; t: TKey }[] }

interface Section {
  id: string
  icon: LucideIcon
  title: TKey
  cls?: string
  blocks: Block[]
}

const TOC: { id: string; label: TKey }[] = [
  { id: 'guide-start', label: 'guide.toc.start' },
  { id: 'guide-flow', label: 'guide.toc.flow' },
  { id: 'guide-apps', label: 'guide.toc.apps' },
  { id: 'guide-buses', label: 'guide.toc.buses' },
  { id: 'guide-strip', label: 'guide.toc.strip' },
  { id: 'guide-fx', label: 'guide.toc.fx' },
  { id: 'guide-extra', label: 'guide.toc.extra' },
  { id: 'guide-fix', label: 'guide.toc.fix' },
  { id: 'guide-keys', label: 'guide.toc.keys' },
]

const SECTIONS: Section[] = [
  {
    id: 'guide-start',
    icon: Rocket,
    title: 'guide.start.title',
    blocks: [
      {
        k: 'ul',
        items: [
          'guide.start.li1',
          'guide.start.li2',
          'guide.start.li3',
          'guide.start.li4',
          'guide.start.li5',
        ],
      },
      { k: 'note', t: 'guide.start.note' },
    ],
  },
  {
    id: 'guide-flow',
    icon: Route,
    title: 'guide.flow.title',
    blocks: [
      {
        k: 'flow',
        items: ['guide.flow.step1', 'guide.flow.step2', 'guide.flow.step3', 'guide.flow.step4'],
      },
      { k: 'p', t: 'guide.flow.p1' },
      { k: 'p', t: 'guide.flow.p2' },
    ],
  },
  {
    id: 'guide-apps',
    icon: Split,
    title: 'guide.apps.title',
    cls: 'guide-key',
    blocks: [
      { k: 'p', t: 'guide.apps.p1' },
      { k: 'p', t: 'guide.apps.p2' },
      {
        k: 'grid',
        items: [
          { t: 'guide.apps.opt1.t', p: 'guide.apps.opt1.p' },
          { t: 'guide.apps.opt2.t', p: 'guide.apps.opt2.p' },
          { t: 'guide.apps.opt3.t', p: 'guide.apps.opt3.p' },
        ],
      },
      { k: 'note', t: 'guide.apps.note', warn: true },
    ],
  },
  {
    id: 'guide-buses',
    icon: Cable,
    title: 'guide.buses.title',
    blocks: [
      { k: 'p', t: 'guide.buses.arch', cls: 'guide-arch-note' },
      {
        k: 'ul',
        items: [
          'guide.buses.li1',
          'guide.buses.li2',
          'guide.buses.li3',
          'guide.buses.li4',
          'guide.buses.li5',
          'guide.buses.li6',
        ],
      },
      { k: 'p', t: 'guide.buses.p1' },
    ],
  },
  {
    id: 'guide-strip',
    icon: SlidersHorizontal,
    title: 'guide.strip.title',
    blocks: [
      {
        k: 'ul',
        items: [
          'guide.strip.li1',
          'guide.strip.li2',
          'guide.strip.li3',
          'guide.strip.li4',
          'guide.strip.li5',
          'guide.strip.li6',
        ],
      },
      { k: 'p', t: 'guide.strip.p1' },
    ],
  },
  {
    id: 'guide-fx',
    icon: Sparkles,
    title: 'guide.fx.title',
    blocks: [
      { k: 'p', t: 'guide.fx.p1' },
      { k: 'p', t: 'guide.fx.p2' },
      { k: 'p', t: 'guide.fx.p3' },
    ],
  },
  {
    id: 'guide-extra',
    icon: Disc3,
    title: 'guide.extra.title',
    blocks: [
      {
        k: 'ul',
        items: ['guide.extra.li1', 'guide.extra.li2', 'guide.extra.li3', 'guide.extra.li4'],
      },
    ],
  },
  {
    id: 'guide-fix',
    icon: Wrench,
    title: 'guide.fix.title',
    blocks: [
      {
        k: 'ul',
        items: [
          'guide.fix.li1',
          'guide.fix.li2',
          'guide.fix.li3',
          'guide.fix.li4',
          'guide.fix.li5',
          'guide.fix.li6',
        ],
      },
    ],
  },
  {
    id: 'guide-keys',
    icon: Keyboard,
    title: 'guide.keys.title',
    blocks: [
      {
        k: 'keys',
        items: [
          { k: 'F1', t: 'guide.keys.f1' },
          { k: 'Ctrl+K', t: 'guide.keys.ctrlK' },
          { k: 'Ctrl+S', t: 'guide.keys.ctrlS' },
          { k: 'Ctrl+Z', t: 'guide.keys.ctrlZ' },
          { k: 'Ctrl+Shift+M', t: 'guide.keys.muteAll' },
          { k: 'C', t: 'guide.keys.c' },
          { k: 'R', t: 'guide.keys.r' },
          { k: 'Esc', t: 'guide.keys.esc' },
          { k: '', kKey: 'guide.keys.dbl', t: 'guide.keys.dblValue' },
        ],
      },
    ],
  },
]

const jump = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function GuideSheet() {
  const t = useT()
  const open = useUi((s) => s.guideOpen)
  const setOpen = useUi((s) => s.setGuideOpen)
  if (!open) return null

  const renderBlock = (block: Block, index: number) => {
    switch (block.k) {
      case 'p':
        return (
          <p key={index} className={block.cls}>
            <RichText text={t(block.t)} />
          </p>
        )
      case 'ul':
        return (
          <ul key={index}>
            {block.items.map((item) => (
              <li key={item}>
                <RichText text={t(item)} />
              </li>
            ))}
          </ul>
        )
      case 'note':
        return (
          <div key={index} className={`guide-note${block.warn ? ' warn' : ''}`}>
            <RichText text={t(block.t)} />
          </div>
        )
      case 'grid':
        return (
          <div key={index} className="guide-grid">
            {block.items.map((item) => (
              <div key={item.t}>
                <b>{t(item.t)}</b>
                <p>
                  <RichText text={t(item.p)} />
                </p>
              </div>
            ))}
          </div>
        )
      case 'flow':
        return (
          <div key={index} className="guide-flow">
            {block.items.map((item, itemIndex) => (
              <FragmentRow key={item} first={itemIndex === 0} text={t(item)} />
            ))}
          </div>
        )
      case 'keys':
        return (
          <div key={index} className="guide-keys">
            {block.items.map((item) => (
              <span key={item.t}>
                <kbd>{item.kKey ? t(item.kKey) : item.k}</kbd> {t(item.t)}
              </span>
            ))}
          </div>
        )
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={() => setOpen(false)} />
      <aside className="guide-sheet glass-strong" role="dialog" aria-modal="true" aria-label={t('guide.aria')}>
        <header className="drawer-head">
          <BookOpen size={16} className="accent" />
          <div>
            <h2>{t('guide.title')}</h2>
            <div className="sub">{t('guide.sub')}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => setOpen(false)}
            aria-label={t('guide.closeAria')}
            data-tip={t('guide.closeTip')}
          >
            <X size={15} />
          </button>
        </header>

        <div className="guide-body">
          <section className="guide-hero">
            <span className="guide-kicker">{t('guide.hero.kicker')}</span>
            <h3>{t('guide.hero.title')}</h3>
            <p>{t('guide.hero.p1')}</p>
            <div className="guide-pills">
              <span>
                <Mic size={12} /> {t('guide.hero.pill.in')}
              </span>
              <span>
                <SlidersHorizontal size={12} /> {t('guide.hero.pill.fx')}
              </span>
              <span>
                <Cable size={12} /> {t('guide.hero.pill.cable')}
              </span>
            </div>
            <button type="button" className="guide-hero-link" onClick={() => jump('guide-apps')}>
              {t('guide.hero.link')}
            </button>
          </section>

          <nav className="guide-toc" aria-label={t('guide.tocAria')}>
            {TOC.map((item) => (
              <button key={item.id} type="button" onClick={() => jump(item.id)}>
                {t(item.label)}
              </button>
            ))}
          </nav>

          {SECTIONS.map((section) => {
            const Icon = section.icon
            return (
              <section key={section.id} id={section.id} className={`guide-section${section.cls ? ` ${section.cls}` : ''}`}>
                <h3>
                  <Icon size={15} /> {t(section.title)}
                </h3>
                {section.blocks.map(renderBlock)}
              </section>
            )
          })}

          <footer className="guide-footer">{t('guide.footer')}</footer>
        </div>
      </aside>
    </>
  )
}

function FragmentRow({ text, first }: { text: string; first: boolean }) {
  return (
    <>
      {first ? null : <i>→</i>}
      <span>{text}</span>
    </>
  )
}
