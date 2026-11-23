import { create } from 'zustand'

export type Lang = 'ru' | 'en'

export const LANG_STORAGE_KEY = 'nm-lang'

export const readStoredLang = (): Lang => {
  try {
    const raw = localStorage.getItem(LANG_STORAGE_KEY)
    if (raw === 'en' || raw === 'ru') return raw
  } catch {
    /* storage may be unavailable */
  }
  return 'ru'
}

const applyDocumentLang = (lang: Lang) => {
  try {
    document.documentElement.lang = lang
    document.documentElement.dataset.lang = lang
  } catch {
    /* ignore */
  }
}

interface LangState {
  lang: Lang
  setLang: (lang: Lang) => void
  toggleLang: () => void
}

export const useLang = create<LangState>((set, get) => ({
  lang: readStoredLang(),
  setLang: (lang) => {
    if (get().lang === lang) return
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang)
    } catch {
      /* storage may be unavailable */
    }
    applyDocumentLang(lang)
    set({ lang })
  },
  toggleLang: () => get().setLang(get().lang === 'ru' ? 'en' : 'ru'),
}))

applyDocumentLang(useLang.getState().lang)
