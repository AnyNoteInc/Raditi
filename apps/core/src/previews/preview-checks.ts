import type { PrismaClient } from '@repo/db'
import type { CandidateFiles, DbPlan, PreviewRecipe, PreviewRuntime } from '@repo/domain'
import { previewRequest, type PreviewTarget } from '@repo/site-content'

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
  input: { target: PreviewTarget; pages: readonly string[] },
  signal: AbortSignal,
): Promise<CheckResult> {
  let failed = 0
  for (const path of input.pages) {
    signal.throwIfAborted()
    try {
      const response = await previewRequest(input.target, {
        method: 'GET',
        path,
        headers: { 'user-agent': 'raditi-preview-check' },
        timeoutMs: 30_000,
        maxResponseBytes: 8 * 1024 * 1024,
      })
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
    recipe: Pick<PreviewRecipe, 'runtime' | 'healthPath' | 'content'>
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
      { target: input.target, pages: smokePages(input.recipe, input.candidate.dbPlan) },
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
