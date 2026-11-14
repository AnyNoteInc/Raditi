import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DomainError, newPageSlug } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import type { McpConfig } from '../config/config.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { McpPagesService, type McpPagesStore } from './pages-service.ts'
import { MCP_PAGES } from './pages.tokens.ts'

const token = `mcp_${'b'.repeat(64)}`
// A chat without a project: the pages are the workspace's, with a site or without.
const scope = {
  keyId: '01960000-0000-7000-8000-000000000011',
  taskId: '01960000-0000-7000-8000-000000000012',
  workspaceId: '01960000-0000-7000-8000-000000000013',
  siteId: null,
  sessionId: 'synthetic',
  turn: 4,
  firstEpoch: 1,
  epoch: 1,
  stack: null,
  url: null,
  preview: null,
  requirements: { repository: false, browser: false },
}
const access: McpAccessStore = { authenticate: async (value) => (value === token ? scope : null) }
const slug = newPageSlug(() => new Uint8Array(16).fill(7))
const pageId = '01960000-0000-7000-8000-0000000000aa'
const address = { baseDomain: 'pages.localhost', scheme: 'http' as const, port: 8092 }

let app: INestApplication | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
})

function fakeStore(): McpPagesStore & { reserve: ReturnType<typeof vi.fn> } {
  return {
    reserve: vi.fn(async () => ({ pageId, slug, version: 2 })),
    documentTitle: vi.fn(async () => 'Аудит скорости'),
    list: vi.fn(async () => [
      {
        id: pageId,
        slug,
        title: 'Прайс',
        kind: 'html',
        state: 'live',
        currentVersion: 1,
        taskId: scope.taskId,
        hasPassword: true,
      },
    ]),
  }
}

async function start(config: McpConfig, store = fakeStore()) {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
  if (config.pages)
    builder.overrideProvider(MCP_PAGES).useValue(new McpPagesService({ store, address }))
  app = (await builder.compile()).createNestApplication({ logger: false })
  await mountMcp(app)
  await app.listen(0, '127.0.0.1')
  return { server: app.getHttpServer(), store }
}

const post = (server: unknown, body: object) =>
  request(server as Parameters<typeof request>[0])
    .post(MCP_ENDPOINT)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-protocol-version', '2025-06-18')
    .send(body)

const call = (name: string, args: unknown) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: args },
})
const names = async (server: unknown) =>
  (
    (await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools as {
      name: string
    }[]
  ).map((tool) => tool.name)

describe('the pages of a workspace through the gateway (plan 69, Ст20)', () => {
  it('are not offered where the pages are not configured', async () => {
    const { server } = await start(testMcpConfig())
    expect(await names(server)).not.toContain('page_publish')
    expect((await post(server, call('page_list', {}))).status).toBe(400)
  })

  it('are offered to a chat without a project, where the pages are configured', async () => {
    const { server } = await start({ ...testMcpConfig(), pages: address })
    expect(await names(server)).toEqual(expect.arrayContaining(['page_publish', 'page_list']))
  })

  it('reserves a page from a file of the outbox and gives its one address now', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    const res = await post(
      server,
      call('page_publish', { file: 'прайс.html', title: 'Прайс', pageId }),
    )
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBeFalsy()
    const answer = JSON.parse(res.body.result.content[0].text)
    expect(answer).toMatchObject({
      pageId,
      url: `http://${slug}.pages.localhost:8092/`,
      version: 2,
    })
    // Who publishes comes from the admitted turn, never from the arguments.
    expect(store.reserve).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      turnNo: 4,
      title: 'Прайс',
      target: { fileName: 'прайс.html' },
      pageId,
    })
  })

  it('takes the title of a document when the agent gives none', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    const docId = '01960000-0000-7000-8000-0000000000bb'
    await post(server, call('page_publish', { docId }))
    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Аудит скорости', target: { documentId: docId } }),
    )
  })

  it('refuses both a file and a document, a path, and an unknown key before the tool', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    for (const args of [
      { file: 'p.html', title: 'П', docId: pageId },
      { file: '../p.html', title: 'П' },
      { file: 'p.html' },
      { file: 'p.html', title: 'П', workspaceId: scope.workspaceId },
    ])
      expect((await post(server, call('page_publish', args))).status, JSON.stringify(args)).toBe(
        400,
      )
    expect(store.reserve).not.toHaveBeenCalled()
  })

  it('tells a limit as a result the agent can go on from', async () => {
    const store = fakeStore()
    store.reserve.mockRejectedValueOnce(
      new DomainError('PAGE_LIMIT', 'The limit publishesPerHour (30) is reached', 409),
    )
    const { server } = await start({ ...testMcpConfig(), pages: address }, store)
    const res = await post(server, call('page_publish', { file: 'p.html', title: 'П' }))
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBe(true)
    expect(JSON.parse(res.body.result.content[0].text)).toMatchObject({ code: 'PAGE_LIMIT' })
  })

  it('lists the pages of the workspace with their address and whether a password is set', async () => {
    const { server } = await start({ ...testMcpConfig(), pages: address })
    const res = await post(server, call('page_list', {}))
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({
      pages: [
        {
          chat: 'this',
          kind: 'html',
          pageId,
          password: true,
          state: 'live',
          title: 'Прайс',
          url: `http://${slug}.pages.localhost:8092/`,
          version: 1,
        },
      ],
    })
  })
})
