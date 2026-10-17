/* global clearTimeout, process, setTimeout, URL */
// B13's separate trusted core process: the real durable turn-key lifecycle over disposable
// PostgreSQL/OpenBao. Subscription values are inaccessible to this role's AppRole.
import { createPrismaClient, dbConfigFromEnv } from '@repo/db'
import { isDomainError, turnCredentialGrantSchema } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { z } from 'zod'

import { backendCapacities } from '../dist/llm/backends.js'
import { CredentialSweeper } from '../dist/llm/credential-sweeper.js'
import { createPoolProbeClient } from '../dist/llm/pool-probe-client.js'
import { GatewayTurnCredentials } from '../dist/llm/turn-credentials.js'
import { turnCredentialRefSchema } from '../dist/llm/turn-key.js'

const initSchema = z.strictObject({
  type: z.literal('init'),
  config: z.strictObject({
    env: z.record(z.string(), z.string()),
    llmControlUrl: z.string().optional(),
    minTurnHeadroomPct: z.number().positive().max(100).optional(),
  }),
})
const id = z.string().min(1).max(128)
const grantSchema = turnCredentialGrantSchema.extend({
  deadlineAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
})
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    id,
    operation: z.literal('issue'),
    ref: turnCredentialRefSchema,
    grant: grantSchema,
  }),
  z.strictObject({ id, operation: z.literal('recover'), ref: turnCredentialRefSchema }),
  z.strictObject({ id, operation: z.literal('revoke'), ref: turnCredentialRefSchema }),
  z.strictObject({ id, operation: z.literal('sweep') }),
  z.strictObject({ id, operation: z.literal('close') }),
])
const errorCodes = new Set([
  'BAD_REQUEST',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'LEASE_LOST',
  'SUBSCRIPTION_WAIT',
  'SUBSCRIPTION_BUSY',
  'LLM_PRICE_MISSING',
  'LLM_GATEWAY_UNAVAILABLE',
  'CROSS_BORDER_NOT_CLEARED',
])
const local = (value) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)
const pending = new Set()
let db
let sweeper
let credentials
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
      await Promise.allSettled([...pending])
      if (sweeper) await sweeper.close()
      if (db) await db.$disconnect()
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

async function operate(request) {
  switch (request.operation) {
    case 'issue':
      return credentials.issue(request.ref, request.grant)
    case 'recover':
      return credentials.recover(request.ref)
    case 'revoke':
      await credentials.revoke(request.ref)
      return null
    case 'sweep':
      await sweeper.tick()
      return null
  }
}

function receive(request) {
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success || closing) {
    const id = typeof request?.id === 'string' ? request.id.slice(0, 128) : null
    void send({ id, ok: false, error: { code: 'INVALID_WORKER_REQUEST' } })
    return
  }
  const command = parsed.data
  if (command.operation === 'close') {
    void stop(0, { id: command.id, ok: true, result: null })
    return
  }
  const job = Promise.resolve()
    .then(() => operate(command))
    .then((result) => send({ id: command.id, ok: true, result }))
    .catch((error) =>
      send({
        id: command.id,
        ok: false,
        error: {
          code:
            isDomainError(error) && errorCodes.has(error.code)
              ? error.code
              : 'WORKER_OPERATION_FAILED',
        },
      }),
    )
    .finally(() => pending.delete(job))
  pending.add(job)
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('B13 core worker: start by IPC after building orchestrator.\n')
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
  const config = initSchema.parse(message).config
  const { env } = config
  if (env.APP_ENV !== 'test') throw new Error('Disposable verification only')
  const database = dbConfigFromEnv(env)
  const vault = vaultConfigFromEnv(env)
  if (!local(database.databaseUrl) || !local(vault.addr) || !vault.appRole || vault.token)
    throw new Error('Disposable local AppRole configuration required')
  const secrets = createVaultSecretStore(vault)
  db = createPrismaClient({ ...database, log: [] })
  credentials = new GatewayTurnCredentials({
    prisma: db,
    secrets,
    minTurnHeadroomPct: config.minTurnHeadroomPct,
    // As LlmModule composes it: the pool reads an account by the capacity of its backend.
    capacityOf: backendCapacities(llmBackends),
    ...(config.llmControlUrl === undefined
      ? {}
      : { probeAccounts: createPoolProbeClient(config.llmControlUrl, env.METRICS_TOKEN) }),
  })
  sweeper = new CredentialSweeper({ prisma: db, secrets, credentials })
  await db.$connect()
  process.on('message', receive)
  await send({ type: 'ready' })
}

main().catch(async () => {
  await send({ type: 'error', error: { code: 'WORKER_INITIALIZATION_FAILED' } })
  await stop(1)
})
