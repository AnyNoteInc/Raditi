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
  for (const sandbox of [a, b]) {
    assert.equal((await run(sandbox, ['id', '-u'])).bytes.toString().trim(), '10001')
    assert.notEqual((await run(sandbox, ['touch', '/rootfs-probe'], { codes: [1] })).code, 0)
  }
  // A file the agent left in the working directory: a turn has no repository
  // (docs/plan/83-remove-projects.md), and no snapshot keeps it.
  await write(a, `${repository}/notes.txt`, Buffer.from('working directory, never kept\n'))
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
  const parts = await transport.capture(a, state)
  assert.deepEqual(Object.keys(parts), ['home'])
  // Existing directories are legitimate; only existing files must be rejected.
  await run(b, ['mkdir', '-p', data])
  await transport.restore(b, state, parts)

  for (const [name, bytes] of session) assert.deepEqual(await read(b, `${home}/${name}`), bytes)
  await absent(b, `${data}/auth.json`)
  await absent(b, `${data}/log`)
  await absent(b, `${home}/.config`)
  await absent(b, `${repository}/notes.txt`)

  // Refuse overwriting existing files, even if a repeated archive has the same bytes.
  // A sentinel differing from archive contents makes non-overwrite observable.
  const sentinel = Buffer.from('existing session must remain intact\n')
  await write(b, `${home}/${sessionFiles[0]}`, sentinel)
  await assert.rejects(transport.restore(b, state, parts), { code: 'SANDBOX_COMMAND_FAILED' })
  assert.deepEqual(await read(b, `${home}/${sessionFiles[0]}`), sentinel)
  await write(b, `${home}/${sessionFiles[0]}`, session.get(sessionFiles[0]))

  // An absolute destination symlink must be refused before any tar extraction.
  await run(b, ['ln', '-s', '/workspace/repo', `${data}/absolute-link`])
  const extractCount = metrics.tarExtractCommands
  await assert.rejects(transport.restore(b, state, parts), { code: 'SANDBOX_COMMAND_FAILED' })
  assert.equal(metrics.tarExtractCommands, extractCount)
  for (const [name, bytes] of session) assert.deepEqual(await read(b, `${home}/${name}`), bytes)
  await run(b, ['rm', '--', `${data}/absolute-link`])

  // A working directory that is not empty: nothing is restored into it.
  await write(b, `${repository}/left-over.txt`, Buffer.from("not the turn's\n"))
  await run(b, ['rm', '--', `${home}/${sessionFiles[0]}`, `${home}/${sessionFiles[1]}`])
  await assert.rejects(transport.restore(b, state, parts), { code: 'SANDBOX_COMMAND_FAILED' })
  await absent(b, `${home}/${sessionFiles[0]}`)

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        image,
        parts: Object.fromEntries(
          Object.entries(parts).map(([name, bytes]) => [
            name,
            { bytes: bytes.byteLength, sha256: digest(bytes) },
          ]),
        ),
        verified: [
          'P2 Docker provider exec path: runc, network none, uid 10001, read-only rootfs',
          'session exact bytes, the home part alone',
          'credentials/config omitted by allowlist',
          'the working directory never captured',
          'existing directories accepted',
          'repeated restore refuses existing files without overwrite',
          'absolute destination symlink rejected before extraction',
          'a working directory that is not empty refused before extraction',
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
