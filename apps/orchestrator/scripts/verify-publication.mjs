/* global Buffer, console, process */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { pack } from 'tar-stream'

import { GitWorkspaceService } from '../dist/git-workspace/git-workspace.service.js'
import { runProcess } from '../dist/git-workspace/process.js'
import { SandboxSnapshotTransport } from '../dist/sessions/sandbox-snapshot.js'

// Explicit local integration: temporary local Git remote, isolated Docker container,
// real pinned scanner, synthetic content only. Never publishes to an external Git server.
assert.equal(process.env.NODE_ENV, 'test')
assert.notEqual(process.env.APP_ENV, 'production')
const scanner = process.env.P2_GITLEAKS_BINARY
const image = process.env.P2_SANDBOX_IMAGE
assert(scanner && isAbsolute(scanner), 'P2_GITLEAKS_BINARY must be an absolute executable path')
assert(
  image && /^[^\s]+@sha256:[a-f0-9]{64}$/.test(image),
  'P2_SANDBOX_IMAGE must be a repository pinned by digest',
)

const root = await mkdtemp(join(tmpdir(), 'raditi-publication-verify-'))
const candidates = []
const failures = []
let sandbox
const command = async (binary, argv, options = {}) => {
  const result = await runProcess(binary, argv, { cwd: root, env: process.env, ...options })
  assert.equal(result.code, 0, `${binary} fixture command failed`)
  return result.stdout
}
const git = (cwd, ...argv) =>
  command('git', argv, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Publication fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Publication fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  })
const archive = async (content) => {
  const stream = pack()
  stream.entry({ name: 'new.txt', mode: 0o644 }, content)
  stream.finalize()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return zstdCompressSync(Buffer.concat(chunks))
}

try {
  assert.equal(
    (await command(scanner, ['version'])).toString().trim(),
    '8.30.1',
    'Use the verified Gitleaks 8.30.1 release',
  )
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'init', '--initial-branch=main', work)
  await writeFile(join(work, 'index.php'), 'hello\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'fixture')
  await git(work, 'push', remote, 'HEAD:main')
  const baseSha = (await git(work, 'rev-parse', 'HEAD')).toString().trim()
  const repo = { provider: 'gitea', owner: 'fixture', name: 'site' }
  const service = new GitWorkspaceService(
    {
      kind: 'gitea',
      getRepository: async () => ({
        ref: repo,
        cloneUrl: remote,
        defaultBranch: 'main',
        private: true,
      }),
      issueCredentials: async () => {
        throw new Error('Local fixtures must not request credentials')
      },
    },
    { transport: { kind: 'local-test', root }, gitleaksBinary: scanner },
  )
  const source = { repo, branch: 'agent/task1', expectedBaseSha: baseSha, protectedPaths: [] }
  const metadata = { ...source, taskId: 'task1', turn: 1, createdAt: '2026-09-26T19:00:00.000Z' }

  const provider = createDockerSandboxProvider({
    runtime: 'runc',
    socketPath: process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock',
  })
  const unique = randomBytes(8).toString('hex')
  sandbox = await provider.create({
    image,
    labels: {
      workspaceId: 'publication-verify',
      siteId: unique,
      taskId: unique,
      sessionId: unique,
      turn: 1,
      leaseEpoch: 1,
    },
    runtime: 'runc',
    resources: { cpu: 1, memoryMiB: 1024, pids: 128 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'none' },
    hardTimeoutMs: 120_000,
  })
  const exec = async (argv) => {
    const handle = await sandbox.exec({ argv, timeoutMs: 15_000 })
    const chunks = []
    for await (const chunk of handle.output())
      if (chunk.stream === 'stdout') chunks.push(Buffer.from(chunk.data))
    assert.deepEqual(await handle.wait(), { code: 0, reason: 'exited' })
    return Buffer.concat(chunks)
  }
  await service.prepareWorkspace(sandbox, source)
  assert.equal(
    (await exec(['git', '-C', '/workspace/repo', 'rev-parse', 'HEAD'])).toString().trim(),
    baseSha,
  )
  assert.equal((await exec(['git', '-C', '/workspace/repo', 'remote'])).toString().trim(), '')

  // The agent commits locally. Capturing against HEAD would silently lose every change.
  await exec([
    'node',
    '-e',
    "const fs=require('fs');fs.writeFileSync('/workspace/repo/index.php','updated by self-commit\\n');fs.writeFileSync('/workspace/repo/new.txt','new file\\n')",
  ])
  await exec(['git', '-C', '/workspace/repo', 'add', '.'])
  await exec([
    'git',
    '-C',
    '/workspace/repo',
    '-c',
    'user.name=Agent fixture',
    '-c',
    'user.email=agent@example.test',
    'commit',
    '-m',
    'untrusted self commit',
  ])
  const transport = new SandboxSnapshotTransport()
  await exec(['mkdir', '--parents', '/agent-home/fixture'])
  await sandbox.quiesce()
  const captured = await transport.capture(
    sandbox,
    { root: '/agent-home/fixture', include: ['session'], exclude: [] },
    baseSha,
  )
  assert(Buffer.from(captured.patch).toString().includes('new.txt'))
  const candidate = await service.preparePublication({
    ...metadata,
    patch: captured.patch,
    untracked: captured.untracked,
  })
  candidates.push(candidate)
  assert(!(await git(remote, 'show-ref', '--heads')).toString().includes('agent/task1'))
  const sandboxId = sandbox.id
  await sandbox.destroy('completed')
  sandbox = undefined
  assert.equal(await provider.get(sandboxId), null)
  await candidate.publish(async () => {})
  assert.equal(
    (await git(remote, 'show', `${candidate.headSha}:index.php`)).toString(),
    'updated by self-commit\n',
  )
  assert.equal((await git(remote, 'show', `${candidate.headSha}:new.txt`)).toString(), 'new file\n')
  const retry = await service.preparePublication({
    ...metadata,
    patch: candidate.patch,
    untracked: candidate.untracked,
  })
  candidates.push(retry)
  assert.equal(retry.headSha, candidate.headSha)
  await retry.publish(async () => {})

  // A synthetic, random token-shaped value exists only in memory and must never be printed.
  const synthetic = 'gh' + 'p_' + randomBytes(18).toString('hex')
  let blocked = false
  try {
    const unexpected = await service.preparePublication({
      ...metadata,
      patch: Buffer.alloc(0),
      untracked: await archive(`TOKEN=${synthetic} # gitleaks:allow\n`),
    })
    candidates.push(unexpected)
  } catch (error) {
    assert.equal(error.code, 'FORBIDDEN')
    assert.equal(error.message, 'Publication contains a possible secret')
    assert(!JSON.stringify(error).includes(synthetic))
    blocked = true
  }
  assert(blocked, 'Real Gitleaks must reject the synthetic token despite an allow comment')
} catch (error) {
  failures.push(error)
} finally {
  const cleanup = await Promise.allSettled([
    ...candidates.map((candidate) => candidate.dispose()),
    ...(sandbox ? [sandbox.destroy('failed')] : []),
  ])
  cleanup.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])))
  if (cleanup.some((result) => result.status === 'rejected'))
    failures.push(new Error('Publication fixture cleanup was incomplete'))
}
if (failures.length) throw new AggregateError(failures, 'Publication verification failed')
console.log(
  'PASS: trusted Docker checkout; agent self-commit captured; fenced local publication; deterministic retry; real Gitleaks 8.30.1 secret rejection; resources cleaned',
)
