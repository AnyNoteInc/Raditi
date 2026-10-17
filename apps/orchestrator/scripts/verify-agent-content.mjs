/* global AbortSignal, console, fetch */
// The glue stand below the queue: a turn key from the real issue, the real pinned CLI in the
// sandbox image, sandbox-gw, the role llm on the synthetic provider, the regular role mcp from
// the build (content profile local, AppRole mcp, the site access from Vault through
// credential_refs) and the WordPress plugin. The role llm reaches Z.ai without the egress node,
// as in the product. Disposable services and synthetic content only: no user env-file, login
// or subscription is loaded. With --live the provider at the end of the path is the real one
// (verify-agent-content-live.mjs; rules and limits in infra/dev/llm-verify/README.md);
// --rehearsal runs that flow on the synthetic Z.ai.
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
import { createS3Client, createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'

import { seedReferenceData } from '../../../packages/db/prisma/seed/apply.ts'
import {
  CLI_IMAGE,
  createCliSession,
  GUARD_IMAGE,
  RUNTIME_IMAGE,
} from '../../../infra/dev/llm-verify/cli.mjs'
import {
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_MARKER,
  ZAI_PATHS,
} from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { LiveRefusal, standMode } from '../../../infra/dev/llm-verify/live.mjs'
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
import {
  bridgeGatewayAddress,
  freePort,
  roleEnvironment,
  roleHome,
  startContentObservers,
  startRegularRole,
} from './verify-agent-content-role.mjs'
import {
  CONTENT_TURN_CALLS,
  liveContentPages,
  liveContentTurns,
} from './verify-agent-content-live.mjs'
import { CONTENT_DRIVERS, verifyAgentContentTurns } from './verify-agent-content-turns.mjs'
import { assertImages, openLiveRun, REFUSED } from './verify-llm-live-run.mjs'
import {
  switchOnZai,
  ZAI_BACKEND,
  zaiDirectEnvironment,
  zaiLogin,
  zaiOperator,
} from './verify-llm-zai-setup.mjs'

const ZAI_LABEL = 'synthetic-zai'
if (process.argv.includes('--help')) {
  console.log(
    'verify:agent-content [--no-build]: the real pinned OpenCode CLI edits a page of a disposable WordPress through the real roles llm and mcp. A synthetic provider and synthetic content; no real subscriptions or .env files.\n' +
      'verify:agent-content --live [--no-build] [--keep=<directory>]: the same on the real provider, with ZAI_API_KEY in the environment; never in CI.\n' +
      'verify:agent-content --rehearsal [--no-build]: the live flow on the synthetic provider.\n' +
      'infra/dev/llm-verify/README.md',
  )
  process.exit(0)
}
const mode = standMode(process.argv.slice(2), { stand: 'content' })
const args = new Set(mode.noBuild ? ['--no-build'] : [])
// The WordPress fixture reads the same argv and refuses any option: this stand's flags end here.
process.argv.length = 2

let stage = 'build',
  checks = 0,
  stack,
  db,
  cli,
  guard,
  s3Client,
  observers
const workers = []
// The plan key of the synthetic Z.ai and the text its refusals would carry, with the rest.
const secretMarkers = new Set([SYNTHETIC_ZAI_KEY, SYNTHETIC_ZAI_MARKER])
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
// A live run or its rehearsal: the plan key leaves the environment here, before any other
// process exists, and a run that must not start ends here.
const live =
  mode.live || mode.rehearsal
    ? await openLiveRun({ mode, kind: 'content', onExpire: interrupt })
    : null
if (live === REFUSED) process.exit(REFUSED)
const cliOutputs = []
// What a failed live run still holds beside what the run itself kept: named once the roles run.
let whatIsLeft = () => [{ name: 'events and output of the CLI', texts: cliOutputs }]

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

/**
 * The bounded companion plugin, an application password and the pages: one a CLI in the
 * deterministic pass, one an attempt in the live flow.
 */
async function prepareSite({ wp, compose, url }, pageNames) {
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
  for (const driver of pageNames) {
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

/** The synthetic account through the product's own login path, as in B13. */
async function importAccounts(env) {
  const writerFile = join(stack.directory, 'writer.token')
  await writeFile(writerFile, stack.tokens['subscriptions-writer'], { mode: 0o400 })
  const models = {}
  // The plan key of Z.ai by the operator command, on the direct path: that provider needs no
  // egress node. Its windows are left unwritten: the first issue has the role llm probe them.
  const planKey = await zaiLogin(zaiOperator(stack, env.LLM_UPSTREAM_CA_FILE), {
    label: ZAI_LABEL,
    writerFile,
    key: SYNTHETIC_ZAI_KEY,
  })
  assert.equal(planKey.code, 0, 'The import of the synthetic plan key failed')
  models[ZAI_BACKEND] = await switchOnZai(db, {
    accountId: JSON.parse(planKey.stdout).accountId,
    ratesUrl: 'https://synthetic.invalid/agent-content-rates',
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
    live: mode.live,
    onStage: (name) => {
      stage = name
    },
  })
  await live?.useProvider(stack)
  passed(
    mode.live
      ? 'disposable PostgreSQL, OpenBao, S3 and sandbox-gw; no synthetic provider, egress proxy or certificate'
      : 'disposable PostgreSQL, OpenBao, S3, synthetic providers, egress proxy and sandbox-gw',
  )
  db = createPrismaClient({ databaseUrl: stack.databaseUrl, log: [] })
  await seedReferenceData(db)
  const metricsToken = randomBytes(24).toString('hex')
  // A live run puts its observer where sandbox-gw sends, and the role behind it on loopback.
  const { observer, rolePort: llmPort } = live
    ? await live.startObserver(stack)
    : { observer: null, rolePort: stack.llmPort }
  const env = live
    ? live.roleEnvironment({
        stack,
        rolePort: llmPort,
        metricsToken,
        callsPerKey: CONTENT_TURN_CALLS,
      })
    : {
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
  /**
   * What the CLI sent to the provider, as the stand's hop in front of the role llm saw it: a
   * live run has no synthetic provider to ask. A request without tools is the CLI's context
   * compaction and declares nothing.
   */
  const observed = () => ({
    zai: {
      requests: observer.exchanges().flatMap((exchange) => {
        if (exchange.method !== 'POST') return []
        try {
          const body = JSON.parse(exchange.requestBody)
          return body.tools === undefined ? [] : [{ path: ZAI_PATHS.chat, body }]
        } catch {
          return []
        }
      }),
    },
  })
  const control = async (path, body) => {
    if (live && path === 'state') return observed()
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
  stage = live ? 'import of the plan key' : 'synthetic subscription accounts'
  let models, accountId
  if (live) {
    // One account: the plan key from the environment of the stand, by the operator command.
    accountId = await live.importKey({ stack, db })
    models = {
      [ZAI_BACKEND]: await switchOnZai(db, {
        accountId,
        ratesUrl: 'https://synthetic.invalid/agent-content-rates',
      }),
    }
    passed(
      'the plan key went from the environment of the stand to the operator command on its input; the import passed on the quota answer of the provider',
    )
  } else models = await importAccounts(env)
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
  /** Every finished row of the content journal, whole, by its id. */
  const finishedCalls = async () =>
    new Map(
      (await db.mcpCall.findMany({ where: { result: { not: null } } })).map((row) => [
        row.id,
        JSON.stringify(row, (_, value) => (typeof value === 'bigint' ? String(value) : value)),
      ]),
    )
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
    // A client may tell the role that it has dropped a request, and one CLI does so after every
    // call that has finished. Nothing the journal holds of a finished call may change for it:
    // each row as it stood when the notification came, and again once the role has answered.
    aroundCancelled: async () => {
      const before = await finishedCalls()
      return async () => {
        const after = await finishedCalls()
        for (const [id, row] of before) assert.equal(after.get(id), row)
      }
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
  // One way to the provider per role process, as in the product: without an egress proxy the
  // role connects only to the provider that needs no egress node.
  const paths = { direct: zaiDirectEnvironment(env, stack) }
  let llm, path
  const rolePath = async (wanted) => {
    if (path === wanted) return
    if (live) {
      // One way, the product's for this provider, under the request guard of the run.
      assert.equal(wanted, 'direct')
      llm = await live.startLlm({ stack, env })
      workers.push(llm)
      path = wanted
      return
    }
    await llm?.close()
    llm = await startWorker('llm', {
      env: {
        ...paths[wanted],
        VAULT_ROLE_ID: stack.roles.llm.roleId,
        VAULT_SECRET_ID: stack.roles.llm.secretId,
      },
    })
    workers.push(llm)
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    // The role says which way it goes when it starts.
    const line = `{"event":"llm_egress_path","path":"${wanted}"}`
    await eventually(async () => llm.logs.join('').includes(line), 10_000)
    path = wanted
  }
  await rolePath('direct')
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
  const { backendCapacities } = await import('../dist/llm/backends.js')
  const { llmBackends } = await import('@repo/llm-backends')
  const { createPoolProbeClient } = await import('../dist/llm/pool-probe-client.js')
  const { ContentSnapshotStorage, contentSnapshotKey } =
    await import('../dist/mcp/content-snapshots.js')
  const credentials = new GatewayTurnCredentials({
    prisma: db,
    secrets: createVaultSecretStore({ addr: stack.vaultAddress, appRole: stack.roles.core }),
    requireAssignment: true,
    // As LlmModule composes it: the pool reads an account by the capacity of its backend.
    capacityOf: backendCapacities(llmBackends),
    // As core does: windows nobody has written are the role llm's to probe before a selection.
    probeAccounts: createPoolProbeClient(`http://127.0.0.1:${llmPort}`, metricsToken),
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
  /** The trusted side of the role mcp in a process of its own, with the role's environment. */
  const undo = async (request) => {
    const { fence } = request
    const result = await run(
      process.execPath,
      [join(repository, 'apps/orchestrator/scripts/verify-agent-content-undo.mjs')],
      {
        input: `${JSON.stringify({
          fence: {
            siteId: fence.siteId,
            taskId: fence.taskId,
            operation: fence.operation,
            epoch: Number(fence.epoch),
          },
          turn: request.turn,
        })}\n`,
        env: roleEnvironment({
          path: process.env.PATH,
          home: roleHome(stack.directory),
          port: rolePort,
          allowedHosts: ['127.0.0.1'],
          databaseUrl: stack.databaseUrl,
          vault: { address: stack.vaultAddress, ...stack.roles.mcp },
          s3: stack.s3,
        }),
        allowFailure: true,
      },
    )
    live.logs.push([result.stdout], [result.stderr])
    assert.equal(result.code, 0, `The trusted return failed: ${result.stderr.trim().slice(0, 200)}`)
    return JSON.parse(result.stdout)
  }
  if (mode.rehearsal) await live.proveSandboxSearch(cli.containerName)
  whatIsLeft = () => [
    { name: 'logs of the roles llm and mcp', streams: workers.flatMap((w) => w.streams) },
    { name: 'events and output of the CLI', texts: cliOutputs },
  ]
  const finished = await verifyAgentContentTurns({
    live: live
      ? liveContentTurns({
          live,
          accountId,
          undo,
          outputs: cliOutputs,
          // Only a rehearsal has a provider to script.
          script: mode.rehearsal ? (scenario) => control('zai', { scenario }) : null,
        })
      : undefined,
    exchanges: () => observer.exchanges(),
    db,
    cli,
    control,
    stats: observers.stats,
    settled: observers.settled,
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
    rolePath,
    setStage: (name) => {
      stage = name
    },
  })
  stage = 'the way of each provider'
  assert.equal(path, 'direct')
  if (mode.rehearsal) await live.proveFailureSearch({ stack, places: whatIsLeft() })
  if (live) {
    // The windows the run ends on, by one more reading of the quota through the role.
    const after = await live.quota({ llm, accountId, what: 'at the end' })
    live.growth(finished.windows, after)
    await live.keepExchanges()
  } else {
    // The stand's proxy logs a tunnel by its host when the tunnel ends: the role without a
    // proxy opened none.
    const tunnels = (await stack.compose(['logs', '--no-color', 'llm-egress'])).stdout
      .split('\n')
      .filter((line) => line.includes('"event":"connect"'))
    assert.deepEqual(tunnels, [], 'A provider was reached through the egress proxy')
    // What the synthetic Z.ai got came with the plan key, which only the role llm reads; and
    // the windows of the account, which nobody wrote, are what the role's probe stored at the
    // first issue.
    const zai = await control('zai')
    assert.ok(zai.requests.length > 0, 'The synthetic Z.ai was not asked')
    assert.ok(
      zai.requests.every((request) => request.credential === 'plan-key'),
      'A request reached Z.ai without the plan key',
    )
    const account = await db.subscriptionAccount.findFirstOrThrow({ where: { label: ZAI_LABEL } })
    assert.deepEqual(account.limitWindows.map((window) => window.name).sort(), ['5h', 'week'])
    passed(
      "Z.ai on the role's own connection with the plan key, nothing through the egress proxy; its windows from the role's probe",
    )
  }
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
  // The output of a role is one text a pipe: a read of the pipe may end inside a value.
  const platformText = [
    ...workers.flatMap((worker) => worker.streams.map((chunks) => chunks.join(''))),
    serviceLogs,
    audit,
    dump,
  ].join('\n')
  // Turn keys, MCP tokens, subscription values, the site's password and the visitors' contacts.
  for (const forbidden of [...secretMarkers, ...Object.values(site.pages).map((p) => p.contact)])
    assert.equal(
      platformText.includes(forbidden),
      false,
      'A private marker reached platform storage or logs',
    )
  passed('no turn key, MCP token, site password or contact in platform logs, audit or SQL')
  if (!live) return
  stage = 'the search for the plan key'
  const containers = (
    await run('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${stack.project}`,
    ])
  ).stdout
    .split('\n')
    .filter(Boolean)
  const inspected = await run('docker', ['inspect', ...containers, cli.containerName, guard])
  const places = await live.assertKeyNowhere({
    stack,
    places: [
      { name: 'logs of the services', text: serviceLogs },
      { name: 'audit log of OpenBao', text: audit },
      { name: 'database dump', text: dump },
      { name: 'logs of the roles llm and mcp', streams: workers.flatMap((w) => w.streams) },
      { name: 'events and output of the CLI', texts: cliOutputs },
      { name: 'S3 objects', texts: finished.objects },
      { name: 'content snapshots, opened', texts: finished.opened },
      { name: 'docker inspect of the containers', text: inspected.stdout },
    ],
  })
  passed(
    `the plan key is in none of ${places} places: logs, audit, database, S3 objects and opened snapshots, CLI events, exchanges, docker inspect, the files of the sandbox and of the stand`,
  )
  live.settle()
}

let failure
try {
  if (live) {
    // A live run builds no image: those of the deterministic stand are its own.
    if (!args.has('--no-build')) await run('pnpm', ['--filter', 'orchestrator', 'build'])
    await assertImages()
  } else if (!args.has('--no-build')) await build()
  stage = 'disposable WordPress'
  await verifySiteFoundation({
    scenario: async ({ wp, compose, url }) => {
      try {
        stage = 'WordPress plugin, application password and pages'
        const site = await prepareSite(
          { wp, compose, url },
          live ? liveContentPages() : CONTENT_DRIVERS,
        )
        await stand(site)
      } catch (error) {
        failure = error
        // Before the cleanup removes it: the search for the key over what the run still holds,
        // and with --keep the exchanges, for the diagnosis of the failure.
        if (live) await live.afterFailure({ stack, places: whatIsLeft() })
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
          () => db?.$disconnect(),
          () => s3Client?.destroy(),
          async () => {
            if (live && !(await live.close())) throw new Error('cleanup')
          },
          // Last: the OpenBao container of a live run holds the plan key until it is removed.
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
  if (live)
    // The exit code is of what the platform owes: the last line says where the model's part is.
    console.log(
      mode.rehearsal
        ? `Rehearsal of the live agent content verification passed: ${checks + live.checks()} checks.`
        : `Live agent content verification passed: ${checks + live.checks()} checks; OpenCode 1.18.34 on the real provider, real role llm, regular role mcp under AppRole, real WordPress. The checks are of what the platform owes; the model's outcomes are shares in the REPORT lines.`,
    )
  else
    console.log(
      `Agent content verification passed: ${checks} checks; CLI OpenCode 1.18.34; synthetic provider, real role llm, regular role mcp under AppRole, real WordPress.`,
    )
} catch (error) {
  const cause = failure ?? error
  if (cause.infrastructureDiagnostic) console.error(cause.infrastructureDiagnostic)
  const text = String(cause.stack ?? cause.message ?? cause)
  // The diagnostic is private: assertion values may quote synthetic content or identifiers.
  // A signal is not a failure to diagnose: nothing is left behind for it.
  if (cause instanceof LiveRefusal) {
    console.error(`Live verification refused to start: ${cause.message}`)
    process.exitCode = REFUSED
  } else if (interrupted)
    console.error(
      `Agent content verification interrupted at: ${stage}${live?.expired() ? ' (the time limit of the run)' : ''}`,
    )
  // Nothing is written where the text could hold the plan key.
  else if (live?.key.foundIn(text)) console.error(`Agent content verification failed at: ${stage}`)
  else
    try {
      // The first line of a live failure is the stand's own words: names and numbers.
      if (live)
        console.error(
          String(cause.message ?? '')
            .split('\n')[0]
            .slice(0, 400),
        )
      const directory = await mkdtemp(join(tmpdir(), 'raditi-agent-content-diagnostic-'))
      await chmod(directory, 0o700)
      const path = join(directory, 'failure.log')
      await writeFile(path, text.slice(-64 * 1024), { mode: 0o600 })
      console.error(`Agent content verification failed at: ${stage}; private diagnostic: ${path}`)
    } catch {
      console.error(`Agent content verification failed at: ${stage}`)
    }
  process.exitCode ||= 1
} finally {
  // A run that failed before its stack started was not closed with the stack: its directory
  // and its time limit end here. Closing twice does nothing twice.
  await live?.close().catch(() => {})
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
