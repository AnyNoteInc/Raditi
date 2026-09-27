import { consentRouter } from './routers/consent.ts'
import { healthRouter } from './routers/health.ts'
import { userRouter } from './routers/user.ts'
import { createCallerFactory, router } from './trpc.ts'

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  consent: consentRouter,
})

export type AppRouter = typeof appRouter

/** Server-side caller for React Server Components: `createCaller(await createContext(…))`. */
export const createCaller = createCallerFactory(appRouter)
