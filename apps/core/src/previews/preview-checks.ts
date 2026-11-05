import type { PrismaClient } from '@repo/db'
import type { CandidateFiles, DbPlan, PreviewRecipe, PreviewRuntime } from '@repo/domain'
import { previewRequest, type PreviewResponse, type PreviewTarget } from '@repo/site-content'

import type { PreviewHold } from './preview-lease.ts'

// The checks of a candidate on its preview (docs/plan/53-chat-preview-release.md, Р20, Р22):
// `php_lint` — the syntax of the changed files of the server's language in a CLI container of
// the preview; `preview_smoke` — the home page and the pages of the objects the database plan
// changes answer 2xx or 3xx without a fatal error of the language. Results are counts only
// (`candidate_checks.summary`): never a path, a host or a message.

export interface CheckResult {
  passed: boolean
  summary: Record<string, number>
}

/** Arguments of one run of the CLI container: its argv holds at most 64. */
const LINT_BATCH = 56
const LINT_MS = 5 * 60_000

/**
 * How a server language is checked: the files it takes and a command over a batch of them that
 * prints, NUL after each, the ones that fail. Languages, not stacks: a recipe names its runtime.
 */
const linters: Record<PreviewRecipe['runtime'], { extensions: RegExp; argv: string[] }> = {
  php: {
    extensions: /\.(?:php|phtml|inc)$/i,
    argv: [
      '/bin/sh',
      '-c',
      'for f do php -l "./$f" >/dev/null 2>&1 || printf "%s\\0" "$f"; done; exit 0',
      'lint',
    ],
  },
}

export async function lintChangedFiles(
  input: {
    runtime: Pick<PreviewRuntime, 'exec'>
    previewId: string
    recipe: Pick<PreviewRecipe, 'runtime'>
    files: CandidateFiles
  },
  signal: AbortSignal,
): Promise<CheckResult> {
  const linter = linters[input.recipe.runtime]
  const paths = input.files
    .filter((file) => file.change !== 'deleted' && linter.extensions.test(file.path))
    .map((file) => file.path)
  let failed = 0
  for (let at = 0; at < paths.length; at += LINT_BATCH) {
    const batch = paths.slice(at, at + LINT_BATCH)
    const result = await input.runtime.exec(
      input.previewId,
      { argv: [...linter.argv, ...batch], timeoutMs: LINT_MS },
      signal,
    )
    if (result.code !== 0) return { passed: false, summary: { files: paths.length, errors: 1 } }
    const listed = Buffer.from(result.stdout).toString('utf8')
    failed += listed === '' ? 0 : listed.split('\0').filter(Boolean).length
  }
  return { passed: failed === 0, summary: { files: paths.length, failed } }
}

/** What a page with a fatal error of PHP shows; an error page of a stack answers 5xx anyway. */
const FATAL = /(?:<b>)?(?:PHP )?(?:Fatal|Parse) error(?:<\/b>)?:/i
const PAGES_MAX = 20

/** How core asks a page of a preview for a check: one GET, no redirect followed. */
const CHECK_REQUEST = {
  method: 'GET',
  headers: { 'user-agent': 'raditi-preview-check' },
  timeoutMs: 30_000,
  maxResponseBytes: 8 * 1024 * 1024,
} as const

/** What a page of a stack that declared `ready` says about the site (docs/plan/62-site-stacks.md, Т33). */
export type PreviewBoot =
  /** The site did not start: no header, 5xx, a message of PHP, a text of `ready.absent`. */
  | { state: 'dead' }
  /** It answered as itself; `redirectsAway` — to another host. */
  | { state: 'alive'; redirectsAway: boolean }
  /** 4xx with the header: the configuration ran, this page is closed or gone. */
  | { state: 'closed' }
  /** Twice no answer to read: a network failure, the time or the size. Nothing is proved. */
  | { state: 'unproved' }

/**
 * Where a message of PHP begins: PHP starts it on a line of its own, plain (`\nFatal error: `) or
 * with html_errors (`<br />\n<b>Fatal error</b>:`). A post quoting one inside its text is no death.
 */
const PHP_HEADER = /(?:^|\n)(?:<b>)?(?:PHP )?(?:Fatal|Parse) error(?:<\/b>)?:/g
/** Where a message of PHP ends. */
const PHP_LINE = / on line (?:<b>)?\d+/g
/** How far the file of a message may be from its header, and how long the file may be. */
const PHP_GAP_MAX = 8192
const PHP_FILE_MAX = 512

/** Where `needle` starts in `text`, ascending. */
function positionsOf(text: string, needle: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at)
  return found
}

/** The index of the first value at least `limit` in an ascending list, or its length. */
function firstAtLeast(sorted: readonly number[], limit: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! < limit) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * A message PHP itself printed, plain or with html_errors: `… in <file> on line <n>`, an uncaught
 * exception over several lines included, up to 8 KiB between the header and ` in `, a file of at
 * most 512 characters without `<` or a line break. Words alone are not one: a post may quote
 * «Fatal error:». Linear in the page, whatever it holds: the page is the site's or the agent's.
 */
export function phpMessageIn(page: string): boolean {
  const headerEnds = Array.from(page.matchAll(PHP_HEADER), (match) => match.index + match[0].length)
  if (headerEnds.length === 0) return false
  const ins = positionsOf(page, ' in ')
  // The last `<` or line break before the end of the file of the current message.
  let separator = -1
  let scanned = 0
  for (const match of page.matchAll(PHP_LINE)) {
    const end = page.endsWith('</b>', match.index) ? match.index - 4 : match.index
    for (; scanned < end; scanned++) {
      const code = page.charCodeAt(scanned)
      if (code === 0x0a || code === 0x3c) separator = scanned
    }
    // ` in <b>file</b>`: the `<` of `<b>` is the separator itself.
    let start = -1
    if (separator >= 4 && page.startsWith(' in <b>', separator - 4)) start = separator - 4
    if (start !== -1 && (end - separator - 3 < 1 || end - separator - 3 > PHP_FILE_MAX)) start = -1
    if (start === -1) {
      // ` in file`: the first ` in ` that leaves a file of 1 to 512 characters after it.
      const at = firstAtLeast(ins, Math.max(separator + 1, end - PHP_FILE_MAX - 4))
      if (at < ins.length && ins[at]! <= end - 5) start = ins[at]!
    }
    if (start === -1) continue
    // No header ends between the separator and the end, so the nearest header is the same for
    // every ` in ` that fits: the first one is the nearest to it.
    const header = firstAtLeast(headerEnds, start + 1) - 1
    if (header >= 0 && start - headerEnds[header]! <= PHP_GAP_MAX) return true
  }
  return false
}

/** One answer of a stack that declared `ready` (Т33): no `Warning` here, OpenCart prints it alive. */
export function pageVerdict(
  response: PreviewResponse,
  ready: NonNullable<PreviewRecipe['ready']>,
  hostname: string,
): Exclude<PreviewBoot, { state: 'unproved' }> {
  if (response.headers[ready.header] === undefined) return { state: 'dead' }
  const page = Buffer.from(response.body).toString('utf8')
  if (phpMessageIn(page) || ready.absent.some((text) => page.includes(text)))
    return { state: 'dead' }
  if (response.status >= 500) return { state: 'dead' }
  // The header proves the configuration ran: a closed site answers a guest 401, 403 or 404.
  if (response.status >= 400) return { state: 'closed' }
  if (response.status >= 200 && response.status < 300)
    return { state: 'alive', redirectsAway: false }
  if (response.status >= 300) {
    const location = response.headers.location
    if (!location) return { state: 'dead' }
    let target: URL
    try {
      target = new URL(location, `http://${hostname}/`)
    } catch {
      return { state: 'dead' }
    }
    return { state: 'alive', redirectsAway: target.hostname !== hostname }
  }
  return { state: 'dead' }
}

/** The health page before `ready`; a request that failed is tried once more. */
export async function previewBootOf(
  target: PreviewTarget,
  recipe: Pick<PreviewRecipe, 'healthPath'> & { ready: NonNullable<PreviewRecipe['ready']> },
  signal: AbortSignal,
): Promise<PreviewBoot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted()
    let response: PreviewResponse
    try {
      response = await previewRequest(target, { ...CHECK_REQUEST, path: recipe.healthPath })
    } catch {
      // A slow or heavy home page proves no death: the preview stays, the client sees `suspect`.
      continue
    }
    return pageVerdict(response, recipe.ready, target.hostname)
  }
  return { state: 'unproved' }
}

/** The pages of the smoke check: the health page, then those of the plan's objects. */
export function smokePages(
  recipe: Pick<PreviewRecipe, 'healthPath' | 'content'>,
  plan: DbPlan,
): string[] {
  const pages = new Set([recipe.healthPath])
  for (const operation of plan) {
    const [type, id] = operation.objectRef.split(':')
    const template = recipe.content?.pages[type ?? '']
    if (template && id) pages.add(template.replace('{id}', id))
    if (pages.size >= PAGES_MAX) break
  }
  return [...pages]
}

export async function smokeCheck(
  input: { target: PreviewTarget; pages: readonly string[]; ready?: PreviewRecipe['ready'] },
  signal: AbortSignal,
): Promise<CheckResult> {
  let failed = 0
  for (const path of input.pages) {
    signal.throwIfAborted()
    try {
      const response = await previewRequest(input.target, { ...CHECK_REQUEST, path })
      if (input.ready) {
        // A stack that says how its live page looks: only PHP's own message is death (Т33).
        if (pageVerdict(response, input.ready, input.target.hostname).state !== 'alive') failed++
        continue
      }
      const page = Buffer.from(response.body).toString('utf8')
      if (response.status < 200 || response.status >= 400 || FATAL.test(page)) failed++
    } catch {
      failed++
    }
  }
  return { passed: failed === 0, summary: { pages: input.pages.length, failed } }
}

/** The checks the manager of previews runs on each rebuild to a candidate's revision (Р20). */
export const previewCheckKinds = ['php_lint', 'preview_smoke'] as const
export type PreviewCheckKind = (typeof previewCheckKinds)[number]

/**
 * Runs the checks of a candidate on its rebuilt preview and records them for its revision (Р20,
 * Р22); checks of earlier revisions of the dialog become stale. Nothing is written once the
 * preview shows another revision or the hold went to another core: a later build owns them.
 */
export async function runCandidateChecks(
  deps: { db: PrismaClient; runtime: Pick<PreviewRuntime, 'exec'> },
  hold: PreviewHold,
  input: {
    taskId: string
    candidate: { id: string; revision: number; files: CandidateFiles; dbPlan: DbPlan }
    recipe: Pick<PreviewRecipe, 'runtime' | 'healthPath' | 'content' | 'ready'>
    target: PreviewTarget
  },
): Promise<Record<PreviewCheckKind, CheckResult>> {
  const signal = hold.signal
  const failed: CheckResult = { passed: false, summary: { errors: 1 } }
  const results: Record<PreviewCheckKind, CheckResult> = {
    php_lint: await lintChangedFiles(
      {
        runtime: deps.runtime,
        previewId: hold.fence.previewId,
        recipe: input.recipe,
        files: input.candidate.files,
      },
      signal,
    ).catch(() => failed),
    preview_smoke: await smokeCheck(
      {
        target: input.target,
        pages: smokePages(input.recipe, input.candidate.dbPlan),
        ready: input.recipe.ready,
      },
      signal,
    ).catch(() => failed),
  }
  hold.assert()
  const { candidate } = input
  await deps.db.$transaction(
    async (tx) => {
      // Only while this hold still shows the revision.
      const shown = await tx.previewEnvironment.count({
        where: {
          id: hold.fence.previewId,
          leaseEpoch: hold.fence.epoch,
          status: 'ready',
          revision: candidate.revision,
          candidateId: candidate.id,
        },
      })
      if (shown !== 1) return
      const finishedAt = new Date()
      for (const kind of previewCheckKinds) {
        const result = results[kind]
        const data = {
          status: result.passed ? ('passed' as const) : ('failed' as const),
          summary: result.summary,
          finishedAt,
        }
        const { count } = await tx.candidateCheck.updateMany({
          where: { candidateId: candidate.id, revision: candidate.revision, kind },
          data,
        })
        if (count === 0)
          await tx.candidateCheck.create({
            data: { candidateId: candidate.id, revision: candidate.revision, kind, ...data },
          })
      }
      await tx.candidateCheck.updateMany({
        where: {
          candidate: { taskId: input.taskId },
          revision: { lt: candidate.revision },
          status: { in: ['pending', 'passed', 'failed'] },
        },
        data: { status: 'stale' },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return results
}
