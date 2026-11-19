import { z } from 'zod'

import { DomainError } from '../errors.ts'
import type { CiStatus } from '../ports/git-provider.ts'

// Webhooks of the repositories of projects and the rest of the second queue (docs/plan/84-projects.md,
// ПР17, ПР24, §4.3, §4.6; slice 84.26). A webhook is only a hint, as a payment of ЮKassa is: web
// checks its signature, keeps its delivery id against a repeat and writes `git.refresh` for core,
// which reads the state again from the provider. The poll stays: a webhook that never came is read
// by the next tick. `git.refresh` coalesces: every hint of one repository, kind and object within
// GIT_REFRESH_WINDOW_MS is one outbox row (its dedupe key), and a repository is read at most once a
// poll gap whoever asks — a storm of deliveries is a few reads a minute.

const numericId = z.string().regex(/^[1-9][0-9]{0,19}$/)
const sha = z.string().regex(/^[0-9a-f]{40}$/)

/** What a delivery says changed: what core reads again. */
export const gitRefreshKinds = ['push', 'merge_request', 'pipeline', 'checks'] as const
export type GitRefreshKind = (typeof gitRefreshKinds)[number]

/** `git.refresh`: a hint of a webhook for one repository of a project. */
export const gitRefreshPayloadSchema = z.strictObject({
  projectRepositoryId: z.uuid(),
  kind: z.enum(gitRefreshKinds),
  /** The merge request the delivery is about, as the provider numbers it. */
  number: z.number().int().positive().max(2_147_483_647).optional(),
  /** The run the delivery is about. */
  runId: numericId.optional(),
})
export type GitRefreshPayload = z.infer<typeof gitRefreshPayloadSchema>

/** Hints of one key within this window are one job, published at the window's end. */
export const GIT_REFRESH_WINDOW_MS = 15_000

/** The dedupe key of the outbox row of a hint: one per repository, kind, object and window. */
export function gitRefreshDedupeKey(payload: GitRefreshPayload, at: Date): string {
  const object = payload.number ?? payload.runId ?? '-'
  const window = Math.floor(at.getTime() / GIT_REFRESH_WINDOW_MS)
  return `git.refresh:${payload.projectRepositoryId}:${payload.kind}:${object}:${window}`
}

/** When the job of a hint is published: the end of its window, so the window coalesces first. */
export function gitRefreshAvailableAt(at: Date): Date {
  return new Date((Math.floor(at.getTime() / GIT_REFRESH_WINDOW_MS) + 1) * GIT_REFRESH_WINDOW_MS)
}

/** Delivery ids are kept this long against a repeat, then the poll tick removes them. */
export const GIT_WEBHOOK_DELIVERY_KEEP_MS = 7 * 24 * 60 * 60_000

/** A signed GitLab delivery older or newer than this is refused (Standard Webhooks). */
export const GIT_WEBHOOK_SIGNATURE_WINDOW_S = 5 * 60

/** The providers whose deliveries are kept (`git_webhook_deliveries.provider`). */
export const gitWebhookProviders = ['github', 'gitlab'] as const
export type GitWebhookProvider = (typeof gitWebhookProviders)[number]

/**
 * The hook of a GitLab project core created (`project_repositories.hook_state`): `active`, or why
 * there is none — `not_allowed` (the connection's user is not a Maintainer, ПР17) or `failed`.
 */
export const repoHookStates = ['active', 'failed', 'not_allowed'] as const
export type RepoHookState = (typeof repoHookStates)[number]

/** `git.hook.create`: a hook of a GitLab project, by the repository's own connection. */
export const gitHookCreatePayloadSchema = z.strictObject({ projectRepositoryId: z.uuid() })

/**
 * `git.hook.remove`: written in the transaction that deletes the row of the repository (detached,
 * purged), so it names the hook by what the row held.
 */
export const gitHookRemovePayloadSchema = z.strictObject({
  connectionId: z.uuid(),
  host: z.string().min(1).max(253),
  path: z.string().min(1).max(300),
  providerRepoId: numericId,
  hookId: numericId,
})
export type GitHookRemovePayload = z.infer<typeof gitHookRemovePayloadSchema>

// --- `@` over the paths of the repository (ПР24) ------------------------------------------------

/** Paths of the main branch `@` offers at most. */
export const REPO_TREE_MAX_PATHS = 20_000

/** `git.repo.tree`: the paths of the main branch at `sha`, from the mirror. */
export const gitRepoTreePayloadSchema = z.strictObject({ projectRepositoryId: z.uuid(), sha })

/**
 * Where core keeps the paths in `raditi-artifacts`; web reads them for `projectRepo.paths`. The
 * version is in the key: a list of v1 (84.26) still offered the files gitleaks flags, which a
 * sandbox holds as a stub (ПР35) — it is never read, and a look at `@` asks core for a new one.
 */
export const repoTreeKey = (projectRepositoryId: string, treeSha: string): string =>
  `repo-trees/${projectRepositoryId.toLowerCase()}/v2/${treeSha}.json`

/**
 * The file at `repoTreeKey`: the files of the tree a sandbox gets as they are — none of those it
 * holds as a stub (ПР35: named like a secret, flagged by gitleaks), so `@` offers only what the
 * agent can read. Paths only, never contents.
 */
export const repoTreeFileSchema = z.strictObject({
  v: z.literal(2),
  sha,
  paths: z.array(z.string().min(1).max(4096)).max(REPO_TREE_MAX_PATHS),
  /** The tree has more files than REPO_TREE_MAX_PATHS: only the first are listed. */
  truncated: z.boolean(),
})
export type RepoTreeFile = z.infer<typeof repoTreeFileSchema>

// --- builds and the revert (ПР15, ПР17) ---------------------------------------------------------

/**
 * Whether a rerun is a card of a deploy (ПР15): a build of the main branch, one with jobs to start
 * by hand (deploy jobs) or a workflow started by hand may put code out — its card says so and core
 * reruns it only while its commit is the head of its branch.
 */
export function rerunIsDeploy(run: {
  ref: string
  defaultBranch: string
  event: string | null
  manualJobs: boolean
}): boolean {
  return run.ref === run.defaultBranch || run.manualJobs || run.event === 'workflow_dispatch'
}

/**
 * Whether the plain card of «Запустить снова» warns of a new build (ПР36): a rerun of a build that
 * passed starts a new build of the branch, which repeats every automatic job — a deploy that needs
 * no manual start included (a branch like `staging`), which the plain card did not say. A card of a
 * deploy (`rerunIsDeploy`) already says in its own words that the repeat may put the version out,
 * so it does not warn twice.
 */
export function rerunPassedIsNewBuild(run: {
  ref: string
  defaultBranch: string
  event: string | null
  manualJobs: boolean
  status: CiStatus
}): boolean {
  return run.status === 'success' && !rerunIsDeploy(run)
}

/** The build of the card is not there any more, or not in a state the button acts on. */
export const repoRunGone = (): DomainError =>
  new DomainError('REPO_RUN_GONE', 'The build is not there or not in that state', 409)

/**
 * «Запустить снова» of a build that passed is a new build of its branch (ПР36), and the provider
 * would not start it: by its settings such a start has no jobs, or its workflow does not run.
 */
export const repoRunNotStarted = (): DomainError =>
  new DomainError('REPO_RUN_NOT_STARTED', 'The provider did not start the new build', 409)

/**
 * The provider refused the new build in words the platform does not know (a configuration error,
 * a limit of builds…): not a technical failure, and not said to be the settings.
 */
export const repoRunRefused = (): DomainError =>
  new DomainError('REPO_RUN_REFUSED', 'The provider refused the new build', 409)

/** A build of a tag or of a merge request ref passed: a new one is started only at the provider. */
export const repoRunNotABranch = (): DomainError =>
  new DomainError('REPO_RUN_NOT_A_BRANCH', 'The build is not of a branch', 409)

/** The one who connected the repository may not start a build on this branch (a protected one). */
export const repoRunNotAllowed = (): DomainError =>
  new DomainError('REPO_RUN_NOT_ALLOWED', 'The user may not start a build on this branch', 403)

/** The merge request was not merged, or its merge commit is not known. */
export const repoNotMerged = (): DomainError =>
  new DomainError('REPO_NOT_MERGED', 'The merge request is not merged', 409)

/** The revert of a merge does not go on top of the main branch as it stands now. */
export const repoRevertConflict = (): DomainError =>
  new DomainError('REPO_REVERT_CONFLICT', 'The revert does not go on top of the branch', 409)

/** The words of the refusals of a build button and of a revert, without a final period. */
export const repoRunRefusalTexts = Object.freeze({
  REPO_RUN_GONE: 'Сборка уже не в том состоянии — обновите страницу',
  REPO_RUN_NOT_STARTED:
    'Новая сборка не запустилась: её настройки не дают ей идти при запуске из Радити — запустите её в самом репозитории',
  REPO_RUN_REFUSED: 'Новая сборка не запустилась — запустите её в самом репозитории',
  REPO_RUN_NOT_A_BRANCH:
    'Эту сборку запускали не для ветки — запустить её снова можно в самом репозитории',
  REPO_RUN_NOT_ALLOWED: 'У вас нет права запускать сборки в этой ветке',
  REPO_NOT_MERGED: 'Запрос ещё не принят — отменять нечего',
  REPO_REVERT_NOTHING: 'Этих изменений уже нет в основной ветке — отменять нечего',
  REPO_REVERT_CONFLICT:
    'Отменить автоматически не получилось: в основной ветке эти места уже изменили. Отмените вручную в репозитории',
} satisfies Record<string, string>)

/** The words of the cards (§4.8). */
export const repoRunTexts = Object.freeze({
  rerunTitle: 'Запустить сборку снова?',
  cancelTitle: 'Остановить сборку?',
  rerunDeployBody:
    'Это сборка основной ветки или сборка с заданиями выкладки: повтор может выкатить её версию — так, как настроена ваша сборка. Повторим, только если эта версия — последняя в ветке.',
  rerunBody: 'Сборка запустится снова на той же версии.',
  rerunPassedWarning:
    'Сборка уже прошла: запустится новая сборка ветки и повторит все автоматические задания — включая выкладку, если вы не запускаете её вручную.',
  cancelBody:
    'Задания, которые ещё идут, остановятся. Выкладка, которая уже началась, может остаться незаконченной.',
  revertTitle: 'Отменить принятые изменения?',
  revertBody:
    'Откроем новый запрос на слияние, который отменяет эти изменения. В основную ветку он попадёт, только когда вы его примете.',
  revertTitleOf: (title: string) => `Отменить «${title}»`,
})
