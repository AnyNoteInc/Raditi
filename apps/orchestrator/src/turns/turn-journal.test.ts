import { createPrismaClient, PostgresSiteLeaseStore, type PrismaClient } from '@repo/db'
import type { SiteLeaseGrant, TurnEvidence } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { replayedTurn, TaskEventTurnJournal, type JournaledEvidence } from './turn-journal.ts'

const fence = {
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  operation: 'turn' as const,
  epoch: 1,
}
const entry = (phase: JournaledEvidence['phase'], extra: Partial<JournaledEvidence> = {}) =>
  ({ fence, sessionId: 'synthetic', turn: 1, sequence: 1, phase, ...extra }) as JournaledEvidence

describe('turn journal boundary', () => {
  it('refuses arbitrary raw errors and prepared credentials in evidence', async () => {
    const $queryRaw = vi.fn()
    await expect(
      new TaskEventTurnJournal({ $queryRaw }).record({
        rawError: 'must not persist',
        prepared: { apiKey: 'secret' },
      } as unknown as TurnEvidence),
    ).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('reports a fenced insert that matched no lease as a lost lease', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([])
    const evidence: TurnEvidence = {
      fence: {
        siteId: '00000000-0000-4000-8000-000000000002',
        taskId: '00000000-0000-4000-8000-000000000003',
        operation: 'turn',
        epoch: 1,
      },
      sessionId: 'synthetic',
      turn: 1,
      sequence: 1,
      phase: 'output',
    }
    await expect(new TaskEventTurnJournal({ $queryRaw }).record(evidence)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
  })
})

describe('turn journal replay', () => {
  it('refuses an invalid range before querying', async () => {
    const $queryRaw = vi.fn()
    const journal = new TaskEventTurnJournal({ $queryRaw })
    const range = {
      siteId: '00000000-0000-4000-8000-000000000002',
      taskId: '00000000-0000-4000-8000-000000000003',
      sessionId: 'synthetic',
      turn: 1,
      fromEpoch: 2,
      toEpoch: 1,
    }
    await expect(journal.replay(range)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(journal.replay({ ...range, siteId: 'bad', toEpoch: 2 })).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('sums up where the agent stopped: the last phase, its exec and the journaled output', () => {
    expect(replayedTurn([])).toEqual({
      lastPhase: undefined,
      step: undefined,
      reason: undefined,
      vacating: false,
      sequence: 0,
      containerId: undefined,
      execId: undefined,
      cursor: { stdout: 0, stderr: 0 },
      events: [],
      candidateHeadSha: undefined,
      nativeSessionId: undefined,
    })
    const journal = [
      entry('leased'),
      entry('created', { sequence: 2, containerId: 'container1' }),
      entry('restored', { sequence: 3, containerId: 'container1', nativeSessionId: 'prior' }),
      entry('running', { sequence: 4, containerId: 'container1', execId: 'exec1' }),
      entry('output', {
        sequence: 5,
        execId: 'exec1',
        cursor: { stdout: 10, stderr: 2 },
        events: [
          { type: 'started', nativeSessionId: 'native1' },
          { type: 'message', text: 'first' },
        ],
      }),
      entry('output', { sequence: 6, execId: 'exec1', cursor: { stdout: 12, stderr: 5 } }),
      entry('resumed', { sequence: 7, fence: { ...fence, epoch: 2 }, recoveredFromEpoch: 1 }),
      entry('output', {
        sequence: 8,
        fence: { ...fence, epoch: 2 },
        execId: 'exec1',
        cursor: { stdout: 20, stderr: 5 },
        events: [{ type: 'completed' }],
      }),
    ]
    expect(replayedTurn(journal)).toEqual({
      lastPhase: 'output',
      step: 'output',
      reason: undefined,
      vacating: false,
      sequence: 8,
      containerId: 'container1',
      execId: 'exec1',
      cursor: { stdout: 20, stderr: 5 },
      events: [
        { type: 'started', nativeSessionId: 'native1' },
        { type: 'message', text: 'first' },
        { type: 'completed' },
      ],
      candidateHeadSha: undefined,
      nativeSessionId: 'native1',
    })
    // A held turn keeps the step it reached and says why it was held.
    expect(
      replayedTurn([...journal, entry('recovery', { sequence: 9, reason: 'destroy_failed' })]),
    ).toMatchObject({ lastPhase: 'recovery', step: 'output', reason: 'destroy_failed' })
    expect(replayedTurn(journal.slice(0, 3))).toMatchObject({ nativeSessionId: 'prior' })
  })

  it('remembers a turn given up while its prepare was out, whatever came after', () => {
    const vacated = [
      entry('leased'),
      entry('vacating', { sequence: 2, reason: 'cancelled' }),
      entry('vacating', { sequence: 3, reason: 'cancelled', containerId: 'container1' }),
      entry('recovery', { sequence: 4, reason: 'destroy_failed', containerId: 'container1' }),
    ]
    expect(replayedTurn(vacated.slice(0, 2))).toMatchObject({
      lastPhase: 'vacating',
      step: 'leased',
      reason: 'cancelled',
      vacating: true,
      containerId: undefined,
    })
    expect(replayedTurn(vacated)).toMatchObject({
      lastPhase: 'recovery',
      step: 'leased',
      reason: 'destroy_failed',
      vacating: true,
      containerId: 'container1',
    })
  })

  it.each([
    ['another container', entry('created', { containerId: 'container2' })],
    ['another exec', entry('running', { containerId: 'container1', execId: 'exec2' })],
    ['a cursor moved back', entry('output', { execId: 'exec1', cursor: { stdout: 1, stderr: 0 } })],
  ])('finds a journal mismatch in %s', (_case, contradicting) => {
    const journal = [
      entry('created', { containerId: 'container1' }),
      entry('running', { containerId: 'container1', execId: 'exec1' }),
      entry('output', { execId: 'exec1', cursor: { stdout: 5, stderr: 0 } }),
    ]
    expect(() => replayedTurn([...journal, contradicting])).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })
})

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('durable fenced turn evidence', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.siteLease.deleteMany({ where: { site: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function fixture() {
    const ws = await db.workspace.create({ data: { name: 'Synthetic turn journal verification' } })
    workspaces.push(ws.id)
    const site = await db.site.create({
      data: {
        workspaceId: ws.id,
        name: 'Journal test',
        url: 'https://journal.invalid',
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({ data: { workspaceId: ws.id, siteId: site.id } })
    const leases = new PostgresSiteLeaseStore(db)
    const fence = (await leases.acquire({
      siteId: site.id,
      taskId: task.id,
      operation: 'turn',
      ttlMs: 60_000,
    })) as SiteLeaseGrant
    const evidence: TurnEvidence = {
      fence,
      sessionId: 'synthetic',
      turn: 1,
      sequence: 1,
      phase: 'leased',
    }
    return { task, leases, fence, evidence, journal: new TaskEventTurnJournal(db) }
  }

  it('persists bounded operational evidence without changing task status', async () => {
    const f = await fixture()
    await f.journal.record(f.evidence)
    const row = await db.taskEvent.findFirstOrThrow({ where: { taskId: f.task.id } })
    expect(row.type).toBe('turn.lifecycle')
    expect(row.clientVisible).toBe(false)
    expect(row.payload).toMatchObject({ phase: 'leased', fence: { epoch: 1 } })
    expect(JSON.stringify(row.payload)).not.toContain('serverNow')
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).status).toBe('queued')
  })

  it('permits recovery evidence under a held lease but refuses normal progress', async () => {
    const f = await fixture()
    await f.leases.holdForRecovery(f.fence)
    await f.journal.record({ ...f.evidence, phase: 'recovery', reason: 'snapshot_ambiguous' })
    await expect(f.journal.record({ ...f.evidence, phase: 'running' })).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    expect(await db.taskEvent.count({ where: { taskId: f.task.id } })).toBe(1)
  })

  it('replays one turn across its epochs in the order it was written', async () => {
    const f = await fixture()
    const record = (fence: SiteLeaseGrant, extra: Partial<TurnEvidence>) =>
      f.journal.record({ ...f.evidence, fence, ...extra })
    await record(f.fence, { phase: 'leased' })
    await record(f.fence, { phase: 'running', execId: 'exec1', containerId: 'container1' })
    await record(f.fence, { phase: 'output', cursor: { stdout: 5, stderr: 0 } })
    // Another session and another turn of the same task stay out.
    await record(f.fence, { phase: 'leased', sessionId: 'other' })
    await record(f.fence, { phase: 'leased', turn: 2 })
    await f.leases.holdForRecovery(f.fence)
    const next = (await f.leases.reclaimForRecovery(f.fence, 60_000)) as SiteLeaseGrant
    await record(next, { phase: 'resumed', recoveredFromEpoch: 1 })
    // Many output batches: more than one page of the replay.
    await db.$executeRaw`
      INSERT INTO task_events (task_id, type, payload, client_visible)
      SELECT ${f.task.id}::uuid, 'turn.output', jsonb_build_object(
        'fence', jsonb_build_object('siteId', ${f.fence.siteId}::text,
          'taskId', ${f.task.id}::text, 'operation', 'turn', 'epoch', 2),
        'sessionId', 'synthetic', 'turn', 1, 'sequence', n, 'phase', 'output',
        'cursor', jsonb_build_object('stdout', 5 + n, 'stderr', 0)), false
      FROM generate_series(1, 600) AS n`
    const range = {
      siteId: f.fence.siteId,
      taskId: f.task.id,
      sessionId: 'synthetic',
      turn: 1,
      fromEpoch: 1,
      toEpoch: 2,
    }
    const entries = await f.journal.replay(range)
    expect(entries).toHaveLength(604)
    expect(entries.slice(0, 4).map((entry) => [entry.fence.epoch, entry.phase])).toEqual([
      [1, 'leased'],
      [1, 'running'],
      [1, 'output'],
      [2, 'resumed'],
    ])
    expect(replayedTurn(entries)).toMatchObject({
      lastPhase: 'output',
      execId: 'exec1',
      cursor: { stdout: 605, stderr: 0 },
    })
    expect(await f.journal.replay({ ...range, toEpoch: 1 })).toHaveLength(3)

    // A stored entry the schema refuses is a mismatch for an operator, never skipped.
    await db.taskEvent.create({
      data: {
        taskId: f.task.id,
        type: 'turn.lifecycle',
        payload: { ...entries[0], fence: { ...entries[0]!.fence, epoch: 2 }, phase: 'rewritten' },
      },
    })
    await expect(f.journal.replay(range)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('keeps a vacating entry under its own held or expired epoch, never under a newer owner', async () => {
    const f = await fixture()
    await f.journal.record({ ...f.evidence, phase: 'vacating', reason: 'cancelled' })
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second'
      WHERE site_id = ${f.fence.siteId}::uuid`
    await f.journal.record({ ...f.evidence, sequence: 2, phase: 'vacating', reason: 'cancelled' })
    await expect(f.journal.record({ ...f.evidence, phase: 'running' })).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    await f.leases.holdForRecovery(f.fence)
    await f.journal.record({ ...f.evidence, sequence: 3, phase: 'vacating', reason: 'cancelled' })
    await f.leases.reclaimForRecovery(f.fence, 60_000)
    await expect(
      f.journal.record({ ...f.evidence, sequence: 4, phase: 'vacating', reason: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(await db.taskEvent.count({ where: { taskId: f.task.id } })).toBe(3)
  })

  it('refuses old-epoch evidence after a newer owner acquires the site', async () => {
    const f = await fixture()
    await f.leases.release(f.fence)
    await f.leases.acquire({
      siteId: f.fence.siteId,
      taskId: f.fence.taskId,
      operation: 'turn',
      ttlMs: 60_000,
    })
    await expect(f.journal.record({ ...f.evidence, phase: 'recovery' })).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    expect(await db.taskEvent.count({ where: { taskId: f.task.id } })).toBe(0)
  })
})
