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

const listed = (extra: Record<string, unknown>) => ({
  id: pageId,
  slug,
  treeId: pageId,
  parentId: null,
  path: '/',
  position: 0,
  title: 'Прайс',
  kind: 'html',
  state: 'live',
  currentVersion: 1,
  hasPassword: true,
  deletedAt: null,
  updatedAt: new Date('2026-11-14T10:00:00Z'),
  ...extra,
})

const child = '01960000-0000-7000-8000-0000000000bb'

function fakeStore() {
  return {
    reserve: vi.fn(async () => ({ pageId, slug, path: '/', treeId: pageId, version: 2 })),
    documentTitle: vi.fn(async () => 'Аудит скорости'),
    list: vi.fn(async () => [
      listed({}),
      listed({ id: child, parentId: pageId, path: '/uslugi', title: 'Услуги', hasPassword: true }),
      listed({
        id: '01960000-0000-7000-8000-0000000000dd',
        treeId: '01960000-0000-7000-8000-0000000000de',
        title: 'В корзине',
        deletedAt: new Date('2026-11-14T10:00:00Z'),
      }),
    ]),
    read: vi.fn(async () => ({
      pageId,
      kind: 'markdown',
      version: 3,
      documentId: null,
      format: 'markdown' as const,
      text: '# Прайс\n\n' + 'а'.repeat(40_000),
    })),
    putFile: vi.fn(async (input: { path: string }) => ({
      reservationId: '01960000-0000-7000-8000-0000000000ef',
      slug,
      path: input.path,
    })),
    files: vi.fn(async () => [{ path: '/_files/style.css', type: 'text/css', sizeBytes: 3 }]),
    deleteFile: vi.fn(async (input: { path: string }) => ({
      reservationId: '01960000-0000-7000-8000-0000000000ef',
      slug,
      path: input.path,
    })),
    change: vi.fn(async (input: { change: { pageId: string } }) => ({
      reservationId: '01960000-0000-7000-8000-0000000000ee',
      pageId: input.change.pageId,
      pages: 1,
    })),
  } satisfies McpPagesStore
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

  it('lists the sites of the workspace by their home pages, those in the trash after them (plan 73)', async () => {
    const { server } = await start({ ...testMcpConfig(), pages: address })
    const res = await post(server, call('page_list', {}))
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({
      sites: [
        {
          homePageId: pageId,
          kind: 'html',
          pages: 2,
          password: true,
          state: 'live',
          title: 'Прайс',
          treeId: pageId,
          url: `http://${slug}.pages.localhost:8092/`,
          version: 1,
        },
        // A site in the trash: page_restore of its home page returns it whole.
        expect.objectContaining({
          deleted: true,
          homePageId: '01960000-0000-7000-8000-0000000000dd',
          pages: 1,
        }),
      ],
      total: 2,
    })
  })

  it('names the pages of a site with their paths, and those of it in the trash', async () => {
    const { server } = await start({ ...testMcpConfig(), pages: address })
    const res = await post(server, call('page_tree', { treeId: pageId }))
    const tree = JSON.parse(res.body.result.content[0].text)
    expect(tree.pages.map((page: { path: string; url: string }) => [page.path, page.url])).toEqual([
      ['/', `http://${slug}.pages.localhost:8092/`],
      ['/uslugi', `http://${slug}.pages.localhost:8092/uslugi`],
    ])
    const missing = await post(server, call('page_tree', { treeId: child }))
    expect(JSON.parse(missing.body.result.content[0].text)).toMatchObject({
      code: 'PAGE_NOT_FOUND',
    })
  })

  it('puts a file of the outbox as a shared file of a site, and names the files of a site (Дер34)', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    const res = await post(
      server,
      call('page_file_put', { treeId: pageId, file: 'style.css', path: '/_files/style.css' }),
    )
    expect(JSON.parse(res.body.result.content[0].text)).toMatchObject({
      url: `http://${slug}.pages.localhost:8092/_files/style.css`,
      live: 'when this turn ends',
    })
    expect(store.putFile).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      turnNo: 4,
      treeId: pageId,
      fileName: 'style.css',
      path: '/_files/style.css',
    })
    for (const path of ['/_files/index.html', '/style.css', '/_files/../x.css'])
      expect(
        (await post(server, call('page_file_put', { treeId: pageId, file: 'x.css', path }))).status,
        path,
      ).toBe(400)
    const tree = await post(server, call('page_tree', { treeId: pageId }))
    expect(JSON.parse(tree.body.result.content[0].text).files).toEqual([
      { path: '/_files/style.css', type: 'text/css', sizeBytes: 3 },
    ])
  })

  it('reads a page a piece at a time', async () => {
    const { server } = await start({ ...testMcpConfig(), pages: address })
    const res = await post(server, call('page_read', { pageId, limit: 100 }))
    const read = JSON.parse(res.body.result.content[0].text)
    expect(read).toMatchObject({ version: 3, format: 'markdown', truncated: true, nextOffset: 100 })
    expect([...read.text]).toHaveLength(100)
  })

  it('reserves the changes of a turn for its end, from the admitted turn (Дер23)', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    const edit = await post(
      server,
      call('page_edit', { pageId, expectedVersion: 3, edits: [{ old: 'Прайс', new: 'Цены' }] }),
    )
    expect(JSON.parse(edit.body.result.content[0].text)).toMatchObject({
      live: 'when this turn ends',
    })
    expect(store.change).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      turnNo: 4,
      change: { kind: 'edit', pageId, expectedVersion: 3, edits: [{ old: 'Прайс', new: 'Цены' }] },
    })
    await post(server, call('page_update', { pageId: child, expectedVersion: 1, segment: 'ceny' }))
    await post(
      server,
      call('page_delete', { pageIds: [child], withChildren: true, confirmedByClient: true }),
    )
    await post(server, call('page_restore', { pageIds: [child] }))
    expect(store.change.mock.calls.map((call) => call[0].change)).toEqual([
      expect.objectContaining({ kind: 'edit' }),
      { kind: 'update', pageId: child, expectedVersion: 1, segment: 'ceny' },
      { kind: 'delete', pageId: child, withChildren: true },
      { kind: 'restore', pageId: child },
    ])
  })

  it('deletes nothing the client did not confirm, nor more than 20 pages a call', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    for (const args of [
      { pageIds: [child] },
      { pageIds: [child], confirmedByClient: false },
      { pageIds: Array.from({ length: 21 }, () => child), confirmedByClient: true },
    ])
      expect((await post(server, call('page_delete', args))).status, JSON.stringify(args)).toBe(400)
    expect(store.change).not.toHaveBeenCalled()
  })

  it('tells a refusal of the store as a result the agent can go on from', async () => {
    const store = fakeStore()
    store.change.mockRejectedValueOnce(
      new DomainError('PAGE_FORBIDDEN', 'Only the owner or an administrator', 403),
    )
    const { server } = await start({ ...testMcpConfig(), pages: address }, store)
    const res = await post(server, call('page_restore', { pageIds: [child] }))
    expect(res.body.result.isError).toBe(true)
    expect(JSON.parse(res.body.result.content[0].text)).toMatchObject({ code: 'PAGE_FORBIDDEN' })
  })

  it('checks each old of page_edit against the page now, and reserves nothing on a miss', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    const missed = await post(
      server,
      call('page_edit', { pageId, expectedVersion: 3, edits: [{ old: 'Цены', new: 'Прайс' }] }),
    )
    expect(JSON.parse(missed.body.result.content[0].text)).toMatchObject({
      code: 'PAGE_EDIT_UNMATCHED',
    })
    const twice = await post(
      server,
      call('page_edit', { pageId, expectedVersion: 3, edits: [{ old: 'а', new: 'б' }] }),
    )
    expect(JSON.parse(twice.body.result.content[0].text).message).toMatch(/40001 times/)
    expect(store.change).not.toHaveBeenCalled()
  })

  it('deletes a page asked with a page above it once, with the page above it', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    await post(
      server,
      call('page_delete', {
        pageIds: [child, pageId],
        withChildren: true,
        confirmedByClient: true,
      }),
    )
    expect(store.change.mock.calls.map((call) => call[0].change)).toEqual([
      { kind: 'delete', pageId, withChildren: true },
    ])
  })

  it('names the shared files of a site with their addresses, and deletes one only when the client asked (Дер34)', async () => {
    const { server, store } = await start({ ...testMcpConfig(), pages: address })
    const listed = await post(server, call('page_files', { treeId: pageId }))
    expect(JSON.parse(listed.body.result.content[0].text)).toEqual({
      treeId: pageId,
      files: [
        {
          path: '/_files/style.css',
          type: 'text/css',
          sizeBytes: 3,
          url: `http://${slug}.pages.localhost:8092/_files/style.css`,
        },
      ],
    })
    // Without the client's word the role refuses the body itself.
    expect(
      (await post(server, call('page_file_delete', { treeId: pageId, path: '/_files/style.css' })))
        .status,
    ).toBe(400)
    const deleted = await post(
      server,
      call('page_file_delete', {
        treeId: pageId,
        path: '/_files/style.css',
        confirmedByClient: true,
      }),
    )
    expect(JSON.parse(deleted.body.result.content[0].text)).toMatchObject({
      path: '/_files/style.css',
      live: 'when this turn ends',
    })
    expect(store.deleteFile).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      turnNo: 4,
      treeId: pageId,
      path: '/_files/style.css',
    })
  })

  it('marks page_delete destructive and the readers read-only', async () => {
    const { server } = await start({ ...testMcpConfig(), pages: address })
    const tools = (await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result
      .tools as { name: string; annotations: Record<string, boolean> }[]
    const of = (name: string) => tools.find((tool) => tool.name === name)!.annotations
    expect(of('page_delete').destructiveHint).toBe(true)
    expect(of('page_file_delete').destructiveHint).toBe(true)
    for (const name of ['page_list', 'page_tree', 'page_read', 'page_files'])
      expect(of(name).readOnlyHint).toBe(true)
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'page_publish',
        'page_list',
        'page_tree',
        'page_read',
        'page_edit',
        'page_update',
        'page_delete',
        'page_restore',
        'page_file_put',
        'page_file_delete',
        'page_files',
      ]),
    )
  })
})
