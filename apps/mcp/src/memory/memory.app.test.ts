import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { ChatMemory } from '@repo/db'
import { DomainError } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore, type McpTurnAccess } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { McpMemoryService, type McpMemoryStore } from './memory-service.ts'
import { MCP_MEMORY } from './memory.tokens.ts'

// The memory of a chat through the gateway (docs/plan/84-projects.md, ПР18, §4.4): offered while
// it is on, its memory from the admitted turn, every change reserved for the end of the turn.

const token = `mcp_${'c'.repeat(64)}`
const projectId = '01960000-0000-7000-8000-0000000000f1'
const userId = '01960000-0000-7000-8000-0000000000e1'
const entryId = '01960000-0000-7000-8000-0000000000e2'
const base: McpTurnAccess = {
  keyId: '01960000-0000-7000-8000-000000000021',
  taskId: '01960000-0000-7000-8000-000000000022',
  workspaceId: '01960000-0000-7000-8000-000000000023',
  sessionId: 'synthetic',
  turn: 3,
  firstEpoch: 1,
  epoch: 1,
  requirements: { repository: false, browser: false },
  memory: { userId, projectId },
}
const chat: ChatMemory = {
  workspaceId: base.workspaceId,
  userId,
  projectId,
  accountMemory: true,
}

let app: INestApplication | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
})

function fakeStore(memory: ChatMemory | null = chat) {
  return {
    memory: vi.fn(async () => memory),
    list: vi.fn(async () => [
      {
        id: entryId,
        kind: 'fact' as const,
        text: 'Цены — только из прайса',
        status: 'active' as const,
        author: 'client' as const,
        version: 2,
        projectId: null,
        pendingAction: 'update' as const,
        updatedAt: new Date('2026-11-15T10:00:00Z'),
      },
    ]),
    reserve: vi.fn(async (_input: Parameters<McpMemoryStore['reserve']>[0]) => ({
      reservationId: '01960000-0000-7000-8000-0000000000e3',
    })),
  } satisfies McpMemoryStore
}

async function start(scope: McpTurnAccess = base, store = fakeStore()) {
  const access: McpAccessStore = { authenticate: async (value) => (value === token ? scope : null) }
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(testMcpConfig())] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
    .overrideProvider(MCP_MEMORY)
    .useValue(new McpMemoryService({ store }))
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
const answer = (res: { body: { result: { content: { text: string }[] } } }) =>
  JSON.parse(res.body.result.content[0]!.text) as Record<string, unknown>

describe('the memory of a chat through the gateway (plan 84, 84.12)', () => {
  it('is offered while the memory of the chat is on, and not at all when it is off', async () => {
    const on = await start()
    expect(await names(on.server)).toEqual(
      expect.arrayContaining(['memory_list', 'memory_save', 'memory_update', 'memory_forget']),
    )
    await app?.close()
    const offScope = await start({ ...base, memory: null })
    expect(await names(offScope.server)).not.toContain('memory_save')
    expect(
      (await post(offScope.server, call('memory_save', { kind: 'fact', text: 'а' }))).status,
    ).toBe(400)
  })

  it('reserves a note in the memory of the chat, never one of the arguments', async () => {
    const { server, store } = await start()
    const res = await post(
      server,
      call('memory_save', { kind: 'preference', text: ' Отвечать коротко ' }),
    )
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBeFalsy()
    expect(answer(res)).toMatchObject({
      ok: true,
      reservedId: '01960000-0000-7000-8000-0000000000e3',
      live: 'when this turn ends',
    })
    expect(store.reserve).toHaveBeenCalledWith({
      taskId: base.taskId,
      turnNo: 3,
      scope: { workspaceId: base.workspaceId, userId, projectId },
      change: { kind: 'save', entryKind: 'preference', text: 'Отвечать коротко' },
    })
    await post(
      server,
      call('memory_update', { id: entryId, text: 'Отвечать подробно', expectedVersion: 2 }),
    )
    await post(server, call('memory_forget', { id: entryId, expectedVersion: 2 }))
    expect(store.reserve.mock.calls.map(([input]) => input.change)).toEqual([
      expect.objectContaining({ kind: 'save' }),
      { kind: 'update', entryId, text: 'Отвечать подробно', expectedVersion: 2 },
      { kind: 'forget', entryId, expectedVersion: 2 },
    ])
  })

  it('refuses a key it does not know, a long text and a version below 1 before the tool', async () => {
    const { server, store } = await start()
    for (const [name, args] of [
      ['memory_save', { kind: 'fact', text: 'а', projectId }],
      ['memory_save', { kind: 'fact', text: 'а'.repeat(401) }],
      ['memory_save', { kind: 'note', text: 'а' }],
      ['memory_update', { id: entryId, text: 'а', expectedVersion: 0 }],
      ['memory_forget', { id: 'запись', expectedVersion: 1 }],
    ] as const)
      expect((await post(server, call(name, args))).status, JSON.stringify(args)).toBe(400)
    expect(store.reserve).not.toHaveBeenCalled()
  })

  it('lists the notes the chat reads, with the memory each is of and a pending proposal', async () => {
    const { server } = await start()
    expect(answer(await post(server, call('memory_list', {})))).toEqual({
      entries: [
        {
          id: entryId,
          kind: 'fact',
          text: 'Цены — только из прайса',
          status: 'active',
          author: 'client',
          version: 2,
          memory: 'account',
          pending: 'update',
          updatedAt: '2026-11-15T10:00:00.000Z',
        },
      ],
    })
  })

  it('answers «off» when the chat left the memory it was admitted with, and a refusal as a result', async () => {
    const moved = await start(base, fakeStore({ ...chat, projectId: null }))
    const res = await post(moved.server, call('memory_save', { kind: 'fact', text: 'а' }))
    expect(res.body.result.isError).toBe(true)
    expect(answer(res)).toMatchObject({ code: 'MEMORY_OFF' })
    expect(moved.store.reserve).not.toHaveBeenCalled()
    await app?.close()
    const store = fakeStore()
    store.reserve.mockRejectedValueOnce(
      new DomainError('MEMORY_LIMIT', 'The memory already has 40 entries', 409),
    )
    const full = await start(base, store)
    const refused = await post(full.server, call('memory_save', { kind: 'fact', text: 'а' }))
    expect(refused.status).toBe(200)
    expect(answer(refused)).toMatchObject({ code: 'MEMORY_LIMIT' })
  })
})
