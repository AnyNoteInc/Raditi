import type { SiteStatus } from '@repo/db'

import type { AppIconName } from '@/components/application/app-icon'

export type SiteSection =
  'chat' | 'overview' | 'changes' | 'runs' | 'database' | 'vault' | 'settings'

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
  { section: 'chat', label: 'Чат', icon: 'chat', primary: true },
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
 * The sections laid out as «list — content»: the dialogs, the versions, the runs, and the
 * sections split by their cards — the database and its copies, the variables and the accesses,
 * the site and its dangerous actions (owner's requests of 26.10.2026). The shell leaves room for their list column.
 */
const listSections: readonly SiteSection[] = [
  'chat',
  'changes',
  'runs',
  'database',
  'vault',
  'settings',
]

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
 * files, the database and the checks, or the browser of a task (docs/plan/57, Б29). From `lg` it
 * stands at the right edge, the full height of the window, and the content leaves it this much
 * room. The viewer may drag its edge: the width is a CSS variable the shell sets for both.
 */
export const SITE_PANE_DEFAULT_WIDTH = 'clamp(440px, 46vw, 760px)'
export const SITE_PANE_WIDTH_VAR = '--site-pane-width'
export const SITE_PANE_WIDTH = `var(${SITE_PANE_WIDTH_VAR}, ${SITE_PANE_DEFAULT_WIDTH})`

/** The narrowest panel, and the narrowest the dialog beside it may become. */
export const SITE_PANE_MIN = 440
export const SITE_DIALOG_MIN = 360
/** The rail, the paddings of the content (32 px each side from `md`) and the dialog column. */
const PANE_RESERVED = SITE_RAIL_WIDTH + 2 * 32 + SITE_DIALOG_MIN

/** The cookie a viewer's width of the panel is kept in: the page is drawn with it at once. */
export const SITE_PANE_COOKIE = 'raditi-pane-width'

/** A width from the cookie, in whole pixels; null for anything that is not one. */
export function parsePaneWidth(value: string | undefined | null): number | null {
  if (value === undefined || value === null || !/^\d{3,4}$/.test(value)) return null
  const width = Number(value)
  return width >= SITE_PANE_MIN && width <= 4000 ? width : null
}

/** The panel's width for a window: never narrower than its minimum, nor the dialog than its. */
export function clampPaneWidth(width: number, windowWidth: number): number {
  const max = Math.max(SITE_PANE_MIN, windowWidth - PANE_RESERVED)
  return Math.round(Math.min(Math.max(width, SITE_PANE_MIN), max))
}

/** The CSS of a chosen width: kept within the same bounds by the browser on any window. */
export const paneWidthCss = (width: number): string =>
  `clamp(${SITE_PANE_MIN}px, ${Math.round(width)}px, max(${SITE_PANE_MIN}px, calc(100vw - ${PANE_RESERVED}px)))`

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
 * is not connected yet has no dialogs — unless it takes tasks in the browser (docs/plan/57, Б9),
 * which needs no connection — and a site whose chat is closed has only the overview.
 */
export const siteLanding = (
  status: string,
  setup?: SiteSetup,
  capabilities?: { browser: string },
): SiteSection =>
  !siteSectionAvailable(status, 'chat', setup) ||
  (status === 'onboarding' && capabilities?.browser !== 'ready')
    ? 'overview'
    : 'chat'
