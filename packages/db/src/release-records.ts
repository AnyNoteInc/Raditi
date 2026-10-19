import {
  releaseStatuses,
  releaseStepDetailSchema,
  releaseSteps,
  releaseStepStates,
  writingReleaseSteps,
  type ReleaseStep,
  type ReleaseStepDetail,
  type ReleaseStepState,
} from '@repo/domain'
import { z } from 'zod'

import { enqueueReleaseAdvance } from './chat-outbox.ts'
import type { Prisma } from './generated/prisma/client.ts'

// What a release keeps of its deploy job and how it is woken (docs/plan/53-chat-preview-
// release.md, Р30, Р32, «Очереди и задания»): the reports of the steps, one row per report key,
// and every enqueue of `release.advance` with the counter of the row in its key.

type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>

const id = z.uuid()
const attempt = z.number().int().min(1).max(999_999)

const stepSchema = z.strictObject({
  releaseId: id,
  deployAttempt: attempt,
  step: z.enum(releaseSteps),
  state: z.enum(releaseStepStates),
  reportKey: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  detail: releaseStepDetailSchema,
})

export interface ReleaseStepRecord {
  releaseId: string
  deployAttempt: number
  step: ReleaseStep
  state: ReleaseStepState
  reportKey: string
  detail: ReleaseStepDetail
}

/**
 * A report of the deploy job, once: the key names the attempt, the step and the state, so a
 * repeat of the same report lands on its row. true — written now; false — it was there.
 */
export async function recordReleaseStep(tx: Tx, input: ReleaseStepRecord): Promise<boolean> {
  const step = stepSchema.parse(input)
  const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO release_steps (release_id, deploy_attempt, step, state, report_key, detail)
    VALUES (${step.releaseId}::uuid, ${step.deployAttempt}, ${step.step}, ${step.state},
      ${step.reportKey}, ${JSON.stringify(step.detail)}::jsonb)
    ON CONFLICT (release_id, report_key) DO NOTHING
    RETURNING id`
  return rows.length === 1
}

/**
 * Whether the deploy job of an attempt may have written to the hosting: a writing step of it
 * (`files`, `db`) reported `started` (Р30). Before that, nothing on the hosting is the release's.
 */
export async function releaseAttemptWrote(
  tx: Tx,
  input: { releaseId: string; deployAttempt: number },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const deployAttempt = attempt.parse(input.deployAttempt)
  const rows = z.array(z.object({ wrote: z.boolean() })).parse(
    await tx.$queryRaw`
      SELECT EXISTS(
        SELECT 1 FROM release_steps
        WHERE release_id = ${releaseId}::uuid AND deploy_attempt = ${deployAttempt}
          AND step = ANY(${[...writingReleaseSteps]}::text[]) AND state = 'started'
      ) AS wrote`,
  )
  return rows[0]?.wrote === true
}

/**
 * The latest deploy attempt of a release that may have written to the hosting (a writing step
 * reported `started`); null — none did. An attempt after it can only be an attempt «только
 * возврат» of what that one wrote (Р31).
 */
export async function releaseWritingAttempt(
  tx: Tx,
  input: { releaseId: string },
): Promise<number | null> {
  const releaseId = id.parse(input.releaseId)
  const rows = z.array(z.object({ attempt: z.number().int().nullable() })).parse(
    await tx.$queryRaw`
      SELECT max(deploy_attempt)::int AS attempt FROM release_steps
      WHERE release_id = ${releaseId}::uuid
        AND step = ANY(${[...writingReleaseSteps]}::text[]) AND state = 'started'`,
  )
  return rows[0]?.attempt ?? null
}

const wakeRows = z.array(
  z.object({
    status: z.enum(releaseStatuses),
    step: z.enum(releaseSteps).nullable(),
    enqueues: z.number().int().min(1),
  }),
)

/**
 * Puts `release.advance` for the release as its row stands, in the caller's transaction: the
 * counter `enqueues` goes up, and the job carries it as `seq`, so a second wake-up for the same
 * status and step is a new outbox row instead of a duplicate. `availableAt` — not before then
 * (a retry, the deadline of a start). false — no such release.
 */
export async function wakeRelease(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'outboxEvent'>,
  input: { releaseId: string; availableAt?: Date },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const row = wakeRows.parse(
    await tx.$queryRaw`
      UPDATE site_releases SET enqueues = enqueues + 1, updated_at = clock_timestamp()
      WHERE id = ${releaseId}::uuid
      RETURNING status::text AS status, step, enqueues`,
  )[0]
  if (!row) return false
  await enqueueReleaseAdvance(
    tx,
    { releaseId, status: row.status, step: row.step, seq: row.enqueues },
    input.availableAt ? { availableAt: input.availableAt } : {},
  )
  return true
}
