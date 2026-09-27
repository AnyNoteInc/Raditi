import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

import { Logger } from '@nestjs/common'
import {
  DomainError,
  leaseLost,
  MAX_SANDBOX_TURN_MS,
  SANDBOX_SECRETS_DIR,
  snapshotHasCredential,
  TURN_FINALIZE_RESERVE_MS,
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
  type TurnEvidence,
  type TurnResult,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { SnapshotArchives } from '../sessions/sandbox-snapshot.ts'
import { SnapshotService } from '../sessions/snapshot.service.ts'
import { TurnPublicationRecovery, type PublicationRecoveryRequest } from './turn-recovery.ts'

import {
  TurnSupervisor,
  type TurnRequest,
  type TurnSupervisorDependencies,
} from './turn-supervisor.ts'

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
const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
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

function fixture() {
  const order: string[] = []
  const evidence: TurnEvidence[] = []
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
    files: [{ path: '/agent-home/codex/config.toml', content: 'synthetic = true' }],
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
    reclaimForRecovery: vi.fn(async (_fence: SiteLeaseFence, ttlMs: number) => ({
      ...grant(ttlMs),
      epoch: 2,
    })),
    holdForRecovery: vi.fn(async () => {
      order.push('hold')
      return true
    }),
  }
  const driver: AgentDriver = {
    id: 'codex',
    image,
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
    extractResult: vi.fn(
      (events: readonly AgentEvent[]) =>
        JSON.parse(events.findLast((event) => event.type === 'message')?.text ?? 'null') as unknown,
    ),
  }
  const publication = {
    baseSha,
    headSha,
    patch: Buffer.from('full-patch-with-new-files'),
    untracked: Buffer.from('empty-valid-archive'),
    publish: vi.fn(async (assertFence: () => Promise<void>) => {
      await assertFence()
      order.push('publish')
    }),
    dispose: vi.fn(async () => {
      order.push('dispose')
    }),
  }
  const archives = {
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
      async (metadata: SnapshotMetadata, _archives: SnapshotArchives, _signal: AbortSignal) => {
        order.push('save')
        return manifest(metadata)
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
          driver: { id: 'codex', version: '1.0.0', nativeSessionId: 'prior-native' },
          home,
          git: { provider: 'gitea', branch: request.workspace.branch, baseSha, headSha: baseSha },
        }),
        archives,
      }
    }),
  }
  const workspace = {
    prepareWorkspace: vi.fn(async () => {
      order.push('checkout')
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
    list: vi.fn(async () => [] as SandboxInfo[]),
  }
  const deps: TurnSupervisorDependencies = {
    leases,
    driver,
    sandboxes,
    workspace,
    snapshots,
    transport,
    journal,
  }
  return {
    request,
    prepared,
    order,
    evidence,
    deps,
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
    sandboxes,
    stdout: (value: string) => {
      stdout = value
    },
    run: (signal?: AbortSignal) => new TurnSupervisor(deps).run(request, signal),
  }
}

afterEach(() => {
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

async function expectLeaseCoversLatePush(
  f: ReturnType<typeof fixture>,
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

describe('PoC TurnSupervisor', () => {
  it('snapshots the candidate before destroying the container and publishing', async () => {
    const f = fixture()
    const finished = await f.run()
    expect(finished.result).toEqual(result)
    expect(f.order).toEqual([
      'create',
      'checkout',
      'prepare',
      'write:/agent-home/codex/config.toml',
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
    expect(f.transport.capture).toHaveBeenCalledWith(f.sandbox, home, baseSha, [
      'synthetic-llm-secret',
      'synthetic-mcp-secret',
      'synthetic-llm-secret',
    ])
    expect(f.snapshots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        git: expect.objectContaining({
          baseSha,
          headSha,
          publication: { taskId: labels.taskId, committedAt: f.request.committedAt },
        }),
      }),
      { home: Buffer.from('home'), patch: f.publication.patch, untracked: f.publication.untracked },
      expect.any(AbortSignal),
    )
    expect(f.leases.holdForRecovery).not.toHaveBeenCalled()
    expect(f.evidence.at(-1)?.phase).toBe('completed')
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
    takes(f.workspace.prepareWorkspace, MAX_SANDBOX_TURN_MS - TURN_FINALIZE_RESERVE_MS)
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

  it('restores the prior candidate before installing the new turn secrets', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: 'codex', version: '1.0.0' },
      home,
    }
    await f.run()
    expect(f.order.indexOf('restore')).toBeLessThan(f.order.indexOf('prepare'))
    expect(f.driver.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ nativeSessionId: 'prior-native' }),
    )
    expect(f.order.indexOf(`write:${SANDBOX_SECRETS_DIR}/llm`)).toBeGreaterThan(
      f.order.indexOf('restore'),
    )
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
    ['another operation owns it', false, 'SITE_BUSY'],
    ['it waits for an operator', true, 'SITE_HELD'],
    ['the lease lookup fails', undefined, 'SITE_BUSY'],
  ] as const)('tells the client why a site is refused: %s', async (_, held, code) => {
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

  it('rejects a turn credential in the container env before the lease: docker inspect shows it', async () => {
    const f = fixture()
    f.request.sandbox.env = { AGENT_FLAGS: `--auth=${f.request.context.mcp.token}` }
    await expect(f.run()).rejects.toThrow('env contains a turn credential')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it('requires the previous checkpoint for every resumed turn', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    await expect(f.run()).rejects.toThrow('previous checkpoint')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<SnapshotReference>]>([
    ['workspace', { workspaceId: '00000000-0000-4000-8000-000000000009' }],
    ['session', { sessionId: 'other-session' }],
    ['turn', { turn: 2 }],
    ['image', { image: `registry.invalid/raditi/codex@sha256:${'e'.repeat(64)}` }],
    ['driver', { driver: { id: 'kimi', version: '1.0.0' } }],
    ['driver version', { driver: { id: 'codex', version: '2.0.0' } }],
  ])('rejects a foreign previous checkpoint (%s) before acquiring a lease', async (_, change) => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    f.request.previous = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: 'codex', version: '1.0.0' },
      home,
      ...change,
    }
    await expect(f.run()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.leases.acquire).not.toHaveBeenCalled()
    expect(f.snapshots.load).not.toHaveBeenCalled()
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
          driver: { id: 'codex', version: '1.0.0' },
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
    async (kind) => {
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
      if (kind === 'home')
        vi.mocked(f.driver.sessionState).mockReturnValue({ ...home, root: '/workspace/repo' })
      f.snapshots.save.mockImplementation((metadata, archives, signal) =>
        service.save(metadata, archives, signal),
      )
      await expect(f.run()).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
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
    f.workspace.prepareWorkspace.mockImplementation(async () => {
      f.leases.assert.mockResolvedValue(false)
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })
    expect(f.driver.prepare).not.toHaveBeenCalled()
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
      await expect(f.run()).rejects.toThrow('credential')
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

  it.each([
    [
      'a driver file',
      {
        files: [{ path: '/agent-home/codex/config.toml', content: 'key = "synthetic-llm-secret"' }],
      },
    ],
    [
      'a driver file with the MCP token',
      {
        files: [
          { path: '/agent-home/codex/mcp.json', content: '{"token":"synthetic-mcp-secret"}' },
        ],
      },
    ],
    [
      'a driver file with a secret file value',
      {
        secrets: [{ path: `${SANDBOX_SECRETS_DIR}/extra`, content: 'synthetic-extra-secret' }],
        files: [{ path: '/agent-home/codex/extra', content: 'synthetic-extra-secret' }],
      },
    ],
    ['an env value', { env: { CODEX_API_KEY: 'synthetic-llm-secret' } }],
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
      expect(f.leases.release).toHaveBeenCalledOnce()
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
    expect(f.leases.release).toHaveBeenCalledOnce()
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
    await expect(f.run()).rejects.toThrow('line exceeds')
    expect(f.snapshots.save).not.toHaveBeenCalled()
  })

  it('does not write prepared files outside allowed roots', async () => {
    const f = fixture()
    f.prepared.secrets = [{ path: '/workspace/repo/secret', content: 'secret' }]
    await expect(f.run()).rejects.toMatchObject({
      code: 'DRIVER_PREPARE_INVALID',
      message: expect.stringContaining('file path'),
    })
    expect(f.sandbox.exec).not.toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
  })

  it.each([
    '/workspace/repo/AGENTS.md',
    '/workspace/repo',
    '/workspace/out/schema.json',
    '/agent-home/../workspace/repo/AGENTS.md',
    '/agent-home/./codex/config.toml',
    `${SANDBOX_SECRETS_DIR}/config.toml`,
  ])('never writes a prepared platform file to %s, where it could be published', async (path) => {
    const f = fixture()
    f.prepared.files = [{ path, content: 'platform instructions' }]
    await expect(f.run()).rejects.toThrow('file path')
    expect(f.sandbox.fs.write).not.toHaveBeenCalled()
    expect(f.sandbox.exec).not.toHaveBeenCalled()
  })
})

describe('committed checkpoint publication recovery', () => {
  async function recoveryFixture() {
    const f = fixture()
    const loaded = await f.snapshots.load()
    loaded.manifest.git.headSha = headSha
    loaded.manifest.git.publication = { taskId: labels.taskId, committedAt: f.request.committedAt }
    loaded.archives.patch = f.publication.patch
    loaded.archives.untracked = f.publication.untracked
    f.snapshots.load.mockResolvedValue(loaded)
    const input: PublicationRecoveryRequest = {
      heldFence: f.lease,
      workspace: f.request.workspace,
      snapshot: {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: 'codex', version: '1.0.0' },
        home,
      },
    }
    return {
      ...f,
      input,
      loaded,
      recover: () => new TurnPublicationRecovery(f.deps).recover(input),
    }
  }

  it('reconstructs the exact candidate, destroys the stale container and publishes under a new fence', async () => {
    const f = await recoveryFixture()
    f.sandboxes.list.mockResolvedValue([
      { id: f.sandbox.id, labels: f.sandbox.labels, createdAt: new Date() },
    ])
    f.sandboxes.get.mockResolvedValue(f.sandbox)
    await expect(f.recover()).resolves.toMatchObject({ headSha })
    expect(f.leases.reclaimForRecovery).toHaveBeenCalledWith(f.lease, 210_000)
    expect(f.order.indexOf('destroy')).toBeLessThan(f.order.indexOf('publish'))
    expect(f.workspace.preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: f.request.committedAt,
        patch: f.publication.patch,
        untracked: f.publication.untracked,
      }),
    )
    expect(f.leases.release).toHaveBeenCalledWith(expect.objectContaining({ epoch: 2 }))
    expect(f.evidence.at(-1)).toMatchObject({
      phase: 'publication_recovered',
      recoveredFromEpoch: 1,
    })
    expect(f.driver.prepare).not.toHaveBeenCalled()
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('retains the new epoch beyond a late 60-second recovery push without a heartbeat', async () => {
    const f = await recoveryFixture()
    await expectLeaseCoversLatePush(
      f,
      () => f.recover(),
      120_000,
      () => f.leases.reclaimForRecovery.mock.calls[0]![1],
    )
  })

  it('keeps the same recovery push margin when the reclaim arrives 40 seconds late', async () => {
    const f = await recoveryFixture()
    delayGrant(f.leases.reclaimForRecovery, 40_000)
    await expectLeaseCoversLatePush(
      f,
      () => f.recover(),
      120_000,
      () => f.leases.reclaimForRecovery.mock.calls[0]![1],
    )
  })

  it('does not reclaim an incomplete reservation without a committed manifest', async () => {
    const f = await recoveryFixture()
    f.snapshots.load.mockRejectedValue(new Error('manifest missing'))
    await expect(f.recover()).rejects.toThrow('manifest missing')
    expect(f.leases.reclaimForRecovery).not.toHaveBeenCalled()
    expect(f.publication.publish).not.toHaveBeenCalled()
  })

  it('requires explicit protected paths before reading the snapshot or reclaiming', async () => {
    const f = await recoveryFixture()
    delete (f.input.workspace as { protectedPaths?: string[] }).protectedPaths
    await expect(f.recover()).rejects.toThrow('recovery source')
    expect(f.snapshots.load).toHaveBeenCalledTimes(1)
    expect(f.leases.reclaimForRecovery).not.toHaveBeenCalled()
  })

  it('requires the exact deliberately held fence', async () => {
    const f = await recoveryFixture()
    f.leases.reclaimForRecovery.mockResolvedValueOnce(null as never)
    await expect(f.recover()).rejects.toThrow('held lease')
    expect(f.workspace.preparePublication).not.toHaveBeenCalled()
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
