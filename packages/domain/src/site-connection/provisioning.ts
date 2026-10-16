import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'
import { provisioningStages, type ProvisioningStage } from './kinds.ts'

/** Short stages (database_schema: at most a minute). */
export const SITE_PROVISIONING_QUEUE = 'site-provisioning' satisfies QueueName
/** The long stage (code_import: up to an hour) has its own queue, so a short one never waits behind it. */
export const SITE_IMPORT_QUEUE = 'site-import' satisfies QueueName

const queueByStage: Record<ProvisioningStage, QueueName> = {
  code_import: SITE_IMPORT_QUEUE,
  database_schema: SITE_PROVISIONING_QUEUE,
}

/** A lookup table, not a comparison scattered through core. */
export const siteProvisionQueue = (stage: ProvisioningStage): QueueName => queueByStage[stage]

export const SITE_PROVISION_JOB = 'site.provision'

/** Ids only (CLAUDE.md rule 2): everything else is read from PostgreSQL and Vault by the worker. */
export const siteProvisionJobSchema = z.strictObject({
  siteId: z.uuid(),
  stage: z.enum(provisioningStages),
})
export type SiteProvisionJob = z.infer<typeof siteProvisionJobSchema>

/** The outbox event of a stage: written at creation, at a retry and when a running stage returns to the queue. */
export const siteProvisionDedupeKey = (
  siteId: string,
  stage: ProvisioningStage,
  attempt: number,
  enqueues: number,
): string => `site-provisioning:${siteId}:${stage}:${attempt}:${enqueues}`

/**
 * The job id of a wake-up sent directly to BullMQ (no database write, so no outbox) for a stage that sits
 * `queued`. `tag` makes it repeat at most once per tag: the sweep passes the five-minute bucket of the clock,
 * the hand-over after an import of the same workspace passes `next-<siteId>-<leaseEpoch>` of the stage that ended.
 */
export const siteProvisionWakeJobId = (
  siteId: string,
  stage: ProvisioningStage,
  attempt: number,
  tag: string,
): string => `site-provisioning:${siteId}:${stage}:${attempt}:wake:${tag}`
