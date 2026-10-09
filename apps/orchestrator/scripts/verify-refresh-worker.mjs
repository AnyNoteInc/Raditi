/* global clearTimeout, process, setTimeout, URL */
// Fault barriers live only in this synthetic IPC worker; production rotation is unchanged.
import { createPrismaClient, dbConfigFromEnv } from '@repo/db'
import { codexBackend, kimiCodeBackend } from '@repo/llm-backends'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { z } from 'zod'

import { llmConfigFromEnv } from '../dist/config/llm-config.js'
import { createCredentialSource } from '../dist/llm-gateway/credentials.js'
import { createControlEgress, createEgressTransport } from '../dist/llm-gateway/egress.js'
import { SubscriptionRefresher } from '../dist/llm-gateway/refresher.js'
import { SessionSubscriptionLock } from '../dist/llm-gateway/session-lock.js'

const id = z.string().min(1).max(128)
const barrierSchema = z.enum(['before_http', 'before_vault', 'after_vault'])
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    id,
    operation: z.literal('refresh'),
    accountId: z.uuid(),
    observedVersion: z.number().int().min(0),
    barrier: barrierSchema.optional(),
  }),
  z.strictObject({ id, operation: z.literal('release') }),
  z.strictObject({
    id,
    operation: z.literal('advance'),
    milliseconds: z.number().int().min(0).max(300_000),
  }),
  z.strictObject({ id, operation: z.literal('close') }),
])
const local = (value) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
let db,
  refresher,
  barrier,
  release,
  closing,
  clockOffset = 0
const send = (message) =>
  new Promise((resolve) => {
    if (!process.connected || !process.send) return resolve()
    process.send(message, () => resolve())
  })
async function hold(phase) {
  if (barrier !== phase) return
  barrier = undefined
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  await send({ type: 'barrier', phase })
  await waiting
  release = undefined
}
function stop(code, response) {
  if (closing) return closing
  closing = (async () => {
    const forced = setTimeout(() => process.exit(1), 12_000)
    forced.unref()
    release?.()
    try {
      await refresher?.close()
      await db?.$disconnect()
    } catch {
      code = 1
    }
    if (response)
      await send({
        id: response.id,
        ok: code === 0,
        result: null,
        ...(code ? { error: { code: 'WORKER_CLOSE_FAILED' } } : {}),
      })
    clearTimeout(forced)
    process.exit(code)
  })()
  return closing
}
async function operate(request) {
  switch (request.operation) {
    case 'refresh': {
      if (release || barrier) throw new Error('A fault barrier is already active')
      barrier = request.barrier
      const value = await refresher.refresh(request.accountId, 'auth', request.observedVersion)
      return { delivered: value !== null }
    }
    case 'release':
      release?.()
      return null
    case 'advance':
      clockOffset += request.milliseconds
      return null
  }
}
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('B13 disposable rotation worker: private IPC, synthetic crash barriers.\n')
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
  const { env } = z
    .strictObject({
      type: z.literal('init'),
      config: z.strictObject({ env: z.record(z.string(), z.string()) }),
    })
    .parse(message).config
  if (env.APP_ENV !== 'test') throw new Error('Disposable verification only')
  const database = dbConfigFromEnv(env)
  const vault = vaultConfigFromEnv(env)
  const config = llmConfigFromEnv(env, 'test')
  if (
    !local(database.databaseUrl) ||
    !local(vault.addr) ||
    !vault.appRole ||
    vault.token ||
    !config.egress.proxyUrl ||
    !local(config.egress.proxyUrl) ||
    !config.egress.upstreamCaFile
  )
    throw new Error('Disposable local PostgreSQL, AppRole and synthetic mTLS required')
  db = createPrismaClient({ ...database, log: [] })
  const store = createVaultSecretStore(vault)
  const secrets = {
    ...store,
    async kvWrite(...args) {
      await hold('before_vault')
      const result = await store.kvWrite(...args)
      await hold('after_vault')
      return result
    },
  }
  const http = createControlEgress(createEgressTransport(config.egress))
  refresher = new SubscriptionRefresher({
    prisma: db,
    secrets,
    credentials: createCredentialSource(secrets),
    backends: [codexBackend, kimiCodeBackend],
    http: {
      async request(...args) {
        await hold('before_http')
        return http.request(...args)
      },
    },
    channelHealthy: () => true,
    onRegion: () => {},
    locks: new SessionSubscriptionLock(database.databaseUrl),
    now: () => Date.now() + clockOffset,
    logger: (event) => {
      void send({ type: 'event', event })
    },
  })
  await db.$connect()
  process.on('message', (request) => {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success || closing) {
      void send({
        id: typeof request?.id === 'string' ? request.id.slice(0, 128) : null,
        ok: false,
        error: { code: 'INVALID_WORKER_REQUEST' },
      })
      return
    }
    if (parsed.data.operation === 'close') {
      void stop(0, parsed.data)
      return
    }
    void operate(parsed.data).then(
      (result) => send({ id: parsed.data.id, ok: true, result }),
      () => send({ id: parsed.data.id, ok: false, error: { code: 'WORKER_OPERATION_FAILED' } }),
    )
  })
  await send({ type: 'ready' })
}
main().catch(async () => {
  await send({ type: 'error', error: { code: 'WORKER_INITIALIZATION_FAILED' } })
  await stop(1)
})
