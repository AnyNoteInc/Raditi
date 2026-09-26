// tRPC transport for the web app: context from the session, procedures, routers.
export {
  clientMessage,
  CONSENT_REQUIRED,
  CONSENT_REQUIRED_MESSAGE,
  formatError,
  INTERNAL_ERROR_MESSAGE,
  INVALID_INPUT_MESSAGE,
  mapDomain,
  toTRPCError,
  trpcCodeForStatus,
  type ErrorDetails,
} from './errors.ts'
export {
  appRouter,
  createCaller,
  type AppRouter,
  type RouterInputs,
  type RouterOutputs,
} from './router.ts'
export { type ConsentStatus } from './services/consents.ts'
export {
  consentedProcedure,
  createCallerFactory,
  createContext,
  protectedProcedure,
  publicProcedure,
  router,
  type Context,
  type CreateContextOptions,
} from './trpc.ts'
