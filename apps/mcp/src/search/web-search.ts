import { Logger } from '@nestjs/common'
import { errorMessage } from '@repo/observability'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import type { McpWebSearchConfig } from '../config/config.ts'
import {
  parallelSearch,
  type ParallelSearchOptions,
  type WebSearchOutcome,
  type WebSearchResult,
} from './parallel-search.ts'
import type { WebSearchKey } from '../access/web-search-key.ts'
import type { WebSearchRefusal, WebSearchStore } from './web-search-store.ts'

/** What the agent is told when a search gives nothing: a fixed code and what to do instead. */
export const webSearchRefusals = {
  SEARCH_TURN_LIMIT:
    'The searches of this turn are used up. Go on without a search: open a known address with webfetch or answer from what you have.',
  SEARCH_NO_CREDITS:
    'The client has no credits for this turn, so there is no search. Go on without it.',
  SEARCH_SERVICE_LIMIT:
    'The search of the platform is used up this month. Go on without a search: open a known address with webfetch or answer from what you have.',
  SEARCH_TIMEOUT:
    'The search did not answer in time. You may try once more with a shorter phrase, or go on without it.',
  SEARCH_RATE_LIMITED:
    'The search service is busy now. Go on without a search, or try again later in this turn.',
  SEARCH_QUOTA_EXHAUSTED:
    'The search service has no quota left. Go on without a search: open a known address with webfetch or answer from what you have.',
  SEARCH_FAILED: 'The search failed. Go on without it.',
  SEARCH_UNAVAILABLE: 'The search is not available for this turn now. Go on without it.',
} as const
export type WebSearchRefusalCode = keyof typeof webSearchRefusals

const refusalCodes: Record<WebSearchRefusal, WebSearchRefusalCode> = {
  turn_limit: 'SEARCH_TURN_LIMIT',
  no_credits: 'SEARCH_NO_CREDITS',
  service_limit: 'SEARCH_SERVICE_LIMIT',
  unavailable: 'SEARCH_UNAVAILABLE',
}
const outcomeCodes: Record<Exclude<WebSearchOutcome['status'], 'ok'>, WebSearchRefusalCode> = {
  timeout: 'SEARCH_TIMEOUT',
  rate_limited: 'SEARCH_RATE_LIMITED',
  quota_exhausted: 'SEARCH_QUOTA_EXHAUSTED',
  failed: 'SEARCH_FAILED',
}

export type WebSearchAnswer =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; code: WebSearchRefusalCode; message: string }

export interface McpWebSearchDeps {
  store: WebSearchStore
  config: McpWebSearchConfig
  /** The key in Vault; none — the call is refused before it is counted. */
  key: Pick<WebSearchKey, 'read'>
  /** The request to the service; a test passes its own. */
  search?: (query: string, options: ParallelSearchOptions) => Promise<WebSearchOutcome>
  now?: () => number
  log?: (line: string) => void
}

/**
 * `raditi_search_web`: the key is read from Vault, the limits are taken before the request leaves
 * (`WebSearchStore.reserve`), then one request to Parallel Search. The log line of a call names its status, how long it took
 * and the counts, never the phrase, the results or the key.
 */
export class McpWebSearchService {
  readonly #logger = new Logger('McpWebSearch')
  readonly #search: NonNullable<McpWebSearchDeps['search']>
  readonly #now: () => number
  readonly #log: (line: string) => void

  constructor(private readonly deps: McpWebSearchDeps) {
    this.#search = deps.search ?? parallelSearch
    this.#now = deps.now ?? (() => performance.now())
    this.#log = deps.log ?? ((line) => this.#logger.log(line))
  }

  async search(scope: McpTurnAccess, query: string): Promise<WebSearchAnswer> {
    const { config, store } = this.deps
    const apiKey = await this.deps.key.read()
    if (apiKey === null) {
      this.#log('web_search status=refused reason=no_key')
      return refusal('SEARCH_UNAVAILABLE')
    }
    const reservation = await store.reserve(scope, config.limits)
    if (!reservation.reserved) {
      const code = refusalCodes[reservation.refusal]
      this.#log(
        `web_search status=refused reason=${reservation.refusal}${counts(reservation.usage)}`,
      )
      return refusal(code)
    }
    const started = this.#now()
    const outcome = await this.#search(query, {
      apiKey,
      timeoutMs: config.timeoutMs,
    })
    const latencyMs = Math.round(this.#now() - started)
    try {
      await store.finish(reservation.id, outcome.status, latencyMs)
    } catch (error) {
      this.#logger.warn(`web_search finish was not recorded: ${errorMessage(error)}`)
    }
    const used = { ...reservation.usage, turn: reservation.usage.turn + 1 }
    const http = outcome.status !== 'ok' && outcome.httpStatus ? ` http=${outcome.httpStatus}` : ''
    const results = outcome.status === 'ok' ? ` results=${outcome.results.length}` : ''
    this.#log(
      `web_search status=${outcome.status}${http} latency_ms=${latencyMs}${results}${counts({
        turn: used.turn,
        workspaceMonth: used.workspaceMonth + 1,
        serviceMonth: used.serviceMonth + 1,
      })}`,
    )
    return outcome.status === 'ok'
      ? { ok: true, results: outcome.results }
      : refusal(outcomeCodes[outcome.status])
  }
}

const refusal = (code: WebSearchRefusalCode): WebSearchAnswer => ({
  ok: false,
  code,
  message: webSearchRefusals[code],
})

const counts = (usage?: { turn: number; workspaceMonth: number; serviceMonth: number }) =>
  usage
    ? ` turn_calls=${usage.turn} workspace_month=${usage.workspaceMonth} service_month=${usage.serviceMonth}`
    : ''
