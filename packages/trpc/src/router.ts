import { billingRouter } from './routers/billing.ts'
import { candidateRouter } from './routers/candidate.ts'
import { consentRouter } from './routers/consent.ts'
import { healthRouter } from './routers/health.ts'
import { previewRouter } from './routers/preview.ts'
import { projectRouter } from './routers/project.ts'
import { releaseRouter } from './routers/release.ts'
import { siteEnvRouter } from './routers/site-env.ts'
import { taskRouter } from './routers/task.ts'
import { userRouter } from './routers/user.ts'
import { createCallerFactory, router } from './trpc.ts'

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  consent: consentRouter,
  project: projectRouter,
  billing: billingRouter,
  // A dialog of a site, its preview and the release of its changes (plan 53, «Маршруты»).
  task: taskRouter,
  candidate: candidateRouter,
  preview: previewRouter,
  release: releaseRouter,
  siteEnv: siteEnvRouter,
})

export type AppRouter = typeof appRouter

/** Server-side caller for React Server Components: `createCaller(await createContext(…))`. */
export const createCaller = createCallerFactory(appRouter)
