import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import {
  DomainError,
  MAX_SANDBOX_TURN_MS,
  notFound,
  runnerReportSchema,
  SANDBOX_SECRETS_DIR,
  TURN_PUBLICATION_GRACE_MS,
  type AgentDriver,
  type AgentEvent,
  type ExecCursor,
  type ExecHandle,
  type RemovableSandbox,
  type Sandbox,
  type SandboxInfo,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnBundleSource,
  type TurnExecutor,
  type TurnResult,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import { SandboxRunner } from '../runner/sandbox-runner.ts'
import type { SealedElsewhere, SnapshotParts } from '../sessions/snapshot.service.ts'
import { crashable } from '../testing/crash.ts'
import { loopbackTransport, type LoopbackTransport } from '../testing/runner-loopback.ts'
import { MemorySiteLeases } from '../testing/site-leases.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { MemoryTurnCredentials } from '../testing/turn-credentials.ts'
import { MemoryTurnJournal } from '../testing/turn-journal.ts'
import { LiveTurns } from './live-turns.ts'
import { LocalTurnExecutor } from './local-turn-executor.ts'
import { TurnExecRecovery } from './turn-exec-recovery.ts'
import { TurnSupervisor, type TurnRequest } from './turn-supervisor.ts'

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 1,
}
const baseSha = 'b'.repeat(40)
const headSha = 'c'.repeat(40)
const image = `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`
const values = { llmApiKey: 'synthetic-llm-secret', mcpToken: 'synthetic-mcp-secret' }
const result: TurnResult = {
  summary: 'Готово',
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: ['page.txt'],
  questions: [],
  needs_approval: false,
  risk: 'low',
}
const events: AgentEvent[] = [
  { type: 'started', nativeSessionId: 'native1' },
  { type: 'message', text: JSON.stringify(result) },
  { type: 'completed' },
]
const line = (event: AgentEvent) => JSON.stringify(event) + '\n'
/** What the agent prints before a test lets it finish, and after. */
const first = Buffer.from(line(events[0]!) + line(events[1]!))
const rest = Buffer.from(line(events[2]!))
/** The first epoch's credentials, as P3 would keep them. */
const reference = { taskId: labels.taskId, sessionId: labels.sessionId, turn: 1, epoch: 1 }

const request = (): TurnRequest => ({
  sandbox: {
    image,
    labels,
    runtime: 'runc',
    resources: { cpu: 1, memoryMiB: 256, pids: 64 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'none' },
    hardTimeoutMs: MAX_SANDBOX_TURN_MS,
  },
  context: {
    taskId: labels.taskId,
    sessionId: labels.sessionId,
    turn: 1,
    llm: { baseUrl: 'http://synthetic.invalid', apiKey: values.llmApiKey, model: 'synthetic' },
    mcp: { url: 'http://synthetic.invalid/mcp', token: values.mcpToken },
    instructions: 'Synthetic verification',
  },
  input: { prompt: 'Synthetic turn', attachments: [] },
  driverVersion: '1.0.0',
  workspace: {
    repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
    branch: `agent/${labels.taskId}`,
    expectedBaseSha: baseSha,
    protectedPaths: [],
  },
  committedAt: '2026-09-27T00:00:00.000Z',
})

/** The VM's Docker: survives every restart of core and of the runner. */
function docker() {
  const gate = Promise.withResolvers<void>()
  let killed = false
  let exists = false
  const kill = vi.fn(async () => {
    killed = true
    gate.resolve()
  })
  const handle = (from: number): ExecHandle => ({
    id: 'exec1',
    output: async function* () {
      if (from < first.byteLength) {
        yield { stream: 'stdout' as const, offset: from, data: first.subarray(from) }
        await gate.promise
        if (killed) return
      }
      const at = Math.max(from, first.byteLength)
      if (at < first.byteLength + rest.byteLength)
        yield { stream: 'stdout' as const, offset: at, data: rest.subarray(at - first.byteLength) }
    },
    wait: async () => {
      await gate.promise
      return killed
        ? { code: null, reason: 'cancelled' as const }
        : { code: 0, reason: 'exited' as const }
    },
    kill,
  })
  const sandbox: Sandbox = {
    id: 'container1',
    labels: { ...labels, leaseEpoch: 1 },
    exec: vi.fn(async () => handle(0)),
    attach: vi.fn(async (_execId: string, cursor?: ExecCursor) => handle(cursor?.stdout ?? 0)),
    fs: { write: vi.fn(async () => {}), read: vi.fn(), list: vi.fn(), remove: vi.fn() },
    quiesce: vi.fn(async () => {}),
    destroy: vi.fn(async () => {
      exists = false
    }),
  }
  const found = (id: string) => (exists && id === sandbox.id ? sandbox : null)
  const sandboxes = {
    kind: 'docker' as const,
    create: vi.fn(async () => {
      exists = true
      return sandbox
    }),
    get: vi.fn(async (id: string): Promise<Sandbox | null> => found(id)),
    getForRemoval: vi.fn(async (id: string): Promise<RemovableSandbox | null> => found(id)),
    list: vi.fn(async (): Promise<SandboxInfo[]> =>
      exists ? [{ id: sandbox.id, labels: sandbox.labels, createdAt: new Date() }] : [],
    ),
  }
  const archives = {
    home: Buffer.from('home archive'),
    patch: Buffer.from('tracked-patch'),
    untracked: emptyUntrackedArchive(),
  }
  return {
    sandbox,
    sandboxes,
    kill,
    exists: () => exists,
    /** The agent prints the rest and exits. */
    finish: () => gate.resolve(),
    side: {
      sandboxes,
      parser: () => ({ parseEvent: (text: string) => [JSON.parse(text) as AgentEvent] }),
      transport: { capture: vi.fn(async () => archives), restore: vi.fn(async () => {}) },
      transfer: {
        get: vi.fn(async (): Promise<Uint8Array> => {
          throw new Error('No previous turn in this test')
        }),
        put: vi.fn(async () => {}),
      },
      importBundle: vi.fn(async () => {}),
    },
  }
}

/** What survives a restart of core: the database, S3, Git and the sandbox side. */
function world(kind: string) {
  const leases = new MemorySiteLeases()
  const journal = new MemoryTurnJournal(leases)
  const assignments = new MemoryTurnAssignments(leases)
  const credentials = new MemoryTurnCredentials()
  const vm = docker()
  const driver: AgentDriver = {
    id: 'codex',
    image,
    capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: false, images: false },
    prepare: vi.fn(async (context) => ({
      context: { ...context },
      files: [{ path: '/agent-home/codex/config.toml', content: 'synthetic = true' }],
      env: {},
      secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey }],
    })),
    command: vi.fn(() => ['synthetic-agent']),
    parseEvent: (text) => [JSON.parse(text) as AgentEvent],
    // The saved home depends on the driver session: recovery must derive the same one.
    sessionState: vi.fn((run) => ({
      root: '/agent-home/codex',
      include: [`sessions/${run.context.nativeSessionId ?? 'new'}`],
      exclude: [],
    })),
    extractResult: (list) =>
      JSON.parse(list.findLast((event) => event.type === 'message')?.text ?? 'null') as unknown,
  }
  const committed = new Map<string, { manifest: SnapshotManifest; patch: Uint8Array }>()
  const snapshots = {
    save: vi.fn(
      async (
        metadata: SnapshotMetadata,
        parts: SnapshotParts<SealedElsewhere>,
        _signal: AbortSignal,
      ) => {
        const manifest: SnapshotManifest = {
          ...metadata,
          schemaVersion: 1,
          createdAt: request().committedAt,
          parts: [],
        }
        committed.set(`${metadata.sessionId}/${metadata.turn}`, {
          manifest,
          patch: Buffer.from(parts.patch as Uint8Array),
        })
        return manifest
      },
    ),
    load: vi.fn(async (ref: SnapshotReference) => {
      const found = committed.get(`${ref.sessionId}/${ref.turn}`)
      // The manifest is written last: without it SnapshotService answers NOT_FOUND.
      if (!found) throw notFound('Snapshot or snapshot part is missing')
      if (JSON.stringify(found.manifest.home) !== JSON.stringify(ref.home))
        throw new DomainError('CONFLICT', 'Snapshot is incompatible', 409)
      return {
        manifest: structuredClone(found.manifest),
        archives: { home: Buffer.alloc(0), patch: found.patch, untracked: emptyUntrackedArchive() },
      }
    }),
    restoreSource: vi.fn(async () => {
      throw new Error('No previous turn in this test')
    }),
  }
  const publish = vi.fn(async (assertFence: () => Promise<void>) => {
    await assertFence()
  })
  const bundle: TurnBundleSource = {
    baseSha,
    branch: `agent/${labels.taskId}`,
    sha256: '0'.repeat(64),
    sizeBytes: 1,
    read: async function* () {
      yield Buffer.from('b')
    },
  }
  const workspace = {
    buildBaseBundle: vi.fn(async () => bundle),
    preparePublication: vi.fn(async (_input: { credentials: readonly string[] }) => ({
      baseSha,
      headSha,
      patch: Buffer.from('full-patch') as Uint8Array,
      untracked: emptyUntrackedArchive(),
      publish,
      dispose: vi.fn(async () => {}),
    })),
  }
  const logger = { warn: vi.fn(), error: vi.fn() }
  let transport: LoopbackTransport | undefined
  let runner: SandboxRunner | undefined

  /** A core process: its own memory, the shared stores; `crash` can kill or pause it. */
  const core = (crash?: ReturnType<typeof crashable>) => {
    const wrap = crash?.wrap ?? (<T>(value: T) => value)
    const deps = {
      leases: wrap(leases),
      assignments: wrap(assignments),
      journal: wrap(journal),
      workspace: wrap(workspace),
      snapshots: wrap(snapshots),
    }
    let hub: RunnerHub | undefined
    let executor: TurnExecutor
    if (kind === 'local') executor = new LocalTurnExecutor(vm.side)
    else {
      hub = new RunnerHub({ ...deps, logger: { warn: vi.fn() } })
      cleanups.push(async () => hub!.close())
      executor = new RemoteTurnExecutor(hub, deps.leases, deps.assignments)
    }
    executor = wrap(executor)
    const live = new LiveTurns()
    return {
      hub,
      executor,
      live,
      supervisor: new TurnSupervisor({ ...deps, executor, driver, live }),
      recovery: new TurnExecRecovery({
        ...deps,
        executor,
        driver: () => driver,
        credentials,
        live,
        logger,
      }),
    }
  }

  /** The runner VM's process, polling `hub`; a new one is a restarted runner. */
  const startRunner = (hub: RunnerHub) => {
    transport = loopbackTransport(hub)
    runner = new SandboxRunner({
      transport,
      executor: new LocalTurnExecutor(vm.side),
      maxTurns: 1,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    runner.start()
    const started = runner
    cleanups.push(() => started.stop())
    return runner
  }

  let current: ReturnType<typeof core> | undefined
  let runnerStopped = false
  /** A new core process; on a runner VM the runner's next poll reaches it. */
  const restart = async (crash?: ReturnType<typeof crashable>) => {
    const previous = current
    const next = core(crash)
    current = next
    if (next.hub && transport) {
      transport.reconnect(next.hub)
      previous?.hub?.close()
      if (!runnerStopped)
        await vi.waitFor(() => expect(next.hub!.session('sandbox-1')).toBeDefined())
    }
    return next
  }

  /**
   * Runs a turn on a core that is killed -9 right after it journaled `phase`, or when `arm`
   * kills it; returns a new core that shares only what survives a restart. On a runner VM the
   * runner lives on and polls the new core, unless `stopRunner` stops it first.
   */
  const crashAt = async (
    phase: string | undefined,
    options: { arm?: (kill: () => void) => void; stopRunner?: boolean } = {},
  ) => {
    const crash = crashable()
    const before = core(crash)
    current = before
    if (before.hub) startRunner(before.hub)
    let crashed = false
    const kill = () => {
      if (crashed) return
      crashed = true
      crash.freeze()
    }
    journal.onRecord = (entry) => {
      if (entry.phase === phase) kill()
    }
    options.arm?.(kill)
    const zombie = before.supervisor.run(request()).then(
      () => 'completed',
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(crashed).toBe(true))
    journal.onRecord = undefined
    if (options.stopRunner && runner) {
      await runner.stop()
      runnerStopped = true
    }
    const after = await restart()
    return { before, after, crash, zombie }
  }

  /** kill -9 of the runner: its memory is gone, its container stays; a new session polls. */
  const restartRunner = async () => {
    await runner!.stop()
    const next = startRunner(current!.hub!)
    await vi.waitFor(() => expect(current!.hub!.session('sandbox-1')).toBe(next.session))
    return next
  }

  const assignment = () => [...assignments.rows.values()][0]!
  const lease = () => leases.rows.get(labels.siteId)!
  return {
    leases,
    journal,
    assignments,
    credentials,
    vm,
    driver,
    snapshots,
    workspace,
    publish,
    logger,
    core,
    crashAt,
    startRunner,
    restart,
    restartRunner,
    runner: () => runner!,
    transport: () => transport!,
    assignment,
    lease,
    /** One recovery pass and every recovery it started. */
    recover: async (recovery: TurnExecRecovery) => {
      await recovery.tick()
      await recovery.settled()
    },
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

describe.each(['local', 'runner'])('turn exec recovery (%s executor)', (kind) => {
  /** The executor of the new core holds the turn credentials only when a runner outlived it. */
  const runnerHolds = kind === 'runner'

  /** Recovery finished the turn itself under `epoch`: saved, removed, published, released. */
  const expectCompleted = (w: ReturnType<typeof world>, epoch = 2) => {
    expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch })
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.vm.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('completed')
    expect(w.vm.sandboxes.create).toHaveBeenCalledOnce()
    expect(w.vm.sandbox.exec).toHaveBeenCalledOnce()
    expect(w.journal.phases(epoch).slice(-5)).toEqual([
      'checkpointing',
      'checkpointed',
      'destroyed',
      'publishing',
      'completed',
    ])
    expect(
      w.journal.entries
        .filter((entry) => entry.fence.epoch === epoch)
        .every((entry) => entry.recoveredFromEpoch === epoch - 1),
    ).toBe(true)
    expect(w.credentials.revoked).toEqual([reference])
  }

  /** Recovery removed the turn's container and released the site: the turn is lost. */
  const expectGivenUp = (w: ReturnType<typeof world>, reason: string) => {
    expect(w.vm.exists()).toBe(false)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason,
      fence: { epoch: 2 },
      recoveredFromEpoch: 1,
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
    expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 2 } })
    expect(w.publish).not.toHaveBeenCalled()
    expect(w.credentials.revoked).toEqual([reference])
  }

  it.each(['running', 'output'])(
    'resumes an agent left %s from the journal cursor and finishes the turn',
    async (phase) => {
      const w = world(kind)
      w.credentials.keep(reference, values)
      const { after } = await w.crashAt(phase)
      const adopt = vi.spyOn(after.executor, 'adopt')
      const recovering = after.recovery.tick().then(() => after.recovery.settled())
      await vi.waitFor(() => expect(w.journal.phases(2)).toContain('resumed'))
      w.vm.finish()
      await recovering

      expectCompleted(w)
      const cursor =
        phase === 'output' ? { stdout: first.byteLength, stderr: 0 } : { stdout: 0, stderr: 0 }
      expect(w.journal.entries.find((entry) => entry.phase === 'resumed')).toMatchObject({
        cursor,
        execId: 'exec1',
        containerId: 'container1',
        recoveredFromEpoch: 1,
      })
      expect(w.vm.sandbox.attach).toHaveBeenCalledWith('exec1', cursor)
      // Every event once across the epochs, and the result read from all of them.
      expect(
        w.journal.entries.flatMap((entry) =>
          entry.phase === 'output' ? (entry.events ?? []) : [],
        ),
      ).toEqual(events)
      expect(w.snapshots.save).toHaveBeenCalledWith(
        expect.objectContaining({
          driver: { id: 'codex', version: '1.0.0', nativeSessionId: 'native1' },
          home: { root: '/agent-home/codex', include: ['sessions/native1'], exclude: [] },
        }),
        expect.anything(),
        expect.anything(),
      )
      // Core checks the output and the candidate with keys from the source; a runner that
      // outlived core still holds them and is not sent them again.
      expect(w.credentials.recovered).toBe(1)
      expect(w.workspace.preparePublication.mock.calls.at(-1)![0].credentials).toEqual([
        values.llmApiKey,
        values.mcpToken,
        values.llmApiKey,
      ])
      expect(adopt.mock.calls[0]![0]).toMatchObject({
        purpose: 'work',
        credentials: [values.llmApiKey, values.mcpToken, values.llmApiKey],
        ...(runnerHolds ? { holdsCredentials: true } : {}),
      })
    },
  )

  it('captures a quiesced turn again and publishes it', async () => {
    const w = world(kind)
    w.credentials.keep(reference, values)
    w.vm.finish()
    const { after } = await w.crashAt('quiesced')
    await w.recover(after.recovery)
    expectCompleted(w)
    expect(w.vm.sandbox.quiesce).toHaveBeenCalledTimes(2)
    expect(w.vm.sandbox.attach).not.toHaveBeenCalled()
  })
  it('resumes again when the core that resumed the turn died too', async () => {
    const w = world(kind)
    w.credentials.keep(reference, values)
    await w.crashAt('output')
    const crash = crashable()
    const second = await w.restart(crash)
    w.journal.onRecord = (entry) => {
      if (entry.phase === 'resumed') crash.freeze()
    }
    void second.recovery.tick()
    await vi.waitFor(() => expect(w.journal.phases(2)).toEqual(['resumed']))
    w.journal.onRecord = undefined
    const third = await w.restart()
    const recovering = w.recover(third.recovery)
    await vi.waitFor(() => expect(w.journal.phases(3)).toContain('resumed'))
    w.vm.finish()
    await recovering

    expectCompleted(w, 3)
    expect(w.assignment()).toMatchObject({ firstEpoch: 1, recoveryAttempts: 2 })
    expect(w.journal.entries.filter((entry) => entry.phase === 'resumed')).toMatchObject([
      { fence: { epoch: 2 }, recoveredFromEpoch: 1 },
      { fence: { epoch: 3 }, recoveredFromEpoch: 2 },
    ])
  })

  it.each([
    ['leased', 'a container its journal does not know yet'],
    ['created', 'a created container'],
    ['restored', 'a prepared container'],
  ])('removes %s turn with %s: its agent may have started', async (phase) => {
    const w = world(kind)
    const create = w.vm.sandboxes.create.getMockImplementation()!
    await w.crashAt(phase === 'leased' ? undefined : phase, {
      // Killed between the container's creation and its journal entry.
      arm: (kill) =>
        phase === 'leased' &&
        w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
          const created = await create(...args)
          kill()
          return created
        }),
    })
    const { recovery } = await w.restart()
    expect(w.journal.phases(1).at(-1)).toBe(phase)
    await w.recover(recovery)

    expectGivenUp(w, 'run_failed')
    expect(w.vm.sandbox.destroy).toHaveBeenCalledWith('failed')
    expect(w.vm.sandbox.exec).not.toHaveBeenCalled()
    expect(w.driver.prepare).toHaveBeenCalledOnce()
    // Only removed, no agent to resume: no attempt counts against the turn.
    expect(w.assignment().recoveryAttempts).toBe(phase === 'leased' ? 0 : 1)
  })

  it('frees the site of a turn whose core died before any runner or container took it', async () => {
    const w = world(kind)
    await w.crashAt(undefined, {
      arm: (kill) =>
        w.workspace.buildBaseBundle.mockImplementationOnce(async () => {
          kill()
          return new Promise<never>(() => {})
        }),
    })
    const { recovery } = await w.restart()
    await w.recover(recovery)
    expect(w.vm.sandboxes.create).not.toHaveBeenCalled()
    if (kind === 'runner') {
      // Nobody claimed it: abandoned now, no runner ever will (P1), and the site is free at once.
      // Recovery gave it up, not its owner: lost.
      expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 1 } })
      expect(w.journal.entries.at(-1)).toMatchObject({
        phase: 'failed',
        reason: 'run_failed',
        outcome: 'lost',
        fence: { epoch: 1 },
      })
      expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
      expect(w.credentials.revoked).toEqual([reference])
      return
    }
    // Nothing tells whether the dead core started a create in its Docker: the site waits.
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 0 })
    w.assignments.rows.get(w.assignment().id)!.deadlineAt = new Date(
      Date.now() - TURN_PUBLICATION_GRACE_MS - 1_000,
    )
    await w.recover(recovery)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'timeout',
      fence: { epoch: 1 },
    })
    expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 1 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('ends a turn its owner gave up while the prepare was out as failed, once its container is removed', async () => {
    const w = world(kind)
    const create = w.vm.sandboxes.create.getMockImplementation()!
    // The daemon did not answer, yet created the container: nothing proves it absent.
    w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
      await create(...args)
      throw new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502)
    })
    await w.crashAt('vacating')
    expect(w.journal.phases(1)).toEqual(['leased', 'vacating'])
    const { recovery } = await w.restart()
    await w.recover(recovery)

    expect(w.vm.exists()).toBe(false)
    expect(w.assignment()).toMatchObject({
      outcome: 'failed',
      fence: { epoch: 2 },
      recoveryAttempts: 0,
    })
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'run_failed',
      fence: { epoch: 2 },
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it('removes a leased turn’s container even when its driver is gone', async () => {
    const w = world(kind)
    const create = w.vm.sandboxes.create.getMockImplementation()!
    await w.crashAt(undefined, {
      arm: (kill) =>
        w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
          const created = await create(...args)
          kill()
          return created
        }),
    })
    const after = await w.restart()
    const recovery = new TurnExecRecovery({
      leases: w.leases,
      assignments: w.assignments,
      journal: w.journal,
      workspace: w.workspace,
      snapshots: w.snapshots,
      executor: after.executor,
      driver: () => {
        throw new Error('This core has no such driver')
      },
      credentials: w.credentials,
      live: after.live,
      logger: w.logger,
    })
    await w.recover(recovery)
    expect(w.vm.exists()).toBe(false)
    expect(w.logger.error).not.toHaveBeenCalled()
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
    expect(w.assignment()).toMatchObject({ outcome: 'lost', recoveryAttempts: 0 })
  })

  it('publishes a checkpoint whose manifest was committed before core died', async () => {
    const w = world(kind)
    w.vm.finish()
    const save = w.snapshots.save.getMockImplementation()!
    const { after } = await w.crashAt(undefined, {
      arm: (kill) =>
        w.snapshots.save.mockImplementationOnce(async (...args) => {
          const manifest = await save(...args)
          kill()
          return manifest
        }),
    })
    expect(w.journal.phases(1).at(-1)).toBe('checkpointing')
    await w.recover(after.recovery)

    expect(w.journal.phases(2)).toEqual([
      'checkpointed',
      'destroyed',
      'publishing',
      'publication_recovered',
    ])
    expect(w.vm.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
    expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
    expect(w.credentials.revoked).toEqual([reference])
  })

  it('leaves a checkpoint without a committed manifest to an operator', async () => {
    const w = world(kind)
    w.vm.finish()
    const { after } = await w.crashAt(undefined, {
      arm: (kill) =>
        w.snapshots.save.mockImplementationOnce(async () => {
          kill()
          return new Promise<never>(() => {})
        }),
    })
    const hold = vi.spyOn(w.leases, 'holdForRecovery')
    await w.recover(after.recovery)
    const holds = hold.mock.calls.length
    // Not tried again by this process.
    await w.recover(after.recovery)

    expect(hold).toHaveBeenCalledTimes(holds)
    expect(w.snapshots.load).toHaveBeenCalledOnce()
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch: 1 } })
    expect(w.publish).not.toHaveBeenCalled()
    expect(w.logger.error).toHaveBeenCalledWith(
      'Turn recovery left a turn to an operator: no committed checkpoint (epoch 1, phase checkpointing, attempts 0)',
    )
  })

  it('tries a checkpoint again when reading it failed, instead of leaving it to an operator', async () => {
    const w = world(kind)
    w.vm.finish()
    const save = w.snapshots.save.getMockImplementation()!
    const { after } = await w.crashAt(undefined, {
      arm: (kill) =>
        w.snapshots.save.mockImplementationOnce(async (...args) => {
          const manifest = await save(...args)
          kill()
          return manifest
        }),
    })
    expect(w.journal.phases(1).at(-1)).toBe('checkpointing')
    // S3 or Vault did not answer: that proves nothing about the manifest.
    w.snapshots.load.mockRejectedValueOnce(
      new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load the turn snapshot', 502),
    )
    await w.recover(after.recovery)
    expect(w.logger.error).not.toHaveBeenCalled()
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch: 1 } })

    await w.recover(after.recovery)
    expect(w.journal.phases(2).at(-1)).toBe('publication_recovered')
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
  })

  it.each(['checkpointed', 'destroyed', 'publishing'])(
    'publishes a turn left %s under a newer epoch',
    async (phase) => {
      const w = world(kind)
      w.vm.finish()
      const { after } = await w.crashAt(phase)
      await w.recover(after.recovery)

      expect(w.journal.phases(2).slice(-2)).toEqual(['publishing', 'publication_recovered'])
      expect(w.publish).toHaveBeenCalledOnce()
      expect(w.vm.exists()).toBe(false)
      expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
      expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
    },
  )

  it('reclaims a checkpoint whose container is still to be removed for what is left of the turn', async () => {
    const w = world(kind)
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed')
    const takeOver = vi.spyOn(w.assignments, 'takeOver')
    await w.recover(after.recovery)

    // Nearly the whole limit is left, more than the recovery's own six minutes: the container
    // may live that long, so the new epoch does too.
    expect(takeOver.mock.calls[0]![0].ttlMs).toBeGreaterThan(
      MAX_SANDBOX_TURN_MS - 60_000 + TURN_PUBLICATION_GRACE_MS,
    )
    expect(w.publish).toHaveBeenCalledOnce()
  })

  it('removes the container its journal names before publishing, whatever the inventory shows', async () => {
    const w = world(kind)
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed')
    // The inventory lags behind the container the journal names.
    const list = vi.spyOn(after.executor, 'list').mockResolvedValue([])
    const order: string[] = []
    const destroy = w.vm.sandbox.destroy
    w.vm.sandbox.destroy = vi.fn(async (reason) => {
      order.push('destroy')
      await destroy(reason)
    })
    w.publish.mockImplementation(async (assertFence) => {
      order.push('publish')
      await assertFence()
    })
    await w.recover(after.recovery)

    expect(list).toHaveBeenCalled()
    expect(order).toEqual(['destroy', 'publish'])
    expect(w.journal.entries.find((entry) => entry.phase === 'destroyed')).toMatchObject({
      containerId: 'container1',
      fence: { epoch: 2 },
    })
    expect(w.assignment()).toMatchObject({ outcome: 'completed', recoveryAttempts: 1 })
  })

  it('leaves a checkpoint to an operator when its container is of another identity', async () => {
    const w = world(kind)
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed')
    // A restarted runner asks Docker; one that held the container would answer from memory.
    if (kind === 'runner') await w.restartRunner()
    const foreign = {
      ...w.vm.sandbox,
      labels: { ...w.vm.sandbox.labels, workspaceId: randomUUID() },
    }
    w.vm.sandboxes.getForRemoval.mockResolvedValue(foreign)
    await w.recover(after.recovery)
    await w.recover(after.recovery)

    expect(w.publish).not.toHaveBeenCalled()
    expect(w.vm.exists()).toBe(true)
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 2 })
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 0 })
    expect(w.logger.error).toHaveBeenCalledExactlyOnceWith(
      'Turn recovery left a turn to an operator: ambiguous container (epoch 2, phase checkpointed, attempts 0)',
    )
  })

  it('frees the site of a turn journaled completed before its release', async () => {
    const w = world(kind)
    w.vm.finish()
    const { after } = await w.crashAt('completed')
    await w.recover(after.recovery)
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.lease()).toMatchObject({ taskId: null, held: false })
    expect(w.assignment()).toMatchObject({ outcome: 'completed' })
  })

  it('closes a failed turn whose assignment update was lost', async () => {
    const w = world(kind)
    const { supervisor, recovery } = await w.restart()
    w.workspace.buildBaseBundle.mockRejectedValueOnce(new Error('clone failed'))
    vi.spyOn(w.assignments, 'finish').mockRejectedValueOnce(new Error('database unavailable'))
    await expect(supervisor.run(request())).rejects.toThrow('clone failed')
    expect(w.assignment().outcome).toBeNull()
    await w.recover(recovery)
    expect(w.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
    expect(w.journal.phases()).toEqual(['leased', 'failed'])
    expect(w.journal.entries.at(-1)).toMatchObject({ reason: 'run_failed', outcome: 'failed' })
  })

  it('keeps a turn recovery gave up lost when its assignment update was lost', async () => {
    const w = world(kind)
    const { after } = await w.crashAt('output')
    vi.spyOn(w.assignments, 'finish').mockRejectedValueOnce(new Error('database unavailable'))
    await w.recover(after.recovery)
    expect(w.assignment().outcome).toBeNull()
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'exec_lost',
      outcome: 'lost',
      fence: { epoch: 2 },
    })
    await w.recover(after.recovery)
    expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 2 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false })
  })

  it.each([
    ['its exec is gone', 'exec'],
    ['its container is gone', 'container'],
    ['its container can no longer run the agent', 'gateway'],
  ])('gives the turn up when %s', async (_case, lost) => {
    const w = world(kind)
    w.credentials.keep(reference, values)
    const { after } = await w.crashAt('output')
    // A runner that holds the container answers from memory: only a restarted one asks Docker.
    if (kind === 'runner' && lost !== 'exec') await w.restartRunner()
    if (lost === 'exec')
      vi.mocked(w.vm.sandbox.attach).mockRejectedValue(
        new DomainError('NOT_FOUND', 'No such exec', 404),
      )
    else {
      w.vm.sandboxes.get.mockResolvedValue(null)
      // Gone for good, or found by its labels and reached only for removal (its gateway died).
      if (lost === 'container') await w.vm.sandbox.destroy('failed')
    }
    await w.recover(after.recovery)

    expectGivenUp(w, 'exec_lost')
    expect(w.vm.sandbox.destroy).toHaveBeenLastCalledWith('failed')
  })

  it('gives the turn up when core cannot recover its credentials to check the output', async () => {
    const w = world(kind)
    const { after } = await w.crashAt('output')
    await w.recover(after.recovery)
    expect(w.credentials.recovered).toBe(1)
    expectGivenUp(w, 'exec_lost')
  })

  it('gives the turn up when nobody holds its credentials any more', async () => {
    const w = world(kind)
    const { after } = await w.crashAt('output')
    if (kind === 'runner') await w.restartRunner()
    await w.recover(after.recovery)
    expect(w.credentials.recovered).toBe(1)
    expectGivenUp(w, 'exec_lost')
  })

  it('gives the turn up as a timeout once its deadline passed', async () => {
    const w = world(kind)
    w.credentials.keep(reference, values)
    const { after } = await w.crashAt('output')
    w.assignments.rows.get(w.assignment().id)!.deadlineAt = new Date(Date.now() - 1_000)
    await w.recover(after.recovery)
    expectGivenUp(w, 'timeout')
    expect(w.vm.sandbox.attach).not.toHaveBeenCalled()
  })

  it('holds the site while a container of the turn cannot be removed', async () => {
    const w = world(kind)
    const { after } = await w.crashAt('restored')
    w.vm.sandbox.destroy = vi.fn(async () => {
      throw new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502)
    })
    await w.recover(after.recovery)

    expect(w.vm.exists()).toBe(true)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'recovery',
      reason: 'destroy_failed',
      fence: { epoch: 2 },
    })
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 2 })
    expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch: 2 } })
    expect(w.credentials.revoked).toEqual([])
  })

  it('tries again later when the executor does not answer before the agent is back', async () => {
    const w = world(kind)
    w.credentials.keep(reference, values)
    const { after } = await w.crashAt('output')
    vi.mocked(w.vm.sandbox.attach).mockRejectedValueOnce(
      new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502),
    )
    await w.recover(after.recovery)
    // The container and its agent stay; the site waits under the new epoch.
    expect(w.vm.exists()).toBe(true)
    expect(w.vm.kill).not.toHaveBeenCalled()
    expect(w.lease()).toMatchObject({ held: true, epoch: 2 })
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 1 })

    const recovering = w.recover(after.recovery)
    await vi.waitFor(() => expect(w.journal.phases(3)).toContain('resumed'))
    w.vm.finish()
    await recovering
    expectCompleted(w, 3)
  })

  it.each(['before', 'after'])(
    'resumes on the next pass when a takeover fails %s its commit, lease and assignment on one epoch',
    async (when) => {
      const w = world(kind)
      w.credentials.keep(reference, values)
      const { after } = await w.crashAt('running')
      const takeOver = w.assignments.takeOver.bind(w.assignments)
      vi.spyOn(w.assignments, 'takeOver').mockImplementationOnce(async (input) => {
        if (when === 'after') await takeOver(input)
        throw new Error('connection reset')
      })
      await w.recover(after.recovery)
      // Committed with its answer lost: the epoch it moved to is held for the next pass.
      const epoch = when === 'after' ? 2 : 1
      expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch } })
      expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch })
      expect(w.vm.exists()).toBe(true)

      const recovering = w.recover(after.recovery)
      await vi.waitFor(() => expect(w.journal.phases(epoch + 1)).toContain('resumed'))
      w.vm.finish()
      await recovering
      expectCompleted(w, epoch + 1)
    },
  )

  it.each(['before', 'after'])(
    'publishes on the next pass when a takeover fails %s its commit, lease and assignment on one epoch',
    async (when) => {
      const w = world(kind)
      w.vm.finish()
      const { after } = await w.crashAt('checkpointed')
      const takeOver = w.assignments.takeOver.bind(w.assignments)
      vi.spyOn(w.assignments, 'takeOver').mockImplementationOnce(async (input) => {
        if (when === 'after') await takeOver(input)
        throw new Error('connection reset')
      })
      await w.recover(after.recovery)
      const epoch = when === 'after' ? 2 : 1
      expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch } })
      expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch })
      expect(w.publish).not.toHaveBeenCalled()

      await w.recover(after.recovery)
      expect(w.publish).toHaveBeenCalledOnce()
      expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: epoch + 1 } })
      expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: epoch + 1 })
      expect(w.logger.error).not.toHaveBeenCalled()
    },
  )

  it('leaves a turn to an operator after two recovery attempts', async () => {
    const w = world(kind)
    const { after } = await w.crashAt('output')
    w.assignments.rows.get(w.assignment().id)!.recoveryAttempts = 2
    const hold = vi.spyOn(w.leases, 'holdForRecovery')
    await w.recover(after.recovery)
    await w.recover(after.recovery)

    expect(hold).toHaveBeenCalledOnce()
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    expect(w.vm.exists()).toBe(true)
    expect(w.assignment().outcome).toBeNull()
    expect(w.logger.error).toHaveBeenCalledWith(
      'Turn recovery left a turn to an operator: too many recovery attempts (epoch 1, phase output, attempts 2)',
    )
  })

  it('leaves a turn to an operator when its journal and assignment disagree', async () => {
    const w = world(kind)
    const { after } = await w.crashAt('output')
    w.assignments.rows.get(w.assignment().id)!.containerId = 'other-container'
    await w.recover(after.recovery)
    expect(w.lease()).toMatchObject({ held: true, epoch: 1 })
    expect(w.vm.exists()).toBe(true)
    expect(w.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('left a turn to an operator: journal mismatch'),
    )
  })

  it('fences the core it took the turn from by the epoch', async () => {
    const w = world(kind)
    w.credentials.keep(reference, values)
    const { after, crash, zombie } = await w.crashAt('output')
    const recovering = w.recover(after.recovery)
    await vi.waitFor(() => expect(w.journal.phases(2)).toContain('resumed'))
    w.vm.finish()
    await recovering
    const journaled = w.journal.entries.length
    const lease = { ...w.lease() }

    // The old core was only paused: it goes on with its stale fence.
    crash.thaw()
    expect(await zombie).toBeInstanceOf(DomainError)
    expect(w.journal.entries).toHaveLength(journaled)
    expect(w.lease()).toEqual(lease)
    expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
    expect(w.publish).toHaveBeenCalledOnce()
  })

  it('never takes over a turn its own process drives', async () => {
    const w = world(kind)
    const crash = crashable()
    const core = w.core(crash)
    if (core.hub) w.startRunner(core.hub)
    w.journal.onRecord = (entry) => {
      if (entry.phase === 'output') crash.freeze()
    }
    void core.supervisor.run(request()).catch(() => {})
    await vi.waitFor(() => expect(w.journal.phases()).toContain('output'))
    // A recovery of the same process: it shares the supervisor's live turns.
    const recovery = new TurnExecRecovery({
      leases: w.leases,
      assignments: w.assignments,
      journal: w.journal,
      workspace: w.workspace,
      snapshots: w.snapshots,
      executor: core.executor,
      driver: () => w.driver,
      credentials: w.credentials,
      live: core.live,
    })
    const hold = vi.spyOn(w.leases, 'holdForRecovery')
    await w.recover(recovery)
    expect(hold).not.toHaveBeenCalled()
    expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch: 1 } })
  })
})

/** The turn's deadline passed long enough ago that the VM's watchdog removed its container. */
const pastGrace = (w: ReturnType<typeof world>) => {
  w.assignments.rows.get(w.assignment().id)!.deadlineAt = new Date(
    Date.now() - TURN_PUBLICATION_GRACE_MS - 1_000,
  )
}

describe('turn exec recovery of a turn given up before its container was reported', () => {
  /** A local turn cancelled while its create hangs; `created` lets the create answer. */
  async function vacatingTurn(w: ReturnType<typeof world>) {
    const core = await w.restart()
    const cancellation = new AbortController()
    const created = Promise.withResolvers<void>()
    const create = w.vm.sandboxes.create.getMockImplementation()!
    w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
      cancellation.abort()
      await created.promise
      return create(...args)
    })
    await expect(core.supervisor.run(request(), cancellation.signal)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    expect(w.journal.phases(1)).toEqual(['leased', 'vacating'])
    return { core, created }
  }

  it('ends as failed after a late container whose removal failed is removed by recovery', async () => {
    const w = world('local')
    const { core, created } = await vacatingTurn(w)
    const destroy = w.vm.sandbox.destroy
    w.vm.sandbox.destroy = vi.fn(async () => {
      throw new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502)
    })
    created.resolve()
    await vi.waitFor(() =>
      expect(w.journal.entries.at(-1)).toMatchObject({
        phase: 'recovery',
        reason: 'destroy_failed',
        containerId: 'container1',
      }),
    )
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    expect(w.assignment().outcome).toBeNull()

    w.vm.sandbox.destroy = destroy
    await w.recover(core.recovery)
    expect(w.vm.exists()).toBe(false)
    // Its owner gave it up first: failed, not lost, whatever the last entry was.
    expect(w.assignment()).toMatchObject({
      outcome: 'failed',
      fence: { epoch: 2 },
      recoveryAttempts: 0,
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it('frees a held site and closes the turn on the next pass when core died after `failed`', async () => {
    const w = world('local')
    const { created } = await vacatingTurn(w)
    w.vm.sandbox.destroy = vi.fn(async () => {
      throw new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502)
    })
    created.resolve()
    await vi.waitFor(() => expect(w.lease()).toMatchObject({ held: true, epoch: 1 }))
    pastGrace(w)
    const crash = crashable()
    const dying = await w.restart(crash)
    w.journal.onRecord = (entry) => {
      if (entry.phase === 'failed') crash.freeze()
    }
    void dying.recovery.tick()
    await vi.waitFor(() => expect(w.journal.entries.at(-1)?.phase).toBe('failed'))
    w.journal.onRecord = undefined
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })

    const { recovery } = await w.restart()
    await w.recover(recovery)
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
    expect(w.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
  })

  it('leaves a vacating turn to its owner until the entry is journaled, then ends it failed', async () => {
    const w = world('local')
    const core = await w.restart()
    const cancellation = new AbortController()
    const create = w.vm.sandboxes.create.getMockImplementation()!
    // The create hangs with the container already in Docker.
    w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
      await create(...args)
      cancellation.abort()
      return new Promise<never>(() => {})
    })
    const slow = Promise.withResolvers<void>()
    const record = w.journal.record.bind(w.journal)
    const journaling = vi.spyOn(w.journal, 'record').mockImplementation(async (entry) => {
      if (entry.phase === 'vacating') await slow.promise
      return record(entry)
    })
    let left = false
    const running = core.supervisor.run(request(), cancellation.signal).catch(() => {
      left = true
    })
    await vi.waitFor(() =>
      expect(journaling).toHaveBeenCalledWith(expect.objectContaining({ phase: 'vacating' })),
    )
    // A pass while the entry commits: the turn is still this process's own.
    await w.recover(core.recovery)
    expect(left).toBe(false)
    expect(w.vm.exists()).toBe(true)
    expect(w.assignment()).toMatchObject({ outcome: null, fence: { epoch: 1 } })

    slow.resolve()
    await running
    await w.recover(core.recovery)
    expect(w.vm.exists()).toBe(false)
    // Its owner gave it up first: failed, not lost.
    expect(w.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 2 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  /** A local turn cancelled while its create hangs with the container already in Docker. */
  async function vacatingWithContainer(w: ReturnType<typeof world>) {
    const core = await w.restart()
    const cancellation = new AbortController()
    const created = Promise.withResolvers<void>()
    const create = w.vm.sandboxes.create.getMockImplementation()!
    w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
      const sandbox = await create(...args)
      cancellation.abort()
      await created.promise
      return sandbox
    })
    await expect(core.supervisor.run(request(), cancellation.signal)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    expect(w.journal.phases(1)).toEqual(['leased', 'vacating'])
    expect(w.vm.exists()).toBe(true)
    return { core, created }
  }

  it('lets recovery take a vacating turn over when the proof comes after it held the site', async () => {
    const w = world('local')
    const { core, created } = await vacatingWithContainer(w)
    const finish = vi.spyOn(w.assignments, 'finish')
    const reclaim = w.leases.reclaimForRecovery.bind(w.leases)
    vi.spyOn(w.leases, 'reclaimForRecovery').mockImplementationOnce(async (fence, ttlMs) => {
      // Held at epoch 1: the late container is removed now, and its attempt ends meanwhile.
      created.resolve()
      await vi.waitFor(() => expect(w.journal.phases(1).at(-1)).toBe('failed'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      return reclaim(fence, ttlMs)
    })
    await w.recover(core.recovery)

    expect(w.vm.sandbox.destroy).toHaveBeenCalledOnce()
    // The attempt saw the hold at its epoch and left the assignment to recovery.
    expect(finish.mock.calls.map(([input]) => input.epoch)).toEqual([2])
    expect(w.assignment()).toMatchObject({
      outcome: 'failed',
      fence: { epoch: 2 },
      recoveryAttempts: 0,
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  /**
   * The attempt finishes a vacating turn while a recovery pass takes it over: the pass held the
   * site before the attempt's failed release looked, and its takeover then finds the turn closed.
   */
  async function finishedDuringTakeOver(w: ReturnType<typeof world>) {
    const { core, created } = await vacatingWithContainer(w)
    // Expired: the attempt's release fails, and it finds the site not held yet.
    w.lease().expiresAt = Date.now() - 1_000
    const inspected = Promise.withResolvers<void>()
    const inspect = w.leases.inspect.bind(w.leases)
    // The attempt's inspect after its failed release, not the sweep's at the start of the pass.
    let armed = false
    vi.spyOn(w.leases, 'inspect').mockImplementation(async (siteId) => {
      const found = await inspect(siteId)
      if (armed) inspected.resolve()
      return found
    })
    const finishing = Promise.withResolvers<void>()
    const finish = w.assignments.finish.bind(w.assignments)
    const finished = Promise.withResolvers<void>()
    vi.spyOn(w.assignments, 'finish').mockImplementation(async (input) => {
      await finishing.promise
      const done = await finish(input)
      finished.resolve()
      return done
    })
    const hold = w.leases.holdForRecovery.bind(w.leases)
    vi.spyOn(w.leases, 'holdForRecovery').mockImplementationOnce(async (fence) => {
      armed = true
      created.resolve()
      await inspected.promise
      return hold(fence)
    })
    const takeOver = w.assignments.takeOver.bind(w.assignments)
    vi.spyOn(w.assignments, 'takeOver').mockImplementationOnce(async (input) => {
      finishing.resolve()
      await finished.promise
      return takeOver(input)
    })
    return core
  }

  it('frees the epoch it held when the attempt finished the turn before its takeover', async () => {
    const w = world('local')
    const core = await finishedDuringTakeOver(w)
    await w.recover(core.recovery)

    expect(w.vm.sandbox.destroy).toHaveBeenCalledOnce()
    expect(w.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('frees on the next pass a hold it left on a turn finished during its takeover', async () => {
    const w = world('local')
    const core = await finishedDuringTakeOver(w)
    // The read after the refused takeover fails: this pass cannot tell the turn was closed.
    const get = w.assignments.get.bind(w.assignments)
    vi.spyOn(w.assignments, 'get')
      .mockImplementationOnce(get)
      .mockRejectedValueOnce(new Error('database unavailable'))
    await w.recover(core.recovery)
    expect(w.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })

    // No unfinished assignment leads a pass back to it: the sweep does.
    await w.recover(core.recovery)
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
    expect(w.logger.warn).toHaveBeenCalledWith(
      'Turn recovery freed 1 site(s) held for finished turns',
    )
  })

  it('waits for a claimed prepare no container of which shows, without a hold or an attempt', async () => {
    const w = world('runner')
    await w.crashAt(undefined, {
      // The runner took the prepare; core died while the daemon had not created anything yet.
      arm: (kill) =>
        w.vm.sandboxes.create.mockImplementationOnce(async () => {
          kill()
          return new Promise<never>(() => {})
        }),
    })
    const { recovery } = await w.restart()
    await w.recover(recovery)
    await w.recover(recovery)
    expect(w.assignment()).toMatchObject({
      outcome: null,
      fence: { epoch: 1 },
      recoveryAttempts: 0,
      runner: { id: 'sandbox-1' },
    })
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })

    pastGrace(w)
    await w.recover(recovery)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'timeout',
      fence: { epoch: 1 },
    })
    expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 1 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })
})

describe('turn exec recovery of a checkpoint: attempts', () => {
  it('counts no attempt for a removal that failed, and one once the container is gone', async () => {
    const w = world('local')
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed')
    const destroy = w.vm.sandbox.destroy
    w.vm.sandbox.destroy = vi.fn(async () => {
      throw new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502)
    })
    await w.recover(after.recovery)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'recovery',
      reason: 'destroy_failed',
      fence: { epoch: 2 },
    })
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 0 })
    expect(w.lease()).toMatchObject({ held: true, epoch: 2 })

    w.vm.sandbox.destroy = destroy
    await w.recover(after.recovery)
    expect(w.vm.exists()).toBe(false)
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.assignment()).toMatchObject({
      outcome: 'completed',
      fence: { epoch: 3 },
      recoveryAttempts: 1,
    })
  })

  it('leaves to an operator a checkpoint whose candidate never matches it', async () => {
    const w = world('local')
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed')
    const prepare = w.workspace.preparePublication.getMockImplementation()!
    w.workspace.preparePublication.mockImplementation(async (input) => ({
      ...(await prepare(input)),
      headSha: 'd'.repeat(40),
    }))
    for (let pass = 0; pass < 4; pass++) await w.recover(after.recovery)

    expect(w.publish).not.toHaveBeenCalled()
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 2 })
    // The first pass removed the container: the second one starts from that removal.
    expect(w.journal.phases(3)[0]).toBe('destroyed')
    expect(w.logger.error).toHaveBeenCalledWith(
      'Turn recovery left a turn to an operator: too many recovery attempts (epoch 3, phase destroyed, attempts 2)',
    )
  })
})

describe('turn exec recovery on a runner VM', () => {
  it.each([
    ['not held', false],
    ['held by an earlier recovery', true],
  ])(
    'never leaves a site %s held for good when freeing it fails after the turn was abandoned',
    async (_, heldBefore) => {
      const w = world('runner')
      await w.crashAt(undefined, {
        arm: (kill) =>
          w.workspace.buildBaseBundle.mockImplementationOnce(async () => {
            kill()
            return new Promise<never>(() => {})
          }),
      })
      if (heldBefore) w.lease().held = true
      const { recovery } = await w.restart()
      const hold = vi.spyOn(w.leases, 'holdForRecovery')
      vi.spyOn(w.leases, 'free').mockRejectedValueOnce(new Error('database unavailable'))
      await w.recover(recovery)
      expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 1 } })
      // One statement frees the epoch: no step of it holds the site.
      expect(hold).not.toHaveBeenCalled()
      expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: heldBefore, epoch: 1 })

      await w.recover(recovery)
      // Not held, it runs out by its TTL; held, the sweep takes it off.
      expect(w.lease()).toMatchObject(
        heldBefore
          ? { taskId: null, held: false, epoch: 1 }
          : { taskId: labels.taskId, held: false, epoch: 1 },
      )
    },
  )

  it('waits for a runner that is away and gives the turn up at its deadline and grace', async () => {
    const w = world('runner')
    const { after } = await w.crashAt('output', { stopRunner: true })
    await w.recover(after.recovery)
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })
    expect(w.journal.phases(1).at(-1)).toBe('output')

    // Past its deadline the watchdog may still be removing the container: the grace is waited out.
    w.assignments.rows.get(w.assignment().id)!.deadlineAt = new Date(Date.now() - 1_000)
    await w.recover(after.recovery)
    expect(w.journal.phases(1).at(-1)).toBe('output')

    pastGrace(w)
    // The assignment update is lost once: the next pass closes it from the journal, still lost.
    vi.spyOn(w.assignments, 'finish').mockRejectedValueOnce(new Error('database unavailable'))
    await expect(w.recover(after.recovery)).resolves.toBeUndefined()
    expect(w.assignment().outcome).toBeNull()
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'timeout',
      outcome: 'lost',
      fence: { epoch: 1 },
    })
    await w.recover(after.recovery)
    expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 1 } })
    // The watchdog removed it by now: the site is freed, not left to its TTL.
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
    expect(w.credentials.revoked).toEqual([reference, reference])
  })

  it('removes once a container the runner reports under the older epoch after recovery took the turn', async () => {
    const w = world('runner')
    const core = await w.restart()
    w.startRunner(core.hub!)
    const cancellation = new AbortController()
    const created = Promise.withResolvers<void>()
    const create = w.vm.sandboxes.create.getMockImplementation()!
    w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
      const sandbox = await create(...args)
      cancellation.abort()
      await created.promise
      return sandbox
    })
    const onCreated = vi.fn()
    await expect(core.supervisor.run(request(), cancellation.signal)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    expect(w.journal.phases(1)).toEqual(['leased', 'vacating'])
    // The runner's inventory shows the container its prepare is still creating.
    await vi.waitFor(() => expect(core.hub!.inventory({})).toHaveLength(1))
    w.transport().intercept = (route, body) => {
      const report = body as { type?: string; epoch?: number } | undefined
      if (route === 'report' && report?.type === 'created') onCreated(report.epoch)
    }

    // Recovery of the same process takes it over under epoch 2 while `created` is on its way.
    const recovering = w.recover(core.recovery)
    await vi.waitFor(() => expect(w.assignment().fence.epoch).toBe(2))
    created.resolve()
    await recovering

    expect(onCreated).toHaveBeenCalledWith(1)
    expect(w.vm.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
    expect(w.vm.exists()).toBe(false)
    expect(w.journal.phases(1)).toEqual(['leased', 'vacating'])
    expect(w.journal.phases(2)).toEqual(['failed'])
    expect(w.assignment()).toMatchObject({
      outcome: 'failed',
      fence: { epoch: 2 },
      recoveryAttempts: 0,
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it('removes a container a restarted runner shows after the old session died creating it', async () => {
    const w = world('runner')
    const core = await w.restart()
    w.startRunner(core.hub!)
    const create = w.vm.sandboxes.create.getMockImplementation()!
    // kill -9 of the runner mid-create: the container exists, `created` is never sent.
    w.vm.sandboxes.create.mockImplementationOnce(async (...args) => {
      await create(...args)
      return new Promise<never>(() => {})
    })
    const running = core.supervisor.run(request()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(w.vm.exists()).toBe(true))
    await w.restartRunner()
    expect(await running).toMatchObject({ code: 'RUNNER_UNAVAILABLE' })
    expect(w.journal.phases(1)).toEqual(['leased', 'vacating'])
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })

    await vi.waitFor(() => expect(core.hub!.inventory({})).toHaveLength(1))
    await w.recover(core.recovery)
    expect(w.vm.exists()).toBe(false)
    expect(w.vm.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('failed')
    expect(w.assignment()).toMatchObject({
      outcome: 'failed',
      fence: { epoch: 2 },
      recoveryAttempts: 0,
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it('keeps the site until the deadline and grace when the dead runner session left no container', async () => {
    const w = world('runner')
    const core = await w.restart()
    w.startRunner(core.hub!)
    w.vm.sandboxes.create.mockImplementationOnce(() => new Promise<never>(() => {}))
    const release = vi.spyOn(w.leases, 'release')
    const running = core.supervisor.run(request()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(w.vm.sandboxes.create).toHaveBeenCalled())
    await w.restartRunner()
    expect(await running).toMatchObject({ code: 'RUNNER_UNAVAILABLE' })

    await w.recover(core.recovery)
    await w.recover(core.recovery)
    expect(release).not.toHaveBeenCalled()
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 0 })

    pastGrace(w)
    await w.recover(core.recovery)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'run_failed',
      fence: { epoch: 1 },
    })
    expect(w.assignment()).toMatchObject({ outcome: 'failed', fence: { epoch: 1 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('holds a checkpoint of an away runner unpublished, then publishes once it is back', async () => {
    const w = world('runner')
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed', { stopRunner: true })
    await w.recover(after.recovery)
    await w.recover(after.recovery)

    expect(w.publish).not.toHaveBeenCalled()
    expect(w.vm.exists()).toBe(true)
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    expect(w.journal.entries.filter((entry) => entry.reason === 'awaiting_runner')).toMatchObject([
      { phase: 'recovery', fence: { epoch: 1 } },
    ])
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 0 })

    await w.restartRunner()
    await w.recover(after.recovery)
    expect(w.journal.phases(2)).toEqual([
      'checkpointed',
      'destroyed',
      'publishing',
      'publication_recovered',
    ])
    expect(w.journal.entries.find((entry) => entry.phase === 'destroyed')).toMatchObject({
      containerId: 'container1',
    })
    expect(w.vm.exists()).toBe(false)
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.assignment()).toMatchObject({
      outcome: 'completed',
      fence: { epoch: 2 },
      recoveryAttempts: 1,
    })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it('waits for a runner silent past its poll hold instead of timing out on it', async () => {
    const w = world('runner')
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed')
    await w.runner().stop()
    // Silent for 50 s: not yet lost to the hub, but a removal through it would only time out.
    const now = performance.now.bind(performance)
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 50_000)
    await w.recover(after.recovery)
    await w.recover(after.recovery)
    expect(w.publish).not.toHaveBeenCalled()
    expect(w.logger.error).not.toHaveBeenCalled()
    expect(w.lease()).toMatchObject({ held: true, epoch: 1 })
    expect(w.assignment()).toMatchObject({ outcome: null, recoveryAttempts: 0 })

    clock.mockRestore()
    await w.restartRunner()
    await w.recover(after.recovery)
    expect(w.vm.exists()).toBe(false)
    expect(w.assignment()).toMatchObject({ outcome: 'completed', recoveryAttempts: 1 })
  })

  it('publishes without the runner once the deadline and grace passed: the watchdog removed it', async () => {
    const w = world('runner')
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed', { stopRunner: true })
    const adopt = vi.spyOn(after.executor, 'adopt')
    // The VM's watchdog removes the container past its own deadline.
    await w.vm.sandbox.destroy('timeout')
    pastGrace(w)
    await w.recover(after.recovery)

    expect(adopt).not.toHaveBeenCalled()
    expect(w.journal.phases(2)).toEqual([
      'checkpointed',
      'destroyed',
      'publishing',
      'publication_recovered',
    ])
    expect(w.journal.entries.find((entry) => entry.phase === 'destroyed')).toMatchObject({
      containerId: 'container1',
      reason: 'timeout',
    })
    expect(w.publish).toHaveBeenCalledOnce()
    expect(w.assignment()).toMatchObject({ outcome: 'completed', recoveryAttempts: 1 })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it('publishes a turn journaled publishing at once, its runner away or not', async () => {
    const w = world('runner')
    w.vm.finish()
    const { after } = await w.crashAt('publishing', { stopRunner: true })
    await w.recover(after.recovery)
    expect(w.journal.entries.some((entry) => entry.reason === 'awaiting_runner')).toBe(false)
    expect(w.journal.phases(2).slice(-2)).toEqual(['publishing', 'publication_recovered'])
    expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
  })

  it.each(['destroyed', 'publishing'])(
    'still publishes a turn journaled %s at once after a pass failed before publishing, its runner away',
    async (phase) => {
      const w = world('runner')
      w.vm.finish()
      const { after } = await w.crashAt(phase, { stopRunner: true })
      w.workspace.preparePublication.mockRejectedValueOnce(
        new DomainError('GIT_UNAVAILABLE', 'The clone did not answer', 502),
      )
      await w.recover(after.recovery)
      expect(w.publish).not.toHaveBeenCalled()
      expect(w.journal.phases(2)).toEqual(['destroyed', 'recovery'])
      expect(w.lease()).toMatchObject({ held: true, epoch: 2 })

      await w.recover(after.recovery)
      expect(w.journal.entries.some((entry) => entry.reason === 'awaiting_runner')).toBe(false)
      expect(w.publish).toHaveBeenCalledOnce()
      expect(w.assignment()).toMatchObject({
        outcome: 'completed',
        fence: { epoch: 3 },
        recoveryAttempts: 2,
      })
    },
  )

  it('does not let the wait for an away runner hide the attempt limit', async () => {
    const w = world('runner')
    w.vm.finish()
    const { after } = await w.crashAt('checkpointed', { stopRunner: true })
    w.assignments.rows.get(w.assignment().id)!.recoveryAttempts = 2
    await w.recover(after.recovery)
    expect(w.journal.entries.some((entry) => entry.reason === 'awaiting_runner')).toBe(false)
    expect(w.lease()).toMatchObject({ held: true, epoch: 1 })
    expect(w.logger.error).toHaveBeenCalledWith(
      'Turn recovery left a turn to an operator: too many recovery attempts (epoch 1, phase checkpointed, attempts 2)',
    )
  })

  it('takes a hold off after the deadline and grace when the runner of a failed removal is away', async () => {
    const w = world('runner')
    const { after } = await w.crashAt('restored')
    const destroy = w.vm.sandbox.destroy
    w.vm.sandbox.destroy = vi.fn(async () => {
      throw new DomainError('SANDBOX_COMMAND_FAILED', 'Docker did not answer', 502)
    })
    await w.recover(after.recovery)
    expect(w.lease()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 2 })
    w.vm.sandbox.destroy = destroy

    // The runner is silent past its poll hold: it may be gone, and it is not waited for here.
    await w.runner().stop()
    const now = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 50_000)
    await w.recover(after.recovery)
    expect(w.lease()).toMatchObject({ held: true, epoch: 2 })
    pastGrace(w)
    await w.recover(after.recovery)
    expect(w.journal.entries.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'timeout',
      fence: { epoch: 2 },
    })
    expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 2 } })
    expect(w.lease()).toMatchObject({ taskId: null, held: false, epoch: 2 })
  })

  it.each(['another task', 'the same task'])(
    'closes a turn whose expired lease %s took, without writing under that owner',
    async (holder) => {
      const w = world('runner')
      const { after } = await w.crashAt('output', { stopRunner: true })
      const journaled = w.journal.entries.length
      w.lease().expiresAt = Date.now() - 1_000
      const taskId = holder === 'the same task' ? labels.taskId : randomUUID()
      const next = (await w.leases.acquire({
        siteId: labels.siteId,
        taskId,
        operation: 'turn',
        ttlMs: 60_000,
      }))!
      pastGrace(w)
      await w.recover(after.recovery)

      expect(w.assignment()).toMatchObject({ outcome: 'lost', fence: { epoch: 1 } })
      expect(w.journal.entries).toHaveLength(journaled)
      expect(w.lease()).toMatchObject({ taskId, held: false, epoch: 2 })
      // The turn of the task is no longer locked by an unfinished assignment.
      expect(
        await w.assignments.open({
          fence: next,
          sessionId: labels.sessionId,
          turn: 1,
          executor: 'runner',
          plan: w.assignment().plan,
          remainingMs: 60_000,
        }),
      ).not.toBeNull()
    },
  )

  it('resumes on a restarted runner with recovered credentials and fences the old session', async () => {
    const w = world('runner')
    w.credentials.keep(reference, values)
    const { after } = await w.crashAt('output')
    const old = w.runner().session
    const adopt = vi.spyOn(after.executor, 'adopt')
    const restarted = await w.restartRunner()
    const recovering = w.recover(after.recovery)
    await vi.waitFor(() => expect(w.journal.phases(2)).toContain('resumed'))
    expect(w.assignment().runner).toEqual({ id: 'sandbox-1', session: restarted.session })
    expect(adopt.mock.calls[0]![0]).toMatchObject({
      purpose: 'work',
      credentials: [values.llmApiKey, values.mcpToken, values.llmApiKey],
    })
    // A zombie of the old session is refused.
    await expect(
      after.hub!.report(
        'sandbox-1',
        runnerReportSchema.parse({
          type: 'quiesced',
          commandId: randomUUID(),
          runnerSession: old,
          assignmentId: w.assignment().id,
          epoch: 2,
        }),
      ),
    ).rejects.toMatchObject({ body: { error: 'SESSION_RETIRED' } })
    w.vm.finish()
    await recovering

    expect(w.credentials.recovered).toBe(1)
    expect(w.assignment()).toMatchObject({ outcome: 'completed', fence: { epoch: 2 } })
    expect(w.publish).toHaveBeenCalledOnce()
  })
})
