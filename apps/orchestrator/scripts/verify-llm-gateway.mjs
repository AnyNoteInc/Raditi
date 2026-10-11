/* global AbortSignal, console, fetch */
// A synthetic, disposable gateway-to-CLI verification. No user env-file or login is loaded.
// With --live the same path ends at the real provider (verify-llm-live.mjs).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import { createPrismaClient } from '@repo/db'
import { createVaultSecretStore } from '@repo/vault'

import { seedReferenceData } from '../../../packages/db/prisma/seed/apply.ts'
import {
  CLI_IMAGE,
  createCliSession,
  GUARD_IMAGE,
  RUNTIME_IMAGE,
} from '../../../infra/dev/llm-verify/cli.mjs'
import {
  abortVerification,
  eventually,
  repository,
  run,
  startVerificationStack,
} from '../../../infra/dev/llm-verify/stack.mjs'
import {
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_MARKER,
  SYNTHETIC_ZAI_ROTATED_KEY,
} from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { standMode } from '../../../infra/dev/llm-verify/live.mjs'
import { startWorker } from '../../../infra/dev/llm-verify/workers.mjs'
import { SessionSubscriptionLock } from '../src/llm-gateway/session-lock.ts'
import { runLiveGateway } from './verify-llm-live.mjs'
import { verifyZai } from './verify-llm-zai.mjs'

if (process.argv.includes('--help')) {
  console.log(
    'verify:llm-gateway [--no-build]: disposable PostgreSQL/OpenBao, synthetic TLS providers and real pinned CLI containers. No real subscriptions or .env files.\n' +
      'verify:llm-gateway --live [--measure | --results] [--no-build] [--keep=<directory>]: the same path to the real provider, with ZAI_API_KEY in the environment; never in CI.\n' +
      'verify:llm-gateway --rehearsal [--measure | --results] [--no-build]: the live flow on the synthetic provider.\n' +
      'infra/dev/llm-verify/README.md',
  )
  process.exit(0)
}
const mode = standMode(process.argv.slice(2), { stand: 'gateway' })
// The live mode and its rehearsal are a run of their own: nothing below starts for them, and
// the plan key leaves the environment before any other process exists.
if (mode.live || mode.rehearsal) process.exit(await runLiveGateway(mode))
const args = new Set(mode.noBuild ? ['--no-build'] : [])

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
const secretMarkers = new Set([
  // Both plan keys of the synthetic Z.ai and the text its refusals carry.
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_ROTATED_KEY,
  SYNTHETIC_ZAI_MARKER,
])
const promptMarker = `synthetic-prompt-${randomBytes(12).toString('hex')}`
// A floor under the count of completed calls the usage check looks at: the stand completes 37
// (the count is in its REPORT line), and a stand that lost a group of its turns must not pass
// that check on what is left.
const MIN_COMPLETED_CALLS = 30
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
        GUARD_IMAGE,
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
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(result.status, 200, 'Synthetic control request failed')
    return result.json()
  }
  // `base`: the environment of the role; the Z.ai group restarts llm without the egress proxy.
  const roleConfig = (name, base = env) => ({
    env: {
      ...base,
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
  const writerFile = join(stack.directory, 'writer.token')
  await writeFile(writerFile, stack.tokens['subscriptions-writer'], { mode: 0o400 })
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
  const restartLlm = async (base = env) => {
    await llm.close()
    llm = await startWorker('llm', roleConfig('llm', base))
    workers.push(llm)
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    return llm
  }
  // Every scenario of the stand runs in this one group, on a key of its backend: the turns of
  // the pinned CLI through its driver and the scenarios of the platform alike.
  stage = 'Z.ai through the OpenCode driver'
  await verifyZai({
    db,
    core,
    stack,
    env,
    cli,
    promptMarker,
    control,
    passed,
    llmSecrets: roleSecret('llm'),
    coreSecrets: roleSecret('core'),
    writer,
    admin,
    locks,
    restartLlm,
    llmGetter: () => llm,
    extraLogs,
    secretMarkers,
    metricsToken,
    writerFile,
    setStage: (name) => {
      stage = `Z.ai: ${name}`
    },
  })
  stage = 'usage of every completed call'
  // The usage of a call is the gateway's own row, written once when the call closes: over
  // every completed call of the stand, whatever scenario made it.
  const completed = await db.llmCall.findMany({
    where: { state: 'completed' },
    select: { id: true },
  })
  const usage = await db.tokenUsage.findMany({
    where: { gatewayCallId: { in: completed.map((call) => call.id) } },
    select: { gatewayCallId: true },
  })
  // The number itself goes to the output: the floor above is set from it.
  console.log(`REPORT completed calls of the stand: ${completed.length}`)
  assert.ok(completed.length >= MIN_COMPLETED_CALLS, 'The stand completed too few calls')
  assert.equal(usage.length, completed.length)
  assert.equal(new Set(usage.map((row) => row.gatewayCallId)).size, completed.length)
  passed('gateway-owned usage: every completed call of the stand has exactly one usage row')
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
    // One text a pipe, and one for each worker of an earlier scenario: a read of a pipe may
    // end inside a value.
    ...workers.flatMap((worker) => worker.streams.map((chunks) => chunks.join(''))),
    ...extraLogs.map((chunks) => chunks.join('')),
    serviceLogs,
    audit,
    dump,
  ].join('\n')
  for (const forbidden of [...secretMarkers, promptMarker])
    assert.equal(
      publicText.includes(forbidden),
      false,
      'A private marker reached platform storage or logs',
    )
  passed('no prompt, turn key or subscription value in platform logs, audit or SQL')
  console.log(`Synthetic gateway verification passed: ${checks} checks; CLI OpenCode 1.18.34.`)
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
