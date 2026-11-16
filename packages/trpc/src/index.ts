// tRPC transport for the web app: context from the session, procedures, routers.
export { CONSENT_REQUIRED } from './errors.ts'
export { appRouter, createCaller, type AppRouter } from './router.ts'
export { createContext, type BillingContext } from './trpc.ts'
// What the procedures of a dialog reach outside the database; the app builds it (plan 53).
export { type ChatContext, type ChatSecretWriter } from './services/chat/context.ts'
// A snapshot the agent took of a task's browser for the client (`web_screenshot`).
export { readTaskFile, type ChatFile } from './services/chat/files.ts'
// The documents of a chat and the tokens of the domain of pages (docs/plan/67-agent-documents.md).
export { readChatImage } from './services/chat/documents.ts'
export {
  pageKeys,
  readPageView,
  type PageKeys,
  type PageView,
} from './services/chat/page-tokens.ts'
export { cabinetDocMarkdown } from './services/pages.ts'
export { readTaskScreenshot } from './services/chat/screenshots.ts'

export { readChatNotification } from './services/notifications.ts'
// The runs of scheduled tasks, handed by core to web (docs/plan/82-scheduled-tasks.md, §4.3).
export { startScheduledRun } from './services/schedule/runs.ts'
export type {
  McpServerCheck,
  McpServerProbe,
  McpServerServices,
} from './services/mcp-server-auth.ts'
export { checkSkillSignIn, connectSignedInServer } from './services/agent-skills.ts'
// The updates of the bot of the chat in Telegram, handed by core to web (docs/plan/80-telegram.md).
export {
  handleTelegramTopicGone,
  handleTelegramUpdate,
  type IntakeAnswer,
  type TelegramIntakeDeps,
  type TelegramMedia,
} from './services/telegram/intake.ts'
export { startAttachmentForTelegram } from './services/chat/attachments.ts'
export { toTRPCError } from './errors.ts'
