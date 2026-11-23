import { chrome } from './ru/chrome'
import { guide } from './ru/guide'
import { data } from './ru/data'
import { settings } from './ru/settings'
import { consoleUi } from './ru/console'
import { rack } from './ru/rack'
import { misc } from './ru/misc'

export const ru = {
  ...chrome,
  ...guide,
  ...data,
  ...settings,
  ...consoleUi,
  ...rack,
  ...misc,
}

export type TKey = keyof typeof ru
