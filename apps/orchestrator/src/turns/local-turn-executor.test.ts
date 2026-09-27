import { Buffer } from 'node:buffer'

import {
  conflict,
  DomainError,
  SANDBOX_SECRETS_DIR,
  type AgentEvent,
  type ExecChunk,
  type ExecHandle,
  type RemovableSandbox,
  type Sandbox,
  type SandboxInfo,
  type SnapshotMetadata,
  type TurnExecution,
  type TurnOutputBatch,
  type TurnPrepareInput,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
import type { SnapshotArchives } from '../sessions/sandbox-snapshot.ts'
import { openSnapshotParts } from '../sessions/snapshot-parts.ts'
import { SnapshotService } from '../sessions/snapshot.service.ts'
import { memoryStorage, memoryTransit, tarZst } from '../testing/snapshots.ts'
import { LocalTurnExecutor } from './local-turn-executor.ts'

const labels = {
  workspaceId: 'ws1',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 2,
  leaseEpoch: 1,
}
const fence = { siteId: labels.siteId, taskId: labels.taskId, operation: 'turn', epoch: 1 } as const
const image = `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`
const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
const baseSha = 'b'.repeat(40)
const credentials = ['synthetic-llm-secret', 'synthetic-mcp-secret']

const lines = (events: AgentEvent[]) =>
  Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(''))

function handle(id: string, chunks: ExecChunk[]): ExecHandle {
  return {
    id,
    output: vi.fn(async function* () {
      yield* chunks
    }),
    wait: vi.fn(async () => ({ code: 0, reason: 'exited' as const })),
    kill: vi.fn(async () => {}),
  }
}

async function fixture() {
  const order: string[] = []
  const memory = memoryStorage()
  const transit = memoryTransit()
  const snapshots = new SnapshotService(memory.storage, transit.secrets)
  const prior: SnapshotArchives = {
    home: await tarZst({ 'sessions/prior.jsonl': 'prior conversation' }),
    untracked: emptyUntrackedArchive(),
    patch: Buffer.from('prior patch'),
  }
  const priorMetadata: SnapshotMetadata = {
    workspaceId: labels.workspaceId,
    sessionId: labels.sessionId,
    turn: 1,
    image,
    driver: { id: 'codex', version: '1.0.0' },
    home,
    git: { provider: 'gitea', branch: `agent/${labels.taskId}`, baseSha, headSha: baseSha },
  }
  await snapshots.save(priorMetadata, prior)
  const captured: SnapshotArchives = {
    home: await tarZst({ 'sessions/turn.jsonl': 'this turn' }),
    untracked: emptyUntrackedArchive(),
    patch: Buffer.from('agent patch'),
  }
  const sandbox: Sandbox = {
    id: 'container2',
    labels,
    exec: vi.fn(async () => handle('exec1', [])),
    attach: vi.fn(async () => handle('exec1', [])),
    fs: {
      write: vi.fn(async (path: string) => {
        order.push(`write:${path}`)
      }),
      read: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
    },
    quiesce: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }
  const sandboxes = {
    kind: 'docker' as const,
    create: vi.fn(async () => {
      order.push('create')
      return sandbox
    }),
    get: vi.fn(async (): Promise<Sandbox | null> => sandbox),
    getForRemoval: vi.fn(async (): Promise<RemovableSandbox | null> => sandbox),
    list: vi.fn(async () => [] as SandboxInfo[]),
  }
  const transport = {
    capture: vi.fn(async () => captured),
    restore: vi.fn(async () => {
      order.push('restore')
    }),
  }
  const transfer = {
    get: vi.fn(memory.transfer.get),
    put: vi.fn(memory.transfer.put),
  }
  const importBundle = vi.fn(async () => {
    order.push('import')
  })
  const executor = new LocalTurnExecutor({
    sandboxes,
    parser: () => ({ parseEvent: (line) => [JSON.parse(line) as AgentEvent] }),
    transport,
    transfer,
    importBundle,
  })
  const source = await snapshots.restoreSource(
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
  const input = (): TurnPrepareInput => ({
    assignmentId: '00000000-0000-4000-8000-0000000000aa',
    fence,
    sandbox: {
      image,
      labels,
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: 600_000,
    },
    remainingMs: 500_000,
    bundle: {
      baseSha,
      branch: `agent/${labels.taskId}`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
      read: async function* () {},
    },
    restore: source,
    driverId: 'codex',
    prepared: {
      files: [
        { path: '/agent-home/codex/config.toml', content: 'synthetic = true' },
        { path: '/agent-home/codex/run.sh', content: 'exit 0', mode: 0o700 },
      ],
      env: { CODEX_HOME: '/agent-home/codex' },
      secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: credentials[0]! }],
    },
    argv: ['codex', 'exec', '--json'],
    credentials,
    created: vi.fn(async () => {
      order.push('created')
    }),
  })
  const signal = new AbortController().signal
  return {
    order,
    memory,
    transit,
    snapshots,
    prior,
    captured,
    sandbox,
    sandboxes,
    transport,
    transfer,
    importBundle,
    executor,
    input,
    signal,
  }
}

describe('LocalTurnExecutor', () => {
  it('reports the container before the import, restores turn n−1, then writes files and secrets', async () => {
    const f = await fixture()
    const input = f.input()
    const execution = await f.executor.prepare(input, f.signal)
    expect(f.order).toEqual([
      'create',
      'created',
      'import',
      'restore',
      'write:/agent-home/codex/config.toml',
      'write:/agent-home/codex/run.sh',
      `write:${SANDBOX_SECRETS_DIR}/llm`,
    ])
    expect(input.created).toHaveBeenCalledWith(execution)
    expect(execution.containerId).toBe('container2')
    // No secrets in the spec, and the container never outlives the turn.
    expect(f.sandboxes.create).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: [], hardTimeoutMs: 500_000 }),
      f.signal,
    )
    expect(f.importBundle).toHaveBeenCalledWith(f.sandbox, input.bundle)
    expect(f.transport.restore).toHaveBeenCalledWith(f.sandbox, home, {
      home: Buffer.from(f.prior.home),
      untracked: Buffer.from(f.prior.untracked),
      patch: Buffer.from(f.prior.patch),
    })
    expect(f.transfer.get).toHaveBeenCalledTimes(3)
    expect(
      vi.mocked(f.sandbox.fs.write).mock.calls.map(([path, , options]) => [path, options]),
    ).toEqual([
      ['/agent-home/codex/config.toml', { mode: 0o600 }],
      ['/agent-home/codex/run.sh', { mode: 0o700 }],
      [`${SANDBOX_SECRETS_DIR}/llm`, { mode: 0o600 }],
    ])
    expect(f.transit.allZeroed()).toBe(true)
  })

  it.each([
    [
      'a file outside the agent home',
      (input: TurnPrepareInput) => {
        input.prepared.files = [{ path: '/workspace/repo/AGENTS.md', content: 'x' }]
      },
      'DRIVER_PREPARE_INVALID',
    ],
    [
      'a credential in env',
      (input: TurnPrepareInput) => {
        input.prepared.env = { AGENT_FLAGS: `--key=${credentials[0]}` }
      },
      'DRIVER_PREPARE_INVALID',
    ],
    [
      'a credential in the command',
      (input: TurnPrepareInput) => {
        input.argv = ['codex', `--token=${credentials[1]}`]
      },
      'DRIVER_PREPARE_INVALID',
    ],
    [
      'secrets in the container spec',
      (input: TurnPrepareInput) => {
        input.sandbox.secrets = [{ path: `${SANDBOX_SECRETS_DIR}/llm`, value: 'x' }]
      },
      'BAD_REQUEST',
    ],
  ])('refuses %s before creating a container', async (_, change, code) => {
    const f = await fixture()
    const input = f.input()
    change(input)
    await expect(f.executor.prepare(input, f.signal)).rejects.toMatchObject({ code })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('refuses a part changed in storage before asking for the key or writing anything', async () => {
    const f = await fixture()
    const key = `sessions/${labels.sessionId}/turns/0001/untracked.tar.zst`
    const stored = f.memory.objects.get(key)!
    stored[0] = (stored[0] ?? 0) ^ 1
    await expect(f.executor.prepare(f.input(), f.signal)).rejects.toMatchObject({
      code: 'SNAPSHOT_LOAD_FAILED',
      httpStatus: 502,
    })
    expect(f.transit.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
    expect(f.transport.restore).not.toHaveBeenCalled()
    expect(f.sandbox.fs.write).not.toHaveBeenCalled()
  })

  it('stops before the import when the caller refuses the container, which it now owns', async () => {
    const f = await fixture()
    const input = f.input()
    input.created = vi.fn(async () => {
      throw new DomainError('TURN_INTERRUPTED', 'lease_lost', 409)
    })
    await expect(f.executor.prepare(input, f.signal)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    expect(f.importBundle).not.toHaveBeenCalled()
    // Removal is the caller's: it holds the execution from created().
    expect(f.sandbox.destroy).not.toHaveBeenCalled()
  })

  it('launches the prepared command and hands over output in batches that follow the cursor', async () => {
    const f = await fixture()
    const first = lines([{ type: 'started', nativeSessionId: 'native1' }])
    const second = lines([{ type: 'completed' }])
    vi.mocked(f.sandbox.exec).mockResolvedValue(
      handle('exec1', [
        { stream: 'stdout', offset: 0, data: first },
        { stream: 'stderr', offset: 0, data: Buffer.from('raw diagnostics') },
        { stream: 'stdout', offset: first.length, data: second },
      ]),
    )
    const execution = await f.executor.prepare(f.input(), f.signal)
    const agent = await execution.launch(300_000)
    expect(f.sandbox.exec).toHaveBeenCalledWith({
      argv: ['codex', 'exec', '--json'],
      cwd: '/workspace/repo',
      env: { CODEX_HOME: '/agent-home/codex' },
      timeoutMs: 300_000,
    })
    const batches: TurnOutputBatch[] = []
    await agent.output(async (batch) => {
      batches.push(structuredClone(batch))
    })
    expect(batches).toEqual([
      {
        from: { stdout: 0, stderr: 0 },
        to: { stdout: first.length, stderr: 0 },
        events: [{ type: 'started', nativeSessionId: 'native1' }],
      },
      {
        from: { stdout: first.length, stderr: 0 },
        to: { stdout: first.length + second.length, stderr: 15 },
        events: [{ type: 'completed' }],
      },
    ])
    await expect(agent.wait()).resolves.toEqual({ code: 0, reason: 'exited' })
  })

  it('refuses agent output with a turn credential before handing it over', async () => {
    const f = await fixture()
    vi.mocked(f.sandbox.exec).mockResolvedValue(
      handle('exec1', [
        {
          stream: 'stdout',
          offset: 0,
          data: lines([{ type: 'message', text: `key ${credentials[1]}` }]),
        },
      ]),
    )
    const execution = await f.executor.prepare(f.input(), f.signal)
    const agent = await execution.launch(300_000)
    const record = vi.fn(async () => {})
    await expect(agent.output(record)).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
    expect(record).not.toHaveBeenCalled()
  })

  it('re-attaches from the journal cursor and counts events across the reconnect', async () => {
    const f = await fixture()
    const line = lines([{ type: 'completed' }])
    vi.mocked(f.sandbox.attach).mockResolvedValue(
      handle('exec1', [{ stream: 'stdout', offset: 40, data: line }]),
    )
    const execution = await f.executor.prepare(f.input(), f.signal)
    const cursor = { stdout: 40, stderr: 3 }
    const agent = await execution.attach({ execId: 'exec1', cursor, eventCount: 9_999 })
    expect(f.sandbox.attach).toHaveBeenCalledWith('exec1', cursor)
    const batches: TurnOutputBatch[] = []
    await agent!.output(async (batch) => {
      batches.push(batch)
    })
    expect(batches).toEqual([
      {
        from: cursor,
        to: { stdout: 40 + line.length, stderr: 3 },
        events: [{ type: 'completed' }],
      },
    ])
    vi.mocked(f.sandbox.attach).mockResolvedValue(
      handle('exec1', [{ stream: 'stdout', offset: 40, data: Buffer.concat([line, line]) }]),
    )
    const again = await execution.attach({ execId: 'exec1', cursor, eventCount: 9_999 })
    await expect(again!.output(async () => {})).rejects.toMatchObject({
      code: 'TURN_OUTPUT_TOO_LARGE',
    })
  })

  it.each([
    ['missing', new DomainError('NOT_FOUND', 'No such exec', 404), null],
    ['foreign', new DomainError('BAD_REQUEST', 'Exec does not belong to this sandbox', 400), null],
  ])('reports a %s exec as lost', async (_, error, expected) => {
    const f = await fixture()
    vi.mocked(f.sandbox.attach).mockRejectedValue(error)
    const execution = await f.executor.prepare(f.input(), f.signal)
    await expect(
      execution.attach({ execId: 'exec1', cursor: { stdout: 0, stderr: 0 }, eventCount: 0 }),
    ).resolves.toBe(expected)
  })

  it('leaves a host failure while attaching to the caller', async () => {
    const f = await fixture()
    vi.mocked(f.sandbox.attach).mockRejectedValue(new Error('connect ENOENT docker.sock'))
    const execution = await f.executor.prepare(f.input(), f.signal)
    await expect(
      execution.attach({ execId: 'exec1', cursor: { stdout: 0, stderr: 0 }, eventCount: 0 }),
    ).rejects.toThrow('ENOENT')
  })

  it('keeps the captured home and seals it with the snapshot AAD through the create-only PUT', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input(), f.signal)
    await expect(execution.seal({} as never)).rejects.toMatchObject({ code: 'CONFLICT' })
    const captured = await execution.capture({ home, baseSha })
    expect(f.transport.capture).toHaveBeenCalledWith(f.sandbox, home, baseSha, credentials)
    expect(captured).toEqual({
      patch: f.captured.patch,
      untracked: f.captured.untracked,
      homeBytes: f.captured.home.byteLength,
    })
    expect(captured).not.toHaveProperty('home')
    const metadata: SnapshotMetadata = {
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 2,
      image,
      driver: { id: 'codex', version: '1.0.0' },
      home,
      git: {
        provider: 'gitea',
        branch: `agent/${labels.taskId}`,
        baseSha,
        headSha: 'c'.repeat(40),
      },
    }
    const sealed = await f.snapshots.seal(metadata, {
      home: { sizeBytes: captured.homeBytes },
      untracked: captured.untracked,
      patch: captured.patch,
    })
    await f.snapshots.reserve(sealed)
    const put = await f.snapshots.presignPart(sealed, 'home', 60_000)
    const part = await execution.seal({
      base: sealed.base,
      dataKey: () => f.snapshots.dataKey(sealed),
      put,
    })
    expect(f.transfer.put).toHaveBeenCalledOnce()
    const body = f.memory.objects.get(`sessions/${labels.sessionId}/turns/0002/home.tar.zst`)!
    expect(part.sizeBytes).toBe(captured.homeBytes)
    const opened = await openSnapshotParts(
      sealed.base,
      [
        {
          part: {
            name: 'home',
            key: `sessions/${labels.sessionId}/turns/0002/home.tar.zst`,
            ...part,
            encryption: {
              algorithm: 'aes-256-gcm',
              keyId: sealed.keyId,
              wrappedKey: sealed.wrappedKey,
              iv: part.iv,
              tag: part.tag,
            },
          },
          body,
        },
      ],
      home,
      () => f.snapshots.dataKey(sealed),
    )
    expect(Buffer.from(opened.home)).toEqual(Buffer.from(f.captured.home))
    // The same PUT cannot store it twice.
    await expect(
      execution.seal({ base: sealed.base, dataKey: () => f.snapshots.dataKey(sealed), put }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.transit.allZeroed()).toBe(true)
  })

  describe('adoption after a restart', () => {
    const adopt = (purpose: 'work' | 'removal', extra: object = {}) => ({
      assignmentId: '00000000-0000-4000-8000-0000000000aa',
      fence: { ...fence, epoch: 2 },
      containerId: 'container2',
      labels,
      ...(purpose === 'removal'
        ? { purpose }
        : { purpose, remainingMs: 60_000, driverId: 'codex' as const, credentials, ...extra }),
    })

    it('finds nothing to adopt when the container is gone', async () => {
      const f = await fixture()
      f.sandboxes.get.mockResolvedValue(null)
      f.sandboxes.getForRemoval.mockResolvedValue(null)
      await expect(f.executor.adopt(adopt('removal'), f.signal)).resolves.toBeNull()
      await expect(f.executor.adopt(adopt('work'), f.signal)).resolves.toBeNull()
    })

    it('reaches a container that can no longer run the agent only for removal', async () => {
      const f = await fixture()
      // Its gateway died: the provider no longer hands it out to work in.
      f.sandboxes.get.mockResolvedValue(null)
      const destroy = vi.fn(async () => {})
      f.sandboxes.getForRemoval.mockResolvedValue({ id: 'container2', labels, destroy })
      await expect(f.executor.adopt(adopt('work'), f.signal)).rejects.toMatchObject({
        code: 'EXEC_LOST',
      })
      const execution = (await f.executor.adopt(adopt('removal'), f.signal))!
      expect(execution.containerId).toBe('container2')
      await expect(
        execution.attach({ execId: 'exec1', cursor: { stdout: 0, stderr: 0 }, eventCount: 0 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await execution.destroy('failed')
      expect(destroy).toHaveBeenCalledWith('failed')
      expect(f.sandbox.destroy).not.toHaveBeenCalled()
    })

    it('refuses a container whose identity changed', async () => {
      const f = await fixture()
      const changed = { ...f.sandbox, labels: { ...labels, turn: 3 } }
      f.sandboxes.get.mockResolvedValue(changed)
      f.sandboxes.getForRemoval.mockResolvedValue(changed)
      for (const purpose of ['work', 'removal'] as const)
        await expect(f.executor.adopt(adopt(purpose), f.signal)).rejects.toMatchObject({
          code: 'CONFLICT',
        })
      f.sandboxes.getForRemoval.mockRejectedValue(conflict('Not a sandbox of this provider'))
      await expect(f.executor.adopt(adopt('removal'), f.signal)).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      expect(f.sandbox.destroy).not.toHaveBeenCalled()
    })

    it('refuses labels of another site or task than the fence', async () => {
      const f = await fixture()
      await expect(
        f.executor.adopt(
          { ...adopt('removal'), labels: { ...labels, taskId: 'other-task' } },
          f.signal,
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(f.sandboxes.get).not.toHaveBeenCalled()
      expect(f.sandboxes.getForRemoval).not.toHaveBeenCalled()
    })

    it('allows only removal of a container adopted for removal', async () => {
      const f = await fixture()
      const execution = (await f.executor.adopt(adopt('removal'), f.signal))!
      await expect(execution.quiesce()).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(execution.capture({ home, baseSha })).rejects.toMatchObject({ code: 'CONFLICT' })
      await execution.destroy('failed')
      expect(f.sandbox.destroy).toHaveBeenCalledWith('failed')
      expect(f.sandbox.quiesce).not.toHaveBeenCalled()
    })

    it('gives the turn up when it cannot filter the output without the credentials', async () => {
      const f = await fixture()
      await expect(
        f.executor.adopt(adopt('work', { credentials: undefined }), f.signal),
      ).rejects.toMatchObject({ code: 'EXEC_LOST' })
    })

    it('re-attaches an adopted turn but never launches its agent again', async () => {
      const f = await fixture()
      const execution: TurnExecution = (await f.executor.adopt(adopt('work'), f.signal))!
      await expect(execution.launch(60_000)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.sandbox.exec).not.toHaveBeenCalled()
      await execution.attach({ execId: 'exec1', cursor: { stdout: 0, stderr: 0 }, eventCount: 0 })
      await execution.quiesce()
      expect(f.sandbox.quiesce).toHaveBeenCalledOnce()
    })

    it('lists turn containers by labels', async () => {
      const f = await fixture()
      await f.executor.list({ taskId: labels.taskId, turn: 2 })
      expect(f.sandboxes.list).toHaveBeenCalledWith({ taskId: labels.taskId, turn: 2 })
    })
  })
})
