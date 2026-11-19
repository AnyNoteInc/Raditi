import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'

import {
  HIDDEN_FILE_STUB,
  isSnapshotCredential,
  type IssuedGitAccess,
  type TurnBundleSource,
} from '@repo/domain'
import { bundleHead } from '@repo/local-turns'
import { pack } from 'tar-stream'
import { afterEach, describe, expect, it } from 'vitest'

import { directoryBytes } from '../git-worker/disk.ts'
import { startGitWorker, type GitWorkerServer } from '../git-worker/server.ts'
import { emptyUntrackedArchive } from './archive.ts'
import { GitWorkspaceService, type RepoCandidate } from './git-workspace.service.ts'
import { GitWorkerClient, type GitRunner } from './worker-client.ts'

// Real git in a real git worker over its socket (docs/plan/84-projects.md, 84.15а): core's
// service only talks to the worker. The fixture git below is the test's own, not core's.

const execute = promisify(execFile)
const roots: string[] = []
const workers: GitWorkerServer[] = []
const candidates: RepoCandidate[] = []
const fixtureEnv = (cwd: string) => ({
  PATH: process.env.PATH,
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
})
const git = async (cwd: string, ...args: string[]) =>
  (await execute('git', args, { cwd, encoding: 'buffer', env: fixtureEnv(cwd) })).stdout
const gitText = async (cwd: string, ...args: string[]) =>
  (await git(cwd, ...args)).toString().trim()

const anonymous: IssuedGitAccess = {
  auth: { kind: 'anonymous' },
  basic: null,
  expiresAt: new Date(Date.now() + 60_000),
}

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => candidate.dispose()))
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function archive(files: { name: string; content: string | Buffer; mode?: number }[]) {
  const stream = pack()
  for (const file of files)
    stream.entry({ name: file.name, mode: file.mode ?? 0o644 }, file.content)
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}

/** A bare remote with one commit on main, a fake gitleaks and a worker on a fresh volume. */
async function fixture(
  options: { fetchBytes?: number; files?: Record<string, string | Buffer>; gitleaks?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-gitws-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  const files = options.files ?? { 'index.js': 'hello\n', 'delete.txt': 'delete me\n' }
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(work, name, '..'), { recursive: true })
    await writeFile(join(work, name), content)
  }
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'first')
  await git(work, 'commit', '--allow-empty', '-m', 'second')
  await git(work, 'push', remote, 'HEAD:refs/heads/main')
  const baseSha = await gitText(work, 'rev-parse', 'HEAD')
  // Like gitleaks: a finding exits with `--exit-code`, its own error with 1.
  const scanner = join(root, 'scanner.mjs')
  await writeFile(
    scanner,
    `#!${process.execPath}
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const flagged = readdirSync(args[1])
  .filter((name) => readFileSync(join(args[1], name), 'latin1').includes('synthetic-secret-marker'))
  .map((name) => ({ RuleID: 'synthetic', Secret: 'REDACTED', File: join(args[1], name) }))
const report = args[args.indexOf('--report-path') + 1]
if (args.includes('--report-path')) writeFileSync(report, JSON.stringify(flagged))
const finding = Number(args.find((arg) => arg.startsWith('--exit-code='))?.slice(12) ?? 1)
process.exit(flagged.length ? finding : 0)
`,
    { mode: 0o700 },
  )
  const mirrorDir = join(root, 'mirrors')
  await mkdir(mirrorDir, { mode: 0o770 })
  const worker = await startGitWorker({
    root: mirrorDir,
    allowLoopback: false,
    refusedSubnets: [],
    allowFileProtocol: true,
    gitleaksBinary: options.gitleaks ?? scanner,
  })
  workers.push(worker)
  const client = new GitWorkerClient(worker.socket)
  const commands: string[] = []
  const runner: GitRunner = {
    run: (request) => {
      commands.push(`${request.tool} ${request.args[0]}`)
      return client.run(request)
    },
  }
  const service = new GitWorkspaceService({
    runner,
    mirrorDir,
    transport: { kind: 'local-test', root },
    ...(options.fetchBytes ? { fetchBytes: options.fetchBytes } : {}),
  })
  const projectRepositoryId = randomUUID()
  const source = { cloneUrl: remote, access: anonymous }
  const fetchMain = () =>
    service.fetch({ projectRepositoryId, remote: source, branches: ['main'], sizeBytes: null })
  return {
    root,
    remote,
    work,
    baseSha,
    mirrorDir,
    service,
    projectRepositoryId,
    source,
    fetchMain,
    commands,
  }
}

const bytesOf = async (bundle: TurnBundleSource) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of bundle.read()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** The sandbox's side, as importBaseBundle does it: a clone of the bundle on the chat's branch. */
async function checkout(root: string, bundle: TurnBundleSource) {
  const path = join(root, `bundle-${randomBytes(4).toString('hex')}`)
  await writeFile(path, await bytesOf(bundle))
  const work = join(root, `sandbox-${randomBytes(4).toString('hex')}`)
  await git(root, 'clone', '--quiet', '--branch', 'raditi-base', path, work)
  return work
}

const turn = (chatId: string) => ({ chatId, turn: 1, createdAt: '2026-11-16T10:00:00.000Z' })

describe('GitWorkspaceService', { timeout: 60_000 }, () => {
  it('fetches the head of main into the mirror without history or tags', async () => {
    const f = await fixture()
    await git(f.work, 'tag', 'v1')
    await git(f.work, 'push', f.remote, 'v1')
    const heads = await f.fetchMain()
    expect(heads.get('main')).toBe(f.baseSha)
    const mirror = join(f.mirrorDir, 'repos', `${f.projectRepositoryId}.git`)
    expect(await gitText(mirror, 'rev-parse', 'refs/heads/main')).toBe(f.baseSha)
    expect(await gitText(mirror, 'tag')).toBe('')
    // Depth 1: the parent of the head is not in the mirror.
    expect((await readFile(join(mirror, 'shallow'), 'latin1')).trim()).toBe(f.baseSha)
    expect(
      await gitText(mirror, 'rev-list', '--count', 'HEAD^@', '--', '.').catch(() => 'none'),
    ).toBe('none')
    expect(await f.service.hasCommit(f.projectRepositoryId, f.baseSha)).toBe(true)
    // Nothing of the operation is left on the volume.
    expect(await readdir(join(f.mirrorDir, 'ops'))).toEqual([])
    // Every command went to the worker: core ran none itself.
    expect(f.commands).toContain('git fetch')
    expect(f.commands).toContain('git ls-remote')
  })

  it('names a branch the remote lacks as null and fetches nothing for a known head', async () => {
    const f = await fixture()
    await f.fetchMain()
    const before = f.commands.length
    const heads = await f.service.fetch({
      projectRepositoryId: f.projectRepositoryId,
      remote: f.source,
      branches: ['main', 'raditi/chat'],
      sizeBytes: null,
    })
    expect(heads).toEqual(
      new Map([
        ['main', f.baseSha],
        ['raditi/chat', null],
      ]),
    )
    expect(f.commands.slice(before)).not.toContain('git fetch')
  })

  it('refuses a repository the provider names above the limit before any command', async () => {
    const f = await fixture()
    await expect(
      f.service.fetch({
        projectRepositoryId: f.projectRepositoryId,
        remote: f.source,
        branches: ['main'],
        sizeBytes: 2 * 1024 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_TOO_LARGE' })
    expect(f.commands).toEqual([])
  })

  it('refuses a pack above the quota (1 GB in production) and the volume does not grow', async () => {
    // 4 MiB that do not compress, against a quota of 256 KiB in this test.
    const f = await fixture({
      fetchBytes: 256 * 1024,
      files: { 'small.txt': 'small\n', 'big.bin': randomBytes(4 * 1024 * 1024) },
    })
    const before = await directoryBytes(join(f.mirrorDir, 'repos'))
    await expect(f.fetchMain()).rejects.toMatchObject({
      code: 'REPOSITORY_TOO_LARGE',
      httpStatus: 413,
    })
    expect(await directoryBytes(join(f.mirrorDir, 'repos'))).toBeLessThanOrEqual(before + 64 * 1024)
    expect(await readdir(join(f.mirrorDir, 'ops'))).toEqual([])
    expect(await f.service.hasCommit(f.projectRepositoryId, f.baseSha)).toBe(false)
  })

  it('refuses a fetch of another quota of the workspace that is used up', async () => {
    const f = await fixture()
    await expect(
      f.service.fetch({
        projectRepositoryId: f.projectRepositoryId,
        remote: f.source,
        branches: ['main'],
        sizeBytes: null,
        quotaBytes: 0,
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_TOO_LARGE' })
  })

  it('bundles the tree of the base as one root commit without a parent, the same every time', async () => {
    const f = await fixture()
    await f.fetchMain()
    const input = {
      projectRepositoryId: f.projectRepositoryId,
      baseSha: f.baseSha,
      branch: 'raditi/chat-1',
      committedAt: '2026-11-16T10:00:00.000Z',
    }
    const bundle = await f.service.buildBaseBundle(input)
    const bytes = await bytesOf(bundle)
    expect(bundleHead(bytes)).toBe(bundle.sandboxBaseSha)
    expect(bundle.sandboxBaseSha).not.toBe(f.baseSha)
    expect(bundle.sizeBytes).toBe(bytes.byteLength)
    const work = await checkout(f.root, bundle)
    expect(await gitText(work, 'rev-list', '--parents', '-n', '1', 'HEAD')).toBe(
      bundle.sandboxBaseSha,
    )
    expect(await gitText(work, 'rev-parse', 'HEAD^{tree}')).toBe(
      await gitText(f.work, 'rev-parse', `${f.baseSha}^{tree}`),
    )
    const again = await f.service.buildBaseBundle(input)
    expect(again.sandboxBaseSha).toBe(bundle.sandboxBaseSha)
    expect(again.sha256).toBe(bundle.sha256)
    // The second bundle came from the cache: no bundle was created for it.
    expect(f.commands.filter((command) => command === 'git bundle')).toHaveLength(1)
  })

  it('drops the mirror and the bundles of a repository that is gone, and nothing else (ПР20)', async () => {
    const f = await fixture()
    await f.fetchMain()
    await f.service.buildBaseBundle({
      projectRepositoryId: f.projectRepositoryId,
      baseSha: f.baseSha,
      branch: 'raditi/chat-1',
      committedAt: '2026-11-16T10:00:00.000Z',
    })
    const other = randomUUID()
    await f.service.fetch({
      projectRepositoryId: other,
      remote: f.source,
      branches: ['main'],
      sizeBytes: null,
    })
    await f.service.dropMirror(f.projectRepositoryId)
    expect((await readdir(join(f.mirrorDir, 'repos'))).sort()).toEqual([`${other}.git`])
    expect(await readdir(join(f.mirrorDir, 'bundles'))).toEqual([])
    expect(await f.service.hasCommit(other, f.baseSha)).toBe(true)
    expect(await f.service.hasCommit(f.projectRepositoryId, f.baseSha)).toBe(false)
    // A repeat finds nothing and does nothing.
    await f.service.dropMirror(f.projectRepositoryId)
  })

  it('refuses the commit of another project, even one its cache holds', async () => {
    const a = await fixture()
    await a.fetchMain()
    await a.service.buildBaseBundle({
      projectRepositoryId: a.projectRepositoryId,
      baseSha: a.baseSha,
      branch: 'main',
      committedAt: '2026-11-16T10:00:00.000Z',
    })
    const other = randomUUID()
    // Another repository with a mirror of its own on the same volume.
    await a.service.fetch({
      projectRepositoryId: other,
      remote: a.source,
      branches: ['main'],
      sizeBytes: null,
    })
    await git(a.work, 'commit', '--allow-empty', '-m', 'only in the first project')
    await git(a.work, 'push', a.remote, 'HEAD:refs/heads/main')
    const [head] = [await gitText(a.work, 'rev-parse', 'HEAD')]
    await a.fetchMain()
    await expect(
      a.service.buildBaseBundle({
        projectRepositoryId: other,
        baseSha: head,
        branch: 'main',
        committedAt: '2026-11-16T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      a.service.buildBaseBundle({
        projectRepositoryId: randomUUID(),
        baseSha: a.baseSha,
        branch: 'main',
        committedAt: '2026-11-16T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('never follows a link of the repository: no file of its target is read or written', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside-secret.txt')
    await writeFile(outside, 'outside-marker-7d1c\n')
    await symlink(outside, join(f.work, 'link'))
    await symlink('../../../../../../etc', join(f.work, 'up'))
    await git(f.work, 'add', 'link', 'up')
    await git(f.work, 'commit', '-m', 'links')
    await git(f.work, 'push', f.remote, 'HEAD:refs/heads/main')
    const head = await gitText(f.work, 'rev-parse', 'HEAD')
    await f.fetchMain()
    const bundle = await f.service.buildBaseBundle({
      projectRepositoryId: f.projectRepositoryId,
      baseSha: head,
      branch: 'main',
      committedAt: '2026-11-16T10:00:00.000Z',
    })
    expect((await bytesOf(bundle)).includes('outside-marker-7d1c')).toBe(false)
    expect(await readFile(outside, 'utf8')).toBe('outside-marker-7d1c\n')
    // The links stay entries of the tree (mode 120000); no path of them exists on the volume.
    const work = await checkout(f.root, bundle)
    expect(await gitText(work, 'ls-tree', 'HEAD', 'link', 'up')).toMatch(
      /^120000 blob .*\tlink\n120000 blob .*\tup$/,
    )
    const names: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        names.push(entry.name)
        if (entry.isDirectory()) await walk(join(dir, entry.name))
      }
    }
    await walk(f.mirrorDir)
    expect(names).not.toContain('link')
    expect(names).not.toContain('up')
  })

  describe('publication', () => {
    async function candidateOf(
      f: Awaited<ReturnType<typeof fixture>>,
      change: (work: string) => Promise<void>,
      extra: {
        untracked?: Uint8Array
        credentials?: string[]
        refusedValues?: string[]
        expectedRef?: string | null
      } = {},
    ) {
      await f.fetchMain()
      const bundle = await f.service.buildBaseBundle({
        projectRepositoryId: f.projectRepositoryId,
        baseSha: f.baseSha,
        branch: 'raditi/chat',
        committedAt: '2026-11-16T10:00:00.000Z',
      })
      const work = await checkout(f.root, bundle)
      await change(work)
      const patch = await git(
        work,
        'diff',
        '--binary',
        '--full-index',
        '--no-renames',
        bundle.sandboxBaseSha,
      )
      const chatId = randomUUID()
      const candidate = await f.service.preparePublication({
        projectRepositoryId: f.projectRepositoryId,
        baseSha: f.baseSha,
        ...turn(chatId),
        expectedRef: extra.expectedRef ?? null,
        patch,
        untracked: extra.untracked ?? emptyUntrackedArchive(),
        credentials: extra.credentials ?? [],
        ...(extra.refusedValues ? { refusedValues: extra.refusedValues } : {}),
      })
      candidates.push(candidate)
      return { candidate, chatId }
    }

    it('commits the patch and new files on the real base and publishes the chat ref by CAS', async () => {
      const f = await fixture()
      const { candidate, chatId } = await candidateOf(
        f,
        async (work) => {
          await writeFile(join(work, 'index.js'), 'hello, world\n')
          await rm(join(work, 'delete.txt'))
        },
        { untracked: await archive([{ name: 'src/new.js', content: 'new\n' }]) },
      )
      expect(candidate.baseSha).toBe(f.baseSha)
      expect(candidate.buildPaths).toEqual([])
      expect(Buffer.from(candidate.patch).toString()).toContain('+new')
      expect(await f.service.readChatRef(f.projectRepositoryId, chatId)).toBeNull()
      let fenced = 0
      await candidate.publish(async () => {
        fenced++
      })
      expect(fenced).toBe(1)
      expect(await f.service.readChatRef(f.projectRepositoryId, chatId)).toBe(candidate.headSha)
      const mirror = join(f.mirrorDir, 'repos', `${f.projectRepositoryId}.git`)
      expect(await gitText(mirror, 'rev-parse', `${candidate.headSha}^`)).toBe(f.baseSha)
      expect(await gitText(mirror, 'show', `${candidate.headSha}:src/new.js`)).toBe('new')
      expect(await gitText(mirror, 'show', `${candidate.headSha}:index.js`)).toBe('hello, world')
      // Again: already there, no fence and no change.
      await candidate.publish(async () => {
        fenced++
      })
      expect(fenced).toBe(1)
      expect(
        f.commands.filter(
          (command) => !command.startsWith('git ') && !command.startsWith('gitleaks '),
        ),
      ).toEqual([])
    })

    it('refuses a publication whose chat ref moved, before the fence', async () => {
      const f = await fixture()
      const { candidate } = await candidateOf(
        f,
        async (work) => writeFile(join(work, 'index.js'), 'changed\n'),
        { expectedRef: 'b'.repeat(40) },
      )
      let fenced = false
      await expect(
        candidate.publish(async () => {
          fenced = true
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(fenced).toBe(false)
    })

    it('marks paths of the build instead of refusing them', async () => {
      const f = await fixture()
      const { candidate } = await candidateOf(f, async () => {}, {
        untracked: await archive([
          { name: '.gitlab-ci.yml', content: 'test: { script: [true] }\n' },
        ]),
      })
      expect(candidate.buildPaths).toEqual(['.gitlab-ci.yml'])
    })

    it('publishes nothing that holds a secret, a credential or a value of a variable', async () => {
      const f = await fixture()
      await expect(
        candidateOf(f, async (work) =>
          writeFile(join(work, 'index.js'), 'synthetic-secret-marker\n'),
        ),
      ).rejects.toMatchObject({ code: 'PUBLICATION_SECRET' })
      await expect(
        candidateOf(f, async (work) => writeFile(join(work, 'index.js'), 'key=turn-key-123456\n'), {
          credentials: ['turn-key-123456'],
        }),
      ).rejects.toSatisfy(isSnapshotCredential)
      await expect(
        candidateOf(
          f,
          async (work) => writeFile(join(work, 'index.js'), 'db=value-of-a-variable\n'),
          {
            refusedValues: ['value-of-a-variable'],
          },
        ),
      ).rejects.toMatchObject({ code: 'PUBLICATION_SECRET' })
      expect(await readdir(join(f.mirrorDir, 'ops'))).toEqual([])
    })

    // The real scanner, when the machine has it (P2_GITLEAKS_BINARY, gitleaks 8.30.1).
    it.runIf(Boolean(process.env.P2_GITLEAKS_BINARY))(
      'finds a token with the real gitleaks over the copies of the changed files',
      async () => {
        const f = await fixture({ gitleaks: process.env.P2_GITLEAKS_BINARY! })
        // A synthetic GitHub token: the shape gitleaks knows, never a real one.
        const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'.slice(0, 36)}`
        await expect(
          candidateOf(f, async (work) =>
            writeFile(join(work, 'index.js'), `const t = '${token}'\n`),
          ),
        ).rejects.toMatchObject({ code: 'PUBLICATION_SECRET' })
        const { candidate } = await candidateOf(f, async (work) =>
          writeFile(join(work, 'index.js'), 'const t = 1\n'),
        )
        expect(candidate.headSha).toMatch(/^[a-f0-9]{40}$/)
      },
    )

    it('refuses a link and a change of .git from the agent', async () => {
      const f = await fixture()
      await expect(
        candidateOf(f, async (work) => {
          await symlink('/etc/passwd', join(work, 'passwd'))
          await git(work, 'add', '--intent-to-add', 'passwd')
        }),
      ).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
      await expect(
        candidateOf(f, async () => {}, {
          untracked: await archive([{ name: '.git/config', content: 'x' }]),
        }),
      ).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
    })

    describe('findSecrets', () => {
      it('names the files that look like a secret, paths only, and leaves the mirror as it was', async () => {
        const f = await fixture({
          files: {
            'index.js': 'hello\n',
            'config/prod.env': 'TOKEN=synthetic-secret-marker\n',
            'docs/readme.md': 'nothing here\n',
            'src/keys.ts': 'export const k = "synthetic-secret-marker"\n',
            'src/clean.ts': 'export const x = 1\n',
          },
        })
        await f.fetchMain()
        expect(await f.service.findSecrets(f.projectRepositoryId, f.baseSha)).toEqual([
          'config/prod.env',
          'src/keys.ts',
        ])
        expect(await readdir(join(f.mirrorDir, 'ops'))).toEqual([])
        expect(await f.service.findSecrets(f.projectRepositoryId, f.baseSha, 1)).toHaveLength(1)
      })

      it('scans the whole tree once and reads only the file names of the report (19.11.2026)', async () => {
        const files: Record<string, string> = { 'index.js': 'hello\n' }
        for (let i = 0; i < 30; i++)
          files[`test/fixture-${String(i).padStart(2, '0')}.ts`] =
            i % 3 === 0 ? 'export const k = "synthetic-secret-marker"\n' : `export const n = ${i}\n`
        const f = await fixture({ files })
        await f.fetchMain()
        f.commands.length = 0
        const found = await f.service.hiddenFiles(f.projectRepositoryId, f.baseSha)
        expect(found).toEqual(
          Array.from({ length: 10 }, (_, i) => `test/fixture-${String(i * 3).padStart(2, '0')}.ts`),
        )
        // Halving the tree took a scan per half: one now, whatever the number of findings.
        expect(f.commands.filter((command) => command.startsWith('gitleaks '))).toHaveLength(1)
        expect(await readdir(join(f.mirrorDir, 'ops'))).toEqual([])
      })

      it('fails on a report that names no copy of the scan, and on a finding without a report', async () => {
        for (const body of [
          "writeFileSync(report, JSON.stringify([{ File: '/etc/passwd' }]))",
          "writeFileSync(report, JSON.stringify([{ File: join(args[1], '99999') }]))",
          "writeFileSync(report, '[]')",
          "writeFileSync(report, 'not json')",
          '',
        ]) {
          const root = await mkdtemp(join(tmpdir(), 'raditi-gitws-scanner-'))
          roots.push(root)
          const scanner = join(root, 'scanner.mjs')
          await writeFile(
            scanner,
            `#!${process.execPath}
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const report = args[args.indexOf('--report-path') + 1]
${body}
process.exit(99)
`,
            { mode: 0o700 },
          )
          const f = await fixture({ gitleaks: scanner })
          await f.fetchMain()
          await expect(
            f.service.findSecrets(f.projectRepositoryId, f.baseSha),
          ).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
        }
      })

      // The real scanner, when the machine has it (P2_GITLEAKS_BINARY, gitleaks 8.30.1).
      it.runIf(Boolean(process.env.P2_GITLEAKS_BINARY))(
        'names the files the real gitleaks flags from its report',
        async () => {
          // Synthetic GitHub tokens: the shape and entropy gitleaks knows, never a real one.
          const tokens = {
            a: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
            b: 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2',
          }
          const token = (c: 'a' | 'b') => `ghp_${tokens[c]}`
          const f = await fixture({
            gitleaks: process.env.P2_GITLEAKS_BINARY!,
            files: {
              'index.js': 'hello\n',
              'a/one.ts': `const t = '${token('a')}'\n`,
              'b/two.ts': `const t = '${token('b')}'\n`,
              'b/clean.ts': 'const t = 1\n',
            },
          })
          await f.fetchMain()
          expect(await f.service.findSecrets(f.projectRepositoryId, f.baseSha)).toEqual([
            'a/one.ts',
            'b/two.ts',
          ])
        },
      )

      it('a clean tree has none; a commit of another repository is refused', async () => {
        const f = await fixture()
        await f.fetchMain()
        expect(await f.service.findSecrets(f.projectRepositoryId, f.baseSha)).toEqual([])
        await expect(f.service.findSecrets(randomUUID(), f.baseSha)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
      })
    })

    // docs/plan/84-projects.md, ПР35 (slice 84.18).
    describe('hidden files', () => {
      it('hides files named like a secret and those gitleaks flags', async () => {
        const f = await fixture({
          files: {
            'index.js': 'hello\n',
            '.env': 'A=1\n',
            'deploy/server.pem': 'cert\n',
            'src/keys.ts': 'export const k = "synthetic-secret-marker"\n',
          },
        })
        await f.fetchMain()
        expect(await f.service.hiddenFiles(f.projectRepositoryId, f.baseSha)).toEqual([
          '.env',
          'deploy/server.pem',
          'src/keys.ts',
        ])
      })

      it('stubs them in the sandbox tree and refuses a change of one', async () => {
        const f = await fixture({ files: { 'index.js': 'hello\n', '.env': 'A=1\n' } })
        await f.fetchMain()
        const bundle = await f.service.buildBaseBundle({
          projectRepositoryId: f.projectRepositoryId,
          baseSha: f.baseSha,
          branch: 'raditi/chat-1',
          committedAt: '2000-01-01T00:00:00.000Z',
          hiddenPaths: ['.env', 'missing.key'],
        })
        const work = await checkout(f.root, bundle)
        expect(await readFile(join(work, '.env'), 'utf8')).toBe(HIDDEN_FILE_STUB)
        // The same tree and time give the same commit: the bundle comes from the cache.
        const again = await f.service.buildBaseBundle({
          projectRepositoryId: f.projectRepositoryId,
          baseSha: f.baseSha,
          branch: 'raditi/chat-2',
          committedAt: '2000-01-01T00:00:00.000Z',
          hiddenPaths: ['.env'],
        })
        expect(again.sandboxBaseSha).toBe(bundle.sandboxBaseSha)
        const changed = async (edit: (work: string) => Promise<void>, untracked?: Uint8Array) => {
          await edit(work)
          const patch = await git(work, 'diff', '--binary', '--no-renames', bundle.sandboxBaseSha)
          const candidate = f.service.preparePublication({
            projectRepositoryId: f.projectRepositoryId,
            baseSha: f.baseSha,
            ...turn(randomUUID()),
            expectedRef: null,
            patch,
            untracked: untracked ?? emptyUntrackedArchive(),
            credentials: [],
            hiddenPaths: ['.env'],
          })
          await git(work, 'checkout', '--', '.')
          return candidate
        }
        await expect(
          changed(async (w) => writeFile(join(w, '.env'), 'B=2\n')),
        ).rejects.toMatchObject({ code: 'PUBLICATION_FORBIDDEN' })
        await expect(changed(async (w) => rm(join(w, '.env')))).rejects.toMatchObject({
          code: 'PUBLICATION_FORBIDDEN',
        })
        // A change of another file lands on the real base: the hidden file keeps its value there.
        const kept = await changed(async (w) => writeFile(join(w, 'index.js'), 'changed\n'))
        candidates.push(kept)
        expect(Buffer.from(kept.patch).toString()).not.toContain('.env')
      })
    })
  })

  it('removes the mirror and bundles of a repository no project has, and keeps the rest (ревью C3)', async () => {
    const f = await fixture()
    await f.fetchMain()
    await f.service.buildBaseBundle({
      projectRepositoryId: f.projectRepositoryId,
      baseSha: f.baseSha,
      branch: 'raditi/chat',
      committedAt: '2026-11-16T10:00:00.000Z',
    })
    const mirror = join(f.mirrorDir, 'repos', `${f.projectRepositoryId}.git`)
    const bundles = join(f.mirrorDir, 'bundles', f.projectRepositoryId)
    expect(await f.service.removeOrphans(async (ids) => new Set(ids))).toBe(0)
    expect((await readdir(bundles)).length).toBeGreaterThan(0)
    let asked: readonly string[] = []
    expect(
      await f.service.removeOrphans(async (ids) => {
        asked = ids
        return new Set()
      }),
    ).toBe(1)
    expect(asked).toEqual([f.projectRepositoryId])
    await expect(readdir(mirror)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(bundles)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // docs/plan/84-projects.md, ПР16 (slice 84.20).
  describe('buildSettingsChange', () => {
    it('names the changed build paths, their diff and the configuration at the head', async () => {
      const f = await fixture({
        files: { 'index.js': 'hello\n', '.gitlab-ci.yml': 'lint:\n  script: a\n' },
      })
      await f.fetchMain()
      await writeFile(join(f.work, '.gitlab-ci.yml'), 'lint:\n  script: b\n')
      await writeFile(join(f.work, 'CODEOWNERS'), '* @team\n')
      await writeFile(join(f.work, 'index.js'), 'changed\n')
      await git(f.work, 'add', '.')
      await git(f.work, 'commit', '-m', 'third')
      await git(f.work, 'push', f.remote, 'HEAD:refs/heads/main')
      const head = await gitText(f.work, 'rev-parse', 'HEAD')
      await f.fetchMain()
      const isBuildPath = (path: string) => path === '.gitlab-ci.yml' || path === 'CODEOWNERS'
      const change = await f.service.buildSettingsChange({
        projectRepositoryId: f.projectRepositoryId,
        from: f.baseSha,
        to: head,
        isBuildPath,
        maxBytes: 1024 * 1024,
        configPath: '.gitlab-ci.yml',
      })
      expect(change.paths).toEqual(['.gitlab-ci.yml', 'CODEOWNERS'])
      const patch = change.patch!.toString()
      expect(patch).toContain('+  script: b')
      expect(patch).toContain('+* @team')
      expect(patch).not.toContain('index.js')
      expect(change.config!.toString()).toBe('lint:\n  script: b\n')
      // Above the limit the diff is not given at all; no build path — an empty diff.
      const big = await f.service.buildSettingsChange({
        projectRepositoryId: f.projectRepositoryId,
        from: f.baseSha,
        to: head,
        isBuildPath,
        maxBytes: 16,
      })
      expect(big.patch).toBeNull()
      const none = await f.service.buildSettingsChange({
        projectRepositoryId: f.projectRepositoryId,
        from: f.baseSha,
        to: head,
        isBuildPath: () => false,
        maxBytes: 1024,
        configPath: 'missing.yml',
      })
      expect(none).toEqual({ paths: [], patch: Buffer.alloc(0), config: null })
      await expect(
        f.service.buildSettingsChange({
          projectRepositoryId: randomUUID(),
          from: f.baseSha,
          to: head,
          isBuildPath,
          maxBytes: 1024,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(await readdir(join(f.mirrorDir, 'ops'))).toEqual([])
    })
  })
})
