import { badRequest } from '@repo/domain'
import { z } from 'zod'

import {
  notificationCatalog,
  notificationTypes,
  type NotificationDefinition,
  type NotificationDeps,
} from './catalog.ts'

const envelopeSchema = z.object({
  type: z.enum(notificationTypes),
  payload: z.unknown(),
})

/**
 * Delivers one notification job; the orchestrator's BullMQ processor calls it with
 * { type: job.name, payload: job.data }. Invalid events throw a BAD_REQUEST DomainError
 * (retrying will not help); delivery failures are rethrown so BullMQ retries them.
 */
export async function deliverNotification(
  event: { type: string; payload: unknown },
  deps: NotificationDeps,
): Promise<void> {
  const envelope = envelopeSchema.safeParse(event)
  if (!envelope.success) throw badRequest(`Unknown notification type: ${event.type}`)
  const { type } = envelope.data
  const definition: NotificationDefinition<unknown> = notificationCatalog[type]
  const payload = definition.payload.safeParse(envelope.data.payload)
  if (!payload.success) {
    // Field names only: the payload holds addresses and one-time links.
    const fields = payload.error.issues.map((issue) => issue.path.join('.') || '(root)')
    throw badRequest(`Invalid payload for notification ${type}`, { fields })
  }
  await definition.deliver(payload.data, deps)
}
