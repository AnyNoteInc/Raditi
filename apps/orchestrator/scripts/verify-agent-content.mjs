/* global AbortSignal, console, fetch */
// The glue stand below the queue: a turn key from the real issue, the real pinned CLIs in the
// sandbox image, sandbox-gw, the role llm on the synthetic providers, the regular role mcp from
// the build (content profile local, AppRole mcp, the site access from Vault through
// credential_refs) and the WordPress plugin. Disposable services and synthetic content only:
// no user env-file, login or subscription is loaded.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
} from '@repo/db'
import { siteAccessPath, workspaceTransitKey } from '@repo/domain'
import { codexBackend, kimiCodeBackend } from '@repo/llm-backends'
import { createS3Client, createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'

import { seedReferenceData } from '../../../packages/db/prisma/seed/apply.ts'
import { CLI_IMAGE, createCliSession, RUNTIME_IMAGE } from '../../../infra/dev/llm-verify/cli.mjs'
import { SYNTHETIC_KIMI_KEY } from '../../../infra/dev/llm-verify/fake-subscriptions.mjs'
import {
  abortVerification,
  eventually,
  repository,
  run,
  startVerificationStack,
} from '../../../infra/dev/llm-verify/stack.mjs'
import { startWorker } from '../../../infra/dev/llm-verify/workers.mjs'
import { verifySiteFoundation } from '../../../infra/dev/site-verify/verify-site.mjs'
import { localVaultRequest } from '../../../infra/vault/bootstrap.mjs'
import { llmConfigFromEnv } from '../src/config/llm-config.ts'
import { createControlEgress, createEgressTransport } from '../src/llm-gateway/egress.ts'
import { SessionSubscriptionLock } from '../src/llm-gateway/session-lock.ts'
import { authenticateSubscription } from '../src/subscriptions/device-login.ts'
import { createSubscriptionClientIdentity, SubscriptionLogin } from '../src/subscriptions/login.ts'
import {
  bridgeGatewayAddress,
  freePort,
  roleEnvironment,
  roleHome,
  startContentObservers,
  startRegularRole,
} from './verify-agent-content-role.mjs'
import { verifyAgentContentTurns } from './verify-agent-content-turns.mjs'

const GUARD_IMAGE = 'raditi-p3verify-guard:b13'
const args = new Set(process.argv.slice(2).filter((value) => value !== '--'))
if (args.has('--help')) {
  console.log(
    'verify:agent-content [--no-build]: real pinned CLIs edit a page of a disposable WordPress through the real roles llm and mcp. Synthetic providers and content; no real subscriptions or .env files.',
  )
  process.exit(0)
}
if ([...args].some((arg) => arg !== '--no-build'))
  throw new Error('Only --no-build is supported; real subscriptions and sites are not accepted')
// The WordPress fixture reads the same argv and refuses any option: this stand's flag ends here.
process.argv.length = 2

let stage = 'build',
  checks = 0,
  stack,
  db,
  cli,
  locks,
  guard,
  s3Client,
  observers
const workers = []
const secretMarkers = new Set([SYNTHETIC_KIMI_KEY])
const passed = (name) => {
  checks++
  console.log(`PASS ${name}`)
}
let interrupted = false
const interrupt = () => {
  if (interrupted) return
  interrupted = true
  abortVerification()
  for (const worker of workers) worker.child.kill('SIGTERM')
  void cli?.close().catch(() => {})
}
// Kept until the end of the pass, not `once`: with no listener left a repeated signal (a second
// Ctrl-C) would end the process in the middle of its cleanup and leave both stacks behind.
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

/** The images of B13: the production agent runtime, the CLI harness on it, the network guard. */
async function build() {
  const image = (target, tag, file, context) =>
    run(
      'docker',
      [
        'build',
        '-f',
        join(repository, file),
        ...(target ? ['--target', target] : ['--build-arg', `RUNTIME_IMAGE=${RUNTIME_IMAGE}`]),
        '-t',
        tag,
        context,
      ],
      { timeoutMs: 900_000 },
    )
  await image('runtime', RUNTIME_IMAGE, 'infra/sandbox/Dockerfile', repository)
  await image(
    null,
    CLI_IMAGE,
    'infra/dev/llm-verify/cli.Dockerfile',
    join(repository, 'infra/dev/llm-verify'),
  )
  await run('pnpm', ['--filter', 'orchestrator', 'build'])
  await image('network-guard', GUARD_IMAGE, 'infra/sandbox/Dockerfile', repository)
}

/** The bounded companion plugin, an application password and one page per CLI. */
async function prepareSite({ wp, compose, url }) {
  const siteId = randomUUID()
  const plugin = await readFile(join(repository, 'infra/wordpress/raditi-content.php'))
  const target = '/var/www/html/wp-content/mu-plugins/raditi-content.php'
  await compose(
    [
      'exec',
      '-T',
      'wpcli',
      'sh',
      '-c',
      `mkdir -p /var/www/html/wp-content/mu-plugins && cat > ${target}`,
    ],
    { input: plugin },
  )
  await compose(['exec', '-T', 'wpcli', 'php', '-l', target])
  await wp(['option', 'update', 'raditi_content_site_id', siteId])
  const applicationPassword = (
    await wp([
      'user',
      'application-password',
      'create',
      'synthetic_admin',
      'Raditi agent content synthetic',
      '--porcelain',
    ])
  ).stdout.trim()
  assert(applicationPassword.length > 10, 'Fixture application password is missing')
  secretMarkers.add(applicationPassword)
  const pages = {}
  for (const driver of ['codex', 'kimi']) {
    const original = `raditi-agent-original-${randomUUID()}`
    // A third party's contact on the page: the model must only ever see its opaque marker.
    const contact = `contact-${driver}-${randomBytes(4).toString('hex')}@example.test`
    const content = `<p>${original}. Напишите нам: ${contact}</p>`
    const id = (
      await wp([
        'post',
        'create',
        '--post_type=page',
        '--post_status=publish',
        `--post_title=Synthetic ${driver} page`,
        `--post_content=${content}`,
        '--porcelain',
      ])
    ).stdout.trim()
    assert.match(id, /^[1-9]\d*$/, 'WordPress did not create the fixture page')
    pages[driver] = { id, original, contact, content, url: `${url}/?page_id=${id}` }
  }
  const receipts = async () =>
    Number(
      (
        await wp(['option', 'list', '--search=raditi_content_call_*', '--format=count'])
      ).stdout.trim(),
    )
  return { siteId, origin: url, username: 'synthetic_admin', applicationPassword, pages, receipts }
}

/** Two synthetic accounts through the product's own login paths, as in B13. */
async function importAccounts(env) {
  const writer = createVaultSecretStore({
    addr: stack.vaultAddress,
    token: stack.tokens['subscriptions-writer'],
  })
  locks = new SessionSubscriptionLock(stack.databaseUrl)
  const login = new SubscriptionLogin({
    prisma: db,
    writer,
    locks,
    backends: [codexBackend, kimiCodeBackend],
  })
  const http = createControlEgress(createEgressTransport(llmConfigFromEnv(env, 'test').egress))
  const identity = createSubscriptionClientIdentity()
  const credential = await authenticateSubscription({
    backend: codexBackend,
    identity,
    http,
    signal: AbortSignal.timeout(20_000),
    showDeviceCode: async () => {},
    readSecret: async () => {
      throw new Error('Unexpected secret input')
    },
  })
  for (const value of [credential.accessToken, credential.refreshToken, credential.idToken])
    secretMarkers.add(value)
  const codex = await login.importAccount({
    backend: codexBackend.id,
    driverId: 'codex',
    label: 'synthetic-codex',
    credential,
    clientIdentity: identity,
    maxConcurrentTurns: 1,
    maxConcurrentRequests: 2,
  })
  const writerFile = join(stack.directory, 'writer.token')
  await writeFile(writerFile, stack.tokens['subscriptions-writer'], { mode: 0o400 })
  const imported = await run(
    process.execPath,
    [
      join(repository, 'apps/orchestrator/scripts/subscription-login.mjs'),
      '--backend',
      'kimi-code',
      '--label',
      'synthetic-kimi',
      '--plan',
      'kimi-code',
      '--vault-token-file',
      writerFile,
    ],
    { input: `${SYNTHETIC_KIMI_KEY}\n`, env },
  )
  const kimi = JSON.parse(imported.stdout)
  const models = {}
  for (const [backend, accountId, slug, providerModelId] of [
    ['openai-chatgpt', codex.accountId, 'gpt-6-sol-standard', 'gpt-6-sol'],
    ['kimi-code', kimi.accountId, 'k3-256k-standard', 'k3-256k'],
  ]) {
    const provider = await db.llmProvider.update({
      where: { slug: backend },
      data: { enabled: true },
    })
    const model = await db.llmModel.findFirstOrThrow({ where: { providerId: provider.id, slug } })
    models[backend] = await db.llmModel.update({
      where: { id: model.id },
      data: { enabled: true, providerModelId, reserveOutputTokens: 1024 },
    })
    // A synthetic accounting rate: without one the product issues no turn key.
    await db.llmModelPrice.create({
      data: {
        modelId: model.id,
        effectiveFrom: new Date(Date.now() - 60_000),
        inputPer1m: '10',
        outputPer1m: '30',
        vatRate: '0.22',
        sourceUrl: 'https://synthetic.invalid/agent-content-rates',
      },
    })
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: {
        enabled: true,
        limitsSeenAt: new Date(),
        headroomPct: '90',
        limitWindows: [
          { name: '5h', usedPct: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        ],
      },
    })
  }
  await db.agentDriver.updateMany({
    where: { id: { in: ['codex', 'kimi'] } },
    data: { enabled: true },
  })
  return models
}

/**
 * The trusted connection step of a site, with the tokens that step has in the product: the
 * provisioner creates the key of the workspace, the writer stores the access with CAS and cannot
 * read it back, and the database keeps only where the access is and which version of it.
 */
async function connectSite(workspaceId, site, origin) {
  const created = await localVaultRequest(
    { address: stack.vaultAddress, token: stack.tokens['workspace-provisioner'] },
    `transit/keys/${workspaceTransitKey(workspaceId)}`,
    { method: 'POST', body: { type: 'aes256-gcm96' } },
  )
  assert.ok([200, 204].includes(created.status), 'The workspace key was not created')
  const path = siteAccessPath(site.siteId, 'wp')
  const writer = createVaultSecretStore({
    addr: stack.vaultAddress,
    token: stack.tokens['sites-writer'],
  })
  // A KV v2 mount refuses writes for a moment after it is enabled, while it upgrades.
  const { version } = await eventually(() =>
    writer.kvWrite(
      path,
      {
        v: '1',
        origin,
        username: site.username,
        applicationPassword: site.applicationPassword,
      },
      { cas: 0 },
    ),
  )
  await db.credentialRef.create({
    data: { kind: 'wp', workspaceId, siteId: site.siteId, vaultPath: path, keyVersion: version },
  })
}

/** The address sandbox-gw reaches the host on: the bridge gateway on a native Linux engine. */
async function bridgeGateway() {
  const inspected = await run('docker', [
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ])
  return bridgeGatewayAddress(inspected.stdout)
}

async function stand(site) {
  stage = 'disposable stack'
  stack = await startVerificationStack({
    content: true,
    onStage: (name) => {
      stage = name
    },
  })
  passed('disposable PostgreSQL, OpenBao, S3, synthetic providers, egress proxy and sandbox-gw')
  db = createPrismaClient({ databaseUrl: stack.databaseUrl, log: [] })
  await seedReferenceData(db)
  const metricsToken = randomBytes(24).toString('hex')
  const env = {
    APP_ENV: 'test',
    DATABASE_URL: stack.databaseUrl,
    VAULT_ADDR: stack.vaultAddress,
    METRICS_TOKEN: metricsToken,
    LLM_GATEWAY_PORT: String(stack.llmPort),
    LLM_GATEWAY_LISTEN_HOST: '0.0.0.0',
    LLM_GATEWAY_CLIENTS: '127.0.0.1/32,172.16.0.0/12,192.168.0.0/16',
    LLM_GATEWAY_HOSTS: `host.docker.internal:${stack.llmPort},127.0.0.1:${stack.llmPort}`,
    LLM_EGRESS_PROXY_URL: stack.egressUrl,
    LLM_EGRESS_CA_FILE: join(stack.certificates.authority, 'root.pem'),
    LLM_EGRESS_CLIENT_CERT_FILE: join(stack.certificates.authority, 'clients/b13-llm.pem'),
    LLM_EGRESS_CLIENT_KEY_FILE: join(stack.certificates.authority, 'clients/b13-llm-key.pem'),
    LLM_UPSTREAM_CA_FILE: join(stack.certificates.authority, 'root.pem'),
  }
  const control = async (path, body) => {
    const result = await fetch(`${stack.control}/${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(result.status, 200, 'Synthetic control request failed')
    return result.json()
  }
  stage = 'synthetic subscription accounts'
  const models = await importAccounts(env)
  const storageEnv = {
    S3_ENDPOINT: stack.s3.endpoint,
    S3_REGION: stack.s3.region,
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: stack.s3.accessKey,
    S3_SECRET_ACCESS_KEY: stack.s3.secretKey,
    S3_BUCKET_ARTIFACTS: stack.s3.buckets.artifacts,
  }
  const storageConfig = storageConfigFromEnv({ ...storageEnv })
  s3Client = createS3Client(storageConfig)
  const storage = createS3ObjectStorage(storageConfig, s3Client)
  stage = "the stand's observers of the role mcp"
  // The role is the regular one, so the stand looks at it from outside: one hop in front of
  // /mcp (where sandbox-gw sends), one in front of the site. The role itself listens on
  // loopback; only the first hop is reachable from the stand's containers.
  const rolePort = await freePort()
  observers = await startContentObservers({
    mcp: {
      listenHost: process.platform === 'linux' ? await bridgeGateway() : '127.0.0.1',
      port: stack.mcpPort,
      upstream: `http://127.0.0.1:${rolePort}`,
    },
    site: { upstream: site.origin },
    // The order the journal promises, observed at the moment the write leaves for the site: the
    // snapshot is acknowledged and present in the actual S3, the site lease names this write.
    beforeSiteWrite: async (request) => {
      const call = await db.mcpCall.findUniqueOrThrow({
        where: { id: request.callId },
        include: { snapshot: true },
      })
      assert(call.snapshot?.payloadSha256, 'No acknowledged snapshot before the write')
      assert(call.writeStartedAt, 'The write was not admitted')
      assert(await storage.exists('artifacts', call.snapshot.s3Key), 'Snapshot absent from S3')
      const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: site.siteId } })
      assert.equal(lease.inflightMcpCallId, request.callId)
    },
  })
  stage = 'workspace, site, its access in OpenBao and the workspace key'
  const workspace = await db.workspace.create({
    data: { name: 'Agent content synthetic workspace', dataClass: 'synthetic' },
  })
  // The platform knows the site by the address it reaches it on: the stand's hop to WordPress.
  await db.site.create({
    data: {
      id: site.siteId,
      workspaceId: workspace.id,
      name: 'Agent content synthetic site',
      url: observers.siteOrigin,
      stack: 'wordpress',
      status: 'active',
    },
  })
  await connectSite(workspace.id, site, observers.siteOrigin)
  stage = 'separate llm and mcp role processes'
  const llm = await startWorker('llm', {
    env: {
      ...env,
      VAULT_ROLE_ID: stack.roles.llm.roleId,
      VAULT_SECRET_ID: stack.roles.llm.secretId,
    },
  })
  workers.push(llm)
  await eventually(
    async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
  )
  // Nothing the stand holds for its own setup may show up in what the platform keeps or logs.
  for (const value of [
    stack.s3.secretKey,
    stack.root.token,
    stack.roles.mcp.secretId,
    ...Object.values(stack.tokens),
  ])
    secretMarkers.add(value)
  await mkdir(roleHome(stack.directory), { mode: 0o700 })
  // The regular role: the entry point of the build with the environment of the mcp service.
  // /health answers 200 only when its database, Vault under AppRole mcp, the artifacts bucket
  // and the admission query all answer.
  const mcp = await startRegularRole({
    port: rolePort,
    env: roleEnvironment({
      path: process.env.PATH,
      home: roleHome(stack.directory),
      port: rolePort,
      // What sandbox-gw rewrites Host to: the role accepts nothing else, loopback included.
      allowedHosts: ['host.docker.internal'],
      databaseUrl: stack.databaseUrl,
      vault: { address: stack.vaultAddress, ...stack.roles.mcp },
      s3: stack.s3,
    }),
  })
  workers.push(mcp)
  // Its own line, read from the pipe: loopback only, and the profile the configuration named.
  const listening = new RegExp(
    `mcp role listening on 127\\.0\\.0\\.1:${rolePort} .*content profile local`,
  )
  await eventually(async () => listening.test(mcp.logs.join('')), 10_000)
  passed(
    'roles llm (AppRole llm) and mcp (regular role from the build, AppRole mcp, loopback) run as separate processes',
  )
  stage = 'trusted turn-key issuer'
  // The trusted side of the stand is this process: the product's issuer under the core AppRole.
  const { GatewayTurnCredentials } = await import('../dist/llm/turn-credentials.js')
  const { ContentSnapshotStorage, contentSnapshotKey } =
    await import('../dist/mcp/content-snapshots.js')
  const credentials = new GatewayTurnCredentials({
    prisma: db,
    secrets: createVaultSecretStore({ addr: stack.vaultAddress, appRole: stack.roles.core }),
    requireAssignment: true,
  })
  // The stand opens a snapshot to compare it with the page: a token that can only unwrap data
  // keys of workspaces, not the operator's.
  const reader = createVaultSecretStore({
    addr: stack.vaultAddress,
    token: stack.tokens['core-transit'],
  })
  stage = 'isolated CLI container'
  cli = await createCliSession({
    parentDirectory: stack.directory,
    network: stack.network,
    address: stack.cliIp,
    gatewayIp: stack.gatewayIp,
  })
  guard = `${stack.project}-guard`
  await run('docker', [
    'run',
    '-d',
    '--pull=never',
    '--name',
    guard,
    '--network',
    `container:${cli.containerName}`,
    '--user',
    '0:0',
    '--read-only',
    '--cap-drop=ALL',
    '--cap-add=NET_ADMIN',
    '--security-opt=no-new-privileges',
    '--tmpfs',
    '/run/raditi-guard:rw,nosuid,nodev,size=1m',
    '-e',
    `GATEWAY_IPV4=${stack.gatewayIp}`,
    '-e',
    'GATEWAY_PORT=8080',
    '--entrypoint',
    'node',
    GUARD_IMAGE,
    '/usr/local/lib/raditi/network-guard.mjs',
  ])
  await eventually(
    async () =>
      (
        await run('docker', ['exec', guard, 'test', '-f', '/run/raditi-guard/ready'], {
          allowFailure: true,
        })
      ).code === 0,
  )
  await verifyAgentContentTurns({
    db,
    cli,
    control,
    stats: observers.stats,
    site,
    models,
    workspaceId: workspace.id,
    credentials,
    leases: new PostgresSiteLeaseStore(db),
    assignments: new PostgresTaskTurnAssignmentStore(db),
    snapshots: new ContentSnapshotStorage(storage, reader),
    snapshotKey: contentSnapshotKey,
    storage,
    s3Client,
    bucket: stack.s3.buckets.artifacts,
    secretMarkers,
    passed,
    setStage: (name) => {
      stage = name
    },
  })
  stage = 'log and database secrecy'
  const serviceLogs = (await stack.compose(['logs', '--no-color'])).stdout
  const audit = (await stack.compose(['exec', '-T', 'vault', 'cat', '/audit/audit.jsonl'])).stdout
  const dump = (
    await stack.compose([
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'raditi',
      '--data-only',
    ])
  ).stdout
  // The role mcp writes with its production logger: an empty log would prove nothing below.
  assert.ok(mcp.logs.join('').includes('mcp role listening on'), 'The role mcp logged nothing')
  assert.deepEqual(observers.stats().violations, [], 'The stand observed a broken promise')
  const platformText = [...workers.flatMap((worker) => worker.logs), serviceLogs, audit, dump].join(
    '\n',
  )
  // Turn keys, MCP tokens, subscription values, the site's password and the visitors' contacts.
  for (const forbidden of [...secretMarkers, ...Object.values(site.pages).map((p) => p.contact)])
    assert.equal(
      platformText.includes(forbidden),
      false,
      'A private marker reached platform storage or logs',
    )
  passed('no turn key, MCP token, site password or contact in platform logs, audit or SQL')
}

let failure
try {
  if (!args.has('--no-build')) await build()
  stage = 'disposable WordPress'
  await verifySiteFoundation({
    scenario: async ({ wp, compose, url }) => {
      try {
        stage = 'WordPress plugin, application password and pages'
        const site = await prepareSite({ wp, compose, url })
        await stand(site)
      } catch (error) {
        failure = error
        throw error
      } finally {
        const cleanup = [
          () => cli?.close(),
          () => guard && run('docker', ['rm', '-f', guard], { allowFailure: true, cleanup: true }),
          () => observers?.close(),
          ...workers
            .slice()
            .reverse()
            .map((worker) => () => worker.close()),
          () => locks?.close(),
          () => db?.$disconnect(),
          () => s3Client?.destroy(),
          () => stack?.close(),
        ]
        let removed = true
        for (const close of cleanup) {
          try {
            await close()
          } catch {
            console.error('An owned verification resource could not be cleaned up')
            removed = false
            process.exitCode = 1
          }
        }
        if (stack && removed) console.log('PASS owned stack, workers and CLI containers removed')
      }
    },
  })
  if (process.exitCode) throw new Error('Cleanup failed')
  console.log(
    `Agent content verification passed: ${checks} checks; CLI Codex 0.158.0 / Kimi 2.1.1; synthetic providers, real role llm, regular role mcp under AppRole, real WordPress.`,
  )
} catch (error) {
  const cause = failure ?? error
  if (cause.infrastructureDiagnostic) console.error(cause.infrastructureDiagnostic)
  // The diagnostic is private: assertion values may quote synthetic content or identifiers.
  // A signal is not a failure to diagnose: nothing is left behind for it.
  if (interrupted) console.error(`Agent content verification interrupted at: ${stage}`)
  else
    try {
      const directory = await mkdtemp(join(tmpdir(), 'raditi-agent-content-diagnostic-'))
      await chmod(directory, 0o700)
      const path = join(directory, 'failure.log')
      await writeFile(path, String(cause.stack ?? cause.message ?? cause).slice(-64 * 1024), {
        mode: 0o600,
      })
      console.error(`Agent content verification failed at: ${stage}; private diagnostic: ${path}`)
    } catch {
      console.error(`Agent content verification failed at: ${stage}`)
    }
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
