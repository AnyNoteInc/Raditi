import type { SiteStatus } from '@repo/db'

import type { AppIconName } from '@/components/application/app-icon'

export type SiteSection = 'chat' | 'overview' | 'changes' | 'runs' | 'database' | 'settings'

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

/** The sections of a site page in rail order. */
export const siteNav: readonly SiteNavEntry[] = [
  { section: 'chat', label: 'Чат', icon: 'chat', primary: true },
  { section: 'overview', label: 'Обзор', icon: 'globe', primary: true },
  { section: 'changes', label: 'Изменения', icon: 'changes', primary: true },
  { section: 'runs', label: 'Запуски', icon: 'runs', primary: true },
  { section: 'database', label: 'База и бэкап', icon: 'database', primary: false },
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

/** The sections laid out as «list — content»; the shell leaves room for their list column. */
const listSections: readonly SiteSection[] = ['chat']

export const hasSiteList = (section: SiteSection | undefined) =>
  section !== undefined && listSections.includes(section)

/** The item a section opens on: «Чат» starts from a new dialog, not from an empty area. */
const sectionStart: Partial<Record<SiteSection, string>> = { chat: 'new' }

/** Where the link of a section leads: to the section, or to the item it starts from. */
export function siteEntryHref(siteId: string, section: SiteSection): string {
  const start = sectionStart[section]
  return start ? `${siteHref(siteId, section)}/${start}` : siteHref(siteId, section)
}

/**
 * True on an item of a «list — content» section that the user opened from its list: on a phone
 * such a path gives up the bottom bar to the content. The item a section starts from keeps the
 * bar — the user came to it by the bar itself.
 */
export function siteItemOpen(pathname: string, siteId: string): boolean {
  const section = activeSiteSection(pathname, siteId)
  if (section === undefined || !hasSiteList(section)) return false
  const rest = pathname.slice(siteHref(siteId, section).length).replace(/\/+$/, '')
  return rest !== '' && rest !== `/${sectionStart[section] ?? ''}`
}

/**
 * The panel beside an open dialog (docs/plan/53-chat-preview-release.md, Р20): the preview, the
 * files, the database and the checks. From `lg` it stands at the right edge, the full height
 * of the window, and the content leaves it this much room.
 */
export const SITE_PANE_WIDTH = 'clamp(440px, 46vw, 760px)'

/** Sections whose open item has the panel beside it. */
const panedSections: readonly SiteSection[] = ['chat']

/**
 * True on a dialog opened from the list of «Чат». From `lg` such an item gives the list column
 * up: the dialog and the panel of its changes take the width (the way back to the list stays).
 */
export function sitePaneOpen(pathname: string, siteId: string): boolean {
  const section = activeSiteSection(pathname, siteId)
  return section !== undefined && panedSections.includes(section) && siteItemOpen(pathname, siteId)
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

/**
 * Where the address of a site itself leads: a site being set up shows how that goes, a site that
 * is not connected yet has no dialogs, and a site whose chat is closed has only the overview.
 */
export const siteLanding = (status: string, setup?: SiteSetup): SiteSection =>
  status === 'onboarding' || !siteSectionAvailable(status, 'chat', setup) ? 'overview' : 'chat'
