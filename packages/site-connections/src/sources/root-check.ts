import {
  ftpSourceInputSchema,
  isFileSourceGuardError,
  isImportSegment,
  isNestedSiteRoot,
  isSiteConnectionError,
  siteConnectionLimits,
  SiteConnectionError,
  siteReadBytes,
  type FileSourceEntry,
  type FileSourceSession,
  type SiteRead,
  type SiteRootInspection,
  type SourceCheckContext,
} from '@repo/domain'

// The part of a check that is the same for every file source: after the login and the folder,
// the root must list, be inspected by the adapters of the stacks in the same session (the version
// of the found stack is read there), hold the markers of a stack (or a folder one level down that
// does, which becomes the suggestion) and give the first bytes of one file — of the root, else of
// a marker folder. Nothing is written.

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
  /**
   * One file below the root (refs of its segments), streamed into `sink`: the contract of
   * `FileSourceSession.read`. On FTP a file longer than `maxBytes` cuts the transfer, and the one
   * connection of the check works no more: the next call fails `transfer_failed`.
   */
  read: FileSourceSession['read']
  /** The segment as a user would type it into the folder field, or null when it cannot be typed. */
  typedSegment(entry: FileSourceEntry): string | null
}

export type RootInspection =
  | { ok: true; entries: number; inspection: SiteRootInspection }
  | {
      ok: false
      reason: 'not_site_root'
      suggestedRoot?: string
      inspection: SiteRootInspection
    }

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

type CheckStacks = SourceCheckContext['stacks']

/** The markers of any of the stacks; a stack that names none takes any folder. */
function hasMarkers(entries: readonly FileSourceEntry[], stacks: CheckStacks): boolean {
  const names = entries.map((entry) => entry.name)
  return stacks.some(({ markers }) => markers.length === 0 || isNestedSiteRoot(names, markers))
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
  stacks: CheckStacks,
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
    if (hasMarkers(listing.entries, stacks)) {
      const suggested = joinRootPath(rootPath, typed)
      if (suggested !== null) return suggested
    }
  }
  return null
}

/**
 * At most `maxBytes` of one file (refs of its segments); null — the file is longer. Throws what the
 * browser throws otherwise.
 */
export async function readBytes(
  browser: CheckBrowser,
  path: readonly string[],
  maxBytes: number,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  try {
    await browser.read(
      path,
      (chunk) => {
        chunks.push(chunk)
        return Promise.resolve()
      },
      maxBytes,
    )
  } catch (error) {
    if (isFileSourceGuardError(error) && error.guard === 'bytes') return null
    throw error
  }
  return Buffer.concat(chunks)
}

/**
 * The `SiteRead` of the check session (Т26): a file of the root by its relative path. null — a path
 * the wizard would not import, no such file, a file closed to this access (question В10 of Э2) or one
 * longer than `siteReadBytes`. Anything else — a cut transfer, a broken connection, the deadline —
 * throws, and the check answers its reason with a retry: a failure of the connection never becomes
 * an unknown version. On FTP a file longer than `siteReadBytes` cuts the transfer, and the next call
 * of the check fails `transfer_failed`: a recorded bound, the files of a version are far shorter.
 */
export function checkSessionRead(browser: CheckBrowser): SiteRead {
  return async (path) => {
    const segments = path.split('/')
    // The port promises ASCII paths: a ref is then the name on every protocol.
    if (!segments.every((segment) => isImportSegment(segment) && /^[\x20-\x7e]+$/.test(segment)))
      return null
    try {
      return await readBytes(browser, segments, siteReadBytes)
    } catch (error) {
      if (isSkippable(error)) return null
      throw error
    }
  }
}

/**
 * The read that proves reading, of a file the listing has just given: one that cannot be had is
 * closed to this access (`access_denied`), never a folder that is not there — whatever the protocol
 * made of the refusal (on FTP a refused RETR whose SIZE the server does not answer reads `not_found`).
 */
async function proveRead(browser: CheckBrowser, path: readonly string[]): Promise<void> {
  try {
    await readBytes(browser, path, CHECK_READ_BYTES)
  } catch (error) {
    if (isSiteConnectionError(error) && error.reason === 'not_found')
      throw new SiteConnectionError('access_denied')
    throw error
  }
}

/**
 * The bounded read that proves reading works: one file of the root, else — a root whose entries are
 * folders and links only — one file of a marker folder, in the order of the markers (one level, within
 * what the listings left of the budget). A file longer than the bound proves it as well. A folder that
 * cannot be entered is passed over; when no file is found at all the check fails `transfer_failed`
 * rather than pass without a read. It comes last: on FTP it may cut the one connection of the check.
 */
async function readOneFile(
  browser: CheckBrowser,
  root: readonly FileSourceEntry[],
  markers: readonly string[],
  budget: { bytes: number },
): Promise<void> {
  const file = fileToRead(root)
  if (file) return proveRead(browser, [file.ref])
  const folders = markers
    .map((marker) =>
      root.find(
        (entry) => entry.type === 'directory' && entry.name.toLowerCase() === marker.toLowerCase(),
      ),
    )
    .filter((entry): entry is FileSourceEntry => entry !== undefined)
  for (const folder of new Set(folders)) {
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
    if (inner) return proveRead(browser, [folder.ref, inner.ref])
  }
  throw new SiteConnectionError('transfer_failed')
}

/**
 * Lists the root within checkListingBytes (the suggestion search and the read spend what the root left
 * of it), has the adapters inspect it in this session, requires the markers of a stack, then reads
 * CHECK_READ_BYTES of one file. The order is strict (Р8 of Э2): the read that proves reading may cut
 * the one connection of an FTP check, so the version is read before it. Throws what the browser
 * throws, and what `inspect` lets through.
 */
export async function inspectRoot(
  browser: CheckBrowser,
  rootPath: string,
  context: Pick<SourceCheckContext, 'stacks' | 'inspect'>,
): Promise<RootInspection> {
  const budget = { bytes: siteConnectionLimits.checkListingBytes }
  const root = await browser.list([], budget.bytes)
  budget.bytes -= root.bytes
  const inspection = await context.inspect(
    root.entries.map((entry) => entry.name),
    checkSessionRead(browser),
  )
  if (!hasMarkers(root.entries, context.stacks)) {
    const suggestedRoot = await suggestRoot(browser, rootPath, root.entries, context.stacks, budget)
    return suggestedRoot === null
      ? { ok: false, reason: 'not_site_root', inspection }
      : { ok: false, reason: 'not_site_root', suggestedRoot, inspection }
  }
  const markers = context.stacks.flatMap((entry) => entry.markers)
  await readOneFile(browser, root.entries, markers, budget)
  return { ok: true, entries: root.entries.length, inspection }
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
