import { ru, type TKey } from './ru'
import { en } from './en'
import { useLang, type Lang } from './lang'

export type { TKey }
export type TVars = Record<string, string | number>

export const dictionaries: Record<Lang, Record<TKey, string>> = { ru, en }

export const LOCALES: Record<Lang, string> = { ru: 'ru-RU', en: 'en-US' }

export const getLang = (): Lang => useLang.getState().lang

export const locale = (lang: Lang = getLang()): string => LOCALES[lang]

const interpolate = (value: string, vars?: TVars): string => {
  if (!vars) return value
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

export const translate = (lang: Lang, key: TKey, vars?: TVars): string =>
  interpolate(dictionaries[lang][key] ?? ru[key] ?? String(key), vars)

export const t = (key: TKey, vars?: TVars): string => translate(getLang(), key, vars)

export const useT = (): ((key: TKey, vars?: TVars) => string) => {
  const lang = useLang((s) => s.lang)
  return (key, vars) => translate(lang, key, vars)
}

export const useLocale = (): string => LOCALES[useLang((s) => s.lang)]

export { useLang }
export type { Lang }
