import type { SiteStatus } from '@repo/db'

import type { AppIconName } from '@/components/application/app-icon'

export type SiteSection = 'overview' | 'changes' | 'runs' | 'database' | 'vault' | 'settings'

export type SiteNavEntry = {
  section: SiteSection
  label: string
  icon: AppIconName
}

/**
 * The sections of a site page in the order of its panel (docs/plan/64-cabinet-navigation.md, Н4):
 * the files of the version the site has are the tab «Файлы» of «Изменения», not a section.
 */
export const siteNav: readonly SiteNavEntry[] = [
  { section: 'overview', label: 'Обзор', icon: 'globe' },
  { section: 'changes', label: 'Изменения', icon: 'changes' },
  { section: 'runs', label: 'Запуски', icon: 'runs' },
  { section: 'database', label: 'База', icon: 'database' },
  // The client's environment variables (docs/plan/53, Р13): the values live in Vault.
  { section: 'vault', label: 'Переменные', icon: 'key' },
  { section: 'settings', label: 'Настройки', icon: 'settings' },
]

export const siteHref = (siteId: string, section?: SiteSection) =>
  section ? `/projects/${siteId}/${section}` : `/projects/${siteId}`

/** The section a path of the site belongs to: its first segment after the site id. */
export function activeSiteSection(pathname: string, siteId: string): SiteSection | undefined {
  const root = siteHref(siteId)
  // The id is compared without regard to case: the lookup of a site takes it in either.
  const head = pathname.slice(0, root.length).toLowerCase()
  if (head !== root.toLowerCase()) return undefined
  if (pathname.length > root.length && pathname[root.length] !== '/') return undefined
  const segment = pathname.slice(root.length + 1).split('/')[0]
  return siteNav.find((entry) => entry.section === segment)?.section
}

/**
 * Why a site keeps only «Обзор» open, in the owner's words. The keys are the statuses in which
 * the platform does not work with the site; the phrase stands on «Обзор» and describes every
 * closed item of the navigation.
 */
const closedSectionsNotes: Readonly<Partial<Record<SiteStatus, string>>> = {
  paused: 'Пока работа приостановлена, остальные разделы сайта недоступны.',
  disconnected: 'Пока связи с сайтом нет, остальные разделы сайта недоступны.',
  archived: 'Пока сайт в архиве, остальные разделы сайта недоступны.',
}

/** The phrase about the closed sections of a site in this status; none when all are open. */
export const closedSectionsNote = (status: string): string | undefined =>
  Object.hasOwn(closedSectionsNotes, status) ? closedSectionsNotes[status as SiteStatus] : undefined

const allSections: readonly SiteSection[] = siteNav.map((entry) => entry.section)
const overviewOnly: readonly SiteSection[] = ['overview']

/**
 * Where the first import of a site stands (`siteSetupState`, spec §12): `pending` while its files
 * are being copied, `failed` after the copy stopped, `done` once the first version is saved; null
 * — or absent — for a site from before the wizard, which lives as it did.
 */
export type SiteSetup = 'pending' | 'failed' | 'done' | null

/**
 * The page of the site is the setup screen: «Обзор» shows how the copy goes, and the other
 * sections have nothing to work with yet.
 */
export const inSiteSetup = (setup: SiteSetup | undefined): boolean =>
  setup === 'pending' || setup === 'failed'

/**
 * The sections a site opens: one being set up, and a paused, a disconnected and an archived site
 * keep «Обзор» alone. The rail, the pages and the address of the site all ask here.
 */
export const availableSiteSections = (status: string, setup?: SiteSetup): readonly SiteSection[] =>
  inSiteSetup(setup) || closedSectionsNote(status) !== undefined ? overviewOnly : allSections

export const siteSectionAvailable = (
  status: string,
  section: SiteSection,
  setup?: SiteSetup,
): boolean => availableSiteSections(status, setup).includes(section)

/** A site added without access to its files that the browser can already work on. */
export function isBrowserOnly(site: {
  status: string
  capabilities?: { repository: string; browser: string }
}): boolean {
  return (
    site.status === 'onboarding' &&
    site.capabilities?.browser === 'ready' &&
    site.capabilities.repository === 'absent'
  )
}

/**
 * What the server says of a new chat of the project (`chat` of `project.get`, `chatRequirements`,
 * docs/plan/61-chats-first.md, К8): null requirements — it takes none now.
 */
export type SiteChat = { requirements: { repository: boolean; browser: boolean } | null }

/** The server takes a new chat of this project now. */
export const takesNewChat = (site: { chat?: SiteChat }): boolean =>
  (site.chat?.requirements ?? null) !== null

/** A new chat of this project works on the live site in the browser. */
export const takesBrowserChat = (site: { chat?: SiteChat }): boolean =>
  site.chat?.requirements?.browser === true
