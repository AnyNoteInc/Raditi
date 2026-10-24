import { randomUUID } from 'node:crypto'

import {
  BROWSER_ONLY,
  REPOSITORY_ONLY,
  type OpenTurnAssignment,
  type TaskRequirements,
  type TurnAssignmentStore,
  type TurnPlan,
} from '@repo/domain'
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
const home = {
  root: '/agent-home/opencode',
  include: ['.local/share/opencode/opencode.db'],
  exclude: [],
}

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

  /** A task and the plan of its first turn; with `requirements` both are made for them. */
  async function fixture(requirements?: TaskRequirements) {
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
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        ...(requirements
          ? { needsRepository: requirements.repository, needsBrowser: requirements.browser }
          : {}),
      },
    })
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
      ...(requirements ? { requirements } : {}),
      ...(requirements?.repository === false
        ? {}
        : {
            workspace: {
              repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
              branch: `agent/${task.id}`,
              expectedBaseSha: baseSha,
              protectedPaths: [],
            },
          }),
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
        ...(plan.workspace
          ? { workspace: { ...plan.workspace, ...(replacesTurn ? { expectedBranchSha } : {}) } }
          : {}),
        sandbox: { ...plan.sandbox, labels: { ...plan.sandbox.labels, turn } },
        context: { ...plan.context, turn },
      },
    })
    /**
     * A later turn as the planner builds it (plan 53, R3): a continuation names the checkpoint
     * of turn `previous`, a rebased start or replacement names none. A turn without a
     * repository has no base.
     */
    const step = (
      turn: number,
      options: { base?: string; previous?: number; rebased?: true; pin?: string | null },
    ): OpenTurnAssignment => {
      const opened = options.pin === undefined ? next(turn) : next(turn, turn - 1, options.pin)
      const previous = options.previous
      opened.plan = {
        ...opened.plan,
        ...(previous === undefined
          ? {}
          : {
              previous: {
                workspaceId: workspace.id,
                sessionId,
                turn: previous,
                image,
                driver: { id: 'opencode' as const, version: '1.0.0' },
                home,
              },
            }),
        ...(options.rebased ? { rebased: true } : {}),
        ...(opened.plan.workspace && options.base
          ? { workspace: { ...opened.plan.workspace, expectedBaseSha: options.base } }
          : {}),
      }
      return opened
    }
    /** Closes a turn; a completed one published `head`. */
    const close = async (
      assignment: { id: string; turn: number },
      outcome: 'completed' | 'failed',
      head?: string,
    ) => {
      if (head)
        await db.taskTurn.updateMany({
          where: { taskId: task.id, turnNo: assignment.turn },
          data: { headSha: head },
        })
      expect(await store.finish({ id: assignment.id, epoch: 1, outcome })).toBe(true)
    }
    let revision = 0
    /** The standing candidate of the dialog; «Обновить» records its head under the task's turn. */
    const candidate = async (turnNo: number, head: string) => {
      await db.taskCandidate.updateMany({
        where: { taskId: task.id, status: 'current' },
        data: { status: 'superseded', supersededAt: new Date() },
      })
      await db.taskCandidate.create({
        data: {
          taskId: task.id,
          revision: ++revision,
          turnNo,
          baseSha,
          baseTree: 'd'.repeat(40),
          headSha: head,
          dbPlanSha256: '0'.repeat(64),
          proposedBump: 'minor',
          proposedVersion: 'v0.1.0',
          facts: {},
        },
      })
    }
    return { task, site, input, plan, next, leases, fence, step, close, candidate }
  }

  describe('after «Обновить» moved the candidate (plan 53, Р27)', () => {
    const moved = 'e'.repeat(40)
    const movedAgain = 'f'.repeat(40)

    it('continues a completed turn while the candidate stands on its head', async () => {
      const f = await fixture()
      await f.close((await store.open(f.input))!, 'completed', headSha)
      await f.candidate(1, headSha)
      await expect(store.open(f.step(2, { base: headSha, rebased: true }))).rejects.toThrow(
        'does not start on the candidate',
      )
      expect(await store.open(f.step(2, { base: headSha, previous: 1 }))).not.toBeNull()
    })

    it('starts a new session on the moved head and refuses the continuation of the old one', async () => {
      const f = await fixture()
      await f.close((await store.open(f.input))!, 'completed', headSha)
      await f.candidate(1, headSha)
      await f.candidate(1, moved)

      await expect(store.open(f.step(2, { base: headSha, previous: 1 }))).rejects.toThrow(
        '«Обновить» moved the task branch',
      )
      for (const wrong of [
        f.step(2, { base: headSha, rebased: true }),
        f.step(2, { base: moved, rebased: true, previous: 1 }),
      ])
        await expect(store.open(wrong)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'A rebased turn does not start on the candidate «Обновить» moved',
        })
      expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(1)

      const second = (await store.open(f.step(2, { base: moved, rebased: true })))!
      expect(second.plan.rebased).toBe(true)
      expect(
        await db.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: f.task.id, turnNo: 2 } },
        }),
      ).toMatchObject({ status: 'running', baseSha: moved })

      // The new session completed without a change: the candidate stays on the moved head, and
      // the next turn continues the session that stands there.
      await f.close(second, 'completed', moved)
      expect(await store.open(f.step(3, { base: moved, previous: 2 }))).not.toBeNull()
    })

    it('replaces a failed new session with its own input, pinned on the moved head', async () => {
      const f = await fixture()
      await f.close((await store.open(f.input))!, 'completed', headSha)
      await f.candidate(1, moved)
      await f.close((await store.open(f.step(2, { base: moved, rebased: true })))!, 'failed')

      for (const [wrong, message] of [
        [f.step(3, { base: moved, rebased: true, pin: headSha }), 'pin the published task branch'],
        [f.step(3, { base: moved, pin: moved }), 'replaced turn input'],
        [f.step(3, { base: headSha, previous: 1, pin: moved }), 'replaced turn input'],
      ] as const)
        await expect(store.open(wrong)).rejects.toThrow(message)

      const third = await store.open(f.step(3, { base: moved, rebased: true, pin: moved }))
      expect(third?.plan).toMatchObject({ replacesTurn: 2, rebased: true })
    })

    it('replaces a turn that failed before the move with a new session on the moved head', async () => {
      const f = await fixture()
      await f.close((await store.open(f.input))!, 'completed', headSha)
      await f.candidate(1, headSha)
      await f.close((await store.open(f.step(2, { base: headSha, previous: 1 })))!, 'failed')
      // The dialog waited with its candidate; «Обновить» moved it under the task's turn 2.
      await f.candidate(2, moved)

      await expect(store.open(f.step(3, { base: moved, rebased: true }))).rejects.toThrow(
        'must be replaced',
      )
      await expect(
        store.open(f.step(3, { base: headSha, previous: 1, pin: headSha })),
      ).rejects.toThrow('pin the published task branch')
      // The input of the failed turn stands on the old main: publishing it would undo the move.
      for (const wrong of [
        f.step(3, { base: headSha, previous: 1, pin: moved }),
        f.step(3, { base: moved, previous: 1, pin: moved, rebased: true }),
      ])
        await expect(store.open(wrong)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'Replacement does not start on the candidate «Обновить» moved',
        })

      const third = (await store.open(f.step(3, { base: moved, rebased: true, pin: moved })))!
      expect(third.plan).toMatchObject({ replacesTurn: 2, rebased: true })
      await f.close(third, 'failed')

      // A second «Обновить» after the failed new session: the next one starts on its head.
      await f.candidate(3, movedAgain)
      await expect(
        store.open(f.step(4, { base: moved, rebased: true, pin: movedAgain })),
      ).rejects.toThrow('does not start on the candidate')
      expect(
        await store.open(f.step(4, { base: movedAgain, rebased: true, pin: movedAgain })),
      ).not.toBeNull()
    })

    it('never starts the first turn as rebased', async () => {
      const f = await fixture()
      await expect(
        store.open({ ...f.input, plan: { ...f.plan, rebased: true } }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'The first product turn has no predecessor',
      })
    })
  })

  describe('the requirements of the task (plan 57, Б2, Б3)', () => {
    it('opens turns without a repository: no base, no branch, the snapshot of a completed turn', async () => {
      const f = await fixture(BROWSER_ONLY)
      const first = (await store.open(f.input))!
      expect(first.plan.requirements).toEqual(BROWSER_ONLY)
      expect(first.plan.workspace).toBeUndefined()
      expect(
        await db.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: f.task.id, turnNo: 1 } },
        }),
      ).toMatchObject({ status: 'running', baseSha: null })
      // A completed turn without a repository published nothing: no head to look for.
      await f.close(first, 'completed')

      await expect(store.open(f.next(2))).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Continuation does not restore the completed product turn',
      })
      expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(1)

      const second = (await store.open(f.step(2, { previous: 1 })))!
      expect(second.plan.previous?.turn).toBe(1)
      expect(
        await db.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: f.task.id, turnNo: 2 } },
        }),
      ).toMatchObject({ status: 'running', baseSha: null })
      expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).turnNo).toBe(2)
    })

    it('starts a new session after an unsuccessful turn without a repository, never a replacement', async () => {
      const f = await fixture(BROWSER_ONLY)
      await f.close((await store.open(f.input))!, 'failed')

      await expect(store.open(f.step(2, { previous: 1 }))).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'A turn after an unsuccessful one starts a new session',
      })
      // What a turn without a repository did on the site is not undone: the plan has no
      // replacement to offer, and the schema refuses one.
      await expect(store.open(f.next(2, 1))).rejects.toThrow()
      expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(1)

      const second = (await store.open(f.next(2)))!
      expect(second.plan.previous).toBeUndefined()
      await f.close(second, 'completed')
      expect(await store.open(f.step(3, { previous: 2 }))).not.toBeNull()
    })

    it('refuses a plan whose requirements differ from its task, without creating a row', async () => {
      const repository = await fixture()
      const withoutRepository: TurnPlan = { ...repository.plan, requirements: BROWSER_ONLY }
      delete withoutRepository.workspace
      await expect(
        store.open({ ...repository.input, plan: withoutRepository }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The turn plan does not meet the requirements of its task',
      })

      // A plan saved before the requirements is a repository plan: refused for a browser task.
      const browser = await fixture(BROWSER_ONLY)
      const saved: TurnPlan = {
        ...repository.plan,
        sandbox: browser.plan.sandbox,
        context: browser.plan.context,
      }
      await expect(store.open({ ...browser.input, plan: saved })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The turn plan does not meet the requirements of its task',
      })
      for (const taskId of [repository.task.id, browser.task.id]) {
        expect(await db.turnAssignment.count({ where: { taskId } })).toBe(0)
        expect(await db.taskTurn.count({ where: { taskId } })).toBe(0)
      }

      // The same task takes the old plan and one that names its requirements alike.
      const named = { ...repository.plan, requirements: REPOSITORY_ONLY }
      expect(await store.open({ ...repository.input, plan: named })).not.toBeNull()
    })

    it('keeps the requirements of a task as they were written', async () => {
      const f = await fixture()
      expect(await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({
        needsRepository: true,
        needsBrowser: false,
      })
      await expect(
        db.task.update({ where: { id: f.task.id }, data: { needsBrowser: true } }),
      ).rejects.toThrow('the requirements of a task are fixed when it is created')
    })
  })

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
    wrong.plan.workspace = { ...wrong.plan.workspace!, expectedBaseSha: headSha }
    await expect(store.open(wrong)).rejects.toThrow('replaced turn input')
    const second = await store.open(f.next(2, 1, headSha))
    expect(second?.plan.replacesTurn).toBe(1)
    await store.finish({ id: second!.id, epoch: 1, outcome: 'failed' })
    expect((await store.open(f.next(3, 2, headSha)))?.plan.replacesTurn).toBe(2)
  })

  it('refuses a replacement that names any turn but the one before it, without creating a row', async () => {
    // The supervisor refuses such a plan first; the store is the second line under the undo
    // that precedes a replacement, which returns the content of the one turn the plan names.
    const f = await fixture()
    const first = (await store.open(f.input))!
    await db.taskTurn.updateMany({ where: { taskId: f.task.id }, data: { headSha } })
    await store.finish({ id: first.id, epoch: 1, outcome: 'completed' })
    const second = (await store.open(f.next(2, 1, headSha)))!
    await store.finish({ id: second.id, epoch: 1, outcome: 'failed' })
    await expect(store.open(f.next(3, 1, headSha))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Product turn identity differs from its assignment',
    })
    expect(await db.turnAssignment.count({ where: { taskId: f.task.id } })).toBe(2)
    expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(2)
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).turnNo).toBe(2)
  })

  // These three alter a saved plan, so they belong in the schema of this file: in `public` an
  // open assignment with such a plan would fail the recovery of a core that runs on the database.
  it('keeps a closed assignment of a removed driver as history and never reads it back as work', async () => {
    const f = await fixture()
    const closed = (await store.open(f.input))!
    expect(await store.finish({ id: closed.id, epoch: 1, outcome: 'completed' })).toBe(true)
    // What the removal of a shell leaves behind: the saved plan names a driver no code knows.
    await db.$executeRaw`UPDATE turn_assignments
      SET plan = jsonb_set(plan, '{driverId}', '"codex"') WHERE id = ${closed.id}::uuid`
    // Recovery lists the unfinished ones: the history row is not among them and breaks nothing.
    expect(await store.unfinished()).toEqual([])
    await expect(store.get(closed.id)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid turn assignment returned by the database',
    })
    expect(await db.taskTurn.findMany({ where: { taskId: f.task.id } })).toMatchObject([
      { turnNo: 1, status: 'completed', driverId: 'opencode' },
    ])
  })

  it('refuses the whole list of unfinished work while one open plan names a removed driver', async () => {
    // The state the migration 20261011090000_switch_to_opencode stops on: it must never be met.
    const f = await fixture()
    const open = (await store.open(f.input))!
    await db.$executeRaw`UPDATE turn_assignments
      SET plan = jsonb_set(plan, '{driverId}', '"kimi"') WHERE id = ${open.id}::uuid`
    await expect(store.unfinished()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid turn assignment returned by the database',
    })
  })

  it('refuses to replace a turn whose saved plan names a removed driver', async () => {
    const f = await fixture()
    const first = (await store.open(f.input))!
    await store.finish({ id: first.id, epoch: 1, outcome: 'failed' })
    // A task the removed shell left: its turn stays as history, its plan can no longer be read.
    await db.$executeRaw`UPDATE turn_assignments
      SET plan = jsonb_set(plan, '{driverId}', '"codex"') WHERE id = ${first.id}::uuid`
    await expect(store.open(f.next(2, 1))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The replaced turn can no longer be restored',
    })
    expect(await db.turnAssignment.count({ where: { taskId: f.task.id } })).toBe(1)
    expect(await db.taskTurn.count({ where: { taskId: f.task.id } })).toBe(1)
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
