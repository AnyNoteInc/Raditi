import type { SiteStatus } from '@repo/db'

import type { AppIconName } from '@/components/application/app-icon'

export type SiteSection = 'overview' | 'changes' | 'runs' | 'database' | 'vault' | 'settings'

export type SiteNavEntry = {
  section: SiteSection
  label: string
  icon: AppIconName
  /** Shown in the bottom bar of a phone; the rest opens from «Ещё». */
  primary: boolean
}

/** The fixed columns of the site page: the rail of sections and the list beside it. */
export const SITE_RAIL_WIDTH = 88
export const SITE_LIST_WIDTH = 300
/**
 * The bar of breadcrumbs from `md` (owner's request of 26.10.2026): it runs from the rail to the
 * right edge and stays at the top; the list column and the panel of a dialog stand under it.
 */
export const SITE_TOOLBAR_HEIGHT = 44

/** The sections of a site page in rail order. */
export const siteNav: readonly SiteNavEntry[] = [
  { section: 'overview', label: 'Обзор', icon: 'globe', primary: true },
  { section: 'changes', label: 'Изменения', icon: 'changes', primary: true },
  { section: 'runs', label: 'Запуски', icon: 'runs', primary: true },
  { section: 'database', label: 'База и бэкап', icon: 'database', primary: false },
  // The client's environment variables (docs/plan/53, Р13): the values live in Vault.
  { section: 'vault', label: 'Переменные', icon: 'key', primary: false },
  { section: 'settings', label: 'Настройки', icon: 'settings', primary: false },
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
 * The sections laid out as «list — content»: the versions, the runs, and the sections split by
 * their cards — the database and its copies, the variables and the accesses,
 * the site and its dangerous actions (owner's requests of 26.10.2026). The shell leaves room for their list column.
 */
const listSections: readonly SiteSection[] = ['changes', 'runs', 'database', 'vault', 'settings']

export const hasSiteList = (section: SiteSection | undefined) =>
  section !== undefined && listSections.includes(section)

/**
 * True on an item of a «list — content» section that the user opened from its list: on a phone
 * such a path gives up the bottom bar to the content.
 */
export function siteItemOpen(pathname: string, siteId: string): boolean {
  const section = activeSiteSection(pathname, siteId)
  if (section === undefined || !hasSiteList(section)) return false
  const rest = pathname.slice(siteHref(siteId, section).length).replace(/\/+$/, '')
  return rest !== ''
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
