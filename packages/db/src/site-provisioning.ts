import {
  SITE_PROVISION_JOB,
  siteProvisionDedupeKey,
  siteProvisionJobSchema,
  siteProvisionQueue,
  type ProvisioningStage,
} from '@repo/domain'
import { z } from 'zod'

import { enqueueOutbox, type OutboxWriter } from './outbox.ts'

// The counters of the stage row, as its CHECK has them: they are part of the dedupe key, and a
// key built from anything else would silently skip a later event of the stage.
const counter = z.number().int().positive()

/**
 * Writes the outbox event of one stage of a site connection (spec §12) in the caller's
 * transaction; false when the key exists. The job carries ids only (CLAUDE.md, rule 2): the
 * worker reads everything else from PostgreSQL and Vault.
 */
export async function enqueueSiteProvisioningStage(
  tx: OutboxWriter,
  input: {
    siteId: string
    stage: ProvisioningStage
    attempt: number
    enqueues: number
    /** Earliest publish time; only the graceful release of a running stage sets it. */
    availableAt?: Date
  },
): Promise<boolean> {
  // Fail in the transaction that queued the stage, not later in the worker.
  const job = siteProvisionJobSchema.parse({ siteId: input.siteId, stage: input.stage })
  // As PostgreSQL prints the id: an id typed in upper case is the same site and the same event.
  const payload = { ...job, siteId: job.siteId.toLowerCase() }
  const attempt = counter.parse(input.attempt)
  const enqueues = counter.parse(input.enqueues)
  return enqueueOutbox(tx, {
    topic: siteProvisionQueue(payload.stage),
    type: SITE_PROVISION_JOB,
    payload,
    dedupeKey: siteProvisionDedupeKey(payload.siteId, payload.stage, attempt, enqueues),
    availableAt: input.availableAt,
  })
}
