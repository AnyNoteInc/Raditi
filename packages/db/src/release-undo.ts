import {
  INITIAL_VERSION_TAG,
  RELEASE_QUEUE,
  RELEASE_UNDO_PLAN_JOB,
  releaseUndoPlanDedupeKey,
  releaseUndoPlanJobSchema,
  UNDO_PLAN_PENDING_MS,
  UNDO_PLAN_TTL_MS,
  undoPlanErrors,
  type ReleaseUndoPlanJob,
  type UndoPlanError,
  type UndoPlanStatus,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'
import { enqueueOutbox } from './outbox.ts'

// The plan of «Отменить выпуск» (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): web asks
// for one when the client opens the window, core works it out (`release.undoPlan`) and writes it
// once; a plan made against what the site no longer runs is never written.

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | 'outboxEvent'>

const id = z.uuid()

/** Puts `release.undoPlan` for the plan in the caller's transaction. */
export async function enqueueUndoPlan(
  tx: Pick<Prisma.TransactionClient, 'outboxEvent'>,
  job: ReleaseUndoPlanJob,
  options: { availableAt?: Date } = {},
): Promise<boolean> {
  const parsed = releaseUndoPlanJobSchema.parse(job)
  const payload = { ...parsed, planId: parsed.planId.toLowerCase() }
  return enqueueOutbox(tx, {
    topic: RELEASE_QUEUE,
    type: RELEASE_UNDO_PLAN_JOB,
    payload,
    dedupeKey: releaseUndoPlanDedupeKey(payload),
    availableAt: options.availableAt,
  })
}

export interface UndoPlanRequest {
  id: string
  status: UndoPlanStatus
  /** A new plan was asked for now. */
  created: boolean
}

const planRows = z.array(
  z.object({
    id,
    status: z.enum(['pending', 'ready', 'failed']),
    fresh: z.boolean(),
    young: z.boolean(),
    overtaken: z.boolean(),
    installed_sha: z.string(),
  }),
)

/**
 * The plan of the undo of `releaseId` the window shows: the latest one, while it stands — a
 * ready plan made against `installedSha` and started less than UNDO_PLAN_TTL_MS ago, or a pending
 * one younger than UNDO_PLAN_PENDING_MS (a window opened twice does not ask twice), and no
 * release or undo of the site started since it was asked for (an undo that failed or was rolled
 * back wrote production) —, else a new pending one with its job, in the caller's transaction.
 */
export async function requestUndoPlan(
  tx: Tx,
  input: { releaseId: string; siteId: string; installedSha: string; userId: string },
): Promise<UndoPlanRequest> {
  const releaseId = id.parse(input.releaseId)
  const siteId = id.parse(input.siteId)
  const userId = id.parse(input.userId)
  const installedSha = z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(input.installedSha)
  const latest = planRows.parse(
    await tx.$queryRaw`
      SELECT plan.id, plan.status::text AS status, plan.installed_sha,
        plan.created_at > clock_timestamp() - ${UNDO_PLAN_TTL_MS}::int * interval '1 millisecond'
          AS fresh,
        plan.created_at > clock_timestamp() - ${UNDO_PLAN_PENDING_MS}::int
          * interval '1 millisecond' AS young,
        EXISTS (
          SELECT 1 FROM site_releases started
          WHERE started.site_id = plan.site_id
            AND (started.undo_plan_id = plan.id OR started.created_at >= plan.created_at)
        ) AS overtaken
      FROM release_undo_plans plan
      WHERE plan.release_id = ${releaseId}::uuid
      ORDER BY plan.created_at DESC, plan.id DESC
      LIMIT 1`,
  )[0]
  if (
    latest !== undefined &&
    latest.installed_sha === installedSha &&
    !latest.overtaken &&
    ((latest.status === 'ready' && latest.fresh) || (latest.status === 'pending' && latest.young))
  )
    return { id: latest.id, status: latest.status, created: false }
  const inserted = z.array(z.object({ id })).parse(
    await tx.$queryRaw`
      INSERT INTO release_undo_plans (id, site_id, release_id, requested_by, installed_sha,
        updated_at)
      VALUES (gen_random_uuid(), ${siteId}::uuid, ${releaseId}::uuid, ${userId}::uuid,
        ${installedSha}, clock_timestamp())
      RETURNING id`,
  )[0]!
  await enqueueUndoPlan(tx, { planId: inserted.id, seq: 1 })
  return { id: inserted.id, status: 'pending', created: true }
}

/**
 * Puts `release.undoPlan` again for a plan still `pending` (the sweeper: its job was lost); the
 * counter goes up in the same transaction. false — the plan is no longer pending.
 */
export async function wakeUndoPlan(
  tx: Tx,
  input: { planId: string; availableAt?: Date },
): Promise<boolean> {
  const planId = id.parse(input.planId)
  const row = z.array(z.object({ enqueues: z.number().int().min(1) })).parse(
    await tx.$queryRaw`
      UPDATE release_undo_plans SET enqueues = enqueues + 1, updated_at = clock_timestamp()
      WHERE id = ${planId}::uuid AND status = 'pending'
      RETURNING enqueues`,
  )[0]
  if (!row) return false
  await enqueueUndoPlan(
    tx,
    { planId, seq: row.enqueues },
    input.availableAt ? { availableAt: input.availableAt } : {},
  )
  return true
}

/** What core worked out: written only over a `pending` plan, once. */
export interface ReadyUndoPlan {
  planId: string
  targetTree: string
  files: unknown
  items: unknown
  dbPlan: unknown
  nothingToUndo: boolean
  planSha256: string
}

/** Writes a ready plan; false — it was written or failed before. */
export async function recordUndoPlan(tx: Tx, plan: ReadyUndoPlan): Promise<boolean> {
  const planId = id.parse(plan.planId)
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE release_undo_plans SET status = 'ready', target_tree = ${plan.targetTree},
      files = ${JSON.stringify(plan.files)}::jsonb, items = ${JSON.stringify(plan.items)}::jsonb,
      db_plan = ${JSON.stringify(plan.dbPlan)}::jsonb, nothing_to_undo = ${plan.nothingToUndo},
      plan_sha256 = ${plan.planSha256}, computed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${planId}::uuid AND status = 'pending'
    RETURNING id`
  return rows.length === 1
}

/** Ends a pending plan without one; false — it was written or failed before. */
export async function failUndoPlan(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { planId: string; code: UndoPlanError },
): Promise<boolean> {
  const planId = id.parse(input.planId)
  const code = z.enum(undoPlanErrors).parse(input.code)
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE release_undo_plans SET status = 'failed', error_code = ${code},
      updated_at = clock_timestamp()
    WHERE id = ${planId}::uuid AND status = 'pending'
    RETURNING id`
  return rows.length === 1
}

/**
 * The version the undo of a release goes back to: the version of the release whose commit the
 * hosting held before it (`installedBeforeSha`), `v0.0.0` for the import.
 */
export async function undoReturnsTo(
  db: Pick<Prisma.TransactionClient, 'siteRelease'>,
  input: { siteId: string; installedBeforeSha: string | null },
): Promise<string> {
  if (input.installedBeforeSha === null) return INITIAL_VERSION_TAG
  const before = await db.siteRelease.findFirst({
    where: { siteId: input.siteId, approvedSha: input.installedBeforeSha, status: 'installed' },
    orderBy: { createdAt: 'desc' },
    select: { version: true },
  })
  return before?.version ?? INITIAL_VERSION_TAG
}
