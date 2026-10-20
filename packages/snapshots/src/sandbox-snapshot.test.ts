import { Buffer } from 'node:buffer'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  snapshotLimits,
  type ExecChunk,
  type ExecExit,
  type ExecHandle,
  type ExecSpec,
  type Sandbox,
  type SessionState,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { describe, expect, it, vi } from 'vitest'

const sampleDriverId = 'opencode' as const
import { SandboxSnapshotTransport, type SnapshotArchives } from './sandbox-snapshot.ts'

const baseSha = 'a'.repeat(40)
const state: SessionState = {
  root: `/agent-home/${sampleDriverId}`,
  include: ['sessions', 'optional'],
  exclude: ['sessions/private'],
}

async function archive(name?: string, body = ''): Promise<Uint8Array> {
  const writer = pack()
  const result = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of writer) chunks.push(Buffer.from(chunk as Uint8Array))
    return zstdCompressSync(Buffer.concat(chunks))
  })()
  if (name !== undefined) writer.entry({ name, mode: 0o600 }, body)
  writer.finalize()
  return result
}

async function fixture(): Promise<SnapshotArchives> {
  return {
    home: await archive('sessions/run.jsonl', '{"turn":1}\n'),
    untracked: await archive('new.txt', 'new file'),
    patch: Buffer.from('diff --git a/old.txt b/old.txt\n'),
  }
}

interface Reply {
  stdout?: Uint8Array
  stderr?: Uint8Array
  chunks?: ExecChunk[]
  code?: number | null
  reason?: ExecExit['reason']
  outputError?: boolean
  waitForever?: boolean
}

function handle(reply: Reply): ExecHandle {
  return {
    id: 'exec-1',
    async *output() {
      if (reply.outputError) throw new Error('must never expose raw stdout or credentials')
      if (reply.chunks) {
        yield* reply.chunks
      } else {
        if (reply.stdout?.byteLength) yield { stream: 'stdout', offset: 0, data: reply.stdout }
        if (reply.stderr?.byteLength) yield { stream: 'stderr', offset: 0, data: reply.stderr }
      }
    },
    wait: reply.waitForever
      ? () => new Promise(() => {})
      : async () => ({
          code: reply.code === undefined ? 0 : reply.code,
          reason: reply.reason ?? 'exited',
        }),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

function sandboxFixture(parts: SnapshotArchives, override?: (spec: ExecSpec) => Reply | undefined) {
  const handles: ExecHandle[] = []
  const calls: Array<{ spec: ExecSpec; stdin: Buffer }> = []
  const exec = vi.fn(async (spec: ExecSpec) => {
    const chunks: Buffer[] = []
    if (spec.stdin) for await (const chunk of spec.stdin) chunks.push(Buffer.from(chunk))
    calls.push({ spec, stdin: Buffer.concat(chunks) })
    let reply: Reply = {}
    if (spec.argv[0] === 'test') {
      reply = { code: spec.argv[1] === '-L' || spec.argv[2]?.endsWith('/optional') ? 1 : 0 }
    } else if (spec.argv.includes('--create')) {
      reply = {
        stdout: spec.argv.includes('--directory=/workspace/repo') ? parts.untracked : parts.home,
      }
    } else if (spec.argv.includes('ls-files')) {
      reply = { stdout: Buffer.from('new.txt\0') }
    } else if (spec.argv.includes('diff')) {
      reply = { stdout: parts.patch }
    }
    const result = handle(override?.(spec) ?? reply)
    handles.push(result)
    return result
  })
  return { sandbox: { exec } as unknown as Sandbox, exec, calls, handles }
}

describe('SandboxSnapshotTransport', () => {
  it('captures through argv and NUL lists, skips absent includes and validates native archives', async () => {
    const parts = await fixture()
    const fake = sandboxFixture(parts)
    const result = await new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha)
    expect(result).toEqual(parts)
    const tarCalls = fake.calls.filter(({ spec }) => spec.argv.includes('--create'))
    expect(tarCalls).toHaveLength(2)
    expect(tarCalls[0]!.stdin.toString()).toBe('sessions\0')
    expect(tarCalls[1]!.stdin.toString()).toBe('new.txt\0')
    expect(tarCalls[0]!.spec.argv).toEqual(
      expect.arrayContaining([
        '--zstd',
        '--format=ustar',
        '--null',
        '--verbatim-files-from',
        '--no-wildcards',
        '--anchored',
        '--exclude=sessions/private',
      ]),
    )
    expect(tarCalls[1]!.spec.argv).toContain('--no-recursion')
    const diff = fake.calls.find(({ spec }) => spec.argv.includes('diff'))!
    expect(diff.spec.cwd).toBe('/workspace/repo')
    expect(diff.spec.argv).toEqual(
      expect.arrayContaining([
        '--no-replace-objects',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        baseSha,
      ]),
    )
    expect(fake.calls.every(({ spec }) => spec.argv[0] !== 'sh' && spec.argv[0] !== 'bash')).toBe(
      true,
    )
  })

  it('takes new media below add-only paths that an ignore file hides (plan 53, Р12)', async () => {
    const parts = await fixture()
    const media = 'wp-content/uploads/raditi/hero.png'
    const fake = sandboxFixture(parts, (spec) =>
      spec.argv.includes('ls-files') && !spec.argv.includes('--exclude-standard')
        ? { stdout: Buffer.from(`new.txt\0${media}\0`) }
        : undefined,
    )
    await new SandboxSnapshotTransport().capture(
      fake.sandbox,
      state,
      baseSha,
      [],
      ['wp-content/uploads/raditi/'],
    )
    const lists = fake.calls.filter(({ spec }) => spec.argv.includes('ls-files'))
    expect(lists.map(({ spec }) => spec.argv)).toEqual([
      ['git', '-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'],
      [
        'git',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        'ls-files',
        '--others',
        '-z',
        '--',
        'wp-content/uploads/raditi/',
      ],
    ])
    const untracked = fake.calls.filter(({ spec }) => spec.argv.includes('--create'))[1]!
    // Each name once, the ignored media after what the site's ignore files let through.
    expect(untracked.stdin.toString()).toBe(`new.txt\0${media}\0`)
  })

  it('lists untracked files once without add-only paths, and refuses add-only paths it cannot read', async () => {
    const parts = await fixture()
    const fake = sandboxFixture(parts)
    await new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha)
    expect(fake.calls.filter(({ spec }) => spec.argv.includes('ls-files'))).toHaveLength(1)
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha, [], ['../x/']),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses a capture whose home or new files hold a turn credential, before returning it', async () => {
    const key = 'synthetic-mcp-token-0123456789'
    const clean = await fixture()
    for (const parts of [
      { ...clean, home: await archive('sessions/run.jsonl', `{"token":"${key}"}\n`) },
      { ...clean, untracked: await archive('new.txt', `token=${key}`) },
    ]) {
      const fake = sandboxFixture(parts)
      await expect(
        new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha, [key]),
      ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    }
    const fake = sandboxFixture(clean)
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha, [key]),
    ).resolves.toEqual(clean)
  })

  it("refuses a home that still holds a value of the client's variables, in any spelling (Р13)", async () => {
    const value = 'pay-se"cret-0001'
    const clean = await fixture()
    // As a JSON row of the session holds it: escaped once.
    const home = await archive('sessions/run.jsonl', JSON.stringify({ output: value }))
    await expect(
      new SandboxSnapshotTransport().capture(
        sandboxFixture({ ...clean, home }).sandbox,
        state,
        baseSha,
        [],
        [],
        [value],
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    await expect(
      new SandboxSnapshotTransport().capture(
        sandboxFixture(clean).sandbox,
        state,
        baseSha,
        [],
        [],
        [value],
      ),
    ).resolves.toEqual(clean)
  })

  it.each([
    [
      'a symlink in agent home',
      'home',
      { name: 'sessions/link', type: 'symlink', linkname: '/etc' },
    ],
    ['a FIFO in agent home', 'home', { name: 'sessions/pipe', type: 'fifo' }],
    [
      'a symlink in the working copy',
      'untracked',
      { name: 'new.txt', type: 'symlink', linkname: '/' },
    ],
    ['a FIFO in the working copy', 'untracked', { name: 'pipe', type: 'fifo' }],
    ['a setuid file in the working copy', 'untracked', { name: 'run.sh', mode: 0o4755 }],
  ] as const)(
    'refuses %s as rejected agent output, not the client input',
    async (_, part, header) => {
      const writer = pack()
      const packed = (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of writer) chunks.push(Buffer.from(chunk as Uint8Array))
        return zstdCompressSync(Buffer.concat(chunks))
      })()
      writer.entry({ mode: 0o644, ...header }, '')
      writer.finalize()
      const fake = sandboxFixture({ ...(await fixture()), [part]: await packed })
      await expect(
        new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha),
      ).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 })
    },
  )

  it('collapses overlapping home include subtrees instead of producing duplicate tar entries', async () => {
    const fake = sandboxFixture(await fixture())
    await new SandboxSnapshotTransport().capture(
      fake.sandbox,
      {
        ...state,
        include: ['sessions', 'sessions/run.jsonl'],
      },
      baseSha,
    )
    expect(fake.calls.find(({ spec }) => spec.argv.includes('--create'))!.stdin.toString()).toBe(
      'sessions\0',
    )
  })

  it.each([
    '--checkpoint-action=exec=touch\0',
    '../outside\0',
    '.git/config\0',
    'same\0same\0',
    'unterminated',
  ])('refuses unsafe or ambiguous untracked file lists: %s', async (list) => {
    const fake = sandboxFixture(await fixture(), (spec) =>
      spec.argv.includes('ls-files') ? { stdout: Buffer.from(list) } : undefined,
    )
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha),
    ).rejects.toThrow(/command/)
    expect(fake.calls.filter(({ spec }) => spec.argv.includes('--create'))).toHaveLength(1)
  })

  it('requires contiguous offsets independently for stdout and stderr', async () => {
    const parts = await fixture()
    const fake = sandboxFixture(parts, (spec) =>
      spec.argv.includes('diff')
        ? {
            chunks: [
              { stream: 'stdout', offset: 0, data: parts.patch.subarray(0, 5) },
              { stream: 'stderr', offset: 0, data: Buffer.from('warning') },
              { stream: 'stdout', offset: 5, data: parts.patch.subarray(5) },
            ],
          }
        : undefined,
    )
    expect(
      (await new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha)).patch,
    ).toEqual(parts.patch)
    for (const offset of [1, -1, Number.NaN]) {
      const wrong = sandboxFixture(parts, (spec) =>
        spec.argv.includes('diff')
          ? {
              chunks: [{ stream: 'stdout', offset, data: parts.patch }],
            }
          : undefined,
      )
      await expect(
        new SandboxSnapshotTransport().capture(wrong.sandbox, state, baseSha),
      ).rejects.toThrow(/command/)
      expect(wrong.handles.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL')
    }
  })

  it.each([
    { code: 1 },
    { code: null },
    { reason: 'lost' },
    { reason: 'oom' },
    { reason: 'timeout' },
    { reason: 'cancelled' },
    { outputError: true },
  ] satisfies Reply[])('rejects failed execs and stops their process: %j', async (reply) => {
    const fake = sandboxFixture(await fixture(), (spec) =>
      spec.argv.includes('diff') ? reply : undefined,
    )
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha),
    ).rejects.toThrow('Snapshot sandbox command failed or exceeded its limits')
    expect(fake.handles.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('bounds stdout and stderr without including either in errors', async () => {
    for (const [reply, error] of [
      [{ stdout: Buffer.alloc(snapshotLimits.patchBytes + 1) }, { code: 'PUBLICATION_TOO_LARGE' }],
      [
        { stderr: Buffer.alloc(64 * 1024 + 1) },
        { code: 'SANDBOX_COMMAND_FAILED', httpStatus: 502 },
      ],
    ] as const) {
      const fake = sandboxFixture(await fixture(), (spec) =>
        spec.argv.includes('diff') ? reply : undefined,
      )
      const capture = new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha)
      await expect(capture).rejects.toMatchObject(error)
      expect(fake.handles.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL')
    }
  })

  it.each([
    [
      'session archive',
      (spec: ExecSpec) =>
        spec.argv.includes('--create') && !spec.argv.includes('--directory=/workspace/repo'),
      snapshotLimits.archiveBytes,
      'SNAPSHOT_TOO_LARGE',
    ],
    [
      'untracked archive',
      (spec: ExecSpec) =>
        spec.argv.includes('--directory=/workspace/repo') && spec.argv.includes('--create'),
      snapshotLimits.archiveBytes,
      'PUBLICATION_TOO_LARGE',
    ],
    [
      'untracked list',
      (spec: ExecSpec) => spec.argv.includes('ls-files'),
      snapshotLimits.entries * (snapshotLimits.path + 1),
      'PUBLICATION_TOO_LARGE',
    ],
  ] as const)('reports an oversized %s as a size limit (413)', async (_, match, limit, code) => {
    const fake = sandboxFixture(await fixture(), (spec) =>
      match(spec) ? { stdout: Buffer.alloc(limit + 1) } : undefined,
    )
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha),
    ).rejects.toMatchObject({ code, httpStatus: 413 })
  })

  it('reports more untracked files than a snapshot holds as a size limit (413)', async () => {
    const names = Array.from({ length: snapshotLimits.entries + 1 }, (_, i) => `f${i}\0`).join('')
    const fake = sandboxFixture(await fixture(), (spec) =>
      spec.argv.includes('ls-files') ? { stdout: Buffer.from(names) } : undefined,
    )
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, state, baseSha),
    ).rejects.toMatchObject({ code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 })
  })

  it('times out even when output ends but wait() never settles', async () => {
    const fake = sandboxFixture(await fixture(), (spec) =>
      spec.argv.includes('diff') ? { waitForever: true } : undefined,
    )
    await expect(
      new SandboxSnapshotTransport({ timeoutMs: 25 }).capture(fake.sandbox, state, baseSha),
    ).rejects.toThrow(/command/)
    expect(fake.handles.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL')
    expect(fake.calls.at(-1)!.spec.signal?.aborted).toBe(true)
  })

  it('kills an exec that is only returned after its startup timed out', async () => {
    let release: ((exec: ExecHandle) => void) | undefined
    const sandbox = {
      exec: () =>
        new Promise<ExecHandle>((resolve) => {
          release = resolve
        }),
    } as unknown as Sandbox
    await expect(
      new SandboxSnapshotTransport({ timeoutMs: 10 }).capture(sandbox, state, baseSha),
    ).rejects.toThrow(/command/)
    const late = handle({})
    release!(late)
    await Promise.resolve()
    expect(late.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('validates both archives before any exec, including when the second archive is unsafe', async () => {
    const parts = { ...(await fixture()), untracked: await archive('../escape', 'payload') }
    const fake = sandboxFixture(parts)
    await expect(
      new SandboxSnapshotTransport().restore(fake.sandbox, state, parts),
    ).rejects.toThrow(/archive/)
    expect(fake.exec).not.toHaveBeenCalled()
  })

  it.each([
    ['mode', 100, 8],
    ['uid', 108, 8],
    ['gid', 116, 8],
    ['size', 124, 12],
    ['mtime', 136, 12],
    ['checksum', 148, 8],
    ['devmajor', 329, 8],
    ['devminor', 337, 8],
  ] as const)(
    'refuses malformed %s metadata before any sandbox exec',
    async (_, offset, length) => {
      for (const corruption of ['suffix', 'high-bit']) {
        const parts = await fixture()
        const raw = zstdDecompressSync(parts.untracked)
        if (offset !== 148) {
          if (corruption === 'suffix') {
            const value = Number.parseInt(raw.toString('latin1', offset, offset + length), 8)
            raw.write(value.toString(8).padStart(length - 1, '0') + 'x', offset, 'latin1')
          } else raw[offset] = raw[offset]! | 0x80
        }
        raw.fill(32, 148, 156)
        const sum = raw.subarray(0, 512).reduce((total, byte) => total + byte, 0)
        raw.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
        if (offset === 148) {
          if (corruption === 'suffix') {
            raw.write(sum.toString(8).padStart(length - 1, '0') + 'x', offset, 'latin1')
          } else raw[offset] = raw[offset]! | 0x80
        }
        parts.untracked = zstdCompressSync(raw)
        const fake = sandboxFixture(parts)
        await expect(
          new SandboxSnapshotTransport().restore(fake.sandbox, state, parts),
        ).rejects.toThrow(/archive/)
        expect(fake.exec).not.toHaveBeenCalled()
      }
    },
  )

  it('restores only home and untracked, without executing or applying patch.diff', async () => {
    const parts = { ...(await fixture()), patch: Buffer.from('malicious shell command') }
    const originalUntracked = Buffer.from(parts.untracked)
    const fake = sandboxFixture(parts, () => {
      // Mutation after the checks cannot change the already-owned restore input.
      parts.untracked.fill(0)
      return undefined
    })
    await new SandboxSnapshotTransport().restore(fake.sandbox, state, parts)
    const writes = fake.calls.filter(({ spec }) => spec.argv.includes('--extract'))
    expect(
      writes.map(({ spec }) => spec.argv.find((arg) => arg.startsWith('--directory='))),
    ).toEqual([`--directory=/agent-home/${sampleDriverId}`, '--directory=/workspace/repo'])
    expect(writes[0]!.stdin).toEqual(Buffer.from(parts.home))
    expect(writes[1]!.stdin).toEqual(originalUntracked)
    expect(
      writes.every(
        ({ spec }) =>
          spec.argv.includes('--keep-old-files') &&
          spec.argv.includes('--no-same-owner') &&
          spec.argv.includes('--no-same-permissions') &&
          !spec.argv.includes('--no-overwrite-dir'),
      ),
    ).toBe(true)
    expect(fake.calls.some(({ spec }) => spec.argv[0] === 'git' || spec.argv[0] === 'sh')).toBe(
      false,
    )
    expect(fake.calls.some(({ stdin }) => stdin.equals(parts.patch))).toBe(false)
  })

  it('refuses pre-existing symlink roots or descendants before mkdir or extraction', async () => {
    const parts = await fixture()
    for (const override of [
      (spec: ExecSpec): Reply | undefined =>
        spec.argv[0] === 'test' && spec.argv[1] === '-L' ? { code: 0 } : undefined,
      (spec: ExecSpec): Reply | undefined =>
        spec.argv[0] === 'find' ? { stdout: Buffer.from('/workspace/repo/link\n') } : undefined,
    ]) {
      const fake = sandboxFixture(parts, override)
      await expect(
        new SandboxSnapshotTransport().restore(fake.sandbox, state, parts),
      ).rejects.toThrow(/command/)
      expect(
        fake.calls.some(({ spec }) => spec.argv[0] === 'mkdir' || spec.argv.includes('--extract')),
      ).toBe(false)
    }
  })

  it('refuses a session root outside /agent-home before contacting the sandbox', async () => {
    const fake = sandboxFixture(await fixture())
    await expect(
      new SandboxSnapshotTransport().capture(
        fake.sandbox,
        { ...state, root: '/run/secrets' },
        baseSha,
      ),
    ).rejects.toThrow(/session state/)
    expect(fake.exec).not.toHaveBeenCalled()
  })

  it('refuses a symlink ancestor of a literal capture path before tar can traverse it', async () => {
    const fake = sandboxFixture(await fixture(), (spec) =>
      spec.argv[0] === 'test' &&
      spec.argv[1] === '-L' &&
      spec.argv[2] === `/agent-home/${sampleDriverId}/sessions`
        ? { code: 0 }
        : undefined,
    )
    await expect(
      new SandboxSnapshotTransport().capture(
        fake.sandbox,
        {
          ...state,
          include: ['sessions/run.jsonl'],
        },
        baseSha,
      ),
    ).rejects.toThrow(/command/)
    expect(fake.calls.some(({ spec }) => spec.argv.includes('--create'))).toBe(false)
  })
})
