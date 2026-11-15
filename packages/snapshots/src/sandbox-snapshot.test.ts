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
import { SandboxSnapshotTransport } from './sandbox-snapshot.ts'

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

interface Parts {
  home: Uint8Array
}

async function fixture(): Promise<Parts> {
  return { home: await archive('sessions/run.jsonl', '{"turn":1}\n') }
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

function sandboxFixture(parts: Parts, override?: (spec: ExecSpec) => Reply | undefined) {
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
      reply = { stdout: parts.home }
    }
    const result = handle(override?.(spec) ?? reply)
    handles.push(result)
    return result
  })
  return { sandbox: { exec } as unknown as Sandbox, exec, calls, handles }
}

const isHomeTar = (spec: ExecSpec) => spec.argv.includes('--create')
const touchesWorkdir = (spec: ExecSpec) =>
  spec.cwd === '/workspace/repo' || spec.argv.some((arg) => arg.includes('/workspace'))

async function packed(header: Record<string, unknown>): Promise<Uint8Array> {
  const writer = pack()
  const result = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of writer) chunks.push(Buffer.from(chunk as Uint8Array))
    return zstdCompressSync(Buffer.concat(chunks))
  })()
  writer.entry({ mode: 0o644, ...header } as never, '')
  writer.finalize()
  return result
}

describe('SandboxSnapshotTransport', () => {
  it('captures the home archive alone, through argv and NUL lists, without any git command', async () => {
    const parts = await fixture()
    const fake = sandboxFixture(parts)
    const result = await new SandboxSnapshotTransport().capture(fake.sandbox, state)
    expect(result).toEqual(parts)
    expect(Object.keys(result)).toEqual(['home'])
    const tarCalls = fake.calls.filter(({ spec }) => isHomeTar(spec))
    expect(tarCalls).toHaveLength(1)
    expect(tarCalls[0]!.stdin.toString()).toBe('sessions\0')
    expect(tarCalls[0]!.spec.argv).toEqual(
      expect.arrayContaining([
        `--directory=/agent-home/${sampleDriverId}`,
        '--zstd',
        '--format=ustar',
        '--null',
        '--verbatim-files-from',
        '--no-wildcards',
        '--anchored',
        '--exclude=sessions/private',
      ]),
    )
    expect(fake.calls.some(({ spec }) => spec.argv[0] === 'git')).toBe(false)
    expect(fake.calls.some(({ spec }) => touchesWorkdir(spec))).toBe(false)
    expect(fake.calls.every(({ spec }) => spec.argv[0] !== 'sh' && spec.argv[0] !== 'bash')).toBe(
      true,
    )
  })

  it("refuses a home with a turn credential or a value of the client's variables (Р13)", async () => {
    const key = 'synthetic-mcp-token-0123456789'
    const value = 'pay-se"cret-0001'
    const clean = await fixture()
    for (const [home, credentials, envValues] of [
      [await archive('sessions/run.jsonl', `{"token":"${key}"}\n`), [key], []],
      // As a JSON row of the session holds it: escaped once.
      [await archive('sessions/run.jsonl', JSON.stringify({ output: value })), [], [value]],
    ] as const) {
      await expect(
        new SandboxSnapshotTransport().capture(
          sandboxFixture({ home }).sandbox,
          state,
          credentials,
          envValues,
        ),
      ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    }
    await expect(
      new SandboxSnapshotTransport().capture(sandboxFixture(clean).sandbox, state, [key], [value]),
    ).resolves.toEqual(clean)
  })

  it.each([
    ['a symlink in agent home', { name: 'sessions/link', type: 'symlink', linkname: '/etc' }],
    ['a FIFO in agent home', { name: 'sessions/pipe', type: 'fifo' }],
    ['a setuid file in agent home', { name: 'sessions/run.sh', mode: 0o4755 }],
  ] as const)('refuses %s as rejected agent output, not the client input', async (_, header) => {
    const fake = sandboxFixture({ home: await packed(header) })
    await expect(new SandboxSnapshotTransport().capture(fake.sandbox, state)).rejects.toMatchObject(
      { code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 },
    )
  })

  it('collapses overlapping home include subtrees instead of producing duplicate tar entries', async () => {
    const fake = sandboxFixture(await fixture())
    await new SandboxSnapshotTransport().capture(fake.sandbox, {
      ...state,
      include: ['sessions', 'sessions/run.jsonl'],
    })
    expect(fake.calls.find(({ spec }) => isHomeTar(spec))!.stdin.toString()).toBe('sessions\0')
  })

  it('requires contiguous offsets independently for stdout and stderr', async () => {
    const parts = await fixture()
    const home = Buffer.from(parts.home)
    const fake = sandboxFixture(parts, (spec) =>
      isHomeTar(spec)
        ? {
            chunks: [
              { stream: 'stdout', offset: 0, data: home.subarray(0, 5) },
              { stream: 'stderr', offset: 0, data: Buffer.from('warning') },
              { stream: 'stdout', offset: 5, data: home.subarray(5) },
            ],
          }
        : undefined,
    )
    expect((await new SandboxSnapshotTransport().capture(fake.sandbox, state)).home).toEqual(home)
    for (const offset of [1, -1, Number.NaN]) {
      const wrong = sandboxFixture(parts, (spec) =>
        isHomeTar(spec) ? { chunks: [{ stream: 'stdout', offset, data: home }] } : undefined,
      )
      await expect(new SandboxSnapshotTransport().capture(wrong.sandbox, state)).rejects.toThrow(
        /command/,
      )
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
    const fake = sandboxFixture(await fixture(), (spec) => (isHomeTar(spec) ? reply : undefined))
    await expect(new SandboxSnapshotTransport().capture(fake.sandbox, state)).rejects.toThrow(
      'Snapshot sandbox command failed or exceeded its limits',
    )
    expect(fake.handles.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('bounds stdout and stderr without including either in errors', async () => {
    for (const [reply, error] of [
      [
        { stdout: Buffer.alloc(snapshotLimits.archiveBytes + 1) },
        { code: 'SNAPSHOT_TOO_LARGE', httpStatus: 413 },
      ],
      [
        { stderr: Buffer.alloc(64 * 1024 + 1) },
        { code: 'SANDBOX_COMMAND_FAILED', httpStatus: 502 },
      ],
    ] as const) {
      const fake = sandboxFixture(await fixture(), (spec) => (isHomeTar(spec) ? reply : undefined))
      await expect(
        new SandboxSnapshotTransport().capture(fake.sandbox, state),
      ).rejects.toMatchObject(error)
      expect(fake.handles.at(-1)!.kill).toHaveBeenCalledWith('SIGKILL')
    }
  })

  it('times out even when output ends but wait() never settles', async () => {
    const fake = sandboxFixture(await fixture(), (spec) =>
      isHomeTar(spec) ? { waitForever: true } : undefined,
    )
    await expect(
      new SandboxSnapshotTransport({ timeoutMs: 25 }).capture(fake.sandbox, state),
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
      new SandboxSnapshotTransport({ timeoutMs: 10 }).capture(sandbox, state),
    ).rejects.toThrow(/command/)
    const late = handle({})
    release!(late)
    await Promise.resolve()
    expect(late.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('validates the home archive before any exec of a restore', async () => {
    const parts = { home: await archive('../escape', 'payload') }
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
        const raw = zstdDecompressSync(parts.home)
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
        parts.home = zstdCompressSync(raw)
        const fake = sandboxFixture(parts)
        await expect(
          new SandboxSnapshotTransport().restore(fake.sandbox, state, parts),
        ).rejects.toThrow(/archive/)
        expect(fake.exec).not.toHaveBeenCalled()
      }
    },
  )

  it('restores the session alone into an empty working directory it only makes', async () => {
    const parts = await fixture()
    const original = Buffer.from(parts.home)
    const fake = sandboxFixture(parts, () => {
      // Mutation after the checks cannot change the already-owned restore input.
      parts.home.fill(0)
      return undefined
    })
    await new SandboxSnapshotTransport().restore(fake.sandbox, state, parts)
    const writes = fake.calls.filter(({ spec }) => spec.argv.includes('--extract'))
    expect(
      writes.map(({ spec }) => spec.argv.find((arg) => arg.startsWith('--directory='))),
    ).toEqual([`--directory=/agent-home/${sampleDriverId}`])
    expect(writes[0]!.stdin).toEqual(original)
    expect(
      writes.every(
        ({ spec }) =>
          spec.argv.includes('--keep-old-files') &&
          spec.argv.includes('--no-same-owner') &&
          spec.argv.includes('--no-same-permissions'),
      ),
    ).toBe(true)
    const argvs = fake.calls.map(({ spec }) => spec.argv)
    expect(argvs).toContainEqual(['mkdir', '--parents', '--', '/workspace/repo'])
    // The working directory is checked before anything is extracted.
    const extract = fake.calls.findIndex(({ spec }) => spec.argv.includes('--extract'))
    const empty = fake.calls.findIndex(({ spec }) => spec.argv.includes('-mindepth'))
    expect(empty).toBeGreaterThanOrEqual(0)
    expect(empty).toBeLessThan(extract)
    expect(fake.calls.some(({ spec }) => spec.argv[0] === 'git' || spec.argv[0] === 'sh')).toBe(
      false,
    )
  })

  it('refuses symlink roots and a working directory that is not empty, before extracting', async () => {
    const parts = await fixture()
    for (const override of [
      (spec: ExecSpec): Reply | undefined =>
        spec.argv[0] === 'test' && spec.argv[1] === '-L' ? { code: 0 } : undefined,
      (spec: ExecSpec): Reply | undefined =>
        spec.argv[0] === 'find' && spec.argv.includes('-type')
          ? { stdout: Buffer.from('/workspace/repo/link\n') }
          : undefined,
      (spec: ExecSpec): Reply | undefined =>
        spec.argv.includes('-mindepth')
          ? { stdout: Buffer.from('/workspace/repo/x\n') }
          : undefined,
    ]) {
      const fake = sandboxFixture(parts, override)
      await expect(
        new SandboxSnapshotTransport().restore(fake.sandbox, state, parts),
      ).rejects.toThrow(/command/)
      expect(fake.calls.some(({ spec }) => spec.argv.includes('--extract'))).toBe(false)
    }
  })

  it('refuses a session root outside /agent-home before contacting the sandbox', async () => {
    const fake = sandboxFixture(await fixture())
    await expect(
      new SandboxSnapshotTransport().capture(fake.sandbox, { ...state, root: '/run/secrets' }),
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
      new SandboxSnapshotTransport().capture(fake.sandbox, {
        ...state,
        include: ['sessions/run.jsonl'],
      }),
    ).rejects.toThrow(/command/)
    expect(fake.calls.some(({ spec }) => isHomeTar(spec))).toBe(false)
  })
})
