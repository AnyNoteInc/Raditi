import { artifactRouter } from './routers/artifact.ts'
import { attachmentRouter } from './routers/attachment.ts'
import { billingRouter } from './routers/billing.ts'
import { browserRouter } from './routers/browser.ts'
import { notificationRouter } from './routers/notification.ts'
import { telegramRouter } from './routers/telegram.ts'
import { consentRouter } from './routers/consent.ts'
import { documentRouter } from './routers/document.ts'
import { healthRouter } from './routers/health.ts'
import { pagesRouter } from './routers/pages.ts'
import { gitConnectionRouter } from './routers/git-connection.ts'
import { projectRouter } from './routers/project.ts'
import { projectRepoRouter } from './routers/project-repo.ts'
import { projectFileRouter } from './routers/project-file.ts'
import { projectMemoryRouter } from './routers/project-memory.ts'
import { scheduleRouter } from './routers/schedule.ts'
import { taskRouter } from './routers/task.ts'
import { userRouter } from './routers/user.ts'
import { workspaceEnvRouter } from './routers/workspace-env.ts'
import { agentSkillsRouter } from './routers/agent-skills.ts'
import { builtinMcpRouter } from './routers/builtin-mcp.ts'
import { accountSkillsRouter } from './routers/account-skills.ts'
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
  // Artifacts (docs/plan/88-artifacts.md): the live channel and presence for now (88.5).
  artifact: artifactRouter,
  // «Страницы»: the published pages of the user's workspaces (docs/plan/69-pages.md).
  pages: pagesRouter,
  // «Проекты»: chats of one matter with their instructions (docs/plan/84-projects.md).
  project: projectRouter,
  // The files and texts of the context of a project (docs/plan/84-projects.md, ПР8).
  projectFile: projectFileRouter,
  // «Память» of a project and of the account (docs/plan/84-projects.md, ПР18, ПР28).
  projectMemory: projectMemoryRouter,
  // The git connections of the user and the repository of a project (docs/plan/84-projects.md, 84.17).
  gitConnection: gitConnectionRouter,
  projectRepo: projectRepoRouter,
  // «Настройки → Переменные»: the variables every chat of a workspace gets (plan 83, БП4).
  workspaceEnv: workspaceEnvRouter,
  // «Настройки → Подключения»: the MCP servers of the workspace's agent (plan 81; plan 83, БП11).
  agentSkills: agentSkillsRouter,
  builtinMcp: builtinMcpRouter,
  // «Настройки → Навыки»: the skills of the user's account, folders with SKILL.md (plan 97).
  accountSkills: accountSkillsRouter,
  // «Запланированные задачи»: the scheduled tasks of the user (docs/plan/82-scheduled-tasks.md).
  schedule: scheduleRouter,
})

export type AppRouter = typeof appRouter

/** Server-side caller for React Server Components: `createCaller(await createContext(…))`. */
export const createCaller = createCallerFactory(appRouter)
