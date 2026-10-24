import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

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
  MAX_SANDBOX_TURN_MS,
  notFound,
  preparedRunLimits,
  SANDBOX_SECRETS_DIR,
  sandboxCommandFailed,
  snapshotHasCredential,
  TimeoutError,
  TURN_FINALIZE_RESERVE_MS,
  toTurnPlan,
  TURN_PUBLICATION_GRACE_MS,
  type AgentDriver,
  type AgentEvent,
  type ExecHandle,
  type ObjectStorage,
  type PreparedRun,
  type PublicationSource,
  type Sandbox,
  type SandboxInfo,
  type SecretStore,
  type SiteLeaseAuthority,
  type SiteLeaseGrant,
  type SiteLeaseFence,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnBundleSource,
  type TurnEvidence,
  type TurnExecutor,
  type TurnRestoreSource,
  type TurnResult,
  withoutTurnCredentials,
} from '@repo/domain'
import { createOpencodeDriver } from '@repo/agent-drivers'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { newTurnKeys } from '@repo/turn-keys'
import type { PresignedTransfer, SnapshotArchives } from '@repo/snapshots'
import { memoryStorage, memoryTransit, tarZst } from '@repo/snapshots/testing'
import { LocalTurnExecutor, type LocalTurnExecutorDependencies } from '@repo/local-turns'

import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
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
import { LiveTurns } from './live-turns.ts'
import {
  isMissingCheckpoint,
  RECOVERY_TIMEOUT_MS,
  TurnPublicationRecovery,
  type PublicationRecoveryRequest,
} from './turn-recovery.ts'

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
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 1,
}
const baseSha = 'b'.repeat(40)
const headSha = 'c'.repeat(40)
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
  // A turn with a repository, as every turn was before plan 57: tests narrow its workspace.
  const request: TurnRequest & { workspace: PublicationSource } = {
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
    workspace: {
      repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
      branch: `agent/${labels.taskId}`,
      expectedBaseSha: baseSha,
      protectedPaths: [],
    },
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
  const sandbox: Sandbox = {
    id: 'container1',
    labels: { ...labels, leaseEpoch: 1 },
    exec: vi.fn(async () => {
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
    capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: false, images: false },
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
  const publication = {
    baseSha,
    headSha,
    patch: Buffer.from('full-patch-with-new-files') as Uint8Array,
    untracked: Buffer.from('empty-valid-archive') as Uint8Array,
    publish: vi.fn(async (assertFence: () => Promise<void>) => {
      await assertFence()
      order.push('publish')
    }),
    dispose: vi.fn(async () => {
      order.push('dispose')
    }),
  }
  const archives: SnapshotArchives = {
    home: Buffer.from('home'),
    patch: Buffer.from('tracked-patch'),
    untracked: Buffer.from('untracked-files'),
  }
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
          git: { provider: 'gitea', branch: request.workspace.branch, baseSha, headSha: baseSha },
        }),
        archives,
      }
    }),
  }
  const bundle: TurnBundleSource = {
    baseSha,
    branch: request.workspace.branch,
    sha256: '0'.repeat(64),
    sizeBytes: 1,
    read: async function* () {},
  }
  const workspace = {
    buildBaseBundle: vi.fn(async () => {
      order.push('bundle')
      return bundle
    }),
    preparePublication: vi.fn(async () => {
      order.push('candidate')
      return publication
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
  const importBundle = vi.fn(async () => {
    order.push('checkout')
  })
  const transfer = {
    get: vi.fn<PresignedTransfer['get']>(async () => {
      throw new Error('No presigned object in this test')
    }),
    put: vi.fn<PresignedTransfer['put']>(async () => {
      throw new Error('No presigned object in this test')
    }),
  }
  const assignments = new MemoryTurnAssignments(leases)
  const executor = executors[kind]!(
    { sandboxes, parser: () => driver, transport, transfer, importBundle },
    { leases, assignments },
  )
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
    workspace,
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
    publication,
    snapshots,
    workspace,
    transport,
    journal,
    assignments,
    sandboxes,
    importBundle,
    transfer,
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

/** The DB fixes expires_at when the statement starts; the grant reaches core `delayMs` later. */
function delayGrant<A extends unknown[]>(
  mock: Mock<(...args: A) => Promise<SiteLeaseGrant>>,
  delayMs: number,
): void {
  const grant = mock.getMockImplementation()!
  mock.mockImplementation(async (...args: A) => {
    const granted = await grant(...args)
    await vi.advanceTimersByTimeAsync(delayMs)
    return granted
  })
}

type Fixture = ReturnType<typeof turnFixture>

/**
 * A run the driver's own output condemns is refused by the dry run before the lease, when the
 * stand-in credentials show it, and right after the turn's credentials were issued otherwise.
 * Either way the site is not left leased.
 */
function expectSiteFree(f: Fixture): void {
  expect(f.leases.release).toHaveBeenCalledTimes(f.leases.acquire.mock.calls.length)
  expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
}

async function expectLeaseCoversLatePush(
  f: Fixture,
  run: () => Promise<unknown>,
  hardTimeoutMs: number,
  requestedTtl: () => number,
): Promise<void> {
  useFakeClock()
  const startedAt = Date.now()
  const pushStarted = Promise.withResolvers<void>()
  f.journal.record.mockImplementation(async (entry) => {
    f.evidence.push(structuredClone(entry))
    // Push at the last moment of the limit, which counts from the lease request.
    if (entry.phase === 'publishing')
      await vi.advanceTimersByTimeAsync(startedAt + hardTimeoutMs - 1 - Date.now())
  })
  f.publication.publish.mockImplementation(async (assertFence) => {
    await assertFence()
    pushStarted.resolve()
    await new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('push reply lost')), 60_000)
    })
  })
  let settledAt = 0
  const rejected = expect(
    run().finally(() => {
      settledAt = Date.now()
    }),
  ).rejects.toThrow()
  await pushStarted.promise
  expect(requestedTtl() - hardTimeoutMs).toBeGreaterThanOrEqual(90_000)
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  expect(settledAt - startedAt).toBeLessThanOrEqual(hardTimeoutMs)
  expect(startedAt + requestedTtl() - Date.now()).toBeGreaterThanOrEqual(30_000)
  // The first grant alone covers the in-flight push: nothing renews it.
  expect(f.leases.renew).not.toHaveBeenCalled()
  expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
  expect(f.leases.release).not.toHaveBeenCalled()
  expect(f.evidence.at(-1)?.phase).toBe('recovery')
}

describe.each(executorKinds)('PoC TurnSupervisor (%s executor)', (kind) => {
  const fixture = () => turnFixture(kind)

  it('undoes a replaced first turn before importing Git or creating its next container', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.replacesTurn = 1
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: null }
    const rollback = vi.fn(async () => {
      expect(f.sandboxes.create).not.toHaveBeenCalled()
      expect(f.workspace.buildBaseBundle).not.toHaveBeenCalled()
      // Only the dry run before the lease: the turn's own run is prepared after the undo.
      expect(f.driver.prepare).toHaveBeenCalledOnce()
      f.order.push('undo')
    })
    f.deps.contentRollback = { rollback }
    await f.run()
    // Admitted by the fence of the lease alone: exactly these two keys, no credential of the turn.
    expect(rollback).toHaveBeenCalledExactlyOnceWith({
      fence: expect.objectContaining({
        siteId: labels.siteId,
        taskId: labels.taskId,
        operation: 'turn',
        epoch: 1,
      }),
      turn: 1,
    })
    expect(JSON.stringify(vi.mocked(rollback).mock.calls)).not.toMatch(/synthetic-[a-z]+-secret/)
    expect(f.order.indexOf('undo')).toBeLessThan(f.order.indexOf('create'))
    expect(f.workspace.preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBranchSha: null,
        expectedBaseSha: baseSha,
        turn: 2,
      }),
    )
    expect([...f.assignments.rows.values()][0]!.plan.replacesTurn).toBe(1)
  })

  it('does not prepare an agent or checkpoint when replacement undo fails', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.replacesTurn = 1
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: null }
    f.deps.contentRollback = {
      rollback: vi.fn(async () => {
        throw conflict('Synthetic content drift')
      }),
    }
    await expect(f.run()).rejects.toThrow('Synthetic content drift')
    // The dry run before the lease, with stand-ins for the credentials, and nothing after it.
    expect(f.driver.prepare).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(f.driver.prepare).mock.calls)).not.toMatch(
      /synthetic-[a-z]+-secret/,
    )
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.credentials.revoke).toHaveBeenCalledOnce()
    expect([...f.assignments.rows.values()][0]!.outcome).toBe('failed')
  })

  it('refuses a replacement that names any turn but the one before it, with no lease and no undo', async () => {
    // The undo before a replacement returns the content of the one turn the plan names: a plan
    // of turn 3 that names turn 1 would leave what turn 2 changed on the site.
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 3 } }
    f.request.context = { ...f.request.context, turn: 3 }
    f.request.replacesTurn = 1
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: null }
    const rollback = vi.fn(async () => {})
    f.deps.contentRollback = { rollback }
    await expect(f.run()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Replacement must name the latest turn',
    })
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('rejects replacement without an undo dependency before taking a lease', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.replacesTurn = 1
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: null }
    await expect(f.run()).rejects.toThrow('requires content rollback')
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.credentials.issue).not.toHaveBeenCalled()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('issues against the persisted assignment and revokes before publication', async () => {
    const f = fixture()
    vi.mocked(f.credentials.issue).mockImplementation(async (ref) => {
      const assignment = [...f.assignments.rows.values()][0]!
      expect(assignment).toMatchObject({ fence: { taskId: labels.taskId }, firstEpoch: ref.epoch })
      expect(JSON.stringify(assignment.plan)).not.toMatch(/synthetic-[a-z]+-secret/)
      expect(f.sandboxes.create).not.toHaveBeenCalled()
      // A runner slot is reserved by now (boundSource below), yet the turn is bound to its
      // runner only when the prepare goes out: a core that dies here left nothing handed out.
      expect(assignment.runner).toBeNull()
      f.order.push('issue')
      return { llmApiKey: f.request.context.llm.apiKey, mcpToken: f.request.context.mcp.token }
    })
    vi.mocked(f.credentials.revoke).mockImplementation(async () => {
      expect(f.sandbox.destroy).toHaveBeenCalled()
      expect(f.publication.publish).not.toHaveBeenCalled()
      f.order.push('revoke')
    })
    await f.run()
    const assignment = [...f.assignments.rows.values()][0]!
    expect(f.credentials.issue).toHaveBeenCalledWith(
      { taskId: labels.taskId, sessionId: labels.sessionId, turn: 1, epoch: assignment.firstEpoch },
      expect.objectContaining({
        ...testTurnCredentialPolicy,
        ttlMs: expect.any(Number),
        deadlineAt: assignment.deadlineAt,
        boundSource: kind === 'runner' ? '127.0.0.1' : null,
      }),
    )
    expect(f.order.indexOf('issue')).toBeLessThan(f.order.indexOf('create'))
    expect(f.order.indexOf('revoke')).toBeLessThan(f.order.indexOf('publish'))
    if (kind === 'runner') expect(assignment.runner).toMatchObject({ id: 'sandbox-1' })
  })

  it('closes credential intent when issuance fails before creating a container', async () => {
    const f = fixture()
    vi.mocked(f.credentials.issue).mockRejectedValueOnce(new Error('Synthetic issuance failure'))
    await expect(f.run()).rejects.toThrow('Synthetic issuance failure')
    expect(f.credentials.revoke).toHaveBeenCalledOnce()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.workspace.buildBaseBundle).not.toHaveBeenCalled()
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

  it('refuses a turn its driver cannot launch before the lease, the key and the content undo', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.replacesTurn = 1
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: null }
    const rollback = vi.fn(async () => {})
    f.deps.contentRollback = { rollback }
    vi.mocked(f.driver.command).mockImplementation(() => {
      throw badRequest('Synthetic driver refuses this turn input')
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.assignments.rows.size).toBe(0)
    expect(f.credentials.issue).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
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

  it('masks the client variables of the turn in its journal and refuses them in its candidate (Р13)', async () => {
    const f = fixture()
    const value = 'pay-se"cret-0001'
    vi.mocked(f.credentials.issue).mockResolvedValue({
      llmApiKey: f.request.context.llm.apiKey,
      mcpToken: f.request.context.mcp.token,
      envValues: { PAYMENT_KEY: value },
    })
    // The client changed another value after the key was issued: the preview may show it.
    const rotated = 'rotated-secret-0002'
    f.credentials.site = [value, rotated]
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
    // The candidate is checked for the values, in every spelling, by the trusted publication:
    // the ones the turn got and the ones the site holds now.
    expect(f.workspace.preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({ refusedValues: [value, rotated] }),
    )
    // The executor masks them before the parser and refuses a home archive that holds one.
    expect(f.transport.capture).toHaveBeenCalledWith(
      f.sandbox,
      home,
      baseSha,
      expect.any(Array),
      [],
      [value],
    )
    // Nothing of them in the plan the assignment keeps.
    expect(JSON.stringify([...f.assignments.rows.values()])).not.toContain('cret-0001')
  })

  it('snapshots the candidate before destroying the container and publishing', async () => {
    const f = fixture()
    const finished = await f.run()
    expect(finished.result).toEqual(result)
    expect(f.order).toEqual([
      // The dry run before the lease, then the run of the turn with its credentials.
      'prepare',
      'bundle',
      'prepare',
      'create',
      'checkout',
      `write:/agent-home/${sampleDriverId}/.config/opencode/opencode.json`,
      `write:${SANDBOX_SECRETS_DIR}/llm`,
      'exec',
      'quiesce',
      'capture',
      'candidate',
      'save',
      'destroy',
      'publish',
      'release',
      'dispose',
    ])
    expect(f.sandboxes.create).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: [], labels: expect.objectContaining({ leaseEpoch: 1 }) }),
      expect.any(AbortSignal),
    )
    expect(f.leases.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: MAX_SANDBOX_TURN_MS + TURN_PUBLICATION_GRACE_MS }),
    )
    // The capture refuses the turn's own credentials: the LLM key, the MCP token, secret files.
    expect(f.transport.capture).toHaveBeenCalledWith(
      f.sandbox,
      home,
      baseSha,
      ['synthetic-llm-secret', 'synthetic-mcp-secret', 'synthetic-llm-secret'],
      [],
      [],
    )
    expect(f.snapshots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        git: expect.objectContaining({
          baseSha,
          headSha,
          publication: { taskId: labels.taskId, committedAt: f.request.committedAt },
        }),
      }),
      {
        // Sealed in the sandbox, which keeps the captured archive: core knows only its size.
        home: expect.objectContaining({ sizeBytes: Buffer.from('home').byteLength }),
        patch: f.publication.patch,
        untracked: f.publication.untracked,
      },
      expect.any(AbortSignal),
    )
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.evidence.map((entry) => entry.phase)).toEqual([
      'leased',
      'created',
      'restored',
      'running',
      'output',
      'quiesced',
      'checkpointing',
      'checkpointed',
      'destroyed',
      'publishing',
      'completed',
    ])
    expect(f.evidence[1]).toMatchObject({ containerId: f.sandbox.id })
  })

  describe('with a working set (plan 53, Р11)', () => {
    const sandboxBaseSha = 'd'.repeat(40)
    const workingSet = { include: ['/wp-content/themes/'], exclude: [], maxBytes: 1024 }
    const sliced = (f: Fixture, sha: string | undefined) =>
      f.workspace.buildBaseBundle.mockImplementation(async () => {
        f.order.push('bundle')
        return {
          baseSha,
          ...(sha ? { sandboxBaseSha: sha } : {}),
          branch: f.request.workspace.branch,
          sha256: '0'.repeat(64),
          sizeBytes: 1,
          read: async function* () {},
        }
      })

    it('gives the sandbox the working set and takes its patch against it', async () => {
      const f = fixture()
      f.request.workspace.workingSet = workingSet
      // The media the agent adds count even when an ignore file of the site hides them.
      f.request.workspace.addOnlyPaths = ['wp-content/uploads/raditi/']
      f.request.workspace.media = {
        extensions: { png: [{ offset: 0, hex: '89504e47' }] },
        refusedNameParts: ['.php'],
        maxFileBytes: 1024,
      }
      sliced(f, sandboxBaseSha)
      Object.assign(f.publication, { sandboxBaseSha })
      await f.run()
      expect(f.workspace.buildBaseBundle).toHaveBeenCalledWith(
        expect.objectContaining({ expectedBaseSha: baseSha, workingSet }),
        f.request.committedAt,
      )
      expect(f.importBundle).toHaveBeenCalledWith(
        f.sandbox,
        expect.objectContaining({ baseSha, sandboxBaseSha }),
      )
      expect(f.transport.capture).toHaveBeenCalledWith(
        f.sandbox,
        home,
        sandboxBaseSha,
        expect.any(Array),
        ['wp-content/uploads/raditi/'],
        [],
      )
      // Publication still starts from the full base; the manifest keeps both commits.
      expect(f.workspace.preparePublication).toHaveBeenCalledWith(
        expect.objectContaining({ expectedBaseSha: baseSha, workingSet }),
      )
      expect(f.snapshots.save).toHaveBeenCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({ baseSha, sandboxBaseSha, headSha }),
        }),
        expect.anything(),
        expect.any(AbortSignal),
      )
      expect(f.evidence.find((entry) => entry.phase === 'restored')).toMatchObject({
        baseSha,
        sandboxBaseSha,
      })
      expect(f.publication.publish).toHaveBeenCalledOnce()
    })

    it.each([
      ['a full bundle for a plan with a working set', workingSet, undefined, undefined],
      ['a working set for a plan without one', undefined, sandboxBaseSha, undefined],
      ['another commit than the plan names', workingSet, sandboxBaseSha, 'e'.repeat(40)],
    ])('refuses %s before a container is made', async (_, set, bundled, planned) => {
      const f = fixture()
      if (set) f.request.workspace.workingSet = set
      if (planned) f.request.workspace.sandboxBaseSha = planned
      sliced(f, bundled)
      await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.sandboxes.create).not.toHaveBeenCalled()
      expectSiteFree(f)
    })

    it('publishes nothing from a candidate cut from another working set', async () => {
      const f = fixture()
      f.request.workspace.workingSet = workingSet
      sliced(f, sandboxBaseSha)
      Object.assign(f.publication, { sandboxBaseSha: 'e'.repeat(40) })
      await expect(f.run()).rejects.toThrow('another working set')
      expect(f.snapshots.save).not.toHaveBeenCalled()
      expect(f.publication.publish).not.toHaveBeenCalled()
    })
  })

  it('keeps lease authority beyond a late 60-second push without a heartbeat', async () => {
    const f = fixture()
    await expectLeaseCoversLatePush(
      f,
      () => f.run(),
      f.request.sandbox.hardTimeoutMs,
      () => f.leases.acquire.mock.calls[0]![0].ttlMs,
    )
  })

  it('keeps the same late-push margin when the lease grant arrives 40 seconds late', async () => {
    const f = fixture()
    delayGrant(f.leases.acquire, 40_000)
    await expectLeaseCoversLatePush(
      f,
      () => f.run(),
      f.request.sandbox.hardTimeoutMs,
      () => f.leases.acquire.mock.calls[0]![0].ttlMs,
    )
  })

  it('keeps the finalize reserve: an agent that ends just before its deadline is still saved and pushed', async () => {
    const f = fixture()
    useFakeClock()
    const startedAt = Date.now()
    // The agent works until 10 s before the deadline it gets. With the whole limit as its
    // deadline that was 19:50, and the steps after it could not fit into the 20 minutes.
    vi.mocked(f.handle.wait).mockImplementation(async () => {
      const { timeoutMs } = vi.mocked(f.sandbox.exec).mock.calls[0]![0]
      await vi.advanceTimersByTimeAsync(timeoutMs! - 10_000)
      return { code: 0, reason: 'exited' }
    })
    takes(f.transport.capture, 30_000)
    takes(f.workspace.preparePublication, 30_000)
    takes(f.snapshots.save, 30_000)
    takes(f.publication.publish, 30_000)
    await expect(f.run()).resolves.toMatchObject({ result })
    expect(vi.mocked(f.sandbox.exec).mock.calls[0]![0].timeoutMs).toBe(
      MAX_SANDBOX_TURN_MS - TURN_FINALIZE_RESERVE_MS,
    )
    // The container keeps the whole limit and outlives the agent for capture, save and push.
    expect(f.sandboxes.create).toHaveBeenCalledWith(
      expect.objectContaining({ hardTimeoutMs: MAX_SANDBOX_TURN_MS }),
      expect.any(AbortSignal),
    )
    expect(f.order).toEqual(expect.arrayContaining(['capture', 'candidate', 'save', 'publish']))
    expect(f.evidence.at(-1)?.phase).toBe('completed')
    expect(Date.now() - startedAt).toBeLessThan(MAX_SANDBOX_TURN_MS)
  })

  it('does not start the agent when less than the finalize reserve is left', async () => {
    const f = fixture()
    useFakeClock()
    takes(f.importBundle, MAX_SANDBOX_TURN_MS - TURN_FINALIZE_RESERVE_MS)
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED', message: 'timeout' })
    expect(f.sandbox.exec).not.toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledWith('timeout')
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'timeout' })
  })

  it('rejects a turn limit that leaves no time for the agent, before the lease', async () => {
    const f = fixture()
    f.request.sandbox.hardTimeoutMs = TURN_FINALIZE_RESERVE_MS
    await expect(f.run()).rejects.toThrow('no time for the agent')
    expect(f.leases.acquire).not.toHaveBeenCalled()
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
    await vi.advanceTimersByTimeAsync(f.request.sandbox.hardTimeoutMs)
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
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.publication.dispose).toHaveBeenCalledOnce()
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
      if (!cancellation) await vi.advanceTimersByTimeAsync(f.request.sandbox.hardTimeoutMs)
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(f.snapshots.save).toHaveBeenCalledOnce()
      expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
      expect(f.leases.release).toHaveBeenCalledOnce()
      expect(f.publication.publish).not.toHaveBeenCalled()
      // Why the site was released without a checkpoint: the interruption, and no prefix.
      expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason })
      expect(f.evidence.at(-1)).not.toHaveProperty('snapshotPrefix')
    },
  )

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

  it('disposes a candidate that only arrives after cancellation', async () => {
    const f = fixture()
    const cancellation = new AbortController()
    const late = Promise.withResolvers<typeof f.publication>()
    f.workspace.preparePublication.mockImplementation(() => {
      cancellation.abort()
      return late.promise
    })
    await expect(f.run(cancellation.signal)).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(f.leases.release).toHaveBeenCalledOnce()
    late.resolve(f.publication)
    await vi.waitFor(() => expect(f.publication.dispose).toHaveBeenCalledOnce())
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.publication.publish).not.toHaveBeenCalled()
  })

  /** The committed checkpoint of turn 1, whose candidate is the fixture's base commit. */
  async function checkpointOfTurnOne(f: Fixture) {
    const memory = memoryStorage()
    const transit = memoryTransit()
    const service = new SnapshotService(memory.storage, transit.secrets)
    const prior = {
      home: await tarZst({ [home.include[0]!]: 'prior conversation' }),
      untracked: emptyUntrackedArchive(),
      patch: Buffer.from('prior patch'),
    }
    await service.save(
      {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0', nativeSessionId: 'prior-native' },
        home,
        git: {
          provider: 'gitea',
          branch: f.request.workspace.branch,
          baseSha: 'a'.repeat(40),
          headSha: baseSha,
        },
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

  it('restores turn n−1 through presigned GETs before installing the new turn secrets', async () => {
    const f = fixture()
    const { prior, transit, reference } = await checkpointOfTurnOne(f)
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = reference
    await f.run()
    expect(f.transport.restore).toHaveBeenCalledWith(f.sandbox, home, {
      home: Buffer.from(prior.home),
      untracked: Buffer.from(prior.untracked),
      patch: Buffer.from(prior.patch),
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

  it('restores the checkpoint the replaced turn started from, older than turn n−1', async () => {
    const f = fixture()
    const { prior, transit, reference } = await checkpointOfTurnOne(f)
    // Turn 2 continued turn 1 and failed: turn 3 replaces it and starts where turn 2 started.
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 3 } }
    f.request.context = { ...f.request.context, turn: 3 }
    f.request.replacesTurn = 2
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: baseSha }
    f.request.previous = reference
    const rollback = vi.fn(async () => {})
    f.deps.contentRollback = { rollback }
    await f.run()
    expect(rollback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turn: 2 }))
    expect(f.transport.restore).toHaveBeenCalledWith(f.sandbox, home, {
      home: Buffer.from(prior.home),
      untracked: Buffer.from(prior.untracked),
      patch: Buffer.from(prior.patch),
    })
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ nativeSessionId: 'prior-native' }),
    )
    expect(f.evidence.at(-1)?.phase).toBe('completed')
    expect(transit.allZeroed()).toBe(true)
  })

  it('refuses a previous checkpoint of another checkout before creating a container', async () => {
    const f = fixture()
    f.snapshots.restoreSource.mockResolvedValue({
      manifest: {
        ...(await f.snapshots.load()).manifest,
        git: { provider: 'gitea', branch: f.request.workspace.branch, baseSha, headSha },
      },
      parts: {} as TurnRestoreSource['parts'],
      dataKey: vi.fn(),
    })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it('seals the home part in the sandbox and commits a snapshot core can load back', async () => {
    const f = fixture()
    const memory = memoryStorage()
    const transit = memoryTransit()
    const service = new SnapshotService(memory.storage, transit.secrets)
    const captured = {
      home: await tarZst({ [home.include[0]!]: 'native session' }),
      untracked: emptyUntrackedArchive(),
      patch: Buffer.from('tracked-patch'),
    }
    f.transport.capture.mockResolvedValue(captured)
    f.publication.untracked = emptyUntrackedArchive()
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
    expect(loaded.manifest.git).toMatchObject({ baseSha, headSha })
    expect(Buffer.from(loaded.archives.home)).toEqual(Buffer.from(captured.home))
    expect(Buffer.from(loaded.archives.patch!)).toEqual(Buffer.from(f.publication.patch))
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
      home: await tarZst({ [home.include[0]!]: 'native session' }),
      untracked: emptyUntrackedArchive(),
      patch: Buffer.from('tracked-patch'),
    })
    f.publication.untracked = emptyUntrackedArchive()
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
    expect(f.importBundle).not.toHaveBeenCalled()
    expect(f.sandbox.exec).not.toHaveBeenCalled()
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
      inflightReleaseId: null,
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
    // A release held for the operator (Р31): the site waits for `releases:resolve`, so does the
    // turn — the dialog is not ended for it.
    [
      'a release held for the operator stands',
      true,
      '00000000-0000-4000-8000-00000000000a',
      'SITE_BUSY',
    ],
    ['a release barrier stands', false, '00000000-0000-4000-8000-00000000000a', 'SITE_BUSY'],
    ['the lease lookup fails', undefined, null, 'SITE_BUSY'],
  ] as const)('tells the client why a site is refused: %s', async (_, held, release, code) => {
    const f = fixture()
    f.leases.acquire.mockResolvedValueOnce(null as never)
    if (held === undefined) f.leases.inspect.mockRejectedValueOnce(new Error('connection reset'))
    else
      f.leases.inspect.mockResolvedValueOnce({
        siteId: labels.siteId,
        taskId: '00000000-0000-4000-8000-000000000009',
        operation: release ? 'deploy' : 'turn',
        epoch: 7,
        expiresAt: new Date(),
        serverNow: new Date(),
        heldForOperator: held,
        inflightReleaseId: release,
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

  it('requires the previous checkpoint for every resumed turn with a repository', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    await expect(f.run()).rejects.toThrow('previous checkpoint')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it('starts a turn after «Обновить» as a new session, with no checkpoint (plan 53, Р27)', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.rebased = true
    await f.run()
    expect(f.snapshots.restoreSource).not.toHaveBeenCalled()
    expect(f.transport.restore).not.toHaveBeenCalled()
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.not.objectContaining({ nativeSessionId: expect.anything() }),
    )
    expect(f.workspace.buildBaseBundle).toHaveBeenCalledWith(
      f.request.workspace,
      f.request.committedAt,
    )
    expect(f.evidence.at(-1)?.phase).toBe('completed')
  })

  it('replaces an unsuccessful turn after «Обновить» with a new session, its content undone first', async () => {
    // The turn that failed before the move, or a failed new session on the moved head (R3).
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.replacesTurn = 1
    f.request.workspace = { ...f.request.workspace, expectedBranchSha: baseSha }
    f.request.rebased = true
    const rollback = vi.fn(async () => {
      expect(f.workspace.buildBaseBundle).not.toHaveBeenCalled()
      f.order.push('undo')
    })
    f.deps.contentRollback = { rollback }
    await f.run()
    expect(rollback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turn: 1 }))
    expect(f.order.indexOf('undo')).toBeLessThan(f.order.indexOf('create'))
    expect(f.snapshots.restoreSource).not.toHaveBeenCalled()
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.not.objectContaining({ nativeSessionId: expect.anything() }),
    )
    expect([...f.assignments.rows.values()][0]!.plan).toMatchObject({
      replacesTurn: 1,
      rebased: true,
    })
    expect(f.evidence.at(-1)?.phase).toBe('completed')
  })

  it.each([
    ['a first turn', (f: Fixture) => void f],
    [
      'a checkpoint',
      (f: Fixture) => {
        f.request.previous = {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: 1,
          image,
          driver: { id: sampleDriverId, version: '1.0.0' },
          home,
        }
      },
    ],
    [
      'a replacement that restores a checkpoint',
      (f: Fixture) => {
        f.request.replacesTurn = 1
        f.request.workspace = { ...f.request.workspace, expectedBranchSha: baseSha }
        f.request.previous = {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: 1,
          image,
          driver: { id: sampleDriverId, version: '1.0.0' },
          home,
        }
        f.deps.contentRollback = { rollback: vi.fn(async () => {}) }
      },
    ],
    [
      'a resumed session',
      (f: Fixture) => {
        f.request.context = { ...f.request.context, nativeSessionId: 'prior-native' }
      },
    ],
  ])('refuses a rebased turn with %s before the lease', async (name, change) => {
    const f = fixture()
    if (name !== 'a first turn') {
      f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
      f.request.context = { ...f.request.context, turn: 2 }
    }
    change(f)
    f.request.rebased = true
    await expect(f.run()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<SnapshotReference>]>([
    ['workspace', { workspaceId: '00000000-0000-4000-8000-000000000009' }],
    ['session', { sessionId: 'other-session' }],
    ['turn', { turn: 2 }],
    ['image', { image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'e'.repeat(64)}` }],
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

  it.each(['branch', 'turn', 'sha', 'protected paths'] as const)(
    'rejects invalid publication metadata (%s) before acquiring a lease',
    async (kind) => {
      const f = fixture()
      if (kind === 'branch') f.request.workspace.branch = 'agent/other'
      if (kind === 'sha') f.request.workspace.expectedBaseSha = 'b'.repeat(64)
      if (kind === 'protected paths')
        delete (f.request.workspace as { protectedPaths?: string[] }).protectedPaths
      if (kind === 'turn') {
        f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 1_000_000 } }
        f.request.context = { ...f.request.context, turn: 1_000_000 }
        f.request.previous = {
          workspaceId: labels.workspaceId,
          sessionId: labels.sessionId,
          turn: 999_999,
          image,
          driver: { id: sampleDriverId, version: '1.0.0' },
          home,
        }
      }
      await expect(f.run()).rejects.toThrow('publication metadata')
      expect(f.leases.acquire).not.toHaveBeenCalled()
    },
  )

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
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
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
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
  })

  it.each(['snapshot', 'publish'] as const)(
    'holds ambiguous %s failures with durable recovery evidence',
    async (point) => {
      const f = fixture()
      if (point === 'snapshot')
        f.snapshots.save.mockRejectedValueOnce(new Error('credential-must-not-be-recorded'))
      else f.publication.publish.mockRejectedValueOnce(new Error('credential-must-not-be-recorded'))
      await expect(f.run()).rejects.toThrow()
      expect(f.leases.holdForRecovery).toHaveBeenCalledOnce()
      expect(f.leases.release).not.toHaveBeenCalled()
      expect(f.sandbox.destroy).toHaveBeenCalledOnce()
      expect(f.evidence.at(-1)).toMatchObject({
        phase: 'recovery',
        reason: point === 'snapshot' ? 'snapshot_ambiguous' : 'publication_ambiguous',
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
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
    expect(f.evidence.at(-1)).not.toHaveProperty('snapshotPrefix')
  })

  it.each(['archive', 'home'] as const)(
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
    f.workspace.buildBaseBundle.mockImplementationOnce(async () => {
      during = f.deps.live.has(f.lease)
      throw new Error('clone failed')
    })
    await expect(f.run()).rejects.toThrow('clone failed')
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
    expect(f.workspace.buildBaseBundle).not.toHaveBeenCalled()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'run_failed' })
  })

  it('holds a site when container deletion remains uncertain', async () => {
    const f = fixture()
    vi.mocked(f.sandbox.destroy).mockRejectedValue(new Error('unreachable daemon'))
    await expect(f.run()).rejects.toThrow()
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).toHaveBeenCalled()
    expect(f.leases.release).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)).toMatchObject({ reason: 'destroy_failed' })
  })

  it('fences a stale owner before the next operation and still destroys its container', async () => {
    const f = fixture()
    f.importBundle.mockImplementation(async () => {
      f.leases.assert.mockResolvedValue(false)
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(f.sandbox.exec).not.toHaveBeenCalled()
    expect(f.publication.publish).not.toHaveBeenCalled()
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
    expect(f.workspace.preparePublication).not.toHaveBeenCalled()
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'snapshot_credential' })
    expect(f.evidence.at(-1)).not.toHaveProperty('snapshotPrefix')
    expect(JSON.stringify(f.evidence)).not.toContain(f.request.context.llm.apiKey)
  })

  it('hands the turn credentials to the candidate and releases the site when a changed file holds one', async () => {
    const f = fixture()
    f.workspace.preparePublication.mockRejectedValueOnce(snapshotHasCredential())
    await expect(f.run()).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    expect(f.workspace.preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.arrayContaining([
          f.request.context.llm.apiKey,
          f.request.context.mcp.token,
        ]),
      }),
    )
    expect(f.snapshots.save).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
    expect(f.evidence.at(-1)).toMatchObject({ phase: 'failed', reason: 'snapshot_credential' })
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
  const request = f.request as TurnRequest
  delete request.workspace
  request.requirements = { ...BROWSER_ONLY }
  f.deps.workspace = null
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

describe.each(executorKinds)('TurnSupervisor without a repository (%s executor)', (kind) => {
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
    expect(f.workspace.buildBaseBundle).not.toHaveBeenCalled()
    expect(f.importBundle).not.toHaveBeenCalled()
    expect(f.workspace.preparePublication).not.toHaveBeenCalled()
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.order).toContain('workdir:mkdir')
    expect(f.order.indexOf('workdir:mkdir')).toBeLessThan(f.order.indexOf('exec'))
    // Capture reads no working copy: no base reaches the transport.
    expect((f.transport.capture.mock.calls[0] as unknown[])[2]).toBeUndefined()
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
    expect(f.workspace.buildBaseBundle).not.toHaveBeenCalled()
  })

  it('refuses a checkpoint with a repository as turn n−1 before creating a container', async () => {
    const f = fixture()
    // The checkpoint of a turn with a repository, read before the task loses its workspace.
    const { manifest } = await f.snapshots.load()
    withoutRepository(f)
    f.snapshots.restoreSource.mockResolvedValue({
      manifest,
      parts: {} as TurnRestoreSource['parts'],
      dataKey: vi.fn(),
    })
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
    await expect(f.run()).rejects.toThrow('holds a repository')
    expect(f.sandboxes.create).not.toHaveBeenCalled()
    expect(f.leases.release).toHaveBeenCalledOnce()
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

  it('refuses a replacement or a rebased start before the lease', async () => {
    for (const patch of [{ replacesTurn: 1 }, { rebased: true }] as const) {
      const f = fixture()
      withoutRepository(f)
      f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
      f.request.context = { ...f.request.context, turn: 2 }
      Object.assign(f.request, patch)
      await expect(f.run()).rejects.toThrow('neither replaces nor rebases')
      expect(f.leases.acquire).not.toHaveBeenCalled()
    }
  })

  it('refuses a turn with a repository before the lease while git is not configured', async () => {
    const f = fixture()
    f.deps.workspace = null
    await expect(f.run()).rejects.toMatchObject({ code: 'GIT_NOT_CONFIGURED' })
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it('refuses a plan whose workspace contradicts its requirements', async () => {
    const f = fixture()
    ;(f.request as TurnRequest).requirements = { ...BROWSER_ONLY }
    await expect(f.run()).rejects.toThrow('exactly when it has a repository')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })
})

// On runner VMs the containers of a held turn are adopted through its assignment, which this
// recovery moves to the new epoch first; turn-exec-recovery.test.ts runs it on both executors.
describe.each(['local'])('committed checkpoint publication recovery (%s executor)', (kind) => {
  async function recoveryFixture() {
    const f = turnFixture(kind)
    const loaded = await f.snapshots.load()
    loaded.manifest.git!.headSha = headSha
    loaded.manifest.git!.publication = { taskId: labels.taskId, committedAt: f.request.committedAt }
    loaded.archives.patch = f.publication.patch
    loaded.archives.untracked = f.publication.untracked
    f.snapshots.load.mockResolvedValue(loaded)
    const assignment = (await f.assignments.open({
      fence: f.lease,
      sessionId: labels.sessionId,
      turn: 1,
      executor: 'local',
      plan: toTurnPlan(f.request, sampleDriverId),
      remainingMs: 60_000,
    }))!
    const input: PublicationRecoveryRequest = {
      assignmentId: assignment.id,
      heldFence: f.lease,
      workspace: f.request.workspace,
      snapshot: {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0' },
        home,
      },
      // Its owner journaled the removal: only what the labels still find is removed.
      removal: 'confirmed',
      remainingMs: 60_000,
      labels: { ...labels, leaseEpoch: 1 },
    }
    return {
      ...f,
      input,
      loaded,
      assignment,
      takeOver: vi.spyOn(f.assignments, 'takeOver'),
      recover: () => new TurnPublicationRecovery(f.deps).recover(input),
    }
  }

  it('reconstructs the exact candidate, destroys the stale container and publishes under a new fence', async () => {
    const f = await recoveryFixture()
    f.sandboxes.list.mockResolvedValue([
      { id: f.sandbox.id, labels: f.sandbox.labels, createdAt: new Date() },
    ])
    f.sandboxes.getForRemoval.mockResolvedValue(f.sandbox)
    await expect(f.recover()).resolves.toMatchObject({ headSha })
    expect(f.takeOver).toHaveBeenCalledWith(
      expect.objectContaining({
        fence: f.lease,
        ttlMs: RECOVERY_TIMEOUT_MS + TURN_PUBLICATION_GRACE_MS,
      }),
    )
    expect(f.order.indexOf('destroy')).toBeGreaterThan(-1)
    expect(f.order.indexOf('destroy')).toBeLessThan(f.order.indexOf('publish'))
    // Removal only: nothing is taken over to work in.
    expect(f.sandboxes.get).not.toHaveBeenCalled()
    expect(f.workspace.preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: f.request.committedAt,
        patch: f.publication.patch,
        untracked: f.publication.untracked,
        // The completed snapshot passed the credential check before its checkpoint.
        credentials: [],
      }),
    )
    expect(f.leases.release).toHaveBeenCalledWith(expect.objectContaining({ epoch: 2 }))
    expect(f.evidence.at(-1)).toMatchObject({
      phase: 'publication_recovered',
      recoveredFromEpoch: 1,
    })
    // The assignment moved to the new epoch before any container was adopted, and ended there.
    expect(await f.assignments.get(f.assignment.id)).toMatchObject({
      fence: { epoch: 2 },
      recoveryAttempts: 1,
      outcome: 'completed',
    })
    expect(f.driver.prepare).not.toHaveBeenCalled()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it.each([
    [15 * 60_000, 15 * 60_000],
    [0, RECOVERY_TIMEOUT_MS],
    [-60_000, RECOVERY_TIMEOUT_MS],
  ])(
    'keeps the new epoch past a container that is still to be removed (%i ms of the turn left)',
    async (remainingMs, covered) => {
      const f = await recoveryFixture()
      f.input.removal = 'adopt'
      f.input.remainingMs = remainingMs
      await expect(f.recover()).resolves.toMatchObject({ headSha })
      expect(f.takeOver).toHaveBeenCalledWith(
        expect.objectContaining({ fence: f.lease, ttlMs: covered + TURN_PUBLICATION_GRACE_MS }),
      )
    },
  )

  it('removes a listed container that can no longer run anything before it publishes', async () => {
    const f = await recoveryFixture()
    f.sandboxes.list.mockResolvedValue([
      { id: f.sandbox.id, labels: f.sandbox.labels, createdAt: new Date() },
    ])
    // Its gateway died: get() refuses it, removal still reaches it.
    f.sandboxes.get.mockResolvedValue(null)
    f.sandboxes.getForRemoval.mockResolvedValue(f.sandbox)
    await expect(f.recover()).resolves.toMatchObject({ headSha })
    expect(f.order.indexOf('destroy')).toBeGreaterThan(-1)
    expect(f.order.indexOf('destroy')).toBeLessThan(f.order.indexOf('publish'))
  })

  it.each(['CONFLICT', 'SANDBOX_COMMAND_FAILED'])(
    'holds the site without publishing while a listed container cannot be removed (%s)',
    async (code) => {
      const f = await recoveryFixture()
      f.sandboxes.list.mockResolvedValue([
        { id: f.sandbox.id, labels: f.sandbox.labels, createdAt: new Date() },
      ])
      f.sandboxes.getForRemoval.mockRejectedValue(new DomainError(code, 'Not removable', 409))
      await expect(f.recover()).rejects.toMatchObject({ code })
      expect(f.publication.publish).not.toHaveBeenCalled()
      expect(f.leases.holdForRecovery).toHaveBeenCalledWith(expect.objectContaining({ epoch: 2 }))
      expect(f.leases.release).not.toHaveBeenCalled()
    },
  )

  it('retains the new epoch beyond a late 60-second recovery push without a heartbeat', async () => {
    const f = await recoveryFixture()
    await expectLeaseCoversLatePush(
      f,
      () => f.recover(),
      RECOVERY_TIMEOUT_MS,
      () => f.takeOver.mock.calls[0]![0].ttlMs,
    )
  })

  it('keeps the same recovery push margin when the reclaim arrives 40 seconds late', async () => {
    const f = await recoveryFixture()
    delayGrant(f.leases.takeOverHeld, 40_000)
    await expectLeaseCoversLatePush(
      f,
      () => f.recover(),
      RECOVERY_TIMEOUT_MS,
      () => f.takeOver.mock.calls[0]![0].ttlMs,
    )
  })

  it('does not reclaim an incomplete reservation without a committed manifest', async () => {
    const f = await recoveryFixture()
    f.snapshots.load.mockRejectedValue(new Error('manifest missing'))
    await expect(f.recover()).rejects.toThrow('manifest missing')
    expect(f.takeOver).not.toHaveBeenCalled()
    expect(f.publication.publish).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing manifest', notFound('Snapshot or snapshot part is missing'), true],
    ['a manifest of another turn', conflict('Snapshot is incompatible'), true],
    ['a storage error', new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load', 502), false],
    ['a timeout', new TimeoutError('Snapshot recovery read timed out'), false],
  ])('tells %s from a failed read before any takeover', async (_case, error, missing) => {
    const f = await recoveryFixture()
    f.snapshots.load.mockRejectedValue(error)
    const refused = await f.recover().catch((caught: unknown) => caught)
    expect(isMissingCheckpoint(refused)).toBe(missing)
    expect(f.takeOver).not.toHaveBeenCalled()
  })

  it('refuses a checkpoint of another publication as missing', async () => {
    const f = await recoveryFixture()
    f.loaded.manifest.git!.branch = 'agent/another'
    const refused = await f.recover().catch((caught: unknown) => caught)
    expect(isMissingCheckpoint(refused)).toBe(true)
    expect(f.takeOver).not.toHaveBeenCalled()
  })

  it('requires explicit protected paths before reading the snapshot or reclaiming', async () => {
    const f = await recoveryFixture()
    delete (f.input.workspace as { protectedPaths?: string[] }).protectedPaths
    await expect(f.recover()).rejects.toThrow('recovery source')
    expect(f.snapshots.load).toHaveBeenCalledTimes(1)
    expect(f.takeOver).not.toHaveBeenCalled()
  })

  it('takes nothing over and publishes nothing when the assignment moved on', async () => {
    const f = await recoveryFixture()
    await f.assignments.finish({ id: f.assignment.id, epoch: 1, outcome: 'failed' })
    await expect(f.recover()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.publication.publish).not.toHaveBeenCalled()
    // The lease stays held where it was: no newer epoch exists that nothing points at.
    await expect(f.takeOver.mock.results[0]!.value).resolves.toBeNull()
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
  })

  it('requires the exact deliberately held fence', async () => {
    const f = await recoveryFixture()
    f.takeOver.mockResolvedValueOnce(null)
    await expect(f.recover()).rejects.toThrow('held lease')
    expect(f.workspace.preparePublication).not.toHaveBeenCalled()
  })

  it('holds the site again when replay derives another working set than the checkpoint', async () => {
    const f = await recoveryFixture()
    f.loaded.manifest.git!.sandboxBaseSha = 'd'.repeat(40)
    await expect(f.recover()).rejects.toThrow('candidate differs')
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).toHaveBeenCalledWith(expect.objectContaining({ epoch: 2 }))
  })

  it('publishes a checkpoint of a working set when replay derives the same one', async () => {
    const f = await recoveryFixture()
    f.loaded.manifest.git!.sandboxBaseSha = 'd'.repeat(40)
    Object.assign(f.publication, { sandboxBaseSha: 'd'.repeat(40) })
    await expect(f.recover()).resolves.toMatchObject({ headSha })
    expect(f.evidence.at(-1)).toMatchObject({
      phase: 'publication_recovered',
      sandboxBaseSha: 'd'.repeat(40),
    })
  })

  it('holds the site again when replay would produce a different commit', async () => {
    const f = await recoveryFixture()
    f.publication.headSha = 'd'.repeat(40)
    await expect(f.recover()).rejects.toThrow('candidate differs')
    expect(f.publication.publish).not.toHaveBeenCalled()
    expect(f.leases.holdForRecovery).toHaveBeenCalledWith(expect.objectContaining({ epoch: 2 }))
    expect(f.leases.release).not.toHaveBeenCalled()
  })

  it('logs a failed hold of the new epoch with only its epoch and phase', async () => {
    const f = await recoveryFixture()
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    f.publication.publish.mockRejectedValue(new Error('push reply lost'))
    f.leases.holdForRecovery.mockResolvedValue(false)
    await expect(f.recover()).rejects.toThrow('push reply lost')
    expect(error).toHaveBeenCalledWith(
      'Site lease hold for recovery was refused (epoch 2, phase publishing)',
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain(labels.siteId)
  })

  it('keeps the new epoch held when publication is still ambiguous', async () => {
    const f = await recoveryFixture()
    f.publication.publish.mockRejectedValue(new Error('push reply lost'))
    await expect(f.recover()).rejects.toThrow()
    expect(f.evidence.at(-1)).toMatchObject({
      phase: 'recovery',
      reason: 'publication_ambiguous',
      candidateHeadSha: headSha,
    })
    expect(f.leases.holdForRecovery).toHaveBeenCalledWith(expect.objectContaining({ epoch: 2 }))
    expect(f.leases.release).not.toHaveBeenCalled()
  })
})
