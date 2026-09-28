// The app VM edge end to end (spec §19): the production compose (infra/app/docker-compose.yml)
// with the real web, core, migrate and seed images, PostgreSQL and Redis, and Pebble instead of
// Let's Encrypt (verify/compose.verify.yml). Proves that Traefik gets real certificates and serves
// web over HTTPS; that core, its port 8081 and the runner API never show through the edge or to
// web; that the runner API is plain HTTP on the private address only, its token bound to the VM;
// that broken settings stop web; that the database roles and the Redis ACL hold; that the dump
// before a migration (dump-db.sh) brings the database back.
//
//   pnpm verify:edge [-- --no-build] [--keep] [--renewal] [--real-address]
//
//   --no-build      use raditi-verify/{web,orchestrator,migrate}:local as they are
//   --keep          leave the stack, its volumes and the temporary directory for a look
//   --renewal       plus the certificate renewal: a 30-minute certificate, ~15 more minutes
//   --real-address  Linux with "userland-proxy": false and sudo only (CI): the edge and the runner
//                   API on the host's own address, called by a client in its own network namespace;
//                   Traefik must forward and core must see that client's address
//
// Synthetic data only; the secrets are random, written to a temporary directory and removed.
// The output names the checks, never a secret. The results go to docs/plan/04-edge-verification.md.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Third-party images of the stack, pinned like env.example (images.test.mjs compares digests).
const TRAEFIK_IMAGE =
  'ghcr.io/traefik/traefik:v3.7.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259'
const POSTGRES_IMAGE =
  'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
const REDIS_IMAGE =
  'redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0'
const LOCAL = {
  web: 'raditi-verify/web:local',
  orchestrator: 'raditi-verify/orchestrator:local',
  migrate: 'raditi-verify/migrate:local',
}

const PROJECT = 'raditi-edge-verify'
const DOMAIN = 'raditi.test'
const PORTS = { http: 18080, https: 18443, runner: 18083, pebble: 15000 }
const UP_TIMEOUT_S = 180
// --real-address: a client outside the host. Docker masquerades every connection the host itself
// opens to a published port (the source becomes the bridge gateway), so only a client in its own
// network namespace, reaching the host over a veth pair, shows the real address.
const CLIENT = { netns: 'raditi-verify-client', host: '10.254.254.1', address: '10.254.254.2' }

const { values: options } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    'no-build': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    renewal: { type: 'boolean', default: false },
    'real-address': { type: 'boolean', default: false },
  },
})

const app = fileURLToPath(new URL('./', import.meta.url))
const repository = fileURLToPath(new URL('../../', import.meta.url))
const composeFiles = [join(app, 'docker-compose.yml'), join(app, 'verify/compose.verify.yml')]
// Docker Desktop has no journald: the production logging driver is kept wherever the host has it.
const localLogs = join(app, 'verify/compose.local-logs.yml')
const pebbleImage = /image: (ghcr\.io\/letsencrypt\/pebble:\S+)/.exec(
  await readFile(join(app, 'verify/compose.verify.yml'), 'utf8'),
)[1]

// Only the Docker CLI's own variables: the caller's APP_*, S3_* or .env must not leak in.
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)

// --- Processes ---------------------------------------------------------------------------------
/** Runs a command; a failure names the command, never its arguments (they may carry secrets). */
function command(
  binary,
  args,
  { allowFailure = false, input, timeoutMs, stdio = 'pipe', env = dockerEnv } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      stdio: stdio === 'inherit' ? ['pipe', 'inherit', 'inherit'] : 'pipe',
    })
    const out = []
    const err = []
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    const timer = timeoutMs && setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }
      if (result.code !== 0 && !allowFailure)
        reject(
          new Error(
            `${binary} ${args.slice(0, 2).join(' ')} failed (${result.code}): ${result.stderr.trim().split('\n').slice(-5).join(' | ')}`,
          ),
        )
      else resolve(result)
    })
    child.stdin.end(input)
  })
}
const docker = (args, opts) => command('docker', args, opts)
let envFile
const compose = (args, opts) =>
  docker(
    [
      'compose',
      '-p',
      PROJECT,
      ...composeFiles.flatMap((file) => ['-f', file]),
      '--env-file',
      envFile,
      ...args,
    ],
    opts,
  )
/** A command inside a running service; the caller checks the exit code. */
const inside = (service, args, opts) =>
  compose(['exec', '-T', service, ...args], { allowFailure: true, ...opts })

const sudo = (args, opts) => command('sudo', ['-n', ...args], opts)

/** The namespace and veth pair of the outside client; the veth goes away with the namespace. */
async function createOutsideClient() {
  await sudo(['ip', 'netns', 'del', CLIENT.netns], { allowFailure: true })
  const inNetns = (args) => sudo(['ip', 'netns', 'exec', CLIENT.netns, ...args])
  await sudo(['ip', 'netns', 'add', CLIENT.netns])
  await sudo(['ip', 'link', 'add', 'rvc-host', 'type', 'veth', 'peer', 'name', 'rvc-client'])
  await sudo(['ip', 'link', 'set', 'rvc-client', 'netns', CLIENT.netns])
  await sudo(['ip', 'address', 'add', `${CLIENT.host}/30`, 'dev', 'rvc-host'])
  await sudo(['ip', 'link', 'set', 'rvc-host', 'up'])
  await inNetns(['ip', 'address', 'add', `${CLIENT.address}/30`, 'dev', 'rvc-client'])
  await inNetns(['ip', 'link', 'set', 'rvc-client', 'up'])
  await inNetns(['ip', 'link', 'set', 'lo', 'up'])
  await inNetns(['ip', 'route', 'add', 'default', 'via', CLIENT.host])
}

/**
 * curl from the outside client. Headers go through a 0600 file (a token never reaches argv);
 * returns the status and the body.
 */
async function fromOutside(url, { method = 'GET', headers = {}, body, resolve, cacert } = {}) {
  const headerFile = join(work, `outside-headers-${randomUUID()}`)
  await writeFile(
    headerFile,
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\n`)
      .join(''),
    { mode: 0o600 },
  )
  try {
    const result = await sudo(
      [
        'ip',
        'netns',
        'exec',
        CLIENT.netns,
        'curl',
        '-sS',
        '--max-time',
        '15',
        '-X',
        method,
        '-H',
        `@${headerFile}`,
        ...(resolve ? ['--resolve', resolve] : []),
        ...(cacert ? ['--cacert', cacert] : []),
        ...(body === undefined ? [] : ['--data-binary', '@-']),
        '-w',
        '\n%{http_code}',
        url,
      ],
      { input: body },
    )
    const split = result.stdout.lastIndexOf('\n')
    return { status: Number(result.stdout.slice(split + 1)), body: result.stdout.slice(0, split) }
  } finally {
    await rm(headerFile, { force: true })
  }
}

// --- Network helpers ---------------------------------------------------------------------------
/**
 * The host's own IPv4 address: not loopback and not a Docker bridge, whose traffic to a published
 * port Docker masquerades.
 */
function hostAddress() {
  for (const [name, addresses] of Object.entries(networkInterfaces()))
    for (const address of addresses ?? [])
      if (
        address.family === 'IPv4' &&
        !address.internal &&
        !/^(docker|br-|veth|rdv-|rvc-)/.test(name)
      )
        return address.address
  return undefined
}

async function portIsFree(port, host = '127.0.0.1') {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
    return true
  } catch {
    return false
  } finally {
    server.close()
  }
}

/** One TLS handshake; `authorized` against `ca`. Never rejects on a bad certificate. */
function handshake({ host, port, servername, ca }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername,
      ca,
      rejectUnauthorized: false,
      timeout: 5000,
    })
    socket.once('secureConnect', () => {
      const result = {
        authorized: socket.authorized,
        error: socket.authorizationError,
        cert: socket.getPeerCertificate(true),
        protocol: socket.getProtocol(),
      }
      socket.end()
      resolve(result)
    })
    socket.once('timeout', () => socket.destroy(new Error('TLS handshake timed out')))
    socket.once('error', reject)
  })
}

/** An HTTP(S) request to the edge; the body is read as text. */
function request(url, { method = 'GET', headers = {}, host, port, servername, ca, body } = {}) {
  const target = new URL(url)
  const secure = target.protocol === 'https:'
  const client = secure ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: host ?? target.hostname,
        port: port ?? target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: { host: target.host, ...headers },
        ...(secure
          ? { servername: servername ?? target.hostname, ca, agent: false }
          : { agent: false }),
        timeout: 15_000,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
        response.on('error', reject)
      },
    )
    req.once('timeout', () => req.destroy(new Error('request timed out')))
    req.once('error', reject)
    req.end(body)
  })
}

/** The error code of a TCP connection attempt, or 'connected'. */
function tcpConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 5000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve('ETIMEDOUT')
    })
    socket.once('error', (error) => resolve(error.code))
  })
}

async function until(what, probe, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline)
      throw new Error(
        `${what}: not within ${timeoutMs / 1000} s${last ? ` (${last.message})` : ''}`,
      )
    await sleep(intervalMs)
  }
}

// --- Secrets and settings ----------------------------------------------------------------------
const hex = (bytes = 24) => randomBytes(bytes).toString('hex')
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const dotenv = (entries) =>
  `${Object.entries(entries)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`
// app.env as the Vault template must write it (README.md «Секреты»): every value double-quoted.
const appEnv = (entries) =>
  `${Object.entries(entries)
    .map(([name, value]) => `${name}="${value}"`)
    .join('\n')}\n`

function secrets() {
  const pg = { superuser: hex(), owner: hex(), web: hex(), core: hex() }
  const redis = { web: hex(), core: hex(), health: hex() }
  const pair = randomBytes(15).toString('base64url') // 20 characters shared by the captcha keys
  // With `#`: an unquoted value would be cut there by node --env-file, and check 3b would fail.
  const metricsToken = `${hex(16)}#${hex(16)}`
  const s3 = { S3_ACCESS_KEY_ID: `verify-${hex(8)}`, S3_SECRET_ACCESS_KEY: hex() }
  const vault = { VAULT_ROLE_ID: randomUUID(), VAULT_SECRET_ID: randomUUID() }
  const web = {
    DATABASE_URL: `postgresql://raditi_web:${pg.web}@postgres:5432/raditi`,
    REDIS_URL: `redis://web:${redis.web}@redis:6379`,
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64'),
    SMARTCAPTCHA_CLIENT_KEY: `ysc1_${pair}${hex(10)}`,
    SMARTCAPTCHA_SERVER_KEY: `ysc2_${pair}${hex(10)}`,
    ...s3,
    ...vault,
    METRICS_TOKEN: metricsToken,
  }
  const core = {
    DATABASE_URL: `postgresql://raditi_core:${pg.core}@postgres:5432/raditi`,
    REDIS_URL: `redis://core:${redis.core}@redis:6379`,
    ...s3,
    ...vault,
    METRICS_TOKEN: metricsToken,
    SENDSAY_API_KEY: hex(16),
  }
  const acl = (user) =>
    `user ${user} on #${sha256(redis[user])} ~* &* +@all -@admin -flushall -flushdb -keys -swapdb`
  const files = {
    'web/app.env': appEnv(web),
    'core/app.env': appEnv(core),
    'migrate/app.env': appEnv({
      DATABASE_URL: `postgresql://raditi:${pg.owner}@postgres:5432/raditi`,
    }),
    'postgres/superuser-password': pg.superuser,
    'postgres/owner-password': pg.owner,
    'postgres/web-password': pg.web,
    'postgres/core-password': pg.core,
    'redis/users.acl': [
      'user default off',
      acl('web'),
      acl('core'),
      `user health on #${sha256(redis.health)} -@all +ping`,
      '',
    ].join('\n'),
    'redis/health-password': redis.health,
  }
  const { BETTER_AUTH_SECRET: _, ...broken } = web
  return {
    pg,
    redis,
    metricsToken,
    files,
    broken,
    values: [
      ...Object.values(pg),
      ...Object.values(redis),
      ...Object.values(web),
      ...Object.values(core),
    ],
  }
}

/** Every file readable by the containers: on Linux their uids are not the owner's (A.13). */
async function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true, mode: 0o755 })
    await writeFile(file, content, { mode: 0o644 })
    await chmod(join(file, '..'), 0o755)
  }
}

// --- Checks ------------------------------------------------------------------------------------
let passed = 0
async function check(name, run) {
  try {
    await run()
  } catch (error) {
    console.log(`FAIL ${name}`)
    throw error
  }
  passed += 1
  console.log(`ok   ${name}`)
}

// --- Run ---------------------------------------------------------------------------------------
const realAddress = options['real-address']
const lanAddress = hostAddress()
if (realAddress) assert(lanAddress, '--real-address needs a non-loopback IPv4 address')
const edgeHost = realAddress ? lanAddress : '127.0.0.1'
const runnerHost = realAddress ? lanAddress : '127.0.0.1'
const runnerTokens = {
  // Bound to an address no request here comes from: a valid token from elsewhere opens nothing.
  foreign: `rnr_verify-1.${randomBytes(32).toString('base64url')}`,
  own: `rnr_verify-2.${randomBytes(32).toString('base64url')}`,
}

let work
let started = false
async function cleanup() {
  if (options.keep) {
    if (work) console.log(`kept: project ${PROJECT}, directory ${work}`)
    return
  }
  if (started) {
    await compose(
      ['--profile', 'ops', 'down', '--volumes', '--remove-orphans', '--timeout', '10'],
      { allowFailure: true },
    )
    await docker(['volume', 'rm', ...['acme', 'pgdata', 'redis'].map((v) => `${PROJECT}-${v}`)], {
      allowFailure: true,
    })
  }
  if (realAddress) await sudo(['ip', 'netns', 'del', CLIENT.netns], { allowFailure: true })
  if (work) await rm(work, { recursive: true, force: true })
}

process.once('SIGINT', () => {
  console.error('verify:edge: interrupted')
  void cleanup().finally(() => process.exit(130))
})

let exitCode = 0
try {
  // 1. Preconditions
  await docker(['version', '--format', '{{.Server.Version}}'])
  for (const port of Object.values(PORTS))
    assert(await portIsFree(port), `port ${port} on 127.0.0.1 is busy`)
  // The checks read the logs back (docker compose logs): journald must take and give them.
  const probe = `${PROJECT}-journald`
  await docker(['rm', '-f', probe], { allowFailure: true })
  const wrote = await docker(
    [
      'run',
      '--name',
      probe,
      '--network',
      'none',
      '--log-driver',
      'journald',
      '--entrypoint',
      'echo',
      REDIS_IMAGE,
      'journald-probe',
    ],
    { allowFailure: true },
  )
  const read = wrote.code === 0 && (await docker(['logs', probe], { allowFailure: true }))
  await docker(['rm', '-f', probe], { allowFailure: true })
  if (!read || !read.stdout.includes('journald-probe')) {
    // The Linux run is the one that proves the production logging driver (edge.yml).
    assert(!realAddress, '--real-address: the daemon cannot log to journald')
    console.log('warning: the daemon cannot log to journald; the stack logs with the local driver')
    composeFiles.push(localLogs)
  }
  const dirty = await command('git', ['-C', repository, 'status', '--porcelain'], {
    allowFailure: true,
  })
  if (dirty.stdout.trim() && !options['no-build'])
    console.log(
      'warning: the working tree is not clean; uncommitted changes go into the local images',
    )

  // 2. Images
  if (!options['no-build']) {
    for (const [file, target, tag] of [
      ['apps/web/Dockerfile', 'runtime', LOCAL.web],
      ['apps/orchestrator/Dockerfile', 'runtime', LOCAL.orchestrator],
      ['apps/orchestrator/Dockerfile', 'migrate', LOCAL.migrate],
    ]) {
      console.log(`build ${tag}`)
      await docker(
        ['build', '-f', join(repository, file), '--target', target, '-t', tag, repository],
        { stdio: 'inherit' },
      )
    }
  }

  // 3. The temporary directory: routes, Pebble's trust and profile, secrets, compose settings
  work = await mkdtemp(join(tmpdir(), 'raditi-edge-'))
  await chmod(work, 0o755)
  await mkdir(join(work, 'dynamic'), { mode: 0o755 })
  for (const dir of [join(app, 'traefik/dynamic'), join(app, 'verify/dynamic')])
    for (const name of await readdir(dir))
      if (name.endsWith('.yml')) await copyFile(join(dir, name), join(work, 'dynamic', name))
  const pebbleBox = (await docker(['create', pebbleImage])).stdout.trim()
  try {
    const { stdout } = await docker(['cp', `${pebbleBox}:/test/certs/pebble.minica.pem`, '-'])
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/.exec(stdout)?.[0]
    assert(pem, 'minica.pem is missing from the Pebble image')
    await writeFile(join(work, 'minica.pem'), pem, { mode: 0o644 })
  } finally {
    await docker(['rm', pebbleBox], { allowFailure: true })
  }
  const pebbleConfig = JSON.parse(await readFile(join(app, 'verify/pebble.json'), 'utf8'))
  if (options.renewal) pebbleConfig.pebble.profiles.default.validityPeriod = 1800
  await writeFile(join(work, 'pebble.json'), JSON.stringify(pebbleConfig, null, 2), { mode: 0o644 })
  const secret = secrets()
  await writeTree(join(work, 'secrets'), secret.files)
  await writeTree(join(work, 'secrets-broken'), { 'web/app.env': appEnv(secret.broken) })
  const tokenEntries = [`verify-1:${sha256(runnerTokens.foreign)}@10.0.0.1`]
  if (realAddress) tokenEntries.push(`verify-2:${sha256(runnerTokens.own)}@${CLIENT.address}`)
  envFile = join(work, 'compose.env')
  await writeFile(
    envFile,
    dotenv({
      APP_DOMAIN: DOMAIN,
      APP_REVISION: 'verify',
      APP_PRIVATE_IP: runnerHost,
      RUNNER_API_PUBLISH: PORTS.runner,
      ACME_EMAIL: 'verify@raditi.test',
      ACME_CA_SERVER: 'https://pebble:14000/dir',
      ACME_STORAGE_FILE: 'acme.json',
      ACME_CERT_HOURS: options.renewal ? 1 : 2160,
      EDGE_HTTP: `127.0.0.1:${PORTS.http}`,
      EDGE_HTTPS: `${edgeHost}:${PORTS.https}`,
      SECRETS_DIR: join(work, 'secrets'),
      VERIFY_DIR: work,
      VOLUME_PREFIX: PROJECT,
      BRIDGE_PREFIX: 'rdv',
      COMPOSE_PROFILES: '',
      WEB_IMAGE: LOCAL.web,
      ORCHESTRATOR_IMAGE: LOCAL.orchestrator,
      MIGRATE_IMAGE: LOCAL.migrate,
      TRAEFIK_IMAGE,
      POSTGRES_IMAGE,
      REDIS_IMAGE,
      SANDBOX_IMAGE_PREFIX: 'raditi-verify/agent',
      RUNNER_TOKENS: tokenEntries.join(','),
      S3_ENDPOINT: 'https://s3.invalid',
      S3_REGION: 'ru-central1',
      S3_RUNNER_ENDPOINT: '',
      VAULT_ADDR: 'https://vault.invalid:8200',
    }),
    { mode: 0o644 },
  )

  // 4. The stack: Pebble first, so that Traefik's first orders find it; then the explicit
  // migration and seeds; then everything `up` starts in production.
  for (const volume of ['acme', 'pgdata', 'redis'])
    await docker(['volume', 'create', `${PROJECT}-${volume}`])
  started = true
  await compose(['up', '-d', 'pebble', 'challtestsrv'])
  const minica = await readFile(join(work, 'minica.pem'), 'utf8')
  const pebbleRoot = await until(
    'Pebble answers',
    async () => {
      const root = await request(`https://localhost:${PORTS.pebble}/roots/0`, {
        host: '127.0.0.1',
        ca: [minica],
      })
      return root.status === 200 && root.body
    },
    60_000,
  )
  const ca = [pebbleRoot]
  const caFile = join(work, 'pebble-root.pem')
  await writeFile(caFile, pebbleRoot)
  if (realAddress) await createOutsideClient()
  try {
    await compose(['--profile', 'ops', 'run', '--rm', 'migrate'])
    await compose(['--profile', 'ops', 'run', '--rm', 'seed'])
    await compose(['up', '-d', '--wait', '--wait-timeout', String(UP_TIMEOUT_S)])
  } catch (error) {
    console.log((await compose(['ps', '--all'], { allowFailure: true })).stdout)
    console.log((await compose(['logs', '--tail=200'], { allowFailure: true })).stdout)
    throw error
  }

  const edge = (name, path = '/', init = {}) =>
    request(`https://${name}${path}`, { host: edgeHost, port: PORTS.https, ca, ...init })
  const served = (servername) =>
    until(
      `certificate of ${servername}`,
      async () => {
        const result = await handshake({ host: edgeHost, port: PORTS.https, servername, ca })
        return result.authorized && result.cert
      },
      120_000,
    )
  const issued = async () =>
    ((await compose(['logs', 'pebble'])).stdout.match(/Issued certificate serial/g) ?? []).length

  // 5. Checks
  let apex
  await check('1. TLS raditi.test: a Pebble certificate for the apex only', async () => {
    apex = await served(DOMAIN)
    assert.match(apex.issuer.CN, /^Pebble Intermediate/)
    assert.equal(apex.subjectaltname, `DNS:${DOMAIN}`)
  })
  await check('1b. TLS www.raditi.test: its own certificate', async () => {
    const www = await served(`www.${DOMAIN}`)
    assert.equal(www.subjectaltname, `DNS:www.${DOMAIN}`)
    assert.notEqual(www.serialNumber, apex.serialNumber)
  })
  await served(`echo.${DOMAIN}`)

  await check(
    '2. GET https://raditi.test/: web answers over HTTPS with its security headers',
    async () => {
      const page = await edge(DOMAIN)
      assert.equal(page.status, 200)
      assert.match(page.headers['content-type'], /^text\/html/)
      assert.match(page.body, /Радити/)
      assert.match(page.headers['strict-transport-security'], /max-age=\d+/)
    },
  )
  await check('3. /api/health: only the status without the token', async () => {
    const health = await edge(DOMAIN, '/api/health')
    assert.ok([200, 503].includes(health.status), `status ${health.status}`)
    assert.deepEqual(Object.keys(JSON.parse(health.body)), ['status'])
  })
  /** web and core reach PostgreSQL and Redis under their own roles and users. */
  const dataReachable = async () => {
    const web = await edge(DOMAIN, '/api/health', {
      headers: { authorization: `Bearer ${secret.metricsToken}` },
    })
    const webChecks = JSON.parse(web.body).checks
    assert.equal(webChecks.database, 'ok')
    assert.equal(webChecks.redis, 'ok')
    // The token reaches node through the environment of exec, never its output
    const core = await inside('core', [
      'env',
      `T=${secret.metricsToken}`,
      'node',
      '-e',
      "fetch('http://127.0.0.1:8081/health', { headers: { authorization: 'Bearer ' + process.env.T } }).then(async (r) => console.log(JSON.stringify((await r.json()).checks)))",
    ])
    const coreChecks = JSON.parse(core.stdout.trim().split('\n').at(-1))
    assert.equal(coreChecks.database, 'ok')
    assert.equal(coreChecks.redis, 'ok')
  }
  await check('3b. web and core work under their own database roles and Redis users', dataReachable)
  await check('4. http:// redirects to https:// on 443, without a port', async () => {
    const answer = await request(`http://${DOMAIN}:${PORTS.http}/x?y=1`, { host: '127.0.0.1' })
    assert.ok([301, 308].includes(answer.status), `status ${answer.status}`)
    assert.equal(answer.headers.location, `https://${DOMAIN}/x?y=1`)
  })
  await check('5. www redirects to the apex', async () => {
    const answer = await edge(`www.${DOMAIN}`, '/x')
    assert.ok([301, 308].includes(answer.status), `status ${answer.status}`)
    assert.equal(answer.headers.location, `https://${DOMAIN}/x`)
  })
  await check('6. no handshake for an unknown name or without SNI (sniStrict)', async () => {
    await assert.rejects(
      handshake({ host: edgeHost, port: PORTS.https, servername: 'nope.test', ca }),
    )
    await assert.rejects(handshake({ host: edgeHost, port: PORTS.https, ca }))
  })
  await check('7. /api/metrics is refused at the edge, even with the token', async () => {
    for (const name of [DOMAIN, `www.${DOMAIN}`]) {
      const answer = await edge(name, '/api/metrics', {
        headers: { authorization: `Bearer ${secret.metricsToken}` },
      })
      assert.equal(answer.status, 403, name)
    }
  })
  await check('8. forwarded headers: the client cannot forge X-Forwarded-For', async () => {
    const answer = await edge(`echo.${DOMAIN}`, '/', {
      headers: { 'x-forwarded-for': '203.0.113.9', x_forwarded_for: '198.51.100.7' },
    })
    assert.equal(answer.status, 200)
    const forwarded = answer.body.split('\n').filter((line) => /^x-forwarded-for:/i.test(line))
    assert.equal(forwarded.length, 1)
    assert.match(forwarded[0], /^X-Forwarded-For: [0-9a-f.:]+\r?$/i)
    assert.doesNotMatch(answer.body, /203\.0\.113\.9|198\.51\.100\.7|X_Forwarded_For/i)
    assert.match(answer.body, /^X-Forwarded-Proto: https\r?$/im)
  })
  if (realAddress)
    await check('8b. Traefik forwards the real client address (userland-proxy off)', async () => {
      const answer = await fromOutside(`https://echo.${DOMAIN}:${PORTS.https}/`, {
        resolve: `echo.${DOMAIN}:${PORTS.https}:${lanAddress}`,
        cacert: caFile,
      })
      assert.equal(answer.status, 200)
      assert.match(
        answer.body,
        new RegExp(`^X-Forwarded-For: ${CLIENT.address.replaceAll('.', '\\.')}\\r?$`, 'im'),
      )
    })
  await check('9. core never shows through the edge', async () => {
    const answers = [
      await edge(DOMAIN, '/runner/v1/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      await edge(DOMAIN, '/health'),
      await edge(DOMAIN, '/metrics'),
      await edge(DOMAIN, '/health', { headers: { host: 'core' } }),
      await edge(DOMAIN, '/health', { headers: { host: 'core:8081' } }),
    ]
    for (const answer of answers) {
      assert.ok([403, 404, 421].includes(answer.status), `status ${answer.status}`)
      assert.doesNotMatch(answer.body, /"error":"UNAUTHORIZED"|^\{"status":/)
    }
  })
  await check('10. no dashboard and no API of Traefik', async () => {
    for (const path of ['/dashboard/', '/dashboard', '/api/rawdata', '/api/http/routers']) {
      let answer = await edge(DOMAIN, path)
      // Next drops a trailing slash with a redirect on the same host
      if ([301, 308].includes(answer.status) && answer.headers.location?.startsWith('/'))
        answer = await edge(DOMAIN, answer.headers.location)
      assert.equal(answer.status, 404, path)
      assert.doesNotMatch(answer.body, /"routers"|traefik/i, path)
    }
  })
  await check('11. from Traefik: core, PostgreSQL and Redis do not even resolve', async () => {
    for (const target of ['core:8081/health', 'core:8083/', 'postgres:5432/', 'redis:6379/']) {
      const answer = await inside('traefik', ['wget', '-T', '3', '-qO-', `http://${target}`])
      assert.notEqual(answer.code, 0, target)
      assert.match(answer.stdout + answer.stderr, /bad address/, target)
    }
  })
  await check('11b. web and core do not see each other', async () => {
    // Docker's resolver passes an unknown name on to the host's DNS: `web` is also a TLD, which
    // may answer 127.0.53.53. What matters: never the other container's address, never reached.
    const addresses = async (service) => {
      const [id] = (await compose(['ps', '-q', service])).stdout.split('\n')
      const [container] = JSON.parse((await docker(['inspect', id])).stdout)
      return Object.values(container.NetworkSettings.Networks).map((network) => network.IPAddress)
    }
    for (const [from, to, url] of [
      ['core', 'web', 'http://web:3000/'],
      ['web', 'core', 'http://core:8081/health'],
      ['web', 'core', 'http://core:8083/'],
    ]) {
      const targets = await addresses(to)
      const resolved = (await inside(from, ['getent', 'hosts', to])).stdout.split(/\s+/)
      assert.ok(!resolved.some((address) => targets.includes(address)), `${from} resolves ${to}`)
      const answer = await inside(from, [
        'node',
        '-e',
        `fetch(${JSON.stringify(url)}).then(() => console.log('reached'), (e) => console.log(e.cause?.code ?? e.message))`,
      ])
      assert.match(answer.stdout.trim(), /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED)$/, `${from} → ${url}`)
    }
  })
  await check(
    '12. published ports: the edge, the runner API on the private address, Pebble',
    async () => {
      const ids = (
        await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`])
      ).stdout
        .split('\n')
        .filter(Boolean)
      const containers = JSON.parse((await docker(['inspect', ...ids])).stdout)
      const published = {}
      for (const container of containers) {
        const service = container.Config.Labels['com.docker.compose.service']
        for (const [port, bindings] of Object.entries(container.HostConfig.PortBindings ?? {}))
          for (const binding of bindings ?? [])
            (published[service] ??= []).push(`${binding.HostIp}:${binding.HostPort}->${port}`)
      }
      for (const list of Object.values(published)) list.sort()
      assert.deepEqual(published, {
        traefik: [
          `127.0.0.1:${PORTS.http}->8000/tcp`,
          `${edgeHost}:${PORTS.https}->8443/tcp`,
        ].sort(),
        core: [`${runnerHost}:${PORTS.runner}->8083/tcp`],
        pebble: [`127.0.0.1:${PORTS.pebble}->15000/tcp`],
      })
    },
  )
  const runnerApi = (path, token, body) =>
    request(`http://${runnerHost}:${PORTS.runner}/runner/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const poll = { runnerSession: randomUUID() }
  await check(
    '13. the runner API answers plain HTTP on the private address; a wrong token gets 401',
    async () => {
      const answer = await runnerApi(
        'poll',
        `rnr_verify-1.${randomBytes(32).toString('base64url')}`,
        poll,
      )
      assert.equal(answer.status, 401)
      assert.equal(answer.headers['content-type'], 'application/json')
      assert.deepEqual(JSON.parse(answer.body), { error: 'UNAUTHORIZED' })
    },
  )
  await check('13b. a valid token from another address gets 401', async () => {
    const answer = await runnerApi('reconcile', runnerTokens.foreign, {
      runnerSession: randomUUID(),
      inventory: [],
    })
    assert.equal(answer.status, 401)
  })
  if (realAddress)
    await check(
      '13c. a valid token from its own address is accepted: core sees the real address',
      async () => {
        const answer = await fromOutside(
          `http://${runnerHost}:${PORTS.runner}/runner/v1/reconcile`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${runnerTokens.own}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ runnerSession: randomUUID(), inventory: [] }),
          },
        )
        assert.equal(answer.status, 200)
        assert.deepEqual(JSON.parse(answer.body), { remove: [] })
      },
    )
  await check('14. no TLS on the runner API port', async () => {
    await assert.rejects(
      handshake({ host: runnerHost, port: PORTS.runner, servername: DOMAIN, ca }),
    )
  })
  if (!realAddress && lanAddress)
    await check("15. the runner API is not on the host's other addresses", async () => {
      assert.equal(await tcpConnect(lanAddress, PORTS.runner), 'ECONNREFUSED')
    })
  await check('16. the access log keeps no reset token and no query string', async () => {
    for (const name of [DOMAIN, `www.${DOMAIN}`])
      await edge(name, '/api/auth/reset-password/TOKENPATH123')
    await edge(DOMAIN, '/api/auth/verify-email?token=TOKENQUERY123')
    await edge(DOMAIN, '/api/health?probe=verify-edge')
    await sleep(1000)
    const logs = (await compose(['logs', 'traefik'])).stdout
    // assert.ok, not assert.match: a failure must not print the whole log
    assert.ok(!/TOKENPATH123|TOKENQUERY123|probe=verify-edge/.test(logs), 'a token is logged')
    assert.ok(/"RequestPath":"\/api\/health"/.test(logs), 'the access log is not written')
    assert.ok(/"RequestPath":"\/api\/auth\/verify-email"/.test(logs), 'the path is not logged')
  })
  await check('17. Traefik accepted every flag and logged no error', async () => {
    const logs = (await compose(['logs', 'traefik'])).stdout
    const errors = logs.split('\n').filter((line) => /"level":"(error|fatal|panic)"/.test(line))
    assert.equal(errors.length, 0, `${errors.length} error lines`)
    // An unknown flag stops Traefik before any provider starts
    assert.ok(/Starting provider \*acme\.Provider/.test(logs), 'the ACME provider did not start')
  })
  await check('18. the certificate survives a recreated Traefik: no new order', async () => {
    const before = await issued()
    await compose([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      '--force-recreate',
      '--no-deps',
      'traefik',
    ])
    const again = await served(DOMAIN)
    assert.equal(again.serialNumber, apex.serialNumber)
    await sleep(3000)
    assert.equal(await issued(), before)
  })
  if (options.renewal)
    await check('19. Traefik renews the certificate before it expires', async () => {
      await until(
        'a renewed certificate',
        async () => (await served(DOMAIN)).serialNumber !== apex.serialNumber,
        15 * 60_000,
        10_000,
      )
    })
  await check('20. broken settings stop web at start, naming the section only', async () => {
    const answer = await docker(
      [
        'run',
        '--rm',
        '--read-only',
        '-e',
        'APP_ENV=production',
        '-e',
        'NODE_ENV=production',
        '-e',
        `APP_URL=https://${DOMAIN}`,
        '-e',
        `BETTER_AUTH_URL=https://${DOMAIN}`,
        '-e',
        'S3_ENDPOINT=https://s3.invalid',
        '-e',
        'VAULT_ADDR=https://vault.invalid:8200',
        '-v',
        `${join(work, 'secrets-broken/web')}:/run/raditi:ro`,
        LOCAL.web,
        '--env-file=/run/raditi/app.env',
        'apps/web/server.js',
      ],
      { allowFailure: true, timeoutMs: 30_000 },
    )
    assert.notEqual(answer.code, 0)
    assert.equal(answer.signal, null, 'web kept running with broken settings')
    const output = answer.stdout + answer.stderr
    assert.match(output, /broken production settings: auth$/m)
    for (const value of secret.values)
      assert.ok(!output.includes(value), 'a secret value is in the output')
  })
  await check('21. PostgreSQL: web has no DDL, superuser only over the socket', async () => {
    // By the service name, not 127.0.0.1: loopback is `trust` in the image's pg_hba
    const psql = (password, user, sql) =>
      inside('postgres', [
        'env',
        `PGPASSWORD=${password}`,
        'psql',
        '-h',
        'postgres',
        '-U',
        user,
        '-d',
        'raditi',
        '-v',
        'ON_ERROR_STOP=1',
        '-tAc',
        sql,
      ])
    const ddl = await psql(secret.pg.web, 'raditi_web', 'CREATE TABLE verify_edge_x ()')
    assert.notEqual(ddl.code, 0)
    assert.match(ddl.stderr, /permission denied/)
    const dml = await psql(
      secret.pg.core,
      'raditi_core',
      'SELECT count(*) > 0 FROM _prisma_migrations',
    )
    assert.equal(dml.stdout.trim(), 't')
    const roles = await psql(
      secret.pg.web,
      'raditi_web',
      "SELECT string_agg(rolsuper::text, ',') FROM pg_roles WHERE rolname IN ('raditi', 'raditi_web', 'raditi_core')",
    )
    assert.equal(roles.stdout.trim(), 'false,false,false')
    const wrong = await psql(secret.pg.owner.replace(/.$/, 'x'), 'raditi', 'SELECT 1')
    assert.match(wrong.stderr, /password authentication failed/)
    const superuser = await psql(secret.pg.superuser, 'postgres', 'SELECT 1')
    assert.notEqual(superuser.code, 0)
    assert.match(superuser.stderr, /password authentication failed/)
  })
  await check('22. Redis: no admin or mass commands for web, only PING for health', async () => {
    const cli = (user, password, ...args) =>
      inside('redis', ['env', `REDISCLI_AUTH=${password}`, 'redis-cli', '--user', user, ...args])
    for (const args of [['FLUSHALL'], ['CONFIG', 'GET', 'maxmemory'], ['KEYS', '*']])
      assert.match((await cli('web', secret.redis.web, ...args)).stdout, /NOPERM/, args[0])
    assert.match((await cli('health', secret.redis.health, 'GET', 'x')).stdout, /NOPERM/)
    assert.match((await cli('web', secret.redis.web, 'PING')).stdout, /PONG/)
  })
  // Last: it restarts web and core.
  await check('23. the dump before a migration takes the database back (dump-db.sh)', async () => {
    // The script from a copy of the app directory, as on the VM: its .env and the record for
    // rollback; compose reaches this stack through its own variables.
    const vm = join(work, 'vm')
    await mkdir(join(vm, 'app'), { recursive: true })
    await copyFile(join(app, 'dump-db.sh'), join(vm, 'app/dump-db.sh'))
    await copyFile(envFile, join(vm, 'app/.env'))
    const log = join(vm, 'releases.log')
    await writeFile(log, `${new Date().toISOString()}\nAPP_REVISION=verify\n`)
    const dumped = await command('sh', [join(vm, 'app/dump-db.sh')], {
      env: {
        ...dockerEnv,
        COMPOSE_PROJECT_NAME: PROJECT,
        COMPOSE_FILE: composeFiles.join(':'),
        COMPOSE_ENV_FILES: envFile,
        DUMP_DIR: join(vm, 'backups'),
        RELEASES_LOG: log,
      },
    })
    const file = /^dump-db: (\S+)$/m.exec(dumped.stdout)?.[1]
    assert.ok(file?.startsWith(join(vm, 'backups/')), dumped.stdout)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').at(-1), `dump=${file}`)

    // The superuser over the socket reads; the schema owner breaks data as a migration would.
    const superuser = async (sql) => {
      const answer = await inside('postgres', [
        'psql',
        '-U',
        'postgres',
        '-d',
        'raditi',
        '-v',
        'ON_ERROR_STOP=1',
        '-tAc',
        sql,
      ])
      assert.equal(answer.code, 0, answer.stderr)
      return answer.stdout.trim()
    }
    const owner = (sql) =>
      inside('postgres', [
        'env',
        `PGPASSWORD=${secret.pg.owner}`,
        'psql',
        '-h',
        'postgres',
        '-U',
        'raditi',
        '-d',
        'raditi',
        '-v',
        'ON_ERROR_STOP=1',
        '-tAc',
        sql,
      ])
    const plans = "SELECT string_agg(name, ',' ORDER BY slug) FROM plans"
    const before = await superuser(plans)
    assert.ok(before)
    const broken = await owner(
      "CREATE TABLE verify_edge_broken (plan_id uuid REFERENCES plans (id)); INSERT INTO verify_edge_broken SELECT id FROM plans; UPDATE plans SET name = 'broken'",
    )
    assert.equal(broken.code, 0, broken.stderr)

    // The runbook's restore: web and core stopped, the database recreated from the dump.
    await compose(['stop', 'web', 'core'])
    const restored = await inside(
      'postgres',
      [
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '--clean',
        '--if-exists',
        '--create',
        '--exit-on-error',
      ],
      { input: await readFile(file) },
    )
    assert.equal(restored.code, 0, restored.stderr)
    assert.equal(await superuser(plans), before)
    // --create: a table the dump does not know goes too, even with a key into a restored one
    assert.equal(await superuser("SELECT to_regclass('verify_edge_broken') IS NULL"), 't')
    // The owner and the grants of the database and the schema came back with it
    assert.equal(
      await superuser(
        "SELECT pg_get_userbyid(datdba) || ',' || has_database_privilege('public', 'raditi', 'CONNECT') FROM pg_database WHERE datname = 'raditi'",
      ),
      'raditi,false',
    )
    assert.equal(
      await superuser(
        "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'",
      ),
      'raditi',
    )
    await compose([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      String(UP_TIMEOUT_S),
      '--no-deps',
      'web',
      'core',
    ])
    await dataReachable()
    // So did the default privileges: the next migration's tables are open to web and core
    const next = await owner('CREATE TABLE verify_edge_next (id int)')
    assert.equal(next.code, 0, next.stderr)
    const read = await inside('postgres', [
      'env',
      `PGPASSWORD=${secret.pg.core}`,
      'psql',
      '-h',
      'postgres',
      '-U',
      'raditi_core',
      '-d',
      'raditi',
      '-tAc',
      'SELECT count(*) FROM verify_edge_next',
    ])
    assert.equal(read.stdout.trim(), '0', read.stderr)
    // And the migrations table: the restored schema is the one the migrations recorded
    const migrate = await compose(['--profile', 'ops', 'run', '--rm', 'migrate'])
    assert.match(migrate.stdout + migrate.stderr, /No pending migrations to apply/)
  })
  console.log(`verify:edge: ${passed} checks passed`)
} catch (error) {
  exitCode = 1
  console.error(`verify:edge: ${error.message}`)
} finally {
  await cleanup()
}
process.exit(exitCode)
