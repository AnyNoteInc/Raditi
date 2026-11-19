/* global AbortSignal, Buffer, URL, console, fetch, process, setTimeout, clearTimeout */
// P2 gates 2 and 3 (spec §8 «Раннер на песочной ВМ», «Восстановление незавершённого хода») on a
// real runner VM: core runs on this host (verify-runner-core.mjs, over the local PostgreSQL, S3
// and OpenBao), the runner role in a Linux VM under gVisor, next to the VM's Docker. No models:
// the synthetic agent prints the rows of the sample driver's CLI (OpenCode), writes its session
// files and may wait at a gate. Scenarios:
//   1. two full turns of one session: turn 2 restores turn 1's snapshot through presigned GETs;
//      each home is sealed by the runner through a presigned PUT;
//   2. core killed -9 while the agent's output is journaled: a new core's recovery resumes it;
//   3. the runner killed -9 there: the turn is given up, its container removed, its lease freed;
//   4. both killed: recovery resumes on the restarted runner with the turn's credentials;
//   5. the turn cancelled: before its prepare went out — a runner slot reserved, the key being
//      issued — the site is free at once; when a poll has just taken the prepare, the site stays
//      with the turn until the container the runner creates is removed;
//   6. core killed after the checkpoint with the runner away: the checkpoint is finished only
//      once the runner is back and the container removed;
//   7. core killed before the prepare went out, a runner slot reserved: the next core closes the
//      turn and frees the site at once, not at the turn's deadline;
// and a stale epoch or a runner session that is gone is refused. Core runs the stores of the
// core role: each turn is a TaskTurn of its task, and the turn's key is bound to the address
// RUNNER_TOKENS names for the runner. Synthetic data only; every row, object, key, container,
// network and firewall rule it creates is removed.
//
//   pnpm --filter core verify:runner          (the seven scenarios above, synthetic agent)
//   pnpm verify:opencode-supervisor           (--opencode, the real CLI)
// Both launchers create disposable PostgreSQL, SeaweedFS and OpenBao of their own
// (verify-agent-supervisor.mjs) and never read .env (П47). --opencode runs the two-turn scenario
// with the real CLI and local LLM/MCP fixtures, including encrypted snapshot restore, then a chat
// whose last request is undone (docs/plan/61-chats-first.md, §5.14): it leases by its own id, two
// turns, and a third that goes back to the snapshot of the first through the runner's links, the
// first writing the agent's to-do list (docs/plan/89-agent-todos.md, 89.6) that the runner reports
// to core as one todo_list; a file of the client in /workspace/inbox; and a chat of a project
// with a repository (docs/plan/84-projects.md, ПР8, ПР12, ПР33, ПР35) — the path of production:
// the bundle without history the runner fetches from core into /workspace/repo, the files that
// look like secrets stubbed, the files of the project in /workspace/project, no git credential in
// the sandbox, the candidate committed by the trusted git of core through its git worker into
// refs/raditi/<chat> of the mirror, its snapshot with the parts `patch` and `untracked`; a kill -9
// of core between that snapshot and the publication, finished by the next core from those parts.
// Crash scenarios of chats without a repository still use the P2 agent.
//
// Needs: disposable PostgreSQL, S3 and OpenBao (the launchers make them); with --opencode git and
// gitleaks on PATH for the git worker;
// P2_RUNNER_DOCKER_SOCKET, the VM's Docker socket on this host; images built in that daemon and
// pinned by digest: P2_SANDBOX_IMAGE (runtime), P2_RUNNER_NODE_IMAGE (base: Node and tini, which runs
// this repository's build instead of the orchestrator image), SANDBOX_GATEWAY_IMAGE, SANDBOX_NETWORK_GUARD_IMAGE. The VM reaches
// this host's loopback at P2_RUNNER_HOST (192.168.5.2 in Colima and Lima).
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, randomUUIDv7 } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

import { createPrismaClient } from '@repo/db'
import {
  attachmentKey,
  HIDDEN_FILE_STUB,
  hiddenFileStub,
  projectFileKey,
  repositorySection,
  snapshotPartFiles,
  turnInboxPath,
  turnProjectPath,
  turnSnapshotPrefix,
} from '@repo/domain'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { extract } from 'tar-stream'

import { SnapshotService } from '../dist/sessions/snapshot.service.js'
import { sampleDriverId } from '../src/testing/ids.ts'
import { startOpencodeRunnerFixture } from './opencode-runner-fixture.mjs'

const {
  values: { opencode: realCli = false },
} = parseArgs({ options: { opencode: { type: 'boolean' } } })

// Without a real CLI the turns are those of «a driver in general».
const driverId = realCli ? 'opencode' : sampleDriverId
const driverName = 'OpenCode'
const firstEffort = 'low'

const env = process.env
const scripts = dirname(fileURLToPath(import.meta.url))
const repository = resolve(scripts, '../../..')
const DIGEST = /^[^\s@]+@sha256:[a-f0-9]{64}$/
const GATE = '/tmp/raditi-verify-go'
const driverVersion = realCli ? '1.18.34' : '0.0.0-verify'
/**
 * The session state of the OpenCode driver: the database and its WAL, nothing else. The
 * synthetic agent writes the same two files.
 */
const opencodeHome = {
  root: '/agent-home/opencode',
  include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
  exclude: [],
}
// The real-CLI mode is entered only by the launcher with disposable platform services.
if (realCli)
  assert.match(
    env.P4_DISPOSABLE_ID ?? '',
    /^[a-f0-9]{32}$/,
    'Use the driver supervisor launcher to create an isolated verification stack',
  )
let fixture
let interrupted = false
let cleaning = false
const pendingRequests = new Set()
const interrupt = () => {
  if (cleaning) return
  interrupted = true
  for (const reject of pendingRequests)
    reject(new Error('Agent supervisor verification interrupted'))
}
if (realCli) {
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
}

// --- Configuration: local endpoints, synthetic data, digest-pinned images ---------------------
assert.notEqual(env.APP_ENV, 'production')
const storageConfig = storageConfigFromEnv(env)
const vaultConfig = vaultConfigFromEnv(env)
const local = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
for (const endpoint of [storageConfig.endpoint, vaultConfig.addr, env.DATABASE_URL ?? ''])
  assert(local(endpoint), 'PostgreSQL, S3 and Vault must be the local development ones')
assert(vaultConfig.token && !vaultConfig.appRole, 'Local OpenBao in dev mode is expected')
const socket = env.P2_RUNNER_DOCKER_SOCKET
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
// Core listens on this host's loopback, which the VM reaches through its own gateway address:
// the runner's requests arrive from loopback, and its token opens nothing from elsewhere.
const runnerAddress = '127.0.0.1'
const runnerTokens = `${runnerId}:${createHash('sha256').update(token).digest('hex')}@${runnerAddress}`
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
    if (realCli && interrupted && !cleaning) return reject(new Error('Verification interrupted'))
    const child = spawn(binary, args, { env: { ...env, ...extraEnv }, stdio: 'pipe' })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', reject)
    const cancel = () => child.kill('SIGKILL')
    if (realCli) pendingRequests.add(cancel)
    const timer = realCli ? setTimeout(() => child.kill('SIGKILL'), 120_000) : undefined
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      pendingRequests.delete(cancel)
      const stdout = Buffer.concat(out).toString()
      const stderr = Buffer.concat(err).toString()
      if (realCli && interrupted && !cleaning) reject(new Error('Verification interrupted'))
      else if (code !== 0 && !allowFailure)
        reject(new Error(`${binary} ${args[0]} failed: ${stderr}`))
      else resolvePromise({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
/** The Docker CLI against the VM's daemon; `options` as for command(). */
const dockerCommand = (args, options = {}) =>
  command('docker', ['--host', `unix://${socket}`, ...args], {
    ...options,
    extraEnv: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: undefined,
      DOCKER_TLS: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    },
  })
const docker = async (...args) => (await dockerCommand(args)).stdout.trim()
const lines = (text) => text.split('\n').filter(Boolean)

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
/**
 * The trusted git of the stand's core (--opencode): the volume of the mirrors, where the git worker
 * listens, and the root of the clients' bare repositories its `local-test` transport reads.
 */
let gitSettings = null
let gitWorker
/** The rows and objects of the project of the repository scenario, removed at the end. */
const projectRows = { users: [], objects: [] }
const cores = []
const runners = []

/** A core process; `kill()` is kill -9, the database, S3 and the VM outlive it. */
async function startCore() {
  const log = await open(join(work, `core-${cores.length + 1}.log`), 'a')
  const child = fork(join(scripts, 'verify-runner-core.mjs'), [], {
    env: {
      ...env,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      S3_RUNNER_ENDPOINT: s3RunnerEndpoint,
      TMPDIR: join(work, 'tmp'),
    },
    stdio: ['ignore', log.fd, log.fd, 'ipc'],
  })
  // Over IPC, not argv or env: the stand-in for P3 hands over the turn credentials it keeps.
  child.send({
    type: 'start',
    config: {
      port,
      root: work,
      workspaceId: site.workspaceId,
      runnerId,
      runnerTokens,
      runnerAddress,
      credentials: [...turnCredentials],
      recoverEveryMs: 5_000,
      driverId: realCli ? driverId : null,
      sandboxImage: images.sandbox,
      git: gitSettings,
    },
  })
  const pending = new Map()
  const ready = Promise.withResolvers()
  const core = {
    child,
    recovered: 0,
    exited: new Promise((done) => child.once('close', done)),
    request(type, body = {}) {
      const id = randomUUID()
      const reply = Promise.withResolvers()
      pending.set(id, reply)
      child.send({ ...body, type, id })
      if (!realCli) return reply.promise
      const rejected = (error) => reply.reject(error)
      pendingRequests.add(rejected)
      const timer = setTimeout(
        () => rejected(new Error('Core verification request timed out')),
        180_000,
      )
      if (interrupted && !cleaning) rejected(new Error('Verification interrupted'))
      return reply.promise.finally(() => {
        clearTimeout(timer)
        pendingRequests.delete(rejected)
        pending.delete(id)
      })
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
  child.on('error', () => {
    ready.reject(new Error('Could not start the verification core'))
    for (const reply of pending.values()) reply.reject(new Error('Core process failed'))
  })
  void core.exited.then(async () => {
    ready.reject(new Error('core exited before it was ready'))
    for (const reply of pending.values()) reply.reject(new Error('core exited'))
    await log.close()
  })
  cores.push(core)
  const rejectReady = (error) => ready.reject(error)
  if (realCli) pendingRequests.add(rejectReady)
  const timer = realCli
    ? setTimeout(() => rejectReady(new Error('Core startup timed out')), 30_000)
    : undefined
  try {
    if (realCli && interrupted) rejectReady(new Error('Verification interrupted'))
    await ready.promise
  } finally {
    if (timer) clearTimeout(timer)
    pendingRequests.delete(rejectReady)
  }
  return core
}

/**
 * The runner role as compose runs it (infra/sandbox/docker-compose.yml, profile runner): no port,
 * root only for the Docker socket, no capabilities, read-only; the token read-only from
 * /etc/raditi. Node runs this repository's build in P2_RUNNER_NODE_IMAGE rather than the
 * orchestrator's runtime image, mounted read-only, with the .env file masked. Its environment has no platform credentials at all.
 */
async function startRunner() {
  const name = `raditi-verify-runner-${runId}-${runners.length + 1}`
  // Register before run: an interrupted Docker command may still have created its container.
  runners.push(name)
  const runnerEnv = {
    NODE_ENV: 'production',
    APP_ENV: 'development',
    NO_COLOR: '1',
    RUNNER_CORE_URL: `http://${hostAddress}:${port}`,
    RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    // Path-style S3 (SeaweedFS) shares its host between buckets: the pin names the sessions one.
    RUNNER_S3_ORIGIN:
      new URL(s3RunnerEndpoint).origin +
      (storageConfig.forcePathStyle ? `/${storageConfig.buckets.sessions}` : ''),
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
    join(repository, 'apps/runner'),
    ...Object.entries(runnerEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--entrypoint',
    'node',
    images.node,
    'dist/main.js',
  )
  const names = JSON.parse(await docker('inspect', '--format', '{{json .Config.Env}}', name)).map(
    (entry) => entry.slice(0, entry.indexOf('=')),
  )
  assert(
    !names.some((key) => /^(DATABASE_URL|REDIS_URL|VAULT_|S3_)/.test(key)),
    'The runner must hold no platform credentials',
  )
  return name
}

/**
 * The git worker (docs/plan/84-projects.md, ПР33) as its own process, like its container next to
 * core: it outlives a kill -9 of core. git and gitleaks of this machine; its socket on the volume.
 */
async function startGitWorker() {
  const log = await open(join(work, 'git-worker.log'), 'a')
  const child = spawn(process.execPath, [join(scripts, 'verify-runner-git-worker.mjs')], {
    cwd: join(repository, 'apps/core'),
    env: {
      PATH: env.PATH,
      HOME: join(work, 'home'),
      TMPDIR: join(work, 'tmp'),
      NODE_ENV: 'test',
      APP_ENV: 'test',
      NO_COLOR: '1',
      GIT_MIRROR_DIR: gitSettings.mirrorDir,
    },
    stdio: ['ignore', log.fd, log.fd],
  })
  const exited = new Promise((done) => child.once('close', done))
  void exited.then(() => log.close())
  await waitFor(
    async () => existsSync(join(gitSettings.mirrorDir, 'worker.sock')) || child.exitCode !== null,
    'the git worker to listen on its socket',
    30_000,
  )
  assert.equal(child.exitCode, null, 'The git worker did not start')
  return {
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
    },
  }
}

/** git of this machine, outside the platform: the client's repository and reads of the mirror. */
const hostGit = async (cwd, ...args) =>
  (
    await command('git', ['-C', cwd, ...args], {
      extraEnv: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  ).stdout

/**
 * The client's repository on its hosting: a bare repository with history and a tag, made from
 * `commits` ([message, { path: content }] in order).
 */
async function clientRepository(root, commits) {
  const tree = await mkdtemp(join(root, 'client-'))
  await hostGit(tree, 'init', '-q', '-b', 'main')
  for (const [message, files] of commits) {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(tree, name)), { recursive: true })
      await writeFile(join(tree, name), content)
    }
    await hostGit(tree, 'add', '-A')
    await hostGit(
      tree,
      '-c',
      'user.name=Клиент',
      '-c',
      'user.email=client@kolosok.example',
      'commit',
      '-q',
      '-m',
      message,
    )
  }
  await hostGit(tree, 'tag', 'v1', 'HEAD~1')
  const bare = join(root, 'kolosok', 'sait.git')
  await mkdir(dirname(bare), { recursive: true })
  await hostGit(root, 'clone', '-q', '--bare', tree, bare)
  await rm(tree, { recursive: true, force: true })
  return bare
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
/** A word of a shell command in single quotes. */
const shellWord = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

/**
 * The shell command of a turn of a chat with a repository: each check runs in order and the first
 * that fails prints its name and stops the command (the fixture names it); then the change.
 */
function repositoryCommand(checks, change = []) {
  return [
    'fail() { echo "raditi-check-failed:$1"; exit 1; }',
    'cd /workspace/repo || fail workdir',
    ...checks.map(([name, test]) => `{ ${test} ; } || fail ${name}`),
    ...change,
  ].join('\n')
}

/**
 * What a sandbox of a chat with a repository must be, whatever its turn (ПР12, ПР35, rule 5): gVisor
 * and the product's uid; one commit without history — the root the bundle carries, `sandboxBaseSha`
 * —, on the chat's branch, no remote, no tag, a clean tree; the files that look like secrets as the
 * stub of each (`hiddenFileStub`: a comment of its language, or the text); and no git credential
 * anywhere — none in git's settings, no credential file, no variable of git, no token of the form
 * of GitLab in the environment of any process, in any file the agent can read or in any object of
 * the repository. The prefix of the token is put together in the shell, so that the command
 * itself, which the session keeps, does not hold it.
 */
function sandboxChecks({ sandboxBaseSha, branch, hidden }) {
  return [
    ['kernel', 'uname -r | grep -qi gvisor'],
    ['uid', '[ "$(id -u)" = 10001 ]'],
    ['head', `[ "$(git rev-parse HEAD)" = ${sandboxBaseSha} ]`],
    ['history', '[ "$(git rev-list --all --count)" = 1 ] && [ -z "$(git log -1 --format=%P)" ]'],
    ['tags', '[ -z "$(git tag)" ]'],
    ['branch', `[ "$(git branch --show-current)" = ${shellWord(branch)} ]`],
    ['remote', '[ -z "$(git remote)" ]'],
    ['clean', '[ -z "$(git status --porcelain)" ]'],
    ...hidden.map((path) => [
      'stub',
      `[ "$(sha256sum < ${shellWord(path)} | cut -c1-64)" = ${sha256(hiddenFileStub(path))} ]`,
    ]),
    [
      'git-config',
      "! git config --list --show-origin 2>/dev/null | grep -Eiq 'credential|extraheader|insteadof|://[^/[:space:]]*@'",
    ],
    [
      'git-credentials',
      '[ ! -e "$HOME/.git-credentials" ] && [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/git/credentials" ]',
    ],
    [
      'git-env',
      '[ -z "${GIT_ASKPASS:-}${SSH_ASKPASS:-}${GIT_CONFIG_PARAMETERS:-}${GIT_CONFIG_COUNT:-}${GITLAB_TOKEN:-}${GITHUB_TOKEN:-}${CI_JOB_TOKEN:-}" ]',
    ],
    ['token-form', 'p="glp""at-"; [ -n "$p" ]'],
    [
      'token-environ',
      '( for e in /proc/[0-9]*/environ; do if tr "\\0" "\\n" < "$e" 2>/dev/null | grep -q "$p"; then exit 9; fi; done )',
    ],
    ['token-files', '! grep -rIlq --devices=skip "$p" /workspace /agent-home /tmp 2>/dev/null'],
    ['token-objects', '! git cat-file --batch-all-objects --batch | grep -aq "$p"'],
  ]
}

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
    if (realCli && interrupted && !cleaning) throw new Error('Verification interrupted')
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 250))
  }
}
// The turn journal's entries only: the dialog feed's `feed.*` rows share the table and carry no
// fence (the stand predates them).
const journal = async (taskId) =>
  (
    await db.taskEvent.findMany({
      where: { taskId, NOT: { type: { startsWith: 'feed.' } } },
      orderBy: { id: 'asc' },
    })
  ).map((row) => row.payload)
const phases = (entries, epoch) =>
  entries.filter((entry) => entry.fence.epoch === epoch).map((entry) => entry.phase)
const assignmentOf = (taskId, turn) =>
  db.turnAssignment.findFirst({
    where: { taskId, ...(turn === undefined ? {} : { turnNo: turn }) },
    orderBy: { firstEpoch: 'desc' },
  })
const leaseOf = (scope) => db.siteLease.findUnique({ where: { siteId: scope } })
/** The product row of a turn: its status follows the assignment's outcome and its reason. */
const taskTurnOf = (taskId, turn = 1) =>
  db.taskTurn.findUnique({ where: { taskId_turnNo: { taskId, turnNo: turn } } })
const turnContainers = async (label, value) =>
  lines(await docker('ps', '--all', '--quiet', '--filter', `label=${label}=${value}`))
const running = async (container) =>
  (await docker('inspect', '--format', '{{.State.Running}}', container)) === 'true'
const openGate = (container) =>
  docker('exec', '--user', '10001:10001', container, 'sh', '-c', `: > ${GATE}`)
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
    ['started', 'message', 'usage', 'completed'],
  )
}

/** Completed and removed; the chat's lease is free again. */
async function expectCompleted(taskId, turn) {
  const assignment = await assignmentOf(taskId, turn)
  assert.equal(assignment.outcome, 'completed')
  assert.equal(assignment.executor, 'runner')
  assert.equal(assignment.runnerId, runnerId)
  assert.equal((await leaseOf(taskId)).holderTaskId, null)
  assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', taskId), [])
  const taskTurn = await taskTurnOf(taskId, turn)
  assert.deepEqual([taskTurn.status, taskTurn.failureReason], ['completed', null])
  return assignment
}

/** The files of a turn's home archive: their names, each with its bytes. */
async function homeEntries(reference) {
  const loaded = await snapshots.load(reference)
  if (realCli) {
    // The persisted snapshot and journal may carry neither the old nor the new turn keys.
    // A checkpoint is its home alone.
    const bytes = [zstdDecompressSync(loaded.archives.home)]
    bytes.push(Buffer.from(JSON.stringify(loaded.manifest)))
    for (const values of turnCredentials.values())
      for (const secret of Object.values(values))
        assert(
          bytes.every((part) => !part.includes(secret)),
          'Snapshot contains a turn credential',
        )
  }
  const entries = new Map()
  const reader = extract()
  const listed = (async () => {
    for await (const entry of reader) {
      const chunks = []
      for await (const chunk of entry) chunks.push(chunk)
      entries.set(entry.header.name, Buffer.concat(chunks))
    }
  })()
  reader.end(zstdDecompressSync(loaded.archives.home))
  await listed
  return entries
}
const homeFiles = async (reference) => [...(await homeEntries(reference)).keys()]

/**
 * The agent's to-do list in the session of a checkpoint (docs/plan/89-agent-todos.md, §2): the
 * rows of the CLI's own table and the calls of its tool the history keeps, read from a private
 * copy of the session database and its WAL.
 */
async function todoState(reference) {
  const entries = await homeEntries(reference)
  const directory = await mkdtemp(join(tmpdir(), 'raditi-verify-todo-'))
  try {
    for (const file of opencodeHome.include)
      if (entries.has(file))
        await writeFile(join(directory, basename(file)), entries.get(file), { mode: 0o600 })
    const database = new DatabaseSync(join(directory, 'opencode.db'))
    try {
      return {
        rows: database.prepare('select count(*) as n from todo').get().n,
        calls: database
          .prepare("select count(*) as n from part where json_extract(data, '$.tool') = ?")
          .get('todowrite').n,
      }
    } finally {
      database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// --- Turns ---------------------------------------------------------------------------------------
/**
 * A chat (docs/plan/61-chats-first.md, §5.3): its id of version 7, and it leases by that id,
 * which is what its turns carry as their site (`leaseScopeOf`).
 */
async function createChat({ projectId, createdById } = {}) {
  const task = await db.task.create({
    data: {
      id: randomUUIDv7(),
      workspaceId: site.workspaceId,
      needsBrowser: false,
      // A chat of a project (docs/plan/84-projects.md, ПР2): its turns get the project's files and
      // repository; its lease is still its own id.
      ...(projectId ? { projectId, createdById } : {}),
    },
  })
  chats.push(task.id)
  return { taskId: task.id, sessionId: `verify-${randomBytes(6).toString('hex')}` }
}

function turnRequest(
  { taskId, sessionId },
  { turn, previous, gated, withoutRepository, compaction, repo },
) {
  const action = compaction ? 'compact' : withoutRepository?.action
  const context = {
    taskId,
    sessionId,
    turn,
    llm: {
      baseUrl: 'http://sandbox-gw.invalid',
      apiKey: `verify-llm-${randomBytes(16).toString('hex')}`,
      model: realCli ? 'glm-5.3' : 'synthetic',
      ...(realCli ? { reasoningEffort: turn === 1 ? firstEffort : 'high' } : {}),
    },
    mcp: {
      url: 'http://sandbox-gw.invalid/mcp',
      token: `verify-mcp-${randomBytes(16).toString('hex')}`,
    },
    // A turn with a repository has its section, as the planner writes it (ПР7, §4.4).
    instructions: `Synthetic runner verification\nRADITI_PLATFORM_TURN_${turn}${repo?.section ?? ''}`,
  }
  // A lone dash, then nearly the longest prompt the turn plan accepts, starting with a slash.
  const prompt =
    compaction?.prompt ??
    repo?.prompt ??
    withoutRepository?.prompt ??
    (realCli ? (turn === 1 ? '-' : `/init ${'я'.repeat(99_900)}`) : JSON.stringify({ gated }))
  if (realCli) {
    context.llm.baseUrl = 'http://sandbox-gw:8080/zai/v4'
    context.mcp.url = 'http://sandbox-gw:8080/mcp'
    const identity = {
      turn,
      llmKey: context.llm.apiKey,
      mcpKey: context.mcp.token,
      prompt,
      effort: context.llm.reasoningEffort,
    }
    if (action)
      fixture.addCompactionTurn({
        ...identity,
        ...(compaction?.fixture ?? withoutRepository.fixture),
      })
    else if (repo) fixture.addRepositoryTurn({ ...identity, id: taskId, ...repo.fixture })
    else if (withoutRepository?.attachments)
      fixture.addInboxTurn({ ...identity, ...withoutRepository.fixture })
    else if (withoutRepository) fixture.addRewindTurn({ ...identity, ...withoutRepository.fixture })
    else fixture.addTurn({ ...identity, model: context.llm.model })
  }
  turnCredentials.set(`${taskId}:${sessionId}:${turn}`, {
    llmApiKey: context.llm.apiKey,
    mcpToken: context.mcp.token,
  })
  return {
    sandbox: {
      image: images.sandbox,
      labels: {
        workspaceId: site.workspaceId,
        siteId: taskId,
        taskId,
        sessionId,
        turn,
      },
      runtime: 'runsc',
      resources: { cpu: 1, memoryMiB: realCli ? 1024 : 512, pids: 128 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'gateway', routes: ['llm', 'mcp'] },
      hardTimeoutMs: 10 * 60_000,
    },
    context,
    input: {
      prompt,
      attachments: withoutRepository?.attachments ?? [],
      ...(repo?.projectFiles ? { projectFiles: repo.projectFiles } : {}),
      ...(action ? { action } : {}),
    },
    driverVersion,
    // A turn names its repository exactly when it needs one (docs/plan/84-projects.md, §4.3).
    requirements: { repository: Boolean(repo), browser: false },
    ...(repo ? { repository: repo.block } : {}),
    committedAt: new Date().toISOString(),
    ...(previous ? { previous } : {}),
    ...(withoutRepository?.rewound ? { rewound: true } : {}),
  }
}

const reference = ({ sessionId }, turn, manifest) => ({
  workspaceId: site.workspaceId,
  sessionId,
  turn,
  image: images.sandbox,
  driver: { id: driverId, version: driverVersion },
  home: manifest?.home ?? opencodeHome,
})

// --- Main -----------------------------------------------------------------------------------------
const verified = []
const failures = []
const sessions = []
/** The chats without a project of this run: each is a lease scope of its own. */
const chats = []
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
/**
 * The provider's own sweep (host-firewall.mjs): drops the host rules of attempt bridges that no
 * longer exist and never the rule of a live attempt. A run interrupted between an attempt's
 * network and its container leaves such a rule; the next attempt anywhere on the VM sweeps it.
 */
const sweepFirewall = () =>
  docker(
    'run',
    '--rm',
    // As the provider runs it: in the host network namespace, which only runc gives.
    '--runtime',
    'runc',
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
    '/usr/local/bin/node',
    images.guard,
    '/usr/local/lib/raditi/host-firewall.mjs',
    'sweep',
  )
/** Short-lived host firewall helpers of runsc attempts carry no scope labels. */
const helpers = async () =>
  lines(await docker('ps', '--all', '--quiet', '--filter', 'label=io.raditi.gateway.role=firewall'))
let keyCreated = false
let driverCreated = false
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
  // Rules an interrupted run left behind would be swept by the first attempt of this one, and
  // the comparison at the end would take that for a change.
  await sweepFirewall()
  rulesBefore = await firewall()
  helpersBefore = await helpers()
  if (realCli) {
    fixture = await startOpencodeRunnerFixture()
    gatewayConfig.llmUpstream = `http://${hostAddress}:${fixture.port}`
    gatewayConfig.mcpUpstream = gatewayConfig.llmUpstream
  }

  work = await mkdtemp(join(tmpdir(), 'raditi-runner-verify-'))
  await mkdir(join(work, 'tmp'))
  port = await freePort()
  if (realCli) {
    // The trusted git of core (docs/plan/84-projects.md, ПР12, ПР33) for the chat with a
    // repository: git and gitleaks of this machine run by the git worker, its socket on the volume
    // of the mirrors — a path under the TMPDIR of macOS is longer than the 104 bytes of a socket's
    // address. The clients' repositories lie below `root`.
    await command('git', ['--version'])
    await command('gitleaks', ['version'])
    await mkdir(join(work, 'home'), { mode: 0o700 })
    await mkdir(join(work, 'repos'))
    const mirrorDir = await mkdtemp('/tmp/raditi-rv-')
    await chmod(mirrorDir, 0o700)
    gitSettings = { mirrorDir, root: join(work, 'repos') }
    gitWorker = await startGitWorker()
  }
  // A TaskTurn names its driver. A seeded database has the row; a migrated one gets it here.
  if (!(await db.agentDriver.findUnique({ where: { id: driverId } }))) {
    await db.agentDriver.create({
      data: { id: driverId, image: images.sandbox, capabilities: {}, enabled: false },
    })
    driverCreated = true
  }
  const workspace = await db.workspace.create({ data: { name: 'Synthetic runner verification' } })
  // The workspace of the chats of this run (no project: docs/plan/83-remove-projects.md).
  site = { workspaceId: workspace.id }
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
    const task = await createChat()
    sessions.push(task.sessionId)
    const first = await core.request('run', {
      request: turnRequest(task, { turn: 1, gated: false }),
    })
    assert.equal(first.result.client_message, 'Изменение готово к проверке.')
    assert.equal(first.manifest.git, undefined, 'A checkpoint holds no git')
    await expectCompleted(task.taskId, 1)
    const second = await core.request('run', {
      request: turnRequest(task, {
        turn: 2,
        previous: reference(task, 1, first.manifest),
        gated: false,
      }),
    })
    await expectCompleted(task.taskId, 2)
    const entries = await journal(task.taskId)
    assert(entries.some((entry) => entry.phase === 'restored' && entry.nativeSessionId))
    // The agent of turn 2 exits non-zero unless turn 1's session was restored.
    const files = await homeFiles(reference(task, 2, second.manifest))
    if (realCli) {
      assert.deepEqual(fixture.observations().problems, [], 'Fixture rejected a request')
      fixture.assertComplete()
      const nativeId = first.manifest.driver.nativeSessionId
      assert.match(nativeId, /^ses_[A-Za-z0-9]{20,40}$/)
      assert.equal(
        second.manifest.driver.nativeSessionId,
        nativeId,
        'The same native session resumes',
      )
      assert.deepEqual(second.manifest.home, opencodeHome)
      assert(
        files.includes(opencodeHome.include[1]) || files.includes(opencodeHome.include[0]),
        'The OpenCode session database was captured',
      )
      assert(
        files.every((file) => opencodeHome.include.includes(file)),
        'Only the OpenCode session database and its WAL are captured',
      )
      const firstAssignment = await assignmentOf(task.taskId, 1)
      const secondAssignment = await assignmentOf(task.taskId, 2)
      assert.notEqual(
        firstAssignment.containerId,
        secondAssignment.containerId,
        'Resume must use a new container',
      )
      assert.equal(firstAssignment.plan.context.llm.reasoningEffort, firstEffort)
      assert.equal(secondAssignment.plan.context.llm.reasoningEffort, 'high')
      for (const turn of [1, 2]) {
        const turnEntries = entries.filter((entry) => entry.turn === turn)
        const phaseNames = turnEntries.map((entry) => entry.phase)
        for (const phase of [
          'running',
          'output',
          'quiesced',
          'checkpointed',
          'destroyed',
          'completed',
        ])
          assert(phaseNames.includes(phase), `Turn ${turn} has no ${phase} evidence`)
        assert(!phaseNames.includes('publishing'), `Turn ${turn} published`)
        const events = turnEntries.flatMap((entry) => entry.events ?? [])
        for (const type of [
          'started',
          'reasoning',
          'command',
          'tool_call',
          'usage',
          'message',
          'completed',
        ])
          assert(
            events.some((event) => event.type === type),
            `${driverName} ${type} was not journaled`,
          )
      }
      const persisted = JSON.stringify([entries, firstAssignment, secondAssignment])
      for (const values of turnCredentials.values())
        for (const secret of Object.values(values))
          assert(!persisted.includes(secret), 'Journal or assignment contains a turn credential')
      await homeFiles(reference(task, 1, first.manifest))

      assert.deepEqual(fixture.observations().problems, [], 'Fixture rejected a request')
    } else {
      // The home of a turn is the session state the driver names and nothing the agent wrote
      // beside it: neither its log nor the configuration of the turn.
      assert.deepEqual(second.manifest.home, opencodeHome)
      assert.deepEqual([...files].sort(), [...opencodeHome.include].sort())
      // Turn 1's line came back by restore in each of the two session files, and turn 2 added
      // its own to both: a restore that brought back only one of them is not a restore.
      const kept = await homeEntries(reference(task, 2, second.manifest))
      for (const file of opencodeHome.include)
        assert.equal(kept.get(file).toString(), 'turn 1\nturn 2\n', file)
    }
    verified.push(
      `${realCli ? `real ${driverName} exec/resume, rotated keys and ${firstEffort} → high; ` : ''}full turns on runsc with restore of the previous snapshot, runner-sealed home through presigned PUT (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // The last request of a chat without a project undone (docs/plan/61-chats-first.md, §5.14): the
  // turn after it restores the snapshot the undone turn started from, not the one before it. That
  // is a snapshot two turns back, reached only by what the runner is given to fetch it, under a
  // lease of the chat's own id: production has no other executor for the first chat of a client.
  if (realCli) {
    const started = Date.now()
    const task = await createChat()
    sessions.push(task.sessionId)
    const words = [
      'raditi-rewind-kept-words',
      'raditi-rewind-undone-words',
      'raditi-rewind-next',
      'An action of the platform.',
      'raditi-after-compaction',
    ]
    const answers = [
      'Ответ raditi-rewind-kept',
      'Ответ raditi-rewind-undone',
      'Ответ next',
      undefined,
      'Ответ после сжатия',
    ]
    const chatTurn = (turn, { previous, rewound, remembered = [], forgotten = [], todos }) =>
      core.request('run', {
        request: turnRequest(task, {
          turn,
          previous,
          withoutRepository: {
            prompt: words[turn - 1],
            rewound,
            fixture: { answer: answers[turn - 1], remembered, forgotten, todos },
          },
        }),
      })
    const kept = [words[0], answers[0]]
    const undone = [words[1], answers[1]]
    // The agent's to-do list (docs/plan/89-agent-todos.md, 89.6): the first turn writes one with
    // the CLI's `todowrite` before it answers. What the runner parsed of that row reaches the
    // journal of core as one `todo_list` and no `tool_call`; the turns after it start with the
    // CLI's table empty and find the call only in the history of the session.
    const todoWord = 'raditi-todo-list-words'
    const todos = [
      { content: `Прочитать запрос ${todoWord}`, status: 'completed', priority: 'high' },
      { content: 'Подготовить ответ', status: 'in_progress', priority: 'medium' },
      { content: 'Проверить ответ', status: 'pending', priority: 'low' },
    ]
    const first = await chatTurn(1, { todos })
    assert.equal(first.result.client_message, answers[0], 'The turn with a list ends as before')
    {
      const events = (
        await db.taskEvent.findMany({
          where: { taskId: task.taskId, type: 'turn.output' },
          orderBy: { id: 'asc' },
        })
      )
        .filter((row) => row.payload.turn === 1)
        .flatMap((row) => row.payload.events ?? [])
      assert.deepEqual(
        events.filter((event) => event.type === 'todo_list' || event.type === 'tool_call'),
        [
          {
            type: 'todo_list',
            items: todos.map(({ content, status }) => ({ text: content, status })),
          },
        ],
        'The journal holds the list of the turn as one todo_list and no tool_call',
      )
    }
    const firstCheckpoint = reference(task, 1, first.manifest)
    const second = await chatTurn(2, {
      previous: firstCheckpoint,
      remembered: [...kept, todoWord],
    })
    await db.taskTurn.update({
      where: { taskId_turnNo: { taskId: task.taskId, turnNo: 2 } },
      data: { undoneAt: new Date() },
    })
    const third = await chatTurn(3, {
      previous: firstCheckpoint,
      rewound: true,
      remembered: [...kept, todoWord],
      forgotten: undone,
    })
    assert.equal(third.result.client_message, answers[2])
    fixture.assertRewindComplete()
    // The checkpoint of the turn that wrote the list holds its rows — the control of the reading;
    // the turns that went on from it wrote none, so what their sessions hold at the end they held
    // at the start: no row, and the call in the history.
    assert.deepEqual(
      await todoState(firstCheckpoint),
      { rows: todos.length, calls: 1 },
      'The session of the turn that wrote the list holds it',
    )
    for (const [turn, { manifest }] of [
      [2, second],
      [3, third],
    ])
      assert.deepEqual(
        await todoState(reference(task, turn, manifest)),
        { rows: 0, calls: 1 },
        `Turn ${turn} started with the to-do table of the CLI empty`,
      )

    // `/compact` on the runner (docs/plan/61-chats-first.md, §5.14): the session of the first three
    // turns goes into one summary, and the next turn goes on from it. The words of the first
    // turn reach the provider in the request of the summary and in none after it; the CLI keeps
    // the last turn as it is.
    const summary = 'raditi-compacted-summary'
    const compacted = await core.request('run', {
      request: turnRequest(task, {
        turn: 4,
        previous: reference(task, 3, third.manifest),
        withoutRepository: {
          prompt: words[3],
          action: 'compact',
          fixture: { summary, remembered: kept },
        },
      }),
    })
    assert.deepEqual(
      [compacted.result.change_type, compacted.result.files_changed],
      ['none', []],
      'A compaction changes nothing',
    )
    assert.match(compacted.result.client_message, /сжата/)
    assert.equal(compacted.manifest.driver.nativeSessionId, third.manifest.driver.nativeSessionId)
    const fifth = await chatTurn(5, {
      previous: reference(task, 4, compacted.manifest),
      remembered: [summary],
      forgotten: kept,
    })
    assert.equal(fifth.result.client_message, answers[4])
    fixture.assertRewindComplete(4)

    const entries = await journal(task.taskId)
    for (const turn of [1, 2, 3, 4, 5]) {
      const assignment = await assignmentOf(task.taskId, turn)
      assert.deepEqual(
        [assignment.outcome, assignment.executor, assignment.runnerId],
        ['completed', 'runner', runnerId],
      )
      assert.equal((await taskTurnOf(task.taskId, turn)).status, 'completed')
    }
    assert.deepEqual(
      entries
        .filter((entry) => entry.phase === 'restored' && entry.nativeSessionId)
        .map((entry) => entry.turn),
      [2, 3, 4, 5],
      'Every later turn restored a checkpoint on the runner',
    )
    const rewoundPlan = (await assignmentOf(task.taskId, 3)).plan
    assert.deepEqual([rewoundPlan.rewound, rewoundPlan.previous.turn], [true, 1])
    assert(entries.length > 0)
    for (const entry of entries)
      assert.equal(entry.fence.siteId, task.taskId, 'A chat without a project leases by its own id')
    for (const turn of [1, 2, 3, 4, 5]) {
      const { plan } = await assignmentOf(task.taskId, turn)
      assert.equal(plan.sandbox.labels.siteId, task.taskId)
    }
    assert.equal((await assignmentOf(task.taskId, 4)).plan.input.action, 'compact')
    const nativeId = first.manifest.driver.nativeSessionId
    assert.match(nativeId, /^ses_[A-Za-z0-9]{20,40}$/)
    assert.equal(second.manifest.driver.nativeSessionId, nativeId)
    assert.equal(third.manifest.driver.nativeSessionId, nativeId, 'The kept session goes on')
    for (const manifest of [first.manifest, second.manifest, third.manifest])
      assert.equal(manifest.git, undefined, 'A checkpoint without a repository holds no git')

    // What the sessions hold, read from the checkpoints core saved. The second is the control of
    // every search below: it finds the words and the answer of the undone turn where they were,
    // so that their absence from the third says something.
    const held = async (turn, manifest) =>
      Buffer.concat([...(await homeEntries(reference(task, turn, manifest))).values()])
    const control = await held(2, second.manifest)
    const session = await held(3, third.manifest)
    for (const text of [...kept, ...undone])
      assert(control.includes(text), 'The search reads a session')
    for (const text of [...kept, words[2], answers[2]])
      assert(session.includes(text), 'The session goes on from the first turn, with its own')
    for (const text of undone)
      assert(!session.includes(text), 'The session holds what the undone turn left')

    assert.equal((await leaseOf(task.taskId)).holderTaskId, null, 'The chat let its lease go')
    assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', task.taskId), [])
    verified.push(
      `real ${driverName} chat without a project: under the lease of its own id, turn 3 after an undone turn 2 restored the snapshot of turn 1 through the runner's links, the session and the provider know nothing of turn 2; the to-do list of turn 1 (todowrite, 3 items) reached the journal of core through the runner as one todo_list and no tool_call, and turns 2 and 3 started with the CLI's table empty and the call in the history; turn 4 compacted the session on the runner and turn 5 went on from its summary (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // A file of the client in a chat without a project (docs/plan/61-chats-first.md, К16, §8): it
  // leaves raditi-inbox only for a runner that asks by its place in an open prepare (`inboxFile`
  // of the API of runners), lands under /workspace/inbox, and the real CLI reads it with its own
  // tool. The address is outside the working copy: `external_directory` of the driver lets it in.
  if (realCli) {
    const started = Date.now()
    const task = await createChat()
    sessions.push(task.sessionId)
    const id = randomUUIDv7()
    const fileName = 'zametka-klienta.txt'
    const words = `raditi-inbox-${randomBytes(8).toString('hex')}`
    const content = Buffer.from(`${words}\nСинтетический файл клиента.\n`)
    const s3Key = attachmentKey(site.workspaceId, id)
    await storage.put('inbox', s3Key, content)
    const now = new Date()
    await db.attachment.create({
      data: {
        id,
        workspaceId: site.workspaceId,
        taskId: task.taskId,
        source: 'web',
        status: 'bound',
        s3Key,
        fileName,
        contentType: 'text/plain',
        sizeBytes: content.length,
        expiresAt: new Date(now.getTime() + 3_600_000),
        boundAt: now,
      },
    })
    const path = turnInboxPath(id, fileName)
    const answer = `В файле написано: ${words}`
    const prompt = 'raditi-inbox-read-the-file'
    const { result, manifest } = await core.request('run', {
      request: turnRequest(task, {
        turn: 1,
        withoutRepository: {
          prompt,
          attachments: [path],
          fixture: { path, words, answer },
        },
      }),
    })
    assert.equal(result.client_message, answer, 'The agent did not answer with the file')
    fixture.assertInboxComplete()
    const assignment = await assignmentOf(task.taskId, 1)
    assert.deepEqual(
      [assignment.outcome, assignment.executor, assignment.runnerId],
      ['completed', 'runner', runnerId],
    )
    // The plan is the stand's own (`turnRequest`): the planner's paths and labels are held by
    // turn-planner.test.ts; what this proves is the way of the file through the runner.
    const session = Buffer.concat([...(await homeEntries(reference(task, 1, manifest))).values()])
    assert(session.includes(answer), 'The search reads the session of the turn')
    assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', task.taskId), [])
    assert.equal((await leaseOf(task.taskId)).holderTaskId, null, 'The chat let its lease go')
    await storage.delete('inbox', s3Key)
    verified.push(
      `real ${driverName} file of a chat without a project: from raditi-inbox through the API of runners to /workspace/inbox, read by the CLI and answered with its content (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  // A chat of a project with a repository on the runner (docs/plan/84-projects.md, ПР8, ПР12,
  // ПР33, ПР35; §4.3, steps 3–8): the path of production. Each pass is prepared as the product
  // prepares it (RepoTurnPreparer in the stand's core): the main branch fetched into the mirror, the
  // base chosen — the chat's own ref once it published —, the files that look like secrets named
  // and the bundle built. The runner fetches the bundle and the files of the project from core's API
  // of runners; it uploads the candidate's parts back there; the trusted git of core commits them
  // through the git worker and publishes the commit into refs/raditi/<chat> of the mirror. Turn 2 is
  // killed with core between its checkpoint and its publication: the next core publishes it from
  // the snapshot's `patch` and `untracked`. Turn 3 starts from that commit.
  if (realCli) {
    const started = Date.now()
    const token = `glpat-${randomBytes(10).toString('hex')}`
    const readme = '# Пекарня «Колосок»\n\nСайт пекарни.\n'
    const files = {
      'README.md': readme,
      'index.html': '<h1>Колосок</h1>\n',
      // gitleaks flags it; `certs/site.key` is hidden by its name (ПР35).
      'config/old-settings.env': `GITLAB_TOKEN=${token}\n`,
      'certs/site.key': 'заглушка ключа сайта\n',
    }
    const bare = await clientRepository(gitSettings.root, [
      ['Первая версия', { 'README.md': '# Колосок\n', 'index.html': '<h1>Колосок</h1>\n' }],
      ['Описание и настройки', files],
    ])
    const mainSha = (await hostGit(bare, 'rev-parse', 'refs/heads/main')).trim()
    const user = await db.user.create({
      data: { name: 'Runner verification', email: `${randomUUID()}@runner-verify.example.ru` },
    })
    projectRows.users.push(user.id)
    const project = await db.project.create({
      data: {
        id: randomUUIDv7(),
        workspaceId: site.workspaceId,
        createdById: user.id,
        name: 'Пекарня «Колосок»',
      },
    })
    const projectRepositoryId = randomUUID()
    // An open link (`read`): the turn does not depend on the mode, the instructions do.
    await db.projectRepository.create({
      data: {
        id: projectRepositoryId,
        projectId: project.id,
        workspaceId: site.workspaceId,
        provider: 'gitlab',
        host: 'gitlab.localhost',
        path: 'kolosok/sait',
        webUrl: 'https://gitlab.localhost/kolosok/sait',
        defaultBranch: 'main',
        mode: 'read',
        mirrorState: 'ready',
        lastFetchedSha: mainSha,
      },
    })
    // The context of the project (ПР8): a text the client wrote and a table, in raditi-inbox.
    const context = {
      'menyu.md': `# Меню недели\nХлеб «Колосок» — raditi-project-${randomBytes(6).toString('hex')}\n`,
      'zametki/ceny.csv': 'позиция;цена\nбатон;90\n',
    }
    for (const [name, content] of Object.entries(context)) {
      const id = randomUUID()
      const key = projectFileKey(site.workspaceId, id)
      await storage.put('inbox', key, Buffer.from(content))
      projectRows.objects.push(key)
      await db.projectFile.create({
        data: {
          id,
          workspaceId: site.workspaceId,
          projectId: project.id,
          kind: name.endsWith('.md') ? 'text' : 'file',
          name,
          mediaType: name.endsWith('.md') ? 'text/markdown' : 'text/csv',
          sizeBytes: Buffer.byteLength(content),
          sha256: sha256(content),
          status: 'ready',
          s3Key: key,
        },
      })
    }
    const projectFiles = Object.keys(context).map((name) => turnProjectPath(name))
    const task = await createChat({ projectId: project.id, createdById: user.id })
    sessions.push(task.sessionId)
    const row = {
      projectId: project.id,
      projectRepositoryId,
      provider: 'gitlab',
      path: 'kolosok/sait',
      defaultBranch: 'main',
      mode: 'read',
      secretsFound: [],
    }
    const prepare = () => core.request('repoPrepare', { chatId: task.taskId, row, cloneUrl: bare })
    const chatRef = () => core.request('repoRef', { projectRepositoryId, chatId: task.taskId })
    const mirror = join(gitSettings.mirrorDir, 'repos', `${projectRepositoryId}.git`)
    const inMirror = (...args) => hostGit(work, '--git-dir', mirror, ...args)
    const show = async (sha, path) => inMirror('show', `${sha}:${path}`)
    /** The plan's repository and its section, as turn-planner.ts makes them of a prepared pass. */
    const planned = (prepared) => ({
      block: {
        projectId: project.id,
        projectRepositoryId,
        provider: 'gitlab',
        baseSha: prepared.baseSha,
        sandboxBaseSha: prepared.sandboxBaseSha,
        branch: prepared.branch,
        mode: 'read',
        expectedRef: prepared.expectedRef,
        bundleSha256: prepared.bundleSha256,
        bundleBytes: prepared.bundleBytes,
        hiddenPaths: [...prepared.hiddenPaths],
      },
      section: repositorySection({
        provider: 'gitlab',
        path: row.path,
        label: prepared.label,
        branch: prepared.branch,
        defaultBranch: 'main',
        baseSha: prepared.baseSha,
        mode: 'read',
        hiddenPaths: prepared.hiddenPaths,
      }),
      projectFiles,
    })
    const hidden = ['certs/site.key', 'config/old-settings.env']
    // Two kinds of stub (19.11.2026): the key keeps the text, the file of variables gets `#`.
    assert.equal(hiddenFileStub('certs/site.key'), HIDDEN_FILE_STUB)
    assert.match(hiddenFileStub('config/old-settings.env'), /^# .*\n# hidden: looks like a secret/)
    const projectChecks = (name) =>
      Object.entries(context).flatMap(([path, content]) => [
        [name, `[ "$(sha256sum < /workspace/project/${path} | cut -c1-64)" = ${sha256(content)} ]`],
        [`${name}-mode`, `[ "$(stat -c %a /workspace/project/${path})" = 444 ]`],
      ])
    const words = ['raditi-repo-first-words', 'raditi-repo-second-words', 'raditi-repo-third-words']
    const answers = [
      'Ответ raditi-repo-first',
      'Ответ raditi-repo-second',
      'Ответ raditi-repo-third',
    ]
    const lines = {
      readme: 'Доставка по городу — бесплатно от 1 000 ₽.',
      menu: 'Меню на неделю: батон, бородинский, булочки с маком.',
      hours: 'Работаем с 8 до 20 без выходных.',
      second: 'По пятницам — пироги с капустой.',
    }
    const repoTurn = (
      turn,
      prepared,
      { checks, change = [], changed, previous, remembered = [] },
    ) =>
      turnRequest(task, {
        turn,
        ...(previous ? { previous } : {}),
        repo: {
          ...planned(prepared),
          prompt: words[turn - 1],
          fixture: {
            answer: answers[turn - 1],
            command: repositoryCommand(
              [...sandboxChecks({ ...prepared, hidden }), ...checks],
              change,
            ),
            files: changed,
            remembered,
          },
        },
      })

    // Turn 1: a bundle of the head of main, without its history; the files of the project in
    // /workspace/project, read-only; the agent tries to change them, which must not last; it
    // changes the description and adds two files.
    const first = await prepare()
    assert.deepEqual(
      [first.baseSha, first.expectedRef, first.branch],
      [mainSha, null, `raditi/chat-${task.taskId.replaceAll('-', '').slice(-8)}`],
    )
    assert.deepEqual(first.hiddenPaths, hidden, 'gitleaks and the names hide the two files')
    assert.notEqual(first.sandboxBaseSha, mainSha, 'The sandbox gets a root commit of its own')
    const one = await core.request('run', {
      request: repoTurn(1, first, {
        checks: [
          ['readme', `[ "$(sha256sum < README.md | cut -c1-64)" = ${sha256(readme)} ]`],
          ...projectChecks('project'),
          ['project-readonly', `! ( printf x >> /workspace/project/menyu.md ) 2>/dev/null`],
        ],
        change: [
          // What the agent does to the files of the project does not last (ПР8): the next turn sees
          // them as the client left them.
          'chmod u+w /workspace/project/menyu.md 2>/dev/null; printf "агент был здесь\\n" >> /workspace/project/menyu.md 2>/dev/null; printf "agent\\n" > /workspace/project/agent-note.txt 2>/dev/null; true',
          `printf '%s\\n' ${shellWord(lines.readme)} >> README.md || fail change`,
          `printf '%s\\n' ${shellWord(lines.menu)} > menu.md || fail change`,
          `mkdir -p docs && printf '%s\\n' ${shellWord(lines.hours)} > docs/hours.md || fail change`,
        ],
        changed: ['README.md', 'menu.md', 'docs/hours.md'],
      }),
    })
    assert.equal(one.result.client_message, answers[0])
    await expectCompleted(task.taskId, 1)
    const head1 = one.repository?.headSha
    assert.match(head1 ?? '', /^[a-f0-9]{40}$/, 'Turn 1 published a commit')
    assert.deepEqual(
      [one.repository.baseSha, one.repository.refusal, one.repository.buildPaths],
      [mainSha, undefined, []],
    )
    // The snapshot names the candidate: its head, the base and the root the sandbox held.
    assert.deepEqual(
      [one.manifest.git.provider, one.manifest.git.branch, one.manifest.git.baseSha],
      ['gitlab', first.branch, mainSha],
    )
    assert.deepEqual(
      [one.manifest.git.sandboxBaseSha, one.manifest.git.headSha],
      [first.sandboxBaseSha, head1],
    )
    assert.equal(one.manifest.git.publication.taskId, task.taskId)
    // In the mirror under the chat's ref, through the git worker: one commit of the platform's bot
    // on main, with the three files and the hidden ones as the client has them.
    assert.equal(await chatRef(), head1)
    assert.equal(
      (await inMirror('rev-parse', `refs/raditi/${task.taskId}`)).trim(),
      head1,
      'The ref of the chat in the mirror',
    )
    assert.equal((await inMirror('log', '-1', '--format=%P', head1)).trim(), mainSha)
    assert.equal(
      (await inMirror('log', '-1', '--format=%an <%ae>', head1)).trim(),
      'Радити <noreply@raditi.ru>',
    )
    assert.deepEqual(
      (await inMirror('diff', '--name-only', mainSha, head1)).trim().split('\n').sort(),
      ['README.md', 'docs/hours.md', 'menu.md'],
    )
    assert.equal(await show(head1, 'README.md'), `${readme}${lines.readme}\n`)
    assert.equal(await show(head1, 'menu.md'), `${lines.menu}\n`)
    for (const path of hidden)
      assert.equal(await show(head1, path), files[path], `${path} is the client's, not the stub`)
    // The snapshot keeps the candidate: its patch, and an empty `untracked` — the new files belong
    // to the commit; the home is the session alone.
    const loaded1 = await snapshots.load(reference(task, 1, one.manifest))
    const patch1 = Buffer.from(one.repository.patch, 'base64')
    assert.deepEqual(Buffer.from(loaded1.archives.patch), patch1, 'The snapshot keeps the patch')
    for (const part of ['+++ b/menu.md', '+++ b/docs/hours.md', lines.readme])
      assert(patch1.toString().includes(part), part)
    assert.deepEqual(
      zstdDecompressSync(loaded1.archives.untracked),
      Buffer.alloc(1024),
      'An empty archive of untracked files',
    )
    for (const secret of [token, 'raditi-project-'])
      assert(
        !patch1.toString().includes(secret),
        'The patch holds no file of the project or secret',
      )
    const journal1 = (await journal(task.taskId)).filter((entry) => entry.turn === 1)
    const phases1 = journal1.map((entry) => entry.phase)
    assert(
      phases1.indexOf('publishing') > phases1.indexOf('destroyed') &&
        phases1.indexOf('destroyed') > phases1.indexOf('checkpointed'),
      'Turn 1 published after its checkpoint and the removal of its container',
    )

    // Turn 2: a bundle of the commit of turn 1, the session of turn 1 restored; core is killed
    // with SIGKILL right after the checkpoint is journaled, before the publication.
    const second = await prepare()
    assert.deepEqual([second.baseSha, second.expectedRef], [head1, head1])
    assert.notEqual(second.sandboxBaseSha, first.sandboxBaseSha)
    await core.request('crashAfter', { taskId: task.taskId, phase: 'checkpointed' })
    const killed = core.request('run', {
      request: repoTurn(2, second, {
        previous: reference(task, 1, one.manifest),
        remembered: [words[0], answers[0]],
        checks: [
          ['kept', `grep -qxF ${shellWord(lines.readme)} README.md`],
          ['kept', `[ "$(cat menu.md)" = ${shellWord(lines.menu)} ]`],
          ['kept', `[ "$(cat docs/hours.md)" = ${shellWord(lines.hours)} ]`],
          ...projectChecks('project-again'),
          ['project-agent-file', '[ ! -e /workspace/project/agent-note.txt ]'],
        ],
        change: [`printf '%s\\n' ${shellWord(lines.second)} >> menu.md || fail change`],
        changed: ['menu.md'],
      }),
    })
    killed.catch(() => {})
    await core.exited
    const left = await journal(task.taskId)
    assert.deepEqual(
      [left.at(-1).phase, left.at(-1).turn],
      ['checkpointed', 2],
      'core died right after the checkpoint of turn 2',
    )
    const { epoch } = left.at(-1).fence
    assert.equal(
      await inMirror('rev-parse', `refs/raditi/${task.taskId}`).then((ref) => ref.trim()),
      head1,
      'Not published yet',
    )
    core = await startCore()
    await waitFor(
      async () => (await assignmentOf(task.taskId, 2))?.outcome,
      'the next core to finish the publication of turn 2',
    )
    await expectCompleted(task.taskId, 2)
    const loaded2 = await snapshots.load(reference(task, 2))
    const head2 = loaded2.manifest.git.headSha
    assert.equal(await chatRef(), head2, 'The next core published the checkpoint of turn 2')
    assert.notEqual(head2, head1)
    assert.equal((await inMirror('log', '-1', '--format=%P', head2)).trim(), head1)
    assert.deepEqual((await inMirror('diff', '--name-only', head1, head2)).trim(), 'menu.md')
    assert.equal(await show(head2, 'menu.md'), `${lines.menu}\n${lines.second}\n`)
    assert(Buffer.from(loaded2.archives.patch).toString().includes(lines.second))
    assert.deepEqual(zstdDecompressSync(loaded2.archives.untracked), Buffer.alloc(1024))
    const recovered = (await journal(task.taskId)).filter(
      (entry) => entry.turn === 2 && entry.fence.epoch > epoch,
    )
    for (const phase of ['publishing', 'publication_recovered'])
      assert(
        recovered.some((entry) => entry.phase === phase),
        `Recovery journaled ${phase}`,
      )
    assert(
      recovered.every(
        (entry) => entry.recoveredFromEpoch === epoch && entry.candidateHeadSha === head2,
      ),
      'The publication was recovered from the checkpoint of the killed core',
    )

    // Turn 3: from the commit the next core published; it changes nothing, and nothing is published.
    const third = await prepare()
    assert.deepEqual([third.baseSha, third.expectedRef], [head2, head2])
    const three = await core.request('run', {
      request: repoTurn(3, third, {
        previous: reference(task, 2),
        remembered: [words[1], answers[1]],
        checks: [
          ['recovered', `grep -qxF ${shellWord(lines.second)} menu.md`],
          ['kept', `grep -qxF ${shellWord(lines.readme)} README.md`],
        ],
        changed: [],
      }),
    })
    assert.equal(three.result.client_message, answers[2])
    await expectCompleted(task.taskId, 3)
    assert.deepEqual(
      [
        three.repository.headSha,
        three.repository.refusal,
        Buffer.from(three.repository.patch, 'base64').length,
      ],
      [null, undefined, 0],
      'A turn without changes publishes nothing',
    )
    assert.deepEqual(
      [three.manifest.git.headSha, three.manifest.git.publication],
      [head2, undefined],
    )
    assert.equal(await chatRef(), head2)
    assert(
      !(await journal(task.taskId)).some(
        (entry) => entry.turn === 3 && entry.phase === 'publishing',
      ),
    )
    fixture.assertRepositoryComplete(task.taskId, 3)

    // Every turn ran on the runner, under the chat's own lease; no turn credential and no token of
    // the client's repository stayed in the journal or the assignments.
    const entries = await journal(task.taskId)
    for (const entry of entries) assert.equal(entry.fence.siteId, task.taskId)
    const assignments = []
    for (const turn of [1, 2, 3]) {
      const assignment = await assignmentOf(task.taskId, turn)
      assert.deepEqual([assignment.executor, assignment.runnerId], ['runner', runnerId])
      assert.equal(assignment.plan.repository.projectRepositoryId, projectRepositoryId)
      assignments.push(assignment)
    }
    const persisted = JSON.stringify([entries, assignments])
    assert(!persisted.includes(token), 'The token of the repository reached the journal')
    for (const values of turnCredentials.values())
      for (const secret of Object.values(values))
        assert(!persisted.includes(secret), 'Journal or assignment contains a turn credential')
    verified.push(
      `real ${driverName} chat of a project with a repository on the runner: a bundle without history in /workspace/repo with two files stubbed, the files of the project read-only in /workspace/project and as the client left them in the next turn, no git credential and no token of GitLab in the sandbox; turn 1 committed by core through the git worker into refs/raditi/<chat> of the mirror, its snapshot with the patch and an empty untracked part; turn 2 on a bundle of that commit with the session restored, core killed after its checkpoint, the next core published it from the snapshot's patch and untracked parts; turn 3 from that commit, nothing to publish (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  if (!realCli) {
    // 2. kill -9 of core during the output: a new core's recovery resumes the agent.
    {
      const started = Date.now()
      const task = await createChat()
      sessions.push(task.sessionId)
      const run = core.request('run', {
        request: turnRequest(task, { turn: 1, gated: true }),
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
      await waitFor(
        async () => (await assignmentOf(task.taskId)).outcome,
        'the resumed turn to end',
      )
      await expectCompleted(task.taskId, 1)
      const entries = await journal(task.taskId)
      expectEvents(entries)
      assert.deepEqual(phases(entries, resumed.fence.epoch).slice(-5), [
        'quiesced',
        'checkpointing',
        'checkpointed',
        'destroyed',
        'completed',
      ])
      assert(
        entries
          .filter((entry) => entry.fence.epoch === resumed.fence.epoch)
          .every((entry) => entry.recoveredFromEpoch === epoch),
      )
      // Core checks the resumed output with keys from the source; the runner kept its own.
      assert.equal(core.recovered, 1, 'Core recovered the credentials to check the output')
      const finished = await report({
        runnerSession: current.runnerSession,
        assignmentId: current.id,
        epoch: resumed.fence.epoch,
      })
      assert.deepEqual([finished.status, finished.body], [409, { error: 'LEASE_LOST' }])
      verified.push(
        `kill -9 of core during output: resumed from the journal cursor under epoch ${resumed.fence.epoch}, every event once, completed; stale epoch → 409 FENCE_SUPERSEDED, another session → 409 SESSION_RETIRED, a finished turn → 409 LEASE_LOST (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }

    // 3. kill -9 of the runner during the output: core gives the turn up, recovery removes it.
    {
      const started = Date.now()
      const task = await createChat()
      sessions.push(task.sessionId)
      const run = core.request('run', {
        request: turnRequest(task, { turn: 1, gated: true }),
      })
      run.catch(() => {})
      const { epoch, assignment } = await untilOutput(task.taskId)
      await killRunner(runner)
      assert(await running(assignment.containerId), 'The agent outlives the runner')
      runner = await startRunner()
      await assert.rejects(run, { code: 'RUNNER_UNAVAILABLE' })
      await waitFor(
        async () => (await assignmentOf(task.taskId)).outcome,
        'recovery to end the turn',
      )
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
      assert.equal((await leaseOf(task.taskId)).holderTaskId, null)
      assert.equal((await taskTurnOf(task.taskId)).status, 'lost')
      const zombie = await report({
        runnerSession: assignment.runnerSession,
        assignmentId: current.id,
        epoch: current.leaseEpoch,
      })
      assert.deepEqual([zombie.status, zombie.body], [409, { error: 'SESSION_RETIRED' }])
      verified.push(
        `kill -9 of the runner during output: the turn lost, its container removed through the restarted runner, the site freed only after that; the old session → 409 SESSION_RETIRED (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }

    // 4. kill -9 of core and of the runner: recovery resumes on the new runner session with the
    //    credentials the stand-in for P3 kept.
    {
      const started = Date.now()
      const task = await createChat()
      sessions.push(task.sessionId)
      const run = core.request('run', {
        request: turnRequest(task, { turn: 1, gated: true }),
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
      await waitFor(
        async () => (await assignmentOf(task.taskId)).outcome,
        'the resumed turn to end',
      )
      await expectCompleted(task.taskId, 1)
      expectEvents(await journal(task.taskId))
      verified.push(
        `kill -9 of core and the runner during output: resumed on the new runner session with recovered credentials, the old session → 409 SESSION_RETIRED, completed (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }

    // 5. Cancelled. A runner is bound to a turn only when its prepare is handed out, so a turn
    //    given up before that — its runner slot reserved, its key being issued — was never
    //    handed out: the site is free at once (spec §8, proof 1). Cancelled when a poll has just
    //    taken the prepare, there is no proof that no container is left: the site stays with
    //    the turn (vacating) until the late container is removed.
    {
      const started = Date.now()
      const early = await createChat()
      sessions.push(early.sessionId)
      await core.request('cancelAt', { taskId: early.taskId, point: 'issue' })
      // Resolves once the supervisor settled the turn: nothing is left to wait for.
      await assert.rejects(
        core.request('run', {
          request: turnRequest(early, { turn: 1, gated: true }),
        }),
        { code: 'TURN_INTERRUPTED', message: 'cancelled' },
      )
      assert.deepEqual(
        (await journal(early.taskId)).map((entry) => [entry.phase, entry.reason]),
        [
          ['leased', undefined],
          ['failed', 'cancelled'],
        ],
      )
      const unclaimed = await assignmentOf(early.taskId)
      assert.deepEqual(
        [unclaimed.outcome, unclaimed.runnerId, unclaimed.runnerSession, unclaimed.containerId],
        ['failed', null, null, null],
      )
      assert.equal((await leaseOf(early.taskId)).holderTaskId, null, 'The lease is free at once')
      assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', early.taskId), [])
      assert.equal((await taskTurnOf(early.taskId)).status, 'cancelled')

      const task = await createChat()
      sessions.push(task.sessionId)
      // The reserved slot was given back with the first turn: this one gets it.
      await core.request('cancelAt', { taskId: task.taskId, point: 'dispatch' })
      await assert.rejects(
        core.request('run', {
          request: turnRequest(task, { turn: 1, gated: true }),
        }),
        { code: 'TURN_INTERRUPTED', message: 'cancelled' },
      )
      // The prepare went out: the turn is its runner's. Creating a gateway and a sandbox takes
      // the runner seconds, and the site stays with the turn meanwhile.
      assert.equal((await assignmentOf(task.taskId)).runnerId, runnerId)
      let seen = false
      await waitFor(async () => {
        // The lease first: a container that exists after the site was freed breaks the rule.
        const lease = await leaseOf(task.taskId)
        const containers = await turnContainers('io.raditi.sandbox.taskId', task.taskId)
        if (containers.length > 0) {
          seen = true
          assert.equal(lease.holderTaskId, task.taskId, 'The site stays with the turn meanwhile')
        }
        // Freed only after the proof: `failed` follows the removal and precedes the release.
        if (lease.holderTaskId !== task.taskId)
          assert.equal((await journal(task.taskId)).at(-1).phase, 'failed')
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
      assert.equal((await leaseOf(task.taskId)).holderTaskId, null)
      assert.equal((await taskTurnOf(task.taskId)).status, 'cancelled')
      verified.push(
        `cancel before the prepare went out (a runner slot reserved, the key being issued): leased → failed, no runner bound, the site free at once; cancel when a poll took the prepare: vacating without a release, the late container removed through the runner, then the site freed${seen ? ' (held while the container was seen)' : ''} (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }

    // 6. core killed -9 right after the checkpoint is journaled, the runner killed too and kept
    //    away: recovery holds the lease and finishes nothing until the runner is back and the
    //    turn's container is removed through it.
    {
      const started = Date.now()
      const task = await createChat()
      sessions.push(task.sessionId)
      await core.request('crashAfter', { taskId: task.taskId, phase: 'checkpointed' })
      const run = core.request('run', {
        request: turnRequest(task, { turn: 1, gated: false }),
      })
      run.catch(() => {})
      await core.exited
      await killRunner(runner)
      const left = await journal(task.taskId)
      assert.equal(left.at(-1).phase, 'checkpointed')
      const { epoch } = left.at(-1).fence
      const { containerId } = await assignmentOf(task.taskId)
      const exists = async () =>
        (
          await dockerCommand(['inspect', '--format', '{{.Id}}', containerId], {
            allowFailure: true,
          })
        ).code === 0
      assert(await exists(), 'The container outlives core and the runner')
      core = await startCore()
      const awaiting = (entries) =>
        entries.filter((entry) => entry.phase === 'recovery' && entry.reason === 'awaiting_runner')
      await waitFor(
        async () => awaiting(await journal(task.taskId)).length > 0,
        'recovery to wait for the runner',
      )
      // Three more passes with the runner away change nothing.
      await new Promise((done) => setTimeout(done, 16_000))
      const waiting = await journal(task.taskId)
      assert.equal(awaiting(waiting).length, 1, 'The wait is journaled once')
      assert(waiting.every((entry) => entry.fence.epoch === epoch))
      const held = await leaseOf(task.taskId)
      assert.deepEqual(
        [held.holderTaskId, held.epoch, held.heldForOperator],
        [task.taskId, epoch, true],
      )
      const open = await assignmentOf(task.taskId)
      assert.deepEqual([open.outcome, open.recoveryAttempts], [null, 0])
      assert(await exists(), 'The container waits for the runner')
      runner = await startRunner()
      await waitFor(
        async () => (await assignmentOf(task.taskId)).outcome,
        'the checkpoint finished',
      )
      assert(!(await exists()), 'The container is removed')
      const done = await expectCompleted(task.taskId, 1)
      assert.equal(done.recoveryAttempts, 1)
      const entries = await journal(task.taskId)
      const recovered = entries.at(-1).fence.epoch
      assert.deepEqual(
        entries
          .filter((entry) => entry.fence.epoch > epoch)
          .map((entry) => [entry.phase, entry.containerId ?? null, entry.recoveredFromEpoch]),
        [
          ['checkpointed', null, epoch],
          ['destroyed', containerId, epoch],
          ['checkpoint_recovered', null, epoch],
        ],
      )
      verified.push(
        `kill -9 of core after the checkpoint with the runner away: the site held, one recovery{awaiting_runner}, no attempt and nothing finished over four passes; the returned runner removed the container by its id, then the checkpoint was finished under epoch ${recovered} (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }

    // 7. core killed -9 while the turn's key is issued: a runner slot is reserved in the dead
    //    core's memory, nothing binds the turn to the runner and no prepare went out. The next
    //    core's recovery closes the turn as one no runner took and frees the site at once — the
    //    turn's own deadline is ten minutes away.
    {
      const started = Date.now()
      const task = await createChat()
      sessions.push(task.sessionId)
      await core.request('crashAfter', { taskId: task.taskId, phase: 'issue' })
      const run = core.request('run', {
        request: turnRequest(task, { turn: 1, gated: false }),
      })
      run.catch(() => {})
      await core.exited
      const left = await assignmentOf(task.taskId)
      assert.deepEqual([left.outcome, left.runnerId, left.containerId], [null, null, null])
      assert.equal((await leaseOf(task.taskId)).holderTaskId, task.taskId)
      assert.deepEqual(phases(await journal(task.taskId), left.leaseEpoch), ['leased'])
      core = await startCore()
      await waitFor(
        async () => (await assignmentOf(task.taskId)).outcome,
        'recovery to close the turn no runner took',
        30_000,
      )
      const closed = await assignmentOf(task.taskId)
      assert.deepEqual(
        [closed.outcome, closed.runnerId, closed.recoveryAttempts],
        ['lost', null, 0],
      )
      const last = (await journal(task.taskId)).at(-1)
      assert.deepEqual([last.phase, last.reason, last.outcome], ['failed', 'run_failed', 'lost'])
      await waitFor(
        async () => (await leaseOf(task.taskId)).holderTaskId === null,
        'the site to be freed',
        10_000,
      )
      assert.deepEqual(await turnContainers('io.raditi.sandbox.taskId', task.taskId), [])
      assert.equal((await taskTurnOf(task.taskId)).status, 'lost')
      // The runner outlived core and takes the next turn from the new one: its slot was not lost.
      await runnerSession(core)
      verified.push(
        `kill -9 of core before the prepare went out (a runner slot reserved): the turn closed as lost with no runner bound, the site freed by the next core's first pass, ${Math.round((Date.now() - started) / 1000)} s after the kill instead of the turn's deadline`,
      )
    }
  }
  // Nothing of the turns is left in the VM: containers, gateway networks, host firewall rules.
  for (const scope of chats) {
    assert.deepEqual(await turnContainers('io.raditi.sandbox.siteId', scope), [])
    assert.deepEqual(await turnContainers('io.raditi.gateway.siteId', scope), [])
    assert.deepEqual(
      lines(
        await docker(
          'network',
          'ls',
          '--quiet',
          '--filter',
          `label=io.raditi.gateway.siteId=${scope}`,
        ),
      ),
      [],
    )
  }
  assert.deepEqual(await firewall(), rulesBefore)
  assert.deepEqual(await helpers(), helpersBefore)
  await core.request('close')
  await core.exited
  await docker('stop', '--time', '30', runner)
  succeeded = true
} catch (error) {
  failures.push(error)
  // Fixed labels only: what the fixture refused is why a turn of the real CLI failed.
  if (fixture?.observations().problems.length)
    failures.push(new Error(`The fixture refused: ${fixture.observations().problems.join('; ')}`))
} finally {
  cleaning = true
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
  if (fixture) await settle('model and MCP fixture', () => fixture.close())
  if (gitWorker) await settle('git worker', () => gitWorker.stop())
  for (const name of runners)
    await settle('runner', async () => {
      const owned = await dockerCommand(
        ['inspect', '--format', '{{index .Config.Labels "io.raditi.verify"}}', name],
        { allowFailure: true },
      )
      if (owned.code !== 0) {
        assert.match(owned.stderr, /No such (object|container)/)
        return
      }
      assert.equal(owned.stdout.trim(), runId, 'Runner container ownership changed')
      if (work) {
        const logs = await dockerCommand(['logs', name], { allowFailure: true })
        await writeFile(join(work, `${name}.log`), logs.stdout + logs.stderr)
      }
      await docker('rm', '--force', name)
    })
  if (site) {
    // Whatever a failed scenario left: removed through the provider, gateway and rule included.
    await settle('sandboxes', async () => {
      for (const scope of chats)
        for (const info of await sandboxes.list({ siteId: scope }))
          await (await sandboxes.getForRemoval(info.id))?.destroy('failed')
    })
    await settle('gateway leftovers', async () => {
      for (const scope of chats) {
        const left = await turnContainers('io.raditi.gateway.siteId', scope)
        if (left.length) await docker('rm', '--force', ...left)
        const networks = lines(
          await docker(
            'network',
            'ls',
            '--quiet',
            '--filter',
            `label=io.raditi.gateway.siteId=${scope}`,
          ),
        )
        if (networks.length) await docker('network', 'rm', ...networks)
      }
    })
    // The rule of a bridge removed just above, when no sandbox was there to be destroyed with it.
    await settle('orphaned firewall rules', () => sweepFirewall())
    await settle('database rows', async () => {
      // A failed run keeps the turns' journals next to the logs: phases, epochs and reasons.
      if (work && !succeeded) {
        const events = await db.taskEvent.findMany({
          where: { task: { workspaceId: site.workspaceId } },
          orderBy: { id: 'asc' },
        })
        const rows = events.map((row) => ({
          taskId: row.taskId,
          at: row.createdAt,
          ...row.payload,
        }))
        await writeFile(join(work, 'journal.json'), JSON.stringify(rows, null, 2))
      }
      await db.siteLease.deleteMany({ where: { siteId: { in: chats } } })
      await db.task.deleteMany({ where: { workspaceId: site.workspaceId } })
      // The project of the chat with a repository: its files and repository go with it.
      await db.project.deleteMany({ where: { workspaceId: site.workspaceId } })
      await db.workspace.delete({ where: { id: site.workspaceId } })
      if (projectRows.users.length)
        await db.user.deleteMany({ where: { id: { in: projectRows.users } } })
      if (driverCreated) await db.agentDriver.delete({ where: { id: driverId } })
    })
    await settle('snapshot objects', async () => {
      for (const sessionId of sessions)
        for (const turn of [1, 2, 3])
          for (const name of [
            'reservation.json',
            'manifest.json',
            ...Object.values(snapshotPartFiles),
          ])
            await storage.delete('sessions', `${turnSnapshotPrefix(sessionId, turn)}${name}`)
    })
    await settle('files of the project', async () => {
      for (const key of projectRows.objects) await storage.delete('inbox', key)
    })
    if (keyCreated)
      await settle('Vault key', async () => {
        await vault(`transit/keys/ws-${site.workspaceId}/config`, { deletion_allowed: true })
        await vault(`transit/keys/ws-${site.workspaceId}`, undefined, 'DELETE')
      })
  }
  await settle('token volume', () => docker('volume', 'rm', '--force', tokenVolume))
  // The mirrors, the bundles and the socket of the git worker: nothing of them outlives the run.
  if (gitSettings)
    await settle('mirrors', () => rm(gitSettings.mirrorDir, { recursive: true, force: true }))
  await settle('firewall rules', async () => assert.deepEqual(await firewall(), rulesBefore))
  await db.$disconnect()
  if (work && succeeded && cleanup.length === 0) await rm(work, { recursive: true, force: true })
  else if (work) console.error(`Logs of core and the runner are kept in ${work}`)
  failures.push(...cleanup)
  if (realCli) {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}
if (failures.length) throw new AggregateError(failures, 'Runner verification failed')
console.log(
  `PASS (runner ${runnerId}, gVisor):\n${verified.map((line) => `- ${line}`).join('\n')}\n- containers, gateway networks, host firewall rules, rows, objects, Vault key, token volume${gitSettings ? ', mirrors and the git worker' : ''} removed`,
)
