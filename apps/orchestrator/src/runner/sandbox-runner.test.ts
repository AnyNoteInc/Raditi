import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import {
  leaseLost,
  MAX_SANDBOX_TURN_MS,
  TURN_PUBLICATION_GRACE_MS,
  type RunnerPollRequest,
  type RunnerReport,
  type TurnOutputBatch,
  type TurnPlan,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import { SnapshotService } from '../sessions/snapshot.service.ts'
import { loopbackTransport } from '../testing/runner-loopback.ts'
import {
  baseSha,
  branch,
  bundleBytes,
  credentials,
  events,
  fence,
  home,
  image,
  labels,
  prepared,
  prepareInput,
  sandboxSide,
  sandboxSpec,
  sha256,
} from '../testing/runner-sandbox.ts'
import { memoryStorage, memoryTransit, tarZst } from '../testing/snapshots.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RunnerCallError, type RunnerTransport } from './core-client.ts'
import { SandboxRunner, type SandboxRunnerDependencies } from './sandbox-runner.ts'

const signal = new AbortController().signal

const runners: SandboxRunner[] = []
const hubs: RunnerHub[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop()
  for (const hub of hubs.splice(0)) hub.close()
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

const open = async (assignments: MemoryTurnAssignments) =>
  (await assignments.open({
    fence,
    sessionId: labels.sessionId,
    turn: 1,
    executor: 'runner',
    plan: {} as TurnPlan,
    remainingMs: MAX_SANDBOX_TURN_MS,
  }))!

/** A core that answers only what a test sends it: polls wait for `send`, reports are kept. */
function scriptedCore() {
  const polls: RunnerPollRequest[] = []
  const reports: RunnerReport[] = []
  const waiting: Array<(answer: unknown) => void> = []
  const transport = {
    poll: vi.fn((request: RunnerPollRequest, abort: AbortSignal) => {
      polls.push(structuredClone(request))
      return new Promise<unknown>((resolve) => {
        waiting.push(resolve)
        abort.addEventListener('abort', () => resolve({ commands: [] }), { once: true })
      })
    }),
    report: vi.fn(async (report: RunnerReport) => {
      reports.push(structuredClone(report))
    }),
    reconcile: vi.fn(async () => ({ remove: [] })),
    bundle: async function* () {
      yield Buffer.from(bundleBytes)
    },
    key: vi.fn(async (): Promise<Uint8Array> => new Uint8Array(32).fill(7)),
    candidate: vi.fn(async () => {}),
  } satisfies RunnerTransport
  return {
    transport,
    polls,
    reports,
    types: () => reports.map((report) => report.type),
    /** Answers the runner's waiting poll. */
    async send(...commands: unknown[]) {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
      waiting.shift()!({ commands })
    },
  }
}

const assignmentId = '00000000-0000-4000-8000-0000000000a1'
const command = (type: string, body: Record<string, unknown> = {}, epoch = 1) => ({
  type,
  commandId: randomUUID(),
  assignmentId,
  fence: { ...fence, epoch },
  ttlMs: 60_000,
  ...body,
})
const prepareCommand = (body: Record<string, unknown> = {}, epoch = 1) =>
  command(
    'prepare',
    {
      sandbox: sandboxSpec(epoch),
      remainingMs: 60_000,
      bundle: { baseSha, branch, sha256: sha256(bundleBytes), sizeBytes: bundleBytes.byteLength },
      driverId: 'codex',
      prepared,
      argv: ['synthetic-agent'],
      credentials,
      ...body,
    },
    epoch,
  )

describe('SandboxRunner with core', () => {
  it('carries a turn through a restart of core and resumes the agent from the journal', async () => {
    const assignments = new MemoryTurnAssignments()
    const side = sandboxSide()
    const before = coreSide(assignments)
    const transport = loopbackTransport(before.hub)
    startRunner(transport, side.executor)
    const assignment = await open(assignments)
    const execution = await before.executor.prepare(prepareInput(assignment.id), signal)
    const agent = await execution.launch(60_000)
    const journal: TurnOutputBatch[] = []
    void agent.output(async (batch) => void journal.push(batch)).catch(() => {})
    await vi.waitFor(() => expect(journal).toHaveLength(1))

    // Core dies while the agent still prints; the runner and its container live on.
    before.hub.close()
    const after = coreSide(assignments)
    transport.hub = after.hub
    await vi.waitFor(() => expect(after.hub.inventory({})).toHaveLength(1))
    await assignments.advance({ id: assignment.id, fromEpoch: 1, epoch: 2 })
    // The runner still holds the turn credentials: recovery does not send them again.
    const adopted = await after.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'work',
        remainingMs: 60_000,
        driverId: 'codex',
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
    const assignments = new MemoryTurnAssignments()
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
    await assignments.advance({
      id: assignment.id,
      fromEpoch: 1,
      epoch: 2,
      runnerSession: runner.session,
    })
    const adopt = (withCredentials: boolean) =>
      core.executor.adopt(
        {
          assignmentId: assignment.id,
          fence: { ...fence, epoch: 2 },
          containerId: 'container1',
          labels: { ...labels, leaseEpoch: 1 },
          purpose: 'work',
          remainingMs: 60_000,
          driverId: 'codex',
          ...(withCredentials ? { credentials } : {}),
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

  it('stops the agent and removes the container itself when core answers that the lease is lost', async () => {
    const assignments = new MemoryTurnAssignments()
    const side = sandboxSide()
    const core = coreSide(assignments)
    const transport = loopbackTransport(core.hub)
    const sent: string[] = []
    transport.intercept = (route, body) => {
      if (route === 'report') sent.push((body as RunnerReport).type)
    }
    const { runner, lines } = startRunner(transport, side.executor)
    const assignment = await open(assignments)
    const execution = await core.executor.prepare(prepareInput(assignment.id), signal)
    const agent = await execution.launch(60_000)

    await expect(
      agent.output(async () => {
        throw leaseLost('Turn evidence no longer owns its site lease')
      }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    await vi.waitFor(() => expect(sent.at(-1)).toBe('destroyed'))

    expect(side.kill).toHaveBeenCalled()
    expect(side.sandbox.destroy).toHaveBeenCalledWith('failed')
    expect(runner.holds('container1')).toBe(false)
    // Core knows the container is gone: its own destroy sends nothing more.
    await execution.destroy('failed')
    expect(side.sandbox.destroy).toHaveBeenCalledOnce()
    expect(lines).toContain(
      'A turn lost its site lease: its agent is stopped and its container removed',
    )
  })

  it('reads the output again from where core stands after a gap', async () => {
    const assignments = new MemoryTurnAssignments()
    const side = sandboxSide()
    side.finish()
    const core = coreSide(assignments)
    const transport = loopbackTransport(core.hub)
    let refused = false
    transport.intercept = (route, body) => {
      if (route !== 'report' || (body as RunnerReport).type !== 'output' || refused) return
      refused = true
      throw new RunnerCallError('report', 409, {
        error: 'CURSOR_MISMATCH',
        expected: { stdout: 0, stderr: 0 },
      })
    }
    startRunner(transport, side.executor)
    const assignment = await open(assignments)
    const execution = await core.executor.prepare(prepareInput(assignment.id), signal)
    const agent = await execution.launch(60_000)
    const journal: TurnOutputBatch[] = []
    await agent.output(async (batch) => void journal.push(batch))

    expect(side.sandbox.attach).toHaveBeenCalledWith('exec1', { stdout: 0, stderr: 0 })
    expect(journal.flatMap((batch) => batch.events)).toEqual(events)
    expect(await agent.wait()).toEqual({ code: 0, reason: 'exited' })
  })
})

describe('SandboxRunner commands', () => {
  it('reports its capacity and turns, and drops invalid, expired and stale commands', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    let clock = 0
    // Every reading of the clock is 5 ms later: a 1 ms command expires before it runs.
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5))
    const { runner, lines } = startRunner(core.transport, side.executor)

    await core.send({ type: 'prepare', commandId: randomUUID() }, prepareCommand({ ttlMs: 1 }))
    await core.send(prepareCommand({}, 2))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    // A stale owner's command is dropped; the current one is carried out.
    await core.send(command('quiesce', {}, 1))
    await core.send(command('quiesce', {}, 2))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared', 'quiesced']))
    await core.send()
    await vi.waitFor(() => expect(core.polls).toHaveLength(6))

    expect(side.sandboxes.create).toHaveBeenCalledOnce()
    expect(side.sandbox.quiesce).toHaveBeenCalledOnce()
    expect(core.reports.every((report) => report.epoch === 2)).toBe(true)
    expect(core.polls[0]).toMatchObject({ runnerSession: runner.session, capacity: 1, active: [] })
    expect(core.polls.at(-1)).toMatchObject({
      capacity: 0,
      active: [{ assignmentId, epoch: 2, phase: 'quiesced' }],
      inventory: [{ containerId: 'container1', labels: { ...labels, leaseEpoch: 1 } }],
    })
    expect(lines).toEqual(['command: invalid command'])
  })

  it('polls again as soon as a turn is gone: its slot takes the next turn at once', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    const removal = Promise.withResolvers<void>()
    vi.mocked(side.sandbox.destroy).mockImplementation(() => removal.promise)

    const before = core.polls.length
    await core.send(command('destroy', { reason: 'completed' }))
    // The poll core holds now was sent while the turn still took the only slot.
    await vi.waitFor(() => expect(core.polls).toHaveLength(before + 1))
    expect(core.polls.at(-1)).toMatchObject({ capacity: 0 })
    const polled = core.polls.length
    removal.resolve()
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared', 'destroyed']))
    await vi.waitFor(() => expect(core.polls).toHaveLength(polled + 1))
    expect(core.polls.at(-1)).toMatchObject({ capacity: 1, active: [] })
  })

  it('removes a container core did not take over, before anything is imported into it', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    core.transport.report.mockImplementation(async (report) => {
      core.reports.push(report)
      if (report.type === 'created')
        throw new RunnerCallError('report', 410, { error: 'COMMAND_CLOSED' })
    })
    const { runner } = startRunner(core.transport, side.executor)

    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'destroyed']))

    expect(core.reports[1]).toEqual(expect.not.objectContaining({ commandId: expect.anything() }))
    expect(side.sandbox.destroy).toHaveBeenCalledWith('failed')
    expect(side.importBundle).not.toHaveBeenCalled()
    expect(runner.holds('container1')).toBe(false)
  })

  it('removes a turn left past its deadline on its own and tells core', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const now = performance.now.bind(performance)
    let later = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now() + later)
    startRunner(core.transport, side.executor)

    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    later = 60_000 + TURN_PUBLICATION_GRACE_MS + 1
    await core.send()
    await vi.waitFor(() => expect(core.types().at(-1)).toBe('destroyed'))

    expect(side.sandbox.destroy).toHaveBeenCalledWith('timeout')
    expect(core.reports.at(-1)).not.toHaveProperty('commandId')
  })

  it('drops its turns without touching their containers once core retired its session', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const onRetired = vi.fn()
    const { runner, lines } = startRunner(core.transport, side.executor, { onRetired })
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))

    core.transport.poll.mockRejectedValue(new RunnerCallError('poll', 409, { error: 'LEASE_LOST' }))
    await core.send()
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce())

    // A newer session of this runner may hold the container now.
    expect(side.sandbox.destroy).not.toHaveBeenCalled()
    expect(runner.holds('container1')).toBe(false)
    expect(lines).toContain(
      'Core retired this runner session: it stops and restarts under a new one',
    )
  })

  it('adopts a container only for removal and removes it', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)

    await core.send(
      command('adopt', {
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'removal',
      }),
    )
    await vi.waitFor(() => expect(core.types()).toEqual(['adopted']))
    await core.send(command('destroy', { reason: 'failed' }))
    await vi.waitFor(() => expect(core.types()).toEqual(['adopted', 'destroyed']))
    // Asked again, it answers from what it removed.
    await core.send(command('destroy', { reason: 'failed' }))
    await vi.waitFor(() => expect(core.types()).toEqual(['adopted', 'destroyed', 'destroyed']))

    expect(side.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
    expect(side.sandbox.exec).not.toHaveBeenCalled()
  })

  it('removes a container that can no longer run anything and answers only a gone one as destroyed', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)
    // Its gateway died: the provider no longer hands it out to work in.
    side.sandboxes.get.mockResolvedValue(null)
    const adopt = (purpose: 'work' | 'removal', containerId = 'container1') =>
      command('adopt', {
        containerId,
        labels: { ...labels, leaseEpoch: 1 },
        purpose,
        ...(purpose === 'work'
          ? { work: { remainingMs: 60_000, driverId: 'codex', credentials } }
          : {}),
      })

    await core.send(adopt('work'))
    await vi.waitFor(() =>
      expect(core.reports).toMatchObject([{ type: 'failed', code: 'EXEC_LOST' }]),
    )
    await core.send(adopt('removal'))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'adopted']))
    await core.send(command('destroy', { reason: 'failed' }))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'adopted', 'destroyed']))
    expect(side.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
    await core.send({
      ...adopt('removal', 'container2'),
      assignmentId: '00000000-0000-4000-8000-0000000000a2',
    })
    await vi.waitFor(() => expect(core.types()).toHaveLength(4))
    expect(core.reports.at(-1)).toMatchObject({ type: 'destroyed', containerId: 'container2' })
    // Without the turn credentials nothing is looked up: its output could not be filtered.
    await core.send({
      ...adopt('work'),
      assignmentId: '00000000-0000-4000-8000-0000000000a3',
      work: { remainingMs: 60_000, driverId: 'codex' },
    })
    await vi.waitFor(() => expect(core.types()).toHaveLength(5))
    expect(core.reports.at(-1)).toMatchObject({ type: 'failed', code: 'CREDENTIALS_LOST' })
    expect(side.sandboxes.getForRemoval).toHaveBeenCalledTimes(3)
  })
})

describe('SandboxRunner snapshot parts', () => {
  async function previousTurn() {
    const memory = memoryStorage()
    const transit = memoryTransit()
    const service = new SnapshotService(memory.storage, transit.secrets)
    await service.save(
      {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: 'codex', version: '1.0.0', nativeSessionId: 'prior-native' },
        home,
        git: { provider: 'gitea', branch, baseSha: 'a'.repeat(40), headSha: baseSha },
      },
      {
        home: await tarZst({ 'sessions/prior.jsonl': 'prior conversation' }),
        untracked: emptyUntrackedArchive(),
        patch: Buffer.from('prior patch'),
      },
    )
    const source = await service.restoreSource(
      {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: 'codex', version: '1.0.0' },
        home,
      },
      60_000,
    )
    const wire = ({ method, url, headers }: { method: string; url: string; headers: object }) => ({
      method,
      url,
      headers,
    })
    return {
      memory,
      source,
      restore: {
        manifest: source.manifest,
        parts: {
          home: wire(source.parts.home),
          untracked: wire(source.parts.untracked),
          patch: wire(source.parts.patch),
        },
      },
    }
  }

  const secondTurn = (restore: object) =>
    prepareCommand({
      sandbox: { ...sandboxSpec(), labels: { ...labels, turn: 2, leaseEpoch: 1 } },
      restore,
    })

  it('restores only the previous turn of its session and zeroes the data key after use', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const prior = await previousTurn()
    side.transfer.get.mockImplementation(prior.memory.transfer.get)
    const keys: Uint8Array[] = []
    core.transport.key.mockImplementation(async () => {
      const key = await prior.source.dataKey()
      keys.push(key)
      return key
    })
    startRunner(core.transport, side.executor)

    const foreign = structuredClone(prior.restore)
    foreign.parts.home.url = foreign.parts.home.url.replace('/turns/0001/', '/turns/0002/')
    await core.send(secondTurn(foreign))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed']))
    expect(core.reports[0]).toMatchObject({ code: 'SNAPSHOT_LOAD_FAILED' })
    expect(side.sandboxes.create).not.toHaveBeenCalled()
    expect(side.transfer.get).not.toHaveBeenCalled()
    expect(core.transport.key).not.toHaveBeenCalled()

    await core.send(secondTurn(prior.restore))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'created', 'prepared']))
    expect(side.snapshot.restore).toHaveBeenCalledWith(side.sandbox, home, expect.anything())
    expect(side.transfer.get).toHaveBeenCalledTimes(3)
    expect(keys).toHaveLength(1)
    expect(keys[0]!.every((byte) => byte === 0)).toBe(true)
  })

  it('seals home only into its own turn, and logs neither presigned URLs nor refused bodies', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const url = (turn: string) =>
      `https://s3.invalid/raditi-sessions/sessions/session1/turns/${turn}/home.tar.zst?X-Amz-Signature=synthetic`
    // Storage and core fail with messages that carry the URL: none of it may reach a log.
    side.transfer.put.mockRejectedValueOnce(new Error(`PUT ${url('0001')} answered 403`))
    core.transport.report.mockImplementation(async (report) => {
      core.reports.push(report)
      if (report.type === 'failed') throw new Error(`refused body with ${url('0001')}`)
    })
    const keys: Uint8Array[] = []
    core.transport.key.mockImplementation(async () => {
      const key = new Uint8Array(32).fill(9)
      keys.push(key)
      return key
    })
    const { lines } = startRunner(core.transport, side.executor)
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    await core.send(command('capture', { home, baseSha }))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared', 'captured']))
    expect(core.transport.candidate).toHaveBeenCalledTimes(2)
    const seal = (turn: string) =>
      command('seal', {
        base: {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: Number(turn),
          image,
          driver: { id: 'codex', version: '1.0.0' },
          home,
          git: { provider: 'gitea', branch, baseSha, headSha: 'c'.repeat(40) },
          schemaVersion: 1,
          createdAt: '2026-09-27T00:00:00.000Z',
        },
        sizeBytes: side.archives.home.byteLength,
        put: { method: 'PUT', url: url(turn), headers: { 'if-none-match': '*' } },
      })

    await core.send(seal('0002'))
    await vi.waitFor(() => expect(core.types()).toHaveLength(4))
    expect(core.reports[3]).toMatchObject({ type: 'failed', code: 'SNAPSHOT_SAVE_FAILED' })
    expect(core.transport.key).not.toHaveBeenCalled()
    expect(side.transfer.put).not.toHaveBeenCalled()

    await core.send(seal('0001'))
    await vi.waitFor(() => expect(core.types()).toHaveLength(5))
    expect(core.reports[4]).toMatchObject({ type: 'failed', code: 'SNAPSHOT_SAVE_FAILED' })
    await core.send(seal('0001'))
    await vi.waitFor(() => expect(core.types()).toHaveLength(6))
    expect(core.reports[5]).toMatchObject({
      type: 'sealed',
      sizeBytes: side.archives.home.byteLength,
    })
    expect(side.transfer.put).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'PUT', url: url('0001') }),
      expect.any(Uint8Array),
    )
    expect(keys).toHaveLength(2)
    expect(keys.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toMatch(/s3\.invalid|X-Amz|refused body/)
  })
})
