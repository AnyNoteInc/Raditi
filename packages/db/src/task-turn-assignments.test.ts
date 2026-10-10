import { randomUUID } from 'node:crypto'

import type { OpenTurnAssignment, TurnAssignmentStore, TurnPlan } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { PostgresSiteLeaseStore } from './site-leases.ts'
import { PostgresTaskTurnAssignmentStore } from './task-turn-assignments.ts'

const databaseUrl = process.env.DATABASE_URL
const image = `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`
const baseSha = 'b'.repeat(40)
const headSha = 'c'.repeat(40)

describe.skipIf(!databaseUrl)('PostgreSQL product task turns', () => {
  let schema: MigratedSchema
  let db: PrismaClient
  let store: PostgresTaskTurnAssignmentStore
  const workspaces: string[] = []
  beforeAll(async () => {
    // A product turn needs the `opencode` row of agent_drivers. In a schema of its own the test
    // neither depends on the seeds of the database it was given nor leaves that row in it.
    schema = await createMigratedSchema(databaseUrl ?? '', 'product_turns')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
    store = new PostgresTaskTurnAssignmentStore(db)
    await db.agentDriver.upsert({
      where: { id: 'opencode' },
      update: {},
      create: {
        id: 'opencode',
        image,
        capabilities: {},
        enabled: true,
      },
    })
  }, 60_000)
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.siteLease.deleteMany({ where: { site: { workspaceId } } })
      await db.mcpCall.deleteMany({ where: { turn: { task: { workspaceId } } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  async function fixture() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic product turn' } })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Synthetic',
        url: 'https://turn.example.test',
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({ data: { workspaceId: workspace.id, siteId: site.id } })
    const sessionId = randomUUID()
    const leases = new PostgresSiteLeaseStore(db)
    const fence = (await leases.acquire({
      siteId: site.id,
      taskId: task.id,
      operation: 'turn',
      ttlMs: 60_000,
    }))!
    const plan: TurnPlan = {
      sandbox: {
        image,
        labels: { workspaceId: workspace.id, siteId: site.id, taskId: task.id, sessionId, turn: 1 },
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
      driverId: 'opencode',
      driverVersion: '1.0.0',
      workspace: {
        repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
        branch: `agent/${task.id}`,
        expectedBaseSha: baseSha,
        protectedPaths: [],
      },
      committedAt: '2026-10-01T00:00:00.000Z',
    }
    const input: OpenTurnAssignment = {
      fence,
      sessionId,
      turn: 1,
      executor: 'local',
      plan,
      remainingMs: 30_000,
    }
    const next = (
      turn: number,
      replacesTurn?: number,
      expectedBranchSha: string | null = null,
    ): OpenTurnAssignment => ({
      ...input,
      turn,
      plan: {
        ...plan,
        ...(replacesTurn ? { replacesTurn } : {}),
        workspace: { ...plan.workspace, ...(replacesTurn ? { expectedBranchSha } : {}) },
        sandbox: { ...plan.sandbox, labels: { ...plan.sandbox.labels, turn } },
        context: { ...plan.context, turn },
      },
    })
    return { task, site, input, plan, next, leases, fence }
  }

  it('atomically admits one running TaskTurn and never reuses its number', async () => {
    const f = await fixture()
    const contenders = await Promise.all([store.open(f.input), store.open(f.input)])
    const assignment = contenders.find(Boolean)!
    expect(contenders.filter(Boolean)).toHaveLength(1)
    expect(await db.taskTurn.findMany({ where: { taskId: f.task.id } })).toEqual([
      expect.objectContaining({
        turnNo: 1,
        status: 'running',
        driverId: 'opencode',
        driverVersion: '1.0.0',
        image,
        baseSha,
        startedAt: expect.any(Date),
        finishedAt: null,
      }),
    ])
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).turnNo).toBe(1)
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(true)
    expect(await store.open(f.input)).toBeNull()
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'completed' })).toBe(false)
    expect((await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).status).toBe(
      'failed',
    )
  })

  it('refuses a retired content context even after the task is requeued', async () => {
    const f = await fixture()
    await db.task.update({ where: { id: f.task.id }, data: { contentRetiredAt: new Date() } })
    await expect(store.open(f.input)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await db.turnAssignment.count({ where: { taskId: f.task.id } })).toBe(0)
    expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(0)
  })

  it('rolls assignment creation back when TaskTurn persistence fails', async () => {
    const f = await fixture()
    // A pre-existing product row must never leave an orphan assignment after its uniqueness failure.
    await db.taskTurn.create({
      data: { taskId: f.task.id, turnNo: 1, driverId: 'opencode', image },
    })
    await expect(store.open(f.input)).rejects.toThrow()
    expect(await db.turnAssignment.count({ where: { taskId: f.task.id } })).toBe(0)
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).turnNo).toBe(0)
  })

  it('refuses foreign identity and skipped turn numbers without creating either row', async () => {
    const f = await fixture()
    const foreign = {
      ...f.plan,
      sandbox: {
        ...f.plan.sandbox,
        labels: { ...f.plan.sandbox.labels, workspaceId: randomUUID() },
      },
    }
    await expect(store.open({ ...f.input, plan: foreign })).rejects.toThrow('not available')
    await expect(store.open({ ...f.input, turn: 2 })).rejects.toThrow('identity')
    expect(await store.open(f.next(2))).toBeNull()
    expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(0)
    expect(await db.turnAssignment.count({ where: { taskId: f.task.id } })).toBe(0)
  })

  it('requires the completed output for continuation and the input for replacement', async () => {
    const f = await fixture()
    const first = (await store.open(f.input))!
    await db.taskTurn.updateMany({ where: { taskId: f.task.id }, data: { headSha } })
    await store.finish({ id: first.id, epoch: 1, outcome: 'completed' })
    await expect(store.open(f.next(2))).rejects.toThrow('completed product turn')
    await expect(store.open(f.next(2, 1))).rejects.toThrow('published task branch')
    const wrong = f.next(2, 1, headSha)
    wrong.plan.workspace = { ...wrong.plan.workspace, expectedBaseSha: headSha }
    await expect(store.open(wrong)).rejects.toThrow('replaced turn input')
    const second = await store.open(f.next(2, 1, headSha))
    expect(second?.plan.replacesTurn).toBe(1)
    await store.finish({ id: second!.id, epoch: 1, outcome: 'failed' })
    expect((await store.open(f.next(3, 2, headSha)))?.plan.replacesTurn).toBe(2)
  })

  it('requires an explicit replacement after failure and blocks a still assigned predecessor', async () => {
    const f = await fixture()
    const first = (await store.open(f.input))!
    expect(await store.open(f.next(2, 1))).toBeNull()
    await store.finish({ id: first.id, epoch: 1, outcome: 'lost' })
    await expect(store.open(f.next(2))).rejects.toThrow('must be replaced')
    expect(await store.open(f.next(2, 1))).not.toBeNull()
  })

  it('does not let a stale owner project a terminal status after takeover', async () => {
    const f = await fixture()
    const first = (await store.open(f.input))!
    await f.leases.holdForRecovery(f.fence)
    const taken = (await store.takeOver({ id: first.id, fence: f.fence, ttlMs: 60_000 }))!
    expect(await store.finish({ id: first.id, epoch: 1, outcome: 'failed' })).toBe(false)
    expect((await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).status).toBe(
      'running',
    )
    expect(await store.finish({ id: first.id, epoch: taken.grant.epoch, outcome: 'lost' })).toBe(
      true,
    )
    expect(await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).toMatchObject({
      status: 'lost',
      finishedAt: expect.any(Date),
    })
  })

  it.each(['timeout', 'cancelled'] as const)(
    'projects the fixed %s reason without exposing CLI text',
    async (reason) => {
      const f = await fixture()
      const assignment = (await store.open(f.input))!
      await db.taskEvent.create({
        data: {
          taskId: f.task.id,
          type: 'turn.lifecycle',
          payload: {
            fence: { siteId: f.site.id, taskId: f.task.id, operation: 'turn', epoch: 1 },
            sessionId: f.input.sessionId,
            turn: 1,
            sequence: 1,
            phase: 'failed',
            reason,
          },
        },
      })
      await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })
      expect(await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).toMatchObject({
        status: reason === 'timeout' ? 'timed_out' : 'cancelled',
        failureReason: reason,
      })
    },
  )

  it('closes an unclaimed runner and its product turn together', async () => {
    const f = await fixture()
    const assignment = (await store.open({ ...f.input, executor: 'runner' }))!
    expect(await store.abandon(assignment.id)).toBe(true)
    expect(await store.abandon(assignment.id, 'lost')).toBe(false)
    expect((await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).status).toBe(
      'failed',
    )
  })

  const reasons = [
    ['timeout', 'timed_out'],
    ['cancelled', 'cancelled'],
  ] as const

  it.each(reasons)(
    'closes an unclaimed runner turn with the %s reason its caller gives',
    async (reason, status) => {
      const f = await fixture()
      const assignment = (await store.open({ ...f.input, executor: 'runner' }))!
      // Callers know the port, not this adapter: the reason is part of its contract.
      const port: TurnAssignmentStore = store
      expect(await port.abandon(assignment.id, 'failed', reason)).toBe(true)
      expect(await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).toMatchObject({
        status,
        failureReason: reason,
        finishedAt: expect.any(Date),
      })
      expect((await store.get(assignment.id))!.outcome).toBe('failed')
    },
  )

  it('rejects a reason outside the fixed list before closing anything', async () => {
    const f = await fixture()
    const assignment = (await store.open({ ...f.input, executor: 'runner' }))!
    await expect(
      store.abandon(assignment.id, 'failed', 'Raw CLI text' as 'cancelled'),
    ).rejects.toThrow()
    expect((await store.get(assignment.id))!.outcome).toBeNull()
  })

  it.each(reasons)(
    'brings a %s journaled after the abandon to the closed turn, once',
    async (reason, status) => {
      const f = await fixture()
      const assignment = (await store.open({ ...f.input, executor: 'runner' }))!
      // The order of a turn cancelled while it waits for a runner: the hub abandons it, its
      // owner then journals why and finishes an assignment that is already closed.
      expect(await store.abandon(assignment.id)).toBe(true)
      const closed = await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })
      expect(closed).toMatchObject({ status: 'failed', failureReason: 'failed' })
      const journal = (entry: string) =>
        db.taskEvent.create({
          data: {
            taskId: f.task.id,
            type: 'turn.lifecycle',
            payload: {
              fence: { siteId: f.site.id, taskId: f.task.id, operation: 'turn', epoch: 1 },
              sessionId: f.input.sessionId,
              turn: 1,
              sequence: 2,
              phase: 'failed',
              reason: entry,
              outcome: 'failed',
            },
          },
        })
      await journal(reason)
      expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(false)
      expect(await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).toMatchObject({
        status,
        failureReason: reason,
        finishedAt: closed.finishedAt,
      })
      // A later entry or a stale owner never rewrites the recorded reason.
      await journal('run_failed')
      expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(false)
      expect(await store.finish({ id: assignment.id, epoch: 2, outcome: 'failed' })).toBe(false)
      expect(await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).toMatchObject({
        status,
        failureReason: reason,
      })
    },
  )

  it.each([
    ['local', false],
    ['claimed runner', true],
  ] as const)('leaves a %s turn that finished by itself as it was closed', async (_, runner) => {
    const f = await fixture()
    const assignment = (await store.open({ ...f.input, executor: runner ? 'runner' : 'local' }))!
    if (runner) {
      const claim = { runnerId: 'vm1', runnerSession: randomUUID(), limit: 1 }
      expect(await store.claim({ ids: [assignment.id], ...claim })).toHaveLength(1)
    }
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(true)
    await db.taskEvent.create({
      data: {
        taskId: f.task.id,
        type: 'turn.lifecycle',
        payload: {
          fence: { siteId: f.site.id, taskId: f.task.id, operation: 'turn', epoch: 1 },
          sessionId: f.input.sessionId,
          turn: 1,
          sequence: 2,
          phase: 'failed',
          reason: 'cancelled',
        },
      },
    })
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(false)
    expect(await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })).toMatchObject({
      status: 'failed',
      failureReason: 'failed',
    })
  })

  it('leaves a product turn assigned while an external writer holds its site', async () => {
    const f = await fixture()
    const assignment = (await store.open(f.input))!
    const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: f.task.id } })
    const call = await db.mcpCall.create({
      data: { turnId: turn.id, tool: 'synthetic', idempotencyKey: randomUUID() },
    })
    await db.siteLease.update({
      where: { siteId: f.site.id },
      data: { inflightMcpCallId: call.id, heldForOperator: true },
    })
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })).toBe(false)
    expect((await store.get(assignment.id))!.outcome).toBeNull()
    expect((await db.taskTurn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe('running')
    await db.siteLease.update({ where: { siteId: f.site.id }, data: { inflightMcpCallId: null } })
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'lost' })).toBe(false)
    expect(await f.leases.free(f.fence)).toBe(true)
    expect(await store.finish({ id: assignment.id, epoch: 1, outcome: 'lost' })).toBe(true)
  })
})
