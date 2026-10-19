// tRPC transport for the web app: context from the session, procedures, routers.
export { CONSENT_REQUIRED } from './errors.ts'
export { appRouter, createCaller, type AppRouter } from './router.ts'
export { createContext, type BillingContext } from './trpc.ts'
// `/preview/open` of web (plan 53, Р19): a ticket for the exact host of a preview.
export { issuePreviewTicket, openPreview } from './services/chat/previews.ts'
// What the procedures of a dialog reach outside the database; the app builds it (plan 53).
export { releaseConfirmKey, type ChatContext } from './services/chat/context.ts'
// The screenshot of a check of a candidate, for the route of web that serves it (plan 53, Р22).
export { readCheckScreenshot } from './services/chat/candidates.ts'
