import { createHash } from 'node:crypto'

import { enqueueOutbox, prisma, type OutboxWriter, type Prisma } from '@repo/db'

import {
  NOTIFICATIONS_QUEUE,
  notificationCatalog,
  type NotificationDefinition,
  type NotificationPayload,
  type NotificationType,
} from './catalog.ts'

export interface EnqueueNotificationOptions {
  /** Transaction client to enqueue atomically with the business change; defaults to the global client. */
  db?: OutboxWriter
  /** Skips the notification when one with the same key was already enqueued. */
  dedupeKey?: string
}

/**
 * Validates the payload and writes it to outbox_events; the relay publishes it to BullMQ.
 * Returns false when the dedupe key was already used.
 */
export async function enqueueNotification<T extends NotificationType>(
  type: T,
  payload: NotificationPayload<T>,
  options: EnqueueNotificationOptions = {},
): Promise<boolean> {
  const definition: NotificationDefinition<unknown> = notificationCatalog[type]
  // Fail in the request that caused the notification, not later in the worker.
  // Every payload schema is a flat object of strings and whole numbers, so the result is JSON.
  const valid = definition.payload.parse(payload) as Prisma.InputJsonObject
  return enqueueOutbox(options.db ?? prisma, {
    topic: NOTIFICATIONS_QUEUE,
    type,
    payload: valid,
    dedupeKey: options.dedupeKey,
  })
}

/** The link carries a one-time token; the key holds only its hash. */
function linkKey(type: NotificationType, url: string): string {
  return `${type}:${createHash('sha256').update(url).digest('hex').slice(0, 32)}`
}

type Options = Omit<EnqueueNotificationOptions, 'dedupeKey'>

export const notify = {
  /** A repeated call with the same link (a retried auth hook) sends one letter. */
  verifyEmail: (payload: NotificationPayload<'auth.verify_email'>, options: Options = {}) =>
    enqueueNotification('auth.verify_email', payload, {
      ...options,
      dedupeKey: linkKey('auth.verify_email', payload.url),
    }),

  resetPassword: (payload: NotificationPayload<'auth.reset_password'>, options: Options = {}) =>
    enqueueNotification('auth.reset_password', payload, {
      ...options,
      dedupeKey: linkKey('auth.reset_password', payload.url),
    }),

  /** At most one welcome letter per user. */
  welcome: (
    { userId, ...payload }: NotificationPayload<'auth.welcome'> & { userId: string },
    options: Options = {},
  ) =>
    enqueueNotification('auth.welcome', payload, {
      ...options,
      dedupeKey: `auth.welcome:${userId}`,
    }),
}
