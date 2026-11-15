import { Buffer } from 'node:buffer'

import {
  snapshotPartFiles,
  outboxLimits,
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
  packOutbox,
  readOutboxArchive,
  sealSnapshotPart,
  SandboxSnapshotTransport,
  type SnapshotSealBase,
} from '@repo/snapshots'
import { memoryStorage, tarZst } from '@repo/snapshots/testing'
import { describe, expect, it, vi } from 'vitest'

import { LocalTurnExecutor } from './local-turn-executor.ts'

// A turn has no repository (docs/plan/83-remove-projects.md): the working directory is an empty
// directory, the snapshot is the home part alone, and no git command ever runs. The real snapshot
// transport works over a sandbox that only records what it is asked to run.

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

async function fixture(
  options: { workdir?: string; outbox?: { listing: string; archive: Uint8Array } } = {},
) {
  const memory = memoryStorage()
  const priorHome = await tarZst({ [home.include[0]!]: 'prior conversation' })
  const thisHome = await tarZst({ [home.include[0]!]: 'this turn' })
  const calls: ExecSpec[] = []
  const writes: string[] = []
  const sandbox: Sandbox = {
    id: 'container2',
    labels,
    deadline: Date.now() + 20 * 60_000,
    extend: vi.fn(async (deadline: number) => {
      ;(sandbox as { deadline: number }).deadline = Math.max(sandbox.deadline, deadline)
    }),
    exec: vi.fn(async (spec: ExecSpec) => {
      if (spec.stdin) for await (const chunk of spec.stdin) void chunk
      calls.push(spec)
      // No link anywhere: `test -L` answers 1, as for a path that is none.
      if (spec.argv[0] === 'test' && spec.argv[1] === '-L') return handle(undefined, 1)
      if (spec.argv[0] === 'mktemp') return handle(Buffer.from('/workspace/.outbox.Ab3dE5gH\n'))
      if (spec.argv.includes('--directory=/workspace/.outbox.Ab3dE5gH'))
        return handle(options.outbox?.archive)
      if (spec.argv.includes('-printf')) return handle(Buffer.from(options.outbox?.listing ?? ''))
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
  const log = vi.fn()
  const executor = new LocalTurnExecutor({
    sandboxes,
    parser: () => ({ parseEvent: () => [] }),
    transport: new SandboxSnapshotTransport(),
    transfer,
    log,
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
  return {
    memory,
    priorHome,
    thisHome,
    calls,
    writes,
    sandbox,
    sandboxes,
    transfer,
    log,
    executor,
    manifest,
    restore,
    input,
    presigned,
  }
}

const argvs = (calls: ExecSpec[]) => calls.map((spec) => spec.argv)
const ranGit = (calls: ExecSpec[]) => calls.some((spec) => spec.argv[0] === 'git')

describe('a turn on the local executor: no repository (plan 57, Б4; plan 83)', () => {
  it('prepares an empty working directory: links refused first, no clone, no git command', async () => {
    const f = await fixture()
    await f.executor.prepare(f.input(), signal)
    expect(argvs(f.calls)).toEqual([
      ['test', '!', '-L', '/workspace'],
      ['test', '!', '-L', '/workspace/repo'],
      ['mkdir', '-p', '--', '/workspace/repo'],
      ['find', '-P', '/workspace/repo', '-mindepth', '1', '-print', '-quit'],
    ])
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

  it('restores the home part alone of a snapshot of a chat that had a project', async () => {
    const f = await fixture()
    const git = {
      provider: 'gitea' as const,
      branch: `agent/${labels.taskId}`,
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    }
    // Sealed as such a turn sealed it: its AAD binds the `git` of the manifest.
    const priorBase = { ...baseOf(1), git }
    const prefix = turnSnapshotPrefix(labels.sessionId, 1)
    const homeKey = `${prefix}${snapshotPartFiles.home}`
    const sealed = sealSnapshotPart(priorBase, 'home', f.priorHome, keyOf())
    f.memory.objects.set(homeKey, sealed.body)
    const encryption = {
      algorithm: 'aes-256-gcm' as const,
      keyId: workspaceTransitKey(labels.workspaceId),
      wrappedKey: 'vault:v1:wrapped',
      iv: sealed.sealed.iv,
      tag: sealed.sealed.tag,
    }
    const manifest: SnapshotManifest = {
      ...priorBase,
      parts: (['home', 'untracked', 'patch'] as const).map((name) => ({
        name,
        key: `${prefix}${snapshotPartFiles[name]}`,
        sha256: name === 'home' ? sealed.sealed.sha256 : '0'.repeat(64),
        sizeBytes: name === 'home' ? sealed.sealed.sizeBytes : 1,
        encryption,
      })),
    }
    await f.executor.prepare(
      f.input({
        restore: { ...f.restore, manifest, parts: { home: f.presigned('GET', homeKey) } },
      }),
      signal,
    )
    // Only the home part is fetched; the working copy of the old turn stays in S3.
    expect(f.transfer.get).toHaveBeenCalledTimes(1)
    expect(f.transfer.get.mock.calls[0]![0].url).toContain('/turns/0001/home.tar.zst')
    const extracts = f.calls.filter((spec) => spec.argv.includes('--extract'))
    expect(extracts.map((spec) => spec.argv.find((arg) => arg.startsWith('--directory=')))).toEqual(
      ['--directory=/agent-home/opencode'],
    )
    expect(ranGit(f.calls)).toBe(false)
  })

  it('captures the home part alone and seals it under a base without git', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input(), signal)
    const before = f.calls.length
    const captured = await execution.capture({ home })
    expect(captured).toEqual({ homeBytes: f.thisHome.byteLength })
    const capture = f.calls.slice(before)
    expect(ranGit(capture)).toBe(false)
    // Nothing of the working directory: only the folder of the agent's files, found empty.
    expect(capture.some((spec) => spec.argv.some((arg) => arg.includes('/workspace/repo')))).toBe(
      false,
    )
    expect(capture.some((spec) => spec.argv.includes('--directory=/workspace/out'))).toBe(false)

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

  it('refuses to seal a base with git', async () => {
    const f = await fixture()
    const execution = await f.executor.prepare(f.input(), signal)
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
})

describe('files of the client on the local executor', () => {
  const pathOf = (name: string) => `/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/${name}`
  const file = (path: string, bytes: Uint8Array, sizeBytes = bytes.byteLength) => ({
    path,
    sizeBytes,
    read: async function* () {
      yield bytes.subarray(0, 2)
      yield bytes.subarray(2)
    },
  })

  /** The turn of a chat: its lease is its own id (К14). */
  const inChat = (input: TurnPrepareInput): TurnPrepareInput => ({
    ...input,
    fence: { ...input.fence, siteId: labels.taskId },
    sandbox: { ...input.sandbox, labels: { ...labels, siteId: labels.taskId } },
  })

  it('writes each file at its path, read-only, before the driver files', async () => {
    const f = await fixture()
    const menu = Buffer.from('%PDF-1.7 synthetic menu')
    await f.executor.prepare(inChat(f.input({ inbox: [file(pathOf('Меню.pdf'), menu)] })), signal)
    expect(f.writes).toEqual([
      pathOf('Меню.pdf'),
      '/agent-home/opencode/.config/opencode/opencode.json',
    ])
    const [, data, options] = vi.mocked(f.sandbox.fs.write).mock.calls[0]!
    expect(Buffer.from(data).toString()).toBe(menu.toString())
    expect(options).toEqual({ mode: 0o444 })
  })

  it('refuses files for a turn under another lease before any container', async () => {
    const f = await fixture()
    await expect(
      f.executor.prepare(f.input({ inbox: [file(pathOf('a.pdf'), Buffer.from('abc'))] }), signal),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('writes the files of a chat into its empty sandbox (К16)', async () => {
    const f = await fixture()
    await f.executor.prepare(
      inChat(f.input({ inbox: [file(pathOf('Смета.pdf'), Buffer.from('%PDF chat'))] })),
      signal,
    )
    expect(f.writes[0]).toBe(pathOf('Смета.pdf'))
    expect(vi.mocked(f.sandbox.fs.write).mock.calls[0]![2]).toEqual({ mode: 0o444 })
  })

  it.each([
    ['shorter', 4],
    ['longer', 2],
  ])('writes no file whose body is %s than announced', async (_label, sizeBytes) => {
    const f = await fixture()
    await expect(
      f.executor.prepare(
        inChat(f.input({ inbox: [file(pathOf('a.pdf'), Buffer.from('abc'), sizeBytes)] })),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(f.writes).toEqual([])
  })
})

describe('files of the project on the local executor (docs/plan/84-projects.md, ПР8)', () => {
  const inboxPath = '/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/Смета.pdf'
  const file = (path: string, bytes: Uint8Array, sizeBytes = bytes.byteLength) => ({
    path,
    sizeBytes,
    read: async function* () {
      yield bytes
    },
  })
  const inChat = (input: TurnPrepareInput): TurnPrepareInput => ({
    ...input,
    fence: { ...input.fence, siteId: labels.taskId },
    sandbox: { ...input.sandbox, labels: { ...labels, siteId: labels.taskId } },
  })

  it('writes them read-only under /workspace/project after the files of the chat, before the driver', async () => {
    const f = await fixture()
    await f.executor.prepare(
      inChat(
        f.input({
          inbox: [file(inboxPath, Buffer.from('%PDF chat'))],
          projectFiles: [
            file('/workspace/project/Фото/витрина.jpg', Buffer.from([0xff, 0xd8, 0xff])),
            file('/workspace/project/Прайс.csv', Buffer.from('a;b')),
          ],
        }),
      ),
      signal,
    )
    expect(f.writes).toEqual([
      inboxPath,
      '/workspace/project/Фото/витрина.jpg',
      '/workspace/project/Прайс.csv',
      '/agent-home/opencode/.config/opencode/opencode.json',
    ])
    for (const call of vi.mocked(f.sandbox.fs.write).mock.calls.slice(0, 3))
      expect(call[2]).toEqual({ mode: 0o444 })
  })

  it('refuses them for a turn under another lease, and a path out of the project, before any container', async () => {
    const f = await fixture()
    await expect(
      f.executor.prepare(
        f.input({ projectFiles: [file('/workspace/project/a.pdf', Buffer.from('abc'))] }),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      f.executor.prepare(
        inChat(f.input({ projectFiles: [file('/workspace/project/../a.pdf', Buffer.from('a'))] })),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.sandboxes.create).not.toHaveBeenCalled()
  })

  it('writes no file of the project whose body is not of its size', async () => {
    const f = await fixture()
    await expect(
      f.executor.prepare(
        inChat(
          f.input({ projectFiles: [file('/workspace/project/a.pdf', Buffer.from('abc'), 5)] }),
        ),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(f.writes).toEqual([])
  })
})

describe('files of the agent for the client on the local executor (docs/plan/66, В8)', () => {
  it('hands the outbox over with the capture, never sealed with the home part', async () => {
    const archive = await packOutbox([{ name: 'estimate.txt', bytes: 'total 100' }])
    const f = await fixture({ outbox: { listing: 'f 9 estimate.txt\0', archive } })
    const execution = await f.executor.prepare(f.input(), signal)
    const captured = await execution.capture({ home })
    expect(captured).toEqual({ homeBytes: f.thisHome.byteLength, outbox: archive })
    expect(f.log).not.toHaveBeenCalled()
  })

  it('drops an outbox that holds a turn credential, and the turn goes on', async () => {
    const archive = await packOutbox([{ name: 'a.txt', bytes: `key ${credentials[0]}` }])
    const f = await fixture({ outbox: { listing: 'f 30 a.txt\0', archive } })
    const execution = await f.executor.prepare(f.input(), signal)
    const captured = await execution.capture({ home })
    // The files are gone, the notice that they were is not: the client is told (В8).
    expect(captured).toEqual({ homeBytes: f.thisHome.byteLength, outbox: expect.any(Uint8Array) })
    expect(await readOutboxArchive(captured.outbox!)).toEqual({
      entries: [],
      skipped: 0,
      refused: true,
    })
    expect(f.log).toHaveBeenCalledWith(
      'turn_outbox_dropped container=container2 reason=SNAPSHOT_NOT_WRITTEN',
    )
  })

  it('drops more files than the limit, and says how many entries it left', async () => {
    const tooMany = Array.from(
      { length: outboxLimits.files + 1 },
      (_, i) => `f 1 f${i}.txt\0`,
    ).join('')
    const f = await fixture({ outbox: { listing: tooMany, archive: new Uint8Array() } })
    const execution = await f.executor.prepare(f.input(), signal)
    const captured = await execution.capture({ home })
    expect(await readOutboxArchive(captured.outbox!)).toMatchObject({ refused: true })
    expect(f.log).toHaveBeenCalledWith(
      'turn_outbox_dropped container=container2 reason=PUBLICATION_TOO_LARGE',
    )
    const skipping = await fixture({
      outbox: { listing: 'd 4096 nested\0', archive: new Uint8Array() },
    })
    const other = await skipping.executor.prepare(skipping.input(), signal)
    const left = await other.capture({ home })
    expect(await readOutboxArchive(left.outbox!)).toEqual({
      entries: [],
      skipped: 1,
      refused: false,
    })
    expect(skipping.log).toHaveBeenCalledWith('turn_outbox_skipped container=container2 entries=1')
  })
})
