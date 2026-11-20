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
import {
  McpArtifactsService,
  type McpArtifactsStore,
  type McpChatArtifactAccess,
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
    admit: vi.fn<S['admit']>(async () => true),
    feed: vi.fn<S['feed']>(async (_taskId: string, _turn: number, row: FeedRow) => {
      rows.push(row)
    }),
  } satisfies McpArtifactsStore
  return { store, rows }
}

async function start(store: McpArtifactsStore, scope: McpTurnAccess = base) {
  const access: McpAccessStore = {
    authenticate: async (value) => (value === token ? scope : null),
  }
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(testMcpConfig())] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
    .overrideProvider(MCP_ARTIFACTS)
    .useValue(new McpArtifactsService({ store }))
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

describe('the artifacts of a workspace through the gateway (plan 88, 88.6)', () => {
  it('lists the six tools of the family and none of the synonyms of plan 69', async () => {
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
    expect(rows).toEqual([{ type: 'feed.doc', payload: { v: 1, docId: artifactId } }])
  })

  it('refuses a kind whose view has not shipped (Ар7)', async () => {
    const server = await start(fakeStore().store)
    const res = await post(server, call('artifact_create', { kind: 'table', title: 'Цены' }))
    expect(res.body.result.isError).toBe(true)
    expect(answer(res)).toMatchObject({ code: 'ARTIFACT_KIND_REFUSED' })
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
    expect(store.news).toHaveBeenCalledWith(base.taskId, artifactId, true)
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
})
