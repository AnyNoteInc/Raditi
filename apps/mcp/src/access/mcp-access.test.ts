import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import { terminalTaskStatuses } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { MCP_TOKEN_PATTERN, newTurnKeys, turnKeyHash } from '@repo/turn-keys'
import { MCP_ACCESS_PROBE_TOKEN, mcpTurnAccessSchema, PostgresMcpAccess } from './mcp-access.ts'

const token = `mcp_${'a'.repeat(64)}`
const scope = () => ({
  keyId: randomUUID(),
  taskId: randomUUID(),
  workspaceId: randomUUID(),
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 2,
})
/** The admission row: the scope and whether the chat has the browser. */
const row = (base = scope(), needsBrowser: unknown = false) => ({ ...base, needsBrowser })

/** The instant the run wrote its instructions: the first `feed.request` of its chat. */
const RUN_STARTED = new Date('2026-11-16T06:00:00.123456Z')

/**
 * The database of the store: the admission query, and what `passUnattended` reads — whether the
 * chat is a run of a scheduled task (`scheduled_runs`) and the requests its feed holds, the first
 * at `RUN_STARTED` and each next a second later, unless their instants are given; a bound on
 * `createdAt` is taken as PostgreSQL takes it.
 */
function dbOf(
  $queryRaw: unknown,
  chat: { run?: boolean; requests?: number; writtenAt?: readonly Date[] } = {},
) {
  const written =
    chat.writtenAt ??
    Array.from(
      { length: chat.requests ?? 1 },
      (_, at) => new Date(RUN_STARTED.getTime() + at * 1000),
    )
  return {
    $queryRaw,
    scheduledRun: {
      findUnique: vi.fn(async () => (chat.run ? { id: randomUUID() } : null)),
    },
    taskEvent: {
      findMany: vi.fn(async (query: { where: { createdAt?: { lt: Date } }; take: number }) =>
        written
          .map((at, index) => ({ id: BigInt(index + 1), at }))
          .filter(({ at }) => query.where.createdAt === undefined || at < query.where.createdAt.lt)
          .slice(0, query.take)
          .map(({ id }) => ({ id })),
      ),
    },
  } as unknown as PrismaClient
}

describe('MCP token access', () => {
  it('passes only the token hash to SQL and validates returned scope', async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base)])
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    expect(await store.authenticate(token)).toEqual({
      ...base,
      requirements: { repository: false, browser: false },
      memory: null,
      repository: null,
      unattended: false,
    })
    expect(JSON.stringify($queryRaw.mock.calls)).not.toContain(token)
    expect(JSON.stringify($queryRaw.mock.calls)).toContain(
      createHash('sha256').update(token).digest('hex'),
    )
  })

  it("carries the chat's browser, and closes a row that does not say it", async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base, true)])
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    expect(await store.authenticate(token)).toEqual({
      ...base,
      requirements: { repository: false, browser: true },
      memory: null,
      repository: null,
      unattended: false,
    })
    $queryRaw.mockResolvedValueOnce([row(scope(), null)])
    await expect(store.authenticate(token)).rejects.toMatchObject({
      code: 'MCP_ACCESS_SCOPE_INVALID',
    })
  })

  it('carries the memory of the chat while its author has it on and its project is not in the trash (plan 84, ПР18)', async () => {
    const base = scope()
    const userId = randomUUID()
    const projectId = randomUUID()
    const memoryRow = (extra: Record<string, unknown>) => ({
      ...row(base),
      authorId: userId,
      agentMemory: true,
      projectId,
      projectGone: false,
      ...extra,
    })
    const $queryRaw = vi.fn()
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    $queryRaw.mockResolvedValueOnce([memoryRow({})])
    expect((await store.authenticate(token))?.memory).toEqual({ userId, projectId })
    $queryRaw.mockResolvedValueOnce([memoryRow({ projectId: null, projectGone: null })])
    expect((await store.authenticate(token))?.memory).toEqual({ userId, projectId: null })
    for (const off of [{ agentMemory: false }, { projectGone: true }, { authorId: null }]) {
      $queryRaw.mockResolvedValueOnce([memoryRow(off)])
      expect((await store.authenticate(token))?.memory, JSON.stringify(off)).toBeNull()
    }
  })

  it('carries the repository the plan of the turn names, and nothing of a broken one (plan 84, 84.19)', async () => {
    const base = scope()
    const repository = {
      projectId: randomUUID(),
      projectRepositoryId: randomUUID(),
      provider: 'gitlab',
      mode: 'write',
      branch: 'raditi/novoe-menyu-0000000a',
      baseSha: 'a'.repeat(40),
      sandboxBaseSha: 'b'.repeat(40),
      hiddenPaths: [],
    }
    const $queryRaw = vi.fn()
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    $queryRaw.mockResolvedValueOnce([{ ...row(base), repository }])
    const access = await store.authenticate(token)
    expect(access?.requirements.repository).toBe(true)
    expect(access?.repository).toEqual({
      projectId: repository.projectId,
      projectRepositoryId: repository.projectRepositoryId,
      mode: 'write',
      branch: repository.branch,
      baseSha: repository.baseSha,
    })
    $queryRaw.mockResolvedValueOnce([{ ...row(base), repository: { ...repository, mode: 'all' } }])
    await expect(store.authenticate(token)).rejects.toMatchObject({
      code: 'MCP_ACCESS_SCOPE_INVALID',
    })
  })

  it('tells a pass of a scheduled run before its client wrote (plan 82, Зп27)', async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base)])
    const cases = [
      // The run's chat, its feed only the instructions: nobody watches.
      [{ run: true, requests: 1 }, true],
      // The client answered: an ordinary chat from now on.
      [{ run: true, requests: 2 }, false],
      // A chat no schedule started.
      [{ run: false, requests: 1 }, false],
    ] as const
    for (const [chat, unattended] of cases) {
      const db = dbOf($queryRaw, chat)
      const access = await new PostgresMcpAccess(db).authenticate(token)
      expect(access?.unattended, JSON.stringify(chat)).toBe(unattended)
      expect(mcpTurnAccessSchema.safeParse(access).success).toBe(true)
      // Asked of the admitted task, never of anything the request names.
      expect(db.scheduledRun.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { taskId: base.taskId } }),
      )
    }
    // A database that cannot say fails the admission: an outage, never an attended guess.
    const broken = dbOf($queryRaw, { run: true })
    vi.mocked(broken.taskEvent.findMany).mockRejectedValueOnce(new Error('connection lost'))
    await expect(new PostgresMcpAccess(broken).authenticate(token)).rejects.toThrow(
      'connection lost',
    )
    // No row, no question: an unknown token reads nothing more.
    const none = dbOf(
      vi.fn(async () => []),
      { run: true },
    )
    expect(await new PostgresMcpAccess(none).authenticate(token)).toBeNull()
    expect(none.scheduledRun.findUnique).not.toHaveBeenCalled()
  })

  it('decides it for the pass, by the request it answers: «Остановить» lifts nothing of it', async () => {
    const base = scope()
    // The plan keeps the instant of the request to the millisecond; the feed, to the microsecond.
    const answeredAt = '2026-11-16T06:00:00.123Z'
    const $queryRaw = vi.fn(async () => [{ ...row(base), answeredAt }])
    // The pass of the run answers its instructions; the client then presses «Остановить» or
    // «Отправить сейчас» while it runs: a second request, written after the pass's own.
    const pressed = dbOf($queryRaw, {
      run: true,
      writtenAt: [RUN_STARTED, new Date('2026-11-16T06:00:04.500Z')],
    })
    const access = await new PostgresMcpAccess(pressed).authenticate(token)
    expect(access?.unattended).toBe(true)
    expect(mcpTurnAccessSchema.safeParse(access).success).toBe(true)
    // Up to the end of the millisecond of the pass's request, never past it.
    expect(pressed.taskEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskId: base.taskId,
          clientVisible: true,
          type: 'feed.request',
          createdAt: { lt: new Date('2026-11-16T06:00:00.124Z') },
        },
      }),
    )
    // The next pass answers the client's words: an ordinary chat.
    const next = vi.fn(async () => [{ ...row(base), answeredAt: '2026-11-16T06:00:04.500Z' }])
    const answered = dbOf(next, {
      run: true,
      writtenAt: [RUN_STARTED, new Date('2026-11-16T06:00:04.500Z')],
    })
    expect((await new PostgresMcpAccess(answered).authenticate(token))?.unattended).toBe(false)
    // A plan without the instant (only a fixture writes one) counts the whole feed, as before.
    for (const missing of [null, 'not a date']) {
      const old = vi.fn(async () => [{ ...row(base), answeredAt: missing }])
      const feed = dbOf(old, { run: true, requests: 2 })
      expect((await new PostgresMcpAccess(feed).authenticate(token))?.unattended).toBe(false)
      expect(feed.taskEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { taskId: base.taskId, clientVisible: true, type: 'feed.request' },
        }),
      )
    }
    // The instant is the plan's own, read by the admission query from the assignment.
    const sql = ($queryRaw.mock.calls[0] as unknown as [string[]])[0].join('$')
    expect(sql).toContain(`a.plan->>'committedAt' AS "answeredAt"`)
  })

  it('reads whether a pass is unattended once per pass, and the token on every call', async () => {
    const base = scope()
    const answeredAt = '2026-11-16T06:00:00.123Z'
    let deadlineAt: unknown = new Date(Date.now() + 60_000)
    const $queryRaw = vi.fn(async () => [{ ...row(base), answeredAt, deadlineAt }])
    const db = dbOf($queryRaw, { run: true, requests: 1 })
    const store = new PostgresMcpAccess(db)
    for (let call = 0; call < 3; call += 1)
      expect((await store.authenticate(token))?.unattended).toBe(true)
    expect($queryRaw).toHaveBeenCalledTimes(3)
    expect(db.scheduledRun.findUnique).toHaveBeenCalledTimes(1)
    expect(db.taskEvent.findMany).toHaveBeenCalledTimes(1)
    // The next pass answers another request: asked again.
    $queryRaw.mockResolvedValueOnce([
      { ...row(base), answeredAt: '2026-11-16T06:00:04.500Z', deadlineAt },
    ])
    await store.authenticate(token)
    expect(db.scheduledRun.findUnique).toHaveBeenCalledTimes(2)
    // A token the query no longer admits is refused at once, whatever is kept of its pass.
    $queryRaw.mockResolvedValueOnce([])
    expect(await store.authenticate(token)).toBeNull()
    // Nothing is kept past the deadline of the assignment, nor without one.
    const late = new PostgresMcpAccess(db)
    for (const passed of [new Date(Date.now() - 1), null]) {
      deadlineAt = passed
      await late.authenticate(token)
      await late.authenticate(token)
    }
    expect(db.scheduledRun.findUnique).toHaveBeenCalledTimes(6)
  })

  it('looks up the token its issuer generates, by the hash its issuer stores', async () => {
    const issued = newTurnKeys()
    const $queryRaw = vi.fn(async (..._: unknown[]) => [])
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    expect(await store.authenticate(issued.mcpToken)).toBeNull()
    expect($queryRaw.mock.calls[0]![1]).toBe(turnKeyHash(issued.mcpToken))
    // The other half of the pair is not an MCP token.
    expect(await store.authenticate(issued.llmApiKey)).toBeNull()
    expect($queryRaw).toHaveBeenCalledTimes(1)
    // Health asks with a token of the issued format, so its probe runs the real query.
    expect(MCP_TOKEN_PATTERN.test(MCP_ACCESS_PROBE_TOKEN)).toBe(true)
  })

  it('keeps every admission condition in the query', async () => {
    // mcp-access.integration.test.ts proves each one on PostgreSQL; this keeps a silently
    // dropped condition from passing where that suite does not run.
    const $queryRaw = vi.fn(async (..._: unknown[]) => [])
    await new PostgresMcpAccess(dbOf($queryRaw)).authenticate(token)
    const sql = ($queryRaw.mock.calls[0]![0] as string[]).join('$').replace(/\s+/g, ' ')
    for (const condition of [
      'JOIN tasks t ON t.id = k.task_id',
      'AND a.site_id = t.id',
      'JOIN site_leases l ON l.site_id = a.site_id AND l.holder_task_id = t.id AND l.epoch = a.lease_epoch',
      'k.mcp_token_hash = $',
      'k.revoke_requested_at IS NULL',
      'k.revoked_at IS NULL',
      'k.task_attempt = t.attempt',
      'k.expires_at > clock_timestamp()',
      'k.valid_until > clock_timestamp()',
      'a.deadline_at > clock_timestamp()',
      'a.finished_at IS NULL',
      'a.outcome IS NULL',
      "l.operation = 'turn'",
      'NOT l.held_for_operator',
      'l.expires_at > clock_timestamp()',
      't.content_retired_at IS NULL',
      't.status <> ALL($::"TaskStatus"[])',
    ])
      expect(sql).toContain(condition)
    expect(sql).not.toMatch(/\bOR\b|sites|preview/)
    // The final statuses are the list of spec §7, not a copy of it in this query.
    expect($queryRaw.mock.calls[0]!.slice(1)).toEqual([
      createHash('sha256').update(token).digest('hex'),
      [...terminalTaskStatuses],
    ])
    expect(terminalTaskStatuses).toEqual(['done', 'failed', 'rolled_back', 'cancelled'])
  })

  it('refuses malformed tokens before the database and admits nobody without a row', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([])
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    for (const value of ['', token.toUpperCase(), token + '\n', 'sk-rdt-other-key'])
      expect(await store.authenticate(value)).toBeNull()
    expect($queryRaw).not.toHaveBeenCalled()
    expect(await store.authenticate(token)).toBeNull()
  })

  it('fails closed with a fixed, content-free invariant error on ambiguous or invalid rows', async () => {
    const $queryRaw = vi.fn()
    const store = new PostgresMcpAccess(dbOf($queryRaw))
    for (const rows of [[row(), row()], [{ ...row(), keyId: 'secret' }]]) {
      $queryRaw.mockResolvedValueOnce(rows)
      const error = await store.authenticate(token).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ name: 'DomainError', code: 'MCP_ACCESS_SCOPE_INVALID' })
      expect(JSON.stringify(error) + String(error)).not.toMatch(/secret|mcp_/)
    }
  })
})
