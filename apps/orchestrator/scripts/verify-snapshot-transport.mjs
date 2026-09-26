/* global Buffer, clearTimeout, console, process, setTimeout */
// Local verification fixture; the production Docker provider belongs to P2.
// Usage: pnpm --filter orchestrator verify:transport sha256:<local-image-id>
// Requires a disposable Ubuntu image containing git, GNU tar and zstd.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SandboxSnapshotTransport } from '../dist/sessions/sandbox-snapshot.js'

const image = process.argv[2]
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const prefix = `raditi-p1-transport-${process.pid}-${Date.now()}`
const created = []
const metrics = {
  commands: 0,
  tarExtractCommands: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdinBytes: 0,
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function docker(argv, stdin) {
  const child = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (data) => stdout.push(data))
  child.stderr.on('data', (data) => stderr.push(data))
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  child.stdin.end(stdin)
  const code = await closed
  assert.equal(code, 0, `docker ${argv[0]} failed: ${Buffer.concat(stderr).toString()}`)
  return Buffer.concat(stdout)
}

// Implements only the Sandbox.exec surface consumed by this transport. Every byte,
// including repository seeding, travels through exec stdin/stdout, never docker cp.
function execSandbox(container) {
  return {
    id: container,
    async exec(spec) {
      metrics.commands += 1
      if (spec.argv[0] === 'tar' && spec.argv.includes('--extract')) metrics.tarExtractCommands += 1
      const args = ['exec', '-i']
      if (spec.cwd) args.push('--workdir', spec.cwd)
      for (const [key, value] of Object.entries(spec.env ?? {}))
        args.push('--env', `${key}=${value}`)
      args.push(container, ...spec.argv)
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks = []
      const errorChunks = []
      const offsets = { stdout: 0, stderr: 0 }
      let done = false
      let wake
      let spawnError
      let reason = 'exited'
      let killPromise
      const notify = () => {
        wake?.()
        wake = undefined
      }
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (bytes) => {
          const data = Buffer.from(bytes)
          chunks.push({ stream, offset: offsets[stream], data })
          offsets[stream] += data.byteLength
          metrics[`${stream}Bytes`] += data.byteLength
          if (stream === 'stderr') errorChunks.push(data)
          notify()
        })
      }
      const stop = (why) => {
        if (done) return Promise.resolve()
        reason = why
        // Killing the entire owned disposable container also stops remote exec;
        // this intentionally does not claim production ExecHandle kill semantics.
        killPromise ??= docker(['kill', container]).catch(() => {})
        child.kill('SIGKILL')
        return killPromise
      }
      const abort = () => {
        void stop('cancelled')
      }
      const timer = setTimeout(() => {
        void stop('timeout')
      }, spec.timeoutMs)
      spec.signal?.addEventListener('abort', abort, { once: true })
      const wait = new Promise((resolve) => {
        child.once('error', (error) => {
          spawnError = error
        })
        child.once('close', (code) => {
          if (code !== 0 && spec.argv[0] !== 'test') {
            console.error(
              JSON.stringify({
                command: spec.argv,
                code,
                stderr: Buffer.concat(errorChunks).toString(),
              }),
            )
          }
          done = true
          clearTimeout(timer)
          spec.signal?.removeEventListener('abort', abort)
          notify()
          resolve({ code, reason: spawnError ? 'lost' : reason })
        })
      })
      async function* stdin() {
        for await (const bytes of spec.stdin ?? []) {
          metrics.stdinBytes += bytes.byteLength
          yield bytes
        }
      }
      void pipeline(Readable.from(stdin()), child.stdin).catch(() => {})
      if (spec.signal?.aborted) abort()
      return {
        id: String(child.pid),
        async *output() {
          while (!done || chunks.length > 0) {
            if (chunks.length > 0) yield chunks.shift()
            else
              await new Promise((resolve) => {
                wake = resolve
              })
          }
          if (spawnError) throw spawnError
        },
        wait: () => wait,
        kill: () => stop('cancelled'),
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
const home = '/agent-home/codex'
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
  const name = `${prefix}-${suffix}`
  const id = (
    await docker([
      'create',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--user',
      '10001:10001',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '64',
      '--memory',
      '256m',
      '--cpus',
      '1',
      '--tmpfs',
      '/workspace:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=32m',
      '--tmpfs',
      '/agent-home:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=16m',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,mode=1777,size=16m',
      '--env',
      'HOME=/agent-home',
      image,
      'sleep',
      'infinity',
    ])
  )
    .toString()
    .trim()
  created.push(id)
  await docker(['start', id])
  return execSandbox(id)
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
  const sessionName = 'sessions/2026/09/26/rollout-synthetic.jsonl'
  const sessionBytes = Buffer.from(
    '{"type":"session_meta","id":"synthetic"}\n{"type":"message","text":"привет"}\n',
  )
  await write(a, `${home}/${sessionName}`, sessionBytes)
  await write(a, `${home}/auth.json`, Buffer.from('{"synthetic":true}'))
  await write(a, `${home}/config.toml`, Buffer.from('synthetic = true\n'))

  const state = { root: home, include: ['sessions'], exclude: [] }
  const transport = new SandboxSnapshotTransport()
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
  await run(b, ['mkdir', '-p', `${home}/sessions/2026/09/26`, `${repository}/new dir`])
  await transport.restore(b, state, parts)

  // P1 restore moves home/untracked only. The trusted P2 patch application remains
  // a distinct operation, explicitly exercised here using synthetic fixture bytes.
  assert.deepEqual(await read(b, `${repository}/tracked.txt`), baseText)
  assert.deepEqual(await read(b, `${repository}/tracked.bin`), baseBinary)
  assert.deepEqual(await read(b, `${home}/${sessionName}`), sessionBytes)
  for (const [name, bytes] of untracked)
    assert.deepEqual(await read(b, `${repository}/${name}`), bytes)
  await absent(b, `${home}/auth.json`)
  await absent(b, `${home}/config.toml`)
  await absent(b, `${repository}/ignored.tmp`)

  // Refuse overwriting existing files, even if a repeated archive has the same bytes.
  // A sentinel differing from archive contents makes non-overwrite observable.
  const sentinel = Buffer.from('existing session must remain intact\n')
  await write(b, `${home}/${sessionName}`, sentinel)
  await assert.rejects(transport.restore(b, state, parts), { code: 'BAD_REQUEST' })
  assert.deepEqual(await read(b, `${home}/${sessionName}`), sentinel)
  for (const [name, bytes] of untracked)
    assert.deepEqual(await read(b, `${repository}/${name}`), bytes)
  assert.deepEqual(await read(b, `${repository}/tracked.txt`), baseText)
  await write(b, `${home}/${sessionName}`, sessionBytes)

  // An absolute destination symlink must be refused before any tar extraction.
  await run(b, ['ln', '-s', '/workspace/repo', `${home}/sessions/absolute-link`])
  const extractCount = metrics.tarExtractCommands
  await assert.rejects(transport.restore(b, state, parts), { code: 'BAD_REQUEST' })
  assert.equal(metrics.tarExtractCommands, extractCount)
  assert.deepEqual(await read(b, `${home}/${sessionName}`), sessionBytes)
  await run(b, ['rm', '--', `${home}/sessions/absolute-link`])

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
  const cleanup = await Promise.allSettled(created.map((id) => docker(['rm', '-f', id])))
  assert(
    cleanup.every((result) => result.status === 'fulfilled'),
    `Could not remove all disposable containers: ${created.join(', ')}`,
  )
  console.log(`Cleaned ${created.length} disposable containers`)
}
