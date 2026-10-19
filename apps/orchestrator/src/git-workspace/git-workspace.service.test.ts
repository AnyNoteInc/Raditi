import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  DomainError,
  isEnvValueRefusal,
  isSnapshotCredential,
  type GitProvider,
  type PublicationMetadata,
  type Sandbox,
  type TurnPublication,
  publicationLimits,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from './archive.ts'
import { importBaseBundle } from './base-bundle.ts'
import { assertBinaryPatchLimits } from './binary-limits.ts'
import { GitWorkspaceService, scanCopy } from './git-workspace.service.ts'
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
  // It scans a directory like `gitleaks dir` and logs its argv and every file it was given.
  // Like Gitleaks, it reports a finding with `--exit-code` and its own errors with 1.
  const scanner = join(root, 'scanner.mjs')
  const scannerLog = join(root, 'scanner.log')
  await writeFile(
    scanner,
    `#!${process.execPath}
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const files = Object.fromEntries(readdirSync(args[1]).map((name) => [name, readFileSync(join(args[1], name), 'latin1')]))
appendFileSync(${JSON.stringify(scannerLog)}, JSON.stringify({ args, cwd: process.cwd(), files }) + '\\n')
const data = Object.values(files).join('\\n')
const finding = Number(args.find((arg) => arg.startsWith('--exit-code='))?.slice(12) ?? 1)
process.exit(data.includes('synthetic-secret-marker') ? finding : data.includes('gitleaks-error-marker') ? 1 : data.includes('scanner-error-marker') ? 2 : 0)
`,
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
    mirrorDir: join(root, 'mirrors'),
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
  const scans = async () =>
    (await readFile(scannerLog, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; cwd: string; files: Record<string, string> },
      )
  const prepare = async (
    diff = Buffer.alloc(0),
    untracked: Uint8Array = emptyUntrackedArchive(),
    overrides: Partial<PublicationMetadata> & {
      credentials?: string[]
      refusedValues?: string[]
    } = {},
  ) => {
    const candidate = await service.preparePublication({
      ...metadata,
      credentials: [],
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
    scans,
  }
}

// Real git and dozens of child processes per test: a shared CI runner needs more than 5 s.
describe('trusted Git publication', { timeout: 30_000 }, () => {
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
    // One scanner run per candidate, never one per file.
    const scans = await f.scans()
    expect(scans).toHaveLength(2)
    for (const { args } of scans) {
      expect(args.slice(0, 2)).toEqual(['dir', '.'])
      expect(args).toContain('--ignore-gitleaks-allow')
      expect(args).toContain('--redact=100')
      expect(args).toContain('--exit-code=99')
      expect(args[args.indexOf('--config') + 1]).toMatch(/^\//)
    }
  })

  it('scans every changed blob in full once, under host-numbered names, in one run', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'index.php'), 'updated\n')
    const binary = Buffer.from([0, 8, 9, 255, 0, 7, 0])
    await writeFile(join(f.work, 'binary.dat'), binary)
    const candidate = await f.prepare(
      await f.patch(),
      await archive([
        { name: '.gitleaksignore', content: 'ignore everything' },
        { name: 'same-a.txt', content: 'shared' },
        { name: 'same-b.txt', content: 'shared' },
      ]),
    )
    const [scan, ...more] = await f.scans()
    expect(more).toEqual([])
    expect(scan!.args.slice(0, 2)).toEqual(['dir', '.'])
    // Agent paths never name a scanned file: a `.gitleaksignore` of its own is only content.
    expect(Object.keys(scan!.files).sort()).toEqual(['0', '1', '2', '3'])
    // Every copy behind an image header, so Gitleaks cannot take it for an archive.
    expect(Object.values(scan!.files).sort()).toEqual(
      [
        'GIF89a\nignore everything',
        'GIF89a\nshared',
        'GIF89a\nupdated\n',
        `GIF89a\n${binary.toString('latin1')}`,
      ].sort(),
    )
    // The private copies are gone before the candidate is handed out.
    await expect(readFile(join(scan!.cwd, '0'))).rejects.toThrow()
    await candidate.publish(async () => {})
    expect((await git(f.remote, 'show', `${candidate.headSha}:same-b.txt`)).toString()).toBe(
      'shared',
    )
  })

  it('runs as many processes for 300 changed files as for 2: none per file', async () => {
    const processes = async (count: number) => {
      const f = await fixture()
      await writeFile(join(f.work, 'index.php'), 'updated\n')
      const patch = await f.patch()
      const files = Array.from({ length: count - 1 }, (_, i) => ({
        name: `new/${i}.txt`,
        content: `file ${i}\n`,
      }))
      vi.mocked(runProcess).mockClear()
      await f.prepare(patch, await archive(files))
      return vi.mocked(runProcess).mock.calls.length
    }
    expect(await processes(300)).toBe(await processes(2))
  })

  it('refuses a turn credential in a binary change of a tracked file before scanning', async () => {
    const f = await fixture()
    const credential = 'synthetic-turn-credential-0123456789'
    // Compressed in the binary patch: the captured patch text never shows the value itself.
    await writeFile(
      join(f.work, 'binary.dat'),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(credential.repeat(64))]),
    )
    const patch = await f.patch()
    expect(patch.toString()).toContain('GIT binary patch')
    expect(patch.includes(credential)).toBe(false)
    const error: unknown = await f.prepare(patch, undefined, { credentials: [credential] }).then(
      () => null,
      (rejection: unknown) => rejection,
    )
    expect(isSnapshotCredential(error)).toBe(true)
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(String(error)).not.toContain(credential)
    await expect(readFile(f.scannerLog, 'utf8')).rejects.toThrow()
    // Recovery replays a checked checkpoint without the turn's credentials.
    await expect(f.prepare(patch)).resolves.toBeDefined()
  })

  it('refuses the value of a client variable in any changed file or path, in any spelling it knows (Р13)', async () => {
    const value = 'pay-se"cret-0001'
    const plain = 'hook-token-0002'
    const refusal = async (
      diff: Buffer<ArrayBuffer>,
      untracked: Uint8Array | undefined,
      f: Awaited<ReturnType<typeof fixture>>,
    ) => {
      const error: unknown = await f
        .prepare(diff, untracked, { refusedValues: [value, plain] })
        .then(
          () => null,
          (rejection: unknown) => rejection,
        )
      expect(isEnvValueRefusal(error)).toBe(true)
      expect((error as DomainError).code).toBe('PUBLICATION_SECRET')
      expect(JSON.stringify(error) + String(error)).not.toMatch(/cret-0001|token-0002/)
    }
    // Compressed in a binary patch: only the whole blob shows it.
    const binary = await fixture()
    await writeFile(
      join(binary.work, 'binary.dat'),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(value.repeat(64))]),
    )
    const patch = await binary.patch()
    expect(patch.includes(value)).toBe(false)
    await refusal(patch, undefined, binary)
    await expect(binary.prepare(patch)).resolves.toBeDefined()
    // As a JSON string holds it, in a new file of the change.
    const json = await fixture()
    await refusal(
      Buffer.alloc(0),
      await archive([{ name: 'config.json', content: JSON.stringify({ key: value }) }]),
      json,
    )
    // In the name of a new file.
    const named = await fixture()
    await refusal(
      Buffer.alloc(0),
      await archive([{ name: `notes-${plain}.txt`, content: 'x' }]),
      named,
    )
    // Without values nothing is refused, and nothing else is looked for.
    const other = await fixture()
    await writeFile(join(other.work, 'index.php'), 'pay-secret but not the value\n')
    await expect(
      other.prepare(await other.patch(), undefined, { refusedValues: [value] }),
    ).resolves.toBeDefined()
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
    await expect(f.service.buildBaseBundle(withoutPaths as typeof source)).rejects.toThrow(
      'Invalid repository source',
    )
    await expect(
      f.service.preparePublication({
        ...(withoutPaths as typeof source),
        taskId: 'task1',
        turn: 1,
        createdAt: f.metadata.createdAt,
        patch: Buffer.alloc(0),
        untracked: emptyUntrackedArchive(),
        credentials: [],
      }),
    ).rejects.toThrow('Invalid publication metadata')
    expect(f.provider.getRepository).not.toHaveBeenCalled()
  })

  it('rejects repeated patch paths before allocating repeated postimages', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'index.php'), 'updated\n')
    const patch = await f.patch()
    await expect(f.prepare(Buffer.concat([patch, patch]))).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      message: expect.stringContaining('repeated paths'),
    })
  })

  it('publishes a replacement from its original base against the pinned previous task head', async () => {
    const f = await fixture()
    const first = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'first.txt', content: 'old proposal' }]),
    )
    await first.publish(async () => {})
    const second = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'second.txt', content: 'new proposal' }]),
      {
        turn: 2,
        expectedBranchSha: first.headSha,
      },
    )
    expect(second.baseSha).toBe(f.baseSha)
    await second.publish(async () => {})
    expect((await git(f.remote, 'rev-parse', 'agent/task1')).toString().trim()).toBe(second.headSha)
    expect(
      (await git(f.remote, 'ls-tree', '--name-only', second.headSha)).toString(),
    ).not.toContain('first.txt')
    expect((await git(f.remote, 'show', `${second.headSha}:second.txt`)).toString()).toBe(
      'new proposal',
    )
    await second.publish(async () => {})
  })

  it('allows a proven absent replacement branch and refuses an unexpected reset to its base', async () => {
    const f = await fixture()
    const first = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'first.txt', content: 'retry' }]),
      {
        turn: 2,
        expectedBranchSha: null,
      },
    )
    await first.publish(async () => {})
    const second = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'second.txt', content: 'replacement' }]),
      {
        turn: 3,
        expectedBranchSha: first.headSha,
      },
    )
    await git(f.remote, 'update-ref', 'refs/heads/agent/task1', f.baseSha)
    await expect(second.publish(async () => {})).rejects.toThrow('Task branch changed')
    expect((await git(f.remote, 'rev-parse', 'agent/task1')).toString().trim()).toBe(f.baseSha)
  })

  it('keeps compare-and-swap when a pinned replacement branch changes during its final fence', async () => {
    const f = await fixture()
    const first = await f.prepare(
      Buffer.alloc(0),
      await archive([{ name: 'first.txt', content: 'old' }]),
    )
    await first.publish(async () => {})
    const replacement = await f.prepare(Buffer.alloc(0), emptyUntrackedArchive(), {
      turn: 2,
      expectedBranchSha: first.headSha,
    })
    await expect(
      replacement.publish(async () => {
        await git(f.remote, 'update-ref', 'refs/heads/agent/task1', f.baseSha)
      }),
    ).rejects.toThrow('Trusted repository operation failed')
    expect((await git(f.remote, 'rev-parse', 'agent/task1')).toString().trim()).toBe(f.baseSha)
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
    ['.github/workflows/pwn.yml', 'PUBLICATION_FORBIDDEN'],
    ['wp-config.php', 'PUBLICATION_FORBIDDEN'],
    ['.GIT/config', 'TURN_OUTPUT_REJECTED'],
    ['git~1/config', 'TURN_OUTPUT_REJECTED'],
    ['nested/.git. /config', 'TURN_OUTPUT_REJECTED'],
    ['nested/../escape', 'TURN_OUTPUT_REJECTED'],
    ['/absolute', 'TURN_OUTPUT_REJECTED'],
    ['-option', 'TURN_OUTPUT_REJECTED'],
  ])('rejects untracked dangerous path %s as the agent output (%s)', async (name, code) => {
    const f = await fixture()
    await expect(
      f.prepare(Buffer.alloc(0), await archive([{ name, content: 'bad' }])),
    ).rejects.toMatchObject({ code, httpStatus: 502 })
  })

  it('rejects a patched path starting with a dash as the agent output', async () => {
    const f = await fixture()
    await writeFile(join(f.work, '-option'), 'bad\n')
    await git(f.work, 'add', '--', '-option')
    await expect(f.prepare(await f.patch())).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      httpStatus: 502,
    })
  })

  it('rejects edits and renames of protected existing paths', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'wp-config.php'), 'changed\n')
    await expect(f.prepare(await f.patch())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
      message: expect.stringContaining('protected path'),
    })
    await git(f.work, 'reset', '--hard', 'HEAD')
    await git(f.work, 'mv', 'wp-config.php', 'renamed.php')
    await expect(f.prepare(await f.patch())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
  })

  it('rejects symlink and permission change patch headers', async () => {
    const f = await fixture()
    await rm(join(f.work, 'index.php'))
    await symlink('wp-config.php', join(f.work, 'index.php'))
    await expect(f.prepare(await f.patch())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
    })
    await git(f.work, 'reset', '--hard', 'HEAD')
    await chmod(join(f.work, 'index.php'), 0o755)
    await expect(f.prepare(await f.patch())).rejects.toMatchObject({
      code: 'PUBLICATION_FORBIDDEN',
      message: expect.stringContaining('permission change'),
    })
  })

  it.each([
    ['an object header', (old: string) => `index ${old}..zz 100644`],
    [
      'a postimage that is not a blob',
      (old: string, tree: string) => `index ${old}..${tree} 100644`,
    ],
  ])('rejects %s it cannot use as the agent output', async (_, header) => {
    const f = await fixture()
    const old = (await git(f.work, 'rev-parse', 'HEAD:binary.dat')).toString().trim()
    const tree = (await git(f.work, 'rev-parse', 'HEAD^{tree}')).toString().trim()
    const patch = Buffer.from(
      `diff --git a/binary.dat b/binary.dat\n${header(old, tree)}\nBinary files a/binary.dat and b/binary.dat differ\n`,
    )
    await expect(f.prepare(patch)).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      httpStatus: 502,
    })
  })

  it('reports a link in the site repository itself as unsupported, not as the agent fault', async () => {
    const f = await fixture()
    await symlink('index.php', join(f.work, 'link.php'))
    await git(f.work, 'add', 'link.php')
    await git(f.work, 'commit', '-m', 'site link')
    await git(f.work, 'push', f.remote, 'HEAD:main')
    const base = (await git(f.work, 'rev-parse', 'HEAD')).toString().trim()
    const { taskId: _task, turn: _turn, createdAt: _date, ...source } = f.metadata
    const unsupported = { code: 'REPOSITORY_UNSUPPORTED', httpStatus: 422 }
    await expect(
      f.service.buildBaseBundle({ ...source, expectedBaseSha: base }),
    ).rejects.toMatchObject(unsupported)
    await expect(
      f.prepare(Buffer.alloc(0), undefined, { expectedBaseSha: base }),
    ).rejects.toMatchObject(unsupported)
  })

  it('rejects symlink archives and collisions rather than replacing a tracked file', async () => {
    const f = await fixture()
    await expect(
      f.prepare(
        Buffer.alloc(0),
        await archive([{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }]),
      ),
    ).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 })
    // The agent's output, not the client's input.
    await expect(
      f.prepare(Buffer.alloc(0), await archive([{ name: 'index.php', content: 'replace' }])),
    ).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      httpStatus: 502,
      message: expect.stringContaining('collides'),
    })
  })

  it.each([
    ['synthetic-secret-marker', 'PUBLICATION_SECRET'],
    // Gitleaks exits 1 on a partial scan or a broken config, not only on a finding.
    ['gitleaks-error-marker', 'GIT_OPERATION_FAILED'],
    ['scanner-error-marker', 'GIT_OPERATION_FAILED'],
  ])('fails closed when fixed scanner rejects a full blob: %s', async (content, code) => {
    const f = await fixture()
    await expect(
      f.prepare(Buffer.alloc(0), await archive([{ name: 'payload.bin', content }])),
    ).rejects.toMatchObject({ code, httpStatus: 502 })
    expect((await git(f.remote, 'show-ref', '--heads')).toString()).not.toContain('agent/task1')
  })

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
    await expect(f.prepare(Buffer.from('this is not a patch'))).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      httpStatus: 502,
    })
  })

  it.each([
    [
      'a corrupt patch',
      'diff --git a/index.php b/index.php\n--- a/index.php\n+++ b/index.php\n@@ -1 +1 @@\nnot a hunk line\n',
    ],
    [
      'a patch that does not apply',
      'diff --git a/index.php b/index.php\n--- a/index.php\n+++ b/index.php\n@@ -1 +1 @@\n-other\n+updated\n',
    ],
  ])('reports %s refused by Git as the agent output', async (_, patch) => {
    const f = await fixture()
    await expect(f.prepare(Buffer.from(patch))).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      httpStatus: 502,
      message: 'Invalid publication patch',
    })
  })

  it.each(['--summary', '--numstat', '--cached'])(
    'maps git apply %s exiting non-zero to the agent output, a failed run to ours',
    async (flag) => {
      const f = await fixture()
      await writeFile(join(f.work, 'index.php'), 'updated\n')
      const patch = await f.patch()
      let failure: 'exit' | 'process' = 'exit'
      vi.mocked(runProcess).mockImplementation(async (binary, argv, options) => {
        if (!(argv.includes('apply') && argv.includes(flag)))
          return realRunProcess(binary, argv, options)
        if (failure === 'exit') return { code: 128, stdout: Buffer.alloc(0) }
        throw new DomainError('GIT_OPERATION_FAILED', 'Trusted repository command failed', 502)
      })
      await expect(f.prepare(patch)).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
      failure = 'process'
      await expect(f.prepare(patch)).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
    },
  )

  it('rejects a new file Git leaves out of the index while reporting success', async () => {
    const f = await fixture()
    // As with `git~1/x` under core.protectNTFS: «Ignoring path» for one entry, exit code 0.
    vi.mocked(runProcess).mockImplementation(async (binary, argv, options) => {
      if (!argv.includes('update-index')) return realRunProcess(binary, argv, options)
      const rows = Buffer.from(options.input!).toString().split('\0')
      const kept = rows.filter((row) => !row.endsWith('\tdropped.txt')).join('\0')
      return realRunProcess(binary, argv, { ...options, input: Buffer.from(kept) })
    })
    const files = [
      { name: 'kept.txt', content: 'kept' },
      { name: 'dropped.txt', content: 'dropped' },
    ]
    await expect(f.prepare(Buffer.alloc(0), await archive(files))).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
      message: expect.stringContaining('missing from the candidate'),
    })
    await expect(readFile(f.scannerLog, 'utf8')).rejects.toThrow()
  })

  it.each(['patch', 'untracked'] as const)(
    'rejects a %s file at a path HFS+ reads as .git, on every platform',
    async (via) => {
      const f = await fixture()
      const name = '.g\u200cit/config'
      let patch = Buffer.alloc(0)
      if (via === 'patch') {
        await mkdir(join(f.work, '.g\u200cit'))
        await writeFile(join(f.work, name), '[core]\n\thooksPath = /tmp\n')
        await git(f.work, '-c', 'core.protectHFS=false', 'add', '--', name)
        patch = await f.patch()
      }
      const untracked =
        via === 'untracked'
          ? [
              { name, content: '[core]\n' },
              { name: 'kept.txt', content: 'kept' },
            ]
          : []
      // A git built for Linux has core.protectHFS off: set off in front of every option, as such
      // a build has it. The trusted options turn it on again, so git refuses the path.
      vi.mocked(runProcess).mockImplementation(async (binary, argv, options) =>
        realRunProcess(
          binary,
          ['-c', 'core.protectHFS=false', '-c', 'core.protectNTFS=false', ...argv],
          options,
        ),
      )
      await expect(f.prepare(patch, await archive(untracked))).rejects.toMatchObject({
        code: 'TURN_OUTPUT_REJECTED',
      })
    },
  )

  it('requires the turn credentials explicitly, even when there are none', async () => {
    const f = await fixture()
    const input = { ...f.metadata, patch: Buffer.alloc(0), untracked: emptyUntrackedArchive() }
    // @ts-expect-error: like protectedPaths, the turn credentials cannot be left out.
    const missing = f.service.preparePublication(input)
    await expect(missing).rejects.toThrow('Invalid publication input')
    expect(f.provider.getRepository).not.toHaveBeenCalled()
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

  it('reads the head of a branch: the base of a first turn and the head of a published task', async () => {
    const f = await fixture()
    const cwds: string[] = []
    vi.mocked(runProcess).mockImplementation((binary, argv, options) => {
      cwds.push(options.cwd)
      return realRunProcess(binary, argv, options)
    })
    await expect(f.service.readBranchHead({ repo: f.repo, branch: 'main' })).resolves.toBe(
      f.baseSha,
    )
    await expect(
      f.service.readBranchHead({ repo: f.repo, branch: 'agent/task1' }),
    ).resolves.toBeNull()
    // One ls-remote per read, in a private directory that is gone afterwards.
    expect(cwds).toHaveLength(2)
    for (const cwd of cwds) await expect(readFile(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    vi.mocked(runProcess).mockImplementation(realRunProcess)

    await writeFile(join(f.work, 'index.php'), 'updated\n')
    const candidate = await f.prepare(await f.patch())
    await candidate.publish(async () => {})
    await expect(f.service.readBranchHead({ repo: f.repo, branch: 'agent/task1' })).resolves.toBe(
      candidate.headSha,
    )
    expect(f.provider.issueCredentials).not.toHaveBeenCalled()
  })

  it.each([
    '',
    '-main',
    'main --upload-pack=x',
    'a..b',
    'a//b',
    'main/',
    'main.lock',
    'refs/heads/main\n',
    'x'.repeat(201),
  ])('refuses the branch name %j before looking the repository up', async (branch) => {
    const f = await fixture()
    await expect(f.service.readBranchHead({ repo: f.repo, branch })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      f.service.readBranchHead({ repo: { ...f.repo, provider: 'github' }, branch: 'main' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.provider.getRepository).not.toHaveBeenCalled()
  })

  it('refuses to read a branch of another repository than the one it asked for', async () => {
    const f = await fixture()
    vi.mocked(f.provider.getRepository).mockResolvedValueOnce({
      ref: { ...f.repo, name: 'other' },
      cloneUrl: f.remote,
      defaultBranch: 'main',
      private: true,
    })
    await expect(f.service.readBranchHead({ repo: f.repo, branch: 'main' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    vi.mocked(f.provider.getRepository).mockResolvedValueOnce(null)
    await expect(f.service.readBranchHead({ repo: f.repo, branch: 'main' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
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
    const bundle = await f.service.buildBaseBundle(source)
    expect(bundle).toMatchObject({ baseSha: f.baseSha, branch: source.branch })
    await importBaseBundle(sandbox, bundle)
    const transfer = calls.find((call) => call.argv[0] === 'dd')!
    expect(transfer.stdin.byteLength).toBe(bundle.sizeBytes)
    expect(createHash('sha256').update(transfer.stdin).digest('hex')).toBe(bundle.sha256)
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
    await expect(
      importBaseBundle(sandbox, await f.service.buildBaseBundle(source)),
    ).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })

  it.each([
    ['changed bytes', { sha256: 'f'.repeat(64) }, 'GIT_OPERATION_FAILED'],
    ['a different size', { sizeBytes: 1 }, 'GIT_OPERATION_FAILED'],
    [
      'a size over the limit',
      { sizeBytes: publicationLimits.bundleBytes + 1 },
      'REPOSITORY_TOO_LARGE',
    ],
    ['a branch git reads as an option', { branch: '--upload-pack=touch' }, 'BAD_REQUEST'],
    ['an abbreviated base', { baseSha: 'abc1234' }, 'BAD_REQUEST'],
  ])('refuses a bundle with %s before running anything in the sandbox', async (_, change, code) => {
    const f = await fixture()
    const exec = vi.fn()
    const { taskId: _task, turn: _turn, createdAt: _date, ...source } = f.metadata
    const bundle = { ...(await f.service.buildBaseBundle(source)), ...change }
    await expect(importBaseBundle({ exec } as unknown as Sandbox, bundle)).rejects.toMatchObject({
      code,
    })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('production boundaries', { timeout: 30_000 }, () => {
  // Mirrors of these remotes are made for real before any network call: never in the shared tmp.
  let mirrorDir = ''
  beforeEach(async () => {
    mirrorDir = await mkdtemp(join(tmpdir(), 'raditi-mirror-test-'))
    roots.push(mirrorDir)
  })
  const https = { kind: 'https' as const, allowedOrigins: ['https://git.example.test'] }
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
    const service = new GitWorkspaceService(p, { transport: https, mirrorDir })
    await expect(service.buildBaseBundle(source)).rejects.toThrow('HTTPS origins')
    expect(p.issueCredentials).not.toHaveBeenCalled()
  })

  it.each([new Date(0), new Date('invalid'), new Date('2099-01-01')])(
    'refuses expired, invalid or permanent grants without network access: %s',
    async (expiresAt) => {
      const service = new GitWorkspaceService(
        provider('https://git.example.test/repo', expiresAt),
        { transport: https, mirrorDir },
      )
      await expect(service.buildBaseBundle(source)).rejects.toThrow('short-lived grant')
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
        const service = new GitWorkspaceService(p, { transport: https, mirrorDir })
        const rejected = expect(service.buildBaseBundle(source)).rejects.toMatchObject({
          code: 'GIT_OPERATION_FAILED',
        })
        await called.promise
        await vi.advanceTimersByTimeAsync(publicationLimits.commandMs)
        await rejected
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('hands the configured CA file to git and leaves certificate checks on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-publication-test-'))
    roots.push(root)
    const caFile = join(root, 'ca.pem')
    await writeFile(caFile, 'synthetic CA placeholder\n')
    const seen: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
    // The mirror is made for real; the network is not there: its fetch fails.
    vi.mocked(runProcess).mockImplementation(async (binary, argv, options) => {
      if (argv.includes('init')) return realRunProcess(binary, argv, options)
      if (argv.includes('cat-file')) return { code: 0, stdout: Buffer.from('x missing\n') }
      seen.push({ argv, env: options.env })
      return { code: 1, stdout: Buffer.alloc(0) }
    })
    for (const transport of [{ ...https, caFile }, https]) {
      const p = provider('https://git.example.test/repo', new Date(Date.now() + 60_000))
      const service = new GitWorkspaceService(p, { transport, mirrorDir })
      await expect(service.buildBaseBundle(source)).rejects.toMatchObject({
        code: 'GIT_OPERATION_FAILED',
      })
    }
    expect(seen).toHaveLength(2)
    expect(seen[0]!.argv).toContain('fetch')
    expect(seen[0]!.env.GIT_SSL_CAINFO).toBe(caFile)
    expect('GIT_SSL_CAINFO' in seen[1]!.env).toBe(false)
    for (const { argv, env } of seen) {
      expect(Object.keys(env).filter((name) => /SSL_NO_VERIFY|CAPATH|PROXY/i.test(name))).toEqual(
        [],
      )
      expect(argv.filter((arg) => /sslVerify|sslCAInfo|proxy/i.test(arg))).toEqual([])
    }
  })

  it.each(['ca.pem', './ca.pem', '', '/nonexistent/raditi/ca.pem', tmpdir()])(
    'refuses the CA file %j at construction',
    (caFile) => {
      expect(
        () =>
          new GitWorkspaceService({} as GitProvider, {
            transport: { kind: 'https', allowedOrigins: ['https://git.example.test'], caFile },
          }),
      ).toThrow('CA file')
    },
  )

  it('reads a branch head over https with a short read-only credential', async () => {
    const seen: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
    const head = 'b'.repeat(40)
    vi.mocked(runProcess).mockImplementation(async (_binary, argv, options) => {
      seen.push({ argv, env: options.env })
      return { code: 0, stdout: Buffer.from(`${head}\trefs/heads/main\n`) }
    })
    const p = provider('https://git.example.test/owner/repo.git', new Date(Date.now() + 60_000))
    const service = new GitWorkspaceService(p, { transport: https, mirrorDir })
    await expect(service.readBranchHead({ repo: ref, branch: 'main' })).resolves.toBe(head)
    expect(p.issueCredentials).toHaveBeenCalledExactlyOnceWith(ref, 'read', 120)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.argv.slice(-4)).toEqual([
      'ls-remote',
      '--refs',
      'https://git.example.test/owner/repo.git',
      'refs/heads/main',
    ])
    // The credential travels in the environment, never in the arguments or the URL.
    expect(seen[0]!.argv).toContain('--config-env=http.extraHeader=RADITI_GIT_AUTH')
    expect(seen[0]!.env.RADITI_GIT_AUTH).toBe(
      `Authorization: Basic ${Buffer.from('bot:synthetic-grant').toString('base64')}`,
    )
    expect(seen[0]!.argv.join(' ')).not.toContain('synthetic-grant')
  })

  it('fails closed when the remote answers a branch read with anything but one ref', async () => {
    const p = provider('https://git.example.test/owner/repo.git', new Date(Date.now() + 60_000))
    const service = new GitWorkspaceService(p, { transport: https, mirrorDir })
    for (const stdout of [
      `${'b'.repeat(40)}\trefs/heads/other\n`,
      `${'b'.repeat(40)}\trefs/heads/main\n${'c'.repeat(40)}\trefs/heads/x/refs/heads/main\n`,
      'not a ref line\n',
    ]) {
      vi.mocked(runProcess).mockImplementation(async () => ({
        code: 0,
        stdout: Buffer.from(stdout),
      }))
      await expect(service.readBranchHead({ repo: ref, branch: 'main' })).rejects.toMatchObject({
        code: 'GIT_OPERATION_FAILED',
      })
    }
  })

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

describe('scan copies', () => {
  it('puts content that starts with an application signature behind an image header', () => {
    // Gitleaks skips a file that looks like a PDF, archive or program; verify-publication.mjs
    // proves the header with the real binary.
    for (const text of [
      Buffer.from('%PDF-1.7\nTOKEN=synthetic-secret-marker\n'),
      Buffer.from('TOKEN=synthetic-secret-marker\n'.padEnd(256, 'x') + 'ustar\n'),
    ]) {
      const copy = scanCopy(text)
      expect(copy.subarray(0, 7).toString('latin1')).toBe('GIF89a\n')
      expect(copy.subarray(7)).toEqual(text)
    }
  })

  it('puts binary content behind the same header: one invalid byte must not hide text', () => {
    const binary = Buffer.from('%PDF-1.7\nTOKEN=synthetic-secret-marker\n\xff', 'latin1')
    expect(scanCopy(binary)).toEqual(Buffer.concat([Buffer.from('GIF89a\n'), binary]))
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
  it('rejects malformed base85 and empty binary blocks as rejected agent output', () => {
    expect(() =>
      assertBinaryPatchLimits(Buffer.from('GIT binary patch\nliteral 1\nA:::::\n\n')),
    ).toThrow(expect.objectContaining({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 }))
    expect(() => assertBinaryPatchLimits(Buffer.from('GIT binary patch\n'))).toThrow(
      expect.objectContaining({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 }),
    )
  })
})
