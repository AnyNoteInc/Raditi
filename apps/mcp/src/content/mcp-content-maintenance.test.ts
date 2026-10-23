import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@repo/db'
import { terminalTaskStatuses } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { CONTENT_SNAPSHOT_TTL_MS, contentExpiredSql } from './content-snapshots.ts'
import { McpContentMaintenance } from './mcp-content-maintenance.ts'

/** A database that finds one row to sweep and records every raw query it is given. */
function recording() {
  const queries: Prisma.Sql[] = []
  const row = { id: randomUUID(), siteId: randomUUID() }
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(Prisma.sql(strings, ...values))
      // The listing finds the row; its claim then finds no lease and no task past the window.
      return queries.length % 3 === 1 ? [{ id: row.id }] : []
    }),
    snapshot: { findUniqueOrThrow: vi.fn(async () => row) },
    task: { findUniqueOrThrow: vi.fn(async () => row) },
  }
  const db = { $transaction: (work: (client: typeof tx) => unknown) => work(tx) }
  const maintenance = new McpContentMaintenance(
    db as unknown as Pick<PrismaClient, '$transaction'>,
    { delete: vi.fn() },
    { kvDestroyAll: vi.fn() },
    vi.fn(),
  )
  return { maintenance, queries }
}

describe('when the content of a task is over', () => {
  const seconds = CONTENT_SNAPSHOT_TTL_MS / 1000

  it('is one predicate: retired, or finished for longer than the undo window', () => {
    const expired = contentExpiredSql('t')
    expect(expired.text.replace(/\s+/g, ' ')).toBe(
      '(t.content_retired_at IS NOT NULL OR (t.status = ANY($1::"TaskStatus"[]) AND t.finished_at <= clock_timestamp() - make_interval(secs => $2::double precision)))',
    )
    expect(expired.values).toEqual([[...terminalTaskStatuses], seconds])
    // The window is the one «Отменить» promises, and the statuses are those of spec §7.
    expect(seconds).toBe(7 * 24 * 60 * 60)
    expect(contentExpiredSql('tasks', 2 * 86_400_000).values).toEqual([
      [...terminalTaskStatuses],
      172_800,
    ])
  })

  it('is what every sweep and every claim asks, with no window or status list of its own', async () => {
    const { maintenance, queries } = recording()
    expect(await maintenance.sweepSnapshots()).toMatchObject({ visited: 1, purged: 0, failed: 0 })
    expect(await maintenance.sweepMasks()).toMatchObject({ visited: 1, purged: 0, failed: 0 })
    const dated = queries.filter((query) => query.text.includes('finished_at'))
    // Two listings and two claims.
    expect(dated).toHaveLength(4)
    for (const query of dated) {
      expect(query.values).toContainEqual([...terminalTaskStatuses])
      expect(query.values).toContain(seconds)
    }
    for (const query of queries) {
      expect(query.text).not.toMatch(/interval\s+'\d+ days'/)
      for (const status of terminalTaskStatuses) expect(query.text).not.toContain(`'${status}'`)
    }
  })
})
