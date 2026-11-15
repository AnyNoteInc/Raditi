// What the browser and the cabinet tell each other outside of a page
// (docs/plan/82-scheduled-tasks.md, Зп12, Зп41): the path the service worker asks an open window of
// the cabinet to go to, and the zone of the browser the cabinet remembers once a session. The
// checks are here, plain, so the component and its tests share them.

/** What the service worker posts to a window of the cabinet when a notification is clicked. */
export const NAVIGATE_MESSAGE = 'raditi:navigate'

// The path of notificationPushPayloadSchema (@repo/domain/schedule), spelled again here so the
// layout of the cabinet does not load the whole domain of schedules; the test keeps them equal.
const CABINET_PATH = /^\/(?!\/)[A-Za-z0-9/_-]*$/
const NOT_A_PAGE = /^\/(?:api|_next)(?:\/|$)/

/** A page of the cabinet to go to, or null: only a path of this origin, never an API route. */
export function cabinetPathOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null
  return CABINET_PATH.test(value) && !NOT_A_PAGE.test(value) ? value : null
}

/** The path of a `raditi:navigate` message of the service worker; null — any other message. */
export function navigatePathOf(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const message = data as { type?: unknown; path?: unknown }
  return message.type === NAVIGATE_MESSAGE ? cabinetPathOf(message.path) : null
}

/** The key of the mark «the zone is remembered» in the storage of this browser session. */
export const ZONE_MARK_KEY = 'raditi-timezone-remembered'

/** The zone of this browser, as Intl names it; null — the browser does not say. */
export function browserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.length > 0 && zone.length <= 64 ? zone : null
  } catch {
    return null
  }
}

/**
 * Whether the zone still has to be told for this user in this browser session, and marks it told:
 * once a session (Зп12). A storage that cannot be read or written tells it every time the cabinet
 * is opened — at worst one call more.
 */
export function claimZoneMark(storage: Storage | null, userId: string, zone: string): boolean {
  const mark = `${userId}:${zone}`
  try {
    if (storage?.getItem(ZONE_MARK_KEY) === mark) return false
    storage?.setItem(ZONE_MARK_KEY, mark)
  } catch {
    // Private mode or blocked storage: tell it anyway.
  }
  return true
}
