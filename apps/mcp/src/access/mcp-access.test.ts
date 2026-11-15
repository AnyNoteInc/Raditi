import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import { terminalTaskStatuses } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { MCP_TOKEN_PATTERN, newTurnKeys, turnKeyHash } from '@repo/turn-keys'
import { MCP_ACCESS_PROBE_TOKEN, PostgresMcpAccess } from './mcp-access.ts'

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

describe('MCP token access', () => {
  it('passes only the token hash to SQL and validates returned scope', async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base)])
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    expect(await store.authenticate(token)).toEqual({
      ...base,
      requirements: { repository: false, browser: false },
      memory: null,
    })
    expect(JSON.stringify($queryRaw.mock.calls)).not.toContain(token)
    expect(JSON.stringify($queryRaw.mock.calls)).toContain(
      createHash('sha256').update(token).digest('hex'),
    )
  })

  it("carries the chat's browser, and closes a row that does not say it", async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base, true)])
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    expect(await store.authenticate(token)).toEqual({
      ...base,
      requirements: { repository: false, browser: true },
      memory: null,
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
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    $queryRaw.mockResolvedValueOnce([memoryRow({})])
    expect((await store.authenticate(token))?.memory).toEqual({ userId, projectId })
    $queryRaw.mockResolvedValueOnce([memoryRow({ projectId: null, projectGone: null })])
    expect((await store.authenticate(token))?.memory).toEqual({ userId, projectId: null })
    for (const off of [{ agentMemory: false }, { projectGone: true }, { authorId: null }]) {
      $queryRaw.mockResolvedValueOnce([memoryRow(off)])
      expect((await store.authenticate(token))?.memory, JSON.stringify(off)).toBeNull()
    }
  })

  it('looks up the token its issuer generates, by the hash its issuer stores', async () => {
    const issued = newTurnKeys()
    const $queryRaw = vi.fn(async (..._: unknown[]) => [])
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
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
    await new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient).authenticate(token)
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
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    for (const value of ['', token.toUpperCase(), token + '\n', 'sk-rdt-other-key'])
      expect(await store.authenticate(value)).toBeNull()
    expect($queryRaw).not.toHaveBeenCalled()
    expect(await store.authenticate(token)).toBeNull()
  })

  it('fails closed with a fixed, content-free invariant error on ambiguous or invalid rows', async () => {
    const $queryRaw = vi.fn()
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    for (const rows of [[row(), row()], [{ ...row(), keyId: 'secret' }]]) {
      $queryRaw.mockResolvedValueOnce(rows)
      const error = await store.authenticate(token).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ name: 'DomainError', code: 'MCP_ACCESS_SCOPE_INVALID' })
      expect(JSON.stringify(error) + String(error)).not.toMatch(/secret|mcp_/)
    }
  })
})
