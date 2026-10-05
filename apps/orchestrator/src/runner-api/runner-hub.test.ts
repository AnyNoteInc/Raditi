import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import {
  DomainError,
  runnerReportSchema,
  runnerTimings,
  type TurnAssignment,
  type TurnPlan,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RunnerHub, type ClaimedRunner, type RunnerCommandBody } from './runner-hub.ts'

const hubs: RunnerHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture() {
  const assignments = new MemoryTurnAssignments()
  const warn = vi.fn()
  const hub = new RunnerHub({
    assignments,
    leases: { assert: vi.fn(async () => true) },
    logger: { warn },
  })
  hubs.push(hub)
  let turns = 0
  /** A runner turn of its own task and site, waiting for nothing yet. */
  const open = async () =>
    (await assignments.open({
      fence: { siteId: randomUUID(), taskId: randomUUID(), operation: 'turn', epoch: 1 },
      sessionId: `session${++turns}`,
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: 60_000,
    }))!
  /** One poll of a runner session; it gives up after 100 ms instead of the 25-second hold. */
  const poll = (
    runnerSession: string,
    {
      runnerId = 'sandbox-1',
      capacity = 1,
      signal = AbortSignal.timeout(100),
      active = [] as string[],
    } = {},
  ) =>
    hub.poll(
      runnerId,
      {
        runnerSession,
        capacity,
        inventory: [],
        active: active.map((assignmentId) => ({
          assignmentId,
          epoch: 1,
          phase: 'running' as const,
        })),
      },
      signal,
    )
  const forever = () => new AbortController().signal
  /** The turn's prepare, handed to the hub as RemoteTurnExecutor does once a session reserved it. */
  const prepare = async (turn: TurnAssignment, runner: ClaimedRunner, signal = forever()) => {
    await hub.claim(turn.id, runner)
    const live = hub.attach({
      id: turn.id,
      fence: turn.fence,
      runner,
      credentials: ['synthetic-llm-secret'],
      remainingMs: 60_000,
    })
    return hub.send(live, prepareBody(turn), { answers: ['prepared'], replyMs: 60_000, signal })
  }
  const report = (runnerSession: string, assignmentId: string, body: Record<string, unknown>) =>
    hub.report(
      'sandbox-1',
      runnerReportSchema.parse({ runnerSession, assignmentId, epoch: 1, ...body }),
    )
  return { assignments, hub, warn, open, poll, forever, prepare, report }
}

function prepareBody({ fence, sessionId }: TurnAssignment): RunnerCommandBody {
  return {
    type: 'prepare',
    sandbox: {
      image: `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`,
      labels: {
        workspaceId: 'ws1',
        siteId: fence.siteId,
        taskId: fence.taskId,
        sessionId,
        turn: 1,
        leaseEpoch: fence.epoch,
      },
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: 60_000,
    },
    remainingMs: 60_000,
    bundle: {
      baseSha: 'b'.repeat(40),
      branch: `agent/${fence.taskId}`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
    },
    driverId: 'codex',
    prepared: { files: [], env: {}, secrets: [] },
    argv: ['codex', 'exec', '--json'],
    credentials: ['synthetic-llm-secret'],
  }
}

/** Lets the hub's held poll act on what just changed. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('RunnerHub: a runner slot for a waiting turn', () => {
  it('gives one slot to one turn, however many polls of the session overlap', async () => {
    const f = fixture()
    const first = await f.open()
    const second = await f.open()
    const session = randomUUID()
    const firstRunner = f.hub.reserve(first.id, f.forever())
    let secondReserved = false
    const secondRunner = f.hub.reserve(second.id, f.forever()).then((runner) => {
      secondReserved = true
      return runner
    })
    const connections = [new AbortController(), new AbortController()]
    const polls = connections.map(({ signal }) => f.poll(session, { signal }))
    await expect(firstRunner).resolves.toEqual({ id: 'sandbox-1', session })
    for (const connection of connections) connection.abort()
    expect(await Promise.all(polls)).toEqual([{ commands: [] }, { commands: [] }])
    expect(secondReserved).toBe(false)

    // The slot is free again once the first turn was given up before its prepare.
    f.hub.forgetReservation(first.id)
    await f.poll(session)
    await expect(secondRunner).resolves.toEqual({ id: 'sandbox-1', session })
  })

  it.each(['different runner', 'restarted session'])(
    'does not charge a reservation to a %s',
    async (kind) => {
      const f = fixture()
      const first = await f.open()
      const second = await f.open()
      const reserved = f.hub.reserve(first.id, f.forever())
      await f.poll(randomUUID())
      await reserved
      const next = f.hub.reserve(second.id, f.forever())
      const runnerId = kind === 'different runner' ? 'sandbox-2' : 'sandbox-1'
      const session = randomUUID()
      await f.poll(session, { runnerId })
      await expect(next).resolves.toEqual({ id: runnerId, session })
    },
  )

  it('reserves nothing for a poll whose connection is closed, and leaves the turn to the next', async () => {
    const f = fixture()
    const turn = await f.open()
    let reserved = false
    const runner = f.hub.reserve(turn.id, f.forever()).then((value) => {
      reserved = true
      return value
    })
    const session = randomUUID()
    const closed = new AbortController()
    closed.abort()
    const started = performance.now()
    expect(await f.poll(session, { signal: closed.signal })).toEqual({ commands: [] })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(reserved).toBe(false)
    await f.poll(session)
    await expect(runner).resolves.toEqual({ id: 'sandbox-1', session })
  })

  it('reserves a turn that begins to wait while a poll is held, instead of sleeping out the hold', async () => {
    const f = fixture()
    const session = randomUUID()
    const connection = new AbortController()
    const polled = f.poll(session, { signal: connection.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const turn = await f.open()
    const timeout = new Promise((resolve) => setTimeout(() => resolve('slept'), 1_000))
    expect(await Promise.race([f.hub.reserve(turn.id, f.forever()), timeout])).toEqual({
      id: 'sandbox-1',
      session,
    })
    connection.abort()
    await polled
  })

  it('gives its free slots to the turns that wait longest, and none to a turn being given up', async () => {
    const f = fixture()
    const turns = [await f.open(), await f.open(), await f.open(), await f.open()]
    // The first turn is given up and its abandon is still under way: no runner gets it any more.
    vi.spyOn(f.assignments, 'abandon').mockReturnValue(new Promise(() => {}))
    const givenUp = new AbortController()
    const reserved: number[] = []
    const waiting = turns.map((turn, index) =>
      f.hub
        .reserve(turn.id, index === 0 ? givenUp.signal : f.forever())
        .then(() => reserved.push(index))
        .catch(() => {}),
    )
    givenUp.abort()
    const session = randomUUID()
    await f.poll(session, { capacity: 2 })
    expect(reserved).toEqual([1, 2])
    void waiting
  })

  it('binds no turn to a runner while it only holds a reservation', async () => {
    const f = fixture()
    const turn = await f.open()
    const claim = vi.spyOn(f.assignments, 'claim')
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(randomUUID())
    await reserved
    // Nothing durable: a core that dies now leaves a turn no runner ever took (spec §8).
    expect(claim).not.toHaveBeenCalled()
    expect((await f.assignments.get(turn.id))!.runner).toBeNull()
  })
})

describe('RunnerHub: a turn given up while it waits for a runner', () => {
  it.each(['cancelled', 'timeout', 'lease_lost'] as const)(
    'closes the assignment with the reason its owner gave the turn up: %s',
    async (reason) => {
      const f = fixture()
      const turn = await f.open()
      const abandon = vi.spyOn(f.assignments, 'abandon')
      const owner = new AbortController()
      const waiting = f.hub.reserve(turn.id, owner.signal)
      // As LeaseGuard aborts a turn: the client's cancel, its deadline, a lost lease.
      owner.abort(new DomainError('TURN_INTERRUPTED', reason, 409))
      await expect(waiting).rejects.toMatchObject({ code: 'TURN_INTERRUPTED', message: reason })
      // The product store closes the TaskTurn with it: a cancel is not a platform failure.
      expect(abandon).toHaveBeenCalledExactlyOnceWith(turn.id, 'failed', reason)
      expect((await f.assignments.get(turn.id))!.outcome).toBe('failed')
    },
  )

  it('closes a turn no runner took in time, or given up for a reason it does not know, as a failed run', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const abandon = vi.spyOn(f.assignments, 'abandon')
    const late = await f.open()
    const waiting = f.hub.reserve(late.id, f.forever())
    const refused = expect(waiting).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(runnerTimings.claimTimeoutMs)
    await refused
    expect(abandon).toHaveBeenLastCalledWith(late.id, 'failed', 'run_failed')

    const other = await f.open()
    const owner = new AbortController()
    const given = f.hub.reserve(other.id, owner.signal)
    owner.abort(new Error('TURN_INTERRUPTED cancelled, said a stranger'))
    await expect(given).rejects.toThrow('said a stranger')
    expect(abandon).toHaveBeenLastCalledWith(other.id, 'failed', 'run_failed')
  })
})

describe('RunnerHub: the durable claim, when the prepare goes out', () => {
  it('binds the turn to the session that reserved it, and only that turn', async () => {
    const f = fixture()
    const turn = await f.open()
    const other = await f.open()
    const session = randomUUID()
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(session)
    await reserved
    const claim = vi.spyOn(f.assignments, 'claim')
    await f.hub.claim(turn.id, { id: 'sandbox-1', session })
    expect(claim).toHaveBeenCalledExactlyOnceWith({
      ids: [turn.id],
      runnerId: 'sandbox-1',
      runnerSession: session,
      limit: 1,
    })
    expect((await f.assignments.get(turn.id))!.runner).toEqual({ id: 'sandbox-1', session })
    expect((await f.assignments.get(other.id))!.runner).toBeNull()
  })

  it('binds nothing once the runner that reserved the turn restarted under a new session', async () => {
    const f = fixture()
    const turn = await f.open()
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(randomUUID())
    const runner = await reserved
    // The key of the turn is bound to the VM of the session that is gone: nobody takes its place.
    await f.poll(randomUUID())
    const claim = vi.spyOn(f.assignments, 'claim')
    await expect(f.hub.claim(turn.id, runner)).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      httpStatus: 503,
    })
    expect(claim).not.toHaveBeenCalled()
    expect((await f.assignments.get(turn.id))!.runner).toBeNull()
  })

  it('binds nothing for a runner other than the one that holds the reservation', async () => {
    const f = fixture()
    const turn = await f.open()
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(randomUUID())
    const runner = await reserved
    const other = randomUUID()
    await f.poll(other, { runnerId: 'sandbox-2', capacity: 0 })
    for (const stranger of [
      { id: 'sandbox-2', session: other },
      { id: 'sandbox-1', session: other },
      { id: 'sandbox-2', session: runner.session },
    ])
      await expect(f.hub.claim(turn.id, stranger)).rejects.toMatchObject({
        code: 'RUNNER_UNAVAILABLE',
      })
    expect((await f.assignments.get(turn.id))!.runner).toBeNull()
    // And nothing at all without a reservation.
    const unreserved = await f.open()
    await expect(f.hub.claim(unreserved.id, runner)).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
    })
  })

  it('binds nothing to a session that went away while the store answered', async () => {
    const f = fixture()
    const turn = await f.open()
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(randomUUID())
    const runner = await reserved
    const claim = f.assignments.claim.bind(f.assignments)
    vi.spyOn(f.assignments, 'claim').mockImplementationOnce(async (input) => {
      const rows = await claim(input)
      // The runner restarts while the claim is out.
      await f.poll(randomUUID())
      return rows
    })
    await expect(f.hub.claim(turn.id, runner)).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
    })
  })

  it('refuses a turn that was closed meanwhile', async () => {
    const f = fixture()
    const turn = await f.open()
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(randomUUID())
    const runner = await reserved
    await f.assignments.finish({ id: turn.id, epoch: 1, outcome: 'failed' })
    await expect(f.hub.claim(turn.id, runner)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await f.assignments.get(turn.id))!.runner).toBeNull()
  })

  it('answers RUNNER_UNAVAILABLE when the store does not take the claim, logging only a code', async () => {
    const f = fixture()
    const turn = await f.open()
    const reserved = f.hub.reserve(turn.id, f.forever())
    await f.poll(randomUUID())
    const runner = await reserved
    vi.spyOn(f.assignments, 'claim').mockRejectedValueOnce(
      new Error('connect ECONNREFUSED postgresql://raditi:secret@db'),
    )
    await expect(f.hub.claim(turn.id, runner)).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      httpStatus: 503,
    })
    expect(JSON.stringify(f.warn.mock.calls)).not.toMatch(/ECONNREFUSED|secret/)
  })
})

describe('RunnerHub: the slots of a poll its runner sent before a prepare reached it', () => {
  /**
   * A runner with two slots runs a turn, and poll P1 takes the prepare of turn B for the other
   * one. The first turn ends while P1's answer is on the wire: the runner's next poll P2 is sent
   * before B arrives, with two free slots and nothing active (SandboxRunner's freed slot).
   */
  async function crossedPolls(givenUp?: AbortSignal) {
    const f = fixture()
    const session = randomUUID()
    const running = randomUUID()
    const b = await f.open()
    const slot = f.hub.reserve(b.id, f.forever())
    await f.poll(session, { capacity: 1, active: [running] })
    const preparing = f.prepare(b, await slot, givenUp)
    preparing.catch(() => {})
    const [command] = (await f.poll(session, { capacity: 1, active: [running] })).commands
    expect(command).toMatchObject({ type: 'prepare', assignmentId: b.id })
    const connection = new AbortController()
    const p2 = f.poll(session, { capacity: 2, signal: connection.signal })
    /** The turns that got a slot of the runner, in the order they began to wait. */
    const reserved: number[] = []
    let waiting = 0
    const wait = async () => {
      const index = waiting++
      const turn = await f.open()
      void f.hub.reserve(turn.id, f.forever()).then(
        () => reserved.push(index),
        () => {},
      )
      await settled()
    }
    return {
      ...f,
      b,
      commandId: command!.commandId,
      preparing,
      reserved,
      wait,
      report: (body: Record<string, unknown>) => f.report(session, b.id, body),
      end: async () => {
        connection.abort()
        await p2
      },
    }
  }

  it('keeps the slot of a turn whose prepare settled while that poll is held', async () => {
    const f = await crossedPolls()
    await f.report({ type: 'created', commandId: f.commandId, containerId: 'container-b' })
    await f.report({ type: 'prepared', commandId: f.commandId, containerId: 'container-b' })
    await f.preparing
    await f.wait()
    await f.wait()
    // B holds one of the two slots, whatever P2 says: the second turn would be refused as
    // `failed{absent}` by a full runner, after its key was issued and its bundle built.
    expect(f.reserved).toEqual([0])

    // The runner removed B's container: its slot goes to the next turn at once.
    await f.report({ type: 'destroyed', containerId: 'container-b' })
    await settled()
    expect(f.reserved).toEqual([0, 1])
    await f.end()
  })

  it('gives the slot away once the runner answers the prepare `failed` before any container', async () => {
    const f = await crossedPolls()
    await f.wait()
    await f.wait()
    expect(f.reserved).toEqual([0])
    await f.report({
      type: 'failed',
      commandId: f.commandId,
      code: 'SANDBOX_COMMAND_FAILED',
      absent: true,
    })
    await expect(f.preparing).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    await settled()
    expect(f.reserved).toEqual([0, 1])
    await f.end()
  })

  it('keeps the slot of a prepare that failed after its container was reported, until it is removed', async () => {
    const f = await crossedPolls()
    await f.report({ type: 'created', commandId: f.commandId, containerId: 'container-b' })
    // The restore failed: the runner still holds the turn, for its container is to be removed.
    await f.report({ type: 'failed', commandId: f.commandId, code: 'SANDBOX_COMMAND_FAILED' })
    await expect(f.preparing).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    await f.wait()
    await f.wait()
    expect(f.reserved).toEqual([0])

    await f.report({ type: 'destroyed', containerId: 'container-b' })
    await settled()
    expect(f.reserved).toEqual([0, 1])
    await f.end()
  })

  it('keeps the slot of a prepare core gave up while its runner still carries it out', async () => {
    const owner = new AbortController()
    const f = await crossedPolls(owner.signal)
    owner.abort(new DomainError('TURN_INTERRUPTED', 'cancelled', 409))
    await expect(f.preparing).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    await f.wait()
    await f.wait()
    expect(f.reserved).toEqual([0])

    // The runner had the prepare: its late container is reported, then removed.
    await f.report({ type: 'created', commandId: f.commandId, containerId: 'container-b' })
    await f.report({ type: 'destroyed', containerId: 'container-b' })
    await settled()
    expect(f.reserved).toEqual([0, 1])
    await f.end()
  })

  it('does not charge a restarted runner with a turn its previous session prepared', async () => {
    const f = await crossedPolls()
    await f.report({ type: 'created', commandId: f.commandId, containerId: 'container-b' })
    await f.report({ type: 'prepared', commandId: f.commandId, containerId: 'container-b' })
    await f.preparing
    await f.end()
    // The runner restarted, and recovery took B over for its new session.
    const session = randomUUID()
    await f.poll(session, { capacity: 2 })
    f.hub.attach({
      id: f.b.id,
      fence: { ...f.b.fence, epoch: 2 },
      runner: { id: 'sandbox-1', session },
      credentials: [],
      remainingMs: 60_000,
      containerId: 'container-b',
    })
    const connection = new AbortController()
    const polled = f.poll(session, { capacity: 2, signal: connection.signal })
    await f.wait()
    await f.wait()
    expect(f.reserved).toEqual([0, 1])
    connection.abort()
    await polled
  })

  it('gives away the slot of a prepare core gave up and the wire lost, once it is missing for two minutes', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    // The monotonic clock follows the fake clock, as it would on a real host.
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    const f = fixture()
    const session = randomUUID()
    const pollAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms - Date.now())
      return (await f.poll(session)).commands
    }
    const start = Date.now()
    const first = await f.open()
    const slot = f.hub.reserve(first.id, f.forever())
    await f.poll(session)
    const owner = new AbortController()
    const preparing = f.prepare(first, await slot, owner.signal)
    preparing.catch(() => {})
    // Core wrote the answer, so the prepare counts as delivered; the wire lost it after that.
    expect(await f.poll(session)).toMatchObject({ commands: [{ type: 'prepare' }] })
    owner.abort(new DomainError('TURN_INTERRUPTED', 'cancelled', 409))
    await expect(preparing).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })

    // Core gave the prepare up, so it never goes out again, whatever the polls miss.
    for (const at of [5_000, 15_000, 45_000, 75_000, 105_000])
      expect(await pollAt(start + at)).toEqual([])
    const second = await f.open()
    let reserved = false
    void f.hub.reserve(second.id, f.forever()).then(
      () => (reserved = true),
      () => {},
    )
    // Nothing says yet that the runner does not hold the turn: its one slot stays taken.
    expect(await pollAt(start + 115_000)).toEqual([])
    expect(reserved).toBe(false)
    // Missing for runnerTimings.prepareMissingMs since the first poll that missed it.
    expect(await pollAt(start + 5_000 + runnerTimings.prepareMissingMs)).toEqual([])
    expect(reserved).toBe(true)
  })
})
