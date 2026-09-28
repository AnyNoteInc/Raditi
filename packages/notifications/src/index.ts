// Notifications: web and auth enqueue through the outbox, the orchestrator delivers.
export {
  NOTIFICATIONS_QUEUE,
  notificationCatalog,
  notificationTypes,
  type NotificationDefinition,
  type NotificationDeps,
  type NotificationPayload,
  type NotificationType,
} from './catalog.ts'
export { deliverNotification } from './deliver.ts'
export { enqueueNotification, notify, type EnqueueNotificationOptions } from './enqueue.ts'
