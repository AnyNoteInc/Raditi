import { createHash, randomBytes } from 'node:crypto'

import { Logger } from '@nestjs/common'
import {
  holdReleaseForOperator,
  ownsReleaseLease,
  raiseReleaseBarrier,
  recordReleaseLease,
  releaseAttemptWrote,
  releaseWritingAttempt,
  renewReleaseLease,
  takeOverReleaseLease,
  wakeRelease,
  type PrismaClient,
  type Prisma,
  type ReleaseLease,
} from '@repo/db'
import {
  additiveChange,
  addOnlyPathOf,
  anyDepthPatterns,
  candidateFactsSchema,
  candidateFilesSchema,
  candidateMediaSchema,
  conflict,
  containsEnvValue,
  DEPLOY_WRAP_SECRET_NAME,
  DEPLOY_WRAP_TTL_SECONDS,
  dbPlanSchema,
  dbPlanViewRefusal,
  dbSettingValueAllowed,
  dbSlugSchema,
  dbStateHashMaterial,
  dbStateTexts,
  dbUndoPlanSchema,
  formatDeployWrap,
  isCreatedRef,
  isDomainError,
  isForbiddenPath,
  isOptionState,
  isRecordState,
  isTableState,
  leaseLost,
  legacySiteDbCapabilities,
  mentionsCreatedId,
  optionNameOf,
  recordIdOf,
  recordTypeOf,
  workspaceTransitKey,
  type DbObjectState,
  type DbOperation,
  type DbSetting,
  type DbUndoOperation,
  type DeployValue,
  type DeployWrapData,
  type GitProvider,
  type ObjectStorage,
  type ReleaseAdvanceJob,
  type ReleaseStatus,
  type RepoRef,
  type SecretStore,
  type SiteAccessKind,
  type SiteAdapter,
  type SiteContentGateway,
  type SiteLeaseGrant,
  type SiteLeaseStore,
  type SiteStack,
  type WorkflowRun,
} from '@repo/domain'

import { z } from 'zod'
import { readSiteEnvValuesToRefuse } from '@repo/turn-keys'
import { publishedValueRefusal } from '@repo/site-content'

import { contentCallId, createdHashOf } from '../deploy-step/content.ts'
import {
  releaseCommit,
  revertCommit,
  undoCommit,
  type ReleaseGit,
  type TrustedCommitInput,
} from '../git-workspace/release-git.ts'
import {
  sealDbOperationValue,
  sealDeployValue,
  undoOperationPayload,
  type DbOperationStates,
  type DbPlanValueReader,
} from './release-db-values.ts'
import {
  closeInstalledDialog,
  endInstalled,
  endWithoutInstall,
  EndLater,
  holdForOperator,
} from './release-outcome.ts'
import {
  backupKeyObject,
  dbValueObject,
  DEPLOY_RUN_CHECK_MS,
  DEPLOY_RUN_MAX_MS,
  DEPLOY_SILENCE_MS,
  DEPLOY_WORKFLOW_FILE,
  DEPLOY_WORKFLOW_SOURCE,
  hostingAccessKind,
  installedBaseOf,
  isCandidateRelease,
  isUndo,
  openReleaseStatuses,
  outcomeOfRow,
  readReleaseRow,
  RELEASE_LEASE_MS,
  RELEASE_PRODUCTION_WAIT_MS,
  RELEASE_PUBLISH_GIVE_UP_MS,
  RELEASE_RETRY_MS,
  RELEASE_SECRET_RETRY_MAX_MS,
  RELEASE_SITE_WAIT_MS,
  releaseErrors,
  siteRepository,
  type CandidateRelease,
  type ReleaseError,
  type ReleaseRow,
  type UndoRelease,
} from './release-row.ts'

/**
 * The plan a release carries (docs/plan/53, «Операции БД и миграции»): every operation of a kind
 * the stack's adapter declares, in the one order of a plan. null — another plan: the readiness
 * refuses it `db_plan_unsupported`, before `main` moves.
 */
function releasablePlan(value: unknown, kinds: readonly string[]): DbOperation[] | null {
  const plan = dbPlanSchema.safeParse(value)
  if (!plan.success) return null
  return plan.data.every((operation) => kinds.includes(operation.kind)) ? plan.data : null
}
/**
 * The texts the write of an operation puts on production, once its states are of its kind and
 * its value one of the kind: a text change's fields, a setting's value, a new record's fields and
 * address, a table's name with the names and defaults of its columns and indexes (`dbStateTexts`,
 * the list the description is checked by). null — a state of another kind, a setting off the adapter's
 * list or not in its spelling, a creation of no plan's record or at an address off the rule, a
 * table change that is not an addition.
 */
function valueTexts(
  operation: DbOperation,
  states: DbOperationStates,
  settings: readonly DbSetting[],
): string[] | null {
  const { after, before } = states
  switch (operation.kind) {
    case 'content_update':
      return isRecordState(after) ? operation.fields.map((field) => after[field]) : null
    case 'option_update': {
      const setting = settings.find((item) => item.option === optionNameOf(operation.objectRef))
      return isOptionState(after) &&
        after.value !== null &&
        setting !== undefined &&
        dbSettingValueAllowed(setting, after.value)
        ? [after.value]
        : null
    }
    case 'post_create':
      return isRecordState(after) &&
        isCreatedRef(operation.objectRef) &&
        after.slug !== undefined &&
        dbSlugSchema.safeParse(after.slug).success
        ? dbStateTexts(after)
        : null
    case 'schema_migration': {
      if (!before || !isTableState(before) || !isTableState(after)) return null
      if (!after.exists || !after.managed || !after.definition) return null
      if (before.exists && (!before.managed || !before.definition)) return null
      const change = additiveChange(before.exists ? before.definition : null, after.definition)
      if (change !== 'create' && change !== 'add') return null
      // The names the plugin creates as they are, beside the defaults it writes.
      return dbStateTexts(after)
    }
  }
}

/** The pattern of the version tags the release account alone may write (Р26). */
export const RELEASE_TAG_PATTERN = 'v*'
/** A charge refused for another reason than open usage is given up after this (R3 does the same). */
const CHARGE_GIVE_UP_MS = 2 * 60 * 60_000

export interface ReleaseSkillDependencies {
  db: PrismaClient
  leases: Pick<SiteLeaseStore, 'acquire' | 'release'>
  /** null while git is not configured in core: no release can be published. */
  git: ReleaseGit | null
  /**
   * The provider as the release account (the owner of the organization, Р35): tags, their
   * protection and the secrets of a repository; and the runs of the deploy workflow. null
   * without git.
   */
  provider: Pick<
    GitProvider,
    | 'protectTags'
    | 'createTag'
    | 'getTag'
    | 'setActionsSecret'
    | 'deleteActionsSecret'
    | 'dispatchWorkflow'
    | 'listWorkflowRuns'
    | 'getWorkflowRun'
  > | null
  /** Vault: the deploy wrapping, the backup's data key, and the values of the site's variables. */
  secrets: Pick<
    SecretStore,
    'wrap' | 'revokeAccessor' | 'transitDataKey' | 'transitDecryptDataKey' | 'kvRead'
  >
  storage: Pick<ObjectStorage, 'putIfAbsent' | 'get'>
  adapter: (
    stack: SiteStack,
  ) => Pick<SiteAdapter, 'dbOperationKinds' | 'dbSettings' | 'protectedPaths' | 'mediaRules'>
  /**
   * The content gateway of production through its plugin (the site's `wp` access, the address
   * rule of a site): the readiness reads what a plan's preconditions say before `main` moves.
   * null — not configured here, and a candidate with a database plan is refused.
   */
  production: ProductionContent | null
  /**
   * The kind of access the content plugin of a stack reads (`SiteContentAdapter.accessKind`);
   * throws for a stack without one. A release with a database plan needs it.
   */
  contentAccessKind: (stack: SiteStack) => SiteAccessKind
  /**
   * The release API deploy jobs call; null — RELEASE_API_HOST is unset, and every release is
   * refused before `main` moves.
   */
  api: { startTimeoutMs: number } | null
  /**
   * The values of a candidate's database plan, read back from the preview's snapshots (R5c);
   * null — no reader, and a candidate with a plan is refused before `main` moves.
   */
  values: DbPlanValueReader | null
  /**
   * PREVIEW_BASE_DOMAIN: a value of the plan that names any preview of it never reaches
   * production. null — previews are not configured here.
   */
  previewBaseDomain: string | null
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void }
  now?: () => Date
}

/** The content gateway of a site's production, as core reaches it. */
export type ProductionContent = (scope: {
  workspaceId: string
  siteId: string
  stack: SiteStack
  url: string
}) => Promise<SiteContentGateway>

/**
 * A step outside PostgreSQL did not answer: the run ends and the release is woken later —
 * after RELEASE_RETRY_MS unless the step names its own wait.
 */
class Later extends Error {
  constructor(
    readonly reason: string,
    readonly delayMs: number = RELEASE_RETRY_MS,
  ) {
    super(`The release waits: ${reason}`)
  }
}

/**
 * A refusal that will not change on a retry: before `main` moved the release is `refused`,
 * after it `failed` with the revert commit.
 */
class Refused extends Error {
  constructor(readonly code: ReleaseError) {
    super(`The release is refused: ${code}`)
  }
}

/**
 * A refusal that a retry will meet again: the provider's final answer (R8a: `details.reason`),
 * a release account without its token in Vault (GIT_PROVIDER_NOT_CONFIGURED), or a request git
 * or the repository rejects as it stands (4xx: invalid, forbidden, not found). An error without
 * either — no answer, a timeout, a 5xx — may pass on a retry.
 */
export const isFinalRefusal = (error: unknown): boolean => {
  if (!isDomainError(error) || error.code === 'LEASE_LOST') return false
  if (error.code === 'GIT_PROVIDER_NOT_CONFIGURED') return true
  if (typeof (error.details as { reason?: unknown } | undefined)?.reason === 'string') return true
  return error.httpStatus >= 400 && error.httpStatus < 500
}

/** What the provider says of the run of a deploy attempt; null — it cannot tell. */
type RunState = 'running' | 'over' | null

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * The release skill of core (docs/plan/53-chat-preview-release.md, Р25–Р31, R8b): the processor
 * of `release.advance` calls it with the id of a release, and it moves the release as far as it
 * can from what its row says — never from the job. Under the site lease `deploy`, which each run
 * takes over at the next epoch, so an older run still going stops at its next fence:
 *
 *   approved    rights and readiness under the lease (the site `active`, the values of the
 *               database plan free of the client's variables, the protection of `v*`), then the
 *               barrier `inflight_release_id`; a refusal ends `failed` before `main` moved
 *               (`refused`)
 *   publishing  the deterministic release commit (stored before the push), `main` by CAS; then,
 *               unless the tag exists already, a new deploy attempt is armed — its token, the
 *               values of the database plan sealed with the attempt's backup key, the wrapping of
 *               token and key, the repository secret — and the tag is made last: the run of the
 *               deploy job finds its secret. Not `published` RELEASE_PUBLISH_GIVE_UP_MS after the
 *               confirmation — it gives up
 *   published   waits for the job's first report; silent past RELEASE_START_TIMEOUT_MINUTES —
 *               revoked, `failed` without a write
 *   deploying … the job reports through the release API; a job silent to its deadline is
 *               stopped, unless the provider shows its run still going
 *   unknown     waits while the job may still report its rollback (UNKNOWN_GRACE_MS), and while
 *               the run that wrote still goes; then one attempt «только возврат»
 *   ended       the way in is closed (token, wrapping, secret); `main` gets the revert commit
 *               unless `installed` — one that cannot land leaves the site to the operator; the
 *               barrier and the lease go with the dialog's move, its credits and the feed row;
 *               `installed` charges the dialog in a second transaction; `unknown` keeps both for
 *               the operator.
 */
export class ReleaseSkill {
  readonly #logger: NonNullable<ReleaseSkillDependencies['logger']>
  readonly #now: () => Date

  constructor(private readonly deps: ReleaseSkillDependencies) {
    this.#logger = deps.logger ?? new Logger('ReleaseSkill')
    this.#now = deps.now ?? (() => new Date())
  }

  async advance(job: Pick<ReleaseAdvanceJob, 'releaseId' | 'seq'>): Promise<void> {
    const row = await readReleaseRow(this.deps.db, job.releaseId)
    if (!row) return
    try {
      await this.#advance(row, job.seq)
    } catch (error) {
      if (error instanceof Later || error instanceof EndLater) {
        this.#logger.warn(`release_later release=${row.id} reason=${error.reason}`)
        await this.#wake(row.id, error instanceof Later ? error.delayMs : RELEASE_RETRY_MS)
        return
      }
      // A newer run took the release over: it goes on from the row.
      if (isDomainError(error) && error.code === 'LEASE_LOST') {
        this.#logger.warn(`release_lease_moved release=${row.id}`)
        return
      }
      throw error
    }
  }

  async #advance(row: ReleaseRow, seq: number): Promise<void> {
    switch (row.status) {
      case 'approved':
        return this.#start(row)
      case 'publishing':
        return this.#publish(row)
      case 'published':
        return this.#awaitStart(row, seq)
      case 'deploying':
      case 'verifying':
      case 'rolling_back':
        return this.#watch(row, seq)
      case 'unknown':
        return this.#awaitOperator(row, seq)
      case 'installed':
      case 'rolled_back':
      case 'failed':
        return this.#end(row)
    }
  }

  // -------------------------------------------------------------------------------------------
  // approved → publishing
  // -------------------------------------------------------------------------------------------

  async #start(row: ReleaseRow): Promise<void> {
    const { git, provider, api } = this.deps
    let lease: { epoch: number } | null =
      row.leaseEpoch > 0
        ? await takeOverReleaseLease(this.deps.db, { releaseId: row.id, ttlMs: RELEASE_LEASE_MS })
        : null
    // Releases are off here: a lease an earlier run recorded is taken over first, so the
    // refusal frees it and wakes the passes that wait for the site.
    if (!git || !provider || !api) return this.#refuse(row, lease?.epoch ?? null, releaseErrors.off)
    // The values of the database plan read back and checked, and production asked whether the
    // plan still fits it, before the site is taken: a production that does not answer holds no
    // turn of another dialog (Later), and what it answers decides nothing yet — the deploy job
    // checks it again under the lease, and its check decides. An undo reads the values of the
    // release it undoes: core checked production when it made the plan, the job checks it again.
    try {
      if (isUndo(row)) await this.#readUndoValues(row)
      else if (isCandidateRelease(row)) {
        const plan = releasablePlan(row.candidate.dbPlan, this.#dbOperationKinds(row))
        if (plan !== null && plan.length > 0 && this.deps.values) {
          const states = await this.#readValues(row, plan)
          const refusal = await this.#productionCheck(row, plan, states)
          if (refusal !== null) return this.#refuse(row, lease?.epoch ?? null, refusal)
        }
      } else throw new Refused(releaseErrors.dbPlan)
    } catch (error) {
      if (error instanceof Refused) return this.#refuse(row, lease?.epoch ?? null, error.code)
      throw error
    }
    /** The lease this run acquired itself: released again when the release moved on meanwhile. */
    let acquired: SiteLeaseGrant | null = null
    if (!lease) {
      const grant = await this.deps.leases.acquire({
        siteId: row.siteId,
        taskId: row.taskId,
        operation: 'deploy',
        ttlMs: RELEASE_LEASE_MS,
      })
      if (!grant) return this.#siteBusy(row)
      if (!(await recordReleaseLease(this.deps.db, { releaseId: row.id, epoch: grant.epoch }))) {
        // Another run moved the release on meanwhile: this lease is nobody's.
        await this.deps.leases.release(grant).catch(() => false)
        return
      }
      lease = grant
      acquired = grant
    }
    if (this.#pastGiveUp(row)) return this.#refuse(row, lease.epoch, releaseErrors.publishTimeout)
    try {
      const repository = await siteRepository(this.deps.db, row.siteId)
      if (!repository) throw new Refused(releaseErrors.off)
      // Read outside the transaction; the transaction compares and decides.
      const head = await this.#git('main', () => git.readBranchHead(repository))
      if (!head) throw new Refused(releaseErrors.outdated)
      const main = {
        head,
        tree: await this.#git('main', () => git.treeOf({ repo: repository.repo, sha: head })),
      }
      // An undo: the tree of the release it undoes, which `main` must hold (Р27).
      const undone = isUndo(row) ? row.undoes.approvedSha : null
      const undoneTree =
        undone === null
          ? null
          : await this.#git('main', () => git.treeOf({ repo: repository.repo, sha: undone }))
      // Only the release account writes `v*` (R8a); idempotent, and `main` has not moved yet.
      await this.#provider('protect_tags', releaseErrors.tagRefused, () =>
        provider.protectTags(repository.repo, RELEASE_TAG_PATTERN),
      )
      const refusal = await this.#ready(row, lease.epoch, main, undoneTree)
      if (refusal === 'gone') {
        // The release moved on without this run: a lease it acquired itself is nobody's.
        if (acquired) await this.deps.leases.release(acquired).catch(() => false)
        return
      }
      if (refusal !== null) return this.#refuse(row, lease.epoch, refusal, main.tree)
    } catch (error) {
      if (error instanceof Refused) return this.#refuse(row, lease.epoch, error.code)
      throw error
    }
    const next = await readReleaseRow(this.deps.db, row.id)
    if (next?.status === 'publishing') await this.#publish(next)
  }

  /**
   * Readiness under the lease (Р27): the approver may still release, the candidate is current
   * with its revision, no check failed, its base has the tree `main` has now, no other release
   * of the site is under way, and the site has what the release needs. Ready — the barrier is
   * raised and the release is `publishing` against `main` as found. A refusal is returned, not
   * written.
   */
  async #ready(
    row: ReleaseRow,
    epoch: number,
    main: { head: string; tree: string },
    undoneTree: string | null,
  ): Promise<ReleaseError | 'gone' | null> {
    return this.deps.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: ReleaseStatus; lease_epoch: number }>>`
        SELECT status::text AS status, lease_epoch FROM site_releases
        WHERE id = ${row.id}::uuid FOR UPDATE`
      if (locked[0]?.status !== 'approved' || locked[0].lease_epoch !== epoch) return 'gone'
      const refusal = isUndo(row)
        ? await this.#readinessUndo(tx, row, main, undoneTree)
        : isCandidateRelease(row)
          ? await this.#readiness(tx, row, main)
          : releaseErrors.dbPlan
      if (refusal !== null) return refusal
      if (!(await raiseReleaseBarrier(tx, { releaseId: row.id, epoch }))) throw new Later('barrier')
      await tx.$queryRaw`
        UPDATE site_releases SET status = 'publishing', main_before_sha = ${main.head},
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid
        RETURNING id`
      return null
    })
  }

  /** The approver is still an owner or an admin of the workspace (Р25). */
  async #approverAllowed(tx: Prisma.TransactionClient, row: ReleaseRow): Promise<boolean> {
    const member = row.approvedBy
      ? await tx.member.findUnique({
          where: {
            workspaceId_userId: { workspaceId: row.task.workspaceId, userId: row.approvedBy },
          },
          select: { role: true },
        })
      : null
    return member?.role === 'owner' || member?.role === 'admin'
  }

  /**
   * The readiness of an undo (docs/plan/53, «Отмена выпуска»): the site still runs the release it
   * undoes and `main` holds its tree; the plan is the one the client confirmed, ready, of that
   * release and made against its commit; no other release goes on; the site has the access the
   * undo writes with.
   */
  async #readinessUndo(
    tx: Prisma.TransactionClient,
    row: UndoRelease,
    main: { tree: string },
    undoneTree: string | null,
  ): Promise<ReleaseError | null> {
    const site = await tx.site.findUnique({
      where: { id: row.siteId },
      select: { status: true, installedReleaseId: true, installedSha: true },
    })
    if (site?.status !== 'active') return releaseErrors.siteInactive
    if (!(await this.#approverAllowed(tx, row))) return releaseErrors.notAllowed
    if (
      row.undoes.kind !== 'release' ||
      site.installedReleaseId !== row.undoesReleaseId ||
      site.installedSha !== row.undoes.approvedSha ||
      undoneTree === null ||
      main.tree !== undoneTree
    )
      return releaseErrors.undoOutdated
    const plan = await tx.releaseUndoPlan.findUnique({
      where: { id: row.undoPlan.id },
      select: {
        status: true,
        releaseId: true,
        installedSha: true,
        planSha256: true,
        nothingToUndo: true,
      },
    })
    if (
      plan?.status !== 'ready' ||
      plan.releaseId !== row.undoesReleaseId ||
      plan.installedSha !== row.undoes.approvedSha ||
      plan.planSha256 !== row.undoPlanSha256 ||
      plan.nothingToUndo
    )
      return releaseErrors.undoPlanChanged
    if ((await this.#othersUnderWay(tx, row)) > 0) return releaseErrors.inProgress
    const source = await tx.siteCodeSource.findUnique({
      where: { siteId: row.siteId },
      select: { kind: true },
    })
    const hosting = source ? hostingAccessKind(source.kind) : null
    if (hosting === null || !(await this.#hasAccess(tx, row.siteId, hosting)))
      return releaseErrors.noHosting
    const writes = dbUndoPlanSchema.safeParse(row.undoPlan.dbPlan)
    if (!writes.success) return releaseErrors.undoPlanChanged
    if (writes.data.length > 0) {
      const content = this.#contentAccessKind(row.site.stack)
      if (
        !this.deps.values ||
        content === null ||
        !(await this.#hasAccess(tx, row.siteId, content))
      )
        return releaseErrors.dbPlan
    }
    return null
  }

  async #readiness(
    tx: Prisma.TransactionClient,
    row: CandidateRelease,
    main: { tree: string },
  ): Promise<ReleaseError | null> {
    // The client paused, disconnected or archived the site after the dialog began.
    const site = await tx.site.findUnique({ where: { id: row.siteId }, select: { status: true } })
    if (site?.status !== 'active') return releaseErrors.siteInactive
    if (!(await this.#approverAllowed(tx, row))) return releaseErrors.notAllowed
    const candidate = await tx.taskCandidate.findUnique({
      where: { id: row.candidateId },
      select: {
        status: true,
        revision: true,
        baseTree: true,
        dbPlan: true,
        dbPlanSha256: true,
        dbView: true,
        facts: true,
        files: true,
        media: true,
      },
    })
    if (
      !candidate ||
      candidate.status !== 'current' ||
      candidate.revision !== row.candidateRevision ||
      candidate.baseTree !== main.tree
    )
      return releaseErrors.outdated
    if (!this.#pathsAllowed(row, candidate.files, candidate.media))
      return releaseErrors.forbiddenPath
    const failedChecks = await tx.candidateCheck.count({
      where: { candidateId: row.candidateId, status: 'failed' },
    })
    if (failedChecks > 0) return releaseErrors.checksFailed
    if ((await this.#othersUnderWay(tx, row)) > 0) return releaseErrors.inProgress
    const source = await tx.siteCodeSource.findUnique({
      where: { siteId: row.siteId },
      select: { kind: true },
    })
    const hosting = source ? hostingAccessKind(source.kind) : null
    if (hosting === null || !(await this.#hasAccess(tx, row.siteId, hosting)))
      return releaseErrors.noHosting
    const plan = releasablePlan(candidate.dbPlan, this.#dbOperationKinds(row))
    if (plan === null) return releaseErrors.dbPlan
    // A file that names the preview's number of a new record would point at nothing on
    // production, where the record gets another (`createdIdFiles`, counted by core).
    const counted = z
      .object({ createdIdFiles: candidateFactsSchema.shape.createdIdFiles })
      .safeParse(candidate.facts)
    if (!counted.success || counted.data.createdIdFiles > 0) return releaseErrors.createdIdInCode
    if (plan.length > 0) {
      const content = this.#contentAccessKind(row.site.stack)
      if (
        !this.deps.values ||
        !this.deps.production ||
        content === null ||
        !(await this.#hasAccess(tx, row.siteId, content))
      )
        return releaseErrors.dbPlan
      return this.#viewRefusal(candidate.dbView, candidate.dbPlanSha256, plan.length)
    }
    return null
  }

  /**
   * The client confirms what they were shown (docs/plan/53, «Операции БД и миграции»): a plan
   * whose description is missing, of another plan, or did not fit is not released; neither is
   * one with a card the description refused — a value of the client's variable, more links than
   * a card says, a table change that is not an addition.
   */
  #viewRefusal(
    stored: unknown,
    planSha256: string | null,
    operations: number,
  ): ReleaseError | null {
    // The rule the release window refuses `/release` by (dbPlanViewRefusal).
    const refusal = dbPlanViewRefusal(stored, { sha256: planSha256, operations })
    if (refusal === null) return null
    return refusal === 'client_variable'
      ? releaseErrors.clientVariable
      : releaseErrors.valuesUnavailable
  }

  /** Other releases of the site past their readiness and not ended: one at a time (Р27). */
  #othersUnderWay(db: Pick<Prisma.TransactionClient, 'siteRelease'>, row: ReleaseRow) {
    return db.siteRelease.count({
      where: { siteId: row.siteId, id: { not: row.id }, status: { in: [...openReleaseStatuses] } },
    })
  }

  async #hasAccess(
    tx: Pick<Prisma.TransactionClient, 'credentialRef'>,
    siteId: string,
    kind: SiteAccessKind,
  ): Promise<boolean> {
    return (await tx.credentialRef.count({ where: { siteId, kind } })) === 1
  }

  /**
   * The second line of rule 6: the release commit changes, against `main`, the candidate's files
   * and adds its media — and none of them may be a path publication could not have written (a
   * CI path, a protected one, media outside its add-only folders or named by a protected pattern
   * at any depth). The trusted side built the
   * candidate from its commits, but the head of `agent/<taskId>` is the only thing it checks
   * them against, and a head that someone else moved would be released as it is.
   */
  #pathsAllowed(row: ReleaseRow, files: unknown, media: unknown): boolean {
    const changed = candidateFilesSchema.safeParse(files)
    const added = candidateMediaSchema.safeParse(media)
    if (!changed.success || !added.success) return false
    const rules = this.#pathRules(row)
    if (rules === null) return false
    const { protectedPaths, addOnlyPaths } = rules
    return (
      changed.data.every((file) => !isForbiddenPath(file.path, protectedPaths)) &&
      added.data.every(
        (file) =>
          addOnlyPathOf(file.path, addOnlyPaths) !== undefined &&
          !isForbiddenPath(file.path, anyDepthPatterns(protectedPaths)),
      )
    )
  }

  /** The paths a release may not write (rule 6) and where it only adds media; null — unknown. */
  #pathRules(
    row: ReleaseRow,
  ): { protectedPaths: string[]; addOnlyPaths: readonly string[] } | null {
    const site = { stack: row.site.stack, url: row.site.url, docroot: '/', extras: {} }
    try {
      const adapter = this.deps.adapter(row.site.stack)
      const protectedPaths = adapter.protectedPaths(site)
      let addOnlyPaths: readonly string[] = []
      try {
        addOnlyPaths = adapter.mediaRules(site).addOnlyPaths
      } catch (error) {
        // A stack without media rules adds no media.
        if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
      }
      return { protectedPaths, addOnlyPaths }
    } catch {
      return null
    }
  }

  #dbOperationKinds(row: ReleaseRow): readonly string[] {
    try {
      const adapter = this.deps.adapter(row.site.stack)
      return adapter.dbOperationKinds({
        stack: row.site.stack,
        url: row.site.url,
        docroot: '/',
        extras: {},
      })
    } catch {
      return []
    }
  }

  #contentAccessKind(stack: SiteStack): SiteAccessKind | null {
    try {
      return this.deps.contentAccessKind(stack)
    } catch {
      return null
    }
  }

  /**
   * The values of the plan as the preview's snapshots keep them — each `after`, and a table's
   * `before` (said whole to the plugin) —, each hash worked out again from its fields, each value
   * checked as one of its kind (docs/plan/53, «Операции БД и миграции»): a setting of the
   * adapter's list in its own spelling, a new record at an address of the rule, a table changed
   * by additions alone. Then against the rules of published content and the values of the site's
   * variables (Р13: nothing the platform writes to production holds one). The preview runs the
   * agent's code, so what its plugin said it stored proves nothing: a value with a turn
   * credential or the address of a preview is Refused (`content_refused`), one that names the
   * preview's number of a new record of the plan Refused (`created_id_in_code` — production gives
   * the record another), one that does not verify Refused (`db_plan_unsupported`), one that holds
   * a variable Refused (`client_variable`); the markup is the production plugin's to check, it
   * writes them in its mode `release` (Р30). Storage or Vault that did not answer is Later.
   */
  async #readValues(row: ReleaseRow, plan: readonly DbOperation[]): Promise<DbOperationStates[]> {
    const reader = this.deps.values
    if (!reader) throw new Refused(releaseErrors.dbPlan)
    const owner = { workspaceId: row.task.workspaceId, taskId: row.taskId }
    const read = async (
      operation: DbOperation,
      side: 'before' | 'after',
    ): Promise<DbObjectState> => {
      let state: DbObjectState
      try {
        state = (await reader.readState(owner, operation.objectRef, side, operation[side])).state
      } catch (error) {
        if (isDomainError(error) && error.httpStatus === 409)
          throw new Refused(releaseErrors.dbPlan)
        throw new Later('db_values')
      }
      const expected = side === 'after' ? operation.afterHash : operation.beforeHash
      if (sha256(dbStateHashMaterial(state)) !== state.stateHash || state.stateHash !== expected)
        throw new Refused(releaseErrors.dbPlan)
      return state
    }
    const settings = this.#dbSettings(row)
    const states: DbOperationStates[] = []
    const written: string[] = []
    for (const operation of plan) {
      const after = await read(operation, 'after')
      const before = operation.kind === 'schema_migration' ? await read(operation, 'before') : null
      const texts = valueTexts(operation, { after, before }, settings)
      if (texts === null) throw new Refused(releaseErrors.dbPlan)
      written.push(...texts)
      states.push({ after, before })
    }
    const previews = { baseDomain: this.deps.previewBaseDomain }
    if (written.some((text) => publishedValueRefusal(text, previews) !== null))
      throw new Refused(releaseErrors.contentRefused)
    const created = plan.flatMap((operation) =>
      isCreatedRef(operation.objectRef) ? [recordIdOf(operation.objectRef)!] : [],
    )
    if (written.some((text) => mentionsCreatedId(text, created)))
      throw new Refused(releaseErrors.createdIdInCode)
    const values = await this.#clientValues(row)
    if (written.some((text) => containsEnvValue(text, values)))
      throw new Refused(releaseErrors.clientVariable)
    return states
  }

  /**
   * The values an undo writes (docs/plan/53, «Отмена выпуска»): what production held before the
   * release it undoes — the `before` side of each operation of that release's plan, as the
   * preview's journal sealed it — each hash worked out again from its fields and equal to the hash
   * the undo writes (the release proved it on production with its precondition); a record the
   * release created is named by its address in the `after` side and by the mark of the creation,
   * and that record re-keyed under production's reference must be the state the undo trashes. A
   * value with a turn credential or the address of a preview is Refused as for a release
   * (`content_refused`); one that does not verify — the plan is not the one these values make —
   * Refused (`undo_plan_changed`). Storage or Vault that did not answer is Later.
   */
  async #readUndoValues(row: UndoRelease): Promise<DeployValue<DbUndoOperation['kind']>[]> {
    const writes = dbUndoPlanSchema.safeParse(row.undoPlan.dbPlan)
    if (!writes.success) throw new Refused(releaseErrors.undoPlanChanged)
    if (writes.data.length === 0) return []
    const reader = this.deps.values
    if (!reader) throw new Refused(releaseErrors.dbPlan)
    const owner = { workspaceId: row.task.workspaceId, taskId: row.taskId }
    const writing = await releaseWritingAttempt(this.deps.db, { releaseId: row.undoesReleaseId })
    const payloads: DeployValue<DbUndoOperation['kind']>[] = []
    const written: string[] = []
    for (const operation of writes.data) {
      const trash = operation.kind === 'post_trash'
      let state: DbObjectState
      try {
        state = (
          await reader.readState(
            owner,
            trash ? operation.createdRef : operation.objectRef,
            trash ? 'after' : 'before',
            trash ? operation.before : operation.after,
          )
        ).state
      } catch (error) {
        if (isDomainError(error) && error.httpStatus === 409)
          throw new Refused(releaseErrors.undoPlanChanged)
        throw new Later('db_values')
      }
      if (sha256(dbStateHashMaterial(state)) !== state.stateHash)
        throw new Refused(releaseErrors.undoPlanChanged)
      if (operation.kind === 'post_trash') {
        if (
          !isRecordState(state) ||
          state.slug === undefined ||
          writing === null ||
          createdHashOf(operation.objectRef, {
            status: state.status ?? 'publish',
            slug: state.slug,
            title: state.title,
            content: state.content,
            excerpt: state.excerpt,
          }) !== operation.beforeHash
        )
          throw new Refused(releaseErrors.undoPlanChanged)
        payloads.push(
          undoOperationPayload(
            operation,
            state,
            contentCallId(row.undoesReleaseId, writing, operation.createdRef, 'apply'),
          ),
        )
        continue
      }
      if (state.stateHash !== operation.afterHash) throw new Refused(releaseErrors.undoPlanChanged)
      const payload = undoOperationPayload(operation, state)
      payloads.push(payload)
      if ('fields' in payload) written.push(...Object.values(payload.fields))
      else if ('value' in payload && payload.value !== null) written.push(payload.value)
    }
    const previews = { baseDomain: this.deps.previewBaseDomain }
    if (written.some((text) => publishedValueRefusal(text, previews) !== null))
      throw new Refused(releaseErrors.contentRefused)
    return payloads
  }

  /**
   * Production through its plugin, before the site is taken and `main` moves (docs/plan/53,
   * «Операции БД и миграции»): its plugin writes every kind of the plan and every setting of it
   * (`plugin_outdated` otherwise), each object holds the base of its operation — a table may
   * hold its result already (`db_conflict` otherwise) —, and the address of each new record is
   * free (`slug_taken`). A refusal leaves `main`, the tag and the number as they were. A
   * production that does not answer is asked again until RELEASE_PRODUCTION_WAIT_MS after the
   * confirmation, then the release is refused (`site_unreachable`).
   */
  async #productionCheck(
    row: ReleaseRow,
    plan: readonly DbOperation[],
    states: readonly DbOperationStates[],
  ): Promise<ReleaseError | null> {
    const production = this.deps.production
    if (!production) return releaseErrors.dbPlan
    const unreachable = (): never => {
      if (this.#now().getTime() - row.approvedAt.getTime() > RELEASE_PRODUCTION_WAIT_MS)
        throw new Refused(releaseErrors.siteUnreachable)
      throw new Later('production')
    }
    let gateway: SiteContentGateway
    try {
      gateway = await production({
        workspaceId: row.task.workspaceId,
        siteId: row.siteId,
        stack: row.site.stack,
        url: row.site.url,
      })
    } catch {
      return unreachable()
    }
    const kinds = new Set(plan.map((operation) => operation.kind))
    const db = gateway.db
    if ([...kinds].some((kind) => kind !== 'content_update')) {
      if (!db) return releaseErrors.pluginOutdated
      let capabilities = legacySiteDbCapabilities
      try {
        capabilities = await db.capabilities()
      } catch {
        return unreachable()
      }
      if (
        [...kinds].some((kind) => !capabilities.operations.includes(kind)) ||
        plan.some(
          (operation) =>
            operation.kind === 'option_update' &&
            !capabilities.settings.includes(optionNameOf(operation.objectRef)),
        )
      )
        return releaseErrors.pluginOutdated
    }
    for (const [index, operation] of plan.entries()) {
      try {
        if (operation.kind === 'post_create') {
          const after = states[index]!.after
          if (!isRecordState(after) || !after.slug) return releaseErrors.dbPlan
          if (await db!.slugTaken(recordTypeOf(operation.objectRef), after.slug))
            return releaseErrors.slugTaken
          continue
        }
        const state =
          operation.kind === 'content_update'
            ? await gateway.read(operation.objectRef)
            : await db!.readObject(operation.objectRef)
        if (
          state.stateHash !== operation.beforeHash &&
          !(operation.kind === 'schema_migration' && state.stateHash === operation.afterHash)
        )
          return releaseErrors.dbConflict
      } catch (error) {
        // A record that is no longer a public page or post the plugin may read: changed.
        if (isDomainError(error) && error.code === 'CONTENT_OBJECT_UNAVAILABLE')
          return releaseErrors.dbConflict
        return unreachable()
      }
    }
    return null
  }

  #dbSettings(row: ReleaseRow): readonly DbSetting[] {
    try {
      return this.deps.adapter(row.site.stack).dbSettings({
        stack: row.site.stack,
        url: row.site.url,
        docroot: '/',
        extras: {},
      })
    } catch {
      return []
    }
  }

  /**
   * The values of every variable of the site, whatever its recipients: none may reach production
   * (Р13). Read for a refusal (R10: `readSiteEnvValuesToRefuse`) — the value Vault holds now, at
   * any version: a value the client has just changed is refused before its row records the new
   * version. Read at the readiness and again when an attempt is armed — a variable may be added
   * in between.
   */
  async #clientValues(row: ReleaseRow): Promise<string[]> {
    const variables = await this.deps.db.siteEnvVar.findMany({
      where: { siteId: row.siteId },
      select: { name: true },
    })
    if (variables.length === 0) return []
    try {
      return await readSiteEnvValuesToRefuse(
        this.deps.secrets,
        row.siteId,
        variables.map((variable) => variable.name),
      )
    } catch {
      throw new Later('client_values')
    }
  }

  /** The site is busy: another release is under way — refused —, or a turn is — wait a while. */
  async #siteBusy(row: ReleaseRow): Promise<void> {
    if ((await this.#othersUnderWay(this.deps.db, row)) > 0)
      return this.#refuse(row, null, releaseErrors.inProgress)
    if (this.#now().getTime() - row.approvedAt.getTime() > RELEASE_SITE_WAIT_MS)
      return this.#refuse(row, null, releaseErrors.siteBusy)
    throw new Later('site_busy')
  }

  /**
   * `approved → failed` before `main` moved: the dialog goes back to its candidate. A candidate
   * refused as outdated whose base has another tree than `main` (`mainTree`, as read under the
   * lease) becomes `stale`: the dialog is offered «Обновить» — `current` would offer `/release`
   * again, refused the same way every time.
   */
  async #refuse(
    row: ReleaseRow,
    epoch: number | null,
    code: ReleaseError,
    mainTree?: string,
  ): Promise<void> {
    await this.deps.db.$transaction(async (tx) => {
      // Without a lease of this run, only while no run recorded a newer one than the row this
      // run read: a run that has just got the site goes on, its release is not refused under it.
      const moved = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE site_releases SET status = 'failed', error_code = ${code},
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'approved'
          AND lease_epoch = ${epoch ?? row.leaseEpoch}::int
        RETURNING id`
      if (moved.length === 0) return
      if (code === releaseErrors.outdated && mainTree !== undefined && row.candidateId !== null)
        await tx.$queryRaw`
          UPDATE task_candidates SET status = 'stale'
          WHERE id = ${row.candidateId}::uuid AND status = 'current'
            AND base_tree <> ${mainTree}
          RETURNING id`
      await endWithoutInstall(tx, {
        row: { ...row, status: 'failed', errorCode: code },
        outcome: 'refused',
        epoch,
        now: this.#now(),
      })
    })
    this.#logger.log(`release_refused release=${row.id} code=${code}`)
  }

  /** Not `published` RELEASE_PUBLISH_GIVE_UP_MS after the confirmation: it gives up. */
  #pastGiveUp(row: ReleaseRow): boolean {
    return this.#now().getTime() - row.approvedAt.getTime() > RELEASE_PUBLISH_GIVE_UP_MS
  }

  // -------------------------------------------------------------------------------------------
  // publishing → published
  // -------------------------------------------------------------------------------------------

  async #publish(start: ReleaseRow): Promise<void> {
    const lease = await takeOverReleaseLease(this.deps.db, {
      releaseId: start.id,
      ttlMs: RELEASE_LEASE_MS,
    })
    // A newer run owns the release.
    if (!lease) return
    const row = await readReleaseRow(this.deps.db, start.id)
    if (row?.status !== 'publishing') return
    try {
      await this.#publishUnder(row, lease)
    } catch (error) {
      if (error instanceof Refused) return this.#failPublishing(row, lease, error.code)
      throw error
    }
  }

  async #publishUnder(row: ReleaseRow, lease: ReleaseLease): Promise<void> {
    const { git, provider } = this.deps
    const repository = await siteRepository(this.deps.db, row.siteId)
    if (!git || !provider || !this.deps.api || !repository) throw new Refused(releaseErrors.off)
    if (this.#pastGiveUp(row)) throw new Refused(releaseErrors.publishTimeout)
    const fence = this.#fence(row.id, lease.epoch, ['publishing'])
    const { repo, branch } = repository

    // 1. The release commit, stored before it is pushed: a retry builds the same SHA. An undo's
    // has the tree of its plan, or the undo is refused before `main` moves.
    let commit: TrustedCommitInput
    if (isUndo(row)) commit = await this.#undoCommitOf(row, repo)
    else if (isCandidateRelease(row))
      commit = releaseCommit(repo, {
        releaseId: row.id,
        taskId: row.taskId,
        candidateId: row.candidateId,
        candidateRevision: row.candidateRevision,
        version: row.version,
        headSha: row.candidate.headSha,
        mainBeforeSha: row.mainBeforeSha,
        committedAt: row.committedAt,
      })
    else throw new Refused(releaseErrors.dbPlan)
    let approvedSha = row.approvedSha
    if (approvedSha === null) {
      approvedSha = await this.#git('commit', () => git.trustedCommit(commit))
      if (!(await this.#store(row.id, lease.epoch, { approvedSha }))) return
    }

    // 2. `main` by CAS; a lost answer is read back, never guessed (Р27).
    if (row.mainPushedAt === null) {
      const pushed = await this.#pushMain(
        commit,
        { repo, branch },
        row.mainBeforeSha,
        approvedSha,
        fence,
      )
      if (pushed === 'moved') throw new Refused(releaseErrors.mainMoved)
      if (!(await this.#store(row.id, lease.epoch, { mainPushed: true }))) return
    }

    // 3. A tag made by an earlier run started the job already: its attempt stays armed.
    let tag = await this.#provider('tag', releaseErrors.tagRefused, () =>
      provider.getTag(repo, row.tag),
    )
    if (tag === null) {
      // 4. A new attempt is armed and its secret set; the tag comes last (Р29).
      await this.#arm(row, lease.epoch, repo, approvedSha, fence)
      await fence()
      const created = approvedSha
      tag = await this.#provider('tag', releaseErrors.tagRefused, () =>
        provider.createTag(repo, row.tag, created),
      )
    }
    // The tag never moves: one that names another commit burns the version.
    if (tag.commitSha !== approvedSha) throw new Refused(releaseErrors.tagTaken)

    // 5. The job has RELEASE_START_TIMEOUT_MINUTES to report its start.
    const startMs = this.deps.api.startTimeoutMs
    await this.deps.db.$transaction(async (tx) => {
      const moved = await tx.$queryRaw<Array<{ deadline: Date }>>`
        UPDATE site_releases SET status = 'published', updated_at = clock_timestamp(),
          deploy_token_expires_at = clock_timestamp() + ${startMs}::int * interval '1 millisecond'
        WHERE id = ${row.id}::uuid AND status = 'publishing' AND lease_epoch = ${lease.epoch}
          AND deploy_token_hash IS NOT NULL
        RETURNING deploy_token_expires_at AS deadline`
      const deadline = moved[0]?.deadline
      if (deadline) await wakeRelease(tx, { releaseId: row.id, availableAt: deadline })
    })
    this.#logger.log(`release_published release=${row.id}`)
  }

  /**
   * The commit of an undo (docs/plan/53, «Отмена выпуска»): the tree the hosting held before the
   * release undone, with the media the release added — under `addOnlyPaths`, which only grow —
   * taken from its commit; on `main` as found, at the moment of the confirmation. Its tree must be
   * the tree of the plan the client confirmed, and every other path it changes against the
   * release — the paths the release changed — is held to rule 6 (no CI path, no protected path,
   * nothing under the folders of media): otherwise the undo is Refused before `main` moves. (The
   * commit itself is on no remote before its push: its diff is read from the release's.)
   */
  async #undoCommitOf(row: UndoRelease, repo: RepoRef): Promise<TrustedCommitInput> {
    const git = this.deps.git!
    const undone = row.undoes
    if (undone.approvedSha === null) throw new Refused(releaseErrors.undoOutdated)
    const undoneSha = undone.approvedSha
    const returnsTo = installedBaseOf(undone)
    const rules = this.#pathRules(row)
    if (rules === null) throw new Refused(releaseErrors.forbiddenPath)
    const changes = await this.#git('commit', () =>
      git.changeDigests({ repo, baseSha: returnsTo, headSha: undoneSha }),
    )
    const keep = changes
      .filter(
        (change) =>
          change.change === 'added' && addOnlyPathOf(change.path, rules.addOnlyPaths) !== undefined,
      )
      .map((change) => change.path)
    const kept = new Set(keep)
    if (
      changes.some(
        (change) =>
          !kept.has(change.path) &&
          (isForbiddenPath(change.path, rules.protectedPaths) ||
            addOnlyPathOf(change.path, rules.addOnlyPaths) !== undefined),
      )
    )
      throw new Refused(releaseErrors.forbiddenPath)
    const commit = undoCommit(repo, {
      undoId: row.id,
      undoneVersion: undone.version,
      undoneSha,
      version: row.version,
      returnsToSha: returnsTo,
      keep,
      mainBeforeSha: row.mainBeforeSha,
      committedAt: row.committedAt,
    })
    const overlay = commit.overlay
    const tree = await this.#git('commit', () =>
      overlay
        ? git.treeWith({ repo, treeOf: returnsTo, overlay })
        : git.treeOf({ repo, sha: returnsTo }),
    )
    if (tree !== row.undoPlan.targetTree) throw new Refused(releaseErrors.undoPlanChanged)
    return commit
  }

  async #pushMain(
    commit: TrustedCommitInput,
    target: { repo: RepoRef; branch: string },
    expected: string,
    approvedSha: string,
    fence: () => Promise<void>,
  ): Promise<'pushed' | 'moved'> {
    const git = this.deps.git!
    let pushed
    try {
      pushed = await git.pushTrustedCommit({ ...commit, branch: target.branch, expected }, fence)
    } catch (error) {
      if (isDomainError(error) && error.code === 'LEASE_LOST') throw error
      // The answer may be lost after the push landed: `main` says which.
      const head = await this.#git('main_push', () => git.readBranchHead(target))
      if (head === approvedSha) return 'pushed'
      if (isFinalRefusal(error)) throw new Refused(releaseErrors.repositoryRefused)
      if (head === expected) throw new Later('main_push')
      return 'moved'
    }
    // Deterministic: the commit pushed is the one stored before the push.
    if (pushed.sha !== approvedSha) throw new Error('The release commit is not the stored one')
    return pushed.status === 'moved' ? 'moved' : 'pushed'
  }

  /**
   * A new deploy attempt (Р29): the number first, then the values of the database plan read
   * and checked again (a variable may have been added since the readiness), the backup key
   * (Transit `ws-<id>`, its wrapped form kept next to the backup — what an operator decrypts
   * the backup with), the values sealed with it, the wrapping of the API token and the key for
   * 30 minutes, the hash of the token and the accessor of the wrapping in the row, and only
   * then the repository secret with the wrapping. The wrapping of an earlier attempt is
   * revoked. A secret the repository did not take is tried again by a new attempt, later each
   * time; one it refused for good ends the release.
   */
  async #arm(
    row: ReleaseRow,
    epoch: number,
    repo: RepoRef,
    approvedSha: string,
    fence: () => Promise<void>,
  ): Promise<void> {
    const { db, secrets, provider } = this.deps
    const previous = row.wrapAccessor
    if (previous !== null) await this.#vault('revoke', () => secrets.revokeAccessor(previous))
    const numbered = await db.$queryRaw<Array<{ deploy_attempt: number }>>`
      UPDATE site_releases SET deploy_attempt = deploy_attempt + 1, wrap_accessor = NULL,
        deploy_token_hash = NULL, deploy_token_expires_at = NULL, access_issued_at = NULL,
        backup_object_key = NULL, backup_sha256 = NULL, backup_bytes = NULL,
        backup_verified_at = NULL, updated_at = clock_timestamp()
      WHERE id = ${row.id}::uuid AND status = 'publishing' AND lease_epoch = ${epoch}
      RETURNING deploy_attempt`
    const attempt = numbered[0]?.deploy_attempt
    if (attempt === undefined) throw leaseLost('The release moved on during its arming')

    // The values sealed for the job: a release's from its candidate's plan, an undo's from what
    // production held before the release it undoes. The readiness refused any other plan.
    let sealValues: (key: Uint8Array) => Buffer[]
    if (isUndo(row)) {
      const writes = dbUndoPlanSchema.parse(row.undoPlan.dbPlan)
      const payloads = await this.#readUndoValues(row)
      sealValues = (key) =>
        writes.map((operation, index) =>
          sealDeployValue(payloads[index]!, operation, row.id, 'undo', key),
        )
    } else {
      const plan = isCandidateRelease(row)
        ? releasablePlan(row.candidate.dbPlan, this.#dbOperationKinds(row))
        : null
      if (plan === null) throw conflict('The database plan of the release is not releasable')
      const states = plan.length > 0 ? await this.#readValues(row, plan) : []
      sealValues = (key) =>
        plan.map((operation, index) => sealDbOperationValue(states[index]!, operation, row.id, key))
    }
    const key = await this.#vault('data_key', () =>
      secrets.transitDataKey(workspaceTransitKey(row.task.workspaceId)),
    )
    const token = randomBytes(32).toString('base64url')
    try {
      await this.#putOnce(
        backupKeyObject(row.siteId, row.id, attempt),
        Buffer.from(JSON.stringify({ v: 1, key: key.ciphertext })),
        'application/json',
      )
      for (const [index, sealed] of sealValues(key.plaintext).entries())
        await this.#putOnce(
          dbValueObject(row.siteId, row.id, attempt, index),
          sealed,
          'application/octet-stream',
        )
      const data: DeployWrapData = {
        v: '1',
        releaseId: row.id,
        attempt: String(attempt),
        releaseApiToken: token,
        backupKey: Buffer.from(key.plaintext).toString('base64'),
      }
      const wrapped = await this.#vault('wrap', () =>
        secrets.wrap({ ...data }, DEPLOY_WRAP_TTL_SECONDS),
      )
      const armed = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE site_releases SET wrap_accessor = ${wrapped.accessor},
            deploy_token_hash = ${sha256(token)},
            deploy_token_expires_at = clock_timestamp() + ${DEPLOY_WRAP_TTL_SECONDS}::int * interval '1 second',
            updated_at = clock_timestamp()
          WHERE id = ${row.id}::uuid AND status = 'publishing' AND lease_epoch = ${epoch}
            AND deploy_attempt = ${attempt}
          RETURNING id`
        if (rows.length === 0) return false
        await this.#deployment(tx, row, approvedSha, attempt)
        return true
      })
      if (!armed) {
        await secrets.revokeAccessor(wrapped.accessor).catch(() => undefined)
        throw leaseLost('The release moved on during its arming')
      }
      await fence()
      try {
        await provider!.setActionsSecret(
          repo,
          DEPLOY_WRAP_SECRET_NAME,
          formatDeployWrap({
            releaseId: row.id,
            attempt,
            tag: row.tag,
            sha: approvedSha,
            wrapToken: wrapped.token,
          }),
        )
      } catch (error) {
        if (isFinalRefusal(error)) throw new Refused(releaseErrors.secretRefused)
        // The next run arms a new attempt and revokes this one: 30 s, 1 min, 2 min… 10 min.
        throw new Later(
          'secret',
          Math.min(RELEASE_RETRY_MS * 2 ** (attempt - 1), RELEASE_SECRET_RETRY_MAX_MS),
        )
      }
    } finally {
      key.plaintext.fill(0)
    }
  }

  /** An object of a new attempt in `raditi-backups`: its path is new, so it must not be there. */
  async #putOnce(key: string, body: Buffer, contentType: string): Promise<void> {
    let stored: boolean
    try {
      stored = await this.deps.storage.putIfAbsent('backups', key, body, {
        contentType,
        sizeBytes: body.byteLength,
      })
    } catch {
      throw new Later('storage')
    }
    if (!stored) throw new Later('storage_exists')
  }

  /** The deploy of the release: one row, made with its first attempt. */
  async #deployment(
    tx: Prisma.TransactionClient,
    row: ReleaseRow,
    approvedSha: string,
    attempt: number,
  ): Promise<void> {
    const existing = await tx.deployment.findUnique({
      where: { releaseId: row.id },
      select: { id: true },
    })
    const prefix = `sites/${row.siteId.toLowerCase()}/${row.id.toLowerCase()}/`
    const deployment =
      existing ??
      (await tx.deployment.create({
        data: {
          siteId: row.siteId,
          taskId: row.taskId,
          // An undo puts the version before the release back (docs/plan/53, «Отмена выпуска»).
          kind: row.kind === 'undo' ? 'revert' : 'deploy',
          status: 'pending',
          commitSha: approvedSha,
          backupPrefix: prefix,
          releaseId: row.id,
          tag: row.tag,
          version: row.version,
        },
        select: { id: true },
      }))
    await tx.siteRelease.update({
      where: { id: row.id },
      data: { deploymentId: deployment.id },
      select: { id: true },
    })
    this.#logger.log(`release_armed release=${row.id} attempt=${attempt}`)
  }

  /** `publishing → failed`: whether `main` moved decides `failed` from `refused`. */
  async #failPublishing(row: ReleaseRow, lease: ReleaseLease, code: ReleaseError): Promise<void> {
    const moved = await this.deps.db.$queryRaw<Array<{ id: string }>>`
      UPDATE site_releases SET status = 'failed', error_code = ${code},
        deploy_token_hash = NULL, deploy_token_expires_at = NULL, updated_at = clock_timestamp()
      WHERE id = ${row.id}::uuid AND status = 'publishing' AND lease_epoch = ${lease.epoch}
      RETURNING id`
    if (moved.length === 0) return
    this.#logger.warn(`release_failed release=${row.id} code=${code}`)
    const ended = await readReleaseRow(this.deps.db, row.id)
    if (ended) await this.#end(ended)
  }

  // -------------------------------------------------------------------------------------------
  // published, deploying, verifying, rolling_back, unknown: the job
  // -------------------------------------------------------------------------------------------

  /** The job has until the deadline in `deploy_token_expires_at` to report its start. */
  async #awaitStart(row: ReleaseRow, seq: number): Promise<void> {
    const timedOut = await this.deps.db.$queryRaw<Array<{ id: string }>>`
      UPDATE site_releases SET status = 'failed', error_code = ${releaseErrors.startTimeout},
        deploy_token_hash = NULL, deploy_token_expires_at = NULL, updated_at = clock_timestamp()
      WHERE id = ${row.id}::uuid AND status = 'published'
        AND deploy_token_expires_at <= clock_timestamp()
      RETURNING id`
    if (timedOut.length === 0) return this.#wakeAtDeadline(row, seq)
    this.#logger.warn(`release_not_started release=${row.id}`)
    const ended = await readReleaseRow(this.deps.db, row.id)
    if (ended) await this.#end(ended)
  }

  /**
   * The job between its reports (Р31). DEPLOY_RUN_CHECK_MS before the deadline of its token core
   * asks the provider about the run of the attempt: a run still queued or at work keeps its
   * token and the lease for another DEPLOY_SILENCE_MS (up to DEPLOY_RUN_MAX_MS) — the job is in
   * a long phase without calls —; a run that is over without its last report is stopped at
   * once; a provider that cannot tell leaves it to the deadline. A stopped job ends the release
   * `failed` before its first write, `unknown` after it.
   */
  async #watch(row: ReleaseRow, seq: number): Promise<void> {
    const clock = await this.#tokenClock(row)
    if (clock !== null && !clock.due) {
      // A newer wake-up is on its way; the latest one looks again before the deadline.
      if (seq >= row.enqueues)
        await this.#wakeAt(row.id, new Date(clock.deadline.getTime() - DEPLOY_RUN_CHECK_MS))
      return
    }
    let over = false
    if (clock !== null) {
      const run = await this.#runState(row, (await this.#rollbackOnly(row)) ? 'dispatch' : 'push')
      if (run === 'running' && !(await this.#ranTooLong(row.id, row.deployAttempt))) {
        const deadline = await this.#keepAlive(row)
        if (deadline) {
          this.#logger.log(`release_job_running release=${row.id} status=${row.status}`)
          await this.#wakeAt(row.id, new Date(deadline.getTime() - DEPLOY_RUN_CHECK_MS))
        }
        return
      }
      over = run === 'over'
      if (!over && !clock.expired) {
        // The provider cannot tell yet: it is asked again until the deadline decides.
        if (run === null) throw new Later('run_status')
        return this.#wakeAt(row.id, clock.deadline)
      }
    }
    const stopped = await this.deps.db.$transaction(async (tx) => {
      const wrote =
        row.status !== 'deploying' ||
        (row.deployAttempt > 0 &&
          (await releaseAttemptWrote(tx, { releaseId: row.id, deployAttempt: row.deployAttempt })))
      const next = wrote ? 'unknown' : 'failed'
      const code = wrote ? releaseErrors.stepUnknown : releaseErrors.silent
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE site_releases SET status = ${next}::"ReleaseStatus", error_code = ${code},
          deploy_token_hash = NULL, deploy_token_expires_at = NULL, updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = ${row.status}::"ReleaseStatus"
          AND deploy_attempt = ${row.deployAttempt}
          AND (${over} OR deploy_token_expires_at IS NULL
            OR deploy_token_expires_at <= clock_timestamp())
        RETURNING id`
      return rows.length === 1
    })
    if (!stopped) return
    this.#logger.warn(`release_job_silent release=${row.id} status=${row.status} over=${over}`)
    const ended = await readReleaseRow(this.deps.db, row.id)
    if (ended?.status === 'unknown') await this.#awaitOperator(ended, ended.enqueues)
    else if (ended) await this.#end(ended)
  }

  /**
   * The deadline of the token of the release's current attempt, while the release stands where
   * the row says: `due` — DEPLOY_RUN_CHECK_MS or less ahead. null — no token, or moved on.
   */
  async #tokenClock(
    row: ReleaseRow,
  ): Promise<{ expired: boolean; due: boolean; deadline: Date } | null> {
    const rows = z
      .array(z.object({ expired: z.boolean(), due: z.boolean(), deadline: z.coerce.date() }))
      .parse(
        await this.deps.db.$queryRaw`
          SELECT deploy_token_expires_at <= clock_timestamp() AS expired,
            deploy_token_expires_at <= clock_timestamp()
              + ${DEPLOY_RUN_CHECK_MS}::int * interval '1 millisecond' AS due,
            deploy_token_expires_at AS deadline
          FROM site_releases
          WHERE id = ${row.id}::uuid AND status = ${row.status}::"ReleaseStatus"
            AND deploy_attempt = ${row.deployAttempt}
            AND deploy_token_hash IS NOT NULL AND deploy_token_expires_at IS NOT NULL`,
      )
    return rows[0] ?? null
  }

  /**
   * A run still at work: its token and the lease live another DEPLOY_SILENCE_MS. The new
   * deadline; null — the release moved on meanwhile.
   */
  async #keepAlive(row: ReleaseRow): Promise<Date | null> {
    return this.deps.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ deadline: Date }>>`
        UPDATE site_releases SET updated_at = clock_timestamp(),
          deploy_token_expires_at = clock_timestamp() + ${DEPLOY_SILENCE_MS}::int * interval '1 millisecond'
        WHERE id = ${row.id}::uuid AND status = ${row.status}::"ReleaseStatus"
          AND deploy_attempt = ${row.deployAttempt} AND deploy_token_hash IS NOT NULL
        RETURNING deploy_token_expires_at AS deadline`
      const deadline = rows[0]?.deadline
      if (!deadline) return null
      await renewReleaseLease(tx, { releaseId: row.id, ttlMs: DEPLOY_SILENCE_MS })
      return new Date(deadline)
    })
  }

  /** The current attempt only restores what an earlier one wrote (Р31). */
  async #rollbackOnly(row: ReleaseRow): Promise<boolean> {
    const writing = await releaseWritingAttempt(this.deps.db, { releaseId: row.id })
    return writing !== null && row.deployAttempt > writing
  }

  /** The first report of the attempt is older than DEPLOY_RUN_MAX_MS. */
  async #ranTooLong(releaseId: string, attempt: number): Promise<boolean> {
    const rows = z.array(z.object({ long: z.boolean().nullable() })).parse(
      await this.deps.db.$queryRaw`
        SELECT min(created_at) < clock_timestamp()
          - ${DEPLOY_RUN_MAX_MS}::int * interval '1 millisecond' AS long
        FROM release_steps
        WHERE release_id = ${releaseId}::uuid AND deploy_attempt = ${attempt}`,
    )
    return rows[0]?.long === true
  }

  /**
   * What the provider shows of the run of the deploy workflow on the release tag (R8a, R8c): the
   * run the tag started (`push`), or the run core dispatched for an attempt «только возврат»
   * (`dispatch`, its id kept in the deploy). `running` — queued or at work; `over` — completed;
   * null — the provider did not answer, or shows no such run. A run is known by its workflow
   * file, its ref and its event, never by its name.
   */
  async #runState(row: ReleaseRow, kind: 'push' | 'dispatch'): Promise<RunState> {
    const { db, provider } = this.deps
    if (!provider || row.approvedSha === null) return null
    const approvedSha = row.approvedSha
    try {
      const repository = await siteRepository(db, row.siteId)
      if (!repository) return null
      let runs: WorkflowRun[]
      const kept =
        kind === 'dispatch' && row.deploymentId !== null
          ? (
              await db.deployment.findUnique({
                where: { id: row.deploymentId },
                select: { workflowRunId: true },
              })
            )?.workflowRunId
          : null
      if (kept) {
        const run = await provider.getWorkflowRun(repository.repo, kept)
        runs = run ? [run] : []
      } else
        runs = await provider.listWorkflowRuns(repository.repo, {
          headSha: approvedSha,
          event: kind === 'push' ? 'push' : 'workflow_dispatch',
        })
      const event = kind === 'push' ? 'push' : 'workflow_dispatch'
      const ours = runs.filter(
        (run) =>
          run.workflowFile === DEPLOY_WORKFLOW_FILE &&
          run.ref === `refs/tags/${row.tag}` &&
          (run.event === null || run.event === event),
      )
      if (ours.length === 0) return null
      return ours.some((run) => run.status !== 'completed') ? 'running' : 'over'
    } catch {
      return null
    }
  }

  /**
   * `unknown` (Р31). While the token of the attempt lives, its job may still report: the rollback
   * of a write it could not prove (the release API gave it UNKNOWN_GRACE_MS), or the run of an
   * attempt «только возврат». Once the token is gone: if the attempt that wrote kept a verified
   * backup and no attempt «только возврат» was armed yet, core waits until the provider no
   * longer shows the run that wrote at work — it may still be restoring by itself, and two jobs
   * must not restore at once —, then arms one and starts it — the deploy workflow dispatched on
   * the release tag (R8c measured it on Gitea 1.27.3) — and waits for it as for any job;
   * otherwise the way in is closed and the release waits for the operator.
   */
  async #awaitOperator(row: ReleaseRow, seq: number): Promise<void> {
    const writing = await releaseWritingAttempt(this.deps.db, { releaseId: row.id })
    const rollbackOnly = writing !== null && row.deployAttempt > writing
    const quiet = await this.deps.db.$queryRaw<Array<{ id: string }>>`
      UPDATE site_releases SET deploy_token_hash = NULL, deploy_token_expires_at = NULL,
        updated_at = clock_timestamp()
      WHERE id = ${row.id}::uuid AND status = 'unknown'
        AND (deploy_token_hash IS NULL OR deploy_token_expires_at <= clock_timestamp())
      RETURNING id`
    if (quiet.length === 0) {
      // A run that died between arming the attempt and starting its job starts it now.
      if (!rollbackOnly || (await this.#dispatchRollback(row)))
        return this.#wakeAtDeadline(row, seq)
    } else if (
      !rollbackOnly &&
      writing !== null &&
      row.backupVerifiedAt !== null &&
      // An undo whose site failed its check before and after the write: going back to the
      // version it undoes mends nothing, the operator decides.
      row.errorCode !== 'site_broken_both'
    ) {
      if (
        (await this.#runState(row, 'push')) === 'running' &&
        !(await this.#ranTooLong(row.id, writing))
      )
        throw new Later('job_running')
      const started = await this.#armRollback(
        { ...row, deployTokenHash: null, deployTokenExpiresAt: null },
        writing,
      )
      if (started) return
    }
    const fresh = await readReleaseRow(this.deps.db, row.id)
    if (fresh?.status === 'unknown') await this.#end(fresh)
  }

  /**
   * An attempt «только возврат» of what attempt `writing` wrote (Р31, R8c): a new attempt with
   * the data key of that one — its backup and the values of its plan were sealed with it —, the
   * wrapping and the secret, and the deploy workflow dispatched on the release tag; the job
   * finds `rollbackOf` in its manifest. Best effort: whatever does not go through — a site no
   * longer `active` included — hands the release to the operator (false), as it would without
   * this attempt.
   */
  async #armRollback(row: ReleaseRow, writing: number): Promise<boolean> {
    const { db, secrets, provider, api } = this.deps
    const repository = await siteRepository(db, row.siteId)
    if (!provider || !api || !repository || row.approvedSha === null) return false
    const site = await db.site.findUnique({ where: { id: row.siteId }, select: { status: true } })
    if (site?.status !== 'active') return false
    const lease = await takeOverReleaseLease(db, { releaseId: row.id, ttlMs: RELEASE_LEASE_MS })
    // The site is the operator's already, or a newer run has the release.
    if (!lease) return true
    const fence = this.#fence(row.id, lease.epoch, ['unknown'])
    let key: Uint8Array | null = null
    try {
      key = await this.#attemptKey(row, writing)
      const previous = row.wrapAccessor
      if (previous !== null) await secrets.revokeAccessor(previous)
      const numbered = await db.$queryRaw<Array<{ deploy_attempt: number }>>`
        UPDATE site_releases SET deploy_attempt = deploy_attempt + 1, wrap_accessor = NULL,
          deploy_token_hash = NULL, deploy_token_expires_at = NULL, access_issued_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'unknown' AND lease_epoch = ${lease.epoch}
          AND deploy_attempt = ${row.deployAttempt}
        RETURNING deploy_attempt`
      const attempt = numbered[0]?.deploy_attempt
      if (attempt === undefined) throw leaseLost('The release moved on during its arming')
      const token = randomBytes(32).toString('base64url')
      const data: DeployWrapData = {
        v: '1',
        releaseId: row.id,
        attempt: String(attempt),
        releaseApiToken: token,
        backupKey: Buffer.from(key).toString('base64'),
      }
      const wrapped = await secrets.wrap({ ...data }, DEPLOY_WRAP_TTL_SECONDS)
      const startMs = api.startTimeoutMs
      const armed = await db.$queryRaw<Array<{ id: string }>>`
        UPDATE site_releases SET wrap_accessor = ${wrapped.accessor},
          deploy_token_hash = ${sha256(token)},
          deploy_token_expires_at = clock_timestamp() + ${startMs}::int * interval '1 millisecond',
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'unknown' AND lease_epoch = ${lease.epoch}
          AND deploy_attempt = ${attempt}
        RETURNING id`
      if (armed.length === 0) {
        await secrets.revokeAccessor(wrapped.accessor).catch(() => undefined)
        throw leaseLost('The release moved on during its arming')
      }
      await fence()
      await provider.setActionsSecret(
        repository.repo,
        DEPLOY_WRAP_SECRET_NAME,
        formatDeployWrap({
          releaseId: row.id,
          attempt,
          tag: row.tag,
          sha: row.approvedSha,
          wrapToken: wrapped.token,
        }),
      )
      const fresh = await readReleaseRow(db, row.id)
      if (!fresh || !(await this.#dispatchRollback(fresh))) return false
      this.#logger.warn(`release_rollback_started release=${row.id} attempt=${attempt}`)
      const deadline = fresh.deployTokenExpiresAt
      if (deadline) await this.#wakeAt(row.id, deadline)
      return true
    } catch (error) {
      if (isDomainError(error) && error.code === 'LEASE_LOST') throw error
      this.#logger.warn(`release_rollback_not_started release=${row.id}`)
      return false
    } finally {
      key?.fill(0)
    }
  }

  /** The data key of attempt `attempt`, from the Transit-wrapped copy next to its backup. */
  async #attemptKey(row: ReleaseRow, attempt: number): Promise<Uint8Array> {
    const object = await this.deps.storage.get(
      'backups',
      backupKeyObject(row.siteId, row.id, attempt),
    )
    if (!object) throw new Error('The backup key of the attempt is missing')
    const chunks: Buffer[] = []
    for await (const chunk of object) chunks.push(Buffer.from(chunk))
    const stored = z
      .strictObject({ v: z.literal(1), key: z.string().min(1).max(4096) })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    return this.deps.secrets.transitDecryptDataKey(
      workspaceTransitKey(row.task.workspaceId),
      stored.key,
    )
  }

  /**
   * Starts the job of an armed attempt «только возврат»: the deploy workflow dispatched on the
   * release tag, once — a run that already reported, or whose id the deploy keeps, is not started
   * again (a second run could only find the wrapping spent). false — the provider refused or did
   * not answer: the token goes, and the release is the operator's.
   */
  async #dispatchRollback(row: ReleaseRow): Promise<boolean> {
    const { db, provider } = this.deps
    const repository = await siteRepository(db, row.siteId)
    const deployment =
      row.deploymentId === null
        ? null
        : await db.deployment.findUnique({
            where: { id: row.deploymentId },
            select: { id: true, workflowRunId: true },
          })
    if (deployment?.workflowRunId) return true
    const reported = await db.releaseStep.count({
      where: { releaseId: row.id, deployAttempt: row.deployAttempt },
    })
    if (reported > 0) return true
    try {
      if (!provider || !repository) throw new Error('No provider')
      const run = await provider.dispatchWorkflow(repository.repo, {
        workflow: DEPLOY_WORKFLOW_FILE,
        ref: `refs/tags/${row.tag}`,
        source: { ...repository.repo, ...DEPLOY_WORKFLOW_SOURCE },
      })
      if (deployment && run.runId !== null)
        await db.deployment.update({
          where: { id: deployment.id },
          data: { workflowRunId: run.runId, status: 'running' },
          select: { id: true },
        })
      return true
    } catch {
      await db.$queryRaw`
        UPDATE site_releases SET deploy_token_hash = NULL, deploy_token_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'unknown' AND deploy_attempt = ${row.deployAttempt}
        RETURNING id`
      this.#logger.warn(`release_rollback_not_dispatched release=${row.id}`)
      return false
    }
  }

  /** The latest wake-up of a release waiting for a deadline wakes it again then. */
  async #wakeAtDeadline(row: ReleaseRow, seq: number): Promise<void> {
    // A newer wake-up is on its way; the latest one checks the deadline again.
    if (seq >= row.enqueues && row.deployTokenExpiresAt)
      await this.#wakeAt(row.id, row.deployTokenExpiresAt)
  }

  // -------------------------------------------------------------------------------------------
  // The end
  // -------------------------------------------------------------------------------------------

  async #end(row: ReleaseRow): Promise<void> {
    const barrier = await this.deps.db.siteLease.findUnique({
      where: { siteId: row.siteId },
      select: { inflightReleaseId: true, heldForOperator: true },
    })
    const ours = barrier?.inflightReleaseId === row.id
    const held = barrier?.heldForOperator === true
    if (row.status === 'installed') {
      if (ours && !held) await this.#endInstalled(row)
      // An undo has no dialog of its own to close and charge: the one of the release it undoes
      // is closed and charged already.
      if (row.kind === 'undo') return
      return this.#closeInstalled(row)
    }
    // Ended for the site already — the barrier is gone or was never raised (`approved`) — or
    // the operator's until `releases:resolve` hands it back.
    if (!ours || held) return
    // Everything below is this run's only while it holds the lease: a run that stalls here
    // stops at its next fence instead of touching what a newer release of the site set up.
    const lease = await takeOverReleaseLease(this.deps.db, {
      releaseId: row.id,
      ttlMs: RELEASE_LEASE_MS,
    })
    if (!lease) return
    const fence = this.#fence(row.id, lease.epoch, [row.status])
    await this.#closeTheWayIn(row, fence)
    if (row.status === 'unknown') {
      if (await this.deps.db.$transaction((tx) => holdForOperator(tx, row, this.#now())))
        this.#logger.error(`release_unknown release=${row.id}`)
      return
    }
    const outcome = outcomeOfRow(row)
    if (outcome !== 'failed' && outcome !== 'rolled_back' && outcome !== 'refused') return
    if (outcome !== 'refused' && row.revertSha === null && !(await this.#revert(row, lease, fence)))
      return this.#holdForRevert(row)
    await this.deps.db.$transaction(async (tx) => {
      await endWithoutInstall(tx, { row, outcome, epoch: lease.epoch, now: this.#now() })
    })
    this.#logger.log(`release_ended release=${row.id} outcome=${outcome}`)
  }

  /**
   * The job's way to the site is closed: its token, the wrapping, the repository secret. The
   * secret is deleted only while `fence` holds — the barrier and the lease are still this
   * release's, so the secret is not one a newer release of the site has set.
   */
  async #closeTheWayIn(row: ReleaseRow, fence: () => Promise<void>): Promise<void> {
    if (row.deployTokenHash !== null)
      await this.deps.db.$queryRaw`
        UPDATE site_releases SET deploy_token_hash = NULL, deploy_token_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = ${row.status}::"ReleaseStatus"
        RETURNING id`
    const accessor = row.wrapAccessor
    if (accessor !== null)
      await this.#vault('revoke', () => this.deps.secrets.revokeAccessor(accessor))
    if (row.deployAttempt === 0 || !this.deps.provider) return
    const repository = await siteRepository(this.deps.db, row.siteId)
    if (!repository) return
    await fence()
    try {
      await this.deps.provider.deleteActionsSecret(repository.repo, DEPLOY_WRAP_SECRET_NAME)
    } catch (error) {
      // A refusal that will not change — the release account without its token included —
      // leaves a secret whose wrapping is revoked already: harmless, and the next release
      // replaces it.
      if (isFinalRefusal(error)) this.#logger.error(`release_secret_not_deleted release=${row.id}`)
      else throw new Later('secret_delete')
    }
  }

  /**
   * The revert commit (Р27): `main` goes back to the tree the hosting holds, on top of the
   * release commit, before the lease goes. `main` found elsewhere counts as reverted only when
   * it holds that tree already (an operator put it back); otherwise — and when git refuses for
   * good or is not configured — false: the site is left to the operator.
   */
  async #revert(
    row: ReleaseRow,
    lease: ReleaseLease,
    fence: () => Promise<void>,
  ): Promise<boolean> {
    const git = this.deps.git
    const repository = await siteRepository(this.deps.db, row.siteId)
    if (!git || !repository || row.approvedSha === null) return false
    const commit = revertCommit(repository.repo, {
      releaseId: row.id,
      version: row.version,
      approvedSha: row.approvedSha,
      installedSha: installedBaseOf(row),
      committedAt: row.committedAt,
    })
    let head: string | null
    try {
      const pushed = await git.pushTrustedCommit(
        { ...commit, branch: repository.branch, expected: row.approvedSha },
        fence,
      )
      if (pushed.status !== 'moved') return this.#recordRevert(row, lease, pushed.sha)
      head = pushed.remote
    } catch (error) {
      if (isDomainError(error) && error.code === 'LEASE_LOST') throw error
      // The answer may be lost after the push landed, or the push was refused: `main` says which.
      let sha: string
      try {
        ;[head, sha] = await Promise.all([
          git.readBranchHead(repository),
          git.trustedCommit(commit),
        ])
      } catch (read) {
        if (isFinalRefusal(read)) return false
        throw new Later('revert')
      }
      if (head === sha) return this.#recordRevert(row, lease, sha)
      if (head === row.approvedSha) {
        if (isFinalRefusal(error)) return false
        throw new Later('revert')
      }
    }
    if (head !== null && (await this.#holdsInstalledTree(repository.repo, head, row)))
      return this.#recordRevert(row, lease, head)
    this.#logger.error(`release_revert_main_moved release=${row.id}`)
    return false
  }

  async #holdsInstalledTree(repo: RepoRef, head: string, row: ReleaseRow): Promise<boolean> {
    const git = this.deps.git!
    try {
      const [main, installed] = await Promise.all([
        git.treeOf({ repo, sha: head }),
        git.treeOf({ repo, sha: installedBaseOf(row) }),
      ])
      return main === installed
    } catch (error) {
      if (isFinalRefusal(error)) return false
      throw new Later('revert')
    }
  }

  async #recordRevert(row: ReleaseRow, lease: ReleaseLease, sha: string): Promise<boolean> {
    await this.deps.db.$queryRaw`
      UPDATE site_releases SET revert_sha = ${sha}, updated_at = clock_timestamp()
      WHERE id = ${row.id}::uuid AND lease_epoch = ${lease.epoch} AND revert_sha IS NULL
      RETURNING id`
    return true
  }

  /**
   * The revert commit cannot land (Р27): `main` is not what the hosting holds, so the barrier and
   * the lease stay — held for the operator — and the dialog waits. `releases:resolve
   * --outcome rolled_back` hands the release back once `main` is put back at the release commit
   * or at the installed tree; the next run then ends it.
   */
  async #holdForRevert(row: ReleaseRow): Promise<void> {
    if (await holdReleaseForOperator(this.deps.db, { releaseId: row.id }))
      this.#logger.error(`release_revert_blocked release=${row.id} status=${row.status}`)
  }

  async #endInstalled(row: ReleaseRow): Promise<void> {
    const lease = await takeOverReleaseLease(this.deps.db, {
      releaseId: row.id,
      ttlMs: RELEASE_LEASE_MS,
    })
    if (!lease) return
    await this.#closeTheWayIn(row, this.#fence(row.id, lease.epoch, ['installed']))
    await this.deps.db.$transaction((tx) =>
      endInstalled(tx, { row, epoch: lease.epoch, now: this.#now() }),
    )
    this.#logger.log(`release_installed release=${row.id} version=${row.version}`)
  }

  /**
   * The dialog of an installed release: `done` with its charge, retried until it is. Only once
   * the site recorded the version (the deploy `succeeded` in the first transaction); a charge
   * refused for another reason than open usage is given up CHARGE_GIVE_UP_MS after that.
   */
  async #closeInstalled(row: ReleaseRow): Promise<void> {
    if (row.task.status !== 'deploying' && row.task.status !== 'verifying') return
    const deployment =
      row.deploymentId === null
        ? null
        : await this.deps.db.deployment.findUnique({
            where: { id: row.deploymentId },
            select: { status: true, finishedAt: true },
          })
    const installedAt = deployment?.status === 'succeeded' ? deployment.finishedAt : null
    if (!installedAt) return
    const now = this.#now()
    const giveUp = now.getTime() - installedAt.getTime() > CHARGE_GIVE_UP_MS
    await this.deps.db.$transaction((tx) =>
      closeInstalledDialog(tx, {
        row,
        now,
        giveUp,
        onRefusal: (reason) =>
          this.#logger.error(`release_charge_refused task=${row.taskId} reason=${reason}`),
      }),
    )
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  #fence(releaseId: string, epoch: number, statuses: readonly ReleaseStatus[]) {
    return async () => {
      if (!(await ownsReleaseLease(this.deps.db, { releaseId, epoch, statuses })))
        throw leaseLost('The release lease is no longer owned')
    }
  }

  /** A conditional write of the publishing run: false — the release is no longer this run's. */
  async #store(
    releaseId: string,
    epoch: number,
    change: { approvedSha: string } | { mainPushed: true },
  ): Promise<boolean> {
    const rows =
      'approvedSha' in change
        ? await this.deps.db.$queryRaw<Array<{ id: string }>>`
            UPDATE site_releases SET approved_sha = ${change.approvedSha}, updated_at = clock_timestamp()
            WHERE id = ${releaseId}::uuid AND status = 'publishing' AND lease_epoch = ${epoch}
              AND approved_sha IS NULL
            RETURNING id`
        : await this.deps.db.$queryRaw<Array<{ id: string }>>`
            UPDATE site_releases SET main_pushed_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = ${releaseId}::uuid AND status = 'publishing' AND lease_epoch = ${epoch}
              AND approved_sha IS NOT NULL AND main_pushed_at IS NULL
            RETURNING id`
    return rows.length === 1
  }

  /** git of the site: a final refusal is Refused (`repository_refused`), anything else Later. */
  async #git<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (isDomainError(error) && error.code === 'LEASE_LOST') throw error
      if (isFinalRefusal(error)) throw new Refused(releaseErrors.repositoryRefused)
      throw new Later(what)
    }
  }

  /** The provider as the release account: a final refusal is Refused with `code`. */
  async #provider<T>(what: string, code: ReleaseError, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (isFinalRefusal(error)) throw new Refused(code)
      throw new Later(what)
    }
  }

  async #vault<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch {
      throw new Later(what)
    }
  }

  #wake(releaseId: string, delayMs: number): Promise<void> {
    return this.#wakeAt(releaseId, new Date(this.#now().getTime() + delayMs))
  }

  async #wakeAt(releaseId: string, at: Date): Promise<void> {
    await this.deps.db.$transaction(async (tx) => {
      await wakeRelease(tx, { releaseId, availableAt: at })
    })
  }
}
