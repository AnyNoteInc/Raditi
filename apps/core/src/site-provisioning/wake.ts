import {
  SITE_IMPORT_QUEUE,
  SITE_PROVISION_JOB,
  siteProvisionWakeJobId,
  withTimeout,
  type JobQueue,
} from '@repo/domain'

import type { SiteImportStore } from './stage-store.ts'

/** As the outbox relay: an add that Redis does not answer must not hold the caller. */
const WAKE_TIMEOUT_MS = 5_000

/** An import that left `running` (or never started): its workspace may start the next one. */
export interface EndedImport {
  siteId: string
  workspaceId: string
  leaseEpoch: number
}

/**
 * A wake-up job straight into BullMQ: no database write, so no outbox. The job id repeats per
 * tag, so one tag wakes a stage at most once (siteProvisionWakeJobId).
 */
export async function wakeImport(
  queue: JobQueue,
  stage: { siteId: string; attempt: number },
  tag: string,
): Promise<void> {
  await withTimeout(
    queue.enqueue(
      SITE_IMPORT_QUEUE,
      SITE_PROVISION_JOB,
      { siteId: stage.siteId, stage: 'code_import' },
      { jobId: siteProvisionWakeJobId(stage.siteId, 'code_import', stage.attempt, tag) },
    ),
    WAKE_TIMEOUT_MS,
    'Site import wake-up timed out',
  )
}

/**
 * At most one import of a workspace runs (provisioningLimits.importsPerWorkspace): the claim of
 * another site of it was a no-op. Once one ends, the oldest waiting one of the same workspace —
 * never the one that ended, whose own event carries its delay — gets a wake-up tagged by the
 * stage that ended and its epoch.
 */
export async function wakeNextImport(
  store: Pick<SiteImportStore, 'nextQueued'>,
  queue: JobQueue,
  ended: EndedImport,
): Promise<void> {
  const next = await store.nextQueued(ended.workspaceId, ended.siteId)
  if (next) await wakeImport(queue, next, `next-${ended.siteId}-${ended.leaseEpoch}`)
}
