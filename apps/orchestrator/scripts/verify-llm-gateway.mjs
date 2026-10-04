/* global AbortSignal, console, fetch */
// A synthetic, disposable gateway-to-CLI verification. No user env-file or login is loaded.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import { createPrismaClient } from '@repo/db'
import { codexBackend, kimiCodeBackend } from '@repo/llm-backends'
import { createVaultSecretStore } from '@repo/vault'

import { seedReferenceData } from '../../../packages/db/prisma/seed/apply.ts'
import { localVaultRequest } from '../../../infra/vault/bootstrap.mjs'
import { CLI_IMAGE, createCliSession, RUNTIME_IMAGE } from '../../../infra/dev/llm-verify/cli.mjs'
import {
  abortVerification,
  eventually,
  repository,
  run,
  startVerificationStack,
} from '../../../infra/dev/llm-verify/stack.mjs'
import {
  SYNTHETIC_KIMI_KEY,
  SYNTHETIC_ERROR_MARKER,
} from '../../../infra/dev/llm-verify/fake-subscriptions.mjs'
import { startWorker } from '../../../infra/dev/llm-verify/workers.mjs'
import { llmConfigFromEnv } from '../src/config/llm-config.ts'
import { createControlEgress, createEgressTransport } from '../src/llm-gateway/egress.ts'
import { SessionSubscriptionLock } from '../src/llm-gateway/session-lock.ts'
import { authenticateSubscription } from '../src/subscriptions/device-login.ts'
import { createSubscriptionClientIdentity, SubscriptionLogin } from '../src/subscriptions/login.ts'
import { verifyLifecycle } from './verify-llm-lifecycle.mjs'
import { verifyCrashes } from './verify-llm-crashes.mjs'
import { verifyProtocol } from './verify-llm-protocol.mjs'
import { verifyStreamFailures } from './verify-llm-gateway-stream.mjs'
import { verifyDriverTurns } from './verify-llm-gateway-drivers.mjs'

const args = new Set(process.argv.slice(2))
if (args.has('--help')) {
  console.log(
    'verify:llm-gateway [--no-build]: disposable PostgreSQL/OpenBao, synthetic TLS providers and real pinned CLI containers. No real subscriptions or .env files.',
  )
  process.exit(0)
}
if ([...args].some((arg) => arg !== '--no-build'))
  throw new Error('Only --no-build is supported; real subscriptions are not accepted')

let stage = 'build',
  checks = 0,
  stack,
  db,
  llm,
  core,
  cli,
  locks,
  guard
const workers = []
const extraLogs = []
const secretMarkers = new Set([SYNTHETIC_KIMI_KEY, SYNTHETIC_ERROR_MARKER])
const promptMarker = `synthetic-prompt-${randomBytes(12).toString('hex')}`
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
// Ctrl-C) would end the process in the middle of its cleanup and leave the stack behind.
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

try {
  if (!args.has('--no-build')) {
    // The production agent runtime first: the CLI image only adds the harness to it.
    await run(
      'docker',
      [
        'build',
        '-f',
        join(repository, 'infra/sandbox/Dockerfile'),
        '--target',
        'runtime',
        '-t',
        RUNTIME_IMAGE,
        repository,
      ],
      { timeoutMs: 900_000 },
    )
    await run(
      'docker',
      [
        'build',
        '-f',
        join(repository, 'infra/dev/llm-verify/cli.Dockerfile'),
        '--build-arg',
        `RUNTIME_IMAGE=${RUNTIME_IMAGE}`,
        '-t',
        CLI_IMAGE,
        join(repository, 'infra/dev/llm-verify'),
      ],
      { timeoutMs: 600_000 },
    )
    await run('pnpm', ['--filter', 'orchestrator', 'build'])
    await run(
      'docker',
      [
        'build',
        '-f',
        join(repository, 'infra/sandbox/Dockerfile'),
        '--target',
        'network-guard',
        '-t',
        'raditi-p3verify-guard:b13',
        repository,
      ],
      { timeoutMs: 300_000 },
    )
  }
  stage = 'disposable stack'
  stack = await startVerificationStack({
    onStage: (name) => {
      stage = name
    },
  })
  console.log('PASS disposable stack and migration bootstrap')
  db = createPrismaClient({ databaseUrl: stack.databaseUrl, log: [] })
  await seedReferenceData(db)
  const user = await db.$queryRaw`SELECT current_user AS name`
  assert.equal(user[0].name, 'raditi')
  const ownership = await db.$queryRaw`SELECT
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS database_owner,
    (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner,
    (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'raditi') AS foreign_tables,
    (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('raditi_app','raditi_web','raditi_core','raditi_llm','postgres_exporter')) AS legacy_roles`
  assert.deepEqual(ownership, [
    { database_owner: 'raditi', schema_owner: 'raditi', foreign_tables: 0, legacy_roles: 0 },
  ])
  passed('shared application database owner')
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
            headers: { 'content-type': 'application/json', 'user-agent': 'codex_exec/0.158.0' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(result.status, 200, 'Synthetic control request failed')
    const value = await result.json()
    for (const credential of [value.tokens, value.credential, value.currentCredential])
      for (const field of [
        'access_token',
        'refresh_token',
        'id_token',
        'accessToken',
        'refreshToken',
        'idToken',
      ])
        if (typeof credential?.[field] === 'string') secretMarkers.add(credential[field])
    for (const request of value.requests ?? []) {
      const token = request.headers?.authorization?.replace(/^Bearer /, '')
      if (token) secretMarkers.add(token)
      for (const field of ['refresh_token', 'token'])
        if (typeof request.body?.[field] === 'string') secretMarkers.add(request.body[field])
    }
    return value
  }
  const roleConfig = (name) => ({
    env: {
      ...env,
      VAULT_ROLE_ID: stack.roles[name].roleId,
      VAULT_SECRET_ID: stack.roles[name].secretId,
    },
  })
  const roleSecret = (name) =>
    createVaultSecretStore({ addr: stack.vaultAddress, appRole: stack.roles[name] })
  const writer = createVaultSecretStore({
    addr: stack.vaultAddress,
    token: stack.tokens['subscriptions-writer'],
  })
  const admin = createVaultSecretStore({
    addr: stack.vaultAddress,
    token: stack.tokens['subscriptions-admin'],
  })
  locks = new SessionSubscriptionLock(stack.databaseUrl)
  const login = new SubscriptionLogin({
    prisma: db,
    writer,
    locks,
    backends: [codexBackend, kimiCodeBackend],
  })
  const http = createControlEgress(createEgressTransport(llmConfigFromEnv(env, 'test').egress))
  stage = 'device login and key import'
  let displayed = false
  const identity = createSubscriptionClientIdentity()
  const credential = await authenticateSubscription({
    backend: codexBackend,
    identity,
    http,
    signal: AbortSignal.timeout(20_000),
    showDeviceCode: async () => {
      displayed = true
    },
    readSecret: async () => {
      throw new Error('Unexpected secret input')
    },
  })
  assert.equal(displayed, true)
  const codex = await login.importAccount({
    backend: codexBackend.id,
    driverId: 'codex',
    label: 'synthetic-codex',
    credential,
    clientIdentity: identity,
    maxConcurrentTurns: 1,
    maxConcurrentRequests: 2,
  })
  const otherIdentity = (token) => {
    const parts = token.split('.')
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    claims['https://api.openai.com/auth'].chatgpt_account_id = 'another-synthetic-account'
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return parts.join('.')
  }
  const wrong = {
    ...credential,
    chatgptAccountId: 'another-synthetic-account',
    accessToken: otherIdentity(credential.accessToken),
    idToken: otherIdentity(credential.idToken),
  }
  await assert.rejects(
    login.relogin({ backend: codexBackend.id, accountId: codex.accountId, credential: wrong }),
    (error) => error.code === 'identity_mismatch',
  )
  const key = SYNTHETIC_KIMI_KEY
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
    { input: `${key}\n`, env },
  )
  const kimi = JSON.parse(imported.stdout)
  passed('Codex device flow, foreign identity rejection and Kimi stdin import')
  stage = 'Vault policy boundaries'
  await assert.rejects(
    writer.kvRead(`subs/openai-chatgpt/${codex.accountId}`),
    (error) => error.status === 403,
  )
  const llmSecrets = roleSecret('llm')
  await assert.rejects(
    llmSecrets.kvMetadata(`subs/openai-chatgpt/${codex.accountId}`),
    (error) => error.status === 403,
  )
  await assert.rejects(
    roleSecret('core').kvRead(`subs/openai-chatgpt/${codex.accountId}`),
    (error) => error.status === 403,
  )
  await assert.rejects(
    llmSecrets.kvDestroyAll(`subs/openai-chatgpt/${codex.accountId}`),
    (error) => error.status === 403,
  )
  await assert.rejects(
    llmSecrets.kvDelete(`subs/openai-chatgpt/${codex.accountId}`),
    (error) => error.status === 403,
  )
  for (const mount of ['subs', 'turns']) {
    const configuration = await stack.request(`${mount}/config`)
    assert.equal(configuration.data.max_versions, 1)
    assert.equal(configuration.data.cas_required, true)
  }
  const versionPath = 'subs/openai-chatgpt/synthetic-version-check'
  await assert.rejects(writer.kvWrite(versionPath, { value: 'first' }))
  await writer.kvWrite(versionPath, { value: 'first' }, { cas: 0 })
  await llmSecrets.kvWrite(versionPath, { value: 'second' }, { cas: 1 })
  assert.equal((await llmSecrets.kvRead(versionPath)).version, 2)
  const historical = await localVaultRequest(
    stack.root,
    'subs/data/openai-chatgpt/synthetic-version-check?version=1',
  )
  assert.equal(historical.status, 404)
  await admin.kvDestroyAll(versionPath)
  passed('distinct Vault capabilities, mandatory CAS and destruction of prior versions')
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
    await db.llmModelPrice.create({
      data: {
        modelId: model.id,
        effectiveFrom: new Date(Date.now() - 60_000),
        inputPer1m: '10',
        outputPer1m: '30',
        vatRate: '0.22',
        sourceUrl: 'https://synthetic.invalid/b13-rates',
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
  stage = 'separate application workers'
  llm = await startWorker('llm', roleConfig('llm'))
  workers.push(llm)
  await eventually(
    async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
  )
  core = await startWorker('core', {
    ...roleConfig('core'),
    llmControlUrl: `http://127.0.0.1:${stack.llmPort}`,
  })
  workers.push(core)
  const workspace = await db.workspace.create({
    data: { name: 'B13 synthetic workspace', dataClass: 'synthetic' },
  })
  const task = async (backend, overrides = {}) => {
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'B13 synthetic site',
        url: `https://${randomUUID()}.invalid`,
        stack: 'wordpress',
      },
    })
    const record = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        status: 'running',
        modelClass: 'standard',
      },
    })
    await db.siteLease.create({
      data: {
        siteId: site.id,
        holderTaskId: record.id,
        epoch: 1,
        operation: 'turn',
        expiresAt: new Date(Date.now() + 1_200_000),
      },
    })
    const ref = { taskId: record.id, sessionId: randomUUID(), turn: 1, epoch: 1 }
    const grant = {
      driverId: backend === 'openai-chatgpt' ? 'codex' : 'kimi',
      backend,
      modelSlug: models[backend].slug,
      modelClass: 'standard',
      reasoningEffort: 'low',
      ttlMs: 600_000,
      deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
      budgetRub: '135.00',
      boundSource: null,
      ...overrides,
    }
    return { ref, grant, record }
  }
  const issued = async (backend, overrides) => {
    const item = await task(backend, overrides)
    const values = await core.call('issue', { ref: item.ref, grant: item.grant })
    secretMarkers.add(values.llmApiKey)
    secretMarkers.add(values.mcpToken)
    return { ...item, values }
  }
  const codexTurn = await issued('openai-chatgpt')
  assert.deepEqual(await core.call('recover', { ref: codexTurn.ref }), codexTurn.values)
  assert.deepEqual(
    await core.call('issue', { ref: codexTurn.ref, grant: codexTurn.grant }),
    codexTurn.values,
  )
  const busy = await task('openai-chatgpt')
  // The only account is healthy but holds its one turn: occupied slots, not missing capacity.
  await assert.rejects(
    core.call('issue', { ref: busy.ref, grant: busy.grant }),
    (error) => error.code === 'SUBSCRIPTION_BUSY',
  )
  passed('durable issuance, recovery and one-turn Codex capacity')
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
    'raditi-p3verify-guard:b13',
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
  // Every production-shaped CLI run starts from its driver (prepare + command); hand-written
  // configs remain only in the protocol scenarios below that need fixed retries or plain text.
  stage = 'driver-prepared CLI turns'
  const kimiTurn = await issued('kimi-code')
  const driverRequests = await verifyDriverTurns({
    cli,
    control,
    passed,
    codexTurn,
    kimiTurn,
    promptMarker,
    secretMarkers,
  })
  stage = 'request and accounting assertions'
  const state = await control('state')
  const codexRequests = state.requests.filter(
    (entry) => entry.path === '/backend-api/codex/responses',
  )
  const kimiRequests = state.requests.filter(
    (entry) => entry.path === '/coding/v1/chat/completions',
  )
  assert.equal(codexRequests.length, driverRequests.codexRequests)
  assert.equal(kimiRequests.length, driverRequests.kimiRequests)
  for (const request of codexRequests) {
    assert.equal(request.body.store, false)
    assert.equal(request.body.max_output_tokens, undefined)
    assert.equal(request.headers['chatgpt-account-id'], credential.chatgptAccountId)
    assert.match(request.body.prompt_cache_key, /^rdt_/)
  }
  const kimiAccount = await db.subscriptionAccount.findUniqueOrThrow({
    where: { id: kimi.accountId },
  })
  for (const request of kimiRequests) {
    assert.equal(request.headers['x-msh-device-id'], kimiAccount.clientIdentity.deviceId)
    assert.equal(request.headers['user-agent'], 'kimi-code-cli/2.1.1')
  }
  const calls = await db.llmCall.findMany({ where: { state: 'completed' } })
  const usage = await db.tokenUsage.findMany({
    where: { gatewayCallId: { in: calls.map((call) => call.id) } },
  })
  assert.equal(usage.length, calls.length)
  assert.ok(calls.length >= 8)
  const kimiUsage = usage.filter((entry) => entry.taskId === kimiTurn.ref.taskId)
  assert.equal(kimiUsage.length, kimiRequests.length)
  for (const entry of kimiUsage) {
    assert.equal(entry.estimated, false)
    assert.equal(entry.inputUncachedTokens, 80)
    assert.equal(entry.cacheReadTokens, 20)
    assert.equal(entry.outputTokens, 12)
    assert.equal(entry.reasoningTokens, 3)
  }
  passed('provider headers/body normalization and gateway-owned usage')
  // Further protocol/lifecycle cases reuse the same real stack and trusted core worker.
  stage = 'request policy refusals'
  const valid = { model: 'gpt-6-sol', input: 'synthetic', stream: true, store: false }
  for (const body of [
    { ...valid, store: true },
    { ...valid, unexpected: true },
    { ...valid, tools: [{ type: 'web_search' }] },
  ]) {
    const response = await cli.request({
      key: codexTurn.values.llmApiKey,
      path: '/codex/responses',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex_exec/0.158.0' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
  }
  for (const path of ['/kimi/v1/search', '/codex/wham/usage'])
    assert.equal(
      (await cli.request({ key: codexTurn.values.llmApiKey, path, body: '{}' })).status,
      403,
    )
  assert.equal(
    (
      await cli.request({
        key: codexTurn.values.llmApiKey,
        path: '/kimi/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'user-agent': 'codex_exec/0.158.0' },
        body: JSON.stringify({
          model: 'k3-256k',
          messages: [{ role: 'user', content: 'synthetic' }],
          stream: true,
        }),
      })
    ).status,
    403,
  )
  passed('gateway body policy and sandbox route refusals')
  stage = 'revocation'
  await core.call('revoke', { ref: codexTurn.ref })
  assert.equal(
    (
      await cli.request({
        key: codexTurn.values.llmApiKey,
        path: '/codex/responses',
        headers: { 'content-type': 'application/json', 'user-agent': 'codex_exec/0.158.0' },
        body: JSON.stringify(valid),
      })
    ).status,
    401,
  )
  await core.call('revoke', { ref: kimiTurn.ref })
  passed('durable early turn-key revocation')
  const restartLlm = async () => {
    await llm.close()
    llm = await startWorker('llm', roleConfig('llm'))
    workers.push(llm)
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    return llm
  }
  const context = {
    db,
    core,
    stack,
    env,
    codex,
    kimi,
    cli,
    promptMarker,
    control,
    task,
    issued,
    passed,
    http,
    llmSecrets,
    writer,
    admin,
    locks,
    restartLlm,
    llmGetter: () => llm,
    extraLogs,
    secretMarkers,
    runDriver: driverRequests.runDriver,
  }
  stage = 'CLI retry, admission and protocol boundaries'
  await verifyProtocol(context)
  stage = 'in-stream provider failures'
  await verifyStreamFailures(context)
  stage = 'crash and persistence recovery'
  await verifyCrashes(context)
  stage = 'runtime lifecycle'
  await verifyLifecycle(context)
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
  await control('state')
  const publicText = [
    ...workers.flatMap((worker) => worker.logs),
    ...extraLogs.flat(),
    serviceLogs,
    audit,
    dump,
  ].join('\n')
  for (const forbidden of [
    ...secretMarkers,
    promptMarker,
    codexTurn.values.llmApiKey,
    kimiTurn.values.llmApiKey,
    credential.accessToken,
    credential.refreshToken,
    key,
  ])
    assert.equal(
      publicText.includes(forbidden),
      false,
      'A private marker reached platform storage or logs',
    )
  passed('no prompt, turn key or subscription value in platform logs, audit or SQL')
  console.log(
    `Synthetic gateway verification passed: ${checks} checks; CLI Codex 0.158.0 / Kimi 2.1.1.`,
  )
} catch (error) {
  if (error.infrastructureDiagnostic) console.error(error.infrastructureDiagnostic)
  const frame = error.stack
    ?.split('\n')
    .find((line) => line.includes('verify-') || line.includes('/llm-verify/'))
  if (frame) console.error(frame.trim())
  if (error.message?.startsWith('Invalid published')) console.error(error.message.split('\n')[0])
  console.error(
    `Synthetic gateway verification failed at: ${stage}. No private diagnostics are printed.`,
  )
  process.exitCode = 1
} finally {
  const cleanup = [
    () => cli?.close(),
    () => guard && run('docker', ['rm', '-f', guard], { allowFailure: true, cleanup: true }),
    ...workers
      .slice()
      .reverse()
      .map((worker) => () => worker.close()),
    () => locks?.close(),
    () => db?.$disconnect(),
    () => stack?.close(),
  ]
  for (const close of cleanup) {
    try {
      await close()
    } catch {
      console.error('An owned verification resource could not be cleaned up')
      process.exitCode = 1
    }
  }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
