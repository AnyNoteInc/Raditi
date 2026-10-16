import type { AppIconName } from '@/components/application/app-icon'

export type SettingsNavEntry = {
  href: string
  label: string
  icon: AppIconName
  /** A section is listed once its page exists; until then it is declared but not shown. */
  enabled: boolean
}

/** The sections of `/settings` in sidebar order. */
export const settingsNav: readonly SettingsNavEntry[] = [
  { href: '/settings', label: 'Общее', icon: 'settings', enabled: true },
  { href: '/settings/plans', label: 'Тарифы', icon: 'plans', enabled: true },
  { href: '/settings/billing', label: 'Оплата', icon: 'payment', enabled: true },
  { href: '/settings/usage', label: 'Использование', icon: 'usage', enabled: true },
]

/**
 * The section a path belongs to, listed in the sidebar or not: the longest `href` that equals
 * the path or is followed by `/` in it. So `/settings/billing/return` belongs to «Оплата» and
 * `/settings/billing-x` does not; a path under `/settings` that no other section claims, such
 * as `/settings/billing-x`, belongs to «Общее».
 */
export function settingsEntryFor(
  pathname: string,
  entries: readonly SettingsNavEntry[],
): SettingsNavEntry | undefined {
  let match: SettingsNavEntry | undefined
  for (const entry of entries) {
    if (pathname !== entry.href && !pathname.startsWith(`${entry.href}/`)) continue
    if (!match || entry.href.length > match.href.length) match = entry
  }
  return match
}

/**
 * The section to light in the sidebar: the one the path belongs to, unless it is switched off.
 * Then nothing is lit, not even «Общее»: the page is not one of its own.
 */
export function activeSettingsEntry(
  pathname: string,
  entries: readonly SettingsNavEntry[],
): SettingsNavEntry | undefined {
  const entry = settingsEntryFor(pathname, entries)
  return entry?.enabled ? entry : undefined
}
