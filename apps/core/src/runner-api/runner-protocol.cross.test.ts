// The two sides of the runner protocol together (plan 56, decision 1): core's RunnerHub,
// RemoteTurnExecutor and runner API against the real SandboxRunner and its HTTP transport,
// reached through testing/runner-side.ts. What the runner does on its own is tested in
// apps/runner against a scripted core; what core does, here and in the runner-api tests.
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'

import {
  MAX_SANDBOX_LEASE_MS,
  runnerOpenTasksResponseSchema,
  type SiteLeaseFence,
  type TurnOutputBatch,
  type TurnPlan,
} from '@repo/domain'
import {
  credentials,
  events,
  fence,
  home,
  image,
  labels,
  prepareInput,
  sandboxSide,
} from '@repo/local-turns/testing'
import { LocalTurnExecutor, WarmSandboxes } from '@repo/local-turns'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { sampleDriverId } from '../testing/ids.ts'
import { loopbackTransport } from '../testing/runner-loopback.ts'
import {
  HttpRunnerTransport,
  SandboxRunner,
  type RunnerTransport,
  type SandboxRunnerDependencies,
} from '../testing/runner-side.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerApiServer } from './runner-api.server.ts'
import { RunnerAuthenticator } from './runner-auth.ts'
import { RunnerHub } from './runner-hub.ts'

const signal = new AbortController().signal
const token = `rnr_sandbox-1.${randomBytes(32).toString('base64url')}`

const runners: SandboxRunner[] = []
const hubs: RunnerHub[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop()
  for (const hub of hubs.splice(0)) hub.close()
  for (const close of closers.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function coreSide(assignments: MemoryTurnAssignments) {
  const leases = { assert: vi.fn(async () => true) }
  const hub = new RunnerHub({ assignments, leases, logger: { warn: vi.fn() } })
  hubs.push(hub)
  return { hub, executor: new RemoteTurnExecutor(hub, leases, assignments) }
}

function startRunner(
  transport: RunnerTransport,
  executor: SandboxRunnerDependencies['executor'],
  extra: Partial<SandboxRunnerDependencies> = {},
) {
  const lines: string[] = []
  const push = (message: string) => lines.push(message)
  const runner = new SandboxRunner({
    transport,
    executor,
    maxTurns: 1,
    logger: { log: push, warn: push, error: push },
    ...extra,
  })
  runner.start()
  runners.push(runner)
  return { runner, lines }
}

/** A takeover moves the held lease to the next epoch; the hub only asserts fences here. */
const recoveryLeases = () => ({
  takeOverHeld: async (held: SiteLeaseFence, ttlMs: number) => ({
    ...held,
    epoch: held.epoch + 1,
    expiresAt: new Date(Date.now() + ttlMs),
    serverNow: new Date(),
  }),
})

const open = async (assignments: MemoryTurnAssignments) =>
  (await assignments.open({
    fence,
    sessionId: labels.sessionId,
    turn: 1,
    executor: 'runner',
    plan: {} as TurnPlan,
    remainingMs: MAX_SANDBOX_LEASE_MS,
  }))!

/** Core's runner API over real HTTP, with the VM token of runner `sandbox-1`. */
async function core() {
  const assignments = new MemoryTurnAssignments()
  const leases = { assert: vi.fn(async () => true) }
  const hub = new RunnerHub({ assignments, leases, logger: { warn: vi.fn() } })
  const server = new RunnerApiServer(
    hub,
    new RunnerAuthenticator(parseRunnerTokens(`sandbox-1:${hashRunnerToken(token)}`).hashes),
    { warn: vi.fn() },
  )
  const { port } = await server.listen(0, '127.0.0.1')
  closers.push(() => server.close())
  const transport = () => {
    const client = new HttpRunnerTransport({ coreUrl: new URL(`http://127.0.0.1:${port}`), token })
    closers.push(() => client.close())
    return client
  }
  return {
    assignments,
    hub,
    transport,
    executor: new RemoteTurnExecutor(hub, leases, assignments),
  }
}

describe('SandboxRunner with core', () => {
  it('carries a turn through a restart of core and resumes the agent from the journal', async () => {
    const assignments = new MemoryTurnAssignments(recoveryLeases())
    const side = sandboxSide()
    const before = coreSide(assignments)
    const transport = loopbackTransport(before.hub)
    startRunner(transport, side.executor)
    const assignment = await open(assignments)
    const execution = await before.executor.prepare(prepareInput(assignment.id), signal)
    const agent = await execution.launch()
    const journal: TurnOutputBatch[] = []
    void agent.output(async (batch) => void journal.push(batch)).catch(() => {})
    await vi.waitFor(() => expect(journal).toHaveLength(1))

    // Core dies while the agent still prints; the runner and its container live on.
    before.hub.close()
    const after = coreSide(assignments)
    transport.hub = after.hub
    await vi.waitFor(() => expect(after.hub.inventory({})).toHaveLength(1))
    await assignments.takeOver({ id: assignment.id, fence, ttlMs: 60_000 })
    // The runner still holds the turn credentials: recovery does not send them again.
    const adopted = await after.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'work',
        remainingMs: 60_000,
        driverId: sampleDriverId,
        credentials,
        holdsCredentials: true,
      },
      signal,
    )
    const resumed = await adopted!.attach({
      execId: 'exec1',
      cursor: journal[0]!.to,
      eventCount: journal[0]!.events.length,
    })
    const ended = resumed!.output(async (batch) => void journal.push(batch))
    await vi.waitFor(() => expect(journal).toHaveLength(2))
    side.finish()
    await ended

    expect(await resumed!.wait()).toEqual({ code: 0, reason: 'exited' })
    expect(journal.flatMap((batch) => batch.events)).toEqual(events)
    expect(journal[1]!.from).toEqual(journal[0]!.to)
    expect(side.sandbox.attach).toHaveBeenCalledWith('exec1', journal[0]!.to)
    expect(side.kill).not.toHaveBeenCalled()
    expect(side.sandboxes.create).toHaveBeenCalledOnce()
    expect(side.sandbox.destroy).not.toHaveBeenCalled()
    await adopted!.destroy('completed')
    expect(side.sandbox.destroy).toHaveBeenCalledWith('completed')
  })

  it('lets a restarted runner take the container over by its labels, only with the turn credentials', async () => {
    const assignments = new MemoryTurnAssignments(recoveryLeases())
    const side = sandboxSide()
    const core = coreSide(assignments)
    const gone = startRunner(loopbackTransport(core.hub), side.executor)
    const assignment = await open(assignments)
    await core.executor.prepare(prepareInput(assignment.id), signal)
    // kill -9 of the runner: its memory is gone, its container stays.
    await gone.runner.stop()
    const transport = loopbackTransport(core.hub)
    let polls = 0
    transport.intercept = (route) => void (route === 'poll' && polls++)
    const { runner } = startRunner(transport, side.executor)
    await vi.waitFor(() => expect(polls).toBeGreaterThan(0))
    await assignments.takeOver({
      id: assignment.id,
      fence,
      ttlMs: 60_000,
      runnerSession: runner.session,
    })
    const adopt = (sent: boolean) =>
      core.executor.adopt(
        {
          assignmentId: assignment.id,
          fence: { ...fence, epoch: 2 },
          containerId: 'container1',
          labels: { ...labels, leaseEpoch: 1 },
          purpose: 'work',
          remainingMs: 60_000,
          driverId: sampleDriverId,
          credentials,
          ...(sent ? {} : { holdsCredentials: true }),
        },
        signal,
      )

    // Only the process that launched the agent held its credentials: without them it is lost.
    await expect(adopt(false)).rejects.toMatchObject({ code: 'EXEC_LOST' })
    // A container gone meanwhile answers the adoption with `destroyed`.
    side.sandboxes.get.mockResolvedValueOnce(null)
    side.sandboxes.getForRemoval.mockResolvedValueOnce(null)
    await expect(adopt(true)).resolves.toBeNull()
    // One that can no longer run the agent (its gateway died) is lost for work, not gone.
    side.sandboxes.get.mockResolvedValueOnce(null)
    await expect(adopt(true)).rejects.toMatchObject({ code: 'EXEC_LOST' })
    expect(runner.holds('container1')).toBe(false)
    const adopted = await adopt(true)

    expect(adopted?.containerId).toBe('container1')
    expect(side.sandboxes.get).toHaveBeenCalledWith('container1')
    expect(runner.holds('container1')).toBe(true)
    await adopted!.destroy('failed')
    expect(side.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
    expect(runner.holds('container1')).toBe(false)
  })
})

describe('A chat without a site on the runner (docs/plan/61-chats-first.md, К16)', () => {
  it('fetches the files of the client from core into the turn of their chat', async () => {
    const c = await core()
    const side = sandboxSide()
    side.finish()
    // The commands that make the empty working directory print nothing.
    vi.mocked(side.sandbox.exec).mockImplementation(async () => ({
      id: 'setup',
      output: async function* () {},
      wait: async () => ({ code: 0, reason: 'exited' as const }),
      kill: async () => {},
    }))
    const runner = new SandboxRunner({
      transport: c.transport(),
      executor: side.executor,
      maxTurns: 1,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    runner.start()
    closers.push(() => runner.stop())
    // The lease of a chat is its own id: the labels are all that says so on the wire.
    const chatFence = fence
    const assignment = (await c.assignments.open({
      fence: chatFence,
      sessionId: labels.sessionId,
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_LEASE_MS,
    }))!
    const path = '/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/Смета.pdf'
    const body = Buffer.from('%PDF synthetic estimate')
    const brief = Buffer.from('# Бриф')
    const input = prepareInput(assignment.id)

    const execution = await c.executor.prepare(
      {
        ...input,
        fence: chatFence,
        sandbox: {
          ...input.sandbox,
          labels: { ...input.sandbox.labels, siteId: labels.taskId },
        },
        inbox: [
          {
            path,
            sizeBytes: body.byteLength,
            read: async function* () {
              yield body
            },
          },
        ],
        // And a file of the chat's project, by its own place (docs/plan/84-projects.md, ПР8).
        projectFiles: [
          {
            path: '/workspace/project/Бриф.md',
            sizeBytes: brief.byteLength,
            read: async function* () {
              yield brief
            },
          },
        ],
      },
      new AbortController().signal,
    )
    await execution.destroy('completed')

    const written = vi.mocked(side.sandbox.fs.write).mock.calls.find(([to]) => to === path)!
    expect(Buffer.from(written[1])).toEqual(body)
    expect(written[2]).toEqual({ mode: 0o444 })
    const project = vi
      .mocked(side.sandbox.fs.write)
      .mock.calls.find(([to]) => to === '/workspace/project/Бриф.md')!
    expect(Buffer.from(project[1])).toEqual(brief)
    expect(project[2]).toEqual({ mode: 0o444 })
  })
})

describe('HttpRunnerTransport', () => {
  it('carries a whole turn between a runner and core over HTTP with the VM token', async () => {
    const c = await core()
    const side = sandboxSide()
    side.finish()
    const runner = new SandboxRunner({
      transport: c.transport(),
      executor: side.executor,
      maxTurns: 1,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    runner.start()
    closers.push(() => runner.stop())
    const assignment = (await c.assignments.open({
      fence,
      sessionId: labels.sessionId,
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_LEASE_MS,
    }))!

    const execution = await c.executor.prepare(
      prepareInput(assignment.id),
      new AbortController().signal,
    )
    const agent = await execution.launch()
    const journal: TurnOutputBatch[] = []
    await agent.output(async (batch) => void journal.push(batch))
    await execution.quiesce()
    const captured = await execution.capture({ home })
    const key = new Uint8Array(32).fill(5)
    const sealed = await execution.seal({
      base: {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0' },
        home,
        schemaVersion: 1,
        createdAt: '2026-09-27T00:00:00.000Z',
      },
      dataKey: async () => key,
      put: {
        method: 'PUT',
        url: 'https://s3.invalid/raditi-sessions/sessions/session1/turns/0001/home.tar.zst?X-Amz-Signature=synthetic',
        headers: { 'if-none-match': '*' },
        expiresAt: new Date(),
      },
    })
    await execution.destroy('completed')

    expect(journal.flatMap((batch) => batch.events)).toEqual(events)
    expect(captured).not.toHaveProperty('patch')
    expect(captured.homeBytes).toBe(side.archives.home.byteLength)
    const [put, body] = side.transfer.put.mock.calls[0]!
    expect(put.url).toContain('/turns/0001/home.tar.zst')
    expect(sealed.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    // Core zeroed its copy once it was sent; the runner zeroed its own after sealing.
    expect(key.every((byte) => byte === 0)).toBe(true)
    expect(side.sandbox.destroy).toHaveBeenCalledWith('completed')
  })
})

describe('Warm containers on the runner (docs/plan/93)', () => {
  /** The runner's pool and executor as apps/runner wires them, over the fake Docker of the side. */
  function warmRunner(open: { tasks: string[] }) {
    const assignments = new MemoryTurnAssignments()
    const leases = { assert: vi.fn(async () => true) }
    const hub = new RunnerHub({
      assignments,
      leases,
      openTasks: async (_runnerId, ids) => ids.filter((id) => open.tasks.includes(id)),
      logger: { warn: vi.fn() },
    })
    hubs.push(hub)
    const core = { hub, executor: new RemoteTurnExecutor(hub, leases, assignments) }
    const side = sandboxSide()
    side.sandbox.reset = vi.fn(async () => {})
    const transport = loopbackTransport(hub)
    const session = '00000000-0000-4000-8000-0000000000aa'
    const warm = new WarmSandboxes({
      sandboxes: side.sandboxes,
      warmMs: 10 * 60_000,
      wanted: async (ids) =>
        new Set(
          runnerOpenTasksResponseSchema.parse(
            await transport.openTasks({ runnerSession: session, taskIds: [...ids] }),
          ).open,
        ),
    })
    closers.push(() => warm.close())
    const executor = new LocalTurnExecutor({
      sandboxes: side.sandboxes,
      parser: () => ({ parseEvent: () => [] }),
      transport: side.snapshot,
      transfer: side.transfer,
      warm,
    })
    const { runner } = startRunner(transport, executor, { session, warm })
    /** Turn `turn` of the session under lease epoch `epoch`. */
    const turn = async (number: number, epoch: number) => {
      const assignment = (await assignments.open({
        fence: { ...fence, epoch },
        sessionId: labels.sessionId,
        turn: number,
        executor: 'runner',
        plan: {} as TurnPlan,
        remainingMs: MAX_SANDBOX_LEASE_MS,
      }))!
      const input = prepareInput(assignment.id)
      return {
        assignment,
        execution: await core.executor.prepare(
          {
            ...input,
            fence: { ...fence, epoch },
            sandbox: { ...input.sandbox, labels: { ...labels, turn: number, leaseEpoch: epoch } },
          },
          signal,
        ),
      }
    }
    return { assignments, hub, side, warm, runner, turn }
  }

  it('the next turn of the task takes the container of the completed one, and no reconcile removes it', async () => {
    const open = { tasks: [fence.taskId] }
    const f = warmRunner(open)
    const first = await f.turn(1, 1)
    await first.execution.destroy('completed')
    await f.assignments.finish({ id: first.assignment.id, epoch: 1, outcome: 'completed' })
    // Reset and waiting, not removed: core asked through the runner API whether the task is open.
    expect(f.side.sandbox.reset).toHaveBeenCalledOnce()
    expect(f.side.sandbox.destroy).not.toHaveBeenCalled()
    expect(f.runner.holds('container1')).toBe(true)
    const inventory = [
      { containerId: 'container1', labels: { ...labels, leaseEpoch: 1 }, ageMs: 1_000 },
    ]
    // No assignment owns the waiting container: core says remove, the runner keeps what it holds.
    expect(
      await f.hub.reconcile('sandbox-1', { runnerSession: f.runner.session, inventory }),
    ).toEqual({ remove: ['container1'] })

    const second = await f.turn(2, 2)
    expect(second.execution.containerId).toBe('container1')
    expect(f.side.sandboxes.create).toHaveBeenCalledOnce()
    // A restarted runner would ask again: the container turn 2 runs in is its own, labels of turn 1.
    expect(
      await f.hub.reconcile('sandbox-1', {
        runnerSession: '00000000-0000-4000-8000-0000000000bb',
        inventory,
      }),
    ).toEqual({ remove: [] })

    await second.execution.destroy('completed')
    await f.assignments.finish({ id: second.assignment.id, epoch: 2, outcome: 'completed' })
    expect(f.side.sandbox.destroy).not.toHaveBeenCalled()
    // The task ended: the next check of the pool removes the container.
    open.tasks = []
    await f.warm.sweep()
    await vi.waitFor(() => expect(f.side.sandbox.destroy).toHaveBeenCalledWith('completed'))
    expect(f.runner.holds('container1')).toBe(false)
  })

  it('a container of a failed turn is removed at once, never kept warm', async () => {
    const f = warmRunner({ tasks: [fence.taskId] })
    const first = await f.turn(1, 1)
    await first.execution.destroy('failed')
    expect(f.side.sandbox.reset).not.toHaveBeenCalled()
    expect(f.side.sandbox.destroy).toHaveBeenCalledWith('failed')
    expect(f.runner.holds('container1')).toBe(false)
  })

  it('a task core no longer calls open leaves nothing waiting', async () => {
    const f = warmRunner({ tasks: [] })
    const first = await f.turn(1, 1)
    await first.execution.destroy('completed')
    expect(f.side.sandbox.destroy).toHaveBeenCalledWith('completed')
    expect(f.runner.holds('container1')).toBe(false)
  })
})
