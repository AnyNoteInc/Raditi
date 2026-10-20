/* global Buffer, console, process */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { pack } from 'tar-stream'

import { importBaseBundle } from '@repo/local-turns'
import { GitWorkspaceService } from '../dist/git-workspace/git-workspace.service.js'
import { runProcess } from '../dist/git-workspace/process.js'
import { SandboxSnapshotTransport } from '@repo/snapshots'

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
const archive = async (files) => {
  const stream = pack()
  for (const [name, content] of Object.entries(files)) stream.entry({ name, mode: 0o644 }, content)
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
  const gitProvider = {
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
  }
  const service = new GitWorkspaceService(gitProvider, {
    transport: { kind: 'local-test', root },
    gitleaksBinary: scanner,
  })
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
  await importBaseBundle(sandbox, await service.buildBaseBundle(source))
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
    credentials: [],
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
    credentials: [],
  })
  candidates.push(retry)
  assert.equal(retry.headSha, candidate.headSha)
  await retry.publish(async () => {})

  // A synthetic, random token-shaped value exists only in memory and must never be printed.
  // One scanner run covers many files; the agent's own ignore file is only content to it.
  const synthetic = 'gh' + 'p_' + randomBytes(18).toString('hex')
  const files = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`pages/${i}.txt`, `page ${i}\n`]),
  )
  files['pages/7.txt'] = `TOKEN=${synthetic} # gitleaks:allow\n`
  files['.gitleaksignore'] = Array.from({ length: 60 }, (_, i) => `${i}:github-pat:1\n`).join('')
  const refusal = async (untracked, using = service) => {
    try {
      candidates.push(
        await using.preparePublication({
          ...metadata,
          patch: Buffer.alloc(0),
          untracked,
          credentials: [],
        }),
      )
    } catch (error) {
      assert(!JSON.stringify(error).includes(synthetic))
      assert(!String(error).includes(synthetic))
      return error
    }
    assert.fail('Real Gitleaks accepted a publication it must refuse')
  }
  const secret = await refusal(await archive(files))
  assert.equal(secret.code, 'PUBLICATION_SECRET', 'Despite an allow comment and ignore file')
  assert.equal(secret.message, 'Publication contains a possible secret')
  // Gitleaks skips a file that starts like a PDF, or has `ustar` at offset 257 like a tar
  // archive: the text is found only behind the host's image header, wherever the agent puts
  // the signature (at 257 in the file, in the copy, or after a one-byte prefix).
  for (const text of [
    `%PDF-1.7\nTOKEN=${synthetic}\n`,
    // One invalid UTF-8 byte: the copy still gets the header.
    Buffer.concat([Buffer.from(`%PDF-1.7\nTOKEN=${synthetic}\n`), Buffer.from([0xff])]),
    ...[257, 257 - 'GIF89a\n'.length, 256].map(
      (offset) => `TOKEN=${synthetic}\n`.padEnd(offset, 'x') + 'ustar\n',
    ),
  ])
    assert.equal(
      (await refusal(await archive({ 'disguised.txt': text }))).code,
      'PUBLICATION_SECRET',
      'Text disguised as an application file must still be scanned',
    )
  // Gitleaks exits 1 on its own errors too, whatever --exit-code says: that is not a finding.
  const brokenConfig = join(root, 'broken-gitleaks.toml')
  await writeFile(brokenConfig, '[extend\n')
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const brokenScanner = join(root, 'gitleaks-broken-config')
  // The last --config wins: every other flag is the service's own.
  await writeFile(
    brokenScanner,
    `#!/bin/sh\nexec ${quote(scanner)} "$@" --config ${quote(brokenConfig)}\n`,
    { mode: 0o700 },
  )
  const broken = await runProcess(
    scanner,
    ['dir', '.', '--config', brokenConfig, '--exit-code=99', '--no-banner', '--log-level=error'],
    { cwd: work, env: { PATH: process.env.PATH, HOME: root } },
  )
  assert.equal(broken.code, 1, 'Gitleaks reports a broken config with exit code 1')
  const failedScan = await refusal(
    await archive({ 'clean.txt': 'nothing secret here\n' }),
    new GitWorkspaceService(gitProvider, {
      transport: { kind: 'local-test', root },
      gitleaksBinary: brokenScanner,
    }),
  )
  assert.equal(failedScan.code, 'GIT_OPERATION_FAILED', 'A failed scan is not a found secret')
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
  'PASS: trusted Docker checkout; agent self-commit captured; fenced local publication; deterministic retry; real Gitleaks 8.30.1 secret rejection in one run over 51 new files and in text disguised as PDF or tar; broken scanner config is a failed scan, not a finding; resources cleaned',
)
