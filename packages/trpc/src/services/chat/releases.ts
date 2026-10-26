import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { extendTaskHolds } from '@repo/billing'
import { enqueueReleaseAdvance, insertFeedEvent, Prisma, type PrismaClient } from '@repo/db'
import {
  bumpOf,
  candidateRefusalsOf,
  CONFIRM_TOKEN_TTL_SECONDS,
  confirmTokenClaimsSchema,
  confirmTokenMaterial,
  dbPlanSchema,
  dbPlanViewNeedsReview,
  dbPlanViewRefusal,
  dbPlanViewSchema,
  isConfirmTokenExpired,
  parseVersion,
  releaseKeyMaterial,
  releaseOutcomeOf,
  taskHoldExpiry,
  versionBumps,
  type CandidateRefusal,
  type ChatCommandRefusal,
  type ConfirmTokenClaims,
  type ReleaseKind,
  type ReleaseOutcome,
  type ReleaseStatus,
  type VersionBump,
} from '@repo/domain'

import { accessibleTask, isManagerRole, memberRole, taskNotFound } from './access.ts'
import { candidateCountsOf, dialogFacts, assertCommandAvailable } from './dialog-facts.ts'
import { moveTo, underDialogLock } from './dialog-lock.ts'
import {
  commandUnavailable,
  releaseCandidateChanged,
  releaseConfirmationExpired,
  releaseConfirmationInvalid,
  releaseInProgress,
  releaseReviewRequired,
  releaseVersionNotOffered,
  releaseVersionTaken,
  taskBusy,
  taskFinished,
} from './refusals.ts'
import { versionProposal } from './versions.ts'

// ---------------------------------------------------------------------------------------------
// The confirmation of a release (Р25): an HMAC over the claims, never words of the model
// ---------------------------------------------------------------------------------------------

/** A token is at most this long; anything longer is not one of ours. */
const MAX_TOKEN_CHARS = 1024

const hmac = (key: Uint8Array, claims: ConfirmTokenClaims): Buffer =>
  createHmac('sha256', key).update(confirmTokenMaterial(claims)).digest()

/**
 * `<claims>.<signature>`, both base64url: the claims as JSON, the signature — HMAC-SHA256 of
 * `confirmTokenMaterial(claims)` with the key of the process (`releaseConfirmKey`).
 */
export function signConfirmToken(key: Uint8Array, claims: ConfirmTokenClaims): string {
  const value = confirmTokenClaimsSchema.parse(claims)
  return `${Buffer.from(JSON.stringify(value)).toString('base64url')}.${hmac(key, value).toString('base64url')}`
}

/**
 * The claims of a token this process signed, checked: the signature, the shape, the time. A
 * token of anything else, altered or of another key is RELEASE_CONFIRMATION_INVALID; one past
 * its time RELEASE_CONFIRMATION_EXPIRED.
 */
export function verifyConfirmToken(key: Uint8Array, token: string, now: Date): ConfirmTokenClaims {
  const parts = token.length > MAX_TOKEN_CHARS ? [] : token.split('.')
  const [body, signature] = parts
  if (parts.length !== 2 || !body || !signature) throw releaseConfirmationInvalid()
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw releaseConfirmationInvalid()
  }
  const claims = confirmTokenClaimsSchema.safeParse(json)
  if (!claims.success) throw releaseConfirmationInvalid()
  const given = Buffer.from(signature, 'base64url')
  const expected = hmac(key, claims.data)
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected))
    throw releaseConfirmationInvalid()
  if (isConfirmTokenExpired(claims.data, now)) throw releaseConfirmationExpired()
  return claims.data
}

/** `site_releases.release_key`: SHA-256 hex of the canonical text of the release (Р33). */
export const releaseKeyOf = (input: Parameters<typeof releaseKeyMaterial>[0]): string =>
  createHash('sha256').update(releaseKeyMaterial(input)).digest('hex')

/** The refusal of `/release` a reason of the candidate stands for, in the words of the chat. */
const refusalOfCandidate: Readonly<Record<CandidateRefusal, ChatCommandRefusal>> = {
  not_current: 'needs_update',
  revision_changed: 'needs_update',
  checks_failed: 'checks_failed',
  base_outdated: 'needs_update',
  release_in_progress: 'release_in_progress',
}

// ---------------------------------------------------------------------------------------------
// release.prepare
// ---------------------------------------------------------------------------------------------

export interface PreparedRelease {
  candidateId: string
  revision: number
  /** Trusted counts of the candidate; null — its facts are unreadable. */
  counts: ReturnType<typeof candidateCountsOf>
  /** The version the site has now; null — none is recorded. */
  installedVersion: string | null
  /** The highest version known, the proposal counts from it. */
  base: string
  proposal: { version: string; bump: VersionBump }
  /** One per kind of change, each with the confirmation of exactly that number. */
  choices: { version: string; bump: VersionBump; confirmToken: string }[]
  /**
   * The changes of the database are many or shown shortened (docs/plan/53, «Операции БД и
   * миграции»): the confirmation needs the client's word that they looked at them all.
   */
  review: boolean
  expiresAt: Date
}

/** Whether the description of a revision makes `/release` ask for the client's review. */
const reviewOf = (stored: unknown): boolean => {
  const view = dbPlanViewSchema.safeParse(stored)
  return view.success && dbPlanViewNeedsReview(view.data)
}

/**
 * A plan the panel «База данных» says cannot be released is not offered or confirmed either: the
 * rule of the readiness of core (`dbPlanViewRefusal`) — no description, one that did not fit or
 * one with a card it refused.
 */
function assertDatabaseReleasable(candidate: {
  dbPlan: unknown
  dbPlanSha256: string
  dbView: unknown
}): void {
  const plan = dbPlanSchema.safeParse(candidate.dbPlan)
  if (
    !plan.success ||
    dbPlanViewRefusal(candidate.dbView, {
      sha256: candidate.dbPlanSha256,
      operations: plan.data.length,
    }) !== null
  )
    throw commandUnavailable('release', 'database_not_releasable')
}

/**
 * `/release`, the first half (Р25–Р27): an owner or an admin of the workspace sees what will be
 * released — the trusted counts of the candidate the dialog waits with — and the number it is
 * offered under, with two neighbours; every number comes with its own confirmation, valid for
 * ten minutes and only for this user, candidate, revision, number and description of its
 * database plan (the one the panel shows). Nothing is written.
 */
export async function prepareRelease(
  db: PrismaClient,
  key: Uint8Array,
  input: { userId: string; taskId: string; now: Date },
): Promise<PreparedRelease> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true, workspaceId: true, siteId: true, status: true },
  })
  if (task === null) throw taskNotFound()
  const facts = await dialogFacts(db, task, input.userId)
  assertCommandAvailable(facts.commands, 'release')
  const live = facts.candidate
  if (live === null) throw commandUnavailable('release', 'no_candidate')
  const candidate = await db.taskCandidate.findUniqueOrThrow({
    where: { id: live.id },
    select: {
      id: true,
      revision: true,
      status: true,
      baseTree: true,
      baseVersion: true,
      facts: true,
      dbPlan: true,
      dbPlanSha256: true,
      dbView: true,
      dbViewSha256: true,
    },
  })
  const checks = await db.candidateCheck.findMany({
    where: { candidateId: candidate.id },
    select: { status: true },
  })
  const [refused] = candidateRefusalsOf({
    status: candidate.status,
    revision: candidate.revision,
    confirmedRevision: candidate.revision,
    checks,
    // Web has no git: a current candidate stands on the tree of `main` (see dialogFacts).
    baseTree: candidate.baseTree,
    mainTree: candidate.baseTree,
    releaseInProgress: facts.commands.releaseInProgress,
  })
  if (refused !== undefined) throw commandUnavailable('release', refusalOfCandidate[refused])
  assertDatabaseReleasable(candidate)

  const site = await db.site.findUniqueOrThrow({
    where: { id: task.siteId },
    select: { installedVersion: true },
  })
  const proposal = await versionProposal(db, {
    siteId: task.siteId,
    baseVersion: candidate.baseVersion,
    facts: candidate.facts,
  })
  const expiresAt = Math.floor(input.now.getTime() / 1000) + CONFIRM_TOKEN_TTL_SECONDS
  return {
    candidateId: candidate.id,
    revision: candidate.revision,
    counts: candidateCountsOf(candidate.facts),
    installedVersion: site.installedVersion,
    base: proposal.base,
    proposal: { version: proposal.version, bump: proposal.bump },
    choices: versionBumps.map((bump) => ({
      version: proposal.choices[bump],
      bump,
      confirmToken: signConfirmToken(key, {
        userId: input.userId,
        candidateId: candidate.id,
        revision: candidate.revision,
        version: proposal.choices[bump],
        dbViewSha256: candidate.dbViewSha256,
        expiresAt,
      }),
    })),
    review: reviewOf(candidate.dbView),
    expiresAt: new Date(expiresAt * 1000),
  }
}

// ---------------------------------------------------------------------------------------------
// release.confirm
// ---------------------------------------------------------------------------------------------

export interface ConfirmedRelease {
  releaseId: string
  status: ReleaseStatus
  version: string
  /** The same confirmation was delivered before: nothing was written now. */
  repeated: boolean
}

/**
 * `/release`, the second half (Р25, Р27, Р33): the confirmation is checked — its signature, its
 * time, its user and its number — and in one transaction under the lock of the dialog the
 * role, the status, the candidate, its revision and the description of its database plan, the
 * client's review of a bulk or shortened plan, the number among the choices and free on the
 * site are checked again. Then the release is written `approved` with its key, the dialog
 * moves `awaiting_approval → deploying`, its reserve is kept until the release ends, the
 * decision goes into the feed and `release.advance` into the outbox; core does the rest under
 * the lease of the site. A repeat of the same confirmation returns the same release.
 */
export async function confirmRelease(
  db: PrismaClient,
  key: Uint8Array,
  input: {
    userId: string
    taskId: string
    confirmToken: string
    version: string
    /** The client looked at every change of the database (required for a bulk or shortened plan). */
    reviewed?: boolean | undefined
    now: Date
  },
): Promise<ConfirmedRelease> {
  const { userId, now } = input
  const claims = verifyConfirmToken(key, input.confirmToken, now)
  if (claims.userId !== userId || claims.version !== input.version)
    throw releaseConfirmationInvalid()

  try {
    return await underDialogLock(db, input, async (tx, task) => {
      // A repeat lands on its release, whatever became of the dialog since: a number is used
      // once on a site, so the candidate, its revision and the number name one release.
      const earlier = await tx.siteRelease.findFirst({
        where: {
          taskId: task.id,
          candidateId: claims.candidateId,
          candidateRevision: claims.revision,
          version: claims.version,
        },
        select: { id: true, status: true, version: true },
      })
      if (earlier !== null)
        return {
          releaseId: earlier.id,
          status: earlier.status,
          version: earlier.version,
          repeated: true,
        }

      if (!isManagerRole(await memberRole(tx, task.workspaceId, userId)))
        throw commandUnavailable('release', 'not_allowed')
      if (task.status !== 'awaiting_approval') {
        if (task.status === 'deploying' || task.status === 'verifying') throw releaseInProgress()
        if (task.status === 'queued' || task.status === 'preparing' || task.status === 'running')
          throw taskBusy()
        throw taskFinished()
      }

      const candidate = await tx.taskCandidate.findFirst({
        where: { id: claims.candidateId, taskId: task.id },
        select: {
          id: true,
          revision: true,
          status: true,
          baseSha: true,
          baseTree: true,
          baseVersion: true,
          facts: true,
          dbPlan: true,
          dbPlanSha256: true,
          dbView: true,
          dbViewSha256: true,
        },
      })
      if (
        candidate === null ||
        candidate.revision !== claims.revision ||
        candidate.dbViewSha256 !== claims.dbViewSha256
      )
        throw releaseCandidateChanged()
      if (reviewOf(candidate.dbView) && input.reviewed !== true) throw releaseReviewRequired()
      // The same changes, but the site moved on under them: confirming again would not help,
      // «Обновить» does (Р15, Р27) — the words `release.prepare` has for it.
      if (candidate.status === 'stale') throw commandUnavailable('release', 'needs_update')
      if (candidate.status !== 'current') throw releaseCandidateChanged()
      const checks = await tx.candidateCheck.findMany({
        where: { candidateId: candidate.id },
        select: { status: true },
      })
      const open = await tx.siteRelease.count({
        where: {
          candidateId: candidate.id,
          status: { notIn: ['failed', 'rolled_back', 'installed'] },
        },
      })
      const [refused] = candidateRefusalsOf({
        status: candidate.status,
        revision: candidate.revision,
        confirmedRevision: claims.revision,
        checks,
        baseTree: candidate.baseTree,
        mainTree: candidate.baseTree,
        releaseInProgress: open > 0,
      })
      if (refused !== undefined) throw commandUnavailable('release', refusalOfCandidate[refused])
      assertDatabaseReleasable(candidate)

      const proposal = await versionProposal(tx, {
        siteId: task.siteId,
        baseVersion: candidate.baseVersion,
        facts: candidate.facts,
      })
      const base = parseVersion(proposal.base)
      const bump = base === null ? null : bumpOf(base, claims.version)
      if (bump === null) throw releaseVersionNotOffered()
      const taken = await tx.siteRelease.findFirst({
        where: { siteId: task.siteId, version: claims.version },
        select: { id: true },
      })
      if (taken !== null) throw releaseVersionTaken()

      const site = await tx.site.findUniqueOrThrow({
        where: { id: task.siteId },
        select: { installedSha: true },
      })
      const attempt = (await tx.siteRelease.count({ where: { candidateId: candidate.id } })) + 1
      const release = await tx.siteRelease.create({
        data: {
          siteId: task.siteId,
          taskId: task.id,
          candidateId: candidate.id,
          candidateRevision: candidate.revision,
          attempt,
          releaseKey: releaseKeyOf({
            candidateId: candidate.id,
            revision: candidate.revision,
            version: claims.version,
            attempt,
          }),
          version: claims.version,
          tag: claims.version,
          bump,
          // The `main` the client approved against; core pushes by CAS against `main` as it is,
          // after it found the trees equal (Р27).
          mainBeforeSha: candidate.baseSha,
          installedBeforeSha: site.installedSha,
          committedAt: now,
          status: 'approved',
          approvedBy: userId,
          approvedAt: now,
          enqueues: 1,
        },
        select: { id: true, status: true, version: true },
      })
      await moveTo(tx, task, 'deploying')
      await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'release') })
      await insertFeedEvent(tx, {
        taskId: task.id,
        row: {
          type: 'feed.decision',
          payload: {
            v: 1,
            kind: 'release',
            authorId: userId,
            revision: candidate.revision,
            version: claims.version,
          },
        },
      })
      await enqueueReleaseAdvance(tx, {
        releaseId: release.id,
        status: 'approved',
        step: null,
        seq: 1,
      })
      return {
        releaseId: release.id,
        status: release.status,
        version: release.version,
        repeated: false,
      }
    })
  } catch (error) {
    // Another dialog of the site took the number between the check and the insert.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw releaseVersionTaken()
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// release.get
// ---------------------------------------------------------------------------------------------

export interface ReleaseView {
  id: string
  taskId: string
  kind: ReleaseKind
  undoesReleaseId: string | null
  version: string
  bump: VersionBump
  status: ReleaseStatus
  step: string | null
  /** null while the release goes on. */
  outcome: ReleaseOutcome | null
  approvedAt: Date
  createdAt: Date
  updatedAt: Date
  /** The reports of the deploy job: the step and its state, never their details. */
  steps: { step: string; state: string; at: Date }[]
}

/** A release of a dialog the user may open; NOT_FOUND otherwise. */
export async function readRelease(
  db: PrismaClient,
  input: { userId: string; releaseId: string },
): Promise<ReleaseView> {
  const release = await db.siteRelease.findFirst({
    where: {
      id: input.releaseId,
      task: {
        site: { deletedAt: null },
        workspace: { members: { some: { userId: input.userId } } },
      },
    },
    select: {
      id: true,
      taskId: true,
      kind: true,
      undoesReleaseId: true,
      version: true,
      bump: true,
      status: true,
      step: true,
      mainPushedAt: true,
      approvedAt: true,
      createdAt: true,
      updatedAt: true,
      steps: {
        orderBy: { id: 'asc' },
        select: { step: true, state: true, createdAt: true },
      },
    },
  })
  if (release === null) throw taskNotFound()
  const { mainPushedAt, steps, ...row } = release
  return {
    ...row,
    outcome: releaseOutcomeOf(row.status, { mainMoved: mainPushedAt !== null }),
    steps: steps.map((step) => ({ step: step.step, state: step.state, at: step.createdAt })),
  }
}
