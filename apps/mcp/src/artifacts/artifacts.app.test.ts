import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { type FeedRow } from '@repo/domain'
import { artifactStale } from '@repo/domain/artifacts'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore, type McpTurnAccess } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { MCP_WEB } from '../web/web.tokens.ts'
import {
  McpArtifactsService,
  type McpArtifactsStore,
  type McpChatArtifactAccess,
  type McpFrameRenderer,
} from './artifacts-service.ts'
import { MCP_ARTIFACTS } from './artifacts.tokens.ts'

// The family `artifacts` through the gateway (docs/plan/88-artifacts.md, Ар3, Ар21–Ар24, §7.5):
// what is listed and called, the synonyms of plan 69, the bounds of a chat and of a pass without
// its client, the news of every answer.

const token = `mcp_${'c'.repeat(64)}`
const base = {
  keyId: '01960000-0000-7000-8000-000000000021',
  taskId: '01960000-0000-7000-8000-000000000022',
  workspaceId: '01960000-0000-7000-8000-000000000023',
  sessionId: 'synthetic',
  turn: 2,
  firstEpoch: 1,
  epoch: 1,
  requirements: { repository: false, browser: false },
} satisfies McpTurnAccess
const artifactId = '01960000-0000-7000-8000-0000000000dd'
const threadId = '01960000-0000-7000-8000-0000000000ee'
const opId = '01960000-0000-7000-8000-0000000000ef'
const news = {
  seq: 7,
  changedSinceYourRead: { count: 1, blocks: ['b1'], more: false },
  refusedSinceYourRead: ['intro'],
}

let app: INestApplication | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

type S = McpArtifactsStore

function fakeStore(
  access: McpChatArtifactAccess | null = { role: 'owner', personal: true, linked: true },
) {
  const rows: FeedRow[] = []
  const store = {
    projectOf: vi.fn<S['projectOf']>(async () => null),
    access: vi.fn<S['access']>(async () => access),
    list: vi.fn<S['list']>(async () => ({
      rows: [
        {
          id: artifactId,
          kind: 'document',
          title: 'План',
          version: 1,
          updatedAt: new Date('2026-11-20T10:00:00Z'),
          place: 'chat' as const,
        },
      ],
      more: false,
    })),
    read: vi.fn<S['read']>(async () => ({
      id: artifactId,
      kind: 'document',
      title: 'План',
      seq: 7,
      version: 1,
      blocks: [
        {
          key: 'intro',
          kind: 'section',
          parent: null,
          rev: 3,
          content: 'Текст',
          props: { heading: 'Введение' },
          checking: false,
          hold: null,
          intent: 'Введение',
        },
        {
          key: 'sources',
          kind: 'section',
          parent: null,
          rev: 1,
          content: null,
          props: {} as Record<string, string>,
          checking: true,
          hold: 'checking',
          intent: 'Источники',
        },
      ],
    })),
    news: vi.fn<S['news']>(async () => news),
    changedSince: vi.fn<S['changedSince']>(async () => ['sources']),
    discard: vi.fn<S['discard']>(async () => undefined),
    create: vi.fn<S['create']>(async () => ({ id: artifactId, seq: 1 })),
    apply: vi.fn<S['apply']>(async () => ({
      artifactId,
      seq: 8,
      blocks: [],
      title: null,
      repeated: false,
    })),
    claim: vi.fn<S['claim']>(async () => ({ until: new Date('2026-11-20T10:02:00Z') })),
    saveVersion: vi.fn<S['saveVersion']>(async () => ({ no: 2 })),
    placeholders: vi.fn<S['placeholders']>(async () => 0),
    setView: vi.fn<S['setView']>(async () => undefined),
    lastRev: vi.fn<S['lastRev']>(async () => 2),
    revision: vi.fn<S['revision']>(async () => 5),
    reserveFile: vi.fn<S['reserveFile']>(async () => ({
      id: '01960000-0000-7000-8000-0000000000f1',
    })),
    reserveImport: vi.fn<S['reserveImport']>(async (input) => ({
      artifactId: input.artifactId ?? '01960000-0000-7000-8000-0000000000f2',
    })),
    kindOf: vi.fn<S['kindOf']>(async () => 'document'),
    admit: vi.fn<S['admit']>(async () => true),
    feed: vi.fn<S['feed']>(async (_taskId: string, _turn: number, row: FeedRow) => {
      rows.push(row)
    }),
    comments: vi.fn<S['comments']>(async () => [
      {
        threadId,
        artifactId,
        block: 'intro',
        quote: 'Цены на лето',
        body: 'Добавьте цены на июль',
        ownerReplies: [],
        resolved: false,
        yourReplies: [],
      },
    ]),
    reply: vi.fn<S['reply']>(async () => ({
      id: '01960000-0000-7000-8000-0000000000f3',
      artifactId,
      repeated: false,
    })),
  } satisfies McpArtifactsStore
  return { store, rows }
}

async function start(
  store: McpArtifactsStore,
  scope: McpTurnAccess = base,
  options: { worker?: boolean; render?: McpFrameRenderer } = {},
) {
  const access: McpAccessStore = {
    authenticate: async (value) => (value === token ? scope : null),
  }
  const config = options.worker
    ? {
        ...testMcpConfig(),
        browserWorker: { url: 'http://127.0.0.1:9', token: 'w'.repeat(48), sessionMaxHours: 4 },
      }
    : testMcpConfig()
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
    .overrideProvider(MCP_ARTIFACTS)
    .useValue(
      new McpArtifactsService({ store, ...(options.render ? { render: options.render } : {}) }),
    )
  if (options.worker) builder = builder.overrideProvider(MCP_WEB).useValue({ call: vi.fn() })
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
type Result = { body: { result: { isError?: boolean; content: { text: string }[] } } }
const answer = (res: Result) =>
  JSON.parse(res.body.result.content[0]!.text) as Record<string, unknown>

describe('the frames drawn by the browser worker (plan 88, Ар32, 88.15б, 88.15в)', () => {
  const drawn: Awaited<ReturnType<McpFrameRenderer>> = {
    title: 'Сайт',
    report: 'Layout of «Сайт» as the client sees it (1440×900, 390×844).\nNo problems found.',
    ru: 'Проверка вёрстки на компьютере и телефоне: замечаний нет',
    problems: 0,
    heights: [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ],
    pictures: [
      { width: 1440, part: 0, type: 'image/jpeg', data: '/9j/AAAA' },
      { width: 390, part: 0, type: 'image/jpeg', data: '/9j/BBBB' },
    ],
  }
  const tools = async (scope: McpTurnAccess, worker = true) => {
    const render = vi.fn<McpFrameRenderer>(async () => drawn)
    const server = await start(fakeStore().store, scope, { worker, render })
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    return {
      server,
      render,
      names: (list.body.result.tools as { name: string }[])
        .map((tool) => tool.name)
        .filter((name) => name === 'artifact_layout' || name === 'artifact_render'),
    }
  }

  it('offers artifact_layout where the worker is, artifact_render only to a turn that sees images', async () => {
    expect((await tools(base, false)).names).toEqual([])
    expect((await tools(base)).names).toEqual(['artifact_layout'])
    await app?.close()
    expect((await tools({ ...base, vision: true })).names).toEqual([
      'artifact_layout',
      'artifact_render',
    ])
  })

  it('reports the layout as the chat sees it and gives the pictures as image results', async () => {
    const { server, render } = await tools({ ...base, vision: true })
    const layout = await post(server, call('artifact_layout', { artifactId, frame: 'home' }))
    expect(answer(layout)).toMatchObject({ report: drawn.report, problems: 0 })
    expect(render).toHaveBeenLastCalledWith({
      artifactId,
      frame: 'home',
      viewer: { kind: 'agent', taskId: base.taskId, turnNo: base.turn },
      output: 'layout',
    })
    const look = await post(server, call('artifact_render', { artifactId, frame: 'home' }))
    const content = look.body.result.content as { type: string; data?: string; mimeType?: string }[]
    expect(content.map((part) => part.type)).toEqual(['text', 'image', 'image'])
    expect(content[1]).toEqual({ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' })
    // A call of the helper's tool by a turn whose key does not see images is not admitted.
    await app?.close()
    const blind = await tools(base)
    const refused = await post(blind.server, call('artifact_render', { artifactId }))
    expect(refused.status).toBe(400)
  })
})

describe('the artifacts of a workspace through the gateway (plan 88, 88.6)', () => {
  it('lists the tools of the family and none of the synonyms of plan 69', async () => {
    const server = await start(fakeStore().store)
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = list.body.result.tools as {
      name: string
      description: string
      inputSchema: { additionalProperties?: boolean }
    }[]
    const names = tools.map((tool) => tool.name)
    const family = tools.filter((tool) => tool.name.startsWith('artifact_'))
    expect(family.map((tool) => tool.name)).toEqual([
      'artifact_list',
      'artifact_read',
      'artifact_create',
      'artifact_edit',
      'artifact_claim',
      'artifact_save_version',
      'artifact_file_put',
      'artifact_import',
      'artifact_comments',
      'artifact_reply',
    ])
    expect(names.filter((name) => name.startsWith('doc_'))).toEqual([])
    for (const tool of family) expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
    // No longer than the descriptions of `docs` it replaces (§7.5).
    expect(family.reduce((sum, tool) => sum + tool.description.length, 0)).toBeLessThanOrEqual(2379)
  })

  it('creates a document with its skeleton and tells the card of the chat', async () => {
    const { store, rows } = fakeStore()
    const server = await start(store)
    const res = await post(
      server,
      call('artifact_create', {
        kind: 'document',
        title: 'План',
        skeleton: [
          { id: 'intro', intent: 'Введение' },
          { id: 'sources', intent: 'Источники' },
        ],
      }),
    )
    expect(answer(res)).toMatchObject({ artifactId, blocks: ['intro', 'sources'], projectId: null })
    expect(store.apply.mock.calls[0]![0]).toMatchObject({
      artifactId,
      ops: [
        { op: 'insert', block: 'intro', after: null, kind: 'section', intent: 'Введение' },
        { op: 'insert', block: 'sources', after: 'intro', kind: 'section', intent: 'Источники' },
      ],
    })
    expect(rows).toEqual([
      { type: 'feed.doc_touch', payload: { v: 1, docId: artifactId, revision: 5 } },
    ])
  })

  it('refuses a kind whose view has not shipped (Ар7)', async () => {
    const server = await start(fakeStore().store)
    const res = await post(server, call('artifact_create', { kind: 'diagram', title: 'Схема' }))
    expect(res.body.result.isError).toBe(true)
    expect(answer(res)).toMatchObject({ code: 'ARTIFACT_KIND_REFUSED' })
  })

  it('creates a table without a skeleton: its blocks go by artifact_edit (88.14)', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const refused = await post(
      server,
      call('artifact_create', {
        kind: 'table',
        title: 'Цены',
        skeleton: [{ id: 'intro', intent: 'Введение' }],
      }),
    )
    expect(refused.body.result.isError).toBe(true)
    expect(answer(refused)).toMatchObject({ code: 'ARTIFACT_OP_INVALID' })
    const made = await post(server, call('artifact_create', { kind: 'table', title: 'Цены' }))
    expect(answer(made)).toMatchObject({ artifactId, kind: 'table' })
    expect(store.apply).not.toHaveBeenCalled()
  })

  it('reads by blocks with the news since the last read, and moves the read (Ар21)', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const res = await post(server, call('artifact_read', { artifactId }))
    expect(answer(res)).toMatchObject({
      artifactId,
      seq: 7,
      changedSinceYourRead: { count: 1, blocks: ['b1'] },
      refusedSinceYourRead: ['intro'],
      blocks: [
        { id: 'intro', rev: 3, heading: 'Введение', content: 'Текст' },
        { id: 'sources', checking: true, heldBy: 'checking', content: null },
      ],
    })
    // A whole read moves the read up to the seq that read saw (Ар21); a part does not.
    expect(store.news).toHaveBeenCalledWith(base.taskId, artifactId, 7)
    store.news.mockClear()
    const since = await post(server, call('artifact_read', { artifactId, sinceSeq: 3 }))
    expect(answer(since)).toMatchObject({ blocks: [{ id: 'sources' }] })
    expect(store.changedSince).toHaveBeenCalledWith(artifactId, 3)
    expect(store.news.mock.calls.every((each) => each[2] === undefined)).toBe(true)
    const outline = await post(server, call('artifact_read', { artifactId, part: 'outline' }))
    expect(answer(outline)).toMatchObject({
      outline: [{ id: 'intro', bytes: 10 }, { id: 'sources' }],
    })
  })

  it('answers an artifact the chat does not open as not found, and counts foreign reads', async () => {
    const closed = fakeStore(null)
    let server = await start(closed.store)
    const res = await post(server, call('artifact_read', { artifactId }))
    expect(answer(res)).toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
    expect(closed.store.read).not.toHaveBeenCalled()
    await app!.close()
    const foreign = fakeStore({ role: 'owner', personal: true, linked: false })
    foreign.store.admit.mockImplementation(
      async (key: string) => !key.startsWith('artifact-foreign'),
    )
    server = await start(foreign.store)
    const limited = await post(server, call('artifact_read', { artifactId }))
    expect(answer(limited)).toMatchObject({ code: 'ARTIFACT_LIMIT' })
  })

  it('edits by a batch and answers with the refusals of the check and the changes of others', async () => {
    const { store, rows } = fakeStore()
    const server = await start(store)
    const batch = {
      artifactId,
      opId: 'a1',
      ops: [{ op: 'edit', block: 'intro', find: 'Текст', replace: 'Новый текст' }],
    }
    const res = await post(server, call('artifact_edit', batch))
    expect(answer(res)).toMatchObject({ seq: 7, refusedSinceYourRead: ['intro'] })
    expect(store.apply).toHaveBeenCalledWith(batch, {
      kind: 'agent',
      taskId: base.taskId,
      turnNo: 2,
    })
    expect(rows).toEqual([
      { type: 'feed.doc_touch', payload: { v: 1, docId: artifactId, revision: 5 } },
    ])
  })

  it('passes a stale write back with the current block (Ар15)', async () => {
    const { store } = fakeStore()
    store.apply.mockRejectedValue(artifactStale({ block: 'intro', rev: 4, content: 'Другое' }))
    const server = await start(store)
    const res = await post(
      server,
      call('artifact_edit', {
        artifactId,
        opId: 'a2',
        ops: [
          { op: 'replace', block: 'intro', ifRev: 3, content: 'Текст', props: { heading: 'В' } },
        ],
      }),
    )
    expect(res.body.result.isError).toBe(true)
    expect(answer(res)).toMatchObject({
      code: 'ARTIFACT_STALE',
      details: { current: { block: 'intro', rev: 4 } },
    })
  })

  it('in a pass without its client changes only the client’s own artifacts (Ар24)', async () => {
    const shared = fakeStore({ role: 'owner', personal: false, linked: true })
    const server = await start(shared.store, { ...base, unattended: true })
    const edit = await post(
      server,
      call('artifact_edit', {
        artifactId,
        opId: 'a3',
        ops: [{ op: 'edit', block: 'intro', find: 'Текст', replace: 'Т' }],
      }),
    )
    expect(answer(edit)).toMatchObject({ code: 'ARTIFACT_FORBIDDEN' })
    expect(shared.store.apply).not.toHaveBeenCalled()
    const create = await post(
      server,
      call('artifact_create', { kind: 'document', title: 'Отчёт', project: 'this_chat' }),
    )
    expect(answer(create)).toMatchObject({ code: 'ARTIFACT_FORBIDDEN' })
    const read = await post(server, call('artifact_read', { artifactId }))
    expect(read.body.result.isError).toBeUndefined()
    // A claim and a version change nothing others read (§7.5).
    const claim = await post(
      server,
      call('artifact_claim', { artifactId, block: 'intro', intent: 'Обновлю цены' }),
    )
    expect(claim.body.result.isError).toBeUndefined()
  })

  it('deletes a new artifact whose skeleton did not go in', async () => {
    const { store } = fakeStore()
    store.apply.mockRejectedValue(artifactStale())
    const server = await start(store)
    const res = await post(
      server,
      call('artifact_create', {
        kind: 'document',
        title: 'План',
        skeleton: [{ id: 'intro', intent: 'Введение' }],
      }),
    )
    expect(res.body.result.isError).toBe(true)
    expect(store.discard).toHaveBeenCalledWith(artifactId, base.taskId, 2)
  })

  it('saves a version, at most ten a turn, without the agent’s label', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const res = await post(server, call('artifact_save_version', { artifactId, label: 'Черновик' }))
    expect(answer(res)).toMatchObject({ version: 2 })
    expect(store.saveVersion).toHaveBeenCalledWith(artifactId, {
      kind: 'agent',
      taskId: base.taskId,
      turnNo: 2,
    })
    store.admit.mockResolvedValue(false)
    const limited = await post(server, call('artifact_save_version', { artifactId }))
    expect(answer(limited)).toMatchObject({ code: 'ARTIFACT_LIMIT' })
  })
})

describe('the synonyms doc_* of plan 69 (Ар3)', () => {
  it('create the document with its skeleton', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const res = await post(
      server,
      call('doc_create', {
        title: 'Аудит',
        view: 'page',
        sections: [{ id: 'summary', intent: 'Итог' }],
      }),
    )
    expect(answer(res)).toMatchObject({ docId: artifactId, sections: ['summary'] })
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document', title: 'Аудит', view: 'page' }),
    )
  })

  it('write a section as a replace under the revision the chat last saw', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    await post(
      server,
      call('doc_section_write', {
        docId: artifactId,
        id: 'intro',
        heading: 'Введение',
        markdown: 'Да',
      }),
    )
    expect(store.apply.mock.calls[0]![0]).toMatchObject({
      ops: [
        { op: 'replace', block: 'intro', ifRev: 2, content: 'Да', props: { heading: 'Введение' } },
      ],
    })
    await post(
      server,
      call('doc_section_write', {
        docId: artifactId,
        id: 'extra',
        heading: 'Ещё',
        markdown: 'Нет',
        after: 'intro',
      }),
    )
    expect(store.apply.mock.calls[1]![0]).toMatchObject({
      ops: [{ op: 'insert', block: 'extra', after: 'intro', kind: 'section' }],
    })
  })

  it('remove and move under that revision, read sections and finish at the end of the turn', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    await post(server, call('doc_section_remove', { docId: artifactId, id: 'intro' }))
    expect(store.apply.mock.calls[0]![0]).toMatchObject({
      ops: [{ op: 'delete', block: 'intro', ifRev: 2 }],
    })
    await post(server, call('doc_section_move', { docId: artifactId, id: 'intro', after: null }))
    expect(store.apply.mock.calls[1]![0]).toMatchObject({
      ops: [{ op: 'move', block: 'intro', ifRev: 2, after: null }],
    })
    const read = await post(server, call('doc_read', { docId: artifactId }))
    expect(answer(read)).toMatchObject({
      sections: [
        { id: 'intro', state: 'written', heading: 'Введение', markdown: 'Текст' },
        { id: 'sources', state: 'pending', intent: 'Источники', markdown: null },
      ],
    })
    store.placeholders.mockResolvedValue(1)
    const early = await post(server, call('doc_finish', { docId: artifactId }))
    expect(answer(early)).toMatchObject({ code: 'DOC_PENDING_SECTIONS' })
    store.placeholders.mockResolvedValue(0)
    const done = await post(server, call('doc_finish', { docId: artifactId, view: 'text' }))
    expect(answer(done)).toMatchObject({ finished: 'when this turn ends' })
    expect(store.setView).toHaveBeenCalledWith(artifactId, 'text')
  })

  it('puts a file of the outbox into an artifact and gives its reference (88.12)', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const res = await post(server, call('artifact_file_put', { artifactId, file: 'logo.png' }))
    expect(answer(res)).toMatchObject({
      ref: 'artifact-file:01960000-0000-7000-8000-0000000000f1',
    })
    expect(store.reserveFile).toHaveBeenCalledWith({
      taskId: base.taskId,
      turnNo: 2,
      artifactId,
      fileName: 'logo.png',
    })
    const refused = await post(server, call('artifact_file_put', { artifactId, file: 'page.html' }))
    expect(answer(refused)).toMatchObject({ code: 'ARTIFACT_OP_INVALID' })
  })

  it('imports a file of the outbox as a new artifact, or into one of its kind (88.12)', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const fresh = await post(server, call('artifact_import', { file: 'plan.md', title: 'План' }))
    expect(answer(fresh)).toMatchObject({
      artifactId: '01960000-0000-7000-8000-0000000000f2',
      kind: 'document',
    })
    const into = await post(server, call('artifact_import', { file: 'page.html', artifactId }))
    expect(answer(into)).toMatchObject({ code: 'ARTIFACT_OP_INVALID' })
    const unknown = await post(server, call('artifact_import', { file: 'notes.txt' }))
    expect(answer(unknown)).toMatchObject({ code: 'ARTIFACT_OP_INVALID' })
  })

  it('reads the notes sent to this chat and replies in one, closing it after the check (88.18г)', async () => {
    const { store } = fakeStore()
    const server = await start(store)
    const notes = await post(server, call('artifact_comments', { artifactId }))
    expect(answer(notes)).toMatchObject({ notes: [{ threadId, quote: 'Цены на лето' }] })
    expect(store.comments).toHaveBeenCalledWith(base.taskId, artifactId)
    const reply = await post(
      server,
      call('artifact_reply', { threadId, opId, body: 'Добавил цены на июль', resolve: true }),
    )
    expect(answer(reply)).toMatchObject({
      threadId,
      artifactId,
      live: 'after the check of the platform',
    })
    expect(store.reply).toHaveBeenCalledWith({
      taskId: base.taskId,
      turnNo: base.turn,
      threadId,
      requestId: opId,
      body: 'Добавил цены на июль',
      resolve: true,
    })
  })

  it('never replies in a note in a pass without its client (Ар24)', async () => {
    const { store } = fakeStore()
    const server = await start(store, { ...base, unattended: true })
    const list = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (list.body.result.tools as { name: string }[]).map((tool) => tool.name)
    expect(names).toContain('artifact_comments')
    expect(names).not.toContain('artifact_reply')
    const notes = await post(server, call('artifact_comments', {}))
    expect(answer(notes)).toMatchObject({ notes: [{ threadId }] })
    const reply = await post(server, call('artifact_reply', { threadId, opId, body: 'Готово' }))
    expect(reply.body.result?.isError ?? reply.body.error).toBeTruthy()
    expect(store.reply).not.toHaveBeenCalled()
  })
})
