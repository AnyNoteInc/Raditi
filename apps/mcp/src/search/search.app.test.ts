import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import type { McpConfig } from '../config/config.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, notDocTool, testMcpConfig } from '../testing/fakes.ts'
import { MCP_WEB_SEARCH } from './search.tokens.ts'
import { McpWebSearchService } from './web-search.ts'
import type { WebSearchStore } from './web-search-store.ts'

const token = `mcp_${'a'.repeat(64)}`
const apiKey = 'synthetic-yandex-key-0123456789'
const folderId = 'b1gsynthetic000folder'
const scope = {
  keyId: '01960000-0000-7000-8000-000000000001',
  taskId: '01960000-0000-7000-8000-000000000002',
  workspaceId: '01960000-0000-7000-8000-000000000003',
  siteId: '01960000-0000-7000-8000-000000000004',
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 1,
  stack: 'wordpress' as const,
  url: 'https://site.example.test',
  preview: null,
}
const access: McpAccessStore = { authenticate: async (value) => (value === token ? scope : null) }

/** Vault of the role: the key of the search at its path when `key` is set, nothing else. */
function vaultWith(key: string | null) {
  const secrets = fakeInfra().secrets
  return {
    ...secrets,
    kvRead: vi.fn(async (path: string) =>
      path === 'subs/search/yandex' && key !== null
        ? { data: { key, folderId }, version: 1 }
        : null,
    ),
  }
}

let app: INestApplication | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
})

async function start(
  key: string | null,
  web?: McpWebSearchService,
  config: McpConfig = testMcpConfig(),
) {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(vaultWith(key))
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
  if (web) builder.overrideProvider(MCP_WEB_SEARCH).useValue(web)
  app = (await builder.compile()).createNestApplication({ logger: false })
  await mountMcp(app)
  await app.listen(0, '127.0.0.1')
  return app.getHttpServer()
}

const post = (server: unknown, body: object) =>
  request(server as Parameters<typeof request>[0])
    .post(MCP_ENDPOINT)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-protocol-version', '2025-06-18')
    .send(body)

const callSearch = (query: unknown) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'search_web', arguments: { query } },
})

function fakeService(outcomeStatus: 'ok' | 'quota_exhausted' = 'ok') {
  const store: WebSearchStore = {
    reserve: vi.fn(async () => ({
      reserved: true as const,
      id: 'call-1',
      usage: { turn: 0, workspaceMonth: 0, serviceMonth: 0 },
    })),
    finish: vi.fn(async () => undefined),
  }
  const search = vi.fn(async () =>
    outcomeStatus === 'ok'
      ? {
          status: 'ok' as const,
          results: [
            {
              title: 'register_post_type() – Function | Developer.WordPress.org',
              url: 'https://developer.wordpress.org/reference/functions/register_post_type/',
              excerpts: ['Registers a post type.'],
            },
          ],
        }
      : { status: 'quota_exhausted' as const, httpStatus: 402 },
  )
  const config = { timeoutMs: 1000, limits: { turn: 3, serviceMonth: 5000 } }
  const web = new McpWebSearchService({
    store,
    config,
    key: { read: async () => ({ apiKey, folderId }) },
    search,
    pacer: { wait: async () => true },
    log: () => {},
  })
  return { store, search, web }
}

describe('search_web through the gateway', () => {
  it('is not offered, and not callable, while its key is not in Vault', async () => {
    const server = await start(null)
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(
      list.body.result.tools.map((tool: { name: string }) => tool.name).filter(notDocTool),
    ).toEqual(['site_info'])
    const call = await post(server, callSearch('wordpress register_post_type'))
    expect(call.status).toBe(400)
  })

  it('is offered while its key is in Vault, as a read-only tool of the open world', async () => {
    const server = await start(apiKey, fakeService().web)
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = list.body.result.tools as {
      name: string
      inputSchema: unknown
      annotations: unknown
    }[]
    expect(tools.map((tool) => tool.name).filter(notDocTool)).toEqual(['site_info', 'search_web'])
    const search = tools.find((tool) => tool.name === 'search_web')!
    expect(search.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true })
    expect(search.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200 } },
      required: ['query'],
    })
    // The key reaches no answer of the role.
    expect(JSON.stringify(list.body)).not.toContain(apiKey)
  })

  it('answers with titles, addresses and excerpts, with the trimmed phrase', async () => {
    const { web, search } = fakeService()
    const server = await start(apiKey, web)
    const res = await post(server, callSearch('  WordPress register_post_type  '))
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBeFalsy()
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({
      results: [
        {
          excerpts: ['Registers a post type.'],
          title: 'register_post_type() – Function | Developer.WordPress.org',
          url: 'https://developer.wordpress.org/reference/functions/register_post_type/',
        },
      ],
    })
    expect(search).toHaveBeenCalledWith('WordPress register_post_type', expect.any(Object))
  })

  it('tells the agent an exhausted quota as a result it can go on from, not a protocol error', async () => {
    const server = await start(apiKey, fakeService('quota_exhausted').web)
    const res = await post(server, callSearch('wordpress register_post_type'))
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBe(true)
    expect(JSON.parse(res.body.result.content[0].text)).toMatchObject({
      code: 'SEARCH_QUOTA_EXHAUSTED',
    })
  })

  it.each([[''], ['x'], ['a'.repeat(201)], ['line\nbreak'], [42]])(
    'refuses a call whose phrase is not one short line (%j) before the tool',
    async (query) => {
      const { web, store } = fakeService()
      const server = await start(apiKey, web)
      const res = await post(server, callSearch(query))
      expect(res.status).toBe(400)
      expect(store.reserve).not.toHaveBeenCalled()
    },
  )

  it('refuses extra arguments of the call', async () => {
    const { web, store } = fakeService()
    const server = await start(apiKey, web)
    const res = await post(server, {
      ...callSearch('wordpress hooks'),
      params: { name: 'search_web', arguments: { query: 'wordpress hooks', mode: 'advanced' } },
    })
    expect(res.status).toBe(400)
    expect(store.reserve).not.toHaveBeenCalled()
  })
})
