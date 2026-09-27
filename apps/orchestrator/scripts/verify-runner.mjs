/* global AbortSignal, Buffer, URL, console, fetch, process, setTimeout */
// P2 gates 2 and 3 (spec §8 «Раннер на песочной ВМ», «Восстановление незавершённого хода») on a
// real runner VM: core runs on this host (verify-runner-core.mjs, over the local PostgreSQL, S3
// and OpenBao), the runner role in a Linux VM under gVisor, next to the VM's Docker. No models:
// the synthetic agent prints codex JSONL and may wait at a gate. Scenarios:
//   1. two full turns of one session: turn 2 restores turn 1's snapshot through presigned GETs;
//      each home is sealed by the runner through a presigned PUT; core publishes;
//   2. core killed -9 while the agent's output is journaled: a new core's recovery resumes it;
//   3. the runner killed -9 there: the turn is given up, its container removed, the site freed;
//   4. both killed: recovery resumes on the restarted runner with the turn's credentials;
//   5. the turn cancelled while the runner creates its container: the site stays with the turn
//      until the container is removed;
// and a stale epoch or a runner session that is gone is refused. Synthetic data only; every
// row, object, key, container, network and firewall rule it creates is removed.
//
//   pnpm --filter orchestrator verify:runner
//
// Needs: the local infrastructure from .env; P2_GITLEAKS_BINARY (gitleaks 8.30.1);
// P2_RUNNER_DOCKER_SOCKET, the VM's Docker socket on this host; images built in that daemon and
// pinned by digest: P2_SANDBOX_IMAGE (runtime), P2_RUNNER_NODE_IMAGE (base: Node and tini — the
// orchestrator image is M10), SANDBOX_GATEWAY_IMAGE, SANDBOX_NETWORK_GUARD_IMAGE. The VM reaches
// this host's loopback at P2_RUNNER_HOST (192.168.5.2 in Colima and Lima).
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import { createPrismaClient } from '@repo/db'
import { snapshotPartFiles, turnSnapshotPrefix } from '@repo/domain'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { extract } from 'tar-stream'

import { SnapshotService } from '../dist/sessions/snapshot.service.js'

const env = process.env
const scripts = dirname(fileURLToPath(import.meta.url))
const repository = resolve(scripts, '../../..')
const DIGEST = /^[^\s@]+@sha256:[a-f0-9]{64}$/
const GATE = '/tmp/raditi-verify-go'
const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
const driverVersion = '0.0.0-verify'

// --- Configuration: local endpoints, synthetic data, digest-pinned images ---------------------
assert.notEqual(env.APP_ENV, 'production')
const storageConfig = storageConfigFromEnv(env)
const vaultConfig = vaultConfigFromEnv(env)
const local = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
for (const endpoint of [storageConfig.endpoint, vaultConfig.addr, env.DATABASE_URL ?? ''])
  assert(local(endpoint), 'PostgreSQL, S3 and Vault must be the local development ones')
assert(vaultConfig.token && !vaultConfig.appRole, 'Local OpenBao in dev mode is expected')
const gitleaks = env.P2_GITLEAKS_BINARY
const socket = env.P2_RUNNER_DOCKER_SOCKET
assert(gitleaks && isAbsolute(gitleaks), 'P2_GITLEAKS_BINARY must be an absolute path')
assert(socket && isAbsolute(socket), 'P2_RUNNER_DOCKER_SOCKET must be an absolute socket path')
const images = {
  sandbox: env.P2_SANDBOX_IMAGE,
  node: env.P2_RUNNER_NODE_IMAGE,
  gateway: env.SANDBOX_GATEWAY_IMAGE,
  guard: env.SANDBOX_NETWORK_GUARD_IMAGE,
}
for (const [name, image] of Object.entries(images))
  assert(image && DIGEST.test(image), `The ${name} image must be pinned by digest`)
const hostAddress = env.P2_RUNNER_HOST ?? '192.168.5.2'
const runnerS3 = new URL(storageConfig.endpoint)
runnerS3.hostname = hostAddress
const s3RunnerEndpoint = env.S3_RUNNER_ENDPOINT || runnerS3.origin
const gatewayConfig = {
  image: images.gateway,
  guardImage: images.guard,
  llmUpstream: `http://${hostAddress}:4000`,
  mcpUpstream: `http://${hostAddress}:8082`,
}

const runId = randomBytes(4).toString('hex')
const runnerId = `verify-${runId}`
const token = `rnr_${runnerId}.${randomBytes(32).toString('base64url')}`
const runnerTokens = `${runnerId}:${createHash('sha256').update(token).digest('hex')}`
const tokenVolume = `raditi-verify-runner-${runId}`

const db = createPrismaClient({ databaseUrl: env.DATABASE_URL, log: [] })
const storage = createS3ObjectStorage(storageConfig)
const snapshots = new SnapshotService(storage, createVaultSecretStore(vaultConfig))
const sandboxes = createDockerSandboxProvider({
  runtime: 'runsc',
  socketPath: socket,
  gateway: gatewayConfig,
})

// --- Processes: commands, Docker of the VM, core, runner ---------------------------------------
function command(binary, args, { input, allowFailure = false, extraEnv = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { env: { ...env, ...extraEnv }, stdio: 'pipe' })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString()
      const stderr = Buffer.concat(err).toString()
      if (code !== 0 && !allowFailure) reject(new Error(`${binary} ${args[0]} failed: ${stderr}`))
      else resolvePromise({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}
/** The Docker CLI against the VM's daemon; `options` as for command(). */
const dockerCommand = (args, options = {}) =>
  command('docker', args, { ...options, extraEnv: { DOCKER_HOST: `unix://${socket}` } })
const docker = async (...args) => (await dockerCommand(args)).stdout.trim()
const lines = (text) => text.split('\n').filter(Boolean)
const git = async (...args) => (await command('git', args)).stdout

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

let work
let port
let site
const turnCredentials = new Map()
const cores = []
const runners = []

/** A core process; `kill()` is kill -9, the database, S3, Git and the VM outlive it. */
async function startCore() {
  const log = await open(join(work, `core-${cores.length + 1}.log`), 'a')
  const child = fork(join(scripts, 'verify-runner-core.mjs'), [], {
    env: {
      ...env,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      S3_RUNNER_ENDPOINT: s3RunnerEndpoint,
    },
    stdio: ['ignore', log.fd, log.fd, 'ipc'],
  })
  // Over IPC, not argv or env: the stand-in for P3 hands over the turn credentials it keeps.
  child.send({
    type: 'start',
    config: {
      port,
      root: work,
      remote: join(work, 'remote.git'),
      gitleaks,
      siteId: site.id,
      runnerId,
      runnerTokens,
      credentials: [...turnCredentials],
      recoverEveryMs: 5_000,
    },
  })
  const pending = new Map()
  const ready = Promise.withResolvers()
  const core = {
    child,
    recovered: 0,
    exited: new Promise((done) => child.once('exit', done)),
    request(type, body = {}) {
      const id = randomUUID()
      const reply = Promise.withResolvers()
      pending.set(id, reply)
      child.send({ ...body, type, id })
      return reply.promise
    },
    async kill() {
      child.kill('SIGKILL')
      await core.exited
    },
  }
  child.on('message', (message) => {
    if (message.type === 'ready') ready.resolve()
    else if (message.type === 'recovered') core.recovered += 1
    else if (message.type === 'reply') {
      const reply = pending.get(message.id)
      pending.delete(message.id)
      if (message.ok) reply?.resolve(message.value)
      else reply?.reject(Object.assign(new Error(message.error.message), message.error))
    }
  })
  void core.exited.then(async () => {
    ready.reject(new Error('core exited before it was ready'))
    for (const reply of pending.values()) reply.reject(new Error('core exited'))
    await log.close()
  })
  cores.push(core)
  await ready.promise
  return core
}

/**
 * The runner role as compose runs it (infra/sandbox/docker-compose.yml, profile runner): no port,
 * root only for the Docker socket, no capabilities, read-only; the token read-only from
 * /etc/raditi. The orchestrator image is M10, so Node runs this repository's build, mounted
 * read-only, with the .env file masked. Its environment has no platform credentials at all.
 */
async function startRunner() {
  const name = `raditi-verify-runner-${runId}-${runners.length + 1}`
  const runnerEnv = {
    NODE_ENV: 'production',
    APP_ENV: 'development',
    NO_COLOR: '1',
    ORCHESTRATOR_ROLES: 'runner',
    RUNNER_CORE_URL: `http://${hostAddress}:${port}`,
    RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    RUNNER_S3_ORIGIN: new URL(s3RunnerEndpoint).origin,
    RUNNER_MAX_TURNS: '1',
    SANDBOX_RUNTIME: 'runsc',
    SANDBOX_DOCKER_SOCKET: '/var/run/docker.sock',
    SANDBOX_GATEWAY_IMAGE: gatewayConfig.image,
    SANDBOX_NETWORK_GUARD_IMAGE: gatewayConfig.guardImage,
    SANDBOX_LLM_UPSTREAM: gatewayConfig.llmUpstream,
    SANDBOX_MCP_UPSTREAM: gatewayConfig.mcpUpstream,
  }
  await docker(
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `io.raditi.verify=${runId}`,
    '--user',
    '0:0',
    '--read-only',
    '--init',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--cpus',
    '1',
    '--memory',
    '512m',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/tmp:size=64m',
    '--volume',
    '/var/run/docker.sock:/var/run/docker.sock',
    '--volume',
    `${tokenVolume}:/etc/raditi:ro`,
    '--volume',
    `${repository}:${repository}:ro`,
    ...(existsSync(join(repository, '.env'))
      ? ['--volume', `/dev/null:${join(repository, '.env')}:ro`]
      : []),
    '--workdir',
    join(repository, 'apps/orchestrator'),
    ...Object.entries(runnerEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--entrypoint',
    'node',
    images.node,
    'dist/main.js',
  )
  runners.push(name)
  const names = JSON.parse(await docker('inspect', '--format', '{{json .Config.Env}}', name)).map(
    (entry) => entry.slice(0, entry.indexOf('=')),
  )
  assert(
    !names.some((key) => /^(DATABASE_URL|REDIS_URL|VAULT_|S3_)/.test(key)),
    'The runner must hold no platform credentials',
  )
  return name
}

/** kill -9 of the runner process: SIGKILL to the container's init ends everything in it. */
const killRunner = (name) => docker('kill', '--signal', 'KILL', name)

async function runnerSession(core) {
  let session = null
  await waitFor(async () => (session = await core.request('session')), 'the runner to poll core')
  return session
}

// --- Observations: database, VM, Git, runner API ------------------------------------------------
async function waitFor(check, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 250))
  }
}
const journal = async (taskId) =>
  (await db.taskEvent.findMany({ where: { taskId }, orderBy: { id: 'asc' } })).map(
    (row) => row.payload,
  )
const phases = (entries, epoch) =>
  entries.filter((entry) => entry.fence.epoch === epoch).map((entry) => entry.phase)
const assignmentOf = (taskId) => db.turnAssignment.findFirst({ where: { taskId } })
const leaseOf = () => db.siteLease.findUnique({ where: { siteId: site.id } })
const turnContainers = async (label, value) =>
  lines(await docker('ps', '--all', '--quiet', '--filter', `label=${label}=${value}`))
const running = async (container) =>
  (await docker('inspect', '--format', '{{.State.Running}}', container)) === 'true'
const openGate = (container) =>
  docker('exec', '--user', '10001:10001', container, 'sh', '-c', `: > ${GATE}`)
const branchHead = async (taskId) =>
  (
    await command(
      'git',
      [
        '--git-dir',
        join(work, 'remote.git'),
        'rev-parse',
        '--verify',
        '-q',
        `refs/heads/agent/${taskId}`,
      ],
      { allowFailure: true },
    )
  ).stdout.trim()

/** Waits until the agent's first output is journaled and returns its epoch and container. */
async function untilOutput(taskId) {
  const entry = await waitFor(
    async () => (await journal(taskId)).find((item) => item.phase === 'output'),
    'the agent output in the journal',
  )
  const assignment = await assignmentOf(taskId)
  assert(assignment.containerId && assignment.runnerSession)
  assert(await running(assignment.containerId), 'The agent waits at its gate')
  assert.equal(
    await docker('inspect', '--format', '{{.HostConfig.Runtime}}', assignment.containerId),
    'runsc',
  )
  return { epoch: entry.fence.epoch, assignment }
}

/** Where the journal left the agent: its exec and the cursor of the last acknowledged output. */
async function journaledAgent(taskId) {
  const entries = await journal(taskId)
  return {
    execId: entries.find((entry) => entry.phase === 'running').execId,
    cursor: entries.findLast((entry) => entry.phase === 'output').cursor,
  }
}

/** A report as a runner would send it, straight to core's runner API. */
async function report(body) {
  const response = await fetch(`http://127.0.0.1:${port}/runner/v1/reports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'quiesced', commandId: randomUUID(), ...body }),
    signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, body: await response.json() }
}

/** Every agent event once, in order, across all epochs of the turn. */
function expectEvents(entries) {
  assert.deepEqual(
    entries
      .flatMap((entry) => (entry.phase === 'output' ? (entry.events ?? []) : []))
      .map((event) => event.type),
    ['started', 'message', 'completed'],
  )
}

/** Completed, published and removed; the site is free again. */
async function expectCompleted(taskId, turn, headSha) {
  const assignment = await assignmentOf(taskId)
  assert.equal(assignment.outcome, 'completed')
  assert.equal(assignment.executor, 'runner')
  assert.equal(assignment.runnerId, runnerId)
  assert.equal((await leaseOf()).holderTaskId, null)
  assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', taskId), [])
  const head = await branchHead(taskId)
  if (headSha) assert.equal(head, headSha)
  const text = await git('--git-dir', join(work, 'remote.git'), 'show', `${head}:index.php`)
  assert(text.endsWith(`turn ${turn}\n`), 'The agent change is published')
  return assignment
}

async function homeFiles(reference) {
  const loaded = await snapshots.load(reference)
  const names = []
  const reader = extract()
  const listed = (async () => {
    for await (const entry of reader) {
      names.push(entry.header.name)
      entry.resume()
    }
  })()
  reader.end(zstdDecompressSync(loaded.archives.home))
  await listed
  return names
}

// --- Turns ---------------------------------------------------------------------------------------
async function createTask() {
  const task = await db.task.create({ data: { workspaceId: site.workspaceId, siteId: site.id } })
  return { taskId: task.id, sessionId: `verify-${randomBytes(6).toString('hex')}` }
}

function turnRequest({ taskId, sessionId }, { turn, baseSha, previous, gated }) {
  const context = {
    taskId,
    sessionId,
    turn,
    llm: {
      baseUrl: 'http://sandbox-gw.invalid',
      apiKey: `verify-llm-${randomBytes(16).toString('hex')}`,
      model: 'synthetic',
    },
    mcp: {
      url: 'http://sandbox-gw.invalid/mcp',
      token: `verify-mcp-${randomBytes(16).toString('hex')}`,
    },
    instructions: 'Synthetic runner verification',
  }
  turnCredentials.set(`${taskId}:${sessionId}:${turn}`, {
    llmApiKey: context.llm.apiKey,
    mcpToken: context.mcp.token,
  })
  return {
    sandbox: {
      image: images.sandbox,
      labels: { workspaceId: site.workspaceId, siteId: site.id, taskId, sessionId, turn },
      runtime: 'runsc',
      resources: { cpu: 1, memoryMiB: 512, pids: 128 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'gateway', routes: ['llm', 'mcp'] },
      hardTimeoutMs: 10 * 60_000,
    },
    context,
    input: { prompt: JSON.stringify({ gated }), attachments: [] },
    driverVersion,
    workspace: {
      repo: { provider: 'gitea', owner: 'verify', name: 'site' },
      branch: `agent/${taskId}`,
      expectedBaseSha: baseSha,
      protectedPaths: [],
    },
    committedAt: new Date().toISOString(),
    ...(previous ? { previous } : {}),
  }
}

const reference = ({ sessionId }, turn) => ({
  workspaceId: site.workspaceId,
  sessionId,
  turn,
  image: images.sandbox,
  driver: { id: 'codex', version: driverVersion },
  home,
})

// --- Main -----------------------------------------------------------------------------------------
const verified = []
const failures = []
const sessions = []
const firewall = async () =>
  lines(
    await docker(
      'run',
      '--rm',
      '--network',
      'host',
      '--user',
      '0:0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_ADMIN',
      '--security-opt',
      'no-new-privileges:true',
      '--entrypoint',
      'sh',
      images.guard,
      '-c',
      'iptables -S INPUT; ip6tables -S INPUT',
    ),
  ).filter((rule) => rule.includes('rdx'))
/** Short-lived host firewall helpers of runsc attempts carry no scope labels. */
const helpers = async () =>
  lines(await docker('ps', '--all', '--quiet', '--filter', 'label=io.raditi.gateway.role=firewall'))
let keyCreated = false
let rulesBefore = []
let helpersBefore
let succeeded = false

async function vault(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${vaultConfig.addr.replace(/\/$/, '')}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': vaultConfig.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  assert(response.ok, `Local Vault setup failed (${response.status})`)
  return response.status === 204 ? null : response.json()
}

try {
  // The VM: Linux with gVisor registered, the images present in its own daemon.
  assert.equal(await docker('info', '--format', '{{.OSType}}'), 'linux')
  assert('runsc' in JSON.parse(await docker('info', '--format', '{{json .Runtimes}}')))
  for (const image of Object.values(images))
    await docker('image', 'inspect', '--format', '{{.Id}}', image)
  rulesBefore = await firewall()
  helpersBefore = await helpers()

  work = await mkdtemp(join(tmpdir(), 'raditi-runner-verify-'))
  port = await freePort()
  // The site's Git remote: one commit on main; each task publishes to agent/<task>.
  const remote = join(work, 'remote.git')
  const seed = join(work, 'seed')
  await git('init', '--quiet', '--bare', '--initial-branch=main', remote)
  await git('init', '--quiet', '--initial-branch=main', seed)
  await writeFile(join(seed, 'index.php'), "<?php echo 'hello';\n")
  await git('-C', seed, 'add', '.')
  await git(
    '-C',
    seed,
    '-c',
    'user.name=Verify',
    '-c',
    'user.email=verify@example.test',
    'commit',
    '--quiet',
    '-m',
    'Synthetic site',
  )
  await git('-C', seed, 'push', '--quiet', remote, 'HEAD:main')
  const mainSha = (await git('-C', seed, 'rev-parse', 'HEAD')).trim()

  const workspace = await db.workspace.create({ data: { name: 'Synthetic runner verification' } })
  site = await db.site.create({
    data: {
      workspaceId: workspace.id,
      name: 'Runner verification',
      url: 'https://runner-verify.invalid',
      stack: 'wordpress',
    },
  })
  const mounts = await vault('sys/mounts')
  if (!mounts.data['transit/']) await vault('sys/mounts/transit', { type: 'transit' })
  await vault(`transit/keys/ws-${workspace.id}`, { type: 'aes256-gcm96' })
  keyCreated = true

  // The VM token: root-owned 0400 in a volume the runner mounts read-only; core keeps its hash.
  await docker('volume', 'create', '--label', `io.raditi.verify=${runId}`, tokenVolume)
  await dockerCommand(
    [
      'run',
      '--rm',
      '--interactive',
      '--network',
      'none',
      '--user',
      '0:0',
      '--volume',
      `${tokenVolume}:/etc/raditi`,
      '--entrypoint',
      'sh',
      images.node,
      '-c',
      'umask 0277 && cat > /etc/raditi/runner-token',
    ],
    { input: token },
  )

  let core = await startCore()
  let runner = await startRunner()
  await runnerSession(core)

  // 1. Two full turns: restore of turn 1 in turn 2, sealing and presigned transfers on the VM.
  {
    const started = Date.now()
    const task = await createTask()
    sessions.push(task.sessionId)
    const first = await core.request('run', {
      request: turnRequest(task, { turn: 1, baseSha: mainSha, gated: false }),
    })
    assert.equal(first.result.client_message, 'Изменение готово к проверке.')
    await expectCompleted(task.taskId, 1, first.manifest.git.headSha)
    const second = await core.request('run', {
      request: turnRequest(task, {
        turn: 2,
        baseSha: first.manifest.git.headSha,
        previous: reference(task, 1),
        gated: false,
      }),
    })
    await expectCompleted(task.taskId, 2, second.manifest.git.headSha)
    const entries = await journal(task.taskId)
    assert(entries.some((entry) => entry.phase === 'restored' && entry.nativeSessionId))
    // The agent of turn 2 exits non-zero unless turn 1's session and change were restored.
    const files = await homeFiles(reference(task, 2))
    for (const name of ['verify/turn-1.jsonl', 'verify/turn-2.jsonl'])
      assert(
        files.some((file) => file.endsWith(name)),
        `turn 2 home keeps ${name}`,
      )
    const tree = await git(
      '--git-dir',
      remote,
      'ls-tree',
      '--name-only',
      second.manifest.git.headSha,
    )
    assert.deepEqual(lines(tree).sort(), ['index.php', 'turn-1.txt', 'turn-2.txt'])
    verified.push(
      `full turns on runsc with restore of the previous snapshot, runner-sealed home through presigned PUT, core publication (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // 2. kill -9 of core during the output: a new core's recovery resumes the agent.
  {
    const started = Date.now()
    const task = await createTask()
    sessions.push(task.sessionId)
    const run = core.request('run', {
      request: turnRequest(task, { turn: 1, baseSha: mainSha, gated: true }),
    })
    run.catch(() => {})
    const { epoch, assignment } = await untilOutput(task.taskId)
    await core.kill()
    const left = await journaledAgent(task.taskId)
    assert(await running(assignment.containerId), 'The agent outlives core')
    assert(await running(runner), 'The runner outlives core')
    core = await startCore()
    const resumed = await waitFor(async () => {
      const entries = await journal(task.taskId)
      return entries.find((entry) => entry.phase === 'resumed' && entry.fence.epoch > epoch)
    }, 'recovery to resume the agent')
    assert.equal(resumed.recoveredFromEpoch, epoch)
    // The same exec, attached again from the journal's cursor.
    assert.deepEqual([resumed.execId, resumed.cursor], [left.execId, left.cursor])
    const current = await assignmentOf(task.taskId)
    assert.equal(current.runnerSession, assignment.runnerSession, 'The same runner session')
    // A stale epoch is refused with the fence to move to; another session of the runner is retired.
    const stale = await report({
      runnerSession: current.runnerSession,
      assignmentId: current.id,
      epoch,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, 'FENCE_SUPERSEDED')
    assert.equal(stale.body.fence.epoch, resumed.fence.epoch)
    const foreign = await report({
      runnerSession: randomUUID(),
      assignmentId: current.id,
      epoch: resumed.fence.epoch,
    })
    assert.deepEqual([foreign.status, foreign.body], [409, { error: 'SESSION_RETIRED' }])
    await openGate(assignment.containerId)
    await waitFor(async () => (await assignmentOf(task.taskId)).outcome, 'the resumed turn to end')
    await expectCompleted(task.taskId, 1)
    const entries = await journal(task.taskId)
    expectEvents(entries)
    assert.deepEqual(phases(entries, resumed.fence.epoch).slice(-6), [
      'quiesced',
      'checkpointing',
      'checkpointed',
      'destroyed',
      'publishing',
      'completed',
    ])
    assert(
      entries
        .filter((entry) => entry.fence.epoch === resumed.fence.epoch)
        .every((entry) => entry.recoveredFromEpoch === epoch),
    )
    assert.equal(core.recovered, 0, 'The runner that outlived core still held the credentials')
    const finished = await report({
      runnerSession: current.runnerSession,
      assignmentId: current.id,
      epoch: resumed.fence.epoch,
    })
    assert.deepEqual([finished.status, finished.body], [409, { error: 'LEASE_LOST' }])
    verified.push(
      `kill -9 of core during output: resumed from the journal cursor under epoch ${resumed.fence.epoch}, every event once, published; stale epoch → 409 FENCE_SUPERSEDED, another session → 409 SESSION_RETIRED, a finished turn → 409 LEASE_LOST (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // 3. kill -9 of the runner during the output: core gives the turn up, recovery removes it.
  {
    const started = Date.now()
    const task = await createTask()
    sessions.push(task.sessionId)
    const run = core.request('run', {
      request: turnRequest(task, { turn: 1, baseSha: mainSha, gated: true }),
    })
    run.catch(() => {})
    const { epoch, assignment } = await untilOutput(task.taskId)
    await killRunner(runner)
    assert(await running(assignment.containerId), 'The agent outlives the runner')
    runner = await startRunner()
    await assert.rejects(run, { code: 'RUNNER_UNAVAILABLE' })
    await waitFor(async () => (await assignmentOf(task.taskId)).outcome, 'recovery to end the turn')
    const current = await assignmentOf(task.taskId)
    assert.equal(current.outcome, 'lost')
    assert.notEqual(current.runnerSession, assignment.runnerSession)
    const entries = await journal(task.taskId)
    // No confirmed removal: the owner held the site; recovery removed the container, then freed it.
    assert.equal(entries.find((entry) => entry.phase === 'recovery')?.reason, 'destroy_failed')
    const last = entries.at(-1)
    assert.deepEqual(
      [last.phase, last.reason, last.fence.epoch > epoch, last.recoveredFromEpoch],
      ['failed', 'run_failed', true, epoch],
    )
    assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', task.taskId), [])
    assert.equal((await leaseOf()).holderTaskId, null)
    assert.equal(await branchHead(task.taskId), '', 'Nothing of the lost turn is published')
    const zombie = await report({
      runnerSession: assignment.runnerSession,
      assignmentId: current.id,
      epoch: current.leaseEpoch,
    })
    assert.deepEqual([zombie.status, zombie.body], [409, { error: 'SESSION_RETIRED' }])
    verified.push(
      `kill -9 of the runner during output: the turn lost without publication, its container removed through the restarted runner, the site freed only after that; the old session → 409 SESSION_RETIRED (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // 4. kill -9 of core and of the runner: recovery resumes on the new runner session with the
  //    credentials the stand-in for P3 kept.
  {
    const started = Date.now()
    const task = await createTask()
    sessions.push(task.sessionId)
    const run = core.request('run', {
      request: turnRequest(task, { turn: 1, baseSha: mainSha, gated: true }),
    })
    run.catch(() => {})
    const { epoch, assignment } = await untilOutput(task.taskId)
    await core.kill()
    await killRunner(runner)
    const left = await journaledAgent(task.taskId)
    assert(await running(assignment.containerId), 'The agent outlives core and the runner')
    runner = await startRunner()
    core = await startCore()
    const resumed = await waitFor(async () => {
      const entries = await journal(task.taskId)
      return entries.find((entry) => entry.phase === 'resumed' && entry.fence.epoch > epoch)
    }, 'recovery to resume the agent on the new runner session')
    assert.equal(resumed.recoveredFromEpoch, epoch)
    // The same exec, attached again from the journal's cursor.
    assert.deepEqual([resumed.execId, resumed.cursor], [left.execId, left.cursor])
    const current = await assignmentOf(task.taskId)
    assert.notEqual(current.runnerSession, assignment.runnerSession)
    assert.equal(core.recovered, 1, 'The credentials came from the source, not the runner')
    const zombie = await report({
      runnerSession: assignment.runnerSession,
      assignmentId: current.id,
      epoch,
    })
    assert.deepEqual([zombie.status, zombie.body], [409, { error: 'SESSION_RETIRED' }])
    const stale = await report({
      runnerSession: current.runnerSession,
      assignmentId: current.id,
      epoch,
    })
    assert.deepEqual([stale.status, stale.body.error], [409, 'FENCE_SUPERSEDED'])
    await openGate(assignment.containerId)
    await waitFor(async () => (await assignmentOf(task.taskId)).outcome, 'the resumed turn to end')
    await expectCompleted(task.taskId, 1)
    expectEvents(await journal(task.taskId))
    verified.push(
      `kill -9 of core and the runner during output: resumed on the new runner session with recovered credentials, the old session → 409 SESSION_RETIRED, published (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // 5. Cancelled while the runner creates the container: no proof that none is left, so the
  //    site stays with the turn (vacating) until the late container is removed.
  {
    const started = Date.now()
    const task = await createTask()
    sessions.push(task.sessionId)
    const run = core.request('run', {
      request: turnRequest(task, { turn: 1, baseSha: mainSha, gated: true }),
    })
    run.catch(() => {})
    // Claimed and delivered in one poll; creating a gateway and a sandbox takes seconds.
    await waitFor(
      async () => (await assignmentOf(task.taskId))?.runnerSession,
      'the runner to take the prepare',
    )
    assert(!(await journal(task.taskId)).some((entry) => entry.phase === 'created'))
    await core.request('cancel', { taskId: task.taskId })
    await assert.rejects(run, { code: 'TURN_INTERRUPTED', message: 'cancelled' })
    let seen = false
    await waitFor(async () => {
      // The lease first: a container that exists after the site was freed breaks the rule.
      const lease = await leaseOf()
      const containers = await turnContainers('io.raditi.sandbox.taskId', task.taskId)
      if (containers.length > 0) {
        seen = true
        assert.equal(lease.holderTaskId, task.taskId, 'The site stays with the turn meanwhile')
      }
      return containers.length === 0 && (await assignmentOf(task.taskId)).outcome
    }, 'the cancelled turn to end')
    const entries = await journal(task.taskId)
    assert.deepEqual(
      entries.map((entry) => [entry.phase, entry.reason, Boolean(entry.containerId)]),
      [
        ['leased', undefined, false],
        ['vacating', 'cancelled', false],
        ['vacating', 'cancelled', true],
        ['failed', 'cancelled', false],
      ],
    )
    assert.equal((await assignmentOf(task.taskId)).outcome, 'failed')
    assert.equal((await leaseOf()).holderTaskId, null)
    assert.equal(await branchHead(task.taskId), '', 'Nothing of the cancelled turn is published')
    verified.push(
      `cancel while the runner creates the container: vacating without a release, the late container removed through the runner, then the site freed${seen ? ' (held while the container was seen)' : ''} (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // Nothing of the turns is left in the VM: containers, gateway networks, host firewall rules.
  assert.deepEqual(await turnContainers('io.raditi.sandbox.siteId', site.id), [])
  assert.deepEqual(await turnContainers('io.raditi.gateway.siteId', site.id), [])
  assert.deepEqual(
    lines(
      await docker(
        'network',
        'ls',
        '--quiet',
        '--filter',
        `label=io.raditi.gateway.siteId=${site.id}`,
      ),
    ),
    [],
  )
  assert.deepEqual(await firewall(), rulesBefore)
  assert.deepEqual(await helpers(), helpersBefore)
  await core.request('close')
  await core.exited
  await docker('stop', '--time', '30', runner)
  succeeded = true
} catch (error) {
  failures.push(error)
} finally {
  const cleanup = []
  const settle = async (what, action) => {
    try {
      await action()
    } catch (error) {
      cleanup.push(new Error(`Cleanup of ${what} failed: ${error.message}`))
    }
  }
  for (const core of cores)
    if (core.child.exitCode === null && core.child.signalCode === null)
      await settle('core', () => core.kill())
  for (const name of runners)
    await settle('runner', async () => {
      if (work) {
        const logs = await dockerCommand(['logs', name], { allowFailure: true })
        await writeFile(join(work, `${name}.log`), logs.stdout + logs.stderr)
      }
      await docker('rm', '--force', name)
    })
  if (site) {
    // Whatever a failed scenario left: removed through the provider, gateway and rule included.
    await settle('sandboxes', async () => {
      for (const info of await sandboxes.list({ siteId: site.id }))
        await (await sandboxes.getForRemoval(info.id))?.destroy('failed')
    })
    await settle('gateway leftovers', async () => {
      const left = await turnContainers('io.raditi.gateway.siteId', site.id)
      if (left.length) await docker('rm', '--force', ...left)
      const networks = lines(
        await docker(
          'network',
          'ls',
          '--quiet',
          '--filter',
          `label=io.raditi.gateway.siteId=${site.id}`,
        ),
      )
      if (networks.length) await docker('network', 'rm', ...networks)
    })
    await settle('database rows', async () => {
      // A failed run keeps the turns' journals next to the logs: phases, epochs and reasons.
      if (work && !succeeded) {
        const events = await db.taskEvent.findMany({
          where: { task: { siteId: site.id } },
          orderBy: { id: 'asc' },
        })
        const rows = events.map((row) => ({
          taskId: row.taskId,
          at: row.createdAt,
          ...row.payload,
        }))
        await writeFile(join(work, 'journal.json'), JSON.stringify(rows, null, 2))
      }
      await db.siteLease.deleteMany({ where: { siteId: site.id } })
      await db.task.deleteMany({ where: { siteId: site.id } })
      await db.site.delete({ where: { id: site.id } })
      await db.workspace.delete({ where: { id: site.workspaceId } })
    })
    await settle('snapshot objects', async () => {
      for (const sessionId of sessions)
        for (const turn of [1, 2])
          for (const name of [
            'reservation.json',
            'manifest.json',
            ...Object.values(snapshotPartFiles),
          ])
            await storage.delete('sessions', `${turnSnapshotPrefix(sessionId, turn)}${name}`)
    })
    if (keyCreated)
      await settle('Vault key', async () => {
        await vault(`transit/keys/ws-${site.workspaceId}/config`, { deletion_allowed: true })
        await vault(`transit/keys/ws-${site.workspaceId}`, undefined, 'DELETE')
      })
  }
  await settle('token volume', () => docker('volume', 'rm', '--force', tokenVolume))
  await settle('firewall rules', async () => assert.deepEqual(await firewall(), rulesBefore))
  await db.$disconnect()
  if (work && succeeded && cleanup.length === 0) await rm(work, { recursive: true, force: true })
  else if (work) console.error(`Logs of core and the runner are kept in ${work}`)
  failures.push(...cleanup)
}
if (failures.length) throw new AggregateError(failures, 'Runner verification failed')
console.log(
  `PASS (runner ${runnerId}, gVisor):\n${verified.map((line) => `- ${line}`).join('\n')}\n- containers, gateway networks, host firewall rules, rows, objects, Vault key and token volume removed`,
)
