import { Buffer } from 'node:buffer'

import {
  SANDBOX_SECRETS_DIR,
  type AgentDriver,
  type AgentEvent,
  type ExecHandle,
  type PreparedRun,
  type Sandbox,
  type SandboxInfo,
  type SiteLeaseGrant,
  type SiteLeaseFence,
  type SnapshotManifest,
  type SnapshotMetadata,
  type TurnEvidence,
  type TurnResult,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      hardTimeoutMs: 60_000,
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
    save: vi.fn(async (metadata: SnapshotMetadata) => {
      order.push('save')
      return manifest(metadata)
    }),
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

afterEach(() => vi.useRealTimers())

async function expectLeaseCoversLatePush(
  f: ReturnType<typeof fixture>,
  run: () => Promise<unknown>,
  hardTimeoutMs: number,
  requestedTtl: () => number,
): Promise<void> {
  vi.useFakeTimers()
  const startedAt = Date.now()
  const pushStarted = Promise.withResolvers<void>()
  // Model a dead core heartbeat while the already-fenced native push remains in flight.
  f.leases.renew.mockImplementation(() => new Promise(() => {}))
  f.journal.record.mockImplementation(async (entry) => {
    f.evidence.push(structuredClone(entry))
    if (entry.phase === 'publishing') await vi.advanceTimersByTimeAsync(hardTimeoutMs - 1)
  })
  f.publication.publish.mockImplementation(async (assertFence) => {
    await assertFence()
    pushStarted.resolve()
    await new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('push reply lost')), 60_000)
    })
  })
  const rejected = expect(run()).rejects.toThrow()
  await pushStarted.promise
  expect(requestedTtl() - hardTimeoutMs).toBeGreaterThanOrEqual(90_000)
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  expect(startedAt + requestedTtl() - Date.now()).toBeGreaterThanOrEqual(30_000)
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
    expect(f.leases.acquire).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: 150_000 }))
    expect(f.transport.capture).toHaveBeenCalledWith(f.sandbox, home, baseSha)
    expect(f.snapshots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        git: expect.objectContaining({
          baseSha,
          headSha,
          publication: { taskId: labels.taskId, committedAt: f.request.committedAt },
        }),
      }),
      { home: Buffer.from('home'), patch: f.publication.patch, untracked: f.publication.untracked },
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
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('requires the previous checkpoint for every resumed turn', async () => {
    const f = fixture()
    f.request.sandbox = { ...f.request.sandbox, labels: { ...labels, turn: 2 } }
    f.request.context = { ...f.request.context, turn: 2 }
    await expect(f.run()).rejects.toThrow('previous checkpoint')
    expect(f.leases.acquire).not.toHaveBeenCalled()
  })

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
    await expect(f.run()).rejects.toThrow('file path')
    expect(f.sandbox.exec).not.toHaveBeenCalled()
    expect(f.sandbox.destroy).toHaveBeenCalledOnce()
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

  it('does not reclaim an incomplete reservation without a committed manifest', async () => {
    const f = await recoveryFixture()
    f.snapshots.load.mockRejectedValue(new Error('manifest missing'))
    await expect(f.recover()).rejects.toThrow('manifest missing')
    expect(f.leases.reclaimForRecovery).not.toHaveBeenCalled()
    expect(f.publication.publish).not.toHaveBeenCalled()
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
