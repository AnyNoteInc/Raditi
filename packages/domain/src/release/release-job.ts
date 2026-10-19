import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'
import {
  releaseStatuses,
  releaseSteps,
  type ReleaseStatus,
  type ReleaseStep,
} from './release-state.ts'

/**
 * The job that moves a release on (docs/plan/53-chat-preview-release.md, «Очереди и задания»):
 * put by web at the confirmation, by the release API after a report and by the sweeper. Ids
 * and the state it was put for only (CLAUDE.md rule 2); the processor reads the row.
 */
export const RELEASE_QUEUE = 'deploys' satisfies QueueName
export const RELEASE_ADVANCE_JOB = 'release.advance'

export const releaseAdvanceJobSchema = z.strictObject({
  releaseId: z.uuid(),
  /** The status the job was put for; a job of a status the row has left does nothing. */
  status: z.enum(releaseStatuses),
  /** The step of the job's last report, null before the job started. */
  step: z.enum(releaseSteps).nullable(),
  /**
   * `site_releases.enqueues` after the increment of this enqueue, in the same transaction as
   * its outbox row: a second wake-up for the same status and step (the sweeper, the start
   * timeout, a repeated report) gets a new key instead of being dropped by the outbox.
   */
  seq: z.number().int().min(1),
})
export type ReleaseAdvanceJob = z.infer<typeof releaseAdvanceJobSchema>

/** The outbox key: `release.advance:<releaseId>:<status>:<step>:<seq>`, `-` for no step. */
export const releaseAdvanceDedupeKey = (job: {
  releaseId: string
  status: ReleaseStatus
  step: ReleaseStep | null
  seq: number
}): string => `${RELEASE_ADVANCE_JOB}:${job.releaseId}:${job.status}:${job.step ?? '-'}:${job.seq}`

/**
 * The job that works out the plan of an undo (docs/plan/53, «Отмена выпуска»): put by web when
 * the client opens «Отменить выпуск», and again by the sweeper for a plan left `pending`. core
 * reads git, production and the values of the release, and writes one row of the plan.
 */
export const RELEASE_UNDO_PLAN_JOB = 'release.undoPlan'

export const releaseUndoPlanJobSchema = z.strictObject({
  planId: z.uuid(),
  /** `release_undo_plans.enqueues` after the increment of this enqueue. */
  seq: z.number().int().min(1),
})
export type ReleaseUndoPlanJob = z.infer<typeof releaseUndoPlanJobSchema>

/** The outbox key: `release.undoPlan:<planId>:<seq>`. */
export const releaseUndoPlanDedupeKey = (job: ReleaseUndoPlanJob): string =>
  `${RELEASE_UNDO_PLAN_JOB}:${job.planId}:${job.seq}`
