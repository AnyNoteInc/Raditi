import type { Prisma } from '@repo/db'
import {
  dbPlanSchema,
  dbUndoPlanSchema,
  deployStepCodes,
  RELEASE_API_PREFIX,
  releaseOutcomeOf,
  type DeployDbOperation,
  type FeedReleaseReason,
  type FeedUndoReason,
  type ReleaseKind,
  type ReleaseOutcome,
  type ReleaseStatus,
  type ReleaseStep,
  type ReleaseStepState,
  type RepoRef,
  type SiteStack,
} from '@repo/domain'

// The row of a release as the release skill and the release API read it (docs/plan/53-chat-
// preview-release.md, «Таблицы»): everything is read again from PostgreSQL on every run and
// every call; a job payload or a request carries ids only.

/** How long one run of the skill holds the deploy lease; every run and every report renews it. */
export const RELEASE_LEASE_MS = 10 * 60_000
/** A step the repository or Vault did not answer is tried again after this. */
export const RELEASE_RETRY_MS = 30_000
/** An `approved` release waits this long for a busy site, then it is refused. */
export const RELEASE_SITE_WAIT_MS = 60 * 60_000
/**
 * A release whose database plan production's plugin does not answer for is asked again until
 * this long after the confirmation, then refused (`site_unreachable`): the site is not taken
 * while it waits (docs/plan/53, «Операции БД и миграции»).
 */
export const RELEASE_PRODUCTION_WAIT_MS = 10 * 60_000
/**
 * An `approved` or `publishing` release still not `published` this long after the confirmation
 * gives up: `refused` before `main` moved, `failed` with the revert commit after. Whatever the
 * repository, Vault or S3 kept refusing, the site is not held longer.
 */
export const RELEASE_PUBLISH_GIVE_UP_MS = 2 * 60 * 60_000
/** A repository secret that did not answer is set again after this, doubled per attempt. */
export const RELEASE_SECRET_RETRY_MAX_MS = 10 * 60_000
/**
 * A deploy job silent this long — no report, no call of the release API — loses its token,
 * unless its run still goes (DEPLOY_RUN_CHECK_MS): the wrapping and the secret go, and the
 * release ends `failed` before its first write or `unknown` after it. Every report, the access
 * and the backup move the deadline on.
 */
export const DEPLOY_SILENCE_MS = 30 * 60_000
/**
 * This long before the deadline of a job's token core asks the provider whether the run of the
 * attempt still goes (queued or at work): one that does keeps its token and the lease for
 * another DEPLOY_SILENCE_MS — its job is in a long phase without calls (reading the replaced
 * files, uploading a large backup, writing many files); one that is over without its last
 * report is stopped at once.
 */
export const DEPLOY_RUN_CHECK_MS = 5 * 60_000
/**
 * The longest a run keeps its token by the provider's word, from the first report of its
 * attempt: Gitea ends a task running longer itself (`ENDLESS_TASK_TIMEOUT`, 3 h), so a run still
 * shown at work past this is not believed.
 */
export const DEPLOY_RUN_MAX_MS = 4 * 60 * 60_000
/**
 * A job that reported a write it cannot prove (`unknown`) restores what it wrote right after;
 * its token lives this long for the first report of that rollback (Р31). Silent — the release
 * waits for the operator.
 */
export const UNKNOWN_GRACE_MS = 5 * 60_000
/**
 * `raditi-backups`: the data key of one deploy attempt's backup as Transit wrapped it (`ws-<id>`),
 * next to the backup — what a later attempt of the same release unwraps the backup with.
 */
export const backupKeyObject = (siteId: string, releaseId: string, attempt: number): string =>
  `sites/${siteId.toLowerCase()}/${releaseId.toLowerCase()}/${attempt}/backup.key`
/** `raditi-backups`: the encrypted backup of one deploy attempt (Р30). */
export const backupObject = (siteId: string, releaseId: string, attempt: number): string =>
  `sites/${siteId.toLowerCase()}/${releaseId.toLowerCase()}/${attempt}/backup.tar.zst.enc`
/** The value of the `index`-th operation of the database plan, sealed with the backup key. */
export const dbValueObject = (
  siteId: string,
  releaseId: string,
  attempt: number,
  index: number,
): string => `sites/${siteId.toLowerCase()}/${releaseId.toLowerCase()}/${attempt}/db/${index}.bin`

/**
 * The deploy workflow of `platform/ci` (R8c): started by the release tag, and dispatched on it for
 * an attempt «только возврат» (Р31). The source names the repository of the scoped workflows on
 * the provider of the site's repository.
 */
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml'
export const DEPLOY_WORKFLOW_SOURCE = Object.freeze({ owner: 'platform', name: 'ci' })

/** Codes of `site_releases.error_code`: why a release did not end `installed`. */
export const releaseErrors = Object.freeze({
  /** Core has no git, no release account or no release API. */
  off: 'releases_off',
  /** The approver is no longer an owner or an admin of the workspace. */
  notAllowed: 'not_allowed',
  /** The site is no longer `active`: paused, disconnected or archived by its client. */
  siteInactive: 'site_inactive',
  /** The candidate is not current, its revision changed, or `main` has another tree. */
  outdated: 'candidate_outdated',
  checksFailed: 'checks_failed',
  inProgress: 'release_in_progress',
  siteBusy: 'site_busy',
  /** Not `published` RELEASE_PUBLISH_GIVE_UP_MS after the confirmation. */
  publishTimeout: 'publish_timeout',
  /** The repository refused for good: git or the provider will answer the same again. */
  repositoryRefused: 'repository_refused',
  /** A value the database plan would write holds the value of a client's variable (Р13). */
  clientVariable: 'client_variable',
  /**
   * A value the database plan would write holds a turn credential or names a preview: the
   * preview's plugin stored what the agent's input could not carry (Р3, Р24).
   */
  contentRefused: 'content_refused',
  /**
   * The candidate changes a path publication could not have written — a CI path, a protected
   * one, media outside its add-only folders (rule 6): its head was moved by another than the
   * platform.
   */
  forbiddenPath: 'forbidden_path',
  /** The code of the site lives where a release cannot write (not SFTP or FTP). */
  noHosting: 'hosting_unsupported',
  /**
   * The database plan has an operation the stack does not replay, a value that cannot be read
   * back, or the site has no access for its plugin.
   */
  dbPlan: 'db_plan_unsupported',
  /** `main` stood neither where it was found nor at the release commit. */
  mainMoved: 'main_moved',
  /**
   * «Операции БД и миграции» (docs/plan/53), refusals before `main` moved: production's plugin
   * cannot write a kind or a setting of the plan; an object of the plan no longer holds its base;
   * the address of a new record is taken; the description of the plan the client confirms is
   * missing or refuses a card; a changed file or a value names the preview's number of a new
   * record; production's plugin did not answer in RELEASE_PRODUCTION_WAIT_MS.
   */
  pluginOutdated: 'plugin_outdated',
  dbConflict: 'db_conflict',
  slugTaken: 'slug_taken',
  valuesUnavailable: 'values_unavailable',
  createdIdInCode: 'created_id_in_code',
  siteUnreachable: 'site_unreachable',
  tagRefused: 'tag_refused',
  /** The version's tag names another commit. */
  tagTaken: 'tag_taken',
  /** The repository refused the secret of the deploy job for good. */
  secretRefused: 'secret_refused',
  startTimeout: 'start_timeout',
  silent: 'job_silent',
  /** The job found the files or records it would change different from the installed version. */
  conflict: 'conflict',
  /** The site did not answer, or showed a failure, after the write. */
  verifyFailed: 'verify_failed',
  stepFailed: 'step_failed',
  stepUnknown: 'step_unknown',
  /**
   * «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): the site runs another version than the
   * release undone, or `main` has another tree than it; the plan confirmed is gone, another, or
   * no longer what git and the values say.
   */
  undoOutdated: 'undo_outdated',
  undoPlanChanged: 'undo_plan_changed',
} as const)
export type ReleaseError = (typeof releaseErrors)[keyof typeof releaseErrors]

/**
 * What a report of the deploy job leaves in `site_releases.error_code` when it ends or turns the
 * release: the job's own code (`deployStepCodes`, a word, never a message) — a conflict and a
 * broken site in the words of `releaseErrors` —, else a failed or an unknown step. null for a
 * report that does neither.
 */
export function releaseErrorOfReport(report: {
  state: ReleaseStepState
  detail: { code?: string }
}): string | null {
  if (report.state !== 'failed' && report.state !== 'unknown') return null
  const code = report.detail.code
  if (code === 'conflict') return releaseErrors.conflict
  if (code === 'site_broken') return releaseErrors.verifyFailed
  if (code !== undefined && (deployStepCodes as readonly string[]).includes(code)) return code
  return report.state === 'unknown' ? releaseErrors.stepUnknown : releaseErrors.stepFailed
}

const reasonByError: Readonly<Record<string, FeedReleaseReason | null>> = {
  [releaseErrors.outdated]: 'outdated',
  [releaseErrors.mainMoved]: 'outdated',
  [releaseErrors.conflict]: 'conflict',
  [releaseErrors.startTimeout]: 'not_started',
  [releaseErrors.verifyFailed]: 'site_check',
  [releaseErrors.notAllowed]: 'not_allowed',
  [releaseErrors.checksFailed]: 'checks_failed',
  [releaseErrors.siteInactive]: 'site_inactive',
  [releaseErrors.clientVariable]: 'client_variable',
  // The job's own code (`deployStepCodes`), kept in `error_code` as it is.
  site_broken_before: 'site_broken_before',
  // The readiness's and the job's (`plugin_outdated`): the plan does not fit production.
  [releaseErrors.pluginOutdated]: 'plugin_outdated',
  [releaseErrors.dbConflict]: 'conflict',
  [releaseErrors.slugTaken]: 'slug_taken',
  [releaseErrors.valuesUnavailable]: 'values_unavailable',
  [releaseErrors.createdIdInCode]: 'created_id_in_code',
  [releaseErrors.siteUnreachable]: 'site_unreachable',
}

/** The client's reason of an outcome (`feed.release.reason`); null for `installed`, `unknown`. */
export function feedReasonOf(
  outcome: ReleaseOutcome,
  errorCode: string | null,
): FeedReleaseReason | null {
  if (outcome === 'installed' || outcome === 'unknown') return null
  if (errorCode !== null && errorCode in reasonByError) return reasonByError[errorCode] ?? null
  return 'technical'
}

/**
 * The client's reason of an undo's outcome (`feed.undo.reason`): another version installed is
 * `undo_outdated`; a plan that no longer holds is the site changed meanwhile (`conflict`).
 */
export function feedUndoReasonOf(
  outcome: ReleaseOutcome,
  errorCode: string | null,
): FeedUndoReason | null {
  if (errorCode === releaseErrors.undoOutdated && outcome !== 'installed') return 'undo_outdated'
  if (errorCode === releaseErrors.undoPlanChanged && outcome !== 'installed') return 'conflict'
  return feedReasonOf(outcome, errorCode)
}

export const releaseRowSelect = {
  id: true,
  siteId: true,
  taskId: true,
  kind: true,
  candidateId: true,
  candidateRevision: true,
  undoesReleaseId: true,
  undoPlanId: true,
  undoPlanSha256: true,
  attempt: true,
  version: true,
  tag: true,
  mainBeforeSha: true,
  installedBeforeSha: true,
  approvedSha: true,
  committedAt: true,
  status: true,
  step: true,
  approvedBy: true,
  approvedAt: true,
  deploymentId: true,
  deployAttempt: true,
  deployTokenHash: true,
  deployTokenExpiresAt: true,
  wrapAccessor: true,
  accessIssuedAt: true,
  backupObjectKey: true,
  backupSha256: true,
  backupBytes: true,
  backupVerifiedAt: true,
  mainPushedAt: true,
  revertSha: true,
  leaseEpoch: true,
  enqueues: true,
  errorCode: true,
  task: { select: { workspaceId: true, status: true } },
  site: { select: { stack: true, url: true, installedSha: true, installedReleaseId: true } },
  candidate: { select: { headSha: true, baseTree: true, dbPlan: true } },
  undoPlan: {
    select: {
      id: true,
      releaseId: true,
      status: true,
      installedSha: true,
      targetTree: true,
      files: true,
      items: true,
      dbPlan: true,
      nothingToUndo: true,
      planSha256: true,
    },
  },
  undoes: {
    select: {
      id: true,
      kind: true,
      version: true,
      approvedSha: true,
      installedBeforeSha: true,
      mainBeforeSha: true,
      status: true,
    },
  },
} satisfies Prisma.SiteReleaseSelect

type Selected = Prisma.SiteReleaseGetPayload<{ select: typeof releaseRowSelect }>

export interface ReleaseRow extends Omit<Selected, 'status' | 'step' | 'site' | 'kind'> {
  kind: ReleaseKind
  status: ReleaseStatus
  step: ReleaseStep | null
  site: Omit<Selected['site'], 'stack'> & { stack: SiteStack }
}

/** A release of a candidate: what reads its candidate holds it. */
export type CandidateRelease = ReleaseRow & {
  kind: 'release'
  candidateId: string
  candidateRevision: number
  candidate: NonNullable<ReleaseRow['candidate']>
}
/** The undo of a release: with the plan the client confirmed and the release it undoes. */
export type UndoRelease = ReleaseRow & {
  kind: 'undo'
  undoesReleaseId: string
  undoPlan: NonNullable<ReleaseRow['undoPlan']>
  undoes: NonNullable<ReleaseRow['undoes']>
}

export const isUndo = (row: ReleaseRow): row is UndoRelease =>
  row.kind === 'undo' && row.undoPlan !== null && row.undoes !== null

export const isCandidateRelease = (row: ReleaseRow): row is CandidateRelease =>
  row.kind === 'release' && row.candidate !== null

/**
 * The database writes the deploy job of a row makes, in its order: a release's — its candidate's
 * plan —, or an undo's — the writes of the plan the client confirmed. Throws for a row that is
 * neither: nothing is written for a plan that does not read.
 */
export function deployPlanOf(row: ReleaseRow): DeployDbOperation[] {
  if (isUndo(row)) return dbUndoPlanSchema.parse(row.undoPlan.dbPlan)
  if (isCandidateRelease(row)) return dbPlanSchema.parse(row.candidate.dbPlan)
  throw new Error('A release row with neither a candidate nor a plan of an undo')
}

export async function readReleaseRow(
  db: Pick<Prisma.TransactionClient, 'siteRelease'>,
  releaseId: string,
): Promise<ReleaseRow | null> {
  const row = await db.siteRelease.findUnique({
    where: { id: releaseId },
    select: releaseRowSelect,
  })
  return row as ReleaseRow | null
}

/** The outcome a row stands for; null while the release goes on. */
export const outcomeOfRow = (row: Pick<ReleaseRow, 'status' | 'mainPushedAt'>) =>
  releaseOutcomeOf(row.status, { mainMoved: row.mainPushedAt !== null })

/** The repository of the site and the branch releases go to; null — the site has none. */
export async function siteRepository(
  db: Pick<Prisma.TransactionClient, 'gitRepository'>,
  siteId: string,
): Promise<{ repo: RepoRef; branch: string } | null> {
  const repository = await db.gitRepository.findFirst({
    where: { siteId },
    orderBy: { createdAt: 'asc' },
    select: { provider: true, owner: true, name: true, defaultBranch: true },
  })
  return repository
    ? {
        repo: { provider: repository.provider, owner: repository.owner, name: repository.name },
        branch: repository.defaultBranch,
      }
    : null
}

/**
 * Releases of a site past their readiness and not ended: at most one at a time (Р27). An
 * `approved` release waits for the lease, so it does not count against another.
 */
export const openReleaseStatuses = [
  'publishing',
  'published',
  'deploying',
  'verifying',
  'rolling_back',
  'unknown',
] as const satisfies readonly ReleaseStatus[]

/**
 * The access of the hosting a release writes through, by where the code of the site lives
 * (`site_code_sources.kind`): SFTP reads `kv/sites/<id>/ssh`, FTP `kv/sites/<id>/ftp`. null — a
 * release cannot write there (a git repository of the client).
 */
export function hostingAccessKind(kind: string): 'ssh' | 'ftp' | null {
  return kind === 'sftp' ? 'ssh' : kind === 'ftp' ? 'ftp' : null
}

/** What the hosting held before the release: the installed version, or `main` as it was found. */
export const installedBaseOf = (row: Pick<ReleaseRow, 'installedBeforeSha' | 'mainBeforeSha'>) =>
  row.installedBeforeSha ?? row.mainBeforeSha

/**
 * The value of the `index`-th operation of the database plan, as the release API hands it to
 * the job of the attempt (`GET …/values/<index>`, Bearer token of the attempt): served from
 * `raditi-backups` on each call, so it does not expire while the job reads the hosting first.
 */
export const releaseValuePath = (releaseId: string, index: number): string =>
  `${RELEASE_API_PREFIX}/${releaseId.toLowerCase()}/values/${index}`
