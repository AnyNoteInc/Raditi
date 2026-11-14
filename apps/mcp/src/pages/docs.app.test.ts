import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DomainError, type FeedRow } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { McpDocsService, type McpDocsStore } from './docs-service.ts'
import { MCP_DOCS } from './pages.tokens.ts'

const token = `mcp_${'c'.repeat(64)}`
const scope = {
  keyId: '01960000-0000-7000-8000-000000000021',
  taskId: '01960000-0000-7000-8000-000000000022',
  workspaceId: '01960000-0000-7000-8000-000000000023',
  siteId: null,
  sessionId: 'synthetic',
  turn: 2,
  firstEpoch: 1,
  epoch: 1,
  stack: null,
  url: null,
  preview: null,
  requirements: { repository: false, browser: false },
}
const access: McpAccessStore = { authenticate: async (value) => (value === token ? scope : null) }
const docId = '01960000-0000-7000-8000-0000000000dd'

let app: INestApplication | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

function fakeStore(writesLeft = 100) {
  const rows: FeedRow[] = []
  let left = writesLeft
  const store = {
    create: vi.fn(async () => ({ id: docId, revision: 1 })),
    write: vi.fn(async () => ({ revision: 2 })),
    remove: vi.fn(async () => ({ revision: 3 })),
    move: vi.fn(async () => ({ revision: 4 })),
    read: vi.fn(async () => ({
      id: docId,
      title: 'Аудит',
      revision: 2,
      version: 0,
      sections: [
        {
          key: 'summary',
          heading: 'Итог',
          intent: 'Итог',
          state: 'written',
          markdown: 'Текст',
          checked: false,
          refusal: null,
        },
        {
          key: 'sources',
          heading: null,
          intent: 'Источники',
          state: 'pending',
          markdown: null,
          checked: false,
          refusal: 'client_value',
        },
      ],
    })),
    finish: vi.fn(async () => undefined),
    admitWrite: vi.fn(async () => left-- > 0),
    feed: vi.fn(async (_taskId: string, _turn: number, row: FeedRow) => {
      rows.push(row)
    }),
  } satisfies McpDocsStore
  return { store, rows }
}

async function start(store: McpDocsStore) {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(testMcpConfig())] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
    .overrideProvider(MCP_DOCS)
    .useValue(new McpDocsService({ store }))
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
const call = (name: string, args: unknown) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: args },
})
const answer = (res: { body: { result: { content: { text: string }[] } } }) =>
  JSON.parse(res.body.result.content[0]!.text) as Record<string, unknown>

describe('the documents of a workspace through the gateway (plan 69, Ст21, Ст22)', () => {
  it('are offered to every turn, without the domain of the pages', async () => {
    const server = await start(fakeStore().store)
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (list.body.result.tools as { name: string }[]).map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'doc_create',
        'doc_section_write',
        'doc_section_remove',
        'doc_section_move',
        'doc_read',
        'doc_finish',
      ]),
    )
    expect(names).not.toContain('page_publish')
  })

  it('declares strict inputs and honest hints, after the other families and before the pages', async () => {
    const server = await start(fakeStore().store)
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = list.body.result.tools as {
      name: string
      inputSchema: { type: string; additionalProperties?: boolean }
      annotations: Record<string, boolean>
    }[]
    const docs = tools.filter((tool) => tool.name.startsWith('doc_'))
    expect(docs.map((tool) => tool.name)).toEqual([
      'doc_create',
      'doc_section_write',
      'doc_section_remove',
      'doc_section_move',
      'doc_read',
      'doc_finish',
    ])
    for (const tool of docs) {
      expect(tool.inputSchema, tool.name).toMatchObject({
        type: 'object',
        additionalProperties: false,
      })
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: tool.name === 'doc_read',
        destructiveHint: tool.name === 'doc_section_remove',
        openWorldHint: false,
      })
    }
    // site_info first, the documents after it.
    expect(tools[0]?.name).toBe('site_info')
  })

  it('sets up the skeleton and tells the card of the chat', async () => {
    const { store, rows } = fakeStore()
    const server = await start(store)
    const res = await post(
      server,
      call('doc_create', {
        title: 'Аудит скорости',
        view: 'page',
        sections: [
          { id: 'summary', intent: 'Итог: три причины' },
          { id: 'sources', intent: 'Источники' },
        ],
      }),
    )
    expect(answer(res)).toMatchObject({ docId, sections: ['summary', 'sources'] })
    expect(store.create).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      title: 'Аудит скорости',
      view: 'page',
      sections: [
        { key: 'summary', intent: 'Итог: три причины' },
        { key: 'sources', intent: 'Источники' },
      ],
    })
    expect(rows).toEqual([{ type: 'feed.doc', payload: { v: 1, docId } }])
  })

  it('writes a section under the admitted turn and signals the card, never with its text', async () => {
    const { store, rows } = fakeStore()
    const server = await start(store)
    await post(
      server,
      call('doc_section_write', {
        docId,
        id: 'summary',
        heading: 'Итог',
        markdown: '### Почему\nТекст',
      }),
    )
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: scope.taskId, turnNo: 2, workspaceId: scope.workspaceId }),
    )
    expect(rows).toEqual([{ type: 'feed.doc_touch', payload: { v: 1, docId, revision: 2 } }])
    expect(JSON.stringify(rows)).not.toContain('Текст')
  })

  it('refuses a key of a turn in a section, a second-level heading, and writes over the limit of a turn', async () => {
    const { store } = fakeStore(1)
    const server = await start(store)
    const key = await post(
      server,
      call('doc_section_write', {
        docId,
        id: 'a',
        heading: 'А',
        markdown: `sk-rdt-${'x'.repeat(43)}`,
      }),
    )
    expect(key.body.result.isError).toBe(true)
    expect(answer(key)).toMatchObject({ code: 'PAGE_CONTENT_REFUSED' })
    expect(store.write).not.toHaveBeenCalled()
    expect(
      (
        await post(
          server,
          call('doc_section_write', { docId, id: 'a', heading: 'А', markdown: '## Раздел' }),
        )
      ).status,
    ).toBe(400)
    const over = await post(
      server,
      call('doc_section_write', { docId, id: 'a', heading: 'А', markdown: 'ok' }),
    )
    expect(answer(over)).toMatchObject({ code: 'DOC_LIMIT' })
  })

  it('reads the document with the reason a section was sent back, and finishes it at the end of the turn', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const read = answer(await post(server, call('doc_read', { docId })))
    expect(store.read).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      documentId: docId,
      taskId: scope.taskId,
    })
    expect(read).toMatchObject({ docId, title: 'Аудит', version: 0 })
    expect((read.sections as unknown[])[1]).toMatchObject({
      id: 'sources',
      state: 'pending',
      refused: 'client_value',
    })
    const finish = answer(await post(server, call('doc_finish', { docId })))
    expect(finish).toMatchObject({ finished: 'when this turn ends' })
    expect(store.finish).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      documentId: docId,
      taskId: scope.taskId,
      turnNo: 2,
    })
  })

  it('lets the agent choose the view, and change it with doc_finish (plan 74, Д1)', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const noView = await post(
      server,
      call('doc_create', { title: 'Без вида', sections: [{ id: 'a', intent: 'Раздел' }] }),
    )
    expect(store.create).not.toHaveBeenCalled()
    expect(noView.body.error ?? noView.body.result?.isError).toBeTruthy()
    await post(server, call('doc_finish', { docId, view: 'text' }))
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({ view: 'text' }))
  })

  it('tells a document of another workspace as not found', async () => {
    const { store } = fakeStore()
    store.read.mockRejectedValueOnce(
      new DomainError('DOC_NOT_FOUND', 'No such document in this workspace', 404),
    )
    const server = await start(store)
    const res = await post(server, call('doc_read', { docId }))
    expect(res.body.result.isError).toBe(true)
    expect(answer(res)).toMatchObject({ code: 'DOC_NOT_FOUND' })
  })
})
