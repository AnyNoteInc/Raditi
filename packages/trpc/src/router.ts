import { attachmentRouter } from './routers/attachment.ts'
import { billingRouter } from './routers/billing.ts'
import { browserRouter } from './routers/browser.ts'
import { candidateRouter } from './routers/candidate.ts'
import { consentRouter } from './routers/consent.ts'
import { healthRouter } from './routers/health.ts'
import { previewRouter } from './routers/preview.ts'
import { projectRouter } from './routers/project.ts'
import { releaseRouter } from './routers/release.ts'
import { siteAgentSkillsRouter } from './routers/site-agent-skills.ts'
import { siteDatabaseDumpRouter } from './routers/site-database-dump.ts'
import { siteEnvRouter } from './routers/site-env.ts'
import { siteHistoryRouter } from './routers/site-history.ts'
import { taskRouter } from './routers/task.ts'
import { siteConnectionRouter } from './routers/site-connection.ts'
import { userRouter } from './routers/user.ts'
import { createCallerFactory, router } from './trpc.ts'

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  consent: consentRouter,
  project: projectRouter,
  siteConnection: siteConnectionRouter,
  billing: billingRouter,
  // A dialog of a site, its preview and the release of its changes (plan 53, «Маршруты»).
  task: taskRouter,
  candidate: candidateRouter,
  preview: previewRouter,
  release: releaseRouter,
  siteEnv: siteEnvRouter,
  // The SQL dump a preview's database is copied from, for a site whose database is not reachable.
  siteDatabaseDump: siteDatabaseDumpRouter,
  // «Изменения», «Запуски», «База и бэкап» and where the files and the database of a site are.
  siteHistory: siteHistoryRouter,
  // «Навыки агента»: the MCP servers a site's agent connects to besides the platform's.
  siteAgentSkills: siteAgentSkillsRouter,
  // A task in the cloud browser and the files of messages (docs/plan/57-browser-tasks.md).
  browser: browserRouter,
  attachment: attachmentRouter,
})

export type AppRouter = typeof appRouter

/** Server-side caller for React Server Components: `createCaller(await createContext(…))`. */
export const createCaller = createCallerFactory(appRouter)
