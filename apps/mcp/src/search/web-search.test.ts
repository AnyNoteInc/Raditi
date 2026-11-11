import { describe, expect, it, vi } from 'vitest'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import type { McpWebSearchConfig } from '../config/config.ts'
import type { WebSearchOutcome } from './yandex-search.ts'
import { McpWebSearchService } from './web-search.ts'
import type { WebSearchReservation, WebSearchStore } from './web-search-store.ts'

const scope = {
  keyId: '01960000-0000-7000-8000-000000000001',
  taskId: '01960000-0000-7000-8000-000000000002',
  workspaceId: '01960000-0000-7000-8000-000000000003',
  siteId: null,
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 1,
  stack: null,
  url: null,
  preview: null,
  requirements: { repository: false, browser: false },
} satisfies McpTurnAccess
const apiKey = 'synthetic-yandex-key-0123456789'
const credentials = { apiKey, folderId: 'b1gsynthetic000folder' }
const config: McpWebSearchConfig = { timeoutMs: 1000, limits: { turn: 3, serviceMonth: 5000 } }
const query = 'secret-looking query words'

function service(
  reservation: WebSearchReservation,
  outcome?: WebSearchOutcome,
  key: typeof credentials | null = credentials,
  turn = true,
) {
  const store: WebSearchStore = {
    reserve: vi.fn(async () => reservation),
    finish: vi.fn(async () => undefined),
  }
  const search = vi.fn(async () => outcome ?? { status: 'ok' as const, results: [] })
  const log = vi.fn<(line: string) => void>()
  let clock = 0
  const now = () => (clock += 120)
  const web = new McpWebSearchService({
    store,
    config,
    key: { read: async () => key },
    search,
    pacer: { wait: async () => turn },
    log,
    now,
  })
  return { store, search, log, web }
}

const usage = { turn: 1, workspaceMonth: 10, serviceMonth: 100 }

describe('McpWebSearchService', () => {
  it('refuses, uncounted, while there is no key in Vault', async () => {
    const { web, search, store, log } = service(
      { reserved: true, id: 'call-1', usage },
      undefined,
      null,
    )
    await expect(web.search(scope, query)).resolves.toMatchObject({
      ok: false,
      code: 'SEARCH_UNAVAILABLE',
    })
    expect(store.reserve).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('web_search status=refused reason=no_key')
  })

  it.each([
    ['turn_limit', 'SEARCH_TURN_LIMIT'],
    ['service_limit', 'SEARCH_SERVICE_LIMIT'],
    ['no_credits', 'SEARCH_NO_CREDITS'],
    ['unavailable', 'SEARCH_UNAVAILABLE'],
  ] as const)('refuses before the request leaves when the store says %s', async (refusal, code) => {
    const { web, search, store, log } = service({ reserved: false, refusal, usage })
    const answer = await web.search(scope, query)
    expect(answer).toMatchObject({ ok: false, code })
    expect(search).not.toHaveBeenCalled()
    expect(store.finish).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`status=refused reason=${refusal}`))
  })

  it('passes the limits to the store and the key of Vault to the request, and records how the call ended', async () => {
    const results = [{ title: 'T', url: 'https://developer.wordpress.org/', excerpts: ['e'] }]
    const { web, search, store, log } = service(
      { reserved: true, id: 'call-1', usage },
      { status: 'ok', results },
    )
    await expect(web.search(scope, query)).resolves.toEqual({ ok: true, results })
    expect(store.reserve).toHaveBeenCalledWith(scope, config.limits)
    expect(search).toHaveBeenCalledWith(query, { credentials, timeoutMs: 1000 })
    expect(store.finish).toHaveBeenCalledWith('call-1', 'ok', 120)
    expect(log).toHaveBeenCalledWith(
      'web_search status=ok latency_ms=120 results=1 turn_calls=2 workspace_month=11 service_month=101',
    )
  })

  it.each([
    ['timeout', 'SEARCH_TIMEOUT'],
    ['rate_limited', 'SEARCH_RATE_LIMITED'],
    ['quota_exhausted', 'SEARCH_QUOTA_EXHAUSTED'],
    ['failed', 'SEARCH_FAILED'],
  ] as const)('tells the agent %s as a fixed code it can go on from', async (status, code) => {
    const { web, store } = service(
      { reserved: true, id: 'call-1', usage },
      { status, httpStatus: 429 },
    )
    const answer = await web.search(scope, query)
    expect(answer).toMatchObject({ ok: false, code })
    expect(answer.ok || answer.message).toMatch(/without/)
    expect(store.finish).toHaveBeenCalledWith('call-1', status, 120)
  })

  it('refuses as busy, without a request, a call that gets no turn of the quota in time', async () => {
    const { web, search, store } = service(
      { reserved: true, id: 'call-1', usage },
      undefined,
      credentials,
      false,
    )
    await expect(web.search(scope, query)).resolves.toMatchObject({
      ok: false,
      code: 'SEARCH_RATE_LIMITED',
    })
    expect(search).not.toHaveBeenCalled()
    expect(store.finish).toHaveBeenCalledWith('call-1', 'rate_limited', 120)
  })

  it('logs neither the phrase, nor the results, nor the key', async () => {
    const { web, log } = service(
      { reserved: true, id: 'call-1', usage },
      {
        status: 'ok',
        results: [{ title: 'Secret title', url: 'https://x.example/', excerpts: ['body'] }],
      },
    )
    await web.search(scope, query)
    const lines = log.mock.calls.map(([line]) => line).join('\n')
    for (const word of [query, 'Secret title', 'x.example', 'body', apiKey])
      expect(lines).not.toContain(word)
  })
})
