import { billingRouter } from './routers/billing.ts'
import { consentRouter } from './routers/consent.ts'
import { healthRouter } from './routers/health.ts'
import { projectRouter } from './routers/project.ts'
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
})

export type AppRouter = typeof appRouter

/** Server-side caller for React Server Components: `createCaller(await createContext(…))`. */
export const createCaller = createCallerFactory(appRouter)
