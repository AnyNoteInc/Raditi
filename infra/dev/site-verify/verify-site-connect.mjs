// `pnpm verify:site-connect`: the trusted local connection of a site, on real services.
//
// Disposable PostgreSQL, S3, OpenBao and Gitea (HTTPS with the stand's own CA), and the profile
// `site` of the dev compose file under a project name of this run — the WordPress, MariaDB and
// WP-CLI a developer starts with `pnpm infra:up` and the profile `site`, never the dev
// containers themselves. A site is created the way «Новый проект» leaves it (`onboarding`);
// `connect-local.mjs` runs as a child process with an explicit environment; then the regular
// role mcp (`node dist/main.js`, content profile `local`, AppRole mcp) reads and edits a page
// of that site. The stand gives the role no access of its own: the secret in OpenBao, its
// reference, the workspace key and the repository are written by the command only.
//
// No .env file, subscription, cloud or image pull.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  roleEnvironment,
  startRegularRole,
} from '../../../apps/orchestrator/scripts/verify-agent-content-role.mjs'
import {
  cleanEnvironment,
  localDesktop,
  ownedContainers,
  provisionServices,
  runCommand,
  serviceImages,
} from '../../../apps/orchestrator/scripts/verify-agent-supervisor.mjs'
import { siteAccessPath } from '../../../packages/domain/src/ports/site-adapter.ts'
import { workspaceTransitKey } from '../../../packages/domain/src/sessions/workspace-transit-key.ts'
import { WordpressPublishedContentGateway } from '../../../packages/site-adapters/src/wordpress-content.ts'
import { bootstrapLocalVault, localVaultRequest } from '../../vault/bootstrap.mjs'
import {
  GITEA_IMAGE,
  certificateConfigs,
  generatedGiteaPassword,
  giteaAccountArgs,
  giteaContainerArgs,
} from '../gitea-verify/stand.mjs'
import { APPLICATION_PASSWORD_NAME, composeWpArgs, giteaPort } from './connect-local.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const composeFile = join(repository, 'infra/dev/docker-compose.yml')
const connectScript = join(repository, 'infra/dev/site-verify/connect-local.mjs')
// The images of the profile `site` by the tags of the dev compose file. A tag can be moved, so
// the local image must also carry the digest verify-site.mjs pins; the stand never pulls.
const siteImages = {
  'wordpress:7.1.2-php8.3-apache':
    'sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5',
  'mariadb:11.4.13': 'sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b',
}
const WPCLI_TAG = 'wordpress:cli-2.12.0-php8.3'
// The cached cli image that was checked as WP-CLI 2.12.0 (verify-site.mjs); checked again below.
const WPCLI_FALLBACK =
  'wordpress@sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586'

const run = randomBytes(4).toString('hex')
const project = `raditi-site-connect-${run}`
const giteaName = `raditi-gitea-verify-${run}`
const controller = new AbortController()
const hash = (text) => createHash('sha256').update(text).digest('hex')
let stage = 'preflight',
  checks = 0,
  directory,
  resources,
  docker,
  dockerEnv,
  role,
  db,
  siteStarted = false,
  giteaCreated = false
const passed = (name) => {
  checks++
  console.log(`PASS ${name}`)
}
const progress = (value) => {
  stage = value
  console.log(`site-connect ${value}`)
}
const command = (binary, args, options = {}) =>
  runCommand(binary, args, { signal: controller.signal, ...options })

let interrupted = false
const interrupt = () => {
  if (interrupted) return
  interrupted = true
  controller.abort()
  role?.child.kill('SIGTERM')
}
// Kept until the cleanup has ended, not `once`: with no listener left a repeated signal would
// end the process in the middle of removing the containers.
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function until(action, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (controller.signal.aborted) throw new Error('Verification interrupted')
    try {
      if (await action()) return
    } catch {
      /* Startup races are expected. */
    }
    if (Date.now() > deadline) throw new Error(`${what} did not become ready`)
    await sleep(500)
  }
}

/** The stand's own CA (two days) and a server certificate for 127.0.0.1, as verify-gitea. */
async function createCertificates() {
  const openssl = (...args) =>
    command('openssl', args, { env: { PATH: process.env.PATH, HOME: directory } })
  const key = (file) =>
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', file)
  const configs = certificateConfigs()
  const file = (leaf) => join(directory, leaf)
  await writeFile(file('ca.ext'), configs.authority)
  await writeFile(file('server.ext'), configs.server)
  await mkdir(file('tls'), { mode: 0o755 })
  await key(file('ca-key.pem'))
  await openssl(
    ...['req', '-new', '-key', file('ca-key.pem'), '-subj', `/CN=${giteaName} CA`],
    ...['-out', file('ca.csr')],
  )
  await openssl(
    ...['x509', '-req', '-in', file('ca.csr'), '-signkey', file('ca-key.pem'), '-days', '2'],
    ...['-sha256', '-extfile', file('ca.ext'), '-out', file('ca.pem')],
  )
  await key(file('tls/server-key.pem'))
  await openssl(
    ...['req', '-new', '-key', file('tls/server-key.pem'), '-subj', '/CN=127.0.0.1'],
    ...['-out', file('server.csr')],
  )
  await openssl(
    ...['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey'],
    ...[file('ca-key.pem'), '-days', '2', '-sha256', '-set_serial'],
    ...[`0x${randomBytes(16).toString('hex')}`, '-extfile', file('server.ext')],
    ...['-out', file('tls/server.pem')],
  )
  // A synthetic key of a two-day certificate: the container's uid 1000 must be able to read it.
  await chmod(file('tls/server-key.pem'), 0o444)
  await chmod(file('tls/server.pem'), 0o444)
}

/** One JSON request of the stand's setup to its Gitea, with a password or without. */
function giteaSetup(port, ca, method, path, { basic, body, expect } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((done, reject) => {
    const failure = () => reject(new Error(`Gitea did not answer during ${stage}`))
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/api${path}`,
        method,
        ca,
        headers: {
          accept: 'application/json',
          ...(basic
            ? {
                authorization: `Basic ${Buffer.from(`${basic.user}:${basic.password}`).toString('base64')}`,
              }
            : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', failure)
        response.on('end', () => {
          if (expect !== undefined && response.statusCode !== expect)
            return reject(new Error(`Gitea answered HTTP ${response.statusCode} during ${stage}`))
          let json = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* Health answers are not read. */
          }
          done({ status: response.statusCode, json })
        })
      },
    )
    request.once('error', failure)
    request.end(payload)
  })
}

/** The lease, the assignment and the paired MCP token a turn of a task has (synthetic model). */
async function openTurn(database, leases, { workspaceId, siteId }) {
  const suffix = randomBytes(8).toString('hex')
  const token = `mcp_${randomBytes(32).toString('hex')}`
  const deadline = new Date(Date.now() + 600_000)
  const task = await database.task.create({ data: { workspaceId, siteId, status: 'running' } })
  const driver = await database.agentDriver.create({
    data: {
      id: `connect-${suffix}`,
      image: `synthetic@sha256:${'a'.repeat(64)}`,
      capabilities: {},
      enabled: true,
    },
  })
  const provider = await database.llmProvider.create({
    data: { slug: `connect-${suffix}`, name: 'Synthetic', kind: 'subscription' },
  })
  const model = await database.llmModel.create({
    data: {
      providerId: provider.id,
      slug: `connect-${suffix}`,
      name: 'Synthetic',
      modelClass: 'standard',
      reserveOutputTokens: 1024,
    },
  })
  const credential = await database.credentialRef.create({
    data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
  })
  const account = await database.subscriptionAccount.create({
    data: {
      providerId: provider.id,
      driverId: driver.id,
      label: suffix,
      plan: 'synthetic',
      credentialRefId: credential.id,
      maxConcurrentTurns: 1,
      maxConcurrentRequests: 1,
    },
  })
  // The real lease: its epoch is what the plugin of the site fences content writes by.
  const lease = await leases.acquire({ siteId, taskId: task.id, operation: 'turn', ttlMs: 600_000 })
  assert(lease, 'The site lease was not granted')
  await database.llmKey.create({
    data: {
      keyHash: hash(randomUUID()),
      mcpTokenHash: hash(token),
      taskId: task.id,
      taskAttempt: 1,
      sessionId: suffix,
      turnNo: 1,
      firstEpoch: lease.epoch,
      driverId: driver.id,
      modelId: model.id,
      subscriptionAccountId: account.id,
      budgetRub: '100',
      issuedAt: new Date(),
      expiresAt: deadline,
      validUntil: deadline,
    },
  })
  await database.turnAssignment.create({
    data: {
      taskId: task.id,
      siteId,
      sessionId: suffix,
      turnNo: 1,
      executor: 'local',
      plan: {},
      firstEpoch: lease.epoch,
      leaseEpoch: lease.epoch,
      deadlineAt: deadline,
    },
  })
  await database.taskTurn.create({
    data: {
      taskId: task.id,
      turnNo: 1,
      status: 'running',
      driverId: driver.id,
      modelId: model.id,
      image: driver.image,
    },
  })
  return { token, taskId: task.id, lease }
}

async function closeTurn(database, leases, turn) {
  assert(await leases.release(turn.lease), 'The site lease was not released')
  await database.turnAssignment.updateMany({
    where: { taskId: turn.taskId, finishedAt: null },
    data: { finishedAt: new Date(), outcome: 'completed' },
  })
  await database.taskTurn.updateMany({
    where: { taskId: turn.taskId, status: 'running' },
    data: { status: 'completed', finishedAt: new Date() },
  })
}

/** JSON-RPC to the role's /mcp with the token of a turn; `status` for the refused case. */
function mcpClient(port, token) {
  let sequence = 0
  const post = (method, params) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    })
  const rpc = async (method, params) => {
    const response = await post(method, params)
    assert.equal(response.status, 200, `MCP answered HTTP ${response.status}`)
    const result = await response.json()
    assert(!result.error, 'MCP transport error')
    return result.result
  }
  return {
    status: async () => {
      const response = await post('tools/list', {})
      await response.arrayBuffer()
      return response.status
    },
    tools: async () => (await rpc('tools/list', {})).tools.map((tool) => tool.name).sort(),
    tool: (name, args) => rpc('tools/call', { name, arguments: args }),
  }
}

async function main() {
  assert.equal(
    process.argv.slice(2).filter((value) => value !== '--').length,
    0,
    'This stand accepts no options, external site, database, Vault or Gitea',
  )
  // On a Linux host (a CI runner) the engine is native; elsewhere Docker Desktop.
  const connection = await localDesktop(process.env, command, {
    nativeLinux: process.platform === 'linux',
  })
  dockerEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          ['PATH', 'HOME'].includes(name) ||
          (name.startsWith('DOCKER_') && name !== 'DOCKER_CONTEXT'),
      ),
    ),
    // The endpoint is resolved once; every Docker CLI of the stand and of the command uses it.
    DOCKER_HOST: connection.endpoint,
    COMPOSE_DISABLE_ENV_FILE: '1',
  }
  docker = (args, options = {}) => command('docker', args, { env: dockerEnv, ...options })
  for (const image of [...Object.values(serviceImages), GITEA_IMAGE, ...Object.keys(siteImages)]) {
    const found = await docker(['image', 'inspect', image, '--format', '{{json .RepoDigests}}'], {
      allowFailure: true,
    })
    assert.equal(found.code, 0, `A pinned local image is missing (${image}); nothing is pulled`)
    const digest = siteImages[image]
    if (digest)
      assert(
        JSON.parse(found.stdout).some((name) => name.endsWith(`@${digest}`)),
        `The local ${image} is not the pinned image`,
      )
  }
  let wpcliImage = WPCLI_TAG
  if ((await docker(['image', 'inspect', wpcliImage], { allowFailure: true })).code !== 0) {
    wpcliImage = WPCLI_FALLBACK
    const fallback = await docker(['image', 'inspect', wpcliImage], { allowFailure: true })
    assert.equal(fallback.code, 0, 'The pinned local WP-CLI image is missing; nothing is pulled')
  }
  const cliVersion = await docker([
    ...['run', '--rm', '--pull', 'never', '--network', 'none', wpcliImage, 'cli', 'version'],
  ])
  assert.equal(cliVersion.stdout.trim(), 'WP-CLI 2.12.0', 'Unexpected local WP-CLI version')
  await command('openssl', ['version'], { env: { PATH: process.env.PATH } })
  try {
    await access(join(repository, 'apps/orchestrator/dist/main.js'))
  } catch {
    throw new Error('Build the orchestrator first: pnpm --filter orchestrator build')
  }
  const { createPrismaClient, PostgresSiteLeaseStore } =
    await import('../../../packages/db/src/index.ts')

  directory = await mkdtemp(join(tmpdir(), 'raditi-site-connect-'))
  await chmod(directory, 0o700)
  for (const leaf of ['home', 'role-home', 'tokens'])
    await mkdir(join(directory, leaf), { mode: 0o700 })
  const marker = randomBytes(16).toString('hex')
  resources = ownedContainers(docker, marker)
  const databasePassword = randomBytes(24).toString('hex')
  const operatorToken = randomBytes(24).toString('hex')
  const accessKey = `connect-${randomBytes(12).toString('hex')}`
  const secretKey = randomBytes(24).toString('hex')
  await writeFile(
    join(directory, 'postgres.env'),
    `POSTGRES_USER=raditi\nPOSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${databasePassword}\n`,
    { mode: 0o600 },
  )
  await writeFile(join(directory, 'vault.env'), `BAO_DEV_ROOT_TOKEN_ID=${operatorToken}\n`, {
    mode: 0o600,
  })

  progress('starting disposable PostgreSQL, S3 and OpenBao')
  const names = {}
  names.postgres = await resources.start('postgres', [
    ...['--tmpfs', '/var/lib/postgresql/data:rw,size=768m', '-p', '127.0.0.1::5432'],
    ...['--env-file', join(directory, 'postgres.env'), serviceImages.postgres],
  ])
  names.s3 = await resources.start('s3', [
    ...['--tmpfs', '/data:rw,size=768m', '--tmpfs', '/config:rw,size=1m'],
    ...['-p', '127.0.0.1::8333', '--entrypoint', '/bin/sh', serviceImages.s3, '-c'],
    'while [ ! -f /config/s3.json ]; do sleep 0.1; done; exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/config/s3.json',
  ])
  await docker(
    [
      ...['exec', '-i', names.s3, 'sh', '-c'],
      'umask 077; cat > /config/s3.json.tmp && mv /config/s3.json.tmp /config/s3.json',
    ],
    {
      input: JSON.stringify({
        identities: [
          {
            name: 'site-connect-fixture',
            credentials: [{ accessKey, secretKey }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      }),
    },
  )
  names.vault = await resources.start('vault', [
    ...['--tmpfs', '/tmp:rw,mode=1777,size=64m', '-p', '127.0.0.1::8200'],
    ...['--env-file', join(directory, 'vault.env'), serviceImages.vault],
    ...['server', '-dev', '-dev-no-store-token', '-dev-listen-address=0.0.0.0:8200'],
  ])
  const published = async (name, number) => {
    const value = (await docker(['port', name, `${number}/tcp`])).stdout.trim()
    assert.match(value, /^127\.0\.0\.1:[1-9]\d{0,4}$/u, 'A stand endpoint must be loopback')
    return value
  }
  const env = {
    ...cleanEnvironment(process.env),
    NODE_ENV: 'test',
    APP_ENV: 'test',
    NO_COLOR: '1',
    DATABASE_URL: `postgresql://raditi:${databasePassword}@${await published(names.postgres, 5432)}/raditi`,
    S3_ENDPOINT: `http://${await published(names.s3, 8333)}`,
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: secretKey,
    S3_BUCKET_ARTIFACTS: `raditi-connect-${marker}-artifacts`,
    VAULT_ADDR: `http://${await published(names.vault, 8200)}`,
    VAULT_DEV_ROOT_TOKEN: operatorToken,
  }
  await provisionServices({
    docker,
    names,
    directory,
    env,
    signal: controller.signal,
    stage: progress,
    command,
    buckets: ['artifacts'],
  })

  progress('OpenBao mounts, policies, AppRole mcp and the two tokens of the connection step')
  // The operator token prepares the server and looks at the result; it reaches neither the
  // role nor the command.
  const operator = async (path, options, statuses = [200, 204]) => {
    const result = await localVaultRequest(
      { address: env.VAULT_ADDR, token: operatorToken },
      path,
      { ...options },
    )
    // Only the status: an OpenBao error body may repeat what was sent.
    assert.ok(statuses.includes(result.status), `OpenBao request failed (HTTP ${result.status})`)
    return result
  }
  await bootstrapLocalVault({ address: env.VAULT_ADDR, token: operatorToken })
  await operator('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
  await operator('auth/approle/role/mcp', {
    method: 'POST',
    body: {
      token_policies: ['mcp-content'],
      token_no_default_policy: true,
      token_ttl: '15m',
      token_max_ttl: '1h',
      secret_id_ttl: '1h',
    },
  })
  const appRole = {
    roleId: (await operator('auth/approle/role/mcp/role-id')).body.data.role_id,
    secretId: (await operator('auth/approle/role/mcp/secret-id', { method: 'POST', body: {} })).body
      .data.secret_id,
  }
  const secrets = [operatorToken, databasePassword, secretKey, appRole.secretId]
  const tokenFile = async (name, value) => {
    const path = join(directory, 'tokens', name)
    await writeFile(path, `${value}\n`, { mode: 0o600 })
    secrets.push(value)
    return path
  }
  const scoped = async (policy) =>
    tokenFile(
      policy,
      (
        await operator('auth/token/create', {
          method: 'POST',
          body: { policies: [policy], no_default_policy: true, ttl: '1h', renewable: false },
        })
      ).body.auth.client_token,
    )
  const sitesWriterFile = await scoped('sites-writer')
  const provisionerFile = await scoped('workspace-provisioner')

  progress('starting the disposable Gitea with the stand CA')
  await createCertificates()
  const ca = await readFile(join(directory, 'ca.pem'))
  const giteaPortNumber = await freePort()
  // Set before the create, so a partial start is cleaned too.
  giteaCreated = true
  await docker(giteaContainerArgs({ name: giteaName, port: giteaPortNumber }))
  await docker(['cp', join(directory, 'tls'), `${giteaName}:/tls`])
  await docker(['start', giteaName])
  assert.equal(
    (await docker(['port', giteaName, '3000/tcp'])).stdout.trim(),
    `127.0.0.1:${giteaPortNumber}`,
    'Gitea is not published on loopback only',
  )
  await until(
    async () => (await giteaSetup(giteaPortNumber, ca, 'GET', '/healthz')).status === 200,
    90_000,
    'Gitea',
  )
  // Gitea generates the password and prints it: it is never an argument of a process.
  const admin = {
    user: 'stand-admin',
    password: generatedGiteaPassword(
      (await docker(giteaAccountArgs({ container: giteaName, user: 'stand-admin', admin: true })))
        .stdout,
    ),
  }
  secrets.push(admin.password)
  await giteaSetup(giteaPortNumber, ca, 'POST', '/v1/orgs', {
    basic: admin,
    body: { username: 'sites', visibility: 'private' },
    expect: 201,
  })
  // What the operator of the local Gitea gives the command: a token that may create a
  // repository in the organization.
  const giteaToken = (
    await giteaSetup(giteaPortNumber, ca, 'POST', `/v1/users/${admin.user}/tokens`, {
      basic: admin,
      body: { name: 'site-connect', scopes: ['write:organization', 'write:repository'] },
      expect: 201,
    })
  ).json.sha1
  assert.match(giteaToken ?? '', /^[0-9a-f]{40}$/, 'Gitea returned no token')
  const giteaTokenFile = await tokenFile('gitea', giteaToken)
  const giteaOrigin = `https://127.0.0.1:${giteaPortNumber}`
  const gitea = giteaPort({ origin: giteaOrigin, token: giteaToken, ca })
  passed('disposable PostgreSQL, S3, OpenBao (AppRole mcp) and Gitea 1.27.3 over HTTPS are ready')

  progress('starting the profile site of the dev compose file under its own project')
  const sitePort = await freePort()
  await writeFile(
    join(directory, 'site.env'),
    `SITE_PORT=${sitePort}\nSITE_WPCLI_IMAGE=${wpcliImage}\n`,
    { mode: 0o600 },
  )
  const compose = (args, options) =>
    docker(
      [
        ...['compose', '--env-file', join(directory, 'site.env'), '-p', project],
        ...['-f', composeFile, '--profile', 'site', ...args],
      ],
      options,
    )
  // Set before up so a partial start is cleaned too. Only the site and its database start:
  // no other service of the dev compose file belongs to this project.
  siteStarted = true
  await compose(['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '180', 'site'], {
    timeoutMs: 240_000,
  })
  assert.equal(
    (await compose(['port', 'site', '80'])).stdout.trim(),
    `127.0.0.1:${sitePort}`,
    'The site is not published on loopback only',
  )
  const started = (await compose(['ps', '--services'])).stdout.trim().split('\n').sort()
  assert.deepEqual(started, ['site', 'site-db'], 'Only the site and its database may run')
  const siteUrl = `http://127.0.0.1:${sitePort}`
  // The stand's own WP-CLI: the same service and arguments the command uses.
  const wpEnv = { ...dockerEnv, SITE_WPCLI_IMAGE: wpcliImage }
  const wp = (args, options = {}) =>
    docker([...composeWpArgs({ project, composeFile }), ...args], {
      env: wpEnv,
      timeoutMs: 120_000,
      ...options,
    })
  const option = async (name) => {
    const result = await wp(['option', 'get', name], { allowFailure: true })
    return result.code === 0 ? result.stdout.trim() : null
  }
  const pluginOptions = async () =>
    JSON.parse(
      (
        await wp([
          ...['option', 'list', '--search=raditi_content_*', '--field=option_name'],
          '--format=json',
        ])
      ).stdout,
    )
  passed('profile site of the dev compose file runs as a disposable project on loopback')

  // The command as a developer runs it: its whole environment is named here.
  const connectEnvironment = () => ({
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    ...Object.fromEntries(Object.entries(dockerEnv).filter(([name]) => name.startsWith('DOCKER_'))),
    APP_ENV: 'test',
    DATABASE_URL: env.DATABASE_URL,
    VAULT_ADDR: env.VAULT_ADDR,
    CONNECT_SITES_WRITER_TOKEN_FILE: sitesWriterFile,
    CONNECT_WORKSPACE_PROVISIONER_TOKEN_FILE: provisionerFile,
    GITEA_URL: giteaOrigin,
    GIT_CA_FILE: join(directory, 'ca.pem'),
    CONNECT_GITEA_TOKEN_FILE: giteaTokenFile,
    CONNECT_COMPOSE_PROJECT: project,
    SITE_WPCLI_IMAGE: wpcliImage,
  })
  const outputs = []
  const connect = async (siteId, overrides = {}) => {
    const result = await command(process.execPath, [connectScript, '--site', siteId], {
      env: { ...connectEnvironment(), ...overrides },
      timeoutMs: 300_000,
      allowFailure: true,
    })
    outputs.push(result.stdout, result.stderr)
    return result
  }
  const connected = async (siteId) => {
    const result = await connect(siteId)
    if (result.code !== 0) {
      const error = new Error('The connection command failed')
      error.verificationOutput = `${result.stdout}\n${result.stderr}`
      throw error
    }
    return result.stdout
  }
  /** A site as «Новый проект» leaves it outside production: synthetic workspace, onboarding. */
  const newProject = async (database) => {
    const workspace = await database.workspace.create({
      data: { name: 'Site connect synthetic workspace', dataClass: 'synthetic' },
    })
    const site = await database.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Local WordPress',
        url: siteUrl,
        stack: 'wordpress',
      },
    })
    assert.equal(site.status, 'onboarding')
    return { workspaceId: workspace.id, siteId: site.id }
  }
  const startRole = async () => {
    const port = await freePort()
    role = await startRegularRole({
      port,
      env: roleEnvironment({
        path: process.env.PATH,
        home: join(directory, 'role-home'),
        port,
        allowedHosts: ['127.0.0.1'],
        databaseUrl: env.DATABASE_URL,
        vault: { address: env.VAULT_ADDR, ...appRole },
        s3: {
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          accessKey,
          secretKey,
          buckets: { artifacts: env.S3_BUCKET_ARTIFACTS },
        },
      }),
    })
    await until(
      async () =>
        /mcp role listening on 127\.0\.0\.1:\d+ .*content profile local/.test(role.logs.join('')),
      10_000,
      'The role mcp',
    )
    return port
  }
  const stopRole = async () => {
    const stopping = role
    role = undefined
    // close() rejects when the role had to be killed: a regular stop is SIGTERM alone.
    await stopping.close()
    outputs.push(stopping.logs.join(''))
  }
  const publicPage = async (pageId) => {
    const response = await fetch(`${siteUrl}/?page_id=${pageId}`, {
      redirect: 'manual',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
    assert.equal(response.status, 200, 'The public page did not answer 200')
    return response.text()
  }
  const text = (result) => result.content?.[0]?.text ?? ''
  /** One edit of the page through the role, checked on the public page. */
  const edit = async (client, pageId, markerText, key) => {
    const route = `/wp/v2/pages/${pageId}`
    const result = await client.tool('wp_rest', {
      method: 'POST',
      route,
      body: { content: `<p>${markerText}</p>` },
      idempotencyKey: key,
    })
    if (result.isError) {
      const error = new Error('The role mcp refused the edit')
      error.verificationOutput = text(result).slice(0, 2000)
      throw error
    }
    assert((await publicPage(pageId)).includes(markerText), 'The edit is not on the public page')
    return JSON.parse(text(result))
  }

  // ── First database ────────────────────────────────────────────────────────────────────────
  progress('a site created in the cabinet stays out of reach until it is connected')
  db = createPrismaClient({ databaseUrl: env.DATABASE_URL, log: [] })
  let leases = new PostgresSiteLeaseStore(db)
  const first = await newProject(db)
  let turn = await openTurn(db, leases, first)
  let port = await startRole()
  let client = mcpClient(port, turn.token)
  assert.equal(await client.status(), 401, 'An onboarding site must not be admitted')
  // The command refuses production and a database that is not on loopback before any step.
  for (const [overrides, code] of [
    [{ APP_ENV: 'production' }, 'PRODUCTION'],
    [{ DATABASE_URL: 'postgresql://raditi:synthetic@db.example.test:5432/raditi' }, 'SETTINGS'],
    [{ GITEA_URL: `http://127.0.0.1:${giteaPortNumber}` }, 'SETTINGS'],
  ]) {
    const refused = await connect(first.siteId, overrides)
    assert.equal(refused.code, 1)
    assert(refused.stderr.includes(`[${code}]`), `The command must refuse with ${code}`)
  }
  assert.equal(await option('raditi_content_site_id'), null)
  assert.equal(
    (await db.site.findUniqueOrThrow({ where: { id: first.siteId } })).status,
    'onboarding',
  )
  passed(
    'an onboarding site is not admitted by the role; production and remote addresses are refused',
  )

  progress('connect-local: install, access, binding, workspace key, repository, activation')
  const firstOutput = await connected(first.siteId)
  assert.match(firstOutput, /WordPress: установлен\n/)
  assert.match(firstOutput, /Доступ в OpenBao: записан, версия 1\n/)
  assert.match(firstOutput, /Репозиторий в Gitea: создан\n/)
  assert.match(firstOutput, /Статус сайта: переведён в active/)
  const state = async (database, { siteId }) => ({
    site: await database.site.findUniqueOrThrow({ where: { id: siteId } }),
    references: await database.credentialRef.findMany({ where: { siteId } }),
    repositories: await database.gitRepository.findMany({ where: { siteId } }),
  })
  const stored = async ({ siteId }) => {
    const secret = (await operator(`kv/data/sites/${siteId}/wp`)).body.data
    return { version: secret.metadata.version, data: secret.data }
  }
  const afterFirst = await state(db, first)
  assert.equal(afterFirst.site.status, 'active')
  assert.equal(afterFirst.references.length, 1, 'One reference of the access')
  assert.deepEqual(
    (({ kind, workspaceId, vaultPath, keyVersion }) => ({
      kind,
      workspaceId,
      vaultPath,
      keyVersion,
    }))(afterFirst.references[0]),
    {
      kind: 'wp',
      workspaceId: first.workspaceId,
      vaultPath: siteAccessPath(first.siteId, 'wp'),
      keyVersion: 1,
    },
  )
  const firstSecret = await stored(first)
  assert.equal(firstSecret.version, 1)
  assert.deepEqual(Object.keys(firstSecret.data).sort(), [
    'applicationPassword',
    'origin',
    'username',
    'v',
  ])
  assert.equal(firstSecret.data.origin, new URL(siteUrl).origin)
  secrets.push(firstSecret.data.applicationPassword)
  await operator(`transit/keys/${workspaceTransitKey(first.workspaceId)}`)
  assert.equal(afterFirst.repositories.length, 1)
  assert.deepEqual(
    (({ provider, owner, name, defaultBranch, url }) => ({
      provider,
      owner,
      name,
      defaultBranch,
      url,
    }))(afterFirst.repositories[0]),
    {
      provider: 'gitea',
      owner: 'sites',
      name: `site-${first.siteId}`,
      defaultBranch: 'main',
      url: `${giteaOrigin}/sites/site-${first.siteId}`,
    },
  )
  const remote = await gitea.repository('sites', `site-${first.siteId}`)
  assert.equal(remote?.defaultBranch, 'main')
  assert.match(remote.head, /^[0-9a-f]{40}$/, 'The repository has its first commit')
  // Private on the server itself: its administrator sees the flag, a stranger sees nothing.
  const repositoryPath = `/v1/repos/sites/site-${first.siteId}`
  const listed = await giteaSetup(giteaPortNumber, ca, 'GET', repositoryPath, {
    basic: admin,
    expect: 200,
  })
  assert.equal(listed.json?.private, true, 'The repository of the site must be private')
  assert.equal(
    (await giteaSetup(giteaPortNumber, ca, 'GET', repositoryPath)).status,
    404,
    'The repository of the site must not be visible without a token',
  )
  assert.equal(await option('raditi_content_site_id'), first.siteId)
  assert.equal(
    (await wp(['eval', 'echo wp_get_environment_type();'])).stdout.trim(),
    'local',
    'The profile must run WordPress with the local environment type',
  )
  passed(
    'connect-local: WordPress installed and bound, access v1 in OpenBao behind one reference, workspace key, private repository with a first commit, site active',
  )

  progress('the regular role mcp reads and edits a page of the connected site')
  const pageId = (
    await wp([
      ...['post', 'create', '--post_type=page', '--post_status=publish'],
      ...['--post_title=Site connect synthetic page', '--post_content=<p>connect original</p>'],
      '--porcelain',
    ])
  ).stdout.trim()
  assert.match(pageId, /^\d+$/, 'WordPress did not create the fixture page')
  assert((await publicPage(pageId)).includes('connect original'))
  // The same turn that was refused a minute ago: nothing changed but the connection.
  assert.deepEqual(await client.tools(), ['restore', 'site_info', 'wp_rest'])
  const read = await client.tool('wp_rest', { method: 'GET', route: `/wp/v2/pages/${pageId}` })
  assert(!read.isError && JSON.parse(text(read)).content.includes('connect original'))
  const firstEdit = await edit(client, pageId, `connect edit ${run}-1`, 'connect-edit-1')
  const snapshot = await db.snapshot.findUniqueOrThrow({ where: { id: firstEdit.snapshotId } })
  assert.equal(snapshot.siteId, first.siteId)
  assert.equal(await option('raditi_content_epoch'), String(turn.lease.epoch))
  passed(
    'regular role mcp (AppRole mcp, no fixture of accesses) reads and edits the page; the public page changed',
  )

  progress('a repeated connection changes nothing')
  const repeated = await connected(first.siteId)
  assert.match(repeated, /WordPress: уже был установлен\n/)
  assert.match(repeated, /Привязка плагина к сайту: без изменений\n/)
  assert.match(repeated, /Ограждение плагина: без изменений\n/)
  assert.match(repeated, /Доступ в OpenBao: без изменений, версия 1\n/)
  assert.match(repeated, /Репозиторий в Gitea: уже был\n/)
  assert.match(repeated, /Статус сайта: уже был active/)
  const afterRepeat = await state(db, first)
  assert.deepEqual(afterRepeat, afterFirst)
  assert.deepEqual(await stored(first), firstSecret)
  assert.equal(await option('raditi_content_epoch'), String(turn.lease.epoch))
  const passwords = (
    await wp([
      ...['user', 'application-password', 'list', firstSecret.data.username],
      ...[`--name=${APPLICATION_PASSWORD_NAME}`, '--format=count'],
    ])
  ).stdout.trim()
  assert.equal(passwords, '1', 'One application password of the command')
  await edit(client, pageId, `connect edit ${run}-2`, 'connect-edit-2')
  passed(
    'a repeated connect-local changes neither the database, OpenBao, Gitea nor the site; the role still edits',
  )

  progress('a later lease raises the epoch the site remembers')
  await closeTurn(db, leases, turn)
  turn = await openTurn(db, leases, first)
  assert.equal(turn.lease.epoch, 2)
  client = mcpClient(port, turn.token)
  await edit(client, pageId, `connect edit ${run}-3`, 'connect-edit-3')
  assert.equal(await option('raditi_content_epoch'), '2')
  const receipts = (await pluginOptions()).filter((name) => name.startsWith('raditi_content_call_'))
  assert.equal(receipts.length, 3, 'One receipt of the plugin per edit')
  await closeTurn(db, leases, turn)

  // ── The database is recreated; the volumes of the site are kept ───────────────────────────
  progress('recreating the platform database with the volumes of the site kept')
  await stopRole()
  await db.$disconnect()
  db = undefined
  // What removing the volume of the dev database does: every row of the platform is gone.
  // The site, its database, OpenBao and Gitea are left as they were.
  await docker([
    ...['exec', names.postgres, 'psql', '-U', 'raditi', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    ...['-c', 'DROP DATABASE raditi WITH (FORCE)', '-c', 'CREATE DATABASE raditi OWNER raditi'],
  ])
  // The same migrations, through the stand's own Prisma configuration (never the repo's).
  await command(
    'pnpm',
    [
      ...['--filter', '@repo/db', 'exec', 'prisma', 'migrate', 'deploy', '--config'],
      join(directory, 'prisma.config.ts'),
    ],
    {
      env: {
        ...cleanEnvironment(env),
        NODE_ENV: 'test',
        DATABASE_URL: env.DATABASE_URL,
        JITI_FS_CACHE: 'false',
      },
      timeoutMs: 180_000,
    },
  )
  db = createPrismaClient({ databaseUrl: env.DATABASE_URL, log: [] })
  leases = new PostgresSiteLeaseStore(db)
  assert.equal(await db.site.count(), 0, 'The recreated database knows no site')
  const second = await newProject(db)
  assert.notEqual(second.siteId, first.siteId)
  assert.equal(await option('raditi_content_site_id'), first.siteId)
  // What the kept installation does to the first lease of a new site while it remembers the
  // old epoch: the write is fenced. The old access is the stand's own look at the plugin.
  const kept = new WordpressPublishedContentGateway({
    origin: firstSecret.data.origin,
    siteId: first.siteId,
    username: firstSecret.data.username,
    applicationPassword: firstSecret.data.applicationPassword,
    allowLoopbackHttp: true,
  })
  const before = await kept.read(`page:${pageId}`)
  const fenced = await kept.conditionalWrite({
    callId: randomUUID(),
    siteId: first.siteId,
    epoch: 1,
    requestHash: hash('site-connect-fence'),
    objectRef: `page:${pageId}`,
    expectedStateHash: before.stateHash,
    deadlineAt: Date.now() + 10_000,
    ttlMs: 10_000,
    mode: 'edit',
    fields: { content: '<p>must be fenced</p>' },
  })
  assert.deepEqual(fenced, { version: 1, kind: 'rejected', code: 'fenced' })
  passed('before the reconnection the kept installation fences a write under epoch 1')

  progress('connect-local on the new site: the installation is rebound and its fence reset')
  const reconnected = await connected(second.siteId)
  assert.match(reconnected, /WordPress: уже был установлен\n/)
  assert.match(reconnected, /Привязка плагина к сайту: записана\n/)
  assert.match(reconnected, /Ограждение плагина: сброшено/)
  assert.match(reconnected, /Доступ в OpenBao: записан, версия 1\n/)
  assert.deepEqual(await pluginOptions(), ['raditi_content_site_id'])
  assert.equal(await option('raditi_content_site_id'), second.siteId)
  const afterSecond = await state(db, second)
  assert.equal(afterSecond.site.status, 'active')
  assert.equal(afterSecond.references.length, 1)
  assert.equal(afterSecond.references[0].vaultPath, siteAccessPath(second.siteId, 'wp'))
  assert.equal(afterSecond.repositories[0].name, `site-${second.siteId}`)
  const secondSecret = await stored(second)
  assert.equal(secondSecret.version, 1)
  secrets.push(secondSecret.data.applicationPassword)
  assert.notEqual(secondSecret.data.applicationPassword, firstSecret.data.applicationPassword)
  // The password of the previous binding is gone with it.
  await assert.rejects(kept.read(`page:${pageId}`))
  port = await startRole()
  turn = await openTurn(db, leases, second)
  assert.equal(turn.lease.epoch, 1, 'A new site starts with epoch 1')
  client = mcpClient(port, turn.token)
  await edit(client, pageId, `connect edit ${run}-4`, 'connect-edit-4')
  assert.equal(await option('raditi_content_epoch'), '1')
  await closeTurn(db, leases, turn)
  passed(
    'after the database was recreated the reconnected site is edited under epoch 1: not fenced',
  )

  progress('nothing secret in the output of the command and in the log of the role')
  await stopRole()
  const printed = outputs.join('\n')
  for (const secret of secrets)
    assert(!printed.includes(secret), 'A secret reached the output of the command or the role log')
  passed(
    'tokens, passwords and the application passwords are in no output of the command or log of the role',
  )
}

let failure
try {
  await main()
  console.log(
    `PASS local site connection: ${checks} checks; the wizard, the packaged plugin and the import of the site remain open`,
  )
} catch (error) {
  failure = error
  // The only diagnostic is private: no content of the site or credential of the stand on stdout.
  let where = ''
  try {
    const copy = await mkdtemp(join(tmpdir(), 'raditi-site-connect-diagnostic-'))
    await chmod(copy, 0o700)
    await writeFile(
      join(copy, 'failure.log'),
      [
        String(error?.stack ?? error),
        String(error?.verificationOutput ?? ''),
        role ? role.logs.join('').slice(-16 * 1024) : '',
      ]
        .join('\n')
        .slice(-64 * 1024),
      { mode: 0o600 },
    )
    where = `; private diagnostic: ${join(copy, 'failure.log')}`
  } catch {
    /* The stage alone is reported. */
  }
  console.error(`FAIL site-connect at ${stage}${interrupted ? ' (interrupted)' : ''}${where}`)
  process.exitCode = 1
} finally {
  stage = 'cleanup'
  const cleanup = { cleanup: true, allowFailure: true, timeoutMs: 60_000 }
  let clean = true
  await role?.close().catch(() => {})
  await db?.$disconnect().catch(() => {})
  if (docker && siteStarted)
    try {
      // One-off WP-CLI containers of an interrupted command belong to the project too.
      const label = `label=com.docker.compose.project=${project}`
      const running = await docker(['ps', '-aq', '--filter', label], cleanup)
      const ids = running.stdout.trim().split('\n').filter(Boolean)
      if (ids.length > 0) await docker(['rm', '-fv', ...ids], cleanup)
      await docker(
        [
          ...['compose', '--env-file', '/dev/null', '-p', project, '-f', composeFile],
          ...['--profile', 'site', 'down', '--volumes', '--remove-orphans', '--timeout', '10'],
        ],
        cleanup,
      )
      for (const kind of [
        ['ps', '-aq'],
        ['network', 'ls', '-q'],
        ['volume', 'ls', '-q'],
      ]) {
        const left = await docker([...kind, '--filter', label], {
          cleanup: true,
          timeoutMs: 30_000,
        })
        assert.equal(left.stdout.trim(), '', 'Resources of the site project survived cleanup')
      }
      console.log('PASS owned WordPress project, its network and volumes removed')
    } catch {
      clean = false
      console.error(`FAIL cleanup of the compose project ${project}`)
    }
  if (docker && giteaCreated)
    try {
      await docker(['rm', '--force', '--volumes', giteaName], cleanup)
      const left = await docker(['ps', '-aq', '--filter', `label=raditi.stand=${giteaName}`], {
        cleanup: true,
        timeoutMs: 30_000,
      })
      assert.equal(left.stdout.trim(), '', 'The Gitea container survived cleanup')
      console.log('PASS owned Gitea container removed')
    } catch {
      clean = false
      console.error(`FAIL cleanup of the Gitea container ${giteaName}`)
    }
  try {
    await resources?.close()
    if (resources) console.log('PASS owned PostgreSQL, S3 and OpenBao containers removed')
  } catch {
    clean = false
    console.error('FAIL cleanup of the data services')
  }
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => (clean = false))
  if (!clean || failure) process.exitCode = 1
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
