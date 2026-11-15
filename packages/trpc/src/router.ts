import { attachmentRouter } from './routers/attachment.ts'
import { billingRouter } from './routers/billing.ts'
import { browserRouter } from './routers/browser.ts'
import { notificationRouter } from './routers/notification.ts'
import { telegramRouter } from './routers/telegram.ts'
import { consentRouter } from './routers/consent.ts'
import { documentRouter } from './routers/document.ts'
import { healthRouter } from './routers/health.ts'
import { pagesRouter } from './routers/pages.ts'
import { taskRouter } from './routers/task.ts'
import { userRouter } from './routers/user.ts'
import { workspaceEnvRouter } from './routers/workspace-env.ts'
import { agentSkillsRouter } from './routers/agent-skills.ts'
import { createCallerFactory, router } from './trpc.ts'

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  consent: consentRouter,
  notification: notificationRouter,
  telegram: telegramRouter,
  billing: billingRouter,
  // A dialog of a site, its preview and the release of its changes (plan 53, «Маршруты»).
  task: taskRouter,
  // A task in the cloud browser and the files of messages (docs/plan/57-browser-tasks.md).
  browser: browserRouter,
  attachment: attachmentRouter,
  // The pages and text documents the agent makes in a chat (docs/plan/67-agent-documents.md).
  document: documentRouter,
  // «Страницы»: the published pages of the user's workspaces (docs/plan/69-pages.md).
  pages: pagesRouter,
  // «Настройки → Переменные»: the variables every chat of a workspace gets (plan 83, БП4).
  workspaceEnv: workspaceEnvRouter,
  // «Настройки → Навыки агента»: the MCP servers of the workspace's agent (plan 81; plan 83, БП11).
  agentSkills: agentSkillsRouter,
})

export type AppRouter = typeof appRouter

/** Server-side caller for React Server Components: `createCaller(await createContext(…))`. */
export const createCaller = createCallerFactory(appRouter)
