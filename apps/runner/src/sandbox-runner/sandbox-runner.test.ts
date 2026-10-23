import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import {
  leftNothing,
  sandboxCommandFailed,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotManifestSchema,
  snapshotPartFiles,
  snapshotPartNames,
  turnSnapshotPrefix,
  TURN_PUBLICATION_GRACE_MS,
  workspaceTransitKey,
  type Sandbox,
  type SandboxSpec,
  type SnapshotPartName,
} from '@repo/domain'
import {
  baseSha,
  branch,
  bundleBytes,
  credentials,
  emptyUntrackedArchive,
  events,
  fence,
  home,
  image,
  labels,
  prepared,
  sandboxSide,
  sandboxSpec,
  sha256,
} from '@repo/local-turns/testing'
import { sealSnapshotPart, type SnapshotSealBase } from '@repo/snapshots'
import { memoryStorage, tarZst } from '@repo/snapshots/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunnerCallError, type RunnerTransport } from '../core-api/core-client.ts'
import { sampleDriverId } from '../testing/ids.ts'
import { scriptedCore } from '../testing/scripted-core.ts'
import {
  isTurnSnapshotUrl,
  SandboxRunner,
  type SandboxRunnerDependencies,
} from './sandbox-runner.ts'

/**
 * A create that ends only when it is stopped: with the provider's proof that it left nothing,
 * or without one.
 */
const stoppedCreate = (proven: boolean, started?: () => void) =>
  ((_spec: unknown, abort?: AbortSignal) =>
    new Promise<Sandbox>((_resolve, reject) => {
      started?.()
      const failure = () =>
        reject(proven ? leftNothing(sandboxCommandFailed()) : sandboxCommandFailed())
      abort?.addEventListener('abort', failure, { once: true })
    })) as unknown as () => Promise<Sandbox>

const runners: SandboxRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop()
  vi.restoreAllMocks()
})

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
      driverId: sampleDriverId,
      prepared,
      argv: ['synthetic-agent'],
      credentials,
      ...body,
    },
    epoch,
  )

describe('SandboxRunner commands', () => {
  it('reports its capacity and turns, and drops invalid, expired and stale commands', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    let clock = 0
    // Every reading of the clock is 5 ms later: a 1 ms command expires before it runs.
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5))
    const { runner, lines } = startRunner(core.transport, side.executor)

    // An expired prepare created nothing: core may free the site at once.
    await core.send({ type: 'prepare', commandId: randomUUID() }, prepareCommand({ ttlMs: 1 }))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed']))
    expect(core.reports[0]).toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
      absent: true,
      epoch: 1,
    })
    await core.send(prepareCommand({}, 2))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'created', 'prepared']))
    // A stale owner's command is dropped; the current one is carried out.
    await core.send(command('quiesce', {}, 1))
    await core.send(command('quiesce', {}, 2))
    await vi.waitFor(() =>
      expect(core.types()).toEqual(['failed', 'created', 'prepared', 'quiesced']),
    )
    await core.send()
    await vi.waitFor(() => expect(core.polls).toHaveLength(6))

    expect(side.sandboxes.create).toHaveBeenCalledOnce()
    expect(side.sandbox.quiesce).toHaveBeenCalledOnce()
    expect(core.reports.slice(1).every((report) => report.epoch === 2)).toBe(true)
    expect(core.polls[0]).toMatchObject({ runnerSession: runner.session, capacity: 1, active: [] })
    expect(core.polls.at(-1)).toMatchObject({
      capacity: 0,
      active: [{ assignmentId, epoch: 2, phase: 'quiesced' }],
      inventory: [{ containerId: 'container1', labels: { ...labels, leaseEpoch: 1 } }],
    })
    expect(lines).toEqual(['command: invalid command'])
  })

  it('answers a prepare that created nothing as absent, and only then', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)
    const other = '00000000-0000-4000-8000-0000000000a2'
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    // Its only slot is taken: the second turn never reaches Docker.
    await core.send({ ...prepareCommand(), assignmentId: other })
    await vi.waitFor(() => expect(core.types()).toHaveLength(3))
    expect(core.reports[2]).toMatchObject({ type: 'failed', assignmentId: other, absent: true })
    await core.send(command('destroy', { reason: 'failed' }))
    await vi.waitFor(() => expect(core.types()).toHaveLength(4))

    // The provider proved it left nothing: absent.
    side.sandboxes.create.mockRejectedValueOnce(leftNothing(sandboxCommandFailed()))
    await core.send({ ...prepareCommand(), assignmentId: other })
    await vi.waitFor(() => expect(core.types()).toHaveLength(5))
    expect(core.reports[4]).toMatchObject({ type: 'failed', assignmentId: other, absent: true })
    // Docker did not answer: the container may exist, so no proof.
    side.sandboxes.create.mockRejectedValueOnce(new Error('daemon did not answer'))
    const third = '00000000-0000-4000-8000-0000000000a3'
    await core.send({ ...prepareCommand(), assignmentId: third })
    await vi.waitFor(() => expect(core.types()).toHaveLength(6))
    expect(core.reports[5]).toMatchObject({ type: 'failed', assignmentId: third })
    expect(core.reports[5]).not.toHaveProperty('absent')
  })

  it('fetches the base bundle again while core is unavailable, as any other call', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    let calls = 0
    core.transport.bundle = async function* () {
      calls += 1
      if (calls === 1) throw new RunnerCallError('bundle', 503, { error: 'UNAVAILABLE' })
      yield Buffer.from(bundleBytes.subarray(0, 4))
      if (calls === 2) throw new RunnerCallError('bundle', null)
      yield Buffer.from(bundleBytes.subarray(4))
    }
    let imported: Buffer | undefined
    side.importBundle.mockImplementation(async (_sandbox, bundle) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of bundle.read()) chunks.push(chunk)
      imported = Buffer.concat(chunks)
    })
    startRunner(core.transport, side.executor)
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']), {
      timeout: 5_000,
    })
    expect(calls).toBe(3)
    expect(imported).toEqual(bundleBytes)
  })

  it('stops a prepare still creating its container when core adopts the turn for removal', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)
    const creating = Promise.withResolvers<void>()
    // The provider removes what it began to create when it is stopped, and says so.
    side.sandboxes.create.mockImplementation(stoppedCreate(true, () => creating.resolve()))
    side.sandboxes.getForRemoval.mockResolvedValue(null)
    const prepare = prepareCommand()
    await core.send(prepare)
    await creating.promise
    // Core saw the container in the inventory and adopts it for removal under a newer epoch.
    const adopt = command(
      'adopt',
      { containerId: 'container1', labels: { ...labels, leaseEpoch: 1 }, purpose: 'removal' },
      2,
    )
    await core.send(adopt)
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'destroyed']))
    expect(core.reports).toMatchObject([
      { commandId: prepare.commandId, code: 'SANDBOX_COMMAND_FAILED', absent: true },
      { commandId: adopt.commandId, containerId: 'container1', epoch: 2 },
    ])

    // Stopped too late to prove anything: the container is adopted and removed like any other.
    const again = scriptedCore()
    const next = sandboxSide()
    startRunner(again.transport, next.executor)
    next.sandboxes.create.mockImplementation(stoppedCreate(false))
    await again.send(prepareCommand())
    await vi.waitFor(() => expect(next.sandboxes.create).toHaveBeenCalled())
    await again.send(adopt)
    await vi.waitFor(() => expect(again.types()).toEqual(['failed', 'adopted']))
    expect(again.reports[0]).not.toHaveProperty('absent')
    await again.send(command('destroy', { reason: 'failed' }, 2))
    await vi.waitFor(() => expect(again.types()).toEqual(['failed', 'adopted', 'destroyed']))
    expect(next.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
  })

  it('counts a turn from the poll that brought it, and a command’s validity from receipt', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const now = performance.now.bind(performance)
    let later = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now() + later)
    startRunner(core.transport, side.executor)
    await vi.waitFor(() => expect(core.polls).toHaveLength(1))
    // Core answers 5 s after the runner sent its poll: that much of the turn is gone already.
    later = 5_000
    await core.send(prepareCommand({ remainingMs: 60_000 }))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    const [spec] = side.sandboxes.create.mock.calls[0] as unknown as [SandboxSpec]
    expect(spec.hardTimeoutMs).toBeLessThanOrEqual(55_000)
    expect(spec.hardTimeoutMs).toBeGreaterThan(54_000)

    // A quiesce valid for 3 s is still carried out 5 s after its poll was sent.
    await vi.waitFor(() => expect(core.polls).toHaveLength(2))
    later = 10_000
    await core.send(command('quiesce', { ttlMs: 3_000 }))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared', 'quiesced']))
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

  it('carries out what a poll brought even when a freed slot started the next poll', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    const removal = Promise.withResolvers<void>()
    vi.mocked(side.sandbox.destroy).mockImplementation(() => removal.promise)
    await core.send(command('destroy', { reason: 'completed' }))
    await vi.waitFor(() => expect(core.polls.at(-1)).toMatchObject({ capacity: 0 }))

    // Core took a command off its queue for the poll it holds; the answer is on its way when
    // the slot frees. Core counts it delivered: nothing would send the command again.
    const other = '00000000-0000-4000-8000-0000000000a2'
    const late = { ...command('destroy', { reason: 'failed' }), assignmentId: other }
    const answer = await core.sendSlowly(late)
    removal.resolve()
    await vi.waitFor(() => expect(core.polls.at(-1)).toMatchObject({ capacity: 1, active: [] }))
    answer.arrive()

    await vi.waitFor(() =>
      expect(
        core.reports.find((report) => 'commandId' in report && report.commandId === late.commandId),
      ).toMatchObject({
        type: 'failed',
        assignmentId: other,
        code: 'EXEC_LOST',
      }),
    )
  })

  it('drops a copy of a prepare it already took, while it holds the turn and after it', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    startRunner(core.transport, side.executor)
    // Core hands a prepare out again when its polls miss it: it cannot tell a lost answer.
    const prepare = prepareCommand()
    await core.send(prepare)
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    await core.send(prepare)
    await core.send(command('destroy', { reason: 'completed' }))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared', 'destroyed']))
    await core.send(prepare)
    // The next poll left only after the copy was taken.
    await core.send()
    expect(side.sandboxes.create).toHaveBeenCalledOnce()
    expect(core.types()).toEqual(['created', 'prepared', 'destroyed'])
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

    core.transport.poll.mockRejectedValue(
      new RunnerCallError('poll', 409, { error: 'SESSION_RETIRED' }),
    )
    await core.send()
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce())

    // A newer session of this runner may hold the container now.
    expect(side.sandbox.destroy).not.toHaveBeenCalled()
    expect(runner.holds('container1')).toBe(false)
    expect(lines).toContain(
      'Core retired this runner session: it stops and restarts under a new one',
    )
  })

  it('stops without touching the container when core answers a report that its session is retired', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const onRetired = vi.fn()
    const { runner } = startRunner(core.transport, side.executor, { onRetired })
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    // Unlike LEASE_LOST, which removes the container of this very turn.
    core.transport.report.mockImplementation(async (report) => {
      core.reports.push(report)
      if (report.type === 'quiesced')
        throw new RunnerCallError('report', 409, { error: 'SESSION_RETIRED' })
    })

    await core.send(command('quiesce'))
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce())

    expect(side.sandbox.destroy).not.toHaveBeenCalled()
    expect(runner.holds('container1')).toBe(false)
    const polls = core.polls.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(core.polls).toHaveLength(polls)
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
          ? { work: { remainingMs: 60_000, driverId: sampleDriverId, credentials } }
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
      work: { remainingMs: 60_000, driverId: sampleDriverId },
    })
    await vi.waitFor(() => expect(core.types()).toHaveLength(5))
    expect(core.reports.at(-1)).toMatchObject({ type: 'failed', code: 'CREDENTIALS_LOST' })
    expect(side.sandboxes.getForRemoval).toHaveBeenCalledTimes(3)
  })

  it('stops the agent and removes the container itself when core answers that the lease is lost', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    // Another owner holds the site now: core refuses the turn's output with LEASE_LOST.
    core.transport.report.mockImplementation(async (report) => {
      core.reports.push(report)
      if (report.type === 'output')
        throw new RunnerCallError('report', 409, { error: 'LEASE_LOST' })
    })
    const { runner, lines } = startRunner(core.transport, side.executor)
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))

    await core.send(command('launch', { timeoutMs: 60_000 }))
    await vi.waitFor(() => expect(core.types().at(-1)).toBe('destroyed'))

    expect(core.types()).toEqual(['created', 'prepared', 'running', 'output', 'destroyed'])
    expect(core.reports.at(-1)).not.toHaveProperty('commandId')
    expect(side.kill).toHaveBeenCalled()
    expect(side.sandbox.destroy).toHaveBeenCalledWith('failed')
    expect(runner.holds('container1')).toBe(false)
    // Core knows the container is gone: its own destroy is answered without a second removal.
    await core.send(command('destroy', { reason: 'failed' }))
    await vi.waitFor(() => expect(core.types()).toHaveLength(6))
    expect(core.reports.at(-1)).toMatchObject({ type: 'destroyed', containerId: 'container1' })
    expect(side.sandbox.destroy).toHaveBeenCalledOnce()
    expect(lines).toContain(
      'A turn lost its site lease: its agent is stopped and its container removed',
    )
  })

  it('reads the output again from where core stands after a gap', async () => {
    const side = sandboxSide()
    side.finish()
    const core = scriptedCore()
    // Core's journal ends before the runner's first batch: it asks for the output from there.
    let refused = false
    core.transport.report.mockImplementation(async (report) => {
      if (report.type === 'output' && !refused) {
        refused = true
        throw new RunnerCallError('report', 409, {
          error: 'CURSOR_MISMATCH',
          expected: { stdout: 0, stderr: 0 },
        })
      }
      core.reports.push(report)
    })
    startRunner(core.transport, side.executor)
    await core.send(prepareCommand())
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))

    await core.send(command('launch', { timeoutMs: 60_000 }))
    await vi.waitFor(() => expect(core.types().at(-1)).toBe('exited'))

    expect(refused).toBe(true)
    expect(side.sandbox.attach).toHaveBeenCalledWith('exec1', { stdout: 0, stderr: 0 })
    const journal = core.reports.flatMap((report) => (report.type === 'output' ? [report] : []))
    expect(journal.flatMap((batch) => batch.events)).toEqual(events)
    expect(journal[0]!.from).toEqual({ stdout: 0, stderr: 0 })
    expect(core.reports.at(-1)).toMatchObject({ exit: { code: 0, reason: 'exited' } })
  })
})

describe('SandboxRunner snapshot parts', () => {
  /**
   * Turn 1 as core leaves it in S3: its three parts sealed with one data key under the AAD of
   * the manifest, the manifest checked by its schema, presigned GETs of the parts. The data key
   * comes back fresh on every call, as an unwrap by Transit gives it.
   */
  async function previousTurn() {
    const memory = memoryStorage()
    const dataKey = async () => new Uint8Array(32).fill(7)
    const base: SnapshotSealBase = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0', nativeSessionId: 'prior-native' },
      home,
      git: { provider: 'gitea', branch, baseSha: 'a'.repeat(40), headSha: baseSha },
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
    }
    const archives: Record<SnapshotPartName, Uint8Array> = {
      home: await tarZst({ [home.include[0]!]: 'prior conversation' }),
      untracked: emptyUntrackedArchive(),
      patch: Buffer.from('prior patch'),
    }
    const prefix = turnSnapshotPrefix(base.sessionId, base.turn)
    const key = await dataKey()
    const parts = snapshotPartNames.map((name) => {
      const { body, sealed } = sealSnapshotPart(base, name, archives[name], key)
      const object = `${prefix}${snapshotPartFiles[name]}`
      memory.objects.set(object, body)
      return {
        name,
        key: object,
        sha256: sealed.sha256,
        sizeBytes: sealed.sizeBytes,
        encryption: {
          algorithm: 'aes-256-gcm' as const,
          keyId: workspaceTransitKey(base.workspaceId),
          wrappedKey: 'vault:v1:wrapped',
          iv: sealed.iv,
          tag: sealed.tag,
        },
      }
    })
    const manifest = snapshotManifestSchema.parse({ ...base, parts })
    const get = async (name: SnapshotPartName) => {
      const { method, url, headers } = await memory.storage.presign({
        bucket: 'sessions',
        key: `${prefix}${snapshotPartFiles[name]}`,
        method: 'GET',
        ttlMs: 60_000,
      })
      return { method, url, headers }
    }
    return {
      memory,
      source: { dataKey },
      restore: {
        manifest,
        parts: {
          home: await get('home'),
          untracked: await get('untracked'),
          patch: await get('patch'),
        },
      },
    }
  }

  const secondTurn = (restore: object) =>
    prepareCommand({
      sandbox: { ...sandboxSpec(), labels: { ...labels, turn: 2, leaseEpoch: 1 } },
      restore,
    })

  it('restores only the parts of the checkpoint core names and zeroes the data key after use', async () => {
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
    // Path-style: the pin names the sessions bucket of the shared host.
    startRunner(core.transport, side.executor, { s3Origin: 'https://s3.invalid/raditi-sessions' })

    const foreign = structuredClone(prior.restore)
    foreign.parts.home.url = foreign.parts.home.url.replace('/turns/0001/', '/turns/0002/')
    // The same object at another origin, or in another bucket of the same host: a forged core's.
    const elsewhere = structuredClone(prior.restore)
    elsewhere.parts.untracked.url = elsewhere.parts.untracked.url.replace(
      'https://s3.invalid/',
      'https://s3.invalid.example/',
    )
    const otherBucket = structuredClone(prior.restore)
    otherBucket.parts.patch.url = otherBucket.parts.patch.url.replace('/raditi-sessions/', '/evil/')
    await core.send(secondTurn(foreign))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed']))
    await core.send(secondTurn(elsewhere))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'failed']))
    await core.send(secondTurn(otherBucket))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'failed', 'failed']))
    expect(core.reports).toMatchObject([
      { code: 'SNAPSHOT_LOAD_FAILED' },
      { code: 'SNAPSHOT_LOAD_FAILED' },
      { code: 'SNAPSHOT_LOAD_FAILED' },
    ])
    expect(side.sandboxes.create).not.toHaveBeenCalled()
    expect(side.transfer.get).not.toHaveBeenCalled()
    expect(core.transport.key).not.toHaveBeenCalled()

    await core.send(secondTurn(prior.restore))
    await vi.waitFor(() =>
      expect(core.types()).toEqual(['failed', 'failed', 'failed', 'created', 'prepared']),
    )
    expect(side.snapshot.restore).toHaveBeenCalledWith(side.sandbox, home, expect.anything())
    expect(side.transfer.get).toHaveBeenCalledTimes(3)
    expect(keys).toHaveLength(1)
    expect(keys[0]!.every((byte) => byte === 0)).toBe(true)
  })

  it('restores the older checkpoint a replacement turn starts from, never its own turn or a later one', async () => {
    const side = sandboxSide()
    const core = scriptedCore()
    const prior = await previousTurn()
    side.transfer.get.mockImplementation(prior.memory.transfer.get)
    core.transport.key.mockImplementation(async () => prior.source.dataKey())
    startRunner(core.transport, side.executor, { s3Origin: 'https://s3.invalid/raditi-sessions' })
    const turn = (number: number) =>
      prepareCommand({
        sandbox: { ...sandboxSpec(), labels: { ...labels, turn: number, leaseEpoch: 1 } },
        restore: prior.restore,
      })

    // The snapshot of turn 1 is nothing turn 1 itself may start from: a forged core's command.
    await core.send(turn(1))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed']))
    expect(core.reports[0]).toMatchObject({ code: 'SNAPSHOT_LOAD_FAILED' })
    expect(side.sandboxes.create).not.toHaveBeenCalled()
    expect(side.transfer.get).not.toHaveBeenCalled()
    expect(core.transport.key).not.toHaveBeenCalled()

    // Turn 3 replaces turn 2 and starts from what that one started from: the checkpoint of turn 1.
    await core.send(turn(3))
    await vi.waitFor(() => expect(core.types()).toEqual(['failed', 'created', 'prepared']))
    expect(side.snapshot.restore).toHaveBeenCalledWith(side.sandbox, home, expect.anything())
    expect(side.transfer.get).toHaveBeenCalledTimes(3)
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
    const { lines } = startRunner(core.transport, side.executor, {
      s3Origin: 'https://s3.invalid/raditi-sessions',
    })
    // The values of the client's variables of the turn (plan 53, Р13) come with the prepare.
    await core.send(prepareCommand({ envValues: ['pay-secret-0001'] }))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared']))
    // New media below an add-only path count even when an ignore file hides them (plan 53, Р12).
    const addOnlyPaths = ['wp-content/uploads/raditi/']
    await core.send(command('capture', { home, baseSha, addOnlyPaths }))
    await vi.waitFor(() => expect(core.types()).toEqual(['created', 'prepared', 'captured']))
    // The home archive is refused when one of them is left in it.
    expect(side.snapshot.capture).toHaveBeenCalledWith(
      side.sandbox,
      home,
      baseSha,
      expect.any(Array),
      addOnlyPaths,
      ['pay-secret-0001'],
    )
    expect(core.transport.candidate).toHaveBeenCalledTimes(2)
    const seal = (turn: string, target = url(turn)) =>
      command('seal', {
        base: {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: Number(turn),
          image,
          driver: { id: sampleDriverId, version: '1.0.0' },
          home,
          git: { provider: 'gitea', branch, baseSha, headSha: 'c'.repeat(40) },
          schemaVersion: 1,
          createdAt: '2026-09-27T00:00:00.000Z',
        },
        sizeBytes: side.archives.home.byteLength,
        put: { method: 'PUT', url: target, headers: { 'if-none-match': '*' } },
      })

    await core.send(seal('0002'))
    await vi.waitFor(() => expect(core.types()).toHaveLength(4))
    await core.send(seal('0001', url('0001').replace('//s3.invalid/', '//s3.invalid:8443/')))
    await vi.waitFor(() => expect(core.types()).toHaveLength(5))
    // Another bucket of the same path-style host.
    await core.send(seal('0001', url('0001').replace('/raditi-sessions/', '/evil/')))
    await vi.waitFor(() => expect(core.types()).toHaveLength(6))
    expect(core.reports.slice(3)).toMatchObject([
      { type: 'failed', code: 'SNAPSHOT_SAVE_FAILED' },
      { type: 'failed', code: 'SNAPSHOT_SAVE_FAILED' },
      { type: 'failed', code: 'SNAPSHOT_SAVE_FAILED' },
    ])
    expect(core.transport.key).not.toHaveBeenCalled()
    expect(side.transfer.put).not.toHaveBeenCalled()

    await core.send(seal('0001'))
    await vi.waitFor(() => expect(core.types()).toHaveLength(7))
    expect(core.reports[6]).toMatchObject({ type: 'failed', code: 'SNAPSHOT_SAVE_FAILED' })
    await core.send(seal('0001'))
    await vi.waitFor(() => expect(core.types()).toHaveLength(8))
    expect(core.reports[7]).toMatchObject({
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

describe('isTurnSnapshotUrl', () => {
  const key = 'sessions/session1/turns/0001/home.tar.zst'
  it('names this part of this turn, at the pinned origin when one is given', () => {
    for (const url of [
      `https://raditi-sessions.storage.yandexcloud.net/${key}?X-Amz-Signature=s`,
      `https://storage.yandexcloud.net/raditi-sessions/${key}?X-Amz-Signature=s`,
    ])
      expect(isTurnSnapshotUrl(url, 'session1', 1, 'home')).toBe(true)
    const pinned = 'https://raditi-sessions.storage.yandexcloud.net'
    expect(isTurnSnapshotUrl(`${pinned}:443/${key}`, 'session1', 1, 'home', pinned)).toBe(true)
    for (const url of [
      `https://storage.yandexcloud.net/raditi-sessions/${key}`,
      `http://raditi-sessions.storage.yandexcloud.net/${key}`,
      `https://raditi-sessions.storage.yandexcloud.net:8443/${key}`,
      `https://raditi-sessions.storage.yandexcloud.net.example/${key}`,
      `https://x.raditi-sessions.storage.yandexcloud.net/${key}`,
    ])
      expect(isTurnSnapshotUrl(url, 'session1', 1, 'home', pinned)).toBe(false)
    expect(isTurnSnapshotUrl(`${pinned}/${key}`, 'session1', 1, 'patch', pinned)).toBe(false)
    expect(isTurnSnapshotUrl(`${pinned}/${key}`, 'session1', 2, 'home', pinned)).toBe(false)
    // Only the exact object: nothing before the key.
    expect(isTurnSnapshotUrl(`${pinned}/x/${key}`, 'session1', 1, 'home', pinned)).toBe(false)
  })

  it('pins the sessions bucket of a path-style host that other buckets share', () => {
    const pinned = 'https://storage.yandexcloud.net/raditi-sessions'
    const host = 'https://storage.yandexcloud.net'
    expect(
      isTurnSnapshotUrl(`${pinned}/${key}?X-Amz-Signature=s`, 'session1', 1, 'home', pinned),
    ).toBe(true)
    for (const url of [
      `${host}/evil/${key}`,
      `${host}/raditi-sessions/x/${key}`,
      `${host}/raditi-sessions-evil/${key}`,
      `${host}/evil/raditi-sessions/${key}`,
      `${host}/raditi-sessions%2F${key}`,
      `${host}/${key}`,
      `https://raditi-sessions.storage.yandexcloud.net/${key}`,
    ])
      expect(isTurnSnapshotUrl(url, 'session1', 1, 'home', pinned)).toBe(false)
  })
})
