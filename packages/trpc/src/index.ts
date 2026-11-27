// tRPC transport for the web app: context from the session, procedures, routers.
export { CONSENT_REQUIRED } from './errors.ts'
export { appRouter, createCaller, type AppRouter } from './router.ts'
export { createContext, type BillingContext } from './trpc.ts'
// What the procedures of a dialog reach outside the database; the app builds it (plan 53).
export { type ChatContext, type ChatSecretWriter } from './services/chat/context.ts'
// Where the signals of changed chats come from; web builds it from Redis (spec §7).
export type { ArtifactSignals } from './services/artifacts/signals.ts'
export type { TaskSignals } from './services/chat/signals.ts'
// A snapshot the agent took of a task's browser for the client (`web_screenshot`).
export { readTaskFile, type ChatFile } from './services/chat/files.ts'
export { readArtifactExport } from './services/artifacts/exports.ts'
// The thumbnails of the screens of a canvas (docs/plan/88-artifacts.md, §7.7, slice 88.15).
export { canvasThumbFile } from './services/artifacts/canvas.ts'
// The frame of a canvas, slide or picture, its files and the edit frame (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28).
export {
  isArtifactFileToken,
  isArtifactFrameToken,
  readArtifactEditViewer,
  serveArtifactFile,
  serveArtifactFrame,
  type ArtifactPlatformFonts,
} from './services/artifacts/frame.ts'
// The documents of a chat and the tokens of the domain of pages (docs/plan/67-agent-documents.md).
export { readChatImage } from './services/chat/documents.ts'
export {
  pageKeys,
  readPageView,
  signArtifactToken,
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
// The git connections of the user (docs/plan/84-projects.md, 84.17): the return from gitlab.com.
export {
  connectGithubApp,
  connectGitlabOAuth,
  type GitServices,
} from './services/git/connections.ts'
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
// The skills of an account (docs/plan/97-skills.md): web composes their services and takes an
// uploaded archive outside tRPC (POST /api/skills/upload).
export {
  installSkillFromArchive,
  type AccountSkillServices,
  type InstallAnswer,
} from './services/account-skills.ts'
