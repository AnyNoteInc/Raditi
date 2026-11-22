import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'

import { Logger } from '@nestjs/common'
import {
  badRequest,
  BROWSER_ONLY,
  conflict,
  DomainError,
  leaseLost,
  leftNothing,
  MAX_PRESIGN_TTL_MS,
  ENV_VALUE_MASK,
  MAX_SANDBOX_LEASE_MS,
  preparedRunLimits,
  SANDBOX_SECRETS_DIR,
  sandboxCommandFailed,
  snapshotHasCredential,
  subscriptionBusy,
  TURN_FINALIZE_MS,
  TURN_LEASE_TTL_MS,
  toTurnPlan,
  TURN_PUBLICATION_GRACE_MS,
  type AgentDriver,
  type AgentEvent,
  type ExecHandle,
  type ObjectStorage,
  type PreparedRun,
  type Sandbox,
  type SandboxInfo,
  type SecretStore,
  type SiteLeaseAuthority,
  type SiteLeaseGrant,
  type SiteLeaseFence,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnCredentialSource,
  type TurnEvidence,
  type TurnExecutor,
  type TurnRestoreSource,
  type TurnResult,
  hiddenFileStub,
  withoutTurnCredentials,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { createOpencodeDriver } from '@repo/agent-drivers'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { newTurnKeys } from '@repo/turn-keys'
import type { PresignedTransfer } from '@repo/snapshots'
import { memoryStorage, memoryTransit, tarZst } from '@repo/snapshots/testing'
import { LocalTurnExecutor, type LocalTurnExecutorDependencies } from '@repo/local-turns'

import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import {
  SnapshotService,
  type SealedElsewhere,
  type SnapshotParts,
} from '../sessions/snapshot.service.ts'
import { otherDriverId, sampleDriverId } from '../testing/ids.ts'
import { loopbackTransport } from '../testing/runner-loopback.ts'
import { SandboxRunner } from '../testing/runner-side.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { MemoryTurnCredentials, testTurnCredentialPolicy } from '../testing/turn-credentials.ts'
import { startGitWorker, type GitWorkerServer } from '../git-worker/server.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { GitWorkerClient } from '../git-workspace/worker-client.ts'
import { LiveTurns } from './live-turns.ts'
import { TurnPublicationRecovery } from './turn-recovery.ts'
import { REPO_BUNDLE_TIME } from './turn-repository.ts'

import {
  TurnSupervisor,
  type TurnRequest,
  type TurnSupervisorDependencies,
} from './turn-supervisor.ts'

/** Every pair turn-key.ts of @repo/turn-keys made: the one owner of the two key formats. */
const madeTurnKeys = vi.hoisted(() => [] as Array<{ llmApiKey: string; mcpToken: string }>)
vi.mock('@repo/turn-keys', async (importOriginal) => {
  const original = await importOriginal<{ newTurnKeys: typeof newTurnKeys }>()
  return {
    ...original,
    newTurnKeys: () => {
      const keys = original.newTurnKeys()
      madeTurnKeys.push(keys)
      return keys
    },
  }
})

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  // The lease of a turn is its chat (leaseScopeOf).
  siteId: '00000000-0000-4000-8000-000000000003',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 1,
}
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const home = {
  root: `/agent-home/${sampleDriverId}`,
  include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
  exclude: [],
}
const result: TurnResult = {
  summary: 'Готово',
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: ['page.txt'],
  questions: [],
  needs_approval: false,
  risk: 'low',
}
const nativeEvents: AgentEvent[] = [
  { type: 'started', nativeSessionId: 'native1' },
  { type: 'message', text: JSON.stringify(result) },
  { type: 'completed' },
]

interface CoreSide {
  leases: TurnSupervisorDependencies['leases']
  assignments: MemoryTurnAssignments
}

const cleanups: Array<() => Promise<void>> = []
/** Everything a runner logged during the test. */
const runnerLines: string[] = []
const runnerLogger = {
  log: (line: string) => runnerLines.push(line),
  warn: (line: string) => runnerLines.push(line),
  error: (line: string) => runnerLines.push(line),
}

/**
 * The whole suite runs against every executor over the same sandbox-side fakes: the supervisor
 * has one code path whether the container is in core's process or on a runner. The runner kind
 * is a real SandboxRunner in this process behind core's RunnerHub (loopback transport): every
 * step crosses the pull protocol, its keys and presigned requests included.
 */
const executors: Record<
  string,
  (sandboxSide: LocalTurnExecutorDependencies, core: CoreSide) => TurnExecutor
> = {
  local: (sandboxSide) => new LocalTurnExecutor(sandboxSide),
  runner: (sandboxSide, core) => {
    const hub = new RunnerHub({ ...core, logger: { warn: vi.fn() } })
    const transport = loopbackTransport(hub)
    const runner = new SandboxRunner({
      transport,
      executor: new LocalTurnExecutor(sandboxSide),
      maxTurns: 1,
      logger: runnerLogger,
    })
    runner.start()
    cleanups.push(async () => {
      await runner.stop()
      hub.close()
      // The runner zeroed every data key right after using it.
      expect(transport.keys.every((key) => key.every((byte) => byte === 0))).toBe(true)
    })
    return new RemoteTurnExecutor(hub, core.leases, core.assignments, () => '127.0.0.1')
  },
}
const executorKinds = Object.keys(executors)

function turnFixture(kind: string) {
  const order: string[] = []
  const evidence: TurnEvidence[] = []
  // A turn of a chat: no repository (docs/plan/83-remove-projects.md).
  const request: TurnRequest = {
    sandbox: {
      image,
      labels,
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: MAX_SANDBOX_LEASE_MS,
    },
    context: {
      taskId: labels.taskId,
      sessionId: labels.sessionId,
      turn: 1,
      llm: {
        baseUrl: 'http://synthetic.invalid',
        apiKey: 'synthetic-llm-secret',
        model: 'synthetic',
      },
      mcp: { url: 'http://synthetic.invalid/mcp', token: 'synthetic-mcp-secret' },
      instructions: 'Synthetic verification',
    },
    input: { prompt: 'Synthetic turn', attachments: [] },
    driverVersion: '1.0.0',
    requirements: { repository: false, browser: false },
    committedAt: '2026-09-26T00:00:00.000Z',
  }
  const prepared: PreparedRun = {
    context: request.context,
    files: [
      {
        path: `/agent-home/${sampleDriverId}/.config/opencode/opencode.json`,
        content: '{"synthetic":true}',
      },
    ],
    env: {},
    secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: request.context.llm.apiKey }],
  }
  let stdout = nativeEvents.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const handle: ExecHandle = {
    id: 'exec1',
    output: vi.fn(async function* () {
      yield { stream: 'stdout' as const, offset: 0, data: Buffer.from(stdout) }
    }),
    wait: vi.fn(async () => ({ code: 0, reason: 'exited' as const })),
    kill: vi.fn(async () => {
      order.push('kill')
    }),
  }
  const quiet = (): ExecHandle => ({
    id: 'exec-workdir',
    output: async function* () {},
    wait: async () => ({ code: 0, reason: 'exited' as const }),
    kill: vi.fn(async () => {}),
  })
  const sandbox: Sandbox = {
    id: 'container1',
    labels: { ...labels, leaseEpoch: 1 },
    deadline: Date.now() + 20 * 60_000,
    extend: vi.fn(async () => {}),
    exec: vi.fn(async (spec: { argv: string[] }) => {
      // The commands that make the empty working directory answer nothing (makeEmptyWorkdir).
      if (['test', 'mkdir', 'find'].includes(spec.argv[0] ?? '')) return quiet()
      order.push('exec')
      return handle
    }),
    attach: vi.fn(),
    fs: {
      write: vi.fn(async (path) => {
        order.push(`write:${path}`)
      }),
      read: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
    },
    quiesce: vi.fn(async () => {
      order.push('quiesce')
    }),
    destroy: vi.fn(async () => {
      order.push('destroy')
    }),
  }
  const grant = (ttlMs: number): SiteLeaseGrant => ({
    siteId: labels.siteId,
    taskId: labels.taskId,
    operation: 'turn',
    epoch: 1,
    serverNow: new Date(),
    expiresAt: new Date(Date.now() + ttlMs),
  })
  const lease = grant(150_000)
  const leases = {
    acquire: vi.fn(async (input: { ttlMs: number }) => grant(input.ttlMs)),
    renew: vi.fn(async (_fence: SiteLeaseFence, ttlMs: number) => grant(ttlMs)),
    assert: vi.fn(async () => true),
    release: vi.fn(async () => {
      order.push('release')
      return true
    }),
    inspect: vi.fn(async () => null),
    // The lease half of MemoryTurnAssignments.takeOver, not part of the port.
    takeOverHeld: vi.fn(async (_fence: SiteLeaseFence, ttlMs: number) => ({
      ...grant(ttlMs),
      epoch: 2,
    })),
    holdForRecovery: vi.fn(async () => {
      order.push('hold')
      return true
    }),
    free: vi.fn(async () => true),
  }
  const driver: AgentDriver = {
    id: sampleDriverId,
    image,
    cliVersion: '1.0.0',
    capabilities: {
      resume: true,
      jsonEvents: true,
      outputSchema: true,
      mcp: false,
      images: false,
      reasoningEvents: false,
      compaction: false,
    },
    prepare: vi.fn(async (context) => {
      order.push('prepare')
      return { ...prepared, context: { ...context } }
    }),
    command: vi.fn(() => ['synthetic-agent']),
    parseEvent: (line) => {
      try {
        return [JSON.parse(line) as AgentEvent]
      } catch {
        return []
      }
    },
    sessionState: vi.fn(() => home),
    extractResult: vi.fn((events: readonly AgentEvent[], lastMessage: string | null) => {
      const text = lastMessage ?? events.findLast((event) => event.type === 'message')?.text
      try {
        return JSON.parse(text ?? 'null') as unknown
      } catch {
        // As the real drivers: a final message that is no JSON carries no result.
        return null
      }
    }),
  }
  const archives = { home: Buffer.from('home') }
  const manifest = (metadata: SnapshotMetadata): SnapshotManifest => ({
    ...metadata,
    schemaVersion: 1,
    createdAt: request.committedAt,
    parts: [],
  })
  const snapshots = {
    save: vi.fn(
      async (
        metadata: SnapshotMetadata,
        _parts: SnapshotParts<SealedElsewhere>,
        _signal: AbortSignal,
      ) => {
        order.push('save')
        return manifest(metadata)
      },
    ),
    restoreSource: vi.fn(
      async (_reference: SnapshotReference, _ttlMs: number): Promise<TurnRestoreSource> => {
        throw new Error('This turn has no previous checkpoint')
      },
    ),
    load: vi.fn(async () => {
      order.push('load')
      return {
        manifest: manifest({
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: 1,
          image,
          driver: { id: sampleDriverId, version: '1.0.0', nativeSessionId: 'prior-native' },
          home,
        }),
        archives,
      }
    }),
  }
  const transport = {
    capture: vi.fn(async () => {
      order.push('capture')
      return archives
    }),
    restore: vi.fn(async () => {
      order.push('restore')
    }),
  }
  const journal = {
    record: vi.fn(async (entry: TurnEvidence) => {
      evidence.push(structuredClone(entry))
    }),
  }
  const sandboxes = {
    kind: 'docker' as const,
    create: vi.fn(async () => {
      order.push('create')
      return sandbox
    }),
    get: vi.fn(),
    getForRemoval: vi.fn(),
    list: vi.fn(async () => [] as SandboxInfo[]),
  }
  const transfer = {
    get: vi.fn<PresignedTransfer['get']>(async () => {
      throw new Error('No presigned object in this test')
    }),
    put: vi.fn<PresignedTransfer['put']>(async () => {
      throw new Error('No presigned object in this test')
    }),
  }
  const assignments = new MemoryTurnAssignments(leases)
  // One object both executors keep: a test may give it the import of a bundle.
  const sandboxSide: LocalTurnExecutorDependencies = {
    sandboxes,
    parser: () => driver,
    transport,
    transfer,
  }
  const executor = executors[kind]!(sandboxSide, { leases, assignments })
  const live = new LiveTurns()
  const credentials = new MemoryTurnCredentials({
    llmApiKey: request.context.llm.apiKey,
    mcpToken: request.context.mcp.token,
  })
  vi.spyOn(credentials, 'issue')
  vi.spyOn(credentials, 'revoke')
  const deps: TurnSupervisorDependencies = {
    leases,
    executor,
    assignments,
    driver,
    snapshots,
    journal,
    live,
    credentials,
  }
  return {
    request,
    prepared,
    order,
    evidence,
    deps,
    credentials,
    handle,
    sandbox,
    lease,
    leases,
    driver,
    snapshots,
    transport,
    journal,
    assignments,
    sandboxes,
    transfer,
    sandboxSide,
    stdout: (value: string) => {
      stdout = value
    },
    run: (signal?: AbortSignal) =>
      new TurnSupervisor(deps).run(
        withoutTurnCredentials(request),
        testTurnCredentialPolicy,
        signal,
      ),
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  // Nothing a runner logs names a presigned URL or a turn credential.
  expect(runnerLines.splice(0).join('\n')).not.toMatch(/s3\.invalid|X-Amz|synthetic-[a-z]+-secret/)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function useFakeClock(): void {
  vi.useFakeTimers()
  // The monotonic clock follows the fake clock, as it would on a real host.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
}

/** The mocked step takes `ms` of the fake clock before it answers. */
function takes<A extends unknown[], R>(mock: Mock<(...args: A) => Promise<R>>, ms: number): void {
  const step = mock.getMockImplementation()!
  mock.mockImplementation(async (...args: A) => {
    await vi.advanceTimersByTimeAsync(ms)
    return step(...args)
  })
}

type Fixture = ReturnType<typeof turnFixture>

/** The execs of the agent: the commands that make the empty working directory are not ones. */
const agentExecs = (f: Fixture) =>
  vi
    .mocked(f.sandbox.exec)
    .mock.calls.map(([spec]) => spec)
    .filter((spec) => !['test', 'mkdir', 'find'].includes(spec.argv[0] ?? ''))

/**
 * A run the driver's own output condemns is refused by the dry run before the lease, when the
 * stand-in credentials show it, and right after the turn's credentials were issued otherwise.
 * Either way the site is not left leased.
 */
function expectSiteFree(f: Fixture): void {
  expect(f.leases.release).toHaveBeenCalledTimes(f.leases.acquire.mock.calls.length)
  expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
}

describe.each(executorKinds)('PoC TurnSupervisor (%s executor)', (kind) => {
  const fixture = () => turnFixture(kind)

  it('refuses an action of a turn without a checkpoint before taking a lease', async () => {
    const f = fixture()
    f.request.input = { ...f.request.input, attachments: [], action: 'compact' }
    await expect(f.run()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'An action of a turn needs the checkpoint of an earlier turn',
    })
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it('asks the pool before the lease and leaves nothing of the turn when it sends the pass back', async () => {
    const f = fixture()
    const admit = vi.fn<NonNullable<TurnCredentialSource['admit']>>(async () => {
      throw subscriptionBusy(new Date(Date.now() + 60_000))
    })
    f.credentials.admit = admit
    const open = vi.spyOn(f.assignments, 'open')
    await expect(f.run()).rejects.toMatchObject({ code: 'SUBSCRIPTION_BUSY' })
    expect(admit).toHaveBeenCalledWith(
      labels.taskId,
      expect.objectContaining({ backend: expect.any(String) }),
    )
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(f.credentials.issue).not.toHaveBeenCalled()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('closes credential intent when issuance fails before creating a container', async () => {
    const f = fixture()
    vi.mocked(f.credentials.issue).mockRejectedValueOnce(new Error('Synthetic issuance failure'))
    await expect(f.run()).rejects.toThrow('Synthetic issuance failure')
    expect(f.credentials.revoke).toHaveBeenCalledOnce()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it('refuses supplied keys and a mismatched policy before leasing', async () => {
    const f = fixture()
    const supervisor = new TurnSupervisor(f.deps)
    await expect(supervisor.run(f.request, testTurnCredentialPolicy)).rejects.toThrow()
    await expect(
      supervisor.run(withoutTurnCredentials(f.request), {
        ...testTurnCredentialPolicy,
        driverId: otherDriverId,
      }),
    ).rejects.toThrow()
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.credentials.issue).not.toHaveBeenCalled()
  })

  it.each(['medium', null])(
    'persists and prepares the issued reasoning profile %s when the request omits it',
    async (reasoningEffort) => {
      const f = fixture()
      await new TurnSupervisor(f.deps).run(withoutTurnCredentials(f.request), {
        ...testTurnCredentialPolicy,
        reasoningEffort,
      })
      const assignment = [...f.assignments.rows.values()][0]!
      expect(assignment.plan.context.llm.reasoningEffort).toBe(reasoningEffort)
      expect(f.driver.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ llm: expect.objectContaining({ reasoningEffort }) }),
      )
      expect(f.credentials.issue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reasoningEffort }),
      )
      expect(f.request.context.llm).not.toHaveProperty('reasoningEffort')
    },
  )

  it.each(['medium', null])('accepts an explicit matching reasoning profile %s', async (effort) => {
    const f = fixture()
    f.request.context.llm.reasoningEffort = effort
    await new TurnSupervisor(f.deps).run(withoutTurnCredentials(f.request), {
      ...testTurnCredentialPolicy,
      reasoningEffort: effort,
    })
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ llm: expect.objectContaining({ reasoningEffort: effort }) }),
    )
  })

  it.each([
    ['high', 'medium'],
    ['low', null],
    [null, 'medium'],
  ])('refuses reasoning profile %s under policy %s before leasing', async (effort, allowed) => {
    const f = fixture()
    f.request.context.llm.reasoningEffort = effort
    await expect(
      new TurnSupervisor(f.deps).run(withoutTurnCredentials(f.request), {
        ...testTurnCredentialPolicy,
        reasoningEffort: allowed,
      }),
    ).rejects.toThrow('Turn reasoning effort differs from credential policy')
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.credentials.issue).not.toHaveBeenCalled()
    expect(f.driver.prepare).not.toHaveBeenCalled()
  })

  it('refuses a turn its driver cannot launch before the lease and the key', async () => {
    const f = fixture()
    vi.mocked(f.driver.command).mockImplementation(() => {
      throw badRequest('Synthetic driver refuses this turn input')
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.assignments.rows.size).toBe(0)
    expect(f.credentials.issue).not.toHaveBeenCalled()
    // The dry run saw stand-ins, never a credential of the turn: none was issued yet.
    expect(JSON.stringify(vi.mocked(f.driver.prepare).mock.calls)).not.toMatch(
      /synthetic-[a-z]+-secret/,
    )
  })

  it('takes the stand-in credentials of its dry run from the owner of the turn key formats', async () => {
    const f = fixture()
    madeTurnKeys.length = 0
    // The turn ends right after the dry run: the site is busy.
    f.leases.acquire.mockResolvedValueOnce(null as never)
    await expect(f.run()).rejects.toMatchObject({ code: 'SITE_BUSY' })
    // One pair, made by llm/turn-key.ts: the supervisor spells neither format itself, so the
    // dry run always sees what the driver will get from the turn's real credentials.
    expect(madeTurnKeys).toHaveLength(1)
    const [context] = vi.mocked(f.driver.prepare).mock.calls[0]!
    expect({ llmApiKey: context.llm.apiKey, mcpToken: context.mcp.token }).toEqual(madeTurnKeys[0])
  })

  it.each([['opencode', createOpencodeDriver({ image }), 'zai-coding', 'high', 'medium']] as const)(
    'refuses a reasoning profile the real %s driver cannot launch before the lease',
    async (driverId, driver, backend, known, unknown) => {
      const f = fixture()
      f.deps.driver = driver
      const policy = { ...testTurnCredentialPolicy, driverId, backend }
      const run = (reasoningEffort: string | null) =>
        new TurnSupervisor(f.deps).run(withoutTurnCredentials(f.request), {
          ...policy,
          reasoningEffort,
        })
      // The provider default (null) is a profile no CLI is launched with.
      for (const effort of [null, unknown])
        await expect(run(effort)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(f.leases.acquire).not.toHaveBeenCalled()
      expect(f.credentials.issue).not.toHaveBeenCalled()
      // A profile of this driver passes the same dry run and reaches the lease.
      f.leases.acquire.mockResolvedValueOnce(null as never)
      await expect(run(known)).rejects.toMatchObject({ code: 'SITE_BUSY' })
    },
  )

  it('runs an agent for hours: no time limit, its container extended, the steps after it saved', async () => {
    // docs/plan/70-turn-without-time-limit.md, ВР1: only the agent, its credits, «Остановить» or a
    // lost platform end a turn.
    const f = fixture()
    useFakeClock()
    const startedAt = Date.now()
    vi.mocked(f.handle.wait).mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
      return { code: 0, reason: 'exited' }
    })
    takes(f.transport.capture, 30_000)
    takes(f.snapshots.save, 30_000)
    await expect(f.run()).resolves.toMatchObject({ result })
    expect(agentExecs(f)[0]!.timeoutMs).toBeUndefined()
    // The container starts with one lease and is extended with every renewal of the turn.
    expect(f.sandboxes.create).toHaveBeenCalledWith(
      expect.objectContaining({ hardTimeoutMs: expect.any(Number) }),
      expect.any(AbortSignal),
    )
    const [created] = f.sandboxes.create.mock.calls as unknown as [[{ hardTimeoutMs: number }]]
    expect(created[0].hardTimeoutMs).toBeLessThanOrEqual(TURN_LEASE_TTL_MS)
    expect(vi.mocked(f.sandbox.extend).mock.calls.length).toBeGreaterThan(200)
    expect(f.leases.renew.mock.calls.length).toBeGreaterThan(200)
    expect(f.order).toEqual(expect.arrayContaining(['capture', 'save']))
    expect(f.evidence.at(-1)?.phase).toBe('completed')
    expect(Date.now() - startedAt).toBeGreaterThan(2 * 60 * 60_000)
  })

  it('is lost, not timed out, when its renewals stop for longer than a lease', async () => {
    const f = fixture()
    useFakeClock()
    let killed = false
    vi.mocked(f.handle.kill).mockImplementation(async () => {
      killed = true
    })
    vi.mocked(f.handle.wait).mockImplementation(async () => {
      for (let waited = 0; !killed && waited < 30 * 60_000; waited += 1_000)
        await vi.advanceTimersByTimeAsync(1_000)
      return { code: null, reason: killed ? 'cancelled' : 'exited' }
    })
    f.leases.renew.mockRejectedValue(new Error('database down'))
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED', message: 'lease_lost' })
    expect(f.evidence.some((entry) => entry.reason === 'timeout')).toBe(false)
  })

  it('holds the site when a snapshot save never answers', async () => {
    const f = fixture()
    useFakeClock()
    f.snapshots.save.mockImplementation(() => new Promise(() => {}))
    let settled = false
    const rejected = expect(
      f.run().finally(() => {
        settled = true
      }),
    ).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    await vi.advanceTimersByTimeAsync(TURN_FINALIZE_MS)
    // It may still be before its reservation: the supervisor waits for its answer a while.
    expect(settled).toBe(false)
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TURN_PUBLICATION_GRACE_MS)
    await rejected
    // The abandoned save sees the abort and must not write anything later.
    expect(f.snapshots.save.mock.calls[0]![2].aborted).toBe(true)
    expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'recovery', reason: 'timeout' })
  })

  it.each([
    ['timeout', undefined],
    ['cancelled', new AbortController()],
  ] as const)(
    'releases the site when a %s stops a save before its reservation',
    async (reason, cancellation) => {
      const f = fixture()
      useFakeClock()
      f.snapshots.save.mockImplementation((_metadata, _archives, signal) => {
        const refused = new Promise<never>((_resolve, reject) => {
          // Vault answers 10 s after the abort; the save then reserves nothing and says so.
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              reject(new DomainError('SNAPSHOT_NOT_WRITTEN', 'Snapshot save was interrupted', 409))
            }, 10_000)
          })
        })
        cancellation?.abort()
        return refused
      })
      const rejected = expect(f.run(cancellation?.signal)).rejects.toMatchObject({
        code: 'TURN_INTERRUPTED',
        message: reason,
      })
      if (!cancellation) await vi.advanceTimersByTimeAsync(TURN_FINALIZE_MS)
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(f.snapshots.save).toHaveBeenCalledOnce()
      expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
      expect(f.leases.release).toHaveBeenCalledOnce()
      // Why the site was released without a checkpoint: the interruption, and no prefix.
      expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason })
      expect(f.evidence.at(-1)).not.toHaveProperty('snapshotPrefix')
    },
  )

  it('masks the client variables of the turn in its journal and refuses them in its home (Р13)', async () => {
    const f = fixture()
    const value = 'pay-se"cret-0001'
    vi.mocked(f.credentials.issue).mockResolvedValue({
      llmApiKey: f.request.context.llm.apiKey,
      mcpToken: f.request.context.mcp.token,
      envValues: { PAYMENT_KEY: value },
    })
    const events: AgentEvent[] = [
      nativeEvents[0]!,
      { type: 'message', text: `Ключ: ${value}; в JSON: ${JSON.stringify({ key: value })}` },
      ...nativeEvents.slice(1),
    ]
    f.stdout(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const finished = await f.run()
    expect(finished.result).toEqual(result)
    const journaled = JSON.stringify(f.evidence)
    expect(journaled).not.toContain('cret-0001')
    expect(
      f.evidence.flatMap((entry) => entry.events ?? []).find((event) => event.type === 'message'),
    ).toEqual({
      type: 'message',
      text: `Ключ: ${ENV_VALUE_MASK}; в JSON: ${JSON.stringify({ key: ENV_VALUE_MASK })}`,
    })
    // The executor masks them before the parser and refuses a home archive that holds one.
    expect(f.transport.capture).toHaveBeenCalledWith(f.sandbox, home, expect.any(Array), [value])
    // Nothing of them in the plan the assignment keeps.
    expect(JSON.stringify([...f.assignments.rows.values()])).not.toContain('cret-0001')
  })

  it('keeps the hold when an interrupted save still commits its snapshot', async () => {
    const f = fixture()
    const cancellation = new AbortController()
    const saved = Promise.withResolvers<SnapshotManifest>()
    f.snapshots.save.mockImplementation(async () => {
      cancellation.abort()
      return saved.promise
    })
    const rejected = expect(f.run(cancellation.signal)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    await vi.waitFor(() => expect(f.snapshots.save).toHaveBeenCalledOnce())
    saved.resolve({} as SnapshotManifest)
    await rejected
    expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'recovery', reason: 'cancelled' })
  })

  /** The committed checkpoint of turn 1: its home part alone. */
  async function checkpointOfTurnOne(f: Fixture) {
    const memory = memoryStorage()
    const transit = memoryTransit()
    const service = new SnapshotService(memory.storage, transit.secrets)
    const prior = { home: await tarZst({ [home.include[0]!]: 'prior conversation' }) }
    await service.save(
      {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0', nativeSessionId: 'prior-native' },
        home,
      },
      prior,
    )
    f.snapshots.restoreSource.mockImplementation((reference, ttlMs) =>
      service.restoreSource(reference, ttlMs),
    )
    f.transfer.get.mockImplementation(memory.transfer.get)
    const reference: SnapshotReference = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    }
    return { prior, transit, reference }
  }

  it('carries out an action over the restored session: no words of the model are its result', async () => {
    const f = fixture()
    const { reference } = await checkpointOfTurnOne(f)
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = reference
    f.request.input = { ...f.request.input, attachments: [], action: 'compact' }
    // As the driver does: an action has no meaning without the session it acts on.
    vi.mocked(f.driver.command).mockImplementation((run) => {
      if (!run.context.nativeSessionId) throw new Error('An action needs a session')
      return ['synthetic-agent']
    })
    vi.mocked(f.driver.extractResult).mockReturnValue(null)

    const { result: ended } = await f.run()

    expect(ended).toMatchObject({ change_type: 'none', files_changed: [], questions: [] })
    expect(ended.client_message).toBe(
      'Готово: переписка сжата. Агент продолжит с её кратким пересказом.',
    )
    expect(f.driver.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ nativeSessionId: 'prior-native' }),
    )
    expect(vi.mocked(f.driver.command).mock.calls.at(-1)![1].action).toBe('compact')
  })

  // The owner, 06.11.2026: «необходимо продолжать сессию» — after an edit or «Обновить» too.
  it('restores turn n−1 through presigned GETs before installing the new turn secrets', async () => {
    const f = fixture()
    const { prior, transit, reference } = await checkpointOfTurnOne(f)
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = reference
    await f.run()
    expect(f.transport.restore).toHaveBeenCalledWith(f.sandbox, home, {
      home: Buffer.from(prior.home),
    })
    const ttlMs = f.snapshots.restoreSource.mock.calls[0]![1]
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(MAX_PRESIGN_TTL_MS)
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ nativeSessionId: 'prior-native' }),
    )
    // Recovery derives the session state from the journal: the resumed session is recorded.
    expect(f.evidence.find((entry) => entry.phase === 'restored')).toMatchObject({
      nativeSessionId: 'prior-native',
    })
    expect(f.order.indexOf(`write:${SANDBOX_SECRETS_DIR}/llm`)).toBeGreaterThan(
      f.order.indexOf('restore'),
    )
    // The data key reached the sandbox side only to open the parts, and was zeroed there.
    expect(transit.secrets.transitDecryptDataKey).toHaveBeenCalledOnce()
    expect(transit.allZeroed()).toBe(true)
  })

  it('seals the home part in the sandbox and commits a snapshot core can load back', async () => {
    const f = fixture()
    const memory = memoryStorage()
    const transit = memoryTransit()
    const service = new SnapshotService(memory.storage, transit.secrets)
    const captured = { home: Buffer.from(await tarZst({ [home.include[0]!]: 'native session' })) }
    f.transport.capture.mockResolvedValue(captured)
    f.transfer.put.mockImplementation(memory.transfer.put)
    f.snapshots.save.mockImplementation((metadata, parts, signal) =>
      service.save(metadata, parts, signal),
    )
    const finished = await f.run()
    const loaded = await service.load({
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    })
    expect(finished.manifest).toEqual(loaded.manifest)
    expect(loaded.manifest).not.toHaveProperty('git')
    expect(Buffer.from(loaded.archives.home)).toEqual(Buffer.from(captured.home))
    expect(loaded.archives).not.toHaveProperty('patch')
    // The home part went only through the create-only PUT, never through core's own writes.
    expect(f.transfer.put).toHaveBeenCalledOnce()
    expect(memory.storage.put.mock.calls.map(([, key]) => key)).not.toContain(
      `sessions/${labels.sessionId}/turns/0001/home.tar.zst`,
    )
    expect(memory.storage.presign).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'PUT', sizeBytes: captured.home.byteLength }),
    )
    expect(transit.allZeroed()).toBe(true)
  })

  it('hands the sandbox neither the PUT nor the data key once the site is lost', async () => {
    const f = fixture()
    const memory = memoryStorage()
    const transit = memoryTransit()
    const service = new SnapshotService(memory.storage, transit.secrets)
    f.transport.capture.mockResolvedValue({
      home: Buffer.from(await tarZst({ [home.include[0]!]: 'native session' })),
    })
    f.transfer.put.mockImplementation(memory.transfer.put)
    f.snapshots.save.mockImplementation((metadata, parts, signal) =>
      service.save(metadata, parts, signal),
    )
    const issue = transit.secrets.transitDataKey.getMockImplementation()!
    transit.secrets.transitDataKey.mockImplementationOnce(async (...args) => {
      // Another owner takes the site while the snapshot is sealed and reserved.
      f.leases.assert.mockResolvedValue(false)
      return issue(...args)
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED', message: 'lease_lost' })
    expect(f.transfer.put).not.toHaveBeenCalled()
    expect(transit.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
    // The reservation is written: the site waits for an operator.
    expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'recovery', reason: 'lease_lost' })
  })

  /** A create that answers only when `created` resolves, after the turn was cancelled. */
  function lateCreate(f: Fixture) {
    const cancellation = new AbortController()
    const created = Promise.withResolvers<void>()
    const create = f.sandboxes.create.getMockImplementation()!
    f.sandboxes.create.mockImplementation(async (...args) => {
      cancellation.abort()
      await created.promise
      return create(...args)
    })
    return { cancellation, created }
  }
  const outcome = (f: Fixture) => [...f.assignments.rows.values()][0]?.outcome

  it('keeps the lease while a container the executor may still create is unaccounted for', async () => {
    const f = fixture()
    const { cancellation, created } = lateCreate(f)
    await expect(f.run(cancellation.signal)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
      message: 'cancelled',
    })
    // No proof that no container is left: neither released nor held, it expires by itself.
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'vacating', reason: 'cancelled' })
    expect(outcome(f)).toBeNull()

    // The late container is removed at once, and only then is the site freed.
    created.resolve()
    await vi.waitFor(() => expect(outcome(f)).toBe('failed'))
    expect(f.sandbox.destroy).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.order.indexOf('destroy')).toBeLessThan(f.order.indexOf('release'))
    expect(f.evidence.map((entry) => entry.phase).slice(-3)).toEqual([
      'vacating',
      'vacating',
      'failed',
    ])
    expect(f.evidence.at(-2)).toMatchObject({ reason: 'cancelled', containerId: f.sandbox.id })
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(agentExecs(f)).toEqual([])
  })

  it('frees the site at once when the turn is given up before its prepare went out', async () => {
    const f = fixture()
    const cancellation = new AbortController()
    const prepare = vi.mocked(f.driver.prepare).getMockImplementation()!
    vi.mocked(f.driver.prepare)
      // The dry run before the lease.
      .mockImplementationOnce(prepare)
      .mockImplementationOnce(async (context) => {
        cancellation.abort()
        return prepare(context)
      })
    await expect(f.run(cancellation.signal)).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'cancelled' })
    expect(outcome(f)).toBe('failed')
  })

  it('waits for the lease to expire when a failed create proves nothing', async () => {
    const f = fixture()
    f.sandboxes.create.mockRejectedValue(new Error('daemon did not answer'))
    await expect(f.run()).rejects.toThrow()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'vacating', reason: 'run_failed' })
    expect(outcome(f)).toBeNull()
  })

  it('frees the site at once when the provider proves a failed create left nothing', async () => {
    const f = fixture()
    f.sandboxes.create.mockRejectedValue(leftNothing(sandboxCommandFailed()))
    await expect(f.run()).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
    expect(outcome(f)).toBe('failed')
  })

  it('holds the site for recovery when a late container cannot be removed, whatever comes later', async () => {
    const f = fixture()
    const prepare = vi.spyOn(f.deps.executor, 'prepare')
    const { cancellation, created } = lateCreate(f)
    vi.mocked(f.sandbox.destroy).mockRejectedValue(new Error('unreachable daemon'))
    await expect(f.run(cancellation.signal)).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    created.resolve()
    await vi.waitFor(() => expect(f.evidence.at(-1)?.phase).toBe('recovery'))
    expect(f.evidence.at(-1)).toMatchObject({
      reason: 'destroy_failed',
      containerId: f.sandbox.id,
    })
    expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
    // A proof that arrives now changes nothing: recovery removes the container and ends the turn.
    prepare.mock.calls[0]![0].vacated()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(outcome(f)).toBeNull()
    expect(f.evidence.at(-1)?.phase).toBe('recovery')
  })

  it('leaves a late container to recovery once it took the turn over under a newer epoch', async () => {
    const f = fixture()
    const { cancellation, created } = lateCreate(f)
    vi.mocked(f.sandbox.destroy).mockRejectedValue(new Error('removed by recovery meanwhile'))
    await expect(f.run(cancellation.signal)).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    f.leases.inspect.mockResolvedValue({
      siteId: labels.siteId,
      taskId: labels.taskId,
      operation: 'turn',
      epoch: 2,
      expiresAt: new Date(Date.now() + 60_000),
      serverNow: new Date(),
      heldForOperator: false,
    } satisfies SiteLeaseAuthority as never)
    created.resolve()
    await vi.waitFor(() => expect(f.sandbox.destroy).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'vacating', containerId: f.sandbox.id })
    expect(outcome(f)).toBeNull()
  })

  it('rejects eager secrets and cross-task identities before acquiring a lease', async () => {
    const f = fixture()
    f.request.sandbox.secrets = [{ path: `${SANDBOX_SECRETS_DIR}/bad`, value: 'secret' }]
    await expect(f.run()).rejects.toThrow('only after restore')
    f.request.sandbox.secrets = []
    f.request.context.taskId = 'wrong'
    await expect(f.run()).rejects.toThrow('identity')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it('does not create a container without a lease', async () => {
    const f = fixture()
    f.leases.acquire.mockResolvedValueOnce(null as never)
    await expect(f.run()).rejects.toMatchObject({ code: 'SITE_BUSY' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it.each([
    ['another operation owns it', false, null, 'SITE_BUSY'],
    ['it waits for an operator', true, null, 'SITE_HELD'],
    ['the lease lookup fails', undefined, null, 'SITE_BUSY'],
  ] as const)('tells the client why a chat is refused: %s', async (_, held, _release, code) => {
    const f = fixture()
    f.leases.acquire.mockResolvedValueOnce(null as never)
    if (held === undefined) f.leases.inspect.mockRejectedValueOnce(new Error('connection reset'))
    else
      f.leases.inspect.mockResolvedValueOnce({
        siteId: labels.siteId,
        taskId: '00000000-0000-4000-8000-000000000009',
        operation: 'turn',
        epoch: 7,
        expiresAt: new Date(),
        serverNow: new Date(),
        heldForOperator: held,
      } satisfies SiteLeaseAuthority as never)
    await expect(f.run()).rejects.toMatchObject({ code, httpStatus: 409 })
    expect(f.leases.inspect).toHaveBeenCalledWith(labels.siteId)
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('rejects an issued turn credential in container env before creating the container', async () => {
    const f = fixture()
    f.request.sandbox.env = { AGENT_FLAGS: `--auth=${f.request.context.mcp.token}` }
    await expect(f.run()).rejects.toThrow('env contains a turn credential')
    expect(f.credentials.revoke).toHaveBeenCalledOnce()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<SnapshotReference>]>([
    ['workspace', { workspaceId: '00000000-0000-4000-8000-000000000009' }],
    ['session', { sessionId: 'other-session' }],
    ['turn', { turn: 2 }],
    ['driver', { driver: { id: otherDriverId, version: '1.0.0' } }],
    ['driver version', { driver: { id: sampleDriverId, version: '2.0.0' } }],
  ])('rejects a foreign previous checkpoint (%s) before acquiring a lease', async (_, change) => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
      ...change,
    }
    await expect(f.run()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.snapshots.restoreSource).not.toHaveBeenCalled()
  })

  it.each(['', 'bad version', '-1.0', 'v'.repeat(65)])(
    'rejects driver version %j that the snapshot manifest would refuse, before the lease',
    async (driverVersion) => {
      const f = fixture()
      f.request.driverVersion = driverVersion
      await expect(f.run()).rejects.toThrow('snapshot metadata')
      expect(f.leases.acquire).not.toHaveBeenCalled()
    },
  )

  it('does not accept completed output when the process exits unsuccessfully', async () => {
    const f = fixture()
    vi.mocked(f.handle.wait).mockResolvedValue({ code: 1, reason: 'exited' })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_EXEC_FAILED' })
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'run_failed',
      exit: { code: 1, reason: 'exited' },
    })
  })

  it('journals the exec limit it ran into as the turn running out of time', async () => {
    const f = fixture()
    // The runner ends the agent at the turn's deadline less the finalize reserve, before the
    // guard's own timer: the turn ran out of time, not into a technical failure.
    vi.mocked(f.handle.wait).mockResolvedValue({ code: null, reason: 'timeout' })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_EXEC_FAILED' })
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'timeout',
      outcome: 'failed',
      exit: { code: null, reason: 'timeout' },
    })
  })

  it('does not accept a result after a failure the agent reported, whatever its exit code', async () => {
    const f = fixture()
    // A CLI may go on after an error row, print a complete answer and exit with code 0.
    const [started, ...answer] = nativeEvents
    f.stdout(
      [started, { type: 'failed', reason: 'stream error' }, started, ...answer]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    )
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_EXEC_FAILED' })
    expect(f.driver.extractResult).not.toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it.each(['snapshot'] as const)(
    'holds ambiguous %s failures with durable recovery evidence',
    async (point) => {
      const f = fixture()
      f.snapshots.save.mockRejectedValueOnce(new Error('credential-must-not-be-recorded'))
      await expect(f.run()).rejects.toThrow()
      expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
      expect(f.leases.release).not.toHaveBeenCalled()
      expect(f.sandbox.destroy).toHaveBeenCalledOnce()
      expect(f.evidence.at(-1)).toMatchObject({
        phase: 'recovery',
        reason: `${point}_ambiguous`,
      })
      expect(JSON.stringify(f.evidence)).not.toContain('credential-must-not-be-recorded')
    },
  )

  it.each([
    ['SNAPSHOT_NOT_WRITTEN', 502],
    ['SNAPSHOT_TOO_LARGE', 413],
    ['PUBLICATION_TOO_LARGE', 413],
  ])('releases the site when the snapshot provably wrote nothing (%s)', async (code, status) => {
    const f = fixture()
    f.snapshots.save.mockRejectedValueOnce(new DomainError(code, 'nothing was written', status))
    await expect(f.run()).rejects.toMatchObject({ code })
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
    expect(f.evidence.at(-1)).not.toHaveProperty('snapshotPrefix')
  })

  // The home part is sealed where it was captured: core checks its session state.
  it.each(['home'] as const)(
    'releases the site when the snapshot service refuses invalid %s before writing',
    async (part) => {
      const f = fixture()
      const storage = {
        putIfAbsent: vi.fn(),
        put: vi.fn(),
        get: vi.fn(),
        exists: vi.fn(),
        delete: vi.fn(),
        checkBuckets: vi.fn(),
      }
      const secrets = { transitDataKey: vi.fn(), transitDecryptDataKey: vi.fn() }
      const service = new SnapshotService(
        storage as unknown as ObjectStorage,
        secrets as unknown as SecretStore,
      )
      // The fixture archives are not valid tar.zst; `home` fails its own schema first.
      if (part === 'home')
        vi.mocked(f.driver.sessionState).mockReturnValue({ ...home, root: '/workspace/repo' })
      f.snapshots.save.mockImplementation((metadata, archives, signal) =>
        service.save(metadata, archives, signal),
      )
      // A runner is not even asked to capture an invalid home, as the local capture refuses it.
      await expect(f.run()).rejects.toMatchObject({
        code: kind === 'runner' && part === 'home' ? 'BAD_REQUEST' : 'SNAPSHOT_NOT_WRITTEN',
      })
      expect(storage.putIfAbsent).not.toHaveBeenCalled()
      expect(storage.put).not.toHaveBeenCalled()
      expect(secrets.transitDataKey).not.toHaveBeenCalled()
      expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
      expect(f.leases.release).toHaveBeenCalledOnce()
      expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
    },
  )

  it.each(['SNAPSHOT_SAVE_FAILED', 'CONFLICT', 'NOT_FOUND'])(
    'keeps every other snapshot error (%s) ambiguous',
    async (code) => {
      const f = fixture()
      f.snapshots.save.mockRejectedValueOnce(new DomainError(code, 'synthetic', 502))
      await expect(f.run()).rejects.toMatchObject({ code })
      expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
      expect(f.leases.release).not.toHaveBeenCalled()
      expect(f.evidence.at(-1)).toMatchObject({ phase: 'recovery', reason: 'snapshot_ambiguous' })
    },
  )

  it('assigns the turn with its plan and without its credentials, then finishes it', async () => {
    const f = fixture()
    const open = vi.spyOn(f.assignments, 'open')
    const prepare = vi.spyOn(f.deps.executor, 'prepare')
    await f.run()
    const [assignment] = [...f.assignments.rows.values()]
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        fence: expect.objectContaining({ epoch: 1 }),
        sessionId: labels.sessionId,
        turn: 1,
        executor: kind,
      }),
    )
    expect(assignment).toMatchObject({
      outcome: 'completed',
      plan: { committedAt: f.request.committedAt, driverId: sampleDriverId },
    })
    expect(JSON.stringify(assignment!.plan)).not.toContain('synthetic-llm-secret')
    expect(JSON.stringify(assignment!.plan)).not.toContain('synthetic-mcp-secret')
    expect(prepare.mock.calls[0]![0].assignmentId).toBe(assignment!.id)
  })

  it('tells recovery the fence it drives from the lease until the turn settled', async () => {
    const f = fixture()
    let during = false
    vi.mocked(f.credentials.issue).mockImplementationOnce(async () => {
      during = f.deps.live.has(f.lease)
      throw new Error('issuance failed')
    })
    await expect(f.run()).rejects.toThrow('issuance failed')
    expect(during).toBe(true)
    expect(f.deps.live.has(f.lease)).toBe(false)
  })

  it('finishes a failed turn once its container is gone and keeps a held one assigned', async () => {
    const failed = fixture()
    failed.stdout('not json\n')
    await expect(failed.run()).rejects.toThrow()
    expect([...failed.assignments.rows.values()]).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ])

    const held = fixture()
    vi.mocked(held.sandbox.destroy).mockRejectedValue(new Error('unreachable daemon'))
    await expect(held.run()).rejects.toThrow()
    expect(held.leases.holdForRecovery).toHaveBeenCalled()
    expect([...held.assignments.rows.values()]).toEqual([
      expect.objectContaining({ outcome: null }),
    ])
  })

  it('refuses a second unfinished assignment of the turn before anything is built', async () => {
    const f = fixture()
    await f.assignments.open({
      fence: f.lease,
      sessionId: labels.sessionId,
      turn: 1,
      executor: kind === 'local' ? 'local' : 'runner',
      plan: toTurnPlan(f.request, sampleDriverId),
      remainingMs: 60_000,
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
  })

  it('holds a site when container deletion remains uncertain', async () => {
    const f = fixture()
    vi.mocked(f.sandbox.destroy).mockRejectedValue(new Error('unreachable daemon'))
    await expect(f.run()).rejects.toThrow()
    expect(f.leases.holdForRecovery).toHaveBeenCalled()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ reason: 'destroy_failed' })
  })

  it('fences a stale owner before the next operation and still destroys its container', async () => {
    const f = fixture()
    const create = f.sandboxes.create.getMockImplementation()!
    f.sandboxes.create.mockImplementation(async (...args) => {
      f.leases.assert.mockResolvedValue(false)
      return create(...args)
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(agentExecs(f)).toEqual([])
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
  })

  it('aborts a running process on cancellation and never snapshots it', async () => {
    const f = fixture()
    const cancellation = new AbortController()
    vi.mocked(f.sandbox.exec).mockImplementation(async () => {
      cancellation.abort()
      return f.handle
    })
    await expect(f.run(cancellation.signal)).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(f.handle.kill).toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
    expect(f.snapshots.save).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'refuses a known credential before journaling, including escaped JSON (%s)',
    async (escaped) => {
      const f = fixture()
      let line = JSON.stringify({ type: 'message', text: f.request.context.llm.apiKey })
      if (escaped) line = line.replace('synthetic-', '\\u0073ynthetic-')
      f.stdout(line + '\n')
      await expect(f.run()).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
      expect(f.evidence.every((entry) => !entry.events?.length)).toBe(true)
      expect(JSON.stringify(f.evidence)).not.toContain(f.request.context.llm.apiKey)
      expect(f.snapshots.save).not.toHaveBeenCalled()
    },
  )

  it('keeps the agent running through a lease read error while it prints', async () => {
    const f = fixture()
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    vi.mocked(f.handle.output).mockImplementation(async function* () {
      f.leases.assert.mockRejectedValueOnce(new Error('connection reset'))
      yield {
        stream: 'stdout' as const,
        offset: 0,
        data: Buffer.from(nativeEvents.map((event) => JSON.stringify(event)).join('\n') + '\n'),
      }
    })
    await expect(f.run()).resolves.toMatchObject({ result })
    expect(warn).toHaveBeenCalledWith('site lease check failed, retrying: connection reset')
    expect(f.handle.kill).not.toHaveBeenCalled()
    expect(f.evidence.map((entry) => entry.phase)).toContain('output')
    expect(f.evidence.at(-1)?.phase).toBe('completed')
  })

  it('stops the agent as lease_lost when the fence is explicitly lost while it prints', async () => {
    const f = fixture()
    vi.mocked(f.handle.output).mockImplementation(async function* () {
      f.leases.assert.mockResolvedValue(false)
      yield {
        stream: 'stdout' as const,
        offset: 0,
        data: Buffer.from(JSON.stringify(nativeEvents[0]) + '\n'),
      }
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED', message: 'lease_lost' })
    expect(f.handle.kill).toHaveBeenCalled()
    expect(f.evidence.some((entry) => entry.phase === 'output')).toBe(false)
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'lease_lost' })
    expect(f.snapshots.save).not.toHaveBeenCalled()
  })

  it('records a journal outage while the agent prints as run_failed, not a lost lease', async () => {
    const f = fixture()
    f.journal.record.mockImplementation(async (entry) => {
      if (entry.phase === 'output') throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      f.evidence.push(structuredClone(entry))
    })
    await expect(f.run()).rejects.toThrow('ECONNREFUSED')
    expect(f.handle.kill).toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.snapshots.save).not.toHaveBeenCalled()
  })

  it('records a fenced journal insert that lost the lease as lease_lost', async () => {
    const f = fixture()
    f.journal.record.mockImplementation(async (entry) => {
      if (entry.phase === 'output') throw leaseLost('Turn evidence no longer owns its site lease')
      f.evidence.push(structuredClone(entry))
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'lease_lost' })
    expect(f.snapshots.save).not.toHaveBeenCalled()
  })

  it('releases the site when the final failed entry cannot be journaled and nothing was written', async () => {
    const f = fixture()
    vi.mocked(f.handle.wait).mockResolvedValue({ code: 1, reason: 'exited' })
    f.journal.record.mockImplementation(async (entry) => {
      if (entry.phase === 'failed') throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      f.evidence.push(structuredClone(entry))
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_EXEC_FAILED' })
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it('leaves the lease to its TTL when neither the journal nor the release answers', async () => {
    const f = fixture()
    vi.mocked(f.handle.wait).mockResolvedValue({ code: 1, reason: 'exited' })
    f.journal.record.mockImplementation(async (entry) => {
      if (entry.phase === 'failed') throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    })
    f.leases.release.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_EXEC_FAILED' })
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it('keeps the hold when the recovery entry cannot be journaled after a snapshot started', async () => {
    const f = fixture()
    f.snapshots.save.mockRejectedValueOnce(new Error('snapshot reply lost'))
    f.journal.record.mockImplementation(async (entry) => {
      if (entry.phase === 'recovery') throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      f.evidence.push(structuredClone(entry))
    })
    await expect(f.run()).rejects.toThrow('snapshot reply lost')
    expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
    expect(f.leases.release).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a driver file',
      {
        files: [
          {
            path: `/agent-home/${sampleDriverId}/.config/opencode/opencode.json`,
            content: '{"key":"synthetic-llm-secret"}',
          },
        ],
      },
    ],
    [
      'a driver file with the MCP token',
      {
        files: [
          {
            path: `/agent-home/${sampleDriverId}/mcp.json`,
            content: '{"token":"synthetic-mcp-secret"}',
          },
        ],
      },
    ],
    [
      'a driver file with a secret file value',
      {
        secrets: [{ path: `${SANDBOX_SECRETS_DIR}/extra`, content: 'synthetic-extra-secret' }],
        files: [{ path: `/agent-home/${sampleDriverId}/extra`, content: 'synthetic-extra-secret' }],
      },
    ],
    ['an env value', { env: { LLM_API_KEY: 'synthetic-llm-secret' } }],
  ] satisfies Array<[string, Partial<PreparedRun>]>)(
    'refuses a turn credential in %s before writing anything',
    async (_, overrides) => {
      const f = fixture()
      Object.assign(f.prepared, overrides)
      await expect(f.run()).rejects.toMatchObject({
        code: 'DRIVER_PREPARE_INVALID',
        httpStatus: 502,
        message: expect.stringContaining('credential'),
      })
      expect(f.sandbox.fs.write).not.toHaveBeenCalled()
      expect(f.sandbox.exec).not.toHaveBeenCalled()
      expect(f.driver.sessionState).not.toHaveBeenCalled()
      expectSiteFree(f)
    },
  )

  it('refuses a turn credential in the agent command before writing or running anything', async () => {
    const f = fixture()
    vi.mocked(f.driver.command).mockReturnValue([
      'synthetic-agent',
      `--header=Authorization: Bearer ${f.request.context.llm.apiKey}`,
    ])
    await expect(f.run()).rejects.toMatchObject({ code: 'DRIVER_PREPARE_INVALID' })
    expect(f.sandbox.fs.write).not.toHaveBeenCalled()
    expect(f.sandbox.exec).not.toHaveBeenCalled()
    expectSiteFree(f)
  })

  it('releases the site without saving when the captured work holds a turn credential', async () => {
    const f = fixture()
    f.transport.capture.mockRejectedValueOnce(snapshotHasCredential())
    await expect(f.run()).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'snapshot_credential' })
    expect(f.evidence.at(-1)).not.toHaveProperty('snapshotPrefix')
    expect(JSON.stringify(f.evidence)).not.toContain(f.request.context.llm.apiKey)
  })

  it('logs a failed recovery hold with only its epoch and phase', async () => {
    const f = fixture()
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    f.snapshots.save.mockRejectedValueOnce(new Error('snapshot reply lost'))
    f.leases.holdForRecovery.mockRejectedValue(new Error(`site ${labels.siteId} is unreachable`))
    await expect(f.run()).rejects.toThrow('snapshot reply lost')
    expect(error).toHaveBeenCalledWith(
      'Site lease hold for recovery failed (epoch 1, phase checkpointing)',
    )
    const logged = JSON.stringify(error.mock.calls)
    for (const id of [labels.siteId, labels.taskId, labels.sessionId])
      expect(logged).not.toContain(id)
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'recovery', reason: 'snapshot_ambiguous' })
  })

  it('rejects an oversized final line instead of accepting an earlier successful result', async () => {
    const f = fixture()
    f.stdout(
      nativeEvents.map((event) => JSON.stringify(event)).join('\n') +
        '\n' +
        'x'.repeat(256 * 1024 + 1),
    )
    // The line is skipped, and what is left in its place is the last message: no result.
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it('goes on after an over-long line in the middle of the output', async () => {
    const f = fixture()
    const [started, ...rest] = nativeEvents.map((event) => JSON.stringify(event))
    f.stdout([started, 'x'.repeat(1024 * 1024), ...rest].join('\n') + '\n')
    await expect(f.run()).resolves.toMatchObject({ result })
    expect(f.evidence.at(-1)?.phase).toBe('completed')
  })

  it('accepts a result its agent wrapped in a sentence and a code fence', async () => {
    const f = fixture()
    const wrapped = 'Готово, итог:\n```json\n' + JSON.stringify(result) + '\n```\nПишите, если что.'
    f.stdout(
      [nativeEvents[0], { type: 'message', text: wrapped }, nativeEvents[2]]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    )
    await expect(f.run()).resolves.toMatchObject({ result })
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'completed', result })
  })

  it('ends a turn whose result fails its schema as rejected output, naming nothing the agent wrote', async () => {
    const f = fixture()
    const invalid = { ...result, risk: 'agent-chosen-risk', 'agent-chosen-key': true }
    f.stdout(
      [nativeEvents[0], { type: 'message', text: JSON.stringify(invalid) }, nativeEvents[2]]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    )
    const error = await f.run().then(
      () => undefined,
      (reason: unknown) => reason,
    )
    // «Не удалось принять результат работы агента»: the agent's output, not a platform fault.
    expect(error).toMatchObject({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 })
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/agent-chosen/)
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
  })

  it.each([
    [
      'more secret files than a runner prepare carries',
      (f: ReturnType<typeof fixture>) => {
        f.prepared.secrets = Array.from({ length: preparedRunLimits.secretFiles + 1 }, (_, i) => ({
          path: `${SANDBOX_SECRETS_DIR}/s${i}`,
          content: `synthetic-secret-${i}`,
        }))
      },
      'file path, mode or size',
    ],
    [
      'a secret file above its size',
      (f: ReturnType<typeof fixture>) => {
        f.prepared.secrets = [
          {
            path: `${SANDBOX_SECRETS_DIR}/big`,
            content: 'x'.repeat(preparedRunLimits.secretChars + 1),
          },
        ]
      },
      'file path, mode or size',
    ],
    [
      'an LLM key above the size of a secret',
      (f: ReturnType<typeof fixture>) => {
        vi.mocked(f.credentials.issue).mockResolvedValueOnce({
          llmApiKey: 'k'.repeat(preparedRunLimits.secretChars + 1),
          mcpToken: f.request.context.mcp.token,
        })
      },
      'credential is too long',
    ],
  ])('refuses %s on either executor before any container', async (_, change, message) => {
    const f = fixture()
    change(f)
    await expect(f.run()).rejects.toMatchObject({
      code: 'DRIVER_PREPARE_INVALID',
      message: expect.stringContaining(message),
    })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.sandbox.fs.write).not.toHaveBeenCalled()
    expectSiteFree(f)
  })

  it('does not write prepared files outside allowed roots', async () => {
    const f = fixture()
    f.prepared.secrets = [{ path: '/workspace/repo/secret', content: 'secret' }]
    await expect(f.run()).rejects.toMatchObject({
      code: 'DRIVER_PREPARE_INVALID',
      message: expect.stringContaining('file path'),
    })
    // Refused in core by the dry run: before the lease, and so before any container exists.
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.sandbox.exec).not.toHaveBeenCalled()
  })

  it.each([
    '/workspace/repo/AGENTS.md',
    '/workspace/repo',
    '/workspace/out/schema.json',
    '/agent-home/../workspace/repo/AGENTS.md',
    `/agent-home/./${sampleDriverId}/config.json`,
    `${SANDBOX_SECRETS_DIR}/config.toml`,
  ])('never writes a prepared platform file to %s, where it could be published', async (path) => {
    const f = fixture()
    f.prepared.files = [{ path, content: 'platform instructions' }]
    await expect(f.run()).rejects.toThrow('file path')
    expect(f.sandbox.fs.write).not.toHaveBeenCalled()
    expect(f.sandbox.exec).not.toHaveBeenCalled()
  })
})

/**
 * The turn of a task in the cloud browser (docs/plan/57-browser-tasks.md, Б4, Б7): no
 * repository, on a core without git. The commands that make its empty working directory print
 * nothing; only the agent prints its events.
 */
function withoutRepository(f: Fixture): void {
  f.request.requirements = { ...BROWSER_ONLY }
  const agent = vi.mocked(f.sandbox.exec).getMockImplementation()!
  vi.mocked(f.sandbox.exec).mockImplementation(async (spec) => {
    const command = spec.argv[0]!
    if (!['test', 'mkdir', 'find'].includes(command)) return agent(spec)
    f.order.push(`workdir:${command}`)
    return {
      id: `setup-${command}`,
      output: async function* () {},
      wait: async () => ({ code: 0, reason: 'exited' as const }),
      kill: async () => {},
    }
  })
}

describe.each(executorKinds)('TurnSupervisor in a chat: no repository (%s executor)', (kind) => {
  const fixture = () => turnFixture(kind)

  /** A real SnapshotService over memory storage: what a turn saves is loaded back. */
  function realSnapshots(f: Fixture, shared?: ReturnType<typeof snapshotStore>) {
    const store = shared ?? snapshotStore()
    f.transfer.put.mockImplementation(store.memory.transfer.put)
    f.transfer.get.mockImplementation(store.memory.transfer.get)
    f.snapshots.save.mockImplementation((metadata, parts, signal) =>
      store.service.save(metadata, parts, signal),
    )
    f.snapshots.restoreSource.mockImplementation((reference, ttlMs) =>
      store.service.restoreSource(reference, ttlMs),
    )
    return store
  }
  function snapshotStore() {
    const memory = memoryStorage()
    const transit = memoryTransit()
    return { memory, transit, service: new SnapshotService(memory.storage, transit.secrets) }
  }
  /** What the sandbox side captures of a turn without a repository: its home alone. */
  async function capturesHome(f: Fixture, text: string) {
    f.transport.capture.mockResolvedValue({
      home: await tarZst({ [home.include[0]!]: text }),
    } as never)
  }

  it('runs on a core without git: empty working directory, home-only checkpoint, no publication', async () => {
    const f = fixture()
    withoutRepository(f)
    const { service, transit } = realSnapshots(f)
    await capturesHome(f, 'native session')
    const finished = await f.run()
    expect(finished.result).toEqual(result)
    expect(finished.manifest.git).toBeUndefined()
    expect(finished.manifest.parts.map((part) => part.name)).toEqual(['home'])
    // No clone, no candidate, no push: the working directory is made empty instead.
    expect(f.order).toContain('workdir:mkdir')
    expect(f.order.indexOf('workdir:mkdir')).toBeLessThan(f.order.indexOf('exec'))
    expect(f.evidence.map((entry) => entry.phase)).not.toContain('publishing')
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'completed', result })
    for (const entry of f.evidence) expect(entry).not.toHaveProperty('baseSha')
    const plan = [...f.assignments.rows.values()][0]!.plan
    expect(plan.requirements).toEqual(BROWSER_ONLY)
    expect(plan).not.toHaveProperty('workspace')
    expect([...f.assignments.rows.values()][0]!.outcome).toBe('completed')
    expect(f.leases.release).toHaveBeenCalledOnce()
    // The checkpoint core committed opens again, home alone.
    const loaded = await service.load({
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    })
    expect(loaded.manifest).toEqual(finished.manifest)
    expect(Object.keys(loaded.archives)).toEqual(['home'])
    expect(transit.allZeroed()).toBe(true)
  })

  it('continues from the home-only checkpoint of turn n−1, restoring nothing into the workdir', async () => {
    const first = fixture()
    withoutRepository(first)
    const store = realSnapshots(first)
    await capturesHome(first, 'native session')
    await first.run()
    const f = fixture()
    withoutRepository(f)
    realSnapshots(f, store)
    await capturesHome(f, 'second session')
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    }
    const finished = await f.run()
    expect(finished.manifest.git).toBeUndefined()
    const [, , archives] = f.transport.restore.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, Uint8Array>,
    ]
    expect(Object.keys(archives)).toEqual(['home'])
  })

  it('continues the checkpoint a previous sandbox image sealed: a release changes the image', async () => {
    const older = `registry.invalid/raditi/${sampleDriverId}@sha256:${'e'.repeat(64)}`
    const first = fixture()
    withoutRepository(first)
    first.request.sandbox = { ...first.request.sandbox, image: older }
    const store = realSnapshots(first)
    await capturesHome(first, 'native session')
    expect((await first.run()).manifest.image).toBe(older)
    const f = fixture()
    withoutRepository(f)
    realSnapshots(f, store)
    await capturesHome(f, 'second session')
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image: older,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    }
    const finished = await f.run()
    expect(finished.manifest.image).toBe(image)
    expect(f.transport.restore).toHaveBeenCalledOnce()
  })

  it('after `/undo` restores the checkpoint the undone turn started from, not turn n−1', async () => {
    const store = snapshotStore()
    const first = fixture()
    withoutRepository(first)
    realSnapshots(first, store)
    await capturesHome(first, 'first session')
    await first.run()
    const f = fixture()
    withoutRepository(f)
    realSnapshots(f, store)
    await capturesHome(f, 'after the undone turn')
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 3 } }
    f.request.context = { ...f.request.context, turn: 3 }
    f.request.rewound = true
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    }
    const finished = await f.run()
    expect(finished.manifest.git).toBeUndefined()
    expect(f.transport.restore).toHaveBeenCalledOnce()
  })

  it('after two `/undo` in a row restores the same checkpoint, further back', async () => {
    const store = snapshotStore()
    const first = fixture()
    withoutRepository(first)
    realSnapshots(first, store)
    await capturesHome(first, 'first session')
    await first.run()
    const f = fixture()
    withoutRepository(f)
    realSnapshots(f, store)
    await capturesHome(f, 'after both undone turns')
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 4 } }
    f.request.context = { ...f.request.context, turn: 4 }
    f.request.rewound = true
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    }
    await f.run()
    expect(f.transport.restore).toHaveBeenCalledOnce()
  })

  it('refuses a rewound turn that restores the undone turn, or is no later turn, or has a repository', async () => {
    const undone = fixture()
    withoutRepository(undone)
    undone.request.sandbox = { ...undone.request.sandbox, labels: { ...labels, turn: 3 } }
    undone.request.context = { ...undone.request.context, turn: 3 }
    undone.request.rewound = true
    undone.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 2,
      image,
      driver: { id: sampleDriverId, version: '1.0.0' },
      home,
    }
    await expect(undone.run()).rejects.toThrow('Incompatible previous turn snapshot')
    expect(undone.leases.acquire).not.toHaveBeenCalled()

    const firstTurn = fixture()
    withoutRepository(firstTurn)
    firstTurn.request.rewound = true
    await expect(firstTurn.run()).rejects.toThrow('Only a later turn is rewound')
    expect(firstTurn.leases.acquire).not.toHaveBeenCalled()

    // A turn that needs a repository but names none (docs/plan/84-projects.md, §4.3).
    const repository = fixture()
    repository.request.requirements = { repository: true, browser: false }
    await expect(repository.run()).rejects.toThrow('A turn has its repository exactly when')
    expect(repository.leases.acquire).not.toHaveBeenCalled()
  })

  it('starts a new session after an unsuccessful turn n−1, with no checkpoint to restore', async () => {
    // «Продолжить» after a turn the key's money ended: the planner and the assignment store
    // want a new session, neither replaced nor rebased (plan 57, Б3, Б4).
    const f = fixture()
    withoutRepository(f)
    await capturesHome(f, 'new session')
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    const finished = await f.run()
    expect(finished.manifest.git).toBeUndefined()
    expect(f.snapshots.restoreSource).not.toHaveBeenCalled()
    expect(f.transport.restore).not.toHaveBeenCalled()
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.not.objectContaining({ nativeSessionId: expect.anything() }),
    )
    expect(f.evidence.at(-1)?.phase).toBe('completed')
  })

  it('refuses a new session that names a driver session to resume, before the lease', async () => {
    const f = fixture()
    withoutRepository(f)
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2, nativeSessionId: 'prior-native' }
    await expect(f.run()).rejects.toThrow('must start fresh')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })
})

// On runner VMs the containers of a held turn are adopted through its assignment, which this
// recovery moves to the new epoch first; turn-exec-recovery.test.ts runs it on both executors.
describe.each(executorKinds)('TurnSupervisor with files of the client (%s executor)', (kind) => {
  const path = '/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/Меню.pdf'
  const menu = Buffer.from('%PDF-1.7 synthetic menu')

  /** The plan names one file; core's inbox gives it as the database and S3 would. */
  function withFiles(f: Fixture) {
    f.request.input = { ...f.request.input, attachments: [path] }
    const files = vi.fn(async (_taskId: string, paths: readonly string[]) =>
      paths.map((at) => ({
        path: at,
        sizeBytes: menu.byteLength,
        read: async function* () {
          yield menu.subarray(0, 4)
          yield menu.subarray(4)
        },
      })),
    )
    f.deps.inbox = { files }
    return files
  }

  it('reads the files the plan names under the lease and writes them into the sandbox', async () => {
    const f = turnFixture(kind)
    const files = withFiles(f)
    vi.mocked(f.leases.acquire).mockImplementation(async (input: { ttlMs: number }) => {
      expect(files).not.toHaveBeenCalled()
      return {
        siteId: labels.siteId,
        taskId: labels.taskId,
        operation: 'turn',
        epoch: 1,
        serverNow: new Date(),
        expiresAt: new Date(Date.now() + input.ttlMs),
      }
    })
    await f.run()
    expect(files).toHaveBeenCalledExactlyOnceWith(labels.taskId, [path])
    const at = (step: string) => f.order.indexOf(step)
    expect(at(`write:${path}`)).toBeGreaterThan(at('checkout'))
    expect(at(`write:${path}`)).toBeLessThan(at(`write:${f.prepared.files[0]!.path}`))
    const written = vi.mocked(f.sandbox.fs.write).mock.calls.find(([to]) => to === path)!
    expect(Buffer.from(written[1]).equals(menu)).toBe(true)
    expect(written[2]).toEqual({ mode: 0o444 })
    // The plan recovery keeps names the path the agent was told of, nothing of the inbox.
    expect([...f.assignments.rows.values()][0]!.plan.input.attachments).toEqual([path])
  })

  it('fails the turn when a file of the plan is no longer bound to the task', async () => {
    const f = turnFixture(kind)
    withFiles(f).mockRejectedValue(conflict('A file of the turn is not bound to its task'))
    await expect(f.run()).rejects.toThrow('A file of the turn is not bound to its task')
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect([...f.assignments.rows.values()][0]!.outcome).toBe('failed')
  })

  it('refuses files without core’s inbox, and files of a turn under another lease, before the lease', async () => {
    const plain = turnFixture(kind)
    plain.request.input = { ...plain.request.input, attachments: [path] }
    await expect(plain.run()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Files of the client need the inbox of core',
    })
    expect(plain.leases.acquire).not.toHaveBeenCalled()

    const browser = turnFixture(kind)
    const files = withFiles(browser)
    withoutRepository(browser)
    browser.request.sandbox = {
      ...browser.request.sandbox,
      labels: { ...labels, siteId: '00000000-0000-4000-8000-000000000002' },
    }
    await expect(browser.run()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Files of the client go only to the turn of their chat',
    })
    expect(browser.leases.acquire).not.toHaveBeenCalled()
    expect(files).not.toHaveBeenCalled()
  })

  it('writes the files of a chat without a site, which has no repository (docs/plan/61, К16)', async () => {
    const f = turnFixture(kind)
    const files = withFiles(f)
    withoutRepository(f)
    const request = f.request as TurnRequest
    request.requirements = { repository: false, browser: false }
    // Its lease is its own id (К14): that is what lets the sandbox hold them.
    request.sandbox = {
      ...request.sandbox,
      labels: { ...request.sandbox.labels, siteId: labels.taskId },
    }
    const chatLease = async (input: { ttlMs: number }) => ({
      ...f.lease,
      siteId: labels.taskId,
      expiresAt: new Date(Date.now() + input.ttlMs),
    })
    f.leases.acquire.mockImplementation(chatLease)
    f.leases.renew.mockImplementation((_fence, ttlMs) => chatLease({ ttlMs }))
    await f.run()
    expect(files).toHaveBeenCalledExactlyOnceWith(labels.taskId, [path])
    expect(f.order).toContain(`write:${path}`)
    expect(f.order.indexOf(`write:${path}`)).toBeGreaterThan(f.order.indexOf('workdir:mkdir'))
    expect([...f.assignments.rows.values()][0]!.outcome).toBe('completed')
  })
})

describe.each(executorKinds)(
  'TurnSupervisor with files of the project (%s executor, docs/plan/84-projects.md, ПР8)',
  (kind) => {
    const inboxPath = '/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/Меню.pdf'
    const path = '/workspace/project/Фото/Бриф.pdf'
    const brief = Buffer.from('%PDF-1.7 synthetic brief')
    const reader = (bytes: Buffer) => async (_taskId: string, paths: readonly string[]) =>
      paths.map((at) => ({
        path: at,
        sizeBytes: bytes.byteLength,
        read: async function* () {
          yield bytes
        },
      }))

    function withProjectFiles(f: Fixture) {
      f.request.input = {
        ...f.request.input,
        attachments: [inboxPath],
        projectFiles: [path],
      }
      f.deps.inbox = { files: vi.fn(reader(Buffer.from('%PDF menu'))) }
      const files = vi.fn(reader(brief))
      f.deps.projectFiles = { files }
      return files
    }

    it('reads them under the lease and writes them read-only after the files of the chat', async () => {
      const f = turnFixture(kind)
      const files = withProjectFiles(f)
      await f.run()
      expect(files).toHaveBeenCalledExactlyOnceWith(labels.taskId, [path])
      const at = (step: string) => f.order.indexOf(step)
      expect(at(`write:${path}`)).toBeGreaterThan(at(`write:${inboxPath}`))
      expect(at(`write:${path}`)).toBeLessThan(at(`write:${f.prepared.files[0]!.path}`))
      const written = vi.mocked(f.sandbox.fs.write).mock.calls.find(([to]) => to === path)!
      expect(Buffer.from(written[1]).equals(brief)).toBe(true)
      expect(written[2]).toEqual({ mode: 0o444 })
      // The plan recovery keeps names the paths the agent was told of, nothing of the store.
      expect([...f.assignments.rows.values()][0]!.plan.input.projectFiles).toEqual([path])
    })

    it('fails the turn when a file is no longer of the project of the chat', async () => {
      const f = turnFixture(kind)
      withProjectFiles(f).mockRejectedValue(
        conflict('A file of the turn is not a file of the project of its chat'),
      )
      await expect(f.run()).rejects.toThrow('not a file of the project of its chat')
      expect(f.sandboxes.create).not.toHaveBeenCalled()
    })

    it('refuses files of a project without the store of core, before the lease', async () => {
      const plain = turnFixture(kind)
      plain.request.input = { ...plain.request.input, projectFiles: [path] }
      await expect(plain.run()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Files of a project need the inbox of core',
      })
      expect(plain.leases.acquire).not.toHaveBeenCalled()
    })
  },
)

// --- A turn with a repository (docs/plan/84-projects.md, ПР12, ПР32, ПР35, §4.3) ------------------
//
// Real git in a real git worker over its socket, as git-workspace.service.test.ts: the turn's
// bundle, its candidate and its publication into the mirror. The sandbox side is the fake above,
// whose working copy a real clone of the bundle stands in for: its patch and new files are what a
// capture of the sandbox would take.

const execute = promisify(execFile)
const gitRoots: string[] = []
const gitWorkers: GitWorkerServer[] = []
const gitEnv = (cwd: string) => ({
  PATH: process.env.PATH,
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
})
const fixtureGit = async (cwd: string, ...args: string[]) =>
  (await execute('git', args, { cwd, encoding: 'buffer', env: gitEnv(cwd) })).stdout

afterEach(async () => {
  await Promise.all(gitWorkers.splice(0).map((worker) => worker.close()))
  await Promise.all(gitRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A remote with one commit on main, a fake gitleaks, a worker and the mirror fetched. */
async function gitFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-turn-repo-'))
  gitRoots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await fixtureGit(root, 'init', '--bare', '--initial-branch=main', remote)
  await fixtureGit(root, 'init', '--initial-branch=main', work)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(work, name, '..'), { recursive: true })
    await writeFile(join(work, name), content)
  }
  await fixtureGit(work, 'add', '.')
  await fixtureGit(work, 'commit', '-m', 'first')
  await fixtureGit(work, 'push', remote, 'HEAD:refs/heads/main')
  const baseSha = (await fixtureGit(work, 'rev-parse', 'HEAD')).toString().trim()
  const scanner = join(root, 'scanner.mjs')
  await writeFile(
    scanner,
    `#!${process.execPath}
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const data = readdirSync(args[1]).map((name) => readFileSync(join(args[1], name), 'latin1')).join('\\n')
const finding = Number(args.find((arg) => arg.startsWith('--exit-code='))?.slice(12) ?? 1)
process.exit(data.includes('synthetic-secret-marker') ? finding : 0)
`,
    { mode: 0o700 },
  )
  const mirrorDir = join(root, 'mirrors')
  await mkdir(mirrorDir, { mode: 0o770 })
  const worker = await startGitWorker({
    root: mirrorDir,
    allowLoopback: false,
    refusedSubnets: [],
    allowFileProtocol: true,
    gitleaksBinary: scanner,
  })
  gitWorkers.push(worker)
  const service = new GitWorkspaceService({
    runner: new GitWorkerClient(worker.socket),
    mirrorDir,
    transport: { kind: 'local-test', root },
  })
  const projectRepositoryId = '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c'
  await service.fetch({
    projectRepositoryId,
    remote: {
      cloneUrl: remote,
      access: {
        auth: { kind: 'anonymous' },
        basic: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
    branches: ['main'],
    sizeBytes: null,
  })
  return { root, baseSha, service, projectRepositoryId }
}

async function tarZstOf(files: Record<string, string>) {
  const stream = pack()
  for (const [name, content] of Object.entries(files)) stream.entry({ name, mode: 0o644 }, content)
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}

const repoChat = 'raditi/chat-000000000000'

/**
 * A turn of a chat of a project with a repository: its plan names the repository and the bundle
 * the trusted git builds of it; the sandbox's working copy is a clone of that bundle, changed by
 * `edit`, and its capture takes the patch and new files of that clone.
 */
async function repositoryTurn(
  kind: string,
  options: {
    files?: Record<string, string>
    hiddenPaths?: string[]
    edit?: (work: string) => Promise<void>
    untracked?: Record<string, string>
  } = {},
) {
  const f = turnFixture(kind)
  const g = await gitFixture(
    options.files ?? {
      'index.js': 'hello\n',
      '.env': 'TOKEN=real-value\n',
      '.gitlab-ci.yml': 'x\n',
    },
  )
  const hiddenPaths = options.hiddenPaths ?? ['.env']
  const bundle = await g.service.buildBaseBundle({
    projectRepositoryId: g.projectRepositoryId,
    baseSha: g.baseSha,
    branch: repoChat,
    committedAt: REPO_BUNDLE_TIME,
    hiddenPaths,
  })
  f.request.requirements = { repository: true, browser: false }
  f.request.repository = {
    projectId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
    projectRepositoryId: g.projectRepositoryId,
    provider: 'gitlab',
    baseSha: g.baseSha,
    sandboxBaseSha: bundle.sandboxBaseSha,
    branch: repoChat,
    mode: 'write',
    expectedRef: null,
    bundleSha256: bundle.sha256,
    bundleBytes: bundle.sizeBytes,
    hiddenPaths,
  }
  f.deps.repository = g.service
  // The sandbox: the bundle core served is checked out and changed as the agent would.
  const imported: Buffer[] = []
  const work = join(g.root, 'sandbox')
  f.sandboxSide.importBundle = vi.fn(async (_sandbox, source) => {
    f.order.push('import')
    const chunks: Buffer[] = []
    for await (const chunk of source.read()) chunks.push(Buffer.from(chunk))
    imported.push(Buffer.concat(chunks))
    const path = join(g.root, 'base.bundle')
    await writeFile(path, Buffer.concat(chunks))
    await fixtureGit(g.root, 'clone', '--quiet', '--branch', 'raditi-base', path, work)
    await fixtureGit(work, 'checkout', '--quiet', '-b', source.branch)
    await options.edit?.(work)
  })
  const transport = f.transport as typeof f.transport & {
    captureRepository: Mock<
      NonNullable<LocalTurnExecutorDependencies['transport']['captureRepository']>
    >
  }
  transport.captureRepository = vi.fn(async (_sandbox, _home, baseSha) => {
    f.order.push('capture')
    const patch = await fixtureGit(work, 'diff', '--binary', '--no-renames', baseSha, '--')
    return {
      home: Buffer.from('home'),
      patch: new Uint8Array(patch),
      untracked: await tarZstOf(options.untracked ?? {}),
    }
  })
  const saved: { metadata: SnapshotMetadata; parts: SnapshotParts<SealedElsewhere> }[] = []
  f.snapshots.save.mockImplementation(async (metadata, parts) => {
    f.order.push('save')
    // At the snapshot the chat's ref is still where it was: the publication comes after it.
    f.order.push(
      `ref:${(await g.service.readChatRef(g.projectRepositoryId, labels.taskId)) ?? 'none'}`,
    )
    saved.push({ metadata, parts })
    return {
      ...metadata,
      schemaVersion: 1,
      createdAt: f.request.committedAt,
      parts: [],
    } as SnapshotManifest
  })
  return { f, g, bundle, imported, saved }
}

describe.each(executorKinds)(
  'TurnSupervisor with a repository (%s executor, docs/plan/84-projects.md, ПР12)',
  { timeout: 60_000 },
  (kind) => {
    it('imports the bundle, snapshots the candidate, then publishes it into the chat ref', async () => {
      const { f, g, bundle, imported, saved } = await repositoryTurn(kind, {
        edit: async (work) => writeFile(join(work, 'index.js'), 'hello, world\n'),
        untracked: { 'src/new.js': 'new\n' },
      })
      const finished = await f.run()
      // The bundle the runner or the local executor imported is the one the plan names.
      expect(imported).toHaveLength(1)
      expect(createHash('sha256').update(imported[0]!).digest('hex')).toBe(bundle.sha256)
      const head = finished.repository!.headSha!
      expect(finished.repository).toMatchObject({ baseSha: g.baseSha, buildPaths: [] })
      expect(finished.repository!.refusal).toBeUndefined()
      expect(Buffer.from(finished.repository!.patch).toString()).toContain('+hello, world')
      expect(Buffer.from(finished.repository!.patch).toString()).toContain('src/new.js')
      // Snapshot before publication: its git names the candidate, its patch is the candidate's.
      expect(f.order.indexOf('ref:none')).toBeGreaterThan(-1)
      expect(saved[0]!.metadata.git).toMatchObject({
        provider: 'gitlab',
        branch: repoChat,
        baseSha: g.baseSha,
        sandboxBaseSha: bundle.sandboxBaseSha,
        headSha: head,
        publication: { taskId: labels.taskId },
      })
      expect(Buffer.from(saved[0]!.parts.patch as Uint8Array)).toEqual(
        Buffer.from(finished.repository!.patch),
      )
      const phases = f.evidence.map((entry) => entry.phase)
      expect(phases.indexOf('checkpointed')).toBeLessThan(phases.indexOf('publishing'))
      expect(phases.at(-1)).toBe('completed')
      expect(await g.service.readChatRef(g.projectRepositoryId, labels.taskId)).toBe(head)
      expect(finished.result.client_message).toBe(result.client_message)
    })

    it('marks a change of a CI file, and publishes it', async () => {
      const { f, g } = await repositoryTurn(kind, {
        edit: async (work) => writeFile(join(work, '.gitlab-ci.yml'), 'changed\n'),
      })
      const finished = await f.run()
      expect(finished.repository!.buildPaths).toEqual(['.gitlab-ci.yml'])
      expect(await g.service.readChatRef(g.projectRepositoryId, labels.taskId)).toBe(
        finished.repository!.headSha,
      )
    })

    it.each([
      [
        'a secret',
        {
          edit: async (work: string) =>
            writeFile(join(work, 'index.js'), 'synthetic-secret-marker\n'),
        },
        'secret_found',
      ],
      [
        'a value of a variable',
        { edit: async (work: string) => writeFile(join(work, 'index.js'), 'client-value-8c1d\n') },
        'client_value',
      ],
      [
        'a change of a hidden file',
        { edit: async (work: string) => writeFile(join(work, '.env'), 'TOKEN=other\n') },
        'failed',
      ],
      ['a path under .git', { untracked: { '.git/config': 'x\n' } }, 'failed'],
    ] as const)(
      'publishes nothing with %s, and the answer arrives',
      async (_label, change, refusal) => {
        const { f, g, saved } = await repositoryTurn(kind, change)
        f.credentials.siteValues = async () => ['client-value-8c1d']
        const finished = await f.run()
        expect(finished.result.client_message).toBe(result.client_message)
        expect(finished.repository).toMatchObject({ headSha: null, refusal })
        // The snapshot names the base as its head and no publication; its patch is empty.
        expect(saved[0]!.metadata.git).toMatchObject({ headSha: g.baseSha })
        expect(saved[0]!.metadata.git).not.toHaveProperty('publication')
        expect((saved[0]!.parts.patch as Uint8Array).byteLength).toBe(0)
        expect(f.evidence.map((entry) => entry.phase)).not.toContain('publishing')
        expect(await g.service.readChatRef(g.projectRepositoryId, labels.taskId)).toBeNull()
      },
    )

    it('gives the sandbox a stub in place of a file that looks like a secret (ПР35)', async () => {
      const { f, g, bundle } = await repositoryTurn(kind)
      await f.run()
      const clone = join(g.root, 'stub-check')
      const path = join(g.root, 'check.bundle')
      const chunks: Buffer[] = []
      for await (const chunk of bundle.read()) chunks.push(Buffer.from(chunk))
      await writeFile(path, Buffer.concat(chunks))
      await fixtureGit(g.root, 'clone', '--quiet', '--branch', 'raditi-base', path, clone)
      // The stub of a file of variables is a comment of its own (19.11.2026).
      expect(await readFile(join(clone, '.env'), 'utf8')).toBe(hiddenFileStub('.env'))
      expect(await readFile(join(clone, 'index.js'), 'utf8')).toBe('hello\n')
    })

    it('finishes the publication after core died between the snapshot and it', async () => {
      const { f, g, saved } = await repositoryTurn(kind, {
        edit: async (work) => writeFile(join(work, 'index.js'), 'after a crash\n'),
      })
      // Core dies right after `checkpointed` and the removal: `publishing` is never written.
      const record = f.journal.record.getMockImplementation()!
      f.journal.record.mockImplementation(async (entry: TurnEvidence) => {
        if (entry.phase === 'publishing') throw new Error('core was killed')
        return record(entry)
      })
      await expect(f.run()).rejects.toThrow('core was killed')
      expect(await g.service.readChatRef(g.projectRepositoryId, labels.taskId)).toBeNull()
      const [assignment] = await f.assignments.unfinished()
      expect(assignment).toBeDefined()
      const snapshot = saved[0]!
      const loaded = {
        manifest: {
          ...snapshot.metadata,
          schemaVersion: 1 as const,
          createdAt: f.request.committedAt,
          parts: [],
        } as SnapshotManifest,
        archives: {
          home: Buffer.from('home'),
          patch: snapshot.parts.patch as Uint8Array,
          untracked: snapshot.parts.untracked as Uint8Array,
        },
      }
      f.journal.record.mockImplementation(record)
      const recovered = await new TurnPublicationRecovery({
        leases: f.leases,
        executor: f.deps.executor,
        assignments: f.assignments,
        snapshots: { ...f.snapshots, load: vi.fn(async () => loaded) },
        journal: f.journal,
        repository: g.service,
      }).recover({
        assignmentId: assignment!.id,
        heldFence: assignment!.fence,
        snapshot: {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: 1,
          image,
          driver: { id: sampleDriverId, version: '1.0.0' },
          home,
        },
        plan: assignment!.plan,
        removal: 'expired',
        remainingMs: 0,
        labels: { ...labels, leaseEpoch: 1 },
      })
      expect(recovered.headSha).toBe(snapshot.metadata.git!.headSha)
      expect(await g.service.readChatRef(g.projectRepositoryId, labels.taskId)).toBe(
        snapshot.metadata.git!.headSha,
      )
      expect(f.evidence.map((entry) => entry.phase)).toContain('publication_recovered')
    })

    it('restores a checkpoint without a repository only when the plan says the repository came (ПР32)', async () => {
      const first = await repositoryTurn(kind)
      const previous = {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0' },
        home,
      }
      const asSecond = (f: Fixture) => {
        f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
        f.request.context = { ...f.request.context, turn: 2 }
        f.request.previous = previous
        f.snapshots.restoreSource.mockResolvedValue({
          manifest: {
            ...previous,
            schemaVersion: 1,
            createdAt: f.request.committedAt,
            parts: [],
          } as unknown as SnapshotManifest,
          parts: {
            home: {
              method: 'GET',
              url: 'https://s3.invalid/home',
              headers: {},
              expiresAt: new Date(Date.now() + 60_000),
            },
          },
          dataKey: async () => new Uint8Array(32),
        })
      }
      asSecond(first.f)
      await expect(first.f.run()).rejects.toThrow('Previous checkpoint differs from the repository')
      const second = await repositoryTurn(kind)
      asSecond(second.f)
      second.f.request.repository = { ...second.f.request.repository!, repositoryChanged: true }
      // Past the check: the turn goes on to its prepare, which this fake checkpoint then fails.
      await expect(second.f.run()).rejects.not.toThrow('Previous checkpoint differs')
      // The dry run and the driver's own prepare: the checkpoint was let through.
      expect(second.f.order.filter((step) => step === 'prepare')).toHaveLength(2)
      expect(first.f.order.filter((step) => step === 'prepare')).toHaveLength(1)
    })

    // The chat of 21.11.2026: the agent renamed the chat as turn 3 ended, the branch row took the
    // new name, and turn 4 failed with CONFLICT on a checkpoint of the old one.
    it('goes on from a checkpoint whose branch had another name', async () => {
      const { f } = await repositoryTurn(kind)
      const previous = {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0' },
        home,
      }
      f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
      f.request.context = { ...f.request.context, turn: 2 }
      f.request.previous = previous
      f.snapshots.restoreSource.mockResolvedValue({
        manifest: {
          ...previous,
          schemaVersion: 1,
          createdAt: f.request.committedAt,
          parts: [],
          git: { branch: 'raditi/staroe-imya-0000aaaa' },
        } as unknown as SnapshotManifest,
        parts: {
          home: {
            method: 'GET',
            url: 'https://s3.invalid/home',
            headers: {},
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
        dataKey: async () => new Uint8Array(32),
      })
      // Past the check: the turn goes on to its prepare, which this fake checkpoint then fails.
      await expect(f.run()).rejects.not.toThrow('Previous checkpoint differs')
      expect(f.order.filter((step) => step === 'prepare')).toHaveLength(2)
    })
  },
)
