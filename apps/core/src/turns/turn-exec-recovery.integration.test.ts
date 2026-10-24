import { randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
  type PrismaClient,
} from '@repo/db'
import {
  BROWSER_ONLY,
  notFound,
  type SnapshotManifest,
  type TurnEvidence,
  type TurnPlan,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { LiveTurns } from './live-turns.ts'
import { TurnExecRecovery } from './turn-exec-recovery.ts'
import { TaskEventTurnJournal } from './turn-journal.ts'

// Only verify:db's disposable PostgreSQL: a pass sweeps the held sites of the whole database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`

describe.skipIf(!enabled)(
  'turn exec recovery of an ended turn behind an unresolved MCP write, with PostgreSQL',
  () => {
    let db: PrismaClient
    const workspaces: string[] = []
    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
      // A product turn names its driver's row; the seeds have it, a bare database does not.
      await db.agentDriver.upsert({
        where: { id: sampleDriverId },
        update: {},
        create: { id: sampleDriverId, image, capabilities: {}, enabled: true },
      })
    })
    afterEach(async () => {
      vi.restoreAllMocks()
      for (const workspaceId of workspaces.splice(0)) {
        await db.siteLease.deleteMany({ where: { site: { workspaceId } } })
        await db.mcpCall.deleteMany({ where: { turn: { task: { workspaceId } } } })
        await db.task.deleteMany({ where: { workspaceId } })
        await db.site.deleteMany({ where: { workspaceId } })
        await db.workspace.delete({ where: { id: workspaceId } })
      }
    })
    afterAll(async () => {
      await db.$disconnect()
    })

    /**
     * A product turn as its owner left it: a content write of the running agent got no answer
     * (McpJournal.markAmbiguous: the lease names its writer and is held), the owner journaled
     * `failed{lease_lost}`, and neither its release nor its finish went through.
     */
    async function endedBehindWrite() {
      const workspace = await db.workspace.create({ data: { name: 'Synthetic turn recovery' } })
      workspaces.push(workspace.id)
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: 'https://recovery.example.test',
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({ data: { workspaceId: workspace.id, siteId: site.id } })
      const sessionId = randomUUID()
      const leases = new PostgresSiteLeaseStore(db)
      const assignments = new PostgresTaskTurnAssignmentStore(db)
      const journal = new TaskEventTurnJournal(db)
      const fence = (await leases.acquire({
        siteId: site.id,
        taskId: task.id,
        operation: 'turn',
        ttlMs: 60_000,
      }))!
      const plan: TurnPlan = {
        sandbox: {
          image,
          labels: {
            workspaceId: workspace.id,
            siteId: site.id,
            taskId: task.id,
            sessionId,
            turn: 1,
          },
          runtime: 'runc',
          resources: { cpu: 1, memoryMiB: 256, pids: 64 },
          user: { uid: 10001, gid: 10001 },
          env: {},
          secrets: [],
          network: { mode: 'none' },
          hardTimeoutMs: 600_000,
        },
        context: {
          taskId: task.id,
          sessionId,
          turn: 1,
          llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
          mcp: { url: 'http://mcp.invalid/mcp' },
          instructions: 'Synthetic',
        },
        input: { prompt: 'Synthetic', attachments: [] },
        driverId: sampleDriverId,
        driverVersion: '1.0.0',
        workspace: {
          repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
          branch: `agent/${task.id}`,
          expectedBaseSha: 'b'.repeat(40),
          protectedPaths: [],
        },
        committedAt: '2026-10-01T00:00:00.000Z',
      }
      const assignment = (await assignments.open({
        fence,
        sessionId,
        turn: 1,
        executor: 'local',
        plan,
        remainingMs: 30_000,
      }))!
      const entry = (sequence: number, phase: TurnEvidence['phase'], extra = {}): TurnEvidence => ({
        fence,
        sessionId,
        turn: 1,
        sequence,
        phase,
        containerId: 'container1',
        ...extra,
      })
      await journal.record({ fence, sessionId, turn: 1, sequence: 1, phase: 'leased' })
      await journal.record(entry(2, 'created'))
      await assignments.recordContainer({ id: assignment.id, epoch: 1, containerId: 'container1' })
      await journal.record(entry(3, 'running', { execId: 'exec1' }))
      const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: task.id } })
      const call = await db.mcpCall.create({
        data: { turnId: turn.id, tool: 'synthetic', idempotencyKey: randomUUID() },
      })
      await db.siteLease.update({
        where: { siteId: site.id },
        data: { inflightMcpCallId: call.id, heldForOperator: true },
      })
      await journal.record(
        entry(4, 'failed', { execId: 'exec1', reason: 'lease_lost', outcome: 'failed' }),
      )
      // The owner's own release and finish, refused by the two stores.
      expect(await leases.free(fence)).toBe(false)
      expect(await assignments.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(
        false,
      )

      // Other suites share the disposable database: this recovery sees only its own turn.
      const unfinished = assignments.unfinished.bind(assignments)
      vi.spyOn(assignments, 'unfinished').mockImplementation(async (filter) =>
        (await unfinished(filter)).filter((row) => row.fence.taskId === task.id),
      )
      const logger = { warn: vi.fn(), error: vi.fn() }
      const revoke = vi.fn(async () => {})
      const recovery = new TurnExecRecovery({
        leases,
        assignments,
        journal,
        // An ended turn asks none of them.
        executor: {} as never,
        driver: () => {
          throw new Error('No driver in this test')
        },
        workspace: {} as never,
        snapshots: {} as never,
        credentials: { issue: vi.fn(), recover: vi.fn(), revoke },
        live: new LiveTurns(),
        logger,
      })
      return {
        site,
        task,
        workspace,
        leases,
        logger,
        revoke,
        replay: vi.spyOn(journal, 'replay'),
        finish: vi.spyOn(assignments, 'finish'),
        pass: async () => {
          await recovery.tick()
          await recovery.settled()
        },
        assignment: async () => (await assignments.get(assignment.id))!,
        lease: () => db.siteLease.findUniqueOrThrow({ where: { siteId: site.id } }),
        taskTurn: () => db.taskTurn.findUniqueOrThrow({ where: { id: turn.id } }),
      }
    }

    it('parks the turn after one pass and closes it once the writer is cleared', async () => {
      const f = await endedBehindWrite()
      for (let pass = 0; pass < 4; pass++) await f.pass()
      expect(f.replay).toHaveBeenCalledOnce()
      expect(f.revoke).toHaveBeenCalledOnce()
      expect(f.finish).toHaveBeenCalledOnce()
      expect(f.logger.error).toHaveBeenCalledExactlyOnceWith(
        'Turn recovery left a turn to an operator: unresolved site write (epoch 1, phase failed, attempts 0)',
      )
      expect((await f.assignment()).outcome).toBeNull()
      expect(await f.lease()).toMatchObject({
        holderTaskId: f.task.id,
        epoch: 1,
        heldForOperator: true,
      })
      expect((await f.taskTurn()).status).toBe('running')

      // The content maintenance resolved the write: the writer goes, the hold stays.
      await db.siteLease.update({
        where: { siteId: f.site.id },
        data: { inflightMcpCallId: null },
      })
      await f.pass()
      expect(await f.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
      expect(await f.lease()).toMatchObject({
        holderTaskId: null,
        epoch: 1,
        heldForOperator: false,
      })
      // The TaskTurn closes in the same transaction, with the reason its owner journaled.
      expect(await f.taskTurn()).toMatchObject({ status: 'failed', failureReason: 'lease_lost' })
      expect(f.replay).toHaveBeenCalledOnce()
      expect(f.revoke).toHaveBeenCalledOnce()
      expect(f.finish).toHaveBeenCalledTimes(2)
    })

    it('closes the parked turn once another task has the site', async () => {
      const f = await endedBehindWrite()
      await f.pass()
      await f.pass()
      expect(f.finish).toHaveBeenCalledOnce()
      // An operator resolved the write and took the hold off; the lease ran out meanwhile.
      await db.siteLease.update({
        where: { siteId: f.site.id },
        data: { inflightMcpCallId: null, heldForOperator: false, expiresAt: new Date(0) },
      })
      const other = await db.task.create({
        data: { workspaceId: f.workspace.id, siteId: f.site.id },
      })
      const next = await f.leases.acquire({
        siteId: f.site.id,
        taskId: other.id,
        operation: 'turn',
        ttlMs: 60_000,
      })
      expect(next).toMatchObject({ epoch: 2 })
      await f.pass()
      expect(await f.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
      // The newer owner keeps the site.
      expect(await f.lease()).toMatchObject({ holderTaskId: other.id, epoch: 2 })
      expect(f.replay).toHaveBeenCalledOnce()
      expect(f.revoke).toHaveBeenCalledOnce()
    })
  },
)

describe.skipIf(!enabled)(
  'turn exec recovery of a checkpoint without a repository, with PostgreSQL (plan 57, Б6)',
  () => {
    let db: PrismaClient
    const workspaces: string[] = []
    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
      await db.agentDriver.upsert({
        where: { id: sampleDriverId },
        update: {},
        create: { id: sampleDriverId, image, capabilities: {}, enabled: true },
      })
    })
    afterEach(async () => {
      vi.restoreAllMocks()
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

    /** A turn of a task in the browser whose core died after the journal reached `last`. */
    async function diedAt(last: 'checkpointing' | 'destroyed', manifest: SnapshotManifest | null) {
      const workspace = await db.workspace.create({ data: { name: 'Synthetic browser recovery' } })
      workspaces.push(workspace.id)
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: 'https://browser-recovery.example.test',
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({
        data: {
          workspaceId: workspace.id,
          siteId: site.id,
          needsRepository: false,
          needsBrowser: true,
        },
      })
      const sessionId = randomUUID()
      const leases = new PostgresSiteLeaseStore(db)
      const assignments = new PostgresTaskTurnAssignmentStore(db)
      const journal = new TaskEventTurnJournal(db)
      const fence = (await leases.acquire({
        siteId: site.id,
        taskId: task.id,
        operation: 'turn',
        ttlMs: 60_000,
      }))!
      const plan: TurnPlan = {
        sandbox: {
          image,
          labels: {
            workspaceId: workspace.id,
            siteId: site.id,
            taskId: task.id,
            sessionId,
            turn: 1,
          },
          runtime: 'runc',
          resources: { cpu: 1, memoryMiB: 256, pids: 64 },
          user: { uid: 10001, gid: 10001 },
          env: {},
          secrets: [],
          network: { mode: 'none' },
          hardTimeoutMs: 600_000,
        },
        context: {
          taskId: task.id,
          sessionId,
          turn: 1,
          llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
          mcp: { url: 'http://mcp.invalid/mcp' },
          instructions: 'Synthetic',
        },
        input: { prompt: 'Synthetic', attachments: [] },
        driverId: sampleDriverId,
        driverVersion: '1.0.0',
        requirements: { ...BROWSER_ONLY },
        committedAt: '2026-10-01T00:00:00.000Z',
      }
      const assignment = (await assignments.open({
        fence,
        sessionId,
        turn: 1,
        executor: 'local',
        plan,
        remainingMs: 30_000,
      }))!
      const steps: TurnEvidence['phase'][] = ['created', 'running', 'quiesced', 'checkpointing']
      if (last === 'destroyed') steps.push('checkpointed', 'destroyed')
      await journal.record({ fence, sessionId, turn: 1, sequence: 1, phase: 'leased' })
      let sequence = 1
      for (const phase of steps)
        await journal.record({
          fence,
          sessionId,
          turn: 1,
          sequence: ++sequence,
          phase,
          containerId: 'container1',
          ...(phase === 'running' ? { execId: 'exec1' } : {}),
        })
      await assignments.recordContainer({ id: assignment.id, epoch: 1, containerId: 'container1' })

      const unfinished = assignments.unfinished.bind(assignments)
      vi.spyOn(assignments, 'unfinished').mockImplementation(async (filter) =>
        (await unfinished(filter)).filter((row) => row.fence.taskId === task.id),
      )
      const load = vi.fn(async () => {
        if (!manifest) throw notFound('Snapshot or snapshot part is missing')
        return { manifest, archives: { home: new Uint8Array() } }
      })
      const logger = { warn: vi.fn(), error: vi.fn() }
      const recovery = new TurnExecRecovery({
        leases,
        assignments,
        journal,
        // The container is gone: nothing answers its id or its labels.
        executor: {
          kind: 'local',
          takeover: () => ({}),
          adopt: vi.fn(async () => null),
          list: vi.fn(async () => []),
        } as never,
        driver: () =>
          ({
            id: sampleDriverId,
            sessionState: () => ({ root: '/agent-home/x', include: ['s.db'], exclude: [] }),
          }) as never,
        workspace: null,
        snapshots: { load } as never,
        credentials: { issue: vi.fn(), recover: vi.fn(), revoke: vi.fn(async () => {}) },
        live: new LiveTurns(),
        logger,
      })
      return {
        task,
        logger,
        load,
        pass: async () => {
          await recovery.tick()
          await recovery.settled()
        },
        assignment: async () => (await assignments.get(assignment.id))!,
        lease: () => db.siteLease.findUniqueOrThrow({ where: { siteId: site.id } }),
        taskTurn: () => db.taskTurn.findFirstOrThrow({ where: { taskId: task.id } }),
        phases: async () =>
          (
            await db.taskEvent.findMany({
              where: { taskId: task.id, type: 'turn.lifecycle' },
              orderBy: { id: 'asc' },
            })
          ).map((row) => (row.payload as { phase: string }).phase),
      }
    }

    const manifestOf = (task: { id: string }): SnapshotManifest =>
      ({
        workspaceId: task.id,
        schemaVersion: 1,
        parts: [],
      }) as unknown as SnapshotManifest

    it('completes a checkpoint its core left `destroyed`: nothing is published', async () => {
      const f = await diedAt('destroyed', null)
      f.load.mockResolvedValue({
        manifest: manifestOf(f.task),
        archives: { home: new Uint8Array() },
      })
      await f.pass()

      expect((await f.phases()).at(-1)).toBe('checkpoint_recovered')
      expect(await f.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
      expect(await f.lease()).toMatchObject({ holderTaskId: null, heldForOperator: false })
      expect(await f.taskTurn()).toMatchObject({ status: 'completed', headSha: null })
      expect(f.logger.error).not.toHaveBeenCalled()
    })

    it('closes the turn lost and frees the site when its save never committed', async () => {
      const f = await diedAt('checkpointing', null)
      await f.pass()

      expect((await f.phases()).at(-1)).toBe('failed')
      expect(await f.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 2 } })
      expect(await f.lease()).toMatchObject({ holderTaskId: null, heldForOperator: false })
      expect((await f.taskTurn()).status).toBe('lost')
      expect(f.logger.error).not.toHaveBeenCalled()
    })
  },
)
