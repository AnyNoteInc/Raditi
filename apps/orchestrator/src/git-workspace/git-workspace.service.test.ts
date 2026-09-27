import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  DomainError,
  type GitProvider,
  type PublicationMetadata,
  type Sandbox,
  type TurnPublication,
  publicationLimits,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from './archive.ts'
import { assertBinaryPatchLimits } from './binary-limits.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { PROCESS_OUTPUT_LIMIT, runProcess } from './process.ts'

// Real processes everywhere; a test may still answer one command itself.
vi.mock('./process.ts', async (importOriginal) => {
  const actual = await importOriginal<{ runProcess: typeof runProcess }>()
  return { ...actual, runProcess: vi.fn(actual.runProcess) }
})
const realRunProcess = vi.mocked(runProcess).getMockImplementation()!

const execute = promisify(execFile)
const roots: string[] = []
const candidates: TurnPublication[] = []
const git = async (cwd: string, ...args: string[]) =>
  (
    await execute('git', args, {
      cwd,
      encoding: 'buffer',
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    })
  ).stdout

afterEach(async () => {
  vi.mocked(runProcess).mockImplementation(realRunProcess)
  await Promise.all(candidates.splice(0).map((candidate) => candidate.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function archive(
  files: {
    name: string
    content?: string | Buffer
    mode?: number
    type?: 'file' | 'symlink'
    linkname?: string
  }[],
) {
  const stream = pack()
  for (const file of files)
    stream.entry(
      {
        name: file.name,
        mode: file.mode ?? 0o644,
        type: file.type ?? 'file',
        linkname: file.linkname,
      },
      file.content ?? '',
    )
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raditi-publication-test-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  await writeFile(join(work, 'index.php'), 'hello\n')
  await writeFile(join(work, 'delete.txt'), 'delete me\n')
  await writeFile(join(work, 'wp-config.php'), 'protected content\n')
  await writeFile(join(work, 'binary.dat'), Buffer.from([0, 1, 2, 3, 0, 4]))
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'fixture')
  const baseSha = (await git(work, 'rev-parse', 'HEAD')).toString().trim()
  await git(work, 'push', remote, 'HEAD:refs/heads/main')
  // The test executable models success, leak detection, and scanner failure; no real secret.
  const scanner = join(root, 'scanner.mjs')
  const scannerLog = join(root, 'scanner.log')
  await writeFile(
    scanner,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nlet data='';for await(const chunk of process.stdin)data+=chunk;\nappendFileSync(${JSON.stringify(scannerLog)},JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.exit(data.includes('synthetic-secret-marker')?1:data.includes('scanner-error-marker')?2:0);\n`,
    { mode: 0o700 },
  )
  const repo = { provider: 'gitea' as const, owner: 'fixture', name: 'site' }
  const provider = {
    kind: 'gitea',
    getRepository: vi.fn(async () => ({
      ref: repo,
      cloneUrl: remote,
      defaultBranch: 'main',
      private: true,
    })),
    issueCredentials: vi.fn(async () => {
      throw new Error('Local tests must not request real credentials')
    }),
  } as unknown as GitProvider
  const service = new GitWorkspaceService(provider, {
    transport: { kind: 'local-test', root },
    gitleaksBinary: scanner,
  })
  const metadata: PublicationMetadata = {
    repo,
    branch: 'agent/task1',
    expectedBaseSha: baseSha,
    taskId: 'task1',
    turn: 1,
    createdAt: '2026-09-26T19:00:00.000Z',
    protectedPaths: ['wp-config.php'],
  }
  const patch = () => git(work, 'diff', '--binary', '--full-index', 'HEAD', '--')
  const prepare = async (
    diff = Buffer.alloc(0),
    untracked: Uint8Array = emptyUntrackedArchive(),
    overrides: Partial<PublicationMetadata> = {},
  ) => {
    const candidate = await service.preparePublication({
      ...metadata,
      ...overrides,
      patch: diff,
      untracked,
    })
    candidates.push(candidate)
    return candidate
  }
  return {
    root,
    remote,
    work,
    scanner,
    scannerLog,
    repo,
    provider,
    service,
    metadata,
    baseSha,
    patch,
    prepare,
  }
}

describe('trusted Git publication', () => {
  it('stages text, binary, deletion and new blobs; snapshots a deterministic candidate before fenced CAS push', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'index.php'), 'updated\n')
    const binary = Buffer.from([0, 8, 9, 255, 0, 7, 0])
    await writeFile(join(f.work, 'binary.dat'), binary)
    await rm(join(f.work, 'delete.txt'))
    const patch = await f.patch()
    expect(patch.toString()).toContain('GIT binary patch')
    const candidate = await f.prepare(
      patch,
      await archive([{ name: 'new dir/new.txt', content: 'new file\n' }]),
    )
    expect(candidate.baseSha).toBe(f.baseSha)
    expect(candidate.patch.toString()).not.toBe('')
    expect(Buffer.from(candidate.patch).toString()).toContain('new dir/new.txt')
    expect(zstdDecompressSync(candidate.untracked)).toEqual(Buffer.alloc(1024))
    expect((await git(f.remote, 'show-ref', '--heads')).toString()).not.toContain('agent/task1')
    const fence = vi.fn(async () => {})
    await candidate.publish(fence)
    expect(fence).toHaveBeenCalledOnce()
    expect((await git(f.remote, 'rev-parse', 'refs/heads/agent/task1')).toString().trim()).toBe(
      candidate.headSha,
    )
    expect((await git(f.remote, 'show', `${candidate.headSha}:index.php`)).toString()).toBe(
      'updated\n',
    )
    expect(await git(f.remote, 'show', `${candidate.headSha}:binary.dat`)).toEqual(binary)
    expect((await git(f.remote, 'show', `${candidate.headSha}:new dir/new.txt`)).toString()).toBe(
      'new file\n',
    )
    expect((await git(f.remote, 'ls-tree', '-r', candidate.headSha)).toString()).not.toContain(
      'delete.txt',
    )
    expect(
      (await git(f.remote, 'show', '-s', '--format=%B', candidate.headSha)).toString(),
    ).toContain('Raditi-Turn: 1')
    const retry = await f.prepare(Buffer.from(candidate.patch), candidate.untracked)
    expect(retry.headSha).toBe(candidate.headSha)
    await retry.publish(fence)
    expect(fence).toHaveBeenCalledTimes(2)
    expect(f.provider.issueCredentials).not.toHaveBeenCalled()
    const scanArgs = (await readFile(f.scannerLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    expect(
      scanArgs.every(
        (args) =>
          args.includes('--ignore-gitleaks-allow') &&
          args.includes('--redact=100') &&
          args[args.indexOf('--config') + 1]?.startsWith('/'),
      ),
    ).toBe(true)
  })

  it('accepts a real compact Git binary delta and reproduces it on retry', async () => {
    const f = await fixture()
    const before = Buffer.alloc(100_000)
    for (let i = 0; i < before.length; i++) before[i] = i % 251
    await writeFile(join(f.work, 'binary.dat'), before)
    await git(f.work, 'add', '.')
    await git(f.work, 'commit', '-m', 'larger binary')
    await git(f.work, 'push', f.remote, 'HEAD:main')
    const base = (await git(f.work, 'rev-parse', 'HEAD')).toString().trim()
    before[1024] = 0
    await writeFile(join(f.work, 'binary.dat'), before)
    const patch = await f.patch()
    expect(patch.toString()).toContain('delta ')
    const candidate = await f.prepare(patch, undefined, { expectedBaseSha: base })
    await candidate.publish(async () => {})
    expect(await git(f.remote, 'show', `${candidate.headSha}:binary.dat`)).toEqual(before)
  })

  it('rejects a binary postimage pointing at an oversized historical blob before native apply', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'old-large.dat'), Buffer.alloc(publicationLimits.fileBytes + 1))
    await git(f.work, 'add', 'old-large.dat')
    await git(f.work, 'commit', '-m', 'large historical fixture')
    const huge = (await git(f.work, 'rev-parse', 'HEAD:old-large.dat')).toString().trim()
    await git(f.work, 'rm', 'old-large.dat')
    await git(f.work, 'commit', '-m', 'remove large file')
    await git(f.work, 'push', f.remote, 'HEAD:main')
    const base = (await git(f.work, 'rev-parse', 'HEAD')).toString().trim()
    const old = (await git(f.work, 'rev-parse', 'HEAD:binary.dat')).toString().trim()
    const patch = Buffer.from(
      `diff --git a/binary.dat b/binary.dat\nindex ${old}..${huge} 100644\nBinary files a/binary.dat and b/binary.dat differ\n`,
    )
    await expect(f.prepare(patch, undefined, { expectedBaseSha: base })).rejects.toMatchObject({
      code: 'PUBLICATION_TOO_LARGE',
      httpStatus: 413,
      message: expect.stringContaining('historical blob exceeds'),
    })
  })

  /** A base commit of `count` copies of one blob, named by `name`. */
  async function manyFiles(
    f: Awaited<ReturnType<typeof fixture>>,
    count: number,
    name: (i: number) => string,
  ) {
    const blob = (await git(f.work, 'hash-object', '-w', 'index.php')).toString().trim()
    const rows = Array.from({ length: count }, (_, i) => `100644 blob ${blob}\t${name(i)}\n`).join(
      '',
    )
    const tree = execFileSync('git', ['mktree'], {
      cwd: f.work,
      input: rows,
      maxBuffer: 1024 * 1024,
    })
      .toString()
      .trim()
    const base = (await git(f.work, 'commit-tree', tree, '-m', 'many files')).toString().trim()
    await git(f.work, 'push', f.remote, `${base}:refs/heads/main`, '--force')
    return base
  }

  it('reports a repository over the file count limit as the repository being too large', async () => {
    const f = await fixture()
    const base = await manyFiles(f, publicationLimits.repositoryFiles + 1, (i) => `file-${i}.txt`)
    await expect(
      f.prepare(Buffer.alloc(0), undefined, { expectedBaseSha: base }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_TOO_LARGE', httpStatus: 413 })
    await expect(readFile(f.scannerLog, 'utf8')).rejects.toThrow()
  }, 30_000)

  it('publishes into a site with more files than one turn may change and a file list over 16 MiB', async () => {
    const f = await fixture()
    // Long names: the listings exceed the default 16 MiB command output.
    const count = publicationLimits.files + 7_000
    const name = (i: number) => `${'long-name-'.repeat(95)}${String(i).padStart(6, '0')}.txt`
    // `100644 blob <oid>\t<name>\0` per file.
    expect(count * (54 + name(0).length)).toBeGreaterThan(16 * 1024 * 1024)
    const base = await manyFiles(f, count, name)
    const candidate = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'new.txt', content: 'new' }]),
      { expectedBaseSha: base },
    )
    expect(candidate.baseSha).toBe(base)
  }, 30_000)

  it.each([
    ['ls-tree', 'REPOSITORY_TOO_LARGE', publicationLimits.repositoryFiles],
    [
      'ls-files',
      'PUBLICATION_TOO_LARGE',
      publicationLimits.repositoryFiles + publicationLimits.files,
    ],
  ] as const)(
    'bounds the %s listing by its file limit and reports a longer one as too large',
    async (command, code, files) => {
      const f = await fixture()
      const limits: (number | undefined)[] = []
      vi.mocked(runProcess).mockImplementation(async (binary, argv, options) => {
        if (!argv.includes(command)) return realRunProcess(binary, argv, options)
        limits.push(options.maxBytes)
        throw new DomainError(
          PROCESS_OUTPUT_LIMIT,
          'Trusted command output exceeded its limit',
          502,
        )
      })
      await expect(f.prepare()).rejects.toMatchObject({ code, httpStatus: 413 })
      expect(limits).toEqual([files * (64 + publicationLimits.pathBytes)])
    },
  )

  it('counts patched and new files together against the limit of one turn', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'index.php'), 'updated\n')
    const files = Array.from({ length: publicationLimits.files }, (_, i) => ({
      name: `new/${i}.txt`,
      content: 'x',
    }))
    await expect(f.prepare(await f.patch(), await archive(files))).rejects.toMatchObject({
      code: 'PUBLICATION_TOO_LARGE',
      message: 'Publication changes too many files',
    })
    await expect(readFile(f.scannerLog, 'utf8')).rejects.toThrow()
  })

  it('rejects a complete patch over its limit as too large, before scanning or committing', async () => {
    const f = await fixture()
    const large = 'x'.repeat(3 * 1024 * 1024) + '\n'
    const files = [1, 2, 3].map((n) => ({ name: `large-${n}.txt`, content: large }))
    await expect(f.prepare(Buffer.alloc(0), await archive(files))).rejects.toMatchObject({
      code: 'PUBLICATION_TOO_LARGE',
      httpStatus: 413,
    })
    await expect(readFile(f.scannerLog, 'utf8')).rejects.toThrow()
    expect((await git(f.remote, 'show-ref', '--heads')).toString()).not.toContain('agent/task1')
  })

  it('rejects an oversized captured patch as too large before cloning', async () => {
    const f = await fixture()
    await expect(f.prepare(Buffer.alloc(publicationLimits.patchBytes + 1))).rejects.toMatchObject({
      code: 'PUBLICATION_TOO_LARGE',
      httpStatus: 413,
    })
    expect(f.provider.getRepository).not.toHaveBeenCalled()
  })

  it('requires protected paths explicitly for checkout and publication', async () => {
    const f = await fixture()
    const { taskId: _task, turn: _turn, createdAt: _date, ...source } = f.metadata
    const { protectedPaths: _paths, ...withoutPaths } = source
    await expect(
      f.service.prepareWorkspace({} as Sandbox, withoutPaths as typeof source),
    ).rejects.toThrow('Invalid repository source')
    await expect(
      f.service.preparePublication({
        ...(withoutPaths as typeof source),
        taskId: 'task1',
        turn: 1,
        createdAt: f.metadata.createdAt,
        patch: Buffer.alloc(0),
        untracked: emptyUntrackedArchive(),
      }),
    ).rejects.toThrow('Invalid publication metadata')
    expect(f.provider.getRepository).not.toHaveBeenCalled()
  })

  it('rejects repeated patch paths before allocating repeated postimages', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'index.php'), 'updated\n')
    const patch = await f.patch()
    await expect(f.prepare(Buffer.concat([patch, patch]))).rejects.toThrow('repeated paths')
  })

  it('checks fencing immediately before push and never changes a branch after lost ownership', async () => {
    const f = await fixture()
    const candidate = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'new.txt', content: 'new' }]),
    )
    await expect(
      candidate.publish(async () => {
        throw new Error('lease lost')
      }),
    ).rejects.toThrow('lease lost')
    expect((await git(f.remote, 'show-ref', '--heads')).toString()).not.toContain('agent/task1')
    await candidate.publish(async () => {})
    expect((await git(f.remote, 'rev-parse', 'agent/task1')).toString().trim()).toBe(
      candidate.headSha,
    )
  })

  it('uses compare-and-swap even if the branch changes inside the final fence callback', async () => {
    const f = await fixture()
    const candidate = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'new.txt', content: 'new' }]),
    )
    await expect(
      candidate.publish(async () => {
        await git(f.remote, 'update-ref', 'refs/heads/agent/task1', f.baseSha)
      }),
    ).rejects.toThrow('Trusted repository operation failed')
    expect((await git(f.remote, 'rev-parse', 'agent/task1')).toString().trim()).toBe(f.baseSha)
  })

  it('refuses a different remote commit or an absent branch after turn one', async () => {
    const f = await fixture()
    const first = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'one.txt', content: 'one' }]),
    )
    await first.publish(async () => {})
    const stale = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'two.txt', content: 'two' }]),
    )
    await expect(stale.publish(async () => {})).rejects.toThrow('Task branch changed')
    const later = await f.prepare(Buffer.alloc(0), emptyUntrackedArchive(), {
      taskId: 'later',
      branch: 'agent/later',
      turn: 2,
    })
    await expect(later.publish(async () => {})).rejects.toThrow('Task branch changed')
  })

  it('blocks new publications as soon as disposal begins while allowing the in-flight push to finish', async () => {
    const f = await fixture()
    const candidate = await f.prepare()
    let unblock: () => void = () => {}
    let entered: () => void = () => {}
    const atFence = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const publishing = candidate.publish(async () => {
      entered()
      await blocked
    })
    await atFence
    const disposing = candidate.dispose()
    await expect(candidate.publish(async () => {})).rejects.toThrow('disposed')
    unblock()
    await publishing
    await disposing
    expect((await git(f.remote, 'rev-parse', 'agent/task1')).toString().trim()).toBe(
      candidate.headSha,
    )
  })

  it('publishes the next turn only from the previous task head', async () => {
    const f = await fixture()
    const first = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'one.txt', content: 'one' }]),
    )
    await first.publish(async () => {})
    const second = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'two.txt', content: 'two' }]),
      { expectedBaseSha: first.headSha, turn: 2 },
    )
    await second.publish(async () => {})
    expect((await git(f.remote, 'rev-parse', `${second.headSha}^`)).toString().trim()).toBe(
      first.headSha,
    )
  })

  it.each([
    '.github/workflows/pwn.yml',
    'wp-config.php',
    '.GIT/config',
    'nested/../escape',
    '/absolute',
    '-option',
  ])('rejects untracked dangerous path %s', async (name) => {
    const f = await fixture()
    await expect(
      f.prepare(Buffer.alloc(0), await archive([{ name, content: 'bad' }])),
    ).rejects.toThrow()
  })

  it('rejects edits and renames of protected existing paths', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'wp-config.php'), 'changed\n')
    await expect(f.prepare(await f.patch())).rejects.toThrow('protected path')
    await git(f.work, 'reset', '--hard', 'HEAD')
    await git(f.work, 'mv', 'wp-config.php', 'renamed.php')
    await expect(f.prepare(await f.patch())).rejects.toThrow()
  })

  it('rejects symlink and permission change patch headers', async () => {
    const f = await fixture()
    await rm(join(f.work, 'index.php'))
    await symlink('wp-config.php', join(f.work, 'index.php'))
    await expect(f.prepare(await f.patch())).rejects.toThrow()
    await git(f.work, 'reset', '--hard', 'HEAD')
    await chmod(join(f.work, 'index.php'), 0o755)
    await expect(f.prepare(await f.patch())).rejects.toThrow('permission change')
  })

  it('rejects symlink archives and collisions rather than replacing a tracked file', async () => {
    const f = await fixture()
    await expect(
      f.prepare(
        Buffer.alloc(0),
        await archive([{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }]),
      ),
    ).rejects.toThrow()
    // The agent's output, not the client's input.
    await expect(
      f.prepare(Buffer.alloc(0), await archive([{ name: 'index.php', content: 'replace' }])),
    ).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      httpStatus: 502,
      message: expect.stringContaining('collides'),
    })
  })

  it.each(['synthetic-secret-marker', 'scanner-error-marker'])(
    'fails closed when fixed scanner rejects a full blob: %s',
    async (content) => {
      const f = await fixture()
      await expect(
        f.prepare(Buffer.alloc(0), await archive([{ name: 'payload.bin', content }])),
      ).rejects.toThrow()
      expect((await git(f.remote, 'show-ref', '--heads')).toString()).not.toContain('agent/task1')
    },
  )

  it('fails closed when scanner is missing and does not expose process diagnostics', async () => {
    const f = await fixture()
    await rm(f.scanner)
    await expect(
      f.prepare(Buffer.alloc(0), await archive([{ name: 'new.txt', content: 'new' }])),
    ).rejects.toThrow('Trusted repository command failed')
  })

  it('rejects branch/task mismatches, invalid dates and malformed patches before publication', async () => {
    const f = await fixture()
    await expect(f.prepare(Buffer.alloc(0), undefined, { branch: 'agent/other' })).rejects.toThrow(
      'metadata',
    )
    await expect(
      f.prepare(Buffer.alloc(0), undefined, { createdAt: 'not a date' }),
    ).rejects.toThrow('metadata')
    await expect(f.prepare(Buffer.from('this is not a patch'))).rejects.toThrow()
  })

  it('copies input bytes before asynchronous work', async () => {
    const f = await fixture()
    const untracked = await archive([{ name: 'new.txt', content: 'original' }])
    const promise = f.prepare(Buffer.alloc(0), untracked)
    untracked.fill(0)
    const candidate = await promise
    await candidate.publish(async () => {})
    expect((await git(f.remote, 'show', `${candidate.headSha}:new.txt`)).toString()).toBe(
      'original',
    )
  })

  it('transfers a credential-free trusted bundle through exec stdin into a fresh sandbox', async () => {
    const f = await fixture()
    const calls: { argv: readonly string[]; stdin: Buffer }[] = []
    const sandbox = {
      exec: vi.fn(async (spec) => {
        const chunks: Uint8Array[] = []
        if (spec.stdin) for await (const chunk of spec.stdin) chunks.push(chunk)
        calls.push({ argv: spec.argv, stdin: Buffer.concat(chunks) })
        return {
          output: async function* () {},
          wait: async () => ({ reason: 'exited', code: 0 }),
          kill: async () => {},
        }
      }),
    } as unknown as Sandbox
    const { taskId: _task, turn: _turn, createdAt: _date, ...source } = f.metadata
    await f.service.prepareWorkspace(sandbox, source)
    const transfer = calls.find((call) => call.argv[0] === 'dd')!
    const bundlePath = join(f.root, 'delivered.bundle')
    await writeFile(bundlePath, transfer.stdin)
    expect((await git(f.work, 'bundle', 'list-heads', bundlePath)).toString()).toBe(
      `${f.baseSha} refs/heads/raditi-base\n`,
    )
    expect(calls.some((call) => call.argv.join(' ').includes('remote remove origin'))).toBe(true)
    expect(calls.some((call) => call.argv.includes(f.remote))).toBe(false)
    expect(calls.at(-1)?.argv).toEqual(['rm', '-f', '--', '/tmp/raditi-base.bundle'])
  })

  it('refuses a gap in sandbox command output and stops the command', async () => {
    const f = await fixture()
    const kill = vi.fn(async () => {})
    const sandbox = {
      exec: vi.fn(async () => ({
        output: async function* () {
          yield { stream: 'stdout', offset: 5, data: Buffer.from('x') }
        },
        wait: async () => ({ reason: 'exited', code: 0 }),
        kill,
      })),
    } as unknown as Sandbox
    const { taskId: _task, turn: _turn, createdAt: _date, ...source } = f.metadata
    await expect(f.service.prepareWorkspace(sandbox, source)).rejects.toMatchObject({
      code: 'GIT_OPERATION_FAILED',
    })
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('production boundaries', () => {
  const ref = { provider: 'gitea' as const, owner: 'owner', name: 'repo' }
  const source = {
    repo: ref,
    branch: 'agent/task1',
    expectedBaseSha: 'a'.repeat(40),
    protectedPaths: [],
  }
  const provider = (cloneUrl: string, expiresAt: Date) =>
    ({
      kind: 'gitea',
      getRepository: async () => ({ ref, cloneUrl }),
      issueCredentials: vi.fn(async () => ({
        username: 'bot',
        token: 'synthetic-grant',
        expiresAt,
      })),
    }) as unknown as GitProvider

  it.each([
    'http://git.example.test/repo',
    'https://other.example.test/repo',
    'https://user:password@git.example.test/repo',
    'https://git.example.test/repo?token=value',
    'file:///tmp/repo',
  ])('refuses an unapproved clone URL: %s', async (url) => {
    const p = provider(url, new Date(Date.now() + 60_000))
    const service = new GitWorkspaceService(p, {
      transport: { kind: 'https', allowedOrigins: ['https://git.example.test'] },
    })
    await expect(service.prepareWorkspace({} as Sandbox, source)).rejects.toThrow('HTTPS origins')
    expect(p.issueCredentials).not.toHaveBeenCalled()
  })

  it.each([new Date(0), new Date('invalid'), new Date('2099-01-01')])(
    'refuses expired, invalid or permanent grants without network access: %s',
    async (expiresAt) => {
      const service = new GitWorkspaceService(
        provider('https://git.example.test/repo', expiresAt),
        { transport: { kind: 'https', allowedOrigins: ['https://git.example.test'] } },
      )
      await expect(service.prepareWorkspace({} as Sandbox, source)).rejects.toThrow(
        'short-lived grant',
      )
    },
  )

  it.each(['getRepository', 'issueCredentials'] as const)(
    'gives up on a provider %s call that never answers',
    async (call) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const p = provider('https://git.example.test/repo', new Date(Date.now() + 60_000))
        const called = Promise.withResolvers<void>()
        p[call] = vi.fn(() => {
          called.resolve()
          return new Promise<never>(() => {})
        })
        const service = new GitWorkspaceService(p, {
          transport: { kind: 'https', allowedOrigins: ['https://git.example.test'] },
        })
        const rejected = expect(
          service.prepareWorkspace({} as Sandbox, source),
        ).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
        await called.promise
        await vi.advanceTimersByTimeAsync(publicationLimits.commandMs)
        await rejected
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('refuses local transport outside test mode', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(
        () =>
          new GitWorkspaceService({} as GitProvider, {
            transport: { kind: 'local-test', root: '/tmp' },
          }),
      ).toThrow('restricted to tests')
    } finally {
      process.env.NODE_ENV = previous
    }
  })
})

describe('binary patch allocation limits', () => {
  it('rejects an inflated-size allocation before invoking native Git as too large', () => {
    expect(() =>
      assertBinaryPatchLimits(
        Buffer.from(`GIT binary patch\nliteral ${publicationLimits.fileBytes + 1}\nA00000\n\n`),
      ),
    ).toThrow(expect.objectContaining({ code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 }))
  })
  it('rejects malformed base85 and empty binary blocks as invalid input', () => {
    expect(() =>
      assertBinaryPatchLimits(Buffer.from('GIT binary patch\nliteral 1\nA:::::\n\n')),
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    expect(() => assertBinaryPatchLimits(Buffer.from('GIT binary patch\n'))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})
