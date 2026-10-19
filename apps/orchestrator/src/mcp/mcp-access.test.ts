import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import { terminalTaskStatuses } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { MCP_TOKEN_PATTERN, newTurnKeys, turnKeyHash } from '../llm/turn-key.ts'
import { MCP_ACCESS_PROBE_TOKEN, PostgresMcpAccess } from './mcp-access.ts'

const token = `mcp_${'a'.repeat(64)}`
const scope = () => ({
  keyId: randomUUID(),
  taskId: randomUUID(),
  siteId: randomUUID(),
  workspaceId: randomUUID(),
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 2,
  stack: 'wordpress',
  url: 'https://site.example.test',
})
const preview = {
  id: randomUUID(),
  status: 'ready',
  database: true,
  hostname: 'site-0a1b2c3d-chat-0a1b2c.localhost',
}
/** The admission row: the scope and the columns of the dialog's preview, NULL without one. */
const row = (base = scope(), of: typeof preview | null = null) => ({
  ...base,
  previewId: of?.id ?? null,
  previewStatus: of?.status ?? null,
  previewDatabase: of?.database ?? null,
  previewHostname: of?.hostname ?? null,
})

describe('MCP token access', () => {
  it('passes only the token hash to SQL and validates returned scope', async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base)])
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    expect(await store.authenticate(token)).toEqual({ ...base, preview: null })
    expect(JSON.stringify($queryRaw.mock.calls)).not.toContain(token)
    expect(JSON.stringify($queryRaw.mock.calls)).toContain(
      createHash('sha256').update(token).digest('hex'),
    )
  })

  it('carries the preview of the dialog, never one named by the request', async () => {
    const base = scope()
    const $queryRaw = vi.fn(async () => [row(base, preview)])
    const store = new PostgresMcpAccess({ $queryRaw } as unknown as PrismaClient)
    expect(await store.authenticate(token)).toEqual({ ...base, preview })
    const sql = ($queryRaw.mock.calls[0] as unknown as [string[]])[0].join('$').replace(/\s+/g, ' ')
    expect(sql).toContain(
      'LEFT JOIN preview_environments p ON p.task_id = t.id AND p.site_id = s.id',
    )
    // A row of another status or an unknown one is broken data: closed, never guessed.
    $queryRaw.mockResolvedValueOnce([row(scope(), { ...preview, status: 'serving' })])
    await expect(store.authenticate(token)).rejects.toMatchObject({
      code: 'MCP_ACCESS_SCOPE_INVALID',
    })
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
      'JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id',
      'JOIN turn_assignments a ON a.task_id = k.task_id AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch AND a.session_id = k.session_id AND a.site_id = s.id',
      'JOIN site_leases l ON l.site_id = s.id AND l.holder_task_id = t.id AND l.epoch = a.lease_epoch',
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
      "s.status = 'active'",
      't.content_retired_at IS NULL',
      't.status <> ALL($::"TaskStatus"[])',
    ])
      expect(sql).toContain(condition)
    expect(sql).not.toMatch(/\bOR\b/)
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
    for (const rows of [
      [row(), row()],
      [row({ ...scope(), url: 'https://password:secret@site.example.test' })],
      [row({ ...scope(), url: 'https://site.example.test/blog/' })],
    ]) {
      $queryRaw.mockResolvedValueOnce(rows)
      const error = await store.authenticate(token).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ name: 'DomainError', code: 'MCP_ACCESS_SCOPE_INVALID' })
      expect(JSON.stringify(error) + String(error)).not.toMatch(/secret|blog|example|mcp_/)
    }
  })
})
