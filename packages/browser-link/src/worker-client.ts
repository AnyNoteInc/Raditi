import { Buffer } from 'node:buffer'

import {
  badRequest,
  browserActionRequestSchema,
  browserActionResponseSchema,
  browserCloseRequestSchema,
  browserCloseResponseSchema,
  browserEnsureRequestSchema,
  browserEnsureResponseSchema,
  browserListResponseSchema,
  browserSessionTimings,
  browserTaskCodeNames,
  browserTaskCodes,
  browserVerifyResponseSchema,
  browserWorkerErrorSchema,
  browserWorkerPaths,
  DomainError,
  type BrowserActionRequest,
  type BrowserCloseRequest,
  type BrowserEnsureRequest,
  type BrowserListResponse,
  type BrowserSessionState,
  type BrowserTaskCode,
  type BrowserToolResult,
  type BrowserVerifyResponse,
} from '@repo/domain'
import { z } from 'zod'

import { browserWorkerOrigin } from './worker-url.ts'

// The HTTP client of the browser worker's internal API (docs/plan/57-browser-tasks.md, §3.5) for
// core (ensure, close, verify, list) and apps/mcp (actions, verify). One request per call, no
// retry: ensure and close are idempotent by the session id, an action is not, and the callers
// know which. A failure is a DomainError with a fixed code and a fixed message: neither the token
// nor the worker's address nor anything the worker sent back ever reaches an error.

export type BrowserWorkerOperation = 'ensure' | 'close' | 'verify' | 'list' | 'action'

/** How long each call may take, end to end (the answer read included). */
export interface BrowserWorkerTimeouts {
  /** A cold start launches the containers of a browser. */
  ensureMs: number
  closeMs: number
  /** Within one `web_verify` call of the agent, so within its budget too. */
  verifyMs: number
  listMs: number
  /** Within one `web_*` call of the agent (`browserSessionTimings.toolCallBudgetMs`). */
  actionMs: number
}

const COLD_START_MAX_MS = 90_000

export const browserWorkerTimeoutDefaults: Readonly<BrowserWorkerTimeouts> = Object.freeze({
  ensureMs: COLD_START_MAX_MS,
  closeMs: 30_000,
  verifyMs: 40_000,
  listMs: 10_000,
  // The budget less the room apps/mcp needs to admit the call and answer the agent.
  actionMs: browserSessionTimings.toolCallBudgetMs - 5_000,
})

/** The longest each call may be given: a slower call would outlive its caller. */
const timeoutMax: Readonly<BrowserWorkerTimeouts> = Object.freeze({
  ensureMs: COLD_START_MAX_MS,
  closeMs: COLD_START_MAX_MS,
  verifyMs: browserSessionTimings.toolCallBudgetMs,
  listMs: COLD_START_MAX_MS,
  actionMs: browserSessionTimings.toolCallBudgetMs,
})

/**
 * The largest answer read: an observation is bounded by the 64 KiB of a tool answer, a list by
 * 1024 short rows; anything near this is not the worker speaking.
 */
export const BROWSER_WORKER_RESPONSE_MAX_BYTES = 1024 * 1024

/** What went wrong, in `DomainError.details`: no address, no token, nothing the worker sent. */
export interface BrowserWorkerFailure {
  operation: BrowserWorkerOperation
  /**
   * `unreachable` — no answer (refused, reset); `timeout` — none in time; `status` — an HTTP
   * error or a redirect with no code of the worker; `body` — an answer that is not the
   * contract's; `refused` — the worker refused with its own code.
   */
  failure: 'unreachable' | 'timeout' | 'status' | 'body' | 'refused'
  /** The HTTP status, when an answer came. */
  status?: number
}

export interface BrowserWorkerCallOptions {
  /** The caller's own cancellation; the call then rejects with the signal's reason. */
  signal?: AbortSignal
}

export interface BrowserWorkerClient {
  /** `POST /v1/sessions/ensure`: the live session of the task, started when there is none. */
  ensure(
    request: BrowserEnsureRequest,
    options?: BrowserWorkerCallOptions,
  ): Promise<BrowserSessionState>
  /** `POST /v1/sessions/:id/close`; closing a closed session again is no error. */
  close(
    sessionId: string,
    request: BrowserCloseRequest,
    options?: BrowserWorkerCallOptions,
  ): Promise<BrowserClosed>
  /** `POST /v1/sessions/:id/verify`: every checkpoint of the task read again on the site. */
  verify(sessionId: string, options?: BrowserWorkerCallOptions): Promise<BrowserVerifyResponse>
  /** `GET /v1/sessions`: what the worker holds, for the collector. */
  list(options?: BrowserWorkerCallOptions): Promise<BrowserListResponse>
  /**
   * `POST /v1/sessions/:id/actions`: one action of the agent. A refusal of the worker
   * (`{ ok: false, code }`) rejects with that code, so every failure of a call is one error.
   */
  action(
    sessionId: string,
    request: BrowserActionRequest,
    options?: BrowserWorkerCallOptions,
  ): Promise<BrowserToolResult>
}

export type BrowserClosed = z.infer<typeof browserCloseResponseSchema>

export interface BrowserWorkerClientOptions {
  /** The worker's internal origin, `http://127.0.0.1:8086`. */
  baseUrl: string
  /** `BROWSER_WORKER_TOKEN`: kept in this closure, sent only as `Authorization: Bearer`. */
  token: string
  fetch?: typeof fetch
  timeouts?: Partial<BrowserWorkerTimeouts>
}

/** A bearer token is one visible ASCII word: anything else could split or bend the header. */
const BEARER_TOKEN = /^[\x21-\x7e]{1,4096}$/
const sessionIdSchema = z.uuid()
const taskCodes: ReadonlySet<string> = new Set(browserTaskCodeNames)
const isTaskCode = (code: string): code is BrowserTaskCode => taskCodes.has(code)
/** A failed read or parse of an answer, told apart from a failed exchange. */
const UNREADABLE = Symbol('unreadable')

export function createBrowserWorkerClient(
  options: BrowserWorkerClientOptions,
): BrowserWorkerClient {
  const origin = browserWorkerOrigin(options.baseUrl)
  if (!BEARER_TOKEN.test(options.token))
    throw new Error('The browser worker token must be visible ASCII without spaces')
  const authorization = `Bearer ${options.token}`
  const fetchImpl = options.fetch ?? fetch
  const timeouts = timeoutsOf(options.timeouts ?? {})

  async function call<S extends z.ZodType>(
    operation: BrowserWorkerOperation,
    schema: S,
    path: string,
    body: unknown,
    callOptions: BrowserWorkerCallOptions | undefined,
  ): Promise<z.output<S>> {
    const caller = callOptions?.signal
    caller?.throwIfAborted()
    const timeout = AbortSignal.timeout(timeouts[`${operation}Ms` as const])
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout
    const headers: Record<string, string> = { authorization, accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let status: number
    let answer: unknown
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect is not the worker answering; it would also carry the token elsewhere.
        redirect: 'manual',
        signal,
      })
      status = response.status
      answer = await readJson(response)
    } catch {
      if (caller?.aborted) throw caller.reason
      // The exchange's own error names the address it failed to reach: it is dropped here.
      throw failure(operation, timeout.aborted ? 'timeout' : 'unreachable')
    }

    if (status >= 200 && status < 300) {
      const parsed = schema.safeParse(answer)
      if (!parsed.success) throw failure(operation, 'body', status)
      return parsed.data
    }
    throw refusal(operation, status, answer)
  }

  return {
    async ensure(request, callOptions) {
      const body = checked('ensure', browserEnsureRequestSchema, request)
      const state = await call(
        'ensure',
        browserEnsureResponseSchema,
        browserWorkerPaths.ensure,
        body,
        callOptions,
      )
      // The state of another session would bind the task to a browser that is not its own.
      if (state.session !== body.sessionId) throw failure('ensure', 'body')
      return state
    },

    async close(sessionId, request, callOptions) {
      const id = checked('close', sessionIdSchema, sessionId)
      const body = checked('close', browserCloseRequestSchema, request)
      const closed = await call(
        'close',
        browserCloseResponseSchema,
        browserWorkerPaths.close(id),
        body,
        callOptions,
      )
      if (closed.sessionId !== id) throw failure('close', 'body')
      return closed
    },

    async verify(sessionId, callOptions) {
      const id = checked('verify', sessionIdSchema, sessionId)
      return call(
        'verify',
        browserVerifyResponseSchema,
        browserWorkerPaths.verify(id),
        {},
        callOptions,
      )
    },

    async list(callOptions) {
      return call(
        'list',
        browserListResponseSchema,
        browserWorkerPaths.list,
        undefined,
        callOptions,
      )
    },

    async action(sessionId, request, callOptions) {
      const id = checked('action', sessionIdSchema, sessionId)
      const body = checked('action', browserActionRequestSchema, request)
      const answer = await call(
        'action',
        browserActionResponseSchema,
        browserWorkerPaths.actions(id),
        body,
        callOptions,
      )
      if (!answer.ok) throw codeError(answer.code, { operation: 'action', failure: 'refused' })
      // A result of another tool is not an answer to this action.
      if (answer.result.tool !== body.action.tool) throw failure('action', 'body')
      return answer.result
    },
  }
}

function timeoutsOf(given: Partial<BrowserWorkerTimeouts>): BrowserWorkerTimeouts {
  const timeouts = { ...browserWorkerTimeoutDefaults, ...given }
  for (const [name, ms] of Object.entries(timeouts) as [keyof BrowserWorkerTimeouts, number][])
    if (!Number.isInteger(ms) || ms < 1 || ms > timeoutMax[name])
      throw new Error(`The browser worker timeout ${name} must be 1 to ${timeoutMax[name]} ms`)
  return timeouts
}

/** A request that breaks the contract is the caller's bug: it never leaves this process. */
function checked<S extends z.ZodType>(
  operation: BrowserWorkerOperation,
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  // Paths only: a value (an address, a typed text) stays out of the error.
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))]
  throw badRequest(`Invalid browser worker request: ${operation}`, { fields })
}

/** The answer as JSON, read up to its limit; `UNREADABLE` for anything else. */
async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > BROWSER_WORKER_RESPONSE_MAX_BYTES || !response.body) {
    await response.body?.cancel()
    return UNREADABLE
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > BROWSER_WORKER_RESPONSE_MAX_BYTES) {
      await reader.cancel()
      return UNREADABLE
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    return UNREADABLE
  }
}

/**
 * An HTTP error. The worker's own code passes for a 4xx, and for a 5xx only when it is one of the
 * fixed codes of the tools (a page that timed out, an action that failed): any other 5xx, and an
 * error without a code (a proxy, a crash, a wrong token), is the worker being unavailable.
 */
function refusal(operation: BrowserWorkerOperation, status: number, answer: unknown): DomainError {
  const parsed = browserWorkerErrorSchema.safeParse(answer)
  if (parsed.success && status >= 400) {
    const { code } = parsed.data
    if (isTaskCode(code)) return codeError(code, { operation, failure: 'refused', status })
    if (status < 500)
      return new DomainError(code, 'The browser worker refused the request', status, {
        operation,
        failure: 'refused',
        status,
      } satisfies BrowserWorkerFailure)
  }
  return failure(operation, 'status', status)
}

/**
 * No usable answer. A timed-out action or check may still have happened in the page, so it is
 * the page that did not answer in time (`BROWSER_TIMEOUT`): the agent looks again. Anything else
 * leaves the browser unavailable.
 */
function failure(
  operation: BrowserWorkerOperation,
  kind: Exclude<BrowserWorkerFailure['failure'], 'refused'>,
  status?: number,
): DomainError {
  const pageTimedOut = kind === 'timeout' && (operation === 'action' || operation === 'verify')
  return codeError(pageTimedOut ? 'BROWSER_TIMEOUT' : 'BROWSER_SESSION_UNAVAILABLE', {
    operation,
    failure: kind,
    ...(status === undefined ? {} : { status }),
  })
}

/** One of the fixed codes of §3.7, with its fixed text for the agent. */
function codeError(code: BrowserTaskCode, details: BrowserWorkerFailure): DomainError {
  const { message, status } = browserTaskCodes[code]
  return new DomainError(code, message, status, details)
}
