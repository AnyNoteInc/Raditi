import { setTimeout as pause } from 'node:timers/promises'

import type { BrowserWorkerClient } from '@repo/browser-link'
import {
  BROWSER_TOOL_RESPONSE_MAX_BYTES,
  browserSessionLimits,
  browserSessionTimings,
  browserTaskCodeNames,
  browserTaskCodes,
  clipTree,
  DomainError,
  isDomainError,
  leaseScopeOf,
  redactResultAddresses,
  type BrowserAction,
  type BrowserToolArguments,
  type BrowserToolName,
  type BrowserToolResult,
} from '@repo/domain'
import { TURN_KEY_IN_TEXT } from '@repo/turn-keys'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import type { ContentPrivacy } from '../privacy/content-privacy.ts'
import type { McpWebAdmission, McpWebStore } from './mcp-web-store.ts'

/**
 * The `web` tools of a browser task (docs/plan/57-browser-tasks.md, Б20, §3.7): the agent works in
 * the task's cloud browser on the site itself, one action at a time, through the browser worker.
 * Every call is admitted again for its turn; the first one opens the task's browser session and
 * waits for it (docs/plan/61-chats-first.md, К11), or answers `BROWSER_STARTING` when the start takes
 * longer than the call may wait. One call per turn runs at a time. The agent never gets Playwright, CDP, cookies or pixels — the worker's
 * answer is text, its addresses without their secret parameters and fragments, its contacts hidden
 * by the task's contact map, at most 64 KiB; a refusal is a fixed code with a fixed text that names
 * no address and no value of a field.
 */

/** Codes a `web` call answers with: those of §3.7, and the full contact map of the task. */
export const webAgentCodes = [...browserTaskCodeNames, 'CONTENT_PRIVACY_LIMIT'] as const
export type WebAgentCode = (typeof webAgentCodes)[number]

const webAgentTexts: Readonly<Record<WebAgentCode, Readonly<{ status: number; message: string }>>> =
  Object.freeze({
    ...browserTaskCodes,
    CONTENT_PRIVACY_LIMIT: {
      status: 413,
      message:
        'This page shows more contacts than the task can hide. Do not read it again; end the turn and tell the client.',
    },
  })

const webCodes: ReadonlySet<string> = new Set(webAgentCodes)
export const isWebAgentCode = (code: string): code is WebAgentCode => webCodes.has(code)

/** The error a refused call raises: its fixed code and text, nothing of the call. */
export const webRefusal = (code: WebAgentCode): DomainError =>
  new DomainError(code, webAgentTexts[code].message, webAgentTexts[code].status)

/** What a tool answers the agent: the worker's result, without secrets of addresses, bounded. */
export type WebToolResponse = Record<string, unknown>

export interface McpWebDeps {
  store: McpWebStore
  /** The worker's client (`@repo/browser-link`): one action per call, no retry. */
  worker: Pick<BrowserWorkerClient, 'action'>
  /** Only gives back contact markers of turns before 09.11.2026: pages are not masked any more. */
  privacy: Pick<ContentPrivacy, 'rehydrate'>
}

export interface McpWebOptions {
  /** All of one call; OpenCode gives an MCP request 60 s. */
  callBudgetMs?: number
  /** A call waits for a starting browser only while this much of it is left for the action. */
  startingActionMs?: number
  /** How often a call looks at a starting browser. */
  pollMs?: number
  /** An answer to the agent is at most this large, as JSON in UTF-8. */
  responseBytes?: number
  now?: () => number
  /** The pause between two looks at a starting browser. */
  sleep?: (ms: number) => Promise<void>
}

const defaults: {
  callBudgetMs: number
  startingActionMs: number
  pollMs: number
  responseBytes: number
  sleep: (ms: number) => Promise<void>
} = {
  callBudgetMs: browserSessionTimings.toolCallBudgetMs,
  startingActionMs: browserSessionTimings.startingActionMs,
  pollMs: 250,
  responseBytes: BROWSER_TOOL_RESPONSE_MAX_BYTES,
  sleep: (ms) => pause(ms),
}

/** Less than this of the turn left: the turn is ending, the action would not finish in it. */
const MIN_ACTION_MS = 1_000

/**
 * What the agent sends that reaches the site, by tool: a contact marker of an earlier turn, when
 * the platform still masked pages (until 09.11.2026), becomes the contact again.
 */
const SENT_TEXT: Partial<Record<BrowserToolName, readonly string[]>> = {
  web_open: ['url'],
  web_fill: ['text'],
  web_type: ['text'],
  web_dialog: ['text'],
}

export class McpWebService {
  readonly #deps: McpWebDeps
  readonly #options: typeof defaults & Pick<McpWebOptions, 'now'>
  /** One call at a time per turn: one browser, one sequence of actions. */
  readonly #locks = new Map<string, Promise<unknown>>()

  constructor(deps: McpWebDeps, options: McpWebOptions = {}) {
    this.#deps = deps
    this.#options = { ...defaults, ...options }
  }

  #now() {
    return this.#options.now?.() ?? Date.now()
  }

  /**
   * One action of the agent: `args` were checked against the tool's schema by the guard and by
   * mcp-nest. Raises only `webRefusal` codes.
   */
  async call<T extends BrowserToolName>(
    scope: McpTurnAccess,
    tool: T,
    args: BrowserToolArguments<T>,
  ): Promise<WebToolResponse> {
    const started = this.#now()
    // The agent can read its own turn credentials in the sandbox: no page of the site, no dialog
    // and no request to the client is where they go.
    if (strings(args).some((text) => TURN_KEY_IN_TEXT.test(text)))
      throw webRefusal('BROWSER_ACTION_DENIED')
    const first = await this.#admit(scope)
    return this.#serial(first.assignmentId, async (waited) => {
      // A call that waited for another one is admitted again: the turn may have ended meanwhile.
      let admission = waited ? await this.#again(scope, first) : first
      let ends = this.#endOf(admission, started)
      if (admission.session.status === 'starting') {
        await this.#untilReady(admission, ends)
        // So is one that waited for its browser, and it may be left less of the turn.
        admission = await this.#again(scope, first)
        // The browser it waited for is gone already and another one starts.
        if (admission.session.status !== 'ready') throw webRefusal('BROWSER_STARTING')
        ends = this.#endOf(admission, started)
      }
      const left = ends - this.#now()
      if (left < MIN_ACTION_MS) throw webRefusal('BROWSER_TIMEOUT')
      const action = await this.#action(scope, tool, args)
      const result = await this.#act(admission, scope, action, left)
      // What the page shows goes to the agent as it is: the data of the site and of the pages the
      // client signed in to is the client's own (the owner's decision of 09.11.2026, spec §20,
      // «Данные сайта клиента»). Only the secret parameters of addresses go.
      return this.#bounded(redactResultAddresses(result) as unknown as WebToolResponse)
    })
  }

  // -------------------------------------------------------------------------------------------
  // Admission and order
  // -------------------------------------------------------------------------------------------

  async #admit(scope: McpTurnAccess): Promise<McpWebAdmission> {
    try {
      return await this.#deps.store.admit(scope)
    } catch (error) {
      if (isDomainError(error) && error.code === 'BROWSER_WORKSPACE_BUSY')
        throw webRefusal('BROWSER_WORKSPACE_BUSY')
      throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
    }
  }

  /** The admission of a call once more: nothing that happened meanwhile moved it to another turn. */
  async #again(scope: McpTurnAccess, first: McpWebAdmission): Promise<McpWebAdmission> {
    const admission = await this.#admit(scope)
    if (admission.assignmentId !== first.assignmentId)
      throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
    return admission
  }

  /** When the call must be over: its own budget, or the turn. */
  #endOf(admission: McpWebAdmission, started: number): number {
    // Both on the database's clock: the time left of the turn is no comparison of two clocks.
    const turnLeft = admission.deadlineAt.getTime() - admission.now.getTime()
    if (turnLeft < MIN_ACTION_MS) throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
    return Math.min(started + this.#options.callBudgetMs, this.#now() + turnLeft)
  }

  /**
   * Waits for the browser of the first call while enough of the call is left for its action. A
   * longer start is no failure: the call answers `BROWSER_STARTING`, the agent calls again and the
   * start goes on. A session that closed will not come up.
   */
  async #untilReady(admission: McpWebAdmission, ends: number): Promise<void> {
    const { startingActionMs, pollMs, sleep } = this.#options
    for (;;) {
      const status = await this.#deps.store.sessionState(admission.session.id).catch(() => null)
      if (status === 'ready') return
      if (status !== 'starting') throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
      if (ends - this.#now() < startingActionMs) throw webRefusal('BROWSER_STARTING')
      await sleep(pollMs)
    }
  }

  async #serial<T>(key: string, work: (waited: boolean) => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key)
    const run = () => work(previous !== undefined)
    const current = (previous ?? Promise.resolve()).then(run, run)
    const settled = current.catch(() => undefined)
    this.#locks.set(key, settled)
    try {
      return await current
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key)
    }
  }

  // -------------------------------------------------------------------------------------------
  // What the agent sends
  // -------------------------------------------------------------------------------------------

  /**
   * The action as the worker takes it: files only of the task's messages, contact markers of the
   * task typed as the contacts they hide, and a path of the site (as the stack's guide names its
   * pages) opened on the site's own address.
   */
  async #action<T extends BrowserToolName>(
    scope: McpTurnAccess,
    tool: T,
    args: BrowserToolArguments<T>,
  ): Promise<BrowserAction> {
    const action = { ...args, tool } as Record<string, unknown>
    if (tool === 'web_upload') {
      const ids = (args as BrowserToolArguments<'web_upload'>).attachmentIds
      let known: boolean
      try {
        known = await this.#deps.store.attachmentsOfTask(scope.taskId, ids)
      } catch {
        throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
      }
      if (!known) throw webRefusal('BROWSER_ATTACHMENT_UNKNOWN')
    }
    const sent = Object.fromEntries(
      (SENT_TEXT[tool] ?? []).flatMap((field) =>
        typeof action[field] === 'string' ? [[field, action[field]]] : [],
      ),
    ) as Record<string, string>
    if (Object.keys(sent).length > 0) Object.assign(action, await this.#rehydrate(scope, sent))
    if (tool === 'web_open') action.url = siteAddress(scope, action.url as string)
    return action as BrowserAction
  }

  async #rehydrate(scope: McpTurnAccess, fields: Record<string, string>) {
    try {
      return await this.#deps.privacy.rehydrate(maskScopeOf(scope), fields)
    } catch (error) {
      // The map cannot be read now; or a marker unknown to the task, or a contact the page would
      // show unmasked where the agent put it.
      if (isDomainError(error) && error.code === 'CONTENT_PRIVACY_UNAVAILABLE')
        throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
      throw webRefusal('BROWSER_ACTION_FAILED')
    }
  }

  // -------------------------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------------------------

  async #act(
    admission: McpWebAdmission,
    scope: McpTurnAccess,
    action: BrowserAction,
    budgetMs: number,
  ): Promise<BrowserToolResult> {
    try {
      return await this.#deps.worker.action(
        admission.session.id,
        { taskId: scope.taskId, assignmentId: admission.assignmentId, action },
        { signal: AbortSignal.timeout(budgetMs) },
      )
    } catch (error) {
      if (isDomainError(error)) {
        // The worker's own fixed codes pass with their own text; any other refusal of it (a bad
        // request, a wrong token) leaves the browser out of reach for this turn.
        if ((browserTaskCodeNames as readonly string[]).includes(error.code))
          throw webRefusal(error.code as WebAgentCode)
        throw webRefusal('BROWSER_SESSION_UNAVAILABLE')
      }
      // The budget of the call ran out (the client rejects with the signal's own reason): the
      // action may still have happened in the page, so the agent looks again.
      throw webRefusal('BROWSER_TIMEOUT')
    }
  }

  // -------------------------------------------------------------------------------------------
  // What the agent gets back
  // -------------------------------------------------------------------------------------------

  /**
   * The answer within its bound (§3.7): the tree of an observation is cut at a line end, the
   * objects of a check are the first that fit; the answer says it was cut. A marker of a contact
   * is never split: lines hold whole markers, and a single line is cut by `clipTree`.
   */
  #bounded(answer: WebToolResponse): WebToolResponse {
    const limit = this.#options.responseBytes
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
    if (size(answer) <= limit) return answer
    const result: WebToolResponse = { ...answer, truncated: true }
    if (typeof result.tree === 'string') {
      let tree = result.tree
      while (tree.length > 0 && size({ ...result, tree }) > limit) {
        const cut = clipTree(tree, Math.floor(tree.length * 0.8)).text
        tree = cut.length < tree.length ? cut : ''
      }
      result.tree = tree
    }
    if (Array.isArray(result.objects)) {
      let objects = result.objects
      while (objects.length > 0 && size({ ...result, objects }) > limit)
        objects = objects.slice(0, objects.length - 1)
      result.objects = objects
    }
    if (size(result) <= limit) return result
    throw webRefusal('BROWSER_ACTION_FAILED')
  }
}

/** Where the contact map of the task lives: a chat without a site keeps it under its own id. */
function maskScopeOf(scope: McpTurnAccess): { siteId: string; taskId: string } {
  return { siteId: leaseScopeOf({ id: scope.taskId, siteId: scope.siteId }), taskId: scope.taskId }
}

/** Every string an argument holds, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/**
 * A path the agent gives (`/news/`) as an address of the site; a full address as it is — where a
 * page may go is the worker's to decide, with the hosts of the site. A path that resolves off the
 * site's origin (`//host`, `/\host`) is no path of it, and without a site no path is one.
 */
function siteAddress(scope: McpTurnAccess, url: string): string {
  if (!url.startsWith('/')) return url
  if (scope.url === null) throw webRefusal('BROWSER_ADDRESS_DENIED')
  const site = new URL(scope.url)
  const resolved = URL.parse(url, site)
  if (
    resolved === null ||
    resolved.origin !== site.origin ||
    resolved.href.length > browserSessionLimits.urlChars
  )
    throw webRefusal('BROWSER_ADDRESS_DENIED')
  return resolved.href
}
