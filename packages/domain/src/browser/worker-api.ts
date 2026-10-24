import { z } from 'zod'

import {
  browserCloseReasons,
  browserSessionStateSchema,
  browserSessionStatuses,
} from './session.ts'
import {
  browserActionSchema,
  browserTaskCodeNames,
  browserToolLimits,
  browserToolResultSchema,
  browserVerifiedCheckpointSchema,
} from './tools.ts'

/**
 * The internal API of the browser worker (`apps/browser`, docs/plan/57-browser-tasks.md, §3.5):
 * HTTP JSON with `Authorization: Bearer <BROWSER_WORKER_TOKEN>` for `core` and `apps/mcp`, and a
 * WebSocket for the stream gateway. Neither the token nor a control socket of a browser ever
 * appears in an answer, a log or an error.
 */
export const browserWorkerPaths = Object.freeze({
  ensure: '/v1/sessions/ensure',
  list: '/v1/sessions',
  close: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/close`,
  verify: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/verify`,
  actions: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
  stream: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/stream`,
})

/**
 * `BROWSER_WORKER_TOKEN`, as core, mcp, preview and the worker itself read it: one visible word
 * of `Authorization: Bearer`, long enough not to be guessed (`openssl rand -base64 48`) and short
 * enough for a header. One rule, so a token one app takes is never refused by another.
 */
export const browserWorkerTokenSchema = z
  .string()
  .regex(/^[\x21-\x7e]{32,4096}$/, 'must be 32 to 4096 visible ASCII characters without spaces')

/** `sites.agent_notes` (Б8): hints for the agent the client wrote in the wizard. */
export const BROWSER_AGENT_NOTES_MAX_CHARS = 2000

/**
 * `POST /v1/sessions/ensure` (core, before a pass): the live session of the task, started when
 * there is none. `takeControl` — a turn starts: the agent takes the browser back from the client
 * (Б16). Answers the state (`browserSessionStateSchema`). The worker reads the site's address and
 * stack from the database by `siteId`: where the browser may go is never the caller's word.
 */
export const browserEnsureRequestSchema = z.strictObject({
  sessionId: z.uuid(),
  taskId: z.uuid(),
  siteId: z.uuid(),
  takeControl: z.boolean(),
})
export type BrowserEnsureRequest = z.infer<typeof browserEnsureRequestSchema>
export const browserEnsureResponseSchema = browserSessionStateSchema

/** `POST /v1/sessions/:id/close` (core): containers and files go; closing twice is no error. */
export const browserCloseRequestSchema = z.strictObject({ reason: z.enum(browserCloseReasons) })
export type BrowserCloseRequest = z.infer<typeof browserCloseRequestSchema>
export const browserCloseResponseSchema = z.strictObject({
  sessionId: z.uuid(),
  status: z.enum(browserSessionStatuses),
})

/**
 * `POST /v1/sessions/:id/verify` (core at the end of a pass and on «Остановить», mcp for
 * `web_verify`): every checkpoint of the task read again through the session; the worker records
 * what it found (`browser_checkpoints`) and answers it.
 */
export const browserVerifyRequestSchema = z.strictObject({})
export const browserVerifyResponseSchema = z.strictObject({
  checkpoints: z.array(browserVerifiedCheckpointSchema).max(browserToolLimits.verifyObjects),
})
export type BrowserVerifyResponse = z.infer<typeof browserVerifyResponseSchema>

/** `GET /v1/sessions` (core's collector): what the worker holds, to compare with the database. */
export const browserListResponseSchema = z.strictObject({
  sessions: z
    .array(
      z.strictObject({
        sessionId: z.uuid(),
        taskId: z.uuid(),
        status: z.enum(browserSessionStatuses),
      }),
    )
    .max(1024),
})
export type BrowserListResponse = z.infer<typeof browserListResponseSchema>

/**
 * `POST /v1/sessions/:id/actions` (mcp): one action of the agent in the turn of `assignmentId`.
 * The worker checks the session is the task's, the control is the agent's and the observation
 * is the latest, runs it and answers its result, or refuses with a fixed code.
 */
export const browserActionRequestSchema = z.strictObject({
  taskId: z.uuid(),
  assignmentId: z.uuid(),
  action: browserActionSchema,
})
export type BrowserActionRequest = z.infer<typeof browserActionRequestSchema>
export const browserActionResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: browserToolResultSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(browserTaskCodeNames) }),
])
export type BrowserActionResponse = z.infer<typeof browserActionResponseSchema>

/**
 * `WS /v1/sessions/:id/stream?viewer=<uuid>&user=<uuid>` (the gateway): who watches through this
 * connection. The gateway authenticated the user; the viewer is the tab, the holder of control.
 */
export const browserStreamQuerySchema = z.strictObject({ viewer: z.uuid(), user: z.uuid() })
export type BrowserStreamQuery = z.infer<typeof browserStreamQuerySchema>

/** What the worker answers a request it refuses as a whole (an unknown session, a bad body). */
export const browserWorkerErrorSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
})
