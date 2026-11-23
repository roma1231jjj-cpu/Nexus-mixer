import { useMixer } from '../store/useMixer'
import { dictionaries, translate } from './index'
import type { Lang } from './lang'
import type { TKey } from './ru'

const DATA_KEYS = (Object.keys(dictionaries.ru) as TKey[]).filter((key) => key.startsWith('data.'))

const VALUE_TO_KEY = (() => {
  const map = new Map<string, TKey>()
  for (const dict of Object.values(dictionaries)) {
    for (const key of DATA_KEYS) {
      const value = dict[key]
      if (value && !map.has(value)) map.set(value, key)
    }
  }
  return map
})()

export const localizeDataValue = (value: string, lang: Lang): string => {
  const key = VALUE_TO_KEY.get(value)
  return key ? translate(lang, key, undefined) : value
}

export const syncLocalizedDefaults = (lang: Lang) => {
  const localize = (value: string) => localizeDataValue(value, lang)
  useMixer.setState((state) => {
    const strips = Object.fromEntries(
      Object.entries(state.strips).map(([id, strip]) => [id, { ...strip, name: localize(strip.name) }]),
    ) as typeof state.strips
    const buses = Object.fromEntries(
      Object.entries(state.buses).map(([id, bus]) => [id, { ...bus, name: localize(bus.name) }]),
    ) as typeof state.buses
    return {
      strips,
      buses,
      presets: state.presets.map((preset) => ({
        ...preset,
        name: localize(preset.name),
        description: localize(preset.description),
      })),
      aiModels: state.aiModels.map((model) => ({ ...model, author: localize(model.author) })),
      status: {
        ...state.status,
        driver: { ...state.status.driver, message: localize(state.status.driver.message) },
        ai: { ...state.status.ai, message: localize(state.status.ai.message) },
      },
    }
  })
}
