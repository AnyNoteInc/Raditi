// The trusted undo without a database: what it takes for an input, and that it answers with
// its counter or one of its fixed codes. The admission itself is proved on PostgreSQL in
// mcp-host-undo.integration.test.ts.
import { randomUUID } from 'node:crypto'

import { conflict, DomainError, leaseLost } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import type { ContentPrivacy } from './content-privacy.ts'
import type { ContentSnapshotStorage } from './content-snapshots.ts'
import type { McpHostScope } from './mcp-access.ts'
import { McpContentService } from './mcp-content.ts'
import { PostgresMcpJournal } from './mcp-journal.ts'

function fixture() {
  const fence = { siteId: randomUUID(), taskId: randomUUID(), operation: 'turn' as const, epoch: 3 }
  const scope: McpHostScope = {
    siteId: fence.siteId,
    workspaceId: randomUUID(),
    stack: 'wordpress',
    url: 'https://site.example.test/',
    targetTaskId: fence.taskId,
    fence,
  }
  const journal = {
    hostScope: vi.fn<PostgresMcpJournal['hostScope']>(async () => scope),
    turnSnapshots: vi.fn<PostgresMcpJournal['turnSnapshots']>(async () => []),
    taskSnapshots: vi.fn<PostgresMcpJournal['taskSnapshots']>(async () => []),
    restoreSource: vi.fn<PostgresMcpJournal['restoreSource']>(),
    reserve: vi.fn<PostgresMcpJournal['reserve']>(),
    noteContentAccess: vi.fn<PostgresMcpJournal['noteContentAccess']>(),
  }
  const privacy = { mask: vi.fn(), rehydrate: vi.fn() }
  const resolve = vi.fn(async () => {
    throw new Error('The site must not be reached')
  })
  const service = new McpContentService(
    journal as unknown as PostgresMcpJournal,
    {} as ContentSnapshotStorage,
    privacy as unknown as ContentPrivacy,
    resolve,
  )
  const snapshotId = randomUUID()
  const receipt = {
    id: snapshotId,
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
    taskId: scope.targetTaskId,
    objectRef: 'page:42',
    expiresAt: new Date(Date.now() + 60_000),
    payloadSha256: 'a'.repeat(64),
    sizeBytes: 1,
  }
  journal.restoreSource.mockResolvedValue({ receipt, expectedStateHash: 'b'.repeat(64) })
  return { fence, scope, journal, privacy, resolve, service, snapshotId }
}

describe('the trusted content undo of the role', () => {
  it('reads its scope from the journal by the fence: the task of the turn lease is the target', async () => {
    const f = fixture()
    const grant = { ...f.fence, expiresAt: new Date(), serverNow: new Date() }
    expect(await f.service.undoTurn({ fence: grant, turn: 2 })).toEqual({ restored: 0 })
    expect(f.journal.hostScope).toHaveBeenCalledExactlyOnceWith(f.fence, f.fence.taskId)
    expect(f.journal.turnSnapshots).toHaveBeenCalledExactlyOnceWith(f.scope, 2)
  })

  it('undoes the task the request names, under whatever fence the journal admits for it', async () => {
    const f = fixture()
    const targetTaskId = randomUUID()
    const fence = { ...f.fence, operation: 'revert' as const }
    expect(await f.service.undoTask({ fence, targetTaskId })).toEqual({ restored: 0 })
    expect(f.journal.hostScope).toHaveBeenCalledExactlyOnceWith(fence, targetTaskId)
    expect(f.journal.taskSnapshots).toHaveBeenCalledExactlyOnceWith(f.scope)
  })

  it.each([
    [
      'a turn undo under a revert lease',
      (f: ReturnType<typeof fixture>) =>
        f.service.undoTurn({ fence: { ...f.fence, operation: 'revert' }, turn: 1 }),
    ],
    [
      'a deploy lease',
      (f: ReturnType<typeof fixture>) =>
        f.service.undoTask({
          fence: { ...f.fence, operation: 'deploy' },
          targetTaskId: randomUUID(),
        }),
    ],
    [
      'a turn that is not a number of a turn',
      (f: ReturnType<typeof fixture>) => f.service.undoTurn({ fence: f.fence, turn: 0 }),
    ],
    [
      'a target that is not a task id',
      (f: ReturnType<typeof fixture>) =>
        f.service.undoTask({ fence: f.fence, targetTaskId: 'task' }),
    ],
    [
      'a turn credential next to the fence',
      (f: ReturnType<typeof fixture>) =>
        f.service.undoTurn({ fence: f.fence, turn: 1, mcpToken: `mcp_${'a'.repeat(64)}` } as never),
    ],
  ])('refuses %s before it asks the journal anything', async (_label, call) => {
    const f = fixture()
    await expect(call(f)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.journal.hostScope).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['LEASE_LOST', leaseLost('Synthetic stale fence')],
    ['CONFLICT', conflict('Synthetic retired context')],
  ])('passes %s of the admission on as it is', async (code, error) => {
    const f = fixture()
    f.journal.hostScope.mockRejectedValue(error)
    await expect(f.service.undoTurn({ fence: f.fence, turn: 1 })).rejects.toBe(error)
    await expect(
      f.service.undoTask({ fence: f.fence, targetTaskId: f.fence.taskId }),
    ).rejects.toMatchObject({ code })
    expect(f.journal.turnSnapshots).not.toHaveBeenCalled()
    expect(f.journal.taskSnapshots).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a journal outage',
      new DomainError('MCP_JOURNAL_UNAVAILABLE', 'MCP journal is unavailable', 503),
    ],
    [
      'a write that is still unresolved',
      new DomainError('MCP_CALL_IN_FLIGHT', 'private detail', 409),
    ],
    ['an unexpected failure', new Error('private postgres://user:secret@host/db')],
  ])('answers %s with the one retryable code and nothing of its cause', async (_label, cause) => {
    const f = fixture()
    f.journal.taskSnapshots.mockRejectedValue(cause)
    const failure = await f.service
      .undoTask({ fence: f.fence, targetTaskId: f.fence.taskId })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'CONTENT_RESTORE_FAILED', httpStatus: 503 })
    expect(JSON.stringify([failure, (failure as Error).message])).not.toMatch(/private|secret/)
    expect((failure as Error).cause).toBeUndefined()
  })

  it('stops at the first edit it cannot return and keeps the fixed code of the stop', async () => {
    const f = fixture()
    f.journal.taskSnapshots.mockResolvedValue([
      { snapshotId: f.snapshotId, turnNo: 2 },
      { snapshotId: randomUUID(), turnNo: 1 },
    ])
    f.journal.reserve.mockResolvedValue({
      kind: 'replay',
      callId: randomUUID(),
      completion: { result: 'error', response: { code: 'CONTENT_CONFLICT' } },
    })
    await expect(
      f.service.undoTask({ fence: f.fence, targetTaskId: f.fence.taskId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // The key of a trusted restore: the turn of the edit and its snapshot, nothing of a request.
    expect(f.journal.reserve).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      {
        tool: 'restore',
        objectRef: 'page:42',
        idempotencyKey: `undo:2:${f.snapshotId}`,
        arguments: { snapshotId: f.snapshotId },
      },
      f.snapshotId,
      true,
    )
    f.journal.reserve.mockResolvedValue({
      kind: 'replay',
      callId: randomUUID(),
      completion: { result: 'error', response: { code: 'CONTENT_SITE_UNAVAILABLE' } },
    })
    await expect(
      f.service.undoTask({ fence: f.fence, targetTaskId: f.fence.taskId }),
    ).rejects.toMatchObject({ code: 'CONTENT_RESTORE_FAILED' })
  })

  it('touches no contact map: an undo reads no content for an agent', async () => {
    const f = fixture()
    f.journal.taskSnapshots.mockResolvedValue([{ snapshotId: f.snapshotId, turnNo: 1 }])
    f.journal.reserve.mockResolvedValue({
      kind: 'replay',
      callId: randomUUID(),
      completion: { result: 'ok', response: { restored: true } },
    })
    expect(await f.service.undoTask({ fence: f.fence, targetTaskId: f.fence.taskId })).toEqual({
      restored: 1,
    })
    expect(f.privacy.mask).not.toHaveBeenCalled()
    expect(f.privacy.rehydrate).not.toHaveBeenCalled()
    expect(f.journal.noteContentAccess).not.toHaveBeenCalled()
  })
})

describe('the host scope at the door of the journal', () => {
  const db = () => ({ $transaction: vi.fn() })
  const host = (): McpHostScope => fixture().scope
  const restore = (snapshotId: string) => ({
    tool: 'restore',
    objectRef: 'page:42',
    idempotencyKey: `undo:1:${snapshotId}`,
    arguments: { snapshotId },
  })

  it.each([
    ['a fence of another site', (scope: McpHostScope) => ({ ...scope, siteId: randomUUID() })],
    [
      'a deploy fence',
      (scope: McpHostScope) => ({
        ...scope,
        fence: { ...scope.fence, operation: 'deploy' },
      }),
    ],
    ['a turn key next to the fence', (scope: McpHostScope) => ({ ...scope, keyId: randomUUID() })],
    [
      'a lease grant instead of a bare fence',
      (scope: McpHostScope) => ({
        ...scope,
        fence: { ...scope.fence, expiresAt: new Date() },
      }),
    ],
    ['no target task', ({ targetTaskId: _target, ...scope }: McpHostScope) => scope],
  ])('refuses %s without opening a transaction', async (_label, forge) => {
    const database = db()
    const snapshotId = randomUUID()
    await expect(
      new PostgresMcpJournal(database).reserve(
        forge(host()) as never,
        restore(snapshotId),
        snapshotId,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid MCP journal scope' })
    expect(database.$transaction).not.toHaveBeenCalled()
  })

  it('reserves nothing but a restore for the host, before any transaction', async () => {
    const database = db()
    const journal = new PostgresMcpJournal(database)
    const snapshotId = randomUUID()
    await expect(
      journal.reserve(host(), { ...restore(snapshotId), tool: 'wp_rest' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'The host scope only restores' })
    await expect(journal.reserve(host(), restore(snapshotId))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The host scope only restores',
    })
    expect(database.$transaction).not.toHaveBeenCalled()
  })

  it('reads a host scope only for a turn or a revert fence and a task id', async () => {
    const database = db()
    const journal = new PostgresMcpJournal(database)
    const { fence } = host()
    for (const [bad, target] of [
      [{ ...fence, operation: 'deploy' }, randomUUID()],
      [{ ...fence, epoch: 0 }, randomUUID()],
      [{ ...fence, siteId: 'site' }, randomUUID()],
      [fence, 'task'],
    ] as const)
      await expect(journal.hostScope(bad as never, target)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid content undo scope',
      })
    expect(database.$transaction).not.toHaveBeenCalled()
  })
})
