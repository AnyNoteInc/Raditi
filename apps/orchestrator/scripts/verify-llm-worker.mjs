/* global clearTimeout, process, setTimeout, URL */
// B13's isolated llm role. The harness supplies only disposable local configuration by IPC;
// importing this worker never reads an env-file or the operator's subscription login.
import { createPrismaClient, dbConfigFromEnv } from '@repo/db'
import { llmBackends } from '@repo/llm-backends'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { z } from 'zod'

import { llmConfigFromEnv } from '../dist/config/llm-config.js'
import { LlmRuntime } from '../dist/llm-gateway/llm-app.module.js'

const initSchema = z.strictObject({
  type: z.literal('init'),
  config: z.strictObject({ env: z.record(z.string(), z.string()) }),
})
const requestSchema = z.strictObject({
  id: z.string().min(1).max(128),
  operation: z.literal('close'),
})
const local = (value) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
let runtime
let db
let closing

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
  const { env } = initSchema.parse(message).config
  if (env.APP_ENV !== 'test') throw new Error('Disposable verification only')
  const database = dbConfigFromEnv(env)
  const vault = vaultConfigFromEnv(env)
  if (!local(database.databaseUrl) || !local(vault.addr) || !vault.appRole || vault.token)
    throw new Error('Disposable local AppRole configuration required')
  const config = llmConfigFromEnv(env, 'test')
  // Never a real provider: through the stand's local proxy, or, without a proxy, only with
  // every origin the role may reach itself pointed at a loopback fake. Either way the
  // providers' TLS is checked against the stand's synthetic CA alone.
  const { egress } = config
  const fakes = llmBackends
    .flatMap((backend) => backend.egress)
    .filter((origin) => origin.direct)
    .every((origin) => egress.backendOrigins.has(origin.origin))
  if (!egress.upstreamCaFile || !(egress.proxyUrl ? local(egress.proxyUrl) : fakes))
    throw new Error(
      'A local mTLS proxy or loopback provider fakes, and an explicit synthetic upstream CA required',
    )
  const metricsToken = z
    .string()
    .regex(/^\S{24,4096}$/)
    .parse(env.METRICS_TOKEN)
  db = createPrismaClient({ ...database, log: [] })
  runtime = new LlmRuntime(
    { ...config, db: database, vault, metricsToken },
    db,
    createVaultSecretStore(vault),
  )
  const address = await runtime.listen()
  process.on('message', (request) => {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) {
      const id = typeof request?.id === 'string' ? request.id.slice(0, 128) : null
      void send({ id, ok: false, error: { code: 'INVALID_WORKER_REQUEST' } })
      return
    }
    void stop(0, { id: parsed.data.id, ok: true, result: null })
  })
  await send({ type: 'ready', address })
}

main().catch(async () => {
  await send({ type: 'error', error: { code: 'WORKER_INITIALIZATION_FAILED' } })
  await stop(1)
})
