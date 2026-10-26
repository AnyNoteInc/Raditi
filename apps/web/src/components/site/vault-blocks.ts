import type { SiteBlock } from './site-block-nav'
import { accessLabel } from './site-format'

/** The blocks of «Переменные», each a page beside the menu (owner's request of 26.10.2026). */
export const VARIABLES_BLOCK = 'variables'
export const ACCESSES_BLOCK = 'accesses'

/**
 * The menu of «Переменные»: the variables, and which accesses are saved. `accesses` — null when
 * they could not be read.
 */
export function vaultBlocks(accesses: readonly { kind: string }[] | null): SiteBlock[] {
  const kinds =
    accesses === null ? [] : [...new Set(accesses.map((access) => accessLabel(access.kind)))]
  return [
    {
      segment: VARIABLES_BLOCK,
      title: 'Переменные окружения',
      icon: 'terminal',
      note: 'Ключи и адреса сервисов',
    },
    {
      segment: ACCESSES_BLOCK,
      title: 'Доступы',
      icon: 'lock',
      note:
        accesses === null
          ? 'Не удалось загрузить'
          : kinds.length === 0
            ? 'Доступов пока нет'
            : kinds.join(' · '),
    },
  ]
}
