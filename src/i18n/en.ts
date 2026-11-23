import type { TKey } from './ru'
import { chrome } from './en/chrome'
import { guide } from './en/guide'
import { data } from './en/data'
import { settings } from './en/settings'
import { consoleUi } from './en/console'
import { rack } from './en/rack'
import { misc } from './en/misc'

export const en: Record<TKey, string> = {
  ...chrome,
  ...guide,
  ...data,
  ...settings,
  ...consoleUi,
  ...rack,
  ...misc,
}
