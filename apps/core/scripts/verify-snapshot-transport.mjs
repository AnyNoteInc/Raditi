/* global Buffer, console, process */
// Local verification on the real P2 exec path: Docker provider (runc, network none), the
// runtime image, uid 10001 and a read-only rootfs; bytes move only through exec, never docker cp.
// Usage: P2_SANDBOX_IMAGE=<repository@sha256:…> pnpm --filter core verify:transport
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

import { createDockerSandboxProvider } from '@repo/sandbox-providers'

import { SandboxSnapshotTransport } from '@repo/snapshots'
import { sampleDriverId } from '../src/testing/ids.ts'

assert.notEqual(process.env.APP_ENV, 'production')
const image = process.env.P2_SANDBOX_IMAGE
assert(
  image && /^[^\s]+@sha256:[a-f0-9]{64}$/.test(image),
  'P2_SANDBOX_IMAGE must be a repository pinned by digest',
)
const provider = createDockerSandboxProvider({
  runtime: 'runc',
  socketPath: process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock',
})
const created = []
const metrics = {
  commands: 0,
  tarExtractCommands: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdinBytes: 0,
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Counts commands and bytes around the provider's own exec; it does not change the transfer.
function counted(sandbox) {
  return {
    id: sandbox.id,
    labels: sandbox.labels,
    async exec(spec) {
      metrics.commands += 1
      if (spec.argv[0] === 'tar' && spec.argv.includes('--extract')) metrics.tarExtractCommands += 1
      const stdin =
        spec.stdin &&
        (async function* () {
          for await (const bytes of spec.stdin) {
            metrics.stdinBytes += bytes.byteLength
            yield bytes
          }
        })()
      const handle = await sandbox.exec({ ...spec, stdin })
      return {
        id: handle.id,
        async *output() {
          for await (const chunk of handle.output()) {
            metrics[`${chunk.stream}Bytes`] += chunk.data.byteLength
            yield chunk
          }
        },
        wait: () => handle.wait(),
        kill: (signal) => handle.kill(signal),
      }
    },
  }
}

async function run(sandbox, argv, { cwd, env, bytes, codes = [0] } = {}) {
  const stdin =
    bytes === undefined
      ? undefined
      : (async function* () {
          yield bytes
        })()
  const handle = await sandbox.exec({ argv, cwd, env, stdin, timeoutMs: 60_000 })
  const stdout = []
  const stderr = []
  const consume = (async () => {
    for await (const chunk of handle.output()) {
      ;(chunk.stream === 'stdout' ? stdout : stderr).push(chunk.data)
    }
  })()
  const [exit] = await Promise.all([handle.wait(), consume])
  assert.equal(exit.reason, 'exited')
  assert.ok(
    codes.includes(exit.code),
    `${argv.join(' ')} failed: ${Buffer.concat(stderr).toString()}`,
  )
  return { bytes: Buffer.concat(stdout), code: exit.code }
}
const repository = '/workspace/repo'
const home = `/agent-home/${sampleDriverId}`
// The session state the sample driver names: its session database and the journal of it. The
// CLI keeps its key store and its logs in the same directory, and its configuration beside it.
const data = `${home}/.local/share/opencode`
const sessionFiles = ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal']
const git = (sandbox, ...args) => run(sandbox, ['git', ...args], { cwd: repository })
async function write(sandbox, path, bytes) {
  await run(sandbox, ['mkdir', '-p', '--', path.slice(0, path.lastIndexOf('/'))])
  await run(sandbox, ['dd', `of=${path}`, 'status=none'], { bytes })
}
async function read(sandbox, path) {
  return (await run(sandbox, ['cat', '--', path])).bytes
}
async function absent(sandbox, path) {
  assert.equal((await run(sandbox, ['test', '-e', path], { codes: [0, 1] })).code, 1, path)
}
async function create(suffix) {
  const unique = randomBytes(8).toString('hex')
  const sandbox = await provider.create({
    image,
    labels: {
      workspaceId: 'transport-verify',
      siteId: unique,
      taskId: unique,
      sessionId: `${suffix}-${unique}`,
      turn: 1,
      leaseEpoch: 1,
    },
    runtime: 'runc',
    resources: { cpu: 1, memoryMiB: 1024, pids: 128 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'none' },
    hardTimeoutMs: 300_000,
  })
  created.push(sandbox)
  return counted(sandbox)
}

try {
  const a = await create('capture')
  const b = await create('restore')
  const baseText = Buffer.from('synthetic base\n', 'utf8')
  const changedText = Buffer.from('synthetic changed\nЮникод preserved\n', 'utf8')
  const baseBinary = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
  const changedBinary = Buffer.from(baseBinary)
  changedBinary.fill(0xff, 101, 239)
  const executable = Buffer.from('#!/bin/sh\nprintf synthetic\\n\n')
  for (const sandbox of [a, b]) {
    assert.equal((await run(sandbox, ['id', '-u'])).bytes.toString().trim(), '10001')
    assert.notEqual((await run(sandbox, ['touch', '/rootfs-probe'], { codes: [1] })).code, 0)
  }
  await run(a, ['mkdir', '-p', repository])
  await git(a, 'init', '-b', 'main')
  await git(a, 'config', 'user.name', 'Synthetic Transport Fixture')
  await git(a, 'config', 'user.email', 'fixture@example.invalid')
  await write(a, `${repository}/tracked.txt`, baseText)
  await write(a, `${repository}/tracked.bin`, baseBinary)
  await write(a, `${repository}/deleted.txt`, Buffer.from('will be deleted\n'))
  await write(a, `${repository}/script.sh`, executable)
  await run(a, ['chmod', '755', `${repository}/script.sh`])
  await write(a, `${repository}/.gitignore`, Buffer.from('ignored.tmp\n'))
  await git(a, 'add', '--all')
  await run(a, ['git', 'commit', '-m', 'Synthetic base'], {
    cwd: repository,
    env: { GIT_AUTHOR_DATE: '2026-09-26T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-26T00:00:00Z' },
  })
  const head = (await git(a, 'rev-parse', 'HEAD')).bytes.toString().trim()
  await git(a, 'bundle', 'create', '/workspace/base.bundle', 'HEAD', 'main')
  await write(b, '/workspace/base.bundle', await read(a, '/workspace/base.bundle'))
  await run(b, ['git', 'clone', '--branch', 'main', '/workspace/base.bundle', repository])
  assert.equal((await git(b, 'rev-parse', 'HEAD')).bytes.toString().trim(), head)
  assert.deepEqual((await git(b, 'status', '--porcelain')).bytes, Buffer.alloc(0))

  await write(a, `${repository}/tracked.txt`, changedText)
  await write(a, `${repository}/tracked.bin`, changedBinary)
  await run(a, ['rm', '--', `${repository}/deleted.txt`])
  const untracked = new Map([
    ['new dir/данные.bin', Buffer.from([0, 1, 2, 255, 128, 10, 13, 0])],
    ['new dir/notes.txt', Buffer.from('untracked UTF-8: привет\n')],
    ['empty.txt', Buffer.alloc(0)],
  ])
  for (const [name, bytes] of untracked) await write(a, `${repository}/${name}`, bytes)
  await write(a, `${repository}/ignored.tmp`, Buffer.from('ignored synthetic file'))
  // Binary, as a database is: a NUL, bytes that are no UTF-8, a line break inside.
  const session = new Map([
    [
      sessionFiles[0],
      Buffer.concat([
        Buffer.from('SQLite format 3\0'),
        Buffer.from([0, 1, 2, 255, 128, 10, 13, 0]),
        Buffer.from('synthetic session: привет\n'),
      ]),
    ],
    [sessionFiles[1], Buffer.from([0x37, 0x7f, 0x06, 0x82, 0, 0, 16, 0, 255, 10, 0])],
  ])
  for (const [name, bytes] of session) await write(a, `${home}/${name}`, bytes)
  await write(a, `${data}/auth.json`, Buffer.from('{"synthetic":true}'))
  await write(a, `${data}/log/synthetic.log`, Buffer.from('synthetic log\n'))
  await write(a, `${home}/.config/opencode/opencode.json`, Buffer.from('{"synthetic":true}'))

  const state = { root: home, include: sessionFiles, exclude: [] }
  const transport = new SandboxSnapshotTransport()
  // As in a turn: agent processes are stopped before capture.
  await created[0].quiesce()
  const parts = await transport.capture(a, state, head)
  const expectedPatch = (
    await git(
      a,
      '-c',
      'core.fsmonitor=false',
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
    )
  ).bytes
  assert.ok(parts.patch.byteLength > 0)
  assert.deepEqual(Buffer.from(parts.patch), expectedPatch)
  assert.match(expectedPatch.toString(), /GIT binary patch/)
  // Existing directories are legitimate; only existing files must be rejected.
  await run(b, ['mkdir', '-p', data, `${repository}/new dir`])
  await transport.restore(b, state, parts)

  // P1 restore moves home/untracked only. The trusted P2 patch application remains
  // a distinct operation, explicitly exercised here using synthetic fixture bytes.
  assert.deepEqual(await read(b, `${repository}/tracked.txt`), baseText)
  assert.deepEqual(await read(b, `${repository}/tracked.bin`), baseBinary)
  for (const [name, bytes] of session) assert.deepEqual(await read(b, `${home}/${name}`), bytes)
  for (const [name, bytes] of untracked)
    assert.deepEqual(await read(b, `${repository}/${name}`), bytes)
  await absent(b, `${data}/auth.json`)
  await absent(b, `${data}/log`)
  await absent(b, `${home}/.config`)
  await absent(b, `${repository}/ignored.tmp`)

  // Refuse overwriting existing files, even if a repeated archive has the same bytes.
  // A sentinel differing from archive contents makes non-overwrite observable.
  const sentinel = Buffer.from('existing session must remain intact\n')
  await write(b, `${home}/${sessionFiles[0]}`, sentinel)
  await assert.rejects(transport.restore(b, state, parts), { code: 'SANDBOX_COMMAND_FAILED' })
  assert.deepEqual(await read(b, `${home}/${sessionFiles[0]}`), sentinel)
  for (const [name, bytes] of untracked)
    assert.deepEqual(await read(b, `${repository}/${name}`), bytes)
  assert.deepEqual(await read(b, `${repository}/tracked.txt`), baseText)
  await write(b, `${home}/${sessionFiles[0]}`, session.get(sessionFiles[0]))

  // An absolute destination symlink must be refused before any tar extraction.
  await run(b, ['ln', '-s', '/workspace/repo', `${data}/absolute-link`])
  const extractCount = metrics.tarExtractCommands
  await assert.rejects(transport.restore(b, state, parts), { code: 'SANDBOX_COMMAND_FAILED' })
  assert.equal(metrics.tarExtractCommands, extractCount)
  for (const [name, bytes] of session) assert.deepEqual(await read(b, `${home}/${name}`), bytes)
  await run(b, ['rm', '--', `${data}/absolute-link`])

  await run(b, ['git', 'apply', '--binary', '-'], { cwd: repository, bytes: parts.patch })
  assert.deepEqual(await read(b, `${repository}/tracked.txt`), changedText)
  assert.deepEqual(await read(b, `${repository}/tracked.bin`), changedBinary)
  assert.deepEqual(await read(b, `${repository}/script.sh`), executable)
  assert.equal(
    (await run(b, ['stat', '-c', '%a', `${repository}/script.sh`])).bytes.toString().trim(),
    '755',
  )
  await absent(b, `${repository}/deleted.txt`)
  assert.equal((await git(b, 'rev-parse', 'HEAD')).bytes.toString().trim(), head)
  assert.deepEqual(
    (
      await git(
        b,
        '-c',
        'core.fsmonitor=false',
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--',
      )
    ).bytes,
    expectedPatch,
  )
  assert.deepEqual(
    (await git(b, 'status', '--porcelain', '-z')).bytes,
    (await git(a, 'status', '--porcelain', '-z')).bytes,
  )

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        image,
        head,
        parts: Object.fromEntries(
          Object.entries(parts).map(([name, bytes]) => [
            name,
            { bytes: bytes.byteLength, sha256: digest(bytes) },
          ]),
        ),
        verified: [
          'P2 Docker provider exec path: runc, network none, uid 10001, read-only rootfs',
          'session exact bytes',
          'three untracked files including binary, empty and UTF-8 paths',
          'credentials/config omitted by allowlist',
          'gitignored file omitted',
          'existing directories accepted',
          'repeated restore refuses existing files without overwrite',
          'absolute destination symlink rejected before extraction',
          'P1 restore leaves tracked base intact',
          'separate trusted git apply restores text, binary and deletion',
          'executable mode preserved',
          'identical Git HEAD, binary diff and porcelain status',
        ],
        metrics,
      },
      null,
      2,
    ),
  )
} finally {
  const cleanup = await Promise.allSettled(
    created.map(async (sandbox) => {
      await sandbox.destroy('completed')
      assert.equal(await provider.get(sandbox.id), null)
    }),
  )
  assert(
    cleanup.every((result) => result.status === 'fulfilled'),
    `Could not remove all disposable containers: ${created.map((s) => s.id).join(', ')}`,
  )
  console.log(`Cleaned ${created.length} disposable containers`)
}
