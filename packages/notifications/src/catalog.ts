import type { QueueName } from '@repo/domain'
import { mailDataSchemas, type Mailer } from '@repo/mail'
import { z } from 'zod'

/** BullMQ queue (and outbox topic) that carries notifications; job name = notification type. */
export const NOTIFICATIONS_QUEUE = 'notifications' satisfies QueueName

export interface NotificationDeps {
  mailer: Mailer
}

export interface NotificationDefinition<P> {
  channel: 'email'
  payload: z.ZodType<P>
  deliver(payload: P, deps: NotificationDeps): Promise<void>
}

function defineNotification<P>(definition: NotificationDefinition<P>): NotificationDefinition<P> {
  return definition
}

const recipient = { to: z.email() }

export const notificationCatalog = {
  'auth.verify_email': defineNotification({
    channel: 'email',
    payload: mailDataSchemas['verify-email'].extend(recipient),
    deliver: ({ to, ...data }, { mailer }) => mailer.sendMail({ kind: 'verify-email', to, data }),
  }),
  'auth.reset_password': defineNotification({
    channel: 'email',
    payload: mailDataSchemas['reset-password'].extend(recipient),
    deliver: ({ to, ...data }, { mailer }) => mailer.sendMail({ kind: 'reset-password', to, data }),
  }),
  'auth.welcome': defineNotification({
    channel: 'email',
    payload: mailDataSchemas.welcome.extend(recipient),
    deliver: ({ to, ...data }, { mailer }) => mailer.sendMail({ kind: 'welcome', to, data }),
  }),
}

export type NotificationType = keyof typeof notificationCatalog
export const notificationTypes = Object.keys(notificationCatalog) as NotificationType[]

export type NotificationPayload<T extends NotificationType> =
  (typeof notificationCatalog)[T] extends NotificationDefinition<infer P> ? P : never
