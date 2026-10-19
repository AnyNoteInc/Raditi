import {
  ftpSourceInputSchema,
  isFileSourceGuardError,
  isImportSegment,
  isNestedSiteRoot,
  isSiteConnectionError,
  siteConnectionLimits,
  SiteConnectionError,
  type FileSourceEntry,
} from '@repo/domain'

// The part of a check that is the same for every file source: after the login and the folder,
// the root must list, hold the markers of the platform (or a folder one level down that does,
// which becomes the suggestion) and give the first bytes of one file — of the root, else of a
// marker folder. Nothing is written.

/** One read of the check: a bounded download proves that reading works; a longer file is fine. */
export const CHECK_READ_BYTES = 4 * 1024

export interface DirectoryListing {
  entries: FileSourceEntry[]
  /** What the listing cost against the byte budget of the check. */
  bytes: number
}

/** The protocol half of a check: SFTP and FTP each implement it over their own connection. */
export interface CheckBrowser {
  /**
   * The root for `[]`, else one directory below it by the refs of its segments. Throws
   * SiteConnectionError or FileSourceGuardError (`listing` past `maxBytes`, `outside_root`).
   */
  list(directory: readonly string[], maxBytes: number): Promise<DirectoryListing>
  /** Reads at most `bytes` of one file below the root (refs of its segments). Throws SiteConnectionError. */
  readHead(path: readonly string[], bytes: number): Promise<void>
  /** The segment as a user would type it into the folder field, or null when it cannot be typed. */
  typedSegment(entry: FileSourceEntry): string | null
}

export type RootInspection =
  { ok: true; entries: number } | { ok: false; reason: 'not_site_root'; suggestedRoot?: string }

/** Where a hosting usually keeps the site: tried first, the other folders after them by name. */
const LIKELY_ROOTS = [
  'public_html',
  'www',
  'htdocs',
  'httpdocs',
  'html',
  'web',
  'site',
  'wordpress',
  'wp',
]

function hasMarkers(entries: readonly FileSourceEntry[], markers: readonly string[]): boolean {
  return (
    markers.length === 0 ||
    isNestedSiteRoot(
      entries.map((entry) => entry.name),
      markers,
    )
  )
}

/** `rootPath` joined with one typed segment, or null when the result is not a folder the wizard accepts. */
export function joinRootPath(rootPath: string, segment: string): string | null {
  const base = rootPath.replace(/\/+$/, '')
  const joined = base === '' && rootPath.startsWith('/') ? `/${segment}` : `${base}/${segment}`
  return ftpSourceInputSchema.shape.rootPath.safeParse(joined).success ? joined : null
}

/** The smallest file that has a byte (cheapest to prove), else any file; null when the folder has none. */
function fileToRead(entries: readonly FileSourceEntry[]): FileSourceEntry | null {
  const files = entries.filter((entry) => entry.type === 'file')
  const sized = files.filter((entry) => Number.isFinite(entry.size) && entry.size > 0)
  if (sized.length > 0)
    return sized.reduce((smallest, entry) => (entry.size < smallest.size ? entry : smallest))
  return files[0] ?? null
}

/** A candidate that cannot be entered is skipped; a broken connection ends the whole check. */
function isSkippable(error: unknown): boolean {
  if (isFileSourceGuardError(error)) return error.guard === 'outside_root'
  return (
    isSiteConnectionError(error) &&
    (error.reason === 'not_found' || error.reason === 'access_denied')
  )
}

async function suggestRoot(
  browser: CheckBrowser,
  rootPath: string,
  root: readonly FileSourceEntry[],
  markers: readonly string[],
  budget: { bytes: number },
): Promise<string | null> {
  const rank = (name: string) => {
    const index = LIKELY_ROOTS.indexOf(name.toLowerCase())
    return index === -1 ? LIKELY_ROOTS.length : index
  }
  const candidates = root
    .filter((entry) => entry.type === 'directory' || entry.type === 'link')
    .filter((entry) => isImportSegment(entry.name))
    .map((entry) => ({ entry, typed: browser.typedSegment(entry) }))
    .filter(
      (candidate): candidate is { entry: FileSourceEntry; typed: string } =>
        candidate.typed !== null,
    )
    .sort(
      (a, b) => rank(a.entry.name) - rank(b.entry.name) || (a.entry.name < b.entry.name ? -1 : 1),
    )
    .slice(0, siteConnectionLimits.rootSuggestionDirectories)

  for (const { entry, typed } of candidates) {
    if (budget.bytes <= 0) return null
    let listing: DirectoryListing
    try {
      listing = await browser.list([entry.ref], budget.bytes)
    } catch (error) {
      if (isFileSourceGuardError(error) && error.guard === 'listing') return null
      if (isSkippable(error)) continue
      throw error
    }
    budget.bytes -= listing.bytes
    if (hasMarkers(listing.entries, markers)) {
      const suggested = joinRootPath(rootPath, typed)
      if (suggested !== null) return suggested
    }
  }
  return null
}

/**
 * The bounded read that proves reading works: one file of the root, else — a root whose entries are
 * folders and links only — one file of a marker folder, in the order of the markers (one level, within
 * what the listings left of the budget). A folder that cannot be entered is passed over; when no file
 * is found at all the check fails `transfer_failed` rather than pass without a read.
 */
async function readOneFile(
  browser: CheckBrowser,
  root: readonly FileSourceEntry[],
  markers: readonly string[],
  budget: { bytes: number },
): Promise<void> {
  const file = fileToRead(root)
  if (file) return browser.readHead([file.ref], CHECK_READ_BYTES)
  const folders = markers
    .map((marker) =>
      root.find(
        (entry) => entry.type === 'directory' && entry.name.toLowerCase() === marker.toLowerCase(),
      ),
    )
    .filter((entry): entry is FileSourceEntry => entry !== undefined)
  for (const folder of folders) {
    if (budget.bytes <= 0) break
    let listing: DirectoryListing
    try {
      listing = await browser.list([folder.ref], budget.bytes)
    } catch (error) {
      if (isFileSourceGuardError(error) && error.guard === 'listing') break
      if (isSkippable(error)) continue
      throw error
    }
    budget.bytes -= listing.bytes
    const inner = fileToRead(listing.entries)
    if (inner) return browser.readHead([folder.ref, inner.ref], CHECK_READ_BYTES)
  }
  throw new SiteConnectionError('transfer_failed')
}

/**
 * Lists the root within checkListingBytes (the suggestion search and the read spend what the root left
 * of it), requires the markers, then reads CHECK_READ_BYTES of one file. Throws what the browser throws.
 */
export async function inspectRoot(
  browser: CheckBrowser,
  rootPath: string,
  markers: readonly string[],
): Promise<RootInspection> {
  const budget = { bytes: siteConnectionLimits.checkListingBytes }
  const root = await browser.list([], budget.bytes)
  budget.bytes -= root.bytes
  if (!hasMarkers(root.entries, markers)) {
    const suggestedRoot = await suggestRoot(browser, rootPath, root.entries, markers, budget)
    return suggestedRoot === null
      ? { ok: false, reason: 'not_site_root' }
      : { ok: false, reason: 'not_site_root', suggestedRoot }
  }
  await readOneFile(browser, root.entries, markers, budget)
  return { ok: true, entries: root.entries.length }
}

/**
 * A segment the adapter may send to the server: one entry of a listing it made itself. Never empty,
 * `.` or `..`, never with a `/` or a NUL, CR or LF (by character code): a ref is never a path.
 */
export function isSafeRef(ref: string): boolean {
  if (ref === '' || ref === '.' || ref === '..' || ref.includes('/')) return false
  for (let index = 0; index < ref.length; index += 1) {
    const code = ref.charCodeAt(index)
    if (code === 0 || code === 10 || code === 13) return false
  }
  return true
}
