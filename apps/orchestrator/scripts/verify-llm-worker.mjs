/* global Buffer, clearTimeout, process, setTimeout, URL */
// B13's isolated llm role. The harness supplies only disposable local configuration by IPC;
// importing this worker never reads an env-file or the operator's subscription login.
import { createPrismaClient, dbConfigFromEnv } from '@repo/db'
import { llmBackends } from '@repo/llm-backends'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { z } from 'zod'

import { roleProfileProblems } from '../../../infra/dev/llm-verify/live.mjs'
import { egressConfigFromEnv, llmConfigFromEnv } from '../dist/config/llm-config.js'
import { decodeSubscriptionCredential } from '../dist/llm-gateway/credentials.js'
import { createControlEgress, createEgressTransport } from '../dist/llm-gateway/egress.js'
import { LlmRuntime } from '../dist/llm-gateway/llm-app.module.js'

const initSchema = z.strictObject({
  type: z.literal('init'),
  config: z.strictObject({
    env: z.record(z.string(), z.string()),
    // `live`: the real provider, as production reaches it (infra/dev/llm-verify/live.mjs).
    profile: z.enum(['synthetic', 'live']).default('synthetic'),
  }),
})
const id = z.string().min(1).max(128)
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ id, operation: z.literal('close') }),
  z.strictObject({ id, operation: z.literal('quota'), accountId: z.uuid() }),
])
const local = (value) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
let runtime
let db
let closing

/**
 * The account's quota as the provider answers it now: the adapter's own probe, sent on the
 * role's own way out with the plan key this role reads from Vault — one more quota request of
 * the role. The stand gets the adapter's reading and the numbers of the answer (the level of the
 * plan, the credits of each limit): no identifier and nothing of the key.
 */
async function quota({ accountId }, { egress, secrets }) {
  const account = await db.subscriptionAccount.findUniqueOrThrow({
    where: { id: accountId },
    include: { provider: true, credentialRef: true },
  })
  const backend = llmBackends.find((item) => item.id === account.provider.slug)
  const credential = decodeSubscriptionCredential(
    await secrets.kvRead(account.credentialRef.vaultPath),
    backend,
  )
  const transport = createControlEgress(createEgressTransport(egress))
  let answered = null
  const probe = await backend.probe(credential, {
    async request(input, options) {
      const response = await transport.request(input, options)
      answered = response.body
      return response
    },
  })
  let data = null
  try {
    data = JSON.parse(Buffer.from(answered ?? '').toString())?.data ?? null
  } catch {
    /* The adapter's reading says what the answer was worth. */
  }
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    status: probe.status,
    windows: probe.windows,
    level: typeof data?.level === 'string' && /^[\w-]{1,32}$/.test(data.level) ? data.level : null,
    limits: (Array.isArray(data?.limits) ? data.limits : []).slice(0, 8).map((limit) => ({
      unit: number(limit?.unit),
      number: number(limit?.number),
      usage: number(limit?.usage),
      currentValue: number(limit?.currentValue),
      remaining: number(limit?.remaining),
      percentage: number(limit?.percentage),
      nextResetTime: number(limit?.nextResetTime),
    })),
  }
}

function send(message) {
  return new Promise((resolve) => {
    if (!process.connected || !process.send) return resolve()
    process.send(message, () => resolve())
  })
}

function stop(code, response) {
  if (closing) return closing
  closing = (async () => {
    const forced = setTimeout(() => process.exit(1), 12_000)
    forced.unref()
    try {
      if (runtime) await runtime.onApplicationShutdown()
      else if (db) await db.$disconnect()
    } catch {
      code = 1
    }
    if (response)
      await send(
        code === 0
          ? response
          : { id: response.id, ok: false, error: { code: 'WORKER_CLOSE_FAILED' } },
      )
    clearTimeout(forced)
    process.exit(code)
  })()
  return closing
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('B13 llm worker: start by IPC after building orchestrator.\n')
    return
  }
  if (!process.send || process.argv.length !== 2) throw new Error('Invalid worker invocation')
  process.once('disconnect', () => void stop(0))
  process.once('SIGINT', () => void stop(0))
  process.once('SIGTERM', () => void stop(0))
  process.once('uncaughtException', () => void stop(1))
  process.once('unhandledRejection', () => void stop(1))
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Initialization timeout')), 30_000)
    process.once('message', (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
  const { env, profile } = initSchema.parse(message).config
  if (env.APP_ENV !== 'test') throw new Error('Disposable verification only')
  const database = dbConfigFromEnv(env)
  const vault = vaultConfigFromEnv(env)
  if (!local(database.databaseUrl) || !local(vault.addr) || !vault.appRole || vault.token)
    throw new Error('Disposable local AppRole configuration required')
  const config = llmConfigFromEnv(env, 'test')
  // The synthetic profile never reaches a real provider: the stand's local proxy, or, without
  // a proxy, every origin the role may reach itself pointed at a loopback fake, and the stand's
  // synthetic CA alone. The live profile is the opposite, and exactly production's: the
  // product's own list of what a production role refuses, on the direct path, under the request
  // guard of the run.
  const { egress } = config
  const problems = roleProfileProblems({
    profile,
    egress,
    directOrigins: llmBackends
      .flatMap((backend) => backend.egress)
      .filter((origin) => origin.direct)
      .map((origin) => origin.origin),
    env,
    processEnv: process.env,
    execArgv: process.execArgv,
    guarded: globalThis[Symbol.for('raditi.live-guard')] !== undefined,
    productionEgress: (values) => egressConfigFromEnv(values, 'production'),
  })
  if (problems.length) {
    // Names of settings alone: the product's configuration errors echo no value.
    process.stderr.write(`llm worker, profile ${profile}: ${problems.join('; ')}\n`)
    throw new Error(problems[0])
  }
  const metricsToken = z
    .string()
    .regex(/^\S{24,4096}$/)
    .parse(env.METRICS_TOKEN)
  db = createPrismaClient({ ...database, log: [] })
  const secrets = createVaultSecretStore(vault)
  runtime = new LlmRuntime({ ...config, db: database, vault, metricsToken }, db, secrets)
  const address = await runtime.listen()
  process.on('message', (request) => {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) {
      const id = typeof request?.id === 'string' ? request.id.slice(0, 128) : null
      void send({ id, ok: false, error: { code: 'INVALID_WORKER_REQUEST' } })
      return
    }
    if (parsed.data.operation === 'close') {
      void stop(0, { id: parsed.data.id, ok: true, result: null })
      return
    }
    quota(parsed.data, { egress, secrets }).then(
      (result) => send({ id: parsed.data.id, ok: true, result }),
      () => send({ id: parsed.data.id, ok: false, error: { code: 'WORKER_OPERATION_FAILED' } }),
    )
  })
  await send({ type: 'ready', address })
}

main().catch(async () => {
  await send({ type: 'error', error: { code: 'WORKER_INITIALIZATION_FAILED' } })
  await stop(1)
})
