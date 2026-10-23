// The trusted host returns content under the fence of a site lease, with no turn key (spec
// §11). The agent's admission is covered by mcp-access.integration.test.ts, which this change
// leaves as it was.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  PostgresTurnAssignmentStore,
  type PrismaClient,
} from '@repo/db'
import {
  conflict,
  publishedContentHashMaterial,
  type ContentWriteProof,
  type KvSecret,
  type PublishedContentGateway,
  type PublishedContentState,
  type SiteLeaseFence,
  type TurnPlan,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage, memoryTransit } from '@repo/snapshots/testing'

import { sampleDriverId } from '../testing/ids.ts'
import { ContentPrivacy } from '../privacy/content-privacy.ts'
import { ContentSnapshotStorage } from './content-snapshots.ts'
import { PostgresMcpAccess, type McpAccess, type McpHostScope } from '../access/mcp-access.ts'
import { McpContentMaintenance } from './mcp-content-maintenance.ts'
import { McpContentService, type ContentGatewayResolver } from './mcp-content.ts'
import { PostgresMcpJournal } from './mcp-journal.ts'
import { McpTurnContentRollback } from './mcp-turn-content-rollback.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const image = `synthetic@sha256:${'a'.repeat(64)}`

describe.skipIf(!enabled)('trusted host undo in the MCP content journal with PostgreSQL', () => {
  let db: PrismaClient
  let access: PostgresMcpAccess
  let leases: PostgresSiteLeaseStore
  let fixture: {
    workspaceId: string
    siteId: string
    taskId: string
    driverId: string
    providerId: string
    modelId: string
    credentialId: string
    accountId: string
    sessionId: string
  }
  const tracked: (typeof fixture)[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    access = new PostgresMcpAccess(db)
    leases = new PostgresSiteLeaseStore(db)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  beforeEach(async () => {
    const suffix = randomBytes(8).toString('hex')
    fixture = await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: 'Synthetic host undo', dataClass: 'synthetic' },
      })
      const site = await tx.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic host undo',
          url: `https://${suffix}.example.test`,
          stack: 'wordpress',
          status: 'active',
        },
      })
      const task = await tx.task.create({
        data: { workspaceId: workspace.id, siteId: site.id, status: 'running' },
      })
      const driver = await tx.agentDriver.create({
        data: { id: `undo-${suffix}`, image, capabilities: {}, enabled: true },
      })
      const provider = await tx.llmProvider.create({
        data: { slug: `undo-${suffix}`, name: 'Synthetic', kind: 'subscription' },
      })
      const model = await tx.llmModel.create({
        data: {
          providerId: provider.id,
          slug: `undo-${suffix}`,
          name: 'Synthetic',
          modelClass: 'standard',
          reserveOutputTokens: 1024,
        },
      })
      const credential = await tx.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
      })
      const account = await tx.subscriptionAccount.create({
        data: {
          providerId: provider.id,
          driverId: driver.id,
          label: `undo-${suffix}`,
          plan: 'synthetic',
          credentialRefId: credential.id,
          maxConcurrentTurns: 1,
          maxConcurrentRequests: 1,
        },
      })
      return {
        workspaceId: workspace.id,
        siteId: site.id,
        taskId: task.id,
        driverId: driver.id,
        providerId: provider.id,
        modelId: model.id,
        credentialId: credential.id,
        accountId: account.id,
        sessionId: suffix,
      }
    })
    tracked.push(fixture)
  })

  afterEach(async () => {
    const fixture = tracked.pop()
    if (!fixture) return
    const tasks = { workspaceId: fixture.workspaceId }
    await db.siteLease.deleteMany({ where: { siteId: fixture.siteId } })
    await db.llmKey.deleteMany({ where: { task: tasks } })
    await db.mcpCall.deleteMany({ where: { turn: { task: tasks } } })
    await db.snapshot.deleteMany({ where: { siteId: fixture.siteId } })
    await db.turnAssignment.deleteMany({ where: { task: tasks } })
    await db.task.deleteMany({ where: { ...tasks, revertsTaskId: { not: null } } })
    await db.task.deleteMany({ where: tasks })
    await db.site.delete({ where: { id: fixture.siteId } })
    await db.workspace.delete({ where: { id: fixture.workspaceId } })
    await db.subscriptionAccount.delete({ where: { id: fixture.accountId } })
    await db.credentialRef.delete({ where: { id: fixture.credentialId } })
    await db.llmModel.delete({ where: { id: fixture.modelId } })
    await db.llmProvider.delete({ where: { id: fixture.providerId } })
    await db.agentDriver.delete({ where: { id: fixture.driverId } })
  })

  function plan(turn: number, replacesTurn?: number): TurnPlan {
    return {
      sandbox: {
        image,
        labels: {
          workspaceId: fixture.workspaceId,
          siteId: fixture.siteId,
          taskId: fixture.taskId,
          sessionId: fixture.sessionId,
          turn,
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
        taskId: fixture.taskId,
        sessionId: fixture.sessionId,
        turn,
        llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
        mcp: { url: 'http://mcp.invalid/mcp' },
        instructions: 'Synthetic',
      },
      input: { prompt: 'Synthetic', attachments: [] },
      driverId: sampleDriverId,
      driverVersion: '1.0.0',
      workspace: {
        repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
        branch: `agent/${fixture.taskId}`,
        expectedBaseSha: 'b'.repeat(40),
        protectedPaths: [],
      },
      committedAt: '2026-10-04T00:00:00.000Z',
      ...(replacesTurn === undefined ? {} : { replacesTurn }),
    }
  }

  /** The turn lease of the task, as the supervisor takes it. */
  async function turnLease(): Promise<SiteLeaseFence & { operation: 'turn' }> {
    const grant = await leases.acquire({
      siteId: fixture.siteId,
      taskId: fixture.taskId,
      operation: 'turn',
      ttlMs: 600_000,
    })
    expect(grant).not.toBeNull()
    return { siteId: grant!.siteId, taskId: grant!.taskId, operation: 'turn', epoch: grant!.epoch }
  }

  /** An agent turn with a live key under the given lease: what the supervisor opens. */
  async function openTurn(fence: SiteLeaseFence, turn: number, replacesTurn?: number) {
    const token = `mcp_${randomBytes(32).toString('hex')}`
    const key = await db.llmKey.create({
      data: {
        keyHash: hash(randomUUID()),
        mcpTokenHash: hash(token),
        taskId: fixture.taskId,
        taskAttempt: 1,
        sessionId: fixture.sessionId,
        turnNo: turn,
        firstEpoch: fence.epoch,
        driverId: fixture.driverId,
        modelId: fixture.modelId,
        subscriptionAccountId: fixture.accountId,
        budgetRub: '100',
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 300_000),
        validUntil: new Date(Date.now() + 600_000),
      },
    })
    const assignment = await db.turnAssignment.create({
      data: {
        taskId: fixture.taskId,
        siteId: fixture.siteId,
        sessionId: fixture.sessionId,
        turnNo: turn,
        executor: 'local',
        plan: plan(turn, replacesTurn) as object,
        firstEpoch: fence.epoch,
        leaseEpoch: fence.epoch,
        deadlineAt: new Date(Date.now() + 600_000),
      },
    })
    const taskTurn = await db.taskTurn.create({
      data: {
        taskId: fixture.taskId,
        turnNo: turn,
        status: 'running',
        driverId: fixture.driverId,
        modelId: fixture.modelId,
        image,
      },
    })
    const scope = await access.authenticate(token)
    expect(scope).toMatchObject({ turn, epoch: fence.epoch })
    return { scope: scope!, token, keyId: key.id, assignmentId: assignment.id, turnId: taskTurn.id }
  }

  /** The turn stops: its key is revoked or already cleaned up; the lease is still its own. */
  async function stopKey(keyId: string, how: 'revoked' | 'deleted' = 'revoked') {
    if (how === 'deleted') await db.llmKey.delete({ where: { id: keyId } })
    else
      await db.llmKey.update({
        where: { id: keyId },
        data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
      })
  }

  async function closeTurn(
    turn: { assignmentId: string; keyId: string },
    turnNo: number,
    outcome: 'completed' | 'failed',
  ) {
    await db.llmKey.updateMany({
      where: { id: turn.keyId },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
    await db.turnAssignment.update({
      where: { id: turn.assignmentId },
      data: { finishedAt: new Date(), outcome },
    })
    await db.taskTurn.updateMany({
      where: { taskId: fixture.taskId, turnNo },
      data: { status: outcome, finishedAt: new Date() },
    })
  }

  /** «Отменить»: a task that reverts the finished one and holds the site for a revert. */
  async function undoTaskLease(revertsTaskId: string | null = fixture.taskId) {
    const undo = await db.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        siteId: fixture.siteId,
        status: 'running',
        billable: false,
        revertsTaskId,
      },
    })
    const grant = await leases.acquire({
      siteId: fixture.siteId,
      taskId: undo.id,
      operation: 'revert',
      ttlMs: 600_000,
    })
    expect(grant).not.toBeNull()
    const fence: SiteLeaseFence & { operation: 'revert' } = {
      siteId: fixture.siteId,
      taskId: undo.id,
      operation: 'revert',
      epoch: grant!.epoch,
    }
    return { undoTaskId: undo.id, fence }
  }

  /** A synthetic site: conditional writes with receipts, as the adapter of a real one. */
  function site() {
    const memory = memoryStorage()
    const transit = memoryTransit()
    const records = new Map<string, KvSecret>()
    const secrets = {
      ...transit.secrets,
      kvRead: vi.fn(async (path: string) => records.get(path) ?? null),
      kvDestroyAll: vi.fn(async (path: string) => {
        records.delete(path)
      }),
      kvWrite: vi.fn(
        async (path: string, data: Record<string, string>, options?: { cas?: number }) => {
          const version = records.get(path)?.version ?? 0
          if (options?.cas !== version) throw conflict('Synthetic CAS mismatch')
          records.set(path, { data, version: version + 1 })
          return { version: version + 1 }
        },
      ),
    }
    const hashed = (fields: Omit<PublishedContentState, 'stateHash'>): PublishedContentState => ({
      ...fields,
      stateHash: hash(publishedContentHashMaterial(fields)),
    })
    const initial = (objectRef: string) =>
      hashed({
        version: 1,
        objectRef,
        kind: 'post',
        title: 'До',
        content: '<p>Исходный текст</p>',
        excerpt: '',
      })
    const states = new Map<string, PublishedContentState>()
    const stateOf = (objectRef: string) => states.get(objectRef) ?? initial(objectRef)
    const operations = new Map<string, ContentWriteProof>()
    /** `unavailableRestore`: which restore from now on the site answers «unavailable», once. */
    const faults = { loseAcknowledgement: false, unavailableRestore: 0 }
    const gateway: PublishedContentGateway = {
      read: vi.fn(async (objectRef: string) => ({ ...stateOf(objectRef) })),
      conditionalWrite: vi.fn<PublishedContentGateway['conditionalWrite']>(async (input) => {
        if (input.mode === 'restore' && faults.unavailableRestore > 0)
          if (--faults.unavailableRestore === 0)
            return { version: 1, kind: 'rejected', code: 'unavailable' }
        const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
        // The barrier is in place and the write carries the epoch of the lease that admits it.
        expect(lease.inflightMcpCallId).toBe(input.callId)
        expect(input.epoch).toBe(lease.epoch)
        const current = stateOf(input.objectRef)
        if (current.stateHash !== input.expectedStateHash)
          return { version: 1, kind: 'rejected', code: 'conflict' }
        const state = hashed({ ...current, ...input.fields })
        states.set(input.objectRef, state)
        const proof: ContentWriteProof = {
          version: 1,
          kind: 'committed',
          callId: input.callId,
          siteId: input.siteId,
          epoch: input.epoch,
          requestHash: input.requestHash,
          objectRef: input.objectRef,
          stateHash: state.stateHash,
        }
        operations.set(input.callId, proof)
        if (faults.loseAcknowledgement) throw new Error('Synthetic lost site acknowledgement')
        return proof
      }),
      operation: vi.fn(async (callId) => operations.get(callId) ?? null),
      reconcileOperation: vi.fn(
        async (input) =>
          operations.get(input.callId) ?? { version: 1 as const, kind: 'unknown' as const },
      ),
      forgetOperation: vi.fn(async (input) => {
        operations.delete(input.callId)
      }),
    }
    const resolve = vi.fn<ContentGatewayResolver>(async () => gateway)
    const journal = new PostgresMcpJournal(db)
    const snapshots = new ContentSnapshotStorage(memory.storage, secrets)
    const service = new McpContentService(journal, snapshots, new ContentPrivacy(secrets), resolve)
    const edit = (scope: McpAccess, key: string, post = 42, title = key) =>
      service.wpRest(scope, {
        method: 'POST',
        route: `/wp/v2/posts/${post}`,
        body: { title },
        idempotencyKey: key,
      })
    const maintenance = () => new McpContentMaintenance(db, memory.storage, secrets, resolve)
    return {
      memory,
      secrets,
      gateway,
      resolve,
      journal,
      snapshots,
      service,
      edit,
      maintenance,
      faults,
      operations,
      original: initial,
      state: (post = 42) => stateOf(`post:${post}`),
      drift: (post = 42) => {
        states.set(
          `post:${post}`,
          hashed({ ...stateOf(`post:${post}`), content: '<p>Правка человека</p>' }),
        )
      },
    }
  }

  const hostCalls = () =>
    db.mcpCall.findMany({
      where: { turn: { task: { workspaceId: fixture.workspaceId } }, hostTaskId: { not: null } },
      orderBy: { journalNo: 'asc' },
    })
  const writes = (s: ReturnType<typeof site>) => vi.mocked(s.gateway.conditionalWrite).mock.calls

  it.each(['revoked', 'deleted'] as const)(
    'returns the edits of a turn that failed under its own lease, its key %s',
    async (how) => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      await s.edit(turn.scope, 'B')
      await s.edit(turn.scope, 'C')
      await s.edit(turn.scope, 'other', 7)
      expect(s.state().title).toBe('C')
      await stopKey(turn.keyId, how)
      // The agent is out: its token admits nothing any more.
      expect(await access.authenticate(turn.token)).toBeNull()

      expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 3 })
      expect(s.state()).toEqual(s.original('post:42'))
      expect(s.state(7)).toEqual(s.original('post:7'))
      const calls = await hostCalls()
      expect(calls).toHaveLength(3)
      for (const call of calls)
        expect(call).toMatchObject({
          tool: 'restore',
          result: 'ok',
          assignmentId: null,
          credentialKeyId: null,
          hostTaskId: fixture.taskId,
          hostOperation: 'turn',
          leaseEpoch: fence.epoch,
          // Written under the turn of the edit it returns.
          turnId: turn.turnId,
        })
      // Newest first.
      expect(calls.map((call) => call.objectRef)).toEqual(['post:7', 'post:42', 'post:42'])
      expect(
        await db.mcpCall.count({
          where: { turnId: turn.turnId, tool: 'wp_rest', revertedAt: { not: null } },
        }),
      ).toBe(3)
      expect(writes(s)).toHaveLength(6)

      // A repeat finds nothing left and sends nothing.
      expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 0 })
      expect(writes(s)).toHaveLength(6)
      expect(await db.llmKey.count({ where: { taskId: fixture.taskId } })).toBe(
        how === 'deleted' ? 0 : 1,
      )
      expect(
        await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
      ).toMatchObject({ heldForOperator: false, inflightMcpCallId: null, epoch: fence.epoch })
      // The site is the turn's own to release.
      expect(await leases.release(fence)).toBe(true)
    },
  )

  it('undoes a done task under the revert lease of the task that reverts it, newest first', async () => {
    const s = site()
    const fence = await turnLease()
    const first = await openTurn(fence, 1)
    await s.edit(first.scope, 'turn-1')
    await closeTurn(first, 1, 'completed')
    const second = await openTurn(fence, 2)
    await s.edit(second.scope, 'turn-2')
    await s.edit(second.scope, 'turn-2-other', 9)
    await closeTurn(second, 2, 'completed')
    expect(await leases.release(fence)).toBe(true)
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date() },
    })
    // The pool is empty: no key is issued for an undo.
    await db.llmKey.deleteMany({ where: { taskId: fixture.taskId } })
    await db.subscriptionAccount.update({
      where: { id: fixture.accountId },
      data: { enabled: false, status: 'retired' },
    })

    const undo = await undoTaskLease()
    expect(await s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId })).toEqual({
      restored: 3,
    })
    expect(s.state()).toEqual(s.original('post:42'))
    expect(s.state(9)).toEqual(s.original('post:9'))
    const calls = await hostCalls()
    expect(calls.map((call) => [call.objectRef, call.turnId])).toEqual([
      ['post:9', second.turnId],
      ['post:42', second.turnId],
      ['post:42', first.turnId],
    ])
    for (const call of calls)
      expect(call).toMatchObject({
        result: 'ok',
        assignmentId: null,
        credentialKeyId: null,
        hostTaskId: undo.undoTaskId,
        hostOperation: 'revert',
        leaseEpoch: undo.fence.epoch,
      })
    // The state before each restore belongs to the task whose edits are returned.
    expect(
      await db.snapshot.count({
        where: { id: { in: calls.map((call) => call.snapshotId!) }, taskId: fixture.taskId },
      }),
    ).toBe(3)
    expect(await db.llmKey.count({ where: { task: { workspaceId: fixture.workspaceId } } })).toBe(0)
    expect(await s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId })).toEqual({
      restored: 0,
    })
    expect(await leases.release(undo.fence)).toBe(true)
  })

  it('undoes a done task whose turn a removed driver ran: its rows are history, not a plan', async () => {
    const s = site()
    const fence = await turnLease()
    const turn = await openTurn(fence, 1)
    await s.edit(turn.scope, 'turn-1')
    await closeTurn(turn, 1, 'completed')
    expect(await leases.release(fence)).toBe(true)
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date() },
    })
    // What the removal of a shell leaves of its task: the driver row switched off, and the
    // turn, its key and its saved plan still naming an id no code knows.
    const removed = `removed-${randomUUID().slice(0, 8)}`
    await db.agentDriver.create({
      data: { id: removed, image, capabilities: {}, enabled: false },
    })
    try {
      await db.taskTurn.updateMany({
        where: { taskId: fixture.taskId },
        data: { driverId: removed },
      })
      await db.llmKey.updateMany({ where: { taskId: fixture.taskId }, data: { driverId: removed } })
      await db.$executeRaw`UPDATE turn_assignments
        SET plan = jsonb_set(plan, '{driverId}', to_jsonb(${removed}::text))
        WHERE id = ${turn.assignmentId}::uuid`

      const undo = await undoTaskLease()
      expect(await s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId })).toEqual(
        { restored: 1 },
      )
      expect(s.state()).toEqual(s.original('post:42'))
      expect((await hostCalls()).map((call) => [call.result, call.turnId])).toEqual([
        ['ok', turn.turnId],
      ])
      expect(await leases.release(undo.fence)).toBe(true)
    } finally {
      await db.taskTurn.updateMany({
        where: { taskId: fixture.taskId },
        data: { driverId: fixture.driverId },
      })
      await db.llmKey.updateMany({
        where: { taskId: fixture.taskId },
        data: { driverId: fixture.driverId },
      })
      await db.agentDriver.delete({ where: { id: removed } })
    }
  })

  describe('refuses', () => {
    /** A done task with one edit, the site free. */
    async function doneTask() {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      const edited = (await s.edit(turn.scope, 'B')).response as { snapshotId: string }
      await closeTurn(turn, 1, 'completed')
      expect(await leases.release(fence)).toBe(true)
      await db.task.update({
        where: { id: fixture.taskId },
        data: { status: 'done', finishedAt: new Date() },
      })
      return { s, turn, snapshotId: edited.snapshotId }
    }
    const untouched = async (s: ReturnType<typeof site>) => {
      expect(s.state().title).toBe('B')
      expect(writes(s)).toHaveLength(1)
      expect(await hostCalls()).toHaveLength(0)
    }

    it('the lease of another task: neither the holder nor the task it reverts', async () => {
      const { s } = await doneTask()
      // A revert lease of a task that reverts nothing, and of one that reverts another task.
      const stranger = await undoTaskLease(null)
      await expect(
        s.service.undoTask({ fence: stranger.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      // A fence that names a task which does not hold the site.
      await expect(
        s.service.undoTask({
          fence: { ...stranger.fence, taskId: fixture.taskId },
          targetTaskId: fixture.taskId,
        }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await untouched(s)
    })

    it('a holder on another site, whatever task it reverts', async () => {
      const { s } = await doneTask()
      // Nothing in the database ties `reverts_task_id` to the site of the task that carries it.
      const other = await db.site.create({
        data: {
          workspaceId: fixture.workspaceId,
          name: 'Synthetic other site',
          url: `https://other-${fixture.sessionId}.example.test`,
          stack: 'wordpress',
          status: 'active',
        },
      })
      const stray = await db.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          siteId: other.id,
          status: 'running',
          billable: false,
          revertsTaskId: fixture.taskId,
        },
      })
      try {
        const grant = await leases.acquire({
          siteId: other.id,
          taskId: stray.id,
          operation: 'revert',
          ttlMs: 60_000,
        })
        const fence = {
          siteId: other.id,
          taskId: stray.id,
          operation: 'revert' as const,
          epoch: grant!.epoch,
        }
        // It holds its own site, and that lease opens no task of another site.
        await expect(
          s.service.undoTask({ fence, targetTaskId: fixture.taskId }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        // Named for the site of the target, the same holder does not hold it.
        await expect(
          s.service.undoTask({
            fence: { ...fence, siteId: fixture.siteId },
            targetTaskId: fixture.taskId,
          }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        await untouched(s)
      } finally {
        await db.siteLease.deleteMany({ where: { siteId: other.id } })
        await db.task.delete({ where: { id: stray.id } })
        await db.site.delete({ where: { id: other.id } })
      }
    })

    it('a target whose row names another workspace than the site', async () => {
      const { s } = await doneTask()
      const foreign = await db.workspace.create({
        data: { name: 'Synthetic foreign workspace', dataClass: 'synthetic' },
      })
      // A broken row: the task of one workspace on the site of another.
      const target = await db.task.create({
        data: {
          workspaceId: foreign.id,
          siteId: fixture.siteId,
          status: 'done',
          finishedAt: new Date(),
        },
      })
      const undo = await undoTaskLease(target.id)
      try {
        await expect(
          s.service.undoTask({ fence: undo.fence, targetTaskId: target.id }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        await untouched(s)
      } finally {
        await db.siteLease.deleteMany({ where: { siteId: fixture.siteId } })
        await db.task.delete({ where: { id: undo.undoTaskId } })
        await db.task.delete({ where: { id: target.id } })
        await db.workspace.delete({ where: { id: foreign.id } })
      }
    })

    it('a stale epoch', async () => {
      const { s } = await doneTask()
      const undo = await undoTaskLease()
      expect(await leases.release(undo.fence)).toBe(true)
      const again = await leases.acquire({
        siteId: fixture.siteId,
        taskId: undo.undoTaskId,
        operation: 'revert',
        ttlMs: 60_000,
      })
      expect(again!.epoch).toBe(undo.fence.epoch + 1)
      await expect(
        s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await untouched(s)
    })

    it('a site held for the operator, and a lease that has expired', async () => {
      const { s } = await doneTask()
      const undo = await undoTaskLease()
      const request = { fence: undo.fence, targetTaskId: fixture.taskId }
      await db.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      await expect(s.service.undoTask(request)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await db.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      })
      expect(await leases.holdForRecovery(undo.fence)).toBe(true)
      await expect(s.service.undoTask(request)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await untouched(s)
    })

    it('a scope read while the fence held the site, at every step after it stopped holding', async () => {
      const { s, snapshotId } = await doneTask()
      const undo = await undoTaskLease()
      // Reading the scope is only the door: each step checks the fence again under the lock.
      const scope = await s.journal.hostScope(undo.fence, fixture.taskId)
      const restore = {
        tool: 'restore',
        objectRef: 'post:42',
        idempotencyKey: `undo:1:${snapshotId}`,
        arguments: { snapshotId },
      }
      const refused = async () => {
        for (const step of [
          () => s.journal.taskSnapshots(scope),
          () => s.journal.turnSnapshots(scope, 1),
          () => s.journal.restoreSource(scope, snapshotId),
          () => s.journal.reserve(scope, restore, snapshotId),
        ])
          await expect(step()).rejects.toMatchObject({ code: 'LEASE_LOST' })
      }
      const lease = (data: { expiresAt?: Date; heldForOperator?: boolean; epoch?: number }) =>
        db.siteLease.update({ where: { siteId: fixture.siteId }, data })

      await lease({ expiresAt: new Date(Date.now() - 1000) })
      await refused()
      await lease({ expiresAt: new Date(Date.now() + 60_000) })
      // The same scope is good again: the refusals above were the lease, not the scope.
      expect(await s.journal.taskSnapshots(scope)).toHaveLength(1)

      await lease({ heldForOperator: true })
      await refused()
      await lease({ heldForOperator: false })

      await db.site.update({ where: { id: fixture.siteId }, data: { status: 'paused' } })
      await refused()
      await db.site.update({ where: { id: fixture.siteId }, data: { status: 'active' } })

      // The holder no longer reverts the target.
      await db.task.update({ where: { id: undo.undoTaskId }, data: { revertsTaskId: null } })
      await refused()
      await db.task.update({
        where: { id: undo.undoTaskId },
        data: { revertsTaskId: fixture.taskId },
      })

      // The site was taken again: the next epoch, even of the same holder.
      await lease({ epoch: undo.fence.epoch + 1 })
      await refused()
      await untouched(s)
    })

    it('a deploy lease and a site that is not active', async () => {
      const { s } = await doneTask()
      const undo = await undoTaskLease()
      await db.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { operation: 'deploy' },
      })
      await expect(
        s.service.undoTask({
          fence: { ...undo.fence, operation: 'deploy' },
          targetTaskId: fixture.taskId,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(
        s.journal.hostScope({ ...undo.fence, operation: 'deploy' }, fixture.taskId),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      // The fence of a revert does not match a site leased for a deploy.
      await expect(
        s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await db.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { operation: 'revert' },
      })
      await db.site.update({ where: { id: fixture.siteId }, data: { status: 'paused' } })
      await expect(
        s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await untouched(s)
    })

    it('a snapshot whose purge has begun', async () => {
      const { s, snapshotId } = await doneTask()
      const undo = await undoTaskLease()
      await db.snapshot.update({
        where: { id: snapshotId },
        data: { expiresAt: new Date(Date.now() - 2000), purgeRequestedAt: new Date() },
      })
      await expect(
        s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await untouched(s)
    })

    it('a task whose content context is retired, at the door and at every later step', async () => {
      const { s, snapshotId } = await doneTask()
      const undo = await undoTaskLease()
      const scope = await s.journal.hostScope(undo.fence, fixture.taskId)
      await db.task.update({
        where: { id: fixture.taskId },
        data: { contentRetiredAt: new Date() },
      })
      await expect(
        s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      // A scope read before the retirement admits nothing after it.
      await expect(s.journal.restoreSource(scope, snapshotId)).rejects.toMatchObject({
        code: 'LEASE_LOST',
      })
      await expect(s.service.rollbackTurn(scope, 1)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await untouched(s)
    })
  })

  it('stops at an external edit with a conflict and marks nothing returned', async () => {
    const s = site()
    const fence = await turnLease()
    const turn = await openTurn(fence, 1)
    await s.edit(turn.scope, 'B')
    await stopKey(turn.keyId)
    s.drift()
    await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(s.state().content).toBe('<p>Правка человека</p>')
    expect(writes(s)).toHaveLength(1)
    expect(
      await db.mcpCall.count({ where: { turnId: turn.turnId, revertedAt: { not: null } } }),
    ).toBe(0)
    expect(await hostCalls()).toMatchObject([
      { result: 'error', response: { code: 'CONTENT_CONFLICT' }, writeStartedAt: null },
    ])
    // A conflict is an answer, not an unknown write: the site is not held.
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ heldForOperator: false, inflightMcpCallId: null })
  })

  it('goes on after a partial undo: a repeat returns what the first could not', async () => {
    const s = site()
    const fence = await turnLease()
    const turn = await openTurn(fence, 1)
    for (const post of [1, 2, 3]) await s.edit(turn.scope, `edit-${post}`, post)
    await stopKey(turn.keyId)
    // The newest edit is returned, then the site stops answering once.
    s.faults.unavailableRestore = 2
    await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
      code: 'CONTENT_RESTORE_FAILED',
    })
    expect(s.state(3)).toEqual(s.original('post:3'))
    expect(s.state(2).title).toBe('edit-2')
    expect(s.state(1).title).toBe('edit-1')
    // The same lease goes on from where the first call stopped.
    expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 2 })
    for (const post of [1, 2, 3]) expect(s.state(post)).toEqual(s.original(`post:${post}`))
    const calls = await hostCalls()
    expect(calls.map((call) => [call.objectRef, call.result])).toEqual([
      ['post:3', 'ok'],
      ['post:2', 'error'],
      ['post:2', 'ok'],
      ['post:1', 'ok'],
    ])
    // The closed failure keeps its own journal row; the retry is a new call of the same source.
    expect(calls[1]!.restoresSnapshotId).toBe(calls[2]!.restoresSnapshotId)
    expect(calls[1]!.idempotencyKey).not.toBe(calls[2]!.idempotencyKey)
    expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 0 })
  })

  it('waits for a preparation of the live agent, and closes it once the key is revoked', async () => {
    const s = site()
    const fence = await turnLease()
    const turn = await openTurn(fence, 1)
    await s.edit(turn.scope, 'B')
    // The agent is in the middle of a preparation: reserved, nothing dispatched.
    const capture = await s.journal.reserve(turn.scope, {
      tool: 'wp_rest',
      objectRef: 'post:5',
      idempotencyKey: 'agent-capture',
      arguments: { title: 'Не дописано' },
    })
    expect(capture.kind).toBe('claimed')
    // Its key is alive: the host does not close the call under it and returns nothing.
    await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
      code: 'CONTENT_RESTORE_FAILED',
    })
    expect(await db.mcpCall.findUniqueOrThrow({ where: { id: capture.callId } })).toMatchObject({
      result: null,
    })
    expect(await hostCalls()).toHaveLength(0)
    expect(s.state().title).toBe('B')

    // The turn stops. Its preparation never dispatched a write: the undo closes it and goes on.
    await stopKey(turn.keyId)
    expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 1 })
    expect(await db.mcpCall.findUniqueOrThrow({ where: { id: capture.callId } })).toMatchObject({
      result: 'error',
      response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
      writeStartedAt: null,
    })
    expect(s.state()).toEqual(s.original('post:42'))
    // The late request of the agent finds its call closed and may not write.
    await expect(s.journal.beginWrite(turn.scope, capture.callId)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    expect(writes(s)).toHaveLength(2)
  })

  it('finishes under a later lease what an earlier one left, and closes its abandoned capture', async () => {
    const s = site()
    const fence = await turnLease()
    const turn = await openTurn(fence, 1)
    const edited = (await s.edit(turn.scope, 'B')).response as { snapshotId: string }
    await closeTurn(turn, 1, 'completed')
    expect(await leases.release(fence)).toBe(true)
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date() },
    })
    const first = await undoTaskLease()
    const scope = await s.journal.hostScope(first.fence, fixture.taskId)
    // The role died between the reservation and the write.
    const abandoned = await s.journal.reserve(
      scope,
      {
        tool: 'restore',
        objectRef: 'post:42',
        idempotencyKey: `undo:1:${edited.snapshotId}`,
        arguments: { snapshotId: edited.snapshotId },
      },
      edited.snapshotId,
    )
    expect(abandoned.kind).toBe('claimed')
    // Its owner still holds the site and a preparation may still last: nothing is closed.
    expect(await s.journal.recoverCaptures(fixture.siteId)).toBe(0)
    await expect(
      s.service.undoTask({ fence: first.fence, targetTaskId: fixture.taskId }),
    ).rejects.toMatchObject({ code: 'CONTENT_RESTORE_FAILED' })
    expect(await leases.release(first.fence)).toBe(true)

    const second = await undoTaskLease()
    expect(second.fence.epoch).toBe(first.fence.epoch + 1)
    expect(await s.service.undoTask({ fence: second.fence, targetTaskId: fixture.taskId })).toEqual(
      { restored: 1 },
    )
    expect(s.state()).toEqual(s.original('post:42'))
    expect(await hostCalls()).toMatchObject([
      {
        hostTaskId: first.undoTaskId,
        leaseEpoch: first.fence.epoch,
        result: 'error',
        response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
        writeStartedAt: null,
      },
      { hostTaskId: second.undoTaskId, leaseEpoch: second.fence.epoch, result: 'ok' },
    ])
    expect(writes(s)).toHaveLength(2)
  })

  it('does not spend the 20-object ceiling of the turn that replaces the undone one', async () => {
    const s = site()
    const fence = await turnLease()
    const first = await openTurn(fence, 1)
    for (let post = 1; post <= 20; post++)
      expect((await s.edit(first.scope, `edit-${post}`, post, 'Правка')).result).toBe('ok')
    await closeTurn(first, 1, 'failed')
    const second = await openTurn(fence, 2, 1)
    // The rollback before the replacement run: by the fence, with no token of the new turn.
    await new McpTurnContentRollback(s.journal, s.service).rollback({ fence, turn: 1 })
    expect(s.state(20)).toEqual(s.original('post:20'))
    expect(await hostCalls()).toHaveLength(20)
    // Twenty other objects remain the new turn's own allowance.
    for (let post = 21; post <= 40; post++)
      expect((await s.edit(second.scope, `other-${post}`, post, 'Другая')).result).toBe('ok')
    await expect(s.edit(second.scope, 'too-many', 41, 'Лишняя')).rejects.toMatchObject({
      code: 'MCP_APPROVAL_REQUIRED',
    })
  }, 60_000)

  it('leaves the agent where it was: no restore of another turn, no host scope of its own', async () => {
    const s = site()
    const fence = await turnLease()
    const first = await openTurn(fence, 1)
    const source = (await s.edit(first.scope, 'B')).response as { snapshotId: string }
    await closeTurn(first, 1, 'completed')
    const second = await openTurn(fence, 2)
    await expect(
      s.service.restore(second.scope, { snapshotId: source.snapshotId, idempotencyKey: 'cross' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(s.state().title).toBe('B')
    // An agent scope is not a host scope, whatever is added to it.
    await expect(s.journal.taskSnapshots(second.scope as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      s.journal.restoreSource(
        { ...second.scope, targetTaskId: fixture.taskId, fence } as never,
        source.snapshotId,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid MCP journal scope' })
    // Within its own turn it still edits and restores.
    const own = (await s.edit(second.scope, 'C')).response as { snapshotId: string }
    expect(
      (await s.service.restore(second.scope, { snapshotId: own.snapshotId, idempotencyKey: 'own' }))
        .result,
    ).toBe('ok')
    expect(await hostCalls()).toHaveLength(0)
  })

  it('lets the host scope restore and nothing else', async () => {
    const s = site()
    const fence = await turnLease()
    const turn = await openTurn(fence, 1)
    const source = (await s.edit(turn.scope, 'B')).response as { snapshotId: string }
    // The agent stopped in the middle of a preparation.
    const capture = await s.journal.reserve(turn.scope, {
      tool: 'wp_rest',
      objectRef: 'post:5',
      idempotencyKey: 'agent-capture',
      arguments: { title: 'Не дописано' },
    })
    if (capture.kind !== 'claimed') throw new Error('Expected a synthetic reservation')
    // Its snapshot is acknowledged: only the admission of the write is left.
    const receipt = await s.snapshots.save(capture.snapshot, Buffer.from('before'))
    await s.journal.attachSnapshot(turn.scope, capture.callId, receipt)
    await stopKey(turn.keyId)
    const scope = await s.journal.hostScope(fence, fixture.taskId)
    // The host never leads a call of the agent to its write; it may only close it.
    await expect(s.journal.beginWrite(scope, capture.callId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(s.journal.attachSnapshot(scope, capture.callId, receipt)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ inflightMcpCallId: null })
    expect(await s.journal.recoveryIntent(scope, capture.callId)).toEqual({
      kind: 'closed',
      committed: false,
    })
    expect(scope).toEqual({
      workspaceId: fixture.workspaceId,
      siteId: fixture.siteId,
      stack: 'wordpress',
      url: (await db.site.findUniqueOrThrow({ where: { id: fixture.siteId } })).url,
      targetTaskId: fixture.taskId,
      fence,
    } satisfies McpHostScope)
    const restore = {
      tool: 'restore',
      objectRef: 'post:42',
      idempotencyKey: `undo:1:${source.snapshotId}`,
      arguments: { snapshotId: source.snapshotId },
    }
    for (const [command, restores] of [
      [{ ...restore, tool: 'wp_rest', arguments: { title: 'Правка хоста' } }, undefined],
      [{ ...restore, tool: 'wp_rest' }, source.snapshotId],
      [restore, undefined],
      // The key is the journal's own: the turn of the edit and its snapshot.
      [{ ...restore, idempotencyKey: 'anything-else' }, source.snapshotId],
      [{ ...restore, idempotencyKey: `undo:2:${source.snapshotId}` }, source.snapshotId],
    ] as const)
      await expect(s.journal.reserve(scope, command, restores)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    await expect(s.journal.noteContentAccess(scope as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    // The content service has no edit for it either.
    await expect(
      s.service.wpRest(scope as never, {
        method: 'POST',
        route: '/wp/v2/posts/42',
        body: { title: 'Правка хоста' },
        idempotencyKey: 'host-edit',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // The edit and the closed preparation of the agent; the host added nothing.
    expect(await db.mcpCall.count({ where: { turnId: turn.turnId } })).toBe(2)
    expect(await hostCalls()).toHaveLength(0)
    expect(writes(s)).toHaveLength(1)
    expect(s.state().title).toBe('B')
  })

  describe('the rollback before a replacement run', () => {
    it('undoes an interrupted chain newest first, by the fence of the new turn alone', async () => {
      const s = site()
      const fence = await turnLease()
      const first = await openTurn(fence, 1)
      await s.edit(first.scope, 'turn-1', 1)
      await s.edit(first.scope, 'turn-1-more', 2)
      await closeTurn(first, 1, 'failed')
      // Turn 2 replaced turn 1; its rollback returned one edit and stopped.
      const second = await openTurn(fence, 2, 1)
      const rollback = new McpTurnContentRollback(s.journal, s.service)
      s.faults.unavailableRestore = 2
      await expect(rollback.rollback({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      await closeTurn(second, 2, 'failed')
      // Turn 3 replaces turn 2. Its key is gone already: the rollback never needed one.
      const third = await openTurn(fence, 3, 2)
      await stopKey(third.keyId, 'deleted')
      await rollback.rollback({ fence, turn: 2 })
      expect(s.state(1)).toEqual(s.original('post:1'))
      expect(s.state(2)).toEqual(s.original('post:2'))
      expect((await hostCalls()).map((call) => [call.objectRef, call.result])).toEqual([
        ['post:2', 'ok'],
        ['post:1', 'error'],
        ['post:1', 'ok'],
      ])
    })

    it('is refused for a turn the open assignment does not replace, and under a revert', async () => {
      const s = site()
      const fence = await turnLease()
      const first = await openTurn(fence, 1)
      await s.edit(first.scope, 'turn-1')
      await closeTurn(first, 1, 'completed')
      const rollback = new McpTurnContentRollback(s.journal, s.service)
      // No turn is open at all.
      await expect(rollback.rollback({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      // Turn 2 continues turn 1 instead of replacing it.
      const second = await openTurn(fence, 2)
      await expect(rollback.rollback({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      await closeTurn(second, 2, 'failed')
      await openTurn(fence, 3, 2)
      await expect(rollback.rollback({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      await expect(
        rollback.rollback({ fence: { ...fence, operation: 'revert' }, turn: 2 }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await expect(
        rollback.rollback({ fence: { ...fence, epoch: fence.epoch + 1 }, turn: 2 }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(s.state().title).toBe('turn-1')
      expect(await hostCalls()).toHaveLength(0)
    })

    it('is refused, with nothing written, when the saved plan of the replaced turn names a removed driver', async () => {
      const s = site()
      const fence = await turnLease()
      const first = await openTurn(fence, 1)
      await s.edit(first.scope, 'turn-1')
      await closeTurn(first, 1, 'failed')
      await openTurn(fence, 2, 1)
      // A turn the removed shell ran: the row stays as history, its plan is no longer a plan.
      // The product store opens no replacement of such a turn; the journal does not trust that.
      await db.$executeRaw`UPDATE turn_assignments
        SET plan = jsonb_set(plan, '{driverId}', '"codex"') WHERE id = ${first.assignmentId}::uuid`
      await expect(
        new McpTurnContentRollback(s.journal, s.service).rollback({ fence, turn: 1 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(s.state().title).toBe('turn-1')
      expect(await hostCalls()).toHaveLength(0)
    })
  })

  describe('maintenance', () => {
    async function ambiguousUndo() {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      await s.edit(turn.scope, 'B')
      await closeTurn(turn, 1, 'completed')
      expect(await leases.release(fence)).toBe(true)
      await db.task.update({
        where: { id: fixture.taskId },
        data: { status: 'done', finishedAt: new Date() },
      })
      const undo = await undoTaskLease()
      s.faults.loseAcknowledgement = true
      await expect(
        s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'CONTENT_RESTORE_FAILED' })
      s.faults.loseAcknowledgement = false
      const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
      return { s, turn, undo, lease }
    }

    it('reconciles an unknown restore of the host under a revert lease, with no second write', async () => {
      const { s, turn, undo, lease } = await ambiguousUndo()
      // The write barrier of a revert: the site is held and cannot be taken or released.
      expect(lease).toMatchObject({
        operation: 'revert',
        holderTaskId: undo.undoTaskId,
        heldForOperator: true,
      })
      expect(lease.inflightMcpCallId).not.toBeNull()
      expect(await leases.release(undo.fence)).toBe(false)
      const callId = lease.inflightMcpCallId!
      expect(await s.maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
        visited: 0,
      })
      await db.mcpCall.update({
        where: { id: callId },
        data: {
          writeStartedAt: new Date(Date.now() - 30_000),
          writeDeadlineAt: new Date(Date.now() - 15_000),
        },
      })
      expect(await s.maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
        visited: 1,
        completed: 1,
        failed: 0,
      })
      expect(await db.mcpCall.findUniqueOrThrow({ where: { id: callId } })).toMatchObject({
        result: 'ok',
        hostTaskId: undo.undoTaskId,
      })
      expect(
        await db.mcpCall.count({ where: { turnId: turn.turnId, revertedAt: { not: null } } }),
      ).toBe(1)
      expect(
        await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
      ).toMatchObject({ inflightMcpCallId: null, heldForOperator: true })
      expect(s.state()).toEqual(s.original('post:42'))
      expect(writes(s)).toHaveLength(2)
      // The site resolver was asked with the site alone: there is no key to borrow a scope from.
      expect(s.resolve).toHaveBeenLastCalledWith(
        expect.objectContaining({ siteId: fixture.siteId, workspaceId: fixture.workspaceId }),
      )
      expect(vi.mocked(s.resolve).mock.lastCall![0]).not.toHaveProperty('keyId')
    })

    it('purges the snapshots and the site receipts of host restores when the undo window is over', async () => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      await s.edit(turn.scope, 'B')
      await closeTurn(turn, 1, 'completed')
      expect(await leases.release(fence)).toBe(true)
      await db.task.update({
        where: { id: fixture.taskId },
        data: { status: 'done', finishedAt: new Date() },
      })
      const undo = await undoTaskLease()
      expect(await s.service.undoTask({ fence: undo.fence, targetTaskId: fixture.taskId })).toEqual(
        { restored: 1 },
      )
      expect(await leases.release(undo.fence)).toBe(true)
      await db.task.updateMany({
        where: { workspaceId: fixture.workspaceId },
        data: { status: 'done', finishedAt: new Date(Date.now() - 8 * 86_400_000) },
      })
      await db.snapshot.updateMany({
        where: { siteId: fixture.siteId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      await db.mcpCall.updateMany({
        where: { turnId: turn.turnId },
        data: {
          writeStartedAt: new Date(Date.now() - 30_000),
          writeDeadlineAt: new Date(Date.now() - 15_000),
        },
      })
      expect(await s.maintenance().sweepSnapshots({ siteId: fixture.siteId })).toMatchObject({
        visited: 2,
        purged: 2,
        receipts: 2,
        failed: 0,
      })
      expect(s.memory.objects.size).toBe(0)
      expect(s.operations.size).toBe(0)
      const [restore] = await hostCalls()
      expect(restore!.receiptPurgedAt).not.toBeNull()
      // The receipt of the restore is retired under the epoch of the lease that wrote it.
      expect(s.gateway.forgetOperation).toHaveBeenCalledWith(
        expect.objectContaining({ callId: restore!.id, epoch: undo.fence.epoch }),
      )
    })
  })

  // The second review: every case here tries to make the host write where it must not, write
  // twice, or let the agent in through the host's door.
  describe('under attack', () => {
    const leaseRow = () => db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    const setLease = (data: {
      expiresAt?: Date
      heldForOperator?: boolean
      epoch?: number
      operation?: 'turn' | 'revert' | 'deploy'
    }) => db.siteLease.update({ where: { siteId: fixture.siteId }, data })
    const restoreCommand = (snapshotId: string, post = 42, turnNo = 1) => ({
      tool: 'restore',
      objectRef: `post:${post}`,
      idempotencyKey: `undo:${turnNo}:${snapshotId}`,
      arguments: { snapshotId },
    })
    const restoreWrites = (s: ReturnType<typeof site>) =>
      writes(s).filter(([input]) => input.mode === 'restore')
    const outage = () => new Error('Synthetic journal outage')
    /** The write deadline of a call is over: maintenance may ask the site about it. */
    const pastDeadline = (callId: string) =>
      db.mcpCall.update({
        where: { id: callId },
        data: {
          writeStartedAt: new Date(Date.now() - 30_000),
          writeDeadlineAt: new Date(Date.now() - 15_000),
        },
      })

    /** A done task with one edit per post, all of turn 1; the site is free. */
    async function finished(posts: number[] = [42]) {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      const snapshots: string[] = []
      for (const post of posts) {
        const edited = await s.edit(turn.scope, `edit-${post}`, post)
        snapshots.push((edited.response as { snapshotId: string }).snapshotId)
      }
      await closeTurn(turn, 1, 'completed')
      expect(await leases.release(fence)).toBe(true)
      await db.task.update({
        where: { id: fixture.taskId },
        data: { status: 'done', finishedAt: new Date() },
      })
      return { s, turn, fence, snapshots }
    }

    it('admits nothing on a site nobody holds, and no task two steps away from the holder', async () => {
      const { s, fence } = await finished()
      const rollback = new McpTurnContentRollback(s.journal, s.service)
      const nobody = async () => {
        // The fence of the turn that released the site, and the same fence named a revert.
        for (const operation of ['turn', 'revert'] as const)
          await expect(
            s.service.undoTask({ fence: { ...fence, operation }, targetTaskId: fixture.taskId }),
          ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
          code: 'LEASE_LOST',
        })
        await expect(rollback.rollback({ fence, turn: 1 })).rejects.toMatchObject({
          code: 'LEASE_LOST',
        })
      }
      // Released: the row stays, with its epoch and no holder.
      expect(await leaseRow()).toMatchObject({ holderTaskId: null, epoch: fence.epoch })
      await nobody()
      // No row at all.
      await db.siteLease.deleteMany({ where: { siteId: fixture.siteId } })
      await nobody()

      // The holder reverts a task that reverts the target: one step is all a revert reaches.
      const middle = await db.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          siteId: fixture.siteId,
          status: 'done',
          billable: false,
          revertsTaskId: fixture.taskId,
        },
      })
      const far = await undoTaskLease(middle.id)
      try {
        await expect(
          s.service.undoTask({ fence: far.fence, targetTaskId: fixture.taskId }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        // A scope made by hand for that target is admitted by no step either.
        const near = await s.journal.hostScope(far.fence, middle.id)
        await expect(
          s.journal.taskSnapshots({ ...near, targetTaskId: fixture.taskId }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        expect(s.state().title).toBe('edit-42')
        expect(writes(s)).toHaveLength(1)
        expect(await hostCalls()).toHaveLength(0)
      } finally {
        await db.siteLease.deleteMany({ where: { siteId: fixture.siteId } })
        await db.task.delete({ where: { id: far.undoTaskId } })
        await db.task.delete({ where: { id: middle.id } })
      }
    })

    it('refuses the two steps that lead to the write once the fence stops holding the site', async () => {
      const { s, snapshots } = await finished()
      const undo = await undoTaskLease()
      const scope = await s.journal.hostScope(undo.fence, fixture.taskId)
      const claimed = await s.journal.reserve(scope, restoreCommand(snapshots[0]!), snapshots[0]!)
      if (claimed.kind !== 'claimed') throw new Error('Expected a reservation of the host')
      const receipt = await s.snapshots.save(claimed.snapshot, Buffer.from('before'))
      const refused = async () => {
        await expect(
          s.journal.attachSnapshot(scope, claimed.callId, receipt),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' })
        await expect(s.journal.beginWrite(scope, claimed.callId)).rejects.toMatchObject({
          code: 'LEASE_LOST',
        })
        expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null })
        expect(await db.mcpCall.findUniqueOrThrow({ where: { id: claimed.callId } })).toMatchObject(
          { writeStartedAt: null, result: null },
        )
      }
      const task = (
        id: string,
        data: { revertsTaskId?: string | null; contentRetiredAt?: Date | null },
      ) => db.task.update({ where: { id }, data })
      const siteStatus = (status: 'active' | 'paused') =>
        db.site.update({ where: { id: fixture.siteId }, data: { status } })
      const stops: Array<[stop: () => Promise<unknown>, resume: () => Promise<unknown>]> = [
        [
          () => setLease({ expiresAt: new Date(Date.now() - 1000) }),
          () => setLease({ expiresAt: new Date(Date.now() + 600_000) }),
        ],
        [() => setLease({ heldForOperator: true }), () => setLease({ heldForOperator: false })],
        [() => setLease({ operation: 'deploy' }), () => setLease({ operation: 'revert' })],
        [
          () => setLease({ epoch: undo.fence.epoch + 1 }),
          () => setLease({ epoch: undo.fence.epoch }),
        ],
        [() => siteStatus('paused'), () => siteStatus('active')],
        [
          () => task(undo.undoTaskId, { revertsTaskId: null }),
          () => task(undo.undoTaskId, { revertsTaskId: fixture.taskId }),
        ],
        [
          () => task(fixture.taskId, { contentRetiredAt: new Date() }),
          () => task(fixture.taskId, { contentRetiredAt: null }),
        ],
      ]
      // Twice: before the snapshot is acknowledged, and when only the admission is left.
      for (const acknowledged of [false, true]) {
        if (acknowledged) await s.journal.attachSnapshot(scope, claimed.callId, receipt)
        for (const [stop, resume] of stops) {
          await stop()
          await refused()
          await resume()
        }
      }
      // The refusals were the fence: with the site held again the same call is admitted.
      expect(await s.journal.beginWrite(scope, claimed.callId)).toBe(true)
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: claimed.callId })

      // An admitted write is the business of whoever owns the epoch: its evidence is recorded
      // past the expiry and under a hold…
      await setLease({ expiresAt: new Date(Date.now() - 1000), heldForOperator: true })
      expect(await s.journal.writeIntent(scope, claimed.callId)).toMatchObject({
        callId: claimed.callId,
        restoresSnapshotId: snapshots[0],
      })
      // …and by nobody once the epoch has moved on.
      await setLease({ epoch: undo.fence.epoch + 1 })
      for (const step of [
        () => s.journal.writeIntent(scope, claimed.callId),
        () => s.journal.recoveryIntent(scope, claimed.callId),
        () => s.journal.markAmbiguous(scope, claimed.callId),
        () =>
          s.journal.finish(scope, claimed.callId, {
            result: 'error',
            response: { code: 'CONTENT_WRITE_NOT_COMMITTED' },
          }),
      ])
        await expect(step()).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(await db.mcpCall.findUniqueOrThrow({ where: { id: claimed.callId } })).toMatchObject({
        result: null,
      })
      expect(writes(s)).toHaveLength(1)
    })

    it('gives the agent no way into a call of the host, and no replay of its restore', async () => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      const first = (await s.edit(turn.scope, 'B')).response as { snapshotId: string }
      const other = (await s.edit(turn.scope, 'other', 7)).response as { snapshotId: string }
      // The host holds the same turn lease; the key of the agent is alive all along.
      const scope = await s.journal.hostScope(fence, fixture.taskId)
      const pending = await s.journal.reserve(
        scope,
        restoreCommand(other.snapshotId, 7),
        other.snapshotId,
      )
      if (pending.kind !== 'claimed') throw new Error('Expected a reservation of the host')
      const receipt = await s.snapshots.save(pending.snapshot, Buffer.from('before'))
      // While the host prepares, the agent starts nothing on the site…
      await expect(s.edit(turn.scope, 'C')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
      await expect(
        s.service.restore(turn.scope, { snapshotId: first.snapshotId, idempotencyKey: 'own' }),
      ).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
      // …and it neither leads the host's call to a write nor closes it.
      for (const step of [
        () => s.journal.attachSnapshot(turn.scope, pending.callId, receipt),
        () => s.journal.beginWrite(turn.scope, pending.callId),
        () => s.journal.recoveryIntent(turn.scope, pending.callId),
        () =>
          s.journal.finish(turn.scope, pending.callId, {
            result: 'error',
            response: { code: 'CONTENT_PREPARATION_FAILED' },
          }),
      ])
        await expect(step()).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await db.mcpCall.findUniqueOrThrow({ where: { id: pending.callId } })).toMatchObject({
        result: null,
        writeStartedAt: null,
      })
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null })
      // The host closes its own preparation and returns both edits.
      expect(await s.journal.recoveryIntent(scope, pending.callId)).toEqual({
        kind: 'closed',
        committed: false,
      })
      expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 2 })
      const sent = writes(s).length

      // The key the host uses is no key of the agent: asked with it, the agent gets its own
      // refusal — the edit is returned already — and not the answer of the host's restore.
      for (const snapshot of [first, other])
        await expect(
          s.service.restore(turn.scope, {
            snapshotId: snapshot.snapshotId,
            idempotencyKey: `undo:1:${snapshot.snapshotId}`,
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(writes(s)).toHaveLength(sent)
      expect(await db.mcpCall.count({ where: { turnId: turn.turnId, tool: 'restore' } })).toBe(
        (await hostCalls()).length,
      )
    })

    it('frees no allowance of the 20 objects: neither the agent restore nor the host undo', async () => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      const snapshots: string[] = []
      for (let post = 1; post <= 20; post++) {
        const edited = await s.edit(turn.scope, `edit-${post}`, post, 'Правка')
        snapshots.push((edited.response as { snapshotId: string }).snapshotId)
      }
      const overLimit = (key: string, post: number) =>
        expect(s.edit(turn.scope, key, post, 'Лишняя')).rejects.toMatchObject({
          code: 'MCP_APPROVAL_REQUIRED',
        })
      await overLimit('over-1', 21)
      // The agent returns one of its twenty: a restore is no new object and frees no place.
      expect(
        (
          await s.service.restore(turn.scope, {
            snapshotId: snapshots[19]!,
            idempotencyKey: 'own-restore',
          })
        ).result,
      ).toBe('ok')
      await overLimit('over-2', 21)
      // The host returns the rest under the same lease, the key of the agent still alive.
      expect(await s.service.undoTurn({ fence, turn: 1 })).toEqual({ restored: 19 })
      for (let post = 1; post <= 20; post++)
        expect(s.state(post)).toEqual(s.original(`post:${post}`))
      // Twenty objects of this turn were changed, whatever came back: the next one needs approval.
      await overLimit('over-3', 21)
      await overLimit('over-4', 22)
      // One of the twenty is still the agent's to edit.
      expect((await s.edit(turn.scope, 'again', 5, 'Снова')).result).toBe('ok')
      expect(
        await db.mcpCall.count({ where: { turnId: turn.turnId, hostTaskId: { not: null } } }),
      ).toBe(19)
    }, 60_000)

    it('sends each restore once when three undos of the host run at once', async () => {
      const posts = [1, 2, 3, 4, 5, 6]
      const { s, turn } = await finished(posts)
      const undo = await undoTaskLease()
      const request = { fence: undo.fence, targetTaskId: fixture.taskId }
      const race = await Promise.allSettled([
        s.service.undoTask(request),
        s.service.undoTask(request),
        s.service.undoTask(request),
      ])
      // Whoever lost the race was told to come again, never that the content had changed.
      for (const result of race)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ code: 'CONTENT_RESTORE_FAILED' })
      expect(race.some((result) => result.status === 'fulfilled')).toBe(true)
      // A repeat finds whatever the race left and nothing more.
      await s.service.undoTask(request)
      expect(await s.service.undoTask(request)).toEqual({ restored: 0 })
      for (const post of posts) expect(s.state(post)).toEqual(s.original(`post:${post}`))
      expect(
        restoreWrites(s)
          .map(([input]) => input.objectRef)
          .sort(),
      ).toEqual(posts.map((post) => `post:${post}`).sort())
      const calls = await hostCalls()
      expect(calls.filter((call) => call.result === 'ok')).toHaveLength(posts.length)
      expect(calls.filter((call) => call.writeStartedAt !== null)).toHaveLength(posts.length)
      expect(calls.every((call) => call.result !== null)).toBe(true)
      expect(
        await db.mcpCall.count({ where: { turnId: turn.turnId, revertedAt: { not: null } } }),
      ).toBe(posts.length)
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
      expect(await leases.release(undo.fence)).toBe(true)
    }, 60_000)

    it('waits for a write of the agent, and the site agrees with the journal after a race', async () => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      await s.edit(turn.scope, 'B')
      // The write of the agent is admitted and not confirmed yet.
      const admitted = await s.journal.reserve(turn.scope, {
        tool: 'wp_rest',
        objectRef: 'post:42',
        idempotencyKey: 'agent-in-flight',
        arguments: { title: 'C' },
      })
      if (admitted.kind !== 'claimed') throw new Error('Expected a reservation of the agent')
      await s.journal.attachSnapshot(
        turn.scope,
        admitted.callId,
        await s.snapshots.save(admitted.snapshot, Buffer.from('before')),
      )
      expect(await s.journal.beginWrite(turn.scope, admitted.callId)).toBe(true)
      await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      await expect(
        s.service.undoTask({ fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'CONTENT_RESTORE_FAILED' })
      expect(await hostCalls()).toHaveLength(0)
      expect(writes(s)).toHaveLength(1)
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: admitted.callId })
      // The site refused it: the agent closes its call, and the lease is clean again.
      await s.journal.finish(turn.scope, admitted.callId, {
        result: 'error',
        response: { code: 'CONTENT_WRITE_REJECTED' },
      })

      // Edits of the agent and undos of the host started together, the key alive: whoever
      // came second was refused, and for every object the site holds the state of its last
      // edit that is not returned — or what was there before the turn.
      for (const round of [0, 1, 2]) {
        const base = 100 + round * 3
        await s.edit(turn.scope, `seed-${base}`, base)
        await s.edit(turn.scope, `seed-${base + 1}`, base + 1)
        const race = await Promise.allSettled([
          s.service.undoTurn({ fence, turn: 1 }),
          s.edit(turn.scope, `late-${base}`, base),
          s.edit(turn.scope, `late-${base + 2}`, base + 2),
          s.service.undoTask({ fence, targetTaskId: fixture.taskId }),
        ])
        for (const result of race)
          if (result.status === 'rejected')
            expect(['CONFLICT', 'CONTENT_RESTORE_FAILED', 'MCP_CALL_IN_FLIGHT']).toContain(
              (result.reason as { code?: string }).code,
            )
        expect(
          await db.mcpCall.count({
            where: { result: null, turn: { taskId: fixture.taskId } },
          }),
        ).toBe(0)
        expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
        for (const post of [42, base, base + 1, base + 2]) {
          const last = await db.mcpCall.findFirst({
            where: {
              objectRef: `post:${post}`,
              restoresSnapshotId: null,
              result: 'ok',
              revertedAt: null,
              turn: { taskId: fixture.taskId },
            },
            orderBy: { journalNo: 'desc' },
          })
          expect(s.state(post).stateHash).toBe(
            last?.appliedStateHash ?? s.original(`post:${post}`).stateHash,
          )
        }
      }
      // Every write the site saw was admitted once: as many as the journal started.
      expect(writes(s)).toHaveLength(
        (await db.mcpCall.count({
          where: { writeStartedAt: { not: null }, turn: { taskId: fixture.taskId } },
        })) - 1,
      )
    }, 60_000)

    it('goes on after the role died in a preparation, with one write on the site', async () => {
      const { s, snapshots } = await finished()
      const undo = await undoTaskLease()
      const request = { fence: undo.fence, targetTaskId: fixture.taskId }
      const scope = await s.journal.hostScope(undo.fence, fixture.taskId)
      const command = restoreCommand(snapshots[0]!)
      const old = (callId: string) =>
        db.mcpCall.update({
          where: { id: callId },
          data: { createdAt: new Date(Date.now() - 120_000) },
        })

      // Died right after the reservation: nothing but a journal row.
      const first = await s.journal.reserve(scope, command, snapshots[0]!)
      if (first.kind !== 'claimed') throw new Error('Expected a reservation of the host')
      // The same lease, at once: that preparation may still be alive, nothing is taken from it.
      await expect(s.service.undoTask(request)).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      expect(await db.mcpCall.findUniqueOrThrow({ where: { id: first.callId } })).toMatchObject({
        result: null,
      })
      // No preparation lasts that long. The next reservation closes it; this one dies too,
      // with its snapshot acknowledged and only the admission of the write left.
      await old(first.callId)
      const second = await s.journal.reserve(scope, command, snapshots[0]!)
      if (second.kind !== 'claimed') throw new Error('Expected a second reservation of the host')
      expect(second.callId).not.toBe(first.callId)
      await s.journal.attachSnapshot(
        scope,
        second.callId,
        await s.snapshots.save(second.snapshot, Buffer.from('before')),
      )
      await expect(s.service.undoTask(request)).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      expect(restoreWrites(s)).toHaveLength(0)

      await old(second.callId)
      expect(await s.service.undoTask(request)).toEqual({ restored: 1 })
      expect(s.state()).toEqual(s.original('post:42'))
      expect(restoreWrites(s)).toHaveLength(1)
      // A request of a dead preparation that is only late finds its call closed.
      expect(await s.journal.beginWrite(scope, second.callId)).toBe(false)
      await expect(
        s.journal.attachSnapshot(
          scope,
          first.callId,
          await s.snapshots.save(first.snapshot, Buffer.from('before')),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const calls = await hostCalls()
      expect(calls.map((call) => [call.result, call.writeStartedAt !== null])).toEqual([
        ['error', false],
        ['error', false],
        ['ok', true],
      ])
      // Each attempt is a call of its own: the ordinal of the closed ones is in the key.
      expect(calls.map((call) => call.idempotencyKey)).toEqual(
        [0, 1, 2].map((attempt) =>
          hash(JSON.stringify(['host', fixture.taskId, 1, snapshots[0], attempt])),
        ),
      )
      expect(restoreWrites(s)).toHaveLength(1)
      expect(await leases.release(undo.fence)).toBe(true)
    })

    it('holds the site after a write nobody confirmed: never dispatched, the site proves it later', async () => {
      const { s } = await finished()
      const undo = await undoTaskLease()
      const request = { fence: undo.fence, targetTaskId: fixture.taskId }
      // The journal admitted the write and went away before the request left the role.
      vi.spyOn(s.journal, 'writeIntent').mockRejectedValueOnce(outage())
      vi.spyOn(s.journal, 'markAmbiguous').mockRejectedValueOnce(outage())
      await expect(s.service.undoTask(request)).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      const [call] = await hostCalls()
      expect(call).toMatchObject({ result: null })
      expect(call!.writeStartedAt).not.toBeNull()
      // No hold was recorded, and the barrier alone keeps the site: not released, not freed,
      // not taken by anybody — also after the lease has expired.
      expect(await leaseRow()).toMatchObject({
        inflightMcpCallId: call!.id,
        heldForOperator: false,
      })
      expect(await leases.release(undo.fence)).toBe(false)
      expect(await leases.free(undo.fence)).toBe(false)
      await setLease({ expiresAt: new Date(Date.now() - 1000) })
      for (const operation of ['turn', 'revert'] as const)
        expect(
          await leases.acquire({
            siteId: fixture.siteId,
            taskId: fixture.taskId,
            operation,
            ttlMs: 60_000,
          }),
        ).toBeNull()
      await setLease({ expiresAt: new Date(Date.now() + 600_000) })
      // A repeat sends nothing while the outcome is unknown.
      await expect(s.service.undoTask(request)).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      expect(await hostCalls()).toHaveLength(1)
      expect(restoreWrites(s)).toHaveLength(0)

      // Past the deadline the site knows nothing of the call: unknown, held for the operator.
      await pastDeadline(call!.id)
      expect(await s.maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
        visited: 1,
        unknown: 1,
      })
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: call!.id, heldForOperator: true })
      await expect(s.service.undoTask(request)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      // The site proves that the write can no longer commit: the call is closed without it.
      vi.mocked(s.gateway.reconcileOperation).mockImplementationOnce(async (input) => ({
        version: 1,
        kind: 'not_committed',
        callId: input.callId,
        siteId: input.siteId,
        epoch: input.epoch,
        requestHash: input.requestHash,
        objectRef: input.objectRef,
        deadlineAt: input.deadlineAt,
      }))
      expect(await s.maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
        visited: 1,
        notCommitted: 1,
      })
      // The barrier is gone, the hold is the operator's to lift.
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: true })
      await expect(s.service.undoTask(request)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(s.state().title).toBe('edit-42')
      await setLease({ heldForOperator: false })
      // The repeat is a new call, and the only restore the site ever saw.
      expect(await s.service.undoTask(request)).toEqual({ restored: 1 })
      expect(s.state()).toEqual(s.original('post:42'))
      expect(restoreWrites(s)).toHaveLength(1)
      expect((await hostCalls()).map((row) => [row.result, row.response])).toEqual([
        ['error', { code: 'CONTENT_WRITE_NOT_COMMITTED' }],
        ['ok', expect.objectContaining({ restored: true })],
      ])
    })

    it('does not write again what the site committed before the journal lost its answer', async () => {
      const { s, turn } = await finished()
      const undo = await undoTaskLease()
      const request = { fence: undo.fence, targetTaskId: fixture.taskId }
      // The site committed the restore; the role could record neither the result nor a hold.
      vi.spyOn(s.journal, 'finish').mockRejectedValueOnce(outage())
      vi.spyOn(s.journal, 'markAmbiguous').mockRejectedValueOnce(outage())
      await expect(s.service.undoTask(request)).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      expect(s.state()).toEqual(s.original('post:42'))
      const [call] = await hostCalls()
      expect(call).toMatchObject({ result: null })
      expect(await leaseRow()).toMatchObject({
        inflightMcpCallId: call!.id,
        heldForOperator: false,
      })
      // The edit is not marked returned yet, and still no repeat sends a second restore.
      expect(
        await db.mcpCall.count({ where: { turnId: turn.turnId, revertedAt: { not: null } } }),
      ).toBe(0)
      for (let repeat = 0; repeat < 2; repeat++)
        await expect(s.service.undoTask(request)).rejects.toMatchObject({
          code: 'CONTENT_RESTORE_FAILED',
        })
      expect(restoreWrites(s)).toHaveLength(1)
      expect(await leases.release(undo.fence)).toBe(false)

      await pastDeadline(call!.id)
      expect(await s.maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
        visited: 1,
        completed: 1,
      })
      expect(
        await db.mcpCall.count({ where: { turnId: turn.turnId, revertedAt: { not: null } } }),
      ).toBe(1)
      expect(await s.service.undoTask(request)).toEqual({ restored: 0 })
      expect(restoreWrites(s)).toHaveLength(1)
      expect(await hostCalls()).toHaveLength(1)
      // Nothing was ever unknown to the operator: the site goes back to its holder.
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
      expect(await leases.release(undo.fence)).toBe(true)
    })

    it('keeps what it returned when an external edit stops it, and returns nothing twice', async () => {
      const { s, turn } = await finished([1, 2, 3])
      const undo = await undoTaskLease()
      const request = { fence: undo.fence, targetTaskId: fixture.taskId }
      // Somebody edited the second object by hand after the task.
      s.drift(2)
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(s.service.undoTask(request)).rejects.toMatchObject({ code: 'CONFLICT' })
        // The newest edit came back on the first call and stays back; the conflict is left as
        // it is, and the older edit behind it is not reached over it.
        expect(s.state(3)).toEqual(s.original('post:3'))
        expect(s.state(2)).toMatchObject({ title: 'edit-2', content: '<p>Правка человека</p>' })
        expect(s.state(1).title).toBe('edit-1')
        expect(restoreWrites(s).map(([input]) => input.objectRef)).toEqual(['post:3'])
      }
      expect(
        (
          await db.mcpCall.findMany({
            where: { turnId: turn.turnId, tool: 'wp_rest' },
            orderBy: { journalNo: 'asc' },
          })
        ).map((call) => call.revertedAt !== null),
      ).toEqual([false, false, true])
      const calls = await hostCalls()
      expect(
        calls.map((call) => [call.objectRef, call.result, call.writeStartedAt !== null]),
      ).toEqual([
        ['post:3', 'ok', true],
        ['post:2', 'error', false],
        ['post:2', 'error', false],
        ['post:2', 'error', false],
      ])
      // A refused attempt leaves a journal row and a snapshot row with no object behind it:
      // the store holds the three edits and the one restore that was sent.
      expect(s.memory.objects.size).toBe(4)
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
      expect(await leases.release(undo.fence)).toBe(true)

      // Those rows do not outlive the task: the sweep of the undo window takes them all, and
      // the contact maps of the task wait for nothing else.
      await db.task.updateMany({
        where: { workspaceId: fixture.workspaceId },
        data: { status: 'done', finishedAt: new Date(Date.now() - 8 * 86_400_000) },
      })
      await db.snapshot.updateMany({
        where: { siteId: fixture.siteId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      await db.mcpCall.updateMany({
        where: { turnId: turn.turnId, writeStartedAt: { not: null } },
        data: {
          writeStartedAt: new Date(Date.now() - 30_000),
          writeDeadlineAt: new Date(Date.now() - 15_000),
        },
      })
      expect(await s.maintenance().sweepSnapshots({ siteId: fixture.siteId })).toMatchObject({
        visited: 7,
        purged: 7,
        failed: 0,
      })
      expect(s.memory.objects.size).toBe(0)
      expect(await s.maintenance().sweepMasks({ siteId: fixture.siteId })).toMatchObject({
        purged: 1,
        failed: 0,
      })
      // The undo window is over for good: a new «Отменить» is refused at the door.
      const late = await undoTaskLease()
      await expect(
        s.service.undoTask({ fence: late.fence, targetTaskId: fixture.taskId }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(restoreWrites(s)).toHaveLength(1)
    })

    it('keeps a turn lease held while a restore of the host is unknown, and after it for an open turn', async () => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      await s.edit(turn.scope, 'B')
      await s.edit(turn.scope, 'other', 7)
      await stopKey(turn.keyId)
      const assignments = new PostgresTurnAssignmentStore(db)
      // The site committed the restore of the newest edit, and its answer was lost.
      s.faults.loseAcknowledgement = true
      await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'CONTENT_RESTORE_FAILED',
      })
      s.faults.loseAcknowledgement = false
      const held = await leaseRow()
      expect(held).toMatchObject({ operation: 'turn', heldForOperator: true })
      expect(held.inflightMcpCallId).not.toBeNull()
      // Not the holder, not anybody else, not the recovery of turns: the write is unknown.
      expect(await assignments.freeOrphanedHolds()).toBe(0)
      expect(await leases.release(fence)).toBe(false)
      expect(await leases.free(fence)).toBe(false)
      await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
        code: 'LEASE_LOST',
      })
      // Maintenance finds the receipt of the site: the restore is recorded, the hold stays.
      await pastDeadline(held.inflightMcpCallId!)
      expect(await s.maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
        visited: 1,
        completed: 1,
      })
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: true })
      // The undo is not over — the older edit is still on the site — and while the turn is
      // open the recovery of turns leaves the site to the operator.
      expect(s.state(7)).toEqual(s.original('post:7'))
      expect(s.state().title).toBe('B')
      expect(await assignments.freeOrphanedHolds()).toBe(0)
      expect(await leaseRow()).toMatchObject({
        holderTaskId: fixture.taskId,
        heldForOperator: true,
      })

      // What the next increment must not do: close the turn before its undo is complete. The
      // recovery of turns then frees the site, with the edit of a failed turn on it.
      await closeTurn(turn, 1, 'failed')
      expect(await assignments.freeOrphanedHolds()).toBe(1)
      expect(await leaseRow()).toMatchObject({ holderTaskId: null, heldForOperator: false })
      expect(s.state().title).toBe('B')
      expect(restoreWrites(s)).toHaveLength(1)
    })

    it('does not reach over an edit of a later turn: one turn stops there, the task returns both', async () => {
      const s = site()
      const fence = await turnLease()
      const first = await openTurn(fence, 1)
      await s.edit(first.scope, 'turn-1')
      await s.edit(first.scope, 'turn-1-other', 7)
      await closeTurn(first, 1, 'completed')
      const second = await openTurn(fence, 2)
      await s.edit(second.scope, 'turn-2')
      await stopKey(second.keyId)
      // Turn 1 alone: its newest edit comes back; the older one stands under the edit of
      // turn 2, which this call may not touch. The refusal is the journal's own: no call is
      // written for it and nothing is sent to the site.
      for (let repeat = 0; repeat < 2; repeat++)
        await expect(s.service.undoTurn({ fence, turn: 1 })).rejects.toMatchObject({
          code: 'CONFLICT',
        })
      expect(s.state(7)).toEqual(s.original('post:7'))
      expect(s.state().title).toBe('turn-2')
      expect((await hostCalls()).map((call) => [call.objectRef, call.result])).toEqual([
        ['post:7', 'ok'],
      ])
      expect(restoreWrites(s)).toHaveLength(1)
      // The task as a whole goes newest first across its turns.
      expect(await s.service.undoTask({ fence, targetTaskId: fixture.taskId })).toEqual({
        restored: 2,
      })
      expect(s.state()).toEqual(s.original('post:42'))
      expect(restoreWrites(s).map(([input]) => input.objectRef)).toEqual([
        'post:7',
        'post:42',
        'post:42',
      ])
    })

    it('closes a preparation of a live agent when the recovery of the role names that call', async () => {
      const s = site()
      const fence = await turnLease()
      const turn = await openTurn(fence, 1)
      await s.edit(turn.scope, 'B')
      const capture = await s.journal.reserve(turn.scope, {
        tool: 'wp_rest',
        objectRef: 'post:5',
        idempotencyKey: 'agent-capture',
        arguments: { title: 'Не дописано' },
      })
      if (capture.kind !== 'claimed') throw new Error('Expected a reservation of the agent')
      const receipt = await s.snapshots.save(capture.snapshot, Buffer.from('before'))
      // The undo leaves a live agent alone (the first review's test). The recovery of the
      // role is another matter: asked for this very call under the turn lease, it closes a
      // preparation though the key is alive. Nothing was dispatched, and nothing will be.
      const scope = await s.journal.hostScope(fence, fixture.taskId)
      expect(await s.service.recoverWrite(scope, capture.callId)).toBe('not_committed')
      expect(await db.mcpCall.findUniqueOrThrow({ where: { id: capture.callId } })).toMatchObject({
        result: 'error',
        response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
        writeStartedAt: null,
      })
      await expect(
        s.journal.attachSnapshot(turn.scope, capture.callId, receipt),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await s.journal.beginWrite(turn.scope, capture.callId)).toBe(false)
      expect(await leaseRow()).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
      // The agent is not locked out: with a new key of its own it edits on.
      expect((await s.edit(turn.scope, 'C', 5)).result).toBe('ok')
      expect(writes(s)).toHaveLength(2)
      expect(await hostCalls()).toHaveLength(0)
    })

    it('answers a repeat under another fence from the journal, and writes for no other holder', async () => {
      const { s, snapshots } = await finished()
      const first = await undoTaskLease()
      expect(
        await s.service.undoTask({ fence: first.fence, targetTaskId: fixture.taskId }),
      ).toEqual({ restored: 1 })
      const [call] = await hostCalls()
      // The key: the target task, the turn of the edit, its snapshot and the attempt. Nothing
      // of the fence is in it — not the holder, not the operation, not the epoch.
      expect(call!.idempotencyKey).toBe(
        hash(JSON.stringify(['host', fixture.taskId, 1, snapshots[0], 0])),
      )
      expect(await leases.release(first.fence)).toBe(true)
      const command = restoreCommand(snapshots[0]!)

      // The same undo task takes the site again: another epoch of the same holder.
      const again = await leases.acquire({
        siteId: fixture.siteId,
        taskId: first.undoTaskId,
        operation: 'revert',
        ttlMs: 60_000,
      })
      const second = { ...first.fence, epoch: again!.epoch }
      expect(second.epoch).toBe(first.fence.epoch + 1)
      expect(await s.service.undoTask({ fence: second, targetTaskId: fixture.taskId })).toEqual({
        restored: 0,
      })
      // Asked for the very restore, the journal answers with the one that was made.
      expect(
        await s.journal.reserve(
          await s.journal.hostScope(second, fixture.taskId),
          command,
          snapshots[0]!,
        ),
      ).toMatchObject({ kind: 'replay', callId: call!.id, completion: { result: 'ok' } })
      expect(await leases.release(second)).toBe(true)

      // Another holder: a second undo task, and the turn lease of the task itself.
      for (const take of [async () => (await undoTaskLease()).fence, () => turnLease()]) {
        const fence: SiteLeaseFence = await take()
        expect(await s.service.undoTask({ fence, targetTaskId: fixture.taskId })).toEqual({
          restored: 0,
        })
        // Not its call: refused, and nothing is reserved in its place.
        await expect(
          s.journal.reserve(
            await s.journal.hostScope(fence, fixture.taskId),
            command,
            snapshots[0]!,
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(await leases.release(fence)).toBe(true)
      }
      expect(await hostCalls()).toHaveLength(1)
      expect(restoreWrites(s)).toHaveLength(1)
      expect(s.state()).toEqual(s.original('post:42'))
    })
  })
})
