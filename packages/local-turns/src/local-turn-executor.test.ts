import { Buffer } from 'node:buffer'

import {
  snapshotPartFiles,
  turnSnapshotPrefix,
  workspaceTransitKey,
  type ExecHandle,
  type ExecSpec,
  type PresignedRequest,
  type Sandbox,
  type SandboxInfo,
  type SnapshotManifest,
  type TurnPrepareInput,
} from '@repo/domain'
import {
  openSnapshotParts,
  sealSnapshotPart,
  SandboxSnapshotTransport,
  type SnapshotSealBase,
} from '@repo/snapshots'
import { memoryStorage, tarZst } from '@repo/snapshots/testing'
import { describe, expect, it, vi } from 'vitest'

import { LocalTurnExecutor } from './local-turn-executor.ts'

// A turn without a repository (docs/plan/57-browser-tasks.md, Б4): the working directory is an
// empty directory, the snapshot is the home part alone, and no git command ever runs. The real
// snapshot transport works over a sandbox that only records what it is asked to run.
vi.mock('./working-tree-export.ts', () => ({
  exportSandboxWorkingTree: vi.fn(async () => ({ archive: new Uint8Array([1]), deletes: [] })),
}))

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 2,
  leaseEpoch: 1,
}
const fence = { siteId: labels.siteId, taskId: labels.taskId, operation: 'turn', epoch: 1 } as const
const image = `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`
const home = {
  root: '/agent-home/opencode',
  include: ['.local/share/opencode/opencode.db'],
  exclude: [],
}
const credentials = ['synthetic-llm-secret', 'synthetic-mcp-secret']
const ORIGIN = 'https://s3.invalid/raditi-sessions/'
const keyOf = () => new Uint8Array(32).fill(7)
const signal = new AbortController().signal

function handle(stdout?: Uint8Array, code = 0): ExecHandle {
  return {
    id: 'exec1',
    async *output() {
      if (stdout?.byteLength) yield { stream: 'stdout' as const, offset: 0, data: stdout }
    },
    wait: async () => ({ code, reason: 'exited' as const }),
    kill: vi.fn(async () => {}),
  }
}

/** The metadata of a snapshot of turn `turn` without a repository. */
const baseOf = (turn: number): SnapshotSealBase => ({
  schemaVersion: 1,
  workspaceId: labels.workspaceId,
  sessionId: labels.sessionId,
  turn,
  createdAt: '2026-10-22T10:00:00.000Z',
  image,
  driver: { id: 'opencode', version: '1.0.0' },
  home,
})

async function fixture(options: { workdir?: string } = {}) {
  const memory = memoryStorage()
  const priorHome = await tarZst({ [home.include[0]!]: 'prior conversation' })
  const thisHome = await tarZst({ [home.include[0]!]: 'this turn' })
  const calls: ExecSpec[] = []
  const writes: string[] = []
  const sandbox: Sandbox = {
    id: 'container2',
    labels,
    exec: vi.fn(async (spec: ExecSpec) => {
      if (spec.stdin) for await (const chunk of spec.stdin) void chunk
      calls.push(spec)
      // No link anywhere: `test -L` answers 1, as for a path that is none.
      if (spec.argv[0] === 'test' && spec.argv[1] === '-L') return handle(undefined, 1)
      if (spec.argv.includes('--create')) return handle(thisHome)
      if (spec.argv.includes('-mindepth') && options.workdir)
        return handle(Buffer.from(`${options.workdir}\n`))
      return handle()
    }),
    attach: vi.fn(),
    fs: {
      write: vi.fn(async (path: string) => {
        writes.push(path)
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
    create: vi.fn(async () => sandbox),
    get: vi.fn(async (): Promise<Sandbox | null> => sandbox),
    getForRemoval: vi.fn(async () => sandbox),
    list: vi.fn(async () => [] as SandboxInfo[]),
  }
  const transfer = { get: vi.fn(memory.transfer.get), put: vi.fn(memory.transfer.put) }
  const importBundle = vi.fn(async () => {})
  const executor = new LocalTurnExecutor({
    sandboxes,
    parser: () => ({ parseEvent: () => [] }),
    transport: new SandboxSnapshotTransport(),
    transfer,
    importBundle,
  })

  // Turn 1 of the session, sealed and stored as core stores it: its home part alone.
  const priorBase = baseOf(1)
  const priorKey = `${turnSnapshotPrefix(labels.sessionId, 1)}${snapshotPartFiles.home}`
  const sealed = sealSnapshotPart(priorBase, 'home', priorHome, keyOf())
  memory.objects.set(priorKey, sealed.body)
  const manifest: SnapshotManifest = {
    ...priorBase,
    parts: [
      {
        name: 'home',
        key: priorKey,
        sha256: sealed.sealed.sha256,
        sizeBytes: sealed.sealed.sizeBytes,
        encryption: {
          algorithm: 'aes-256-gcm',
          keyId: workspaceTransitKey(labels.workspaceId),
          wrappedKey: 'vault:v1:wrapped',
          iv: sealed.sealed.iv,
          tag: sealed.sealed.tag,
        },
      },
    ],
  }
  const presigned = (method: 'GET' | 'PUT', key: string): PresignedRequest => ({
    method,
    url: `${ORIGIN}${key}?X-Amz-Signature=synthetic`,
    headers: method === 'PUT' ? { 'if-none-match': '*' } : {},
    expiresAt: new Date(Date.now() + 60_000),
  })
  const restore = {
    manifest,
    parts: { home: presigned('GET', priorKey) },
    dataKey: vi.fn(async () => keyOf()),
  }
  const input = (overrides: Partial<TurnPrepareInput> = {}): TurnPrepareInput => ({
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
    driverId: 'opencode',
    prepared: {
      files: [{ path: '/agent-home/opencode/.config/opencode/opencode.json', content: '{}' }],
      env: { HOME: '/agent-home/opencode' },
      secrets: [],
    },
    argv: ['node', '/agent-home/opencode/run.mjs'],
    credentials,
    created: vi.fn(async () => {}),
    dispatched: vi.fn(),
    vacated: vi.fn(),
    ...overrides,
  })
  const bundle = {
    baseSha: 'b'.repeat(40),
    branch: `agent/${labels.taskId}`,
    sha256: '0'.repeat(64),
    sizeBytes: 1,
    read: async function* () {},
  }
  return {
    memory,
    priorHome,
    thisHome,
    calls,
    writes,
    sandbox,
    sandboxes,
    transfer,
    importBundle,
    executor,
    manifest,
    restore,
    input,
    bundle,
    presigned,
  }
}

const argvs = (calls: ExecSpec[]) => calls.map((spec) => spec.argv)
const ranGit = (calls: ExecSpec[]) => calls.some((spec) => spec.argv[0] === 'git')

describe('a turn without a repository on the local executor (plan 57, Б4)', () => {
  it('prepares an empty working directory: links refused first, no clone, no git command', async () => {
    const f = await fixture()
    await f.executor.prepare(f.input(), signal)
    expect(argvs(f.calls)).toEqual([
      ['test', '!', '-L', '/workspace'],
      ['test', '!', '-L', '/workspace/repo'],
      ['mkdir', '-p', '--', '/workspace/repo'],
      ['find', '-P', '/workspace/repo', '-mindepth', '1', '-print', '-quit'],
    ])
    expect(f.importBundle).not.toHaveBeenCalled()
    expect(ranGit(f.calls)).toBe(false)
    // The driver's files still come after the working directory.
    expect(f.writes).toEqual(['/agent-home/opencode/.config/opencode/opencode.json'])
  })

  it('refuses a working directory that is not empty', async () => {
    const f = await fixture({ workdir: '/workspace/repo/left-over' })
    await expect(f.executor.prepare(f.input(), signal)).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
    })
    expect(f.writes).toEqual([])
  })

  it('restores the home part alone of the previous turn, without git', async () => {
    const f = await fixture()
    await f.executor.prepare(f.input({ restore: f.restore }), signal)
    expect(f.transfer.get).toHaveBeenCalledTimes(1)
    expect(f.transfer.get.mock.calls[0]![0].url).toContain('/turns/0001/home.tar.zst')
    const extracts = f.calls.filter((spec) => spec.argv.includes('--extract'))
    expect(extracts.map((spec) => spec.argv.find((arg) => arg.startsWith('--directory=')))).toEqual(
      ['--directory=/agent-home/opencode'],
    )
    expect(ranGit(f.calls)).toBe(false)
    expect(f.restore.dataKey).toHaveBeenCalledTimes(1)
  })

  it('refuses a restore of the other kind before any container exists', async () => {
    const f = await fixture()
    const withGit = {
      ...f.restore,
      manifest: {
        ...f.manifest,
        git: {
          provider: 'gitea' as const,
          branch: `agent/${labels.taskId}`,
          baseSha: 'b'.repeat(40),
          headSha: 'c'.repeat(40),
        },
      },
    }
    for (const input of [
      f.input({ restore: withGit }),
      f.input({ bundle: f.bundle, restore: f.restore }),
    ]) {
      await expect(f.executor.prepare(input, signal)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(input.dispatched).not.toHaveBeenCalled()
    }
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('captures the home part alone and seals it under a base without git', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input(), signal)
    const before = f.calls.length
    const captured = await execution.capture({ home })
    expect(captured).toEqual({ homeBytes: f.thisHome.byteLength })
    const capture = f.calls.slice(before)
    expect(ranGit(capture)).toBe(false)
    expect(capture.some((spec) => spec.argv.some((arg) => arg.includes('/workspace')))).toBe(false)

    const base = baseOf(2)
    const key = `${turnSnapshotPrefix(labels.sessionId, 2)}${snapshotPartFiles.home}`
    const sealed = await execution.seal({
      base,
      dataKey: async () => keyOf(),
      put: f.presigned('PUT', key),
    })
    // AES-GCM adds no padding.
    expect(sealed.sizeBytes).toBe(f.thisHome.byteLength)
    const part = {
      name: 'home' as const,
      key,
      sha256: sealed.sha256,
      sizeBytes: sealed.sizeBytes,
      encryption: {
        algorithm: 'aes-256-gcm' as const,
        keyId: workspaceTransitKey(labels.workspaceId),
        wrappedKey: 'vault:v1:wrapped',
        iv: sealed.iv,
        tag: sealed.tag,
      },
    }
    const opened = await openSnapshotParts(
      base,
      [{ part, body: f.memory.objects.get(key)! }],
      home,
      async () => keyOf(),
    )
    expect(Buffer.from(opened.home).equals(Buffer.from(f.thisHome))).toBe(true)
  })

  it('refuses a capture with a base, a working set without one, and a seal of the other kind', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input(), signal)
    const before = f.calls.length
    await expect(execution.capture({ home, baseSha: 'b'.repeat(40) })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    for (const extra of [{ sandboxBaseSha: 'd'.repeat(40) }, { addOnlyPaths: [] }])
      await expect(execution.capture({ home, ...extra })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    expect(f.calls.length).toBe(before)

    await execution.capture({ home })
    const withGit = {
      ...baseOf(2),
      git: {
        provider: 'gitea' as const,
        branch: `agent/${labels.taskId}`,
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
      },
    }
    const key = `${turnSnapshotPrefix(labels.sessionId, 2)}${snapshotPartFiles.home}`
    await expect(
      execution.seal({ base: withGit, dataKey: async () => keyOf(), put: f.presigned('PUT', key) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.transfer.put).not.toHaveBeenCalled()
  })

  it('refuses a capture without a base after a bundle was imported', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input({ bundle: f.bundle }), signal)
    expect(f.importBundle).toHaveBeenCalledTimes(1)
    const before = f.calls.length
    await expect(execution.capture({ home })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.calls.length).toBe(before)
  })

  it('exports no working tree of it, until its container is removed', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input(), signal)
    const request = {
      assignmentId: '00000000-0000-4000-8000-0000000000aa',
      containerId: f.sandbox.id,
      labels,
      baseSha: 'b'.repeat(40),
    }
    await expect(f.executor.exportWorkingTree(request, signal)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await execution.destroy('completed')
    // A later container with the same id is another turn's; the record went with the removal.
    await expect(f.executor.exportWorkingTree(request, signal)).resolves.toEqual({
      archive: new Uint8Array([1]),
      deletes: [],
    })

    // The same once recovery removes the container instead.
    await f.executor.prepare(f.input(), signal)
    await expect(f.executor.exportWorkingTree(request, signal)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const removal = await f.executor.adopt(
      {
        assignmentId: request.assignmentId,
        fence,
        containerId: f.sandbox.id,
        labels,
        purpose: 'removal',
      },
      signal,
    )
    await removal!.destroy('failed')
    await expect(f.executor.exportWorkingTree(request, signal)).resolves.toMatchObject({
      deletes: [],
    })
  })
})

describe('files of the client on the local executor', () => {
  const pathOf = (name: string) =>
    `/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/${name}`
  const file = (path: string, bytes: Uint8Array, sizeBytes = bytes.byteLength) => ({
    path,
    sizeBytes,
    read: async function* () {
      yield bytes.subarray(0, 2)
      yield bytes.subarray(2)
    },
  })

  it('writes each file at its path, read-only, after the bundle and before the driver files', async () => {
    const f = await fixture()
    const menu = Buffer.from('%PDF-1.7 synthetic menu')
    await f.executor.prepare(
      f.input({ bundle: f.bundle, inbox: [file(pathOf('Меню.pdf'), menu)] }),
      signal,
    )
    expect(f.importBundle).toHaveBeenCalledOnce()
    expect(f.writes).toEqual([
      pathOf('Меню.pdf'),
      '/agent-home/opencode/.config/opencode/opencode.json',
    ])
    const [, data, options] = vi.mocked(f.sandbox.fs.write).mock.calls[0]!
    expect(Buffer.from(data).toString()).toBe(menu.toString())
    expect(options).toEqual({ mode: 0o444 })
  })

  it('refuses files for a turn without a repository before any container', async () => {
    const f = await fixture()
    await expect(
      f.executor.prepare(f.input({ inbox: [file(pathOf('a.pdf'), Buffer.from('abc'))] }), signal),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it.each([
    ['shorter', 4],
    ['longer', 2],
  ])('writes no file whose body is %s than announced', async (_label, sizeBytes) => {
    const f = await fixture()
    await expect(
      f.executor.prepare(
        f.input({ bundle: f.bundle, inbox: [file(pathOf('a.pdf'), Buffer.from('abc'), sizeBytes)] }),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(f.writes).toEqual([])
  })
})
