import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { codexBackend, zaiCodingBackend } from '@repo/llm-backends'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { llmConfigFromEnv } from '../config/llm-config.ts'
import { createLlmTestCertificates } from '../testing/llm-certificates.ts'
import { createCredentialSource, encodeSubscriptionCredential } from './credentials.ts'
import { createEgressTransport } from './egress.ts'
import { createLlmGateway, type LlmGateway } from './server.ts'
import { PostgresGatewayStore } from './store.ts'

const enabled = Boolean(process.env.DATABASE_URL && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const delta = event({ type: 'response.output_text.delta', delta: 'synthetic text' })
const completed = event({
  type: 'response.completed',
  response: {
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 1 },
    },
  },
})
const jwt = (claims: unknown) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
const credential = {
  v: '1',
  kind: 'chatgpt_oauth',
  accessToken: jwt({}),
  refreshToken: 'synthetic-private-refresh',
  idToken: jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'synthetic-account',
      chatgpt_plan_type: 'plus',
    },
  }),
  chatgptAccountId: 'synthetic-account',
  accessExpiresAt: null,
  refreshedAt: new Date().toISOString(),
}

describe.skipIf(!enabled)(
  'real subscription gateway: PostgreSQL, Vault boundary and mTLS CONNECT',
  () => {
    let db: PrismaClient
    let certificates: ReturnType<typeof createLlmTestCertificates>
    let providerId: string
    let providerWasEnabled: boolean

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: process.env.DATABASE_URL! })
      const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: 'openai-chatgpt' } })
      providerId = provider.id
      providerWasEnabled = provider.enabled
      await db.llmProvider.update({ where: { id: providerId }, data: { enabled: true } })
      certificates = createLlmTestCertificates()
    })
    afterAll(async () => {
      certificates?.close()
      if (providerId)
        await db.llmProvider.update({
          where: { id: providerId },
          data: { enabled: providerWasEnabled },
        })
      await db?.$disconnect()
    })

    async function fixture({ accountSlots = 2, hold = false, status = 200 } = {}) {
      const workspaceId = randomUUID()
      const siteId = randomUUID()
      const modelId = randomUUID()
      const accountId = randomUUID()
      const credentialRefId = randomUUID()
      const taskIds: string[] = []
      const servers: LlmGateway[] = []
      const sockets = new Set<Duplex>()
      const pending: ServerResponse[] = []
      const upstreamRequests: { path: string; authorization: string | undefined; body: string }[] =
        []
      const tunnels: string[] = []
      const logs: string[] = []
      const kvRead = vi
        .fn<SecretStore['kvRead']>()
        .mockResolvedValue({ data: encodeSubscriptionCredential(credential), version: 1 })
      await db.workspace.create({
        data: {
          id: workspaceId,
          name: `gateway-integration-${workspaceId}`,
          dataClass: 'synthetic',
        },
      })
      await db.site.create({
        data: {
          id: siteId,
          workspaceId,
          name: 'Synthetic gateway integration',
          url: `https://${siteId}.example.invalid`,
          stack: 'wordpress',
        },
      })
      await db.llmModel.create({
        data: {
          id: modelId,
          providerId,
          slug: `gateway-${modelId}`,
          name: 'Synthetic model',
          providerModelId: 'synthetic-model',
          modelClass: 'light',
          reserveOutputTokens: 1024,
          enabled: true,
        },
      })
      await db.llmModelPrice.create({
        data: {
          modelId,
          effectiveFrom: new Date(Date.now() - 60_000),
          inputPer1m: '100',
          cacheReadPer1m: '10',
          outputPer1m: '200',
          vatRate: '0.22',
          sourceUrl: 'https://example.invalid/synthetic',
        },
      })
      await db.credentialRef.create({
        data: {
          id: credentialRefId,
          kind: 'subscription',
          vaultPath: `subs/openai-chatgpt/${accountId}`,
        },
      })
      await db.subscriptionAccount.create({
        data: {
          id: accountId,
          providerId,
          driverId: 'codex',
          label: `gateway-${accountId}`,
          credentialRefId,
          plan: 'plus',
          maxConcurrentTurns: 2,
          maxConcurrentRequests: accountSlots,
          credentialVersion: 1,
          clientIdentity: { installationId: `synthetic-${accountId}` },
          enabled: true,
          limitWindows: [
            { name: '5h', usedPct: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
          ],
        },
      })
      const cert = readFileSync(certificates.certFile)
      const key = readFileSync(certificates.keyFile)
      const provider = createHttpsServer({ cert, key }, (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          upstreamRequests.push({
            path: req.url!,
            authorization: req.headers.authorization,
            body: Buffer.concat(chunks).toString(),
          })
          if (status !== 200) {
            res.writeHead(status, {
              'content-type': 'application/json',
              'x-ratelimit-private-account': 'private-account-id',
            })
            res.end(
              JSON.stringify({
                error: {
                  code: 'usage_limit_reached',
                  message: 'private-provider-secret',
                  account_id: 'private-account-id',
                },
              }),
            )
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-codex-turn-state': 'synthetic-next-state',
            'x-ratelimit-private-account': 'private-account-id',
          })
          res.write(delta)
          if (hold) pending.push(res)
          else res.end(completed)
        })
      })
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const providerPort = (provider.address() as AddressInfo).port
      const proxy = createHttpsServer({
        cert,
        key,
        ca: cert,
        requestCert: true,
        rejectUnauthorized: true,
      })
      proxy.on('tlsClientError', () => {})
      proxy.on('connect', (req, socket, head) => {
        tunnels.push(req.url!)
        if (req.url !== `localhost:${providerPort}`) {
          socket.destroy()
          return
        }
        const target = connect(providerPort, '127.0.0.1')
        sockets.add(socket)
        sockets.add(target)
        target.on('error', () => socket.destroy())
        socket.on('error', () => target.destroy())
        target.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) target.write(head)
          socket.pipe(target).pipe(socket)
        })
      })
      for (const server of [provider, proxy])
        server.on('connection', (socket) => sockets.add(socket))
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const proxyPort = (proxy.address() as AddressInfo).port
      const config = llmConfigFromEnv(
        {
          LLM_GATEWAY_HOSTS: 'gateway.test',
          LLM_GATEWAY_CLIENTS: '127.0.0.1/32',
          LLM_EGRESS_PROXY_URL: `https://127.0.0.1:${proxyPort}`,
          LLM_EGRESS_CA_FILE: certificates.certFile,
          LLM_EGRESS_CLIENT_CERT_FILE: certificates.certFile,
          LLM_EGRESS_CLIENT_KEY_FILE: certificates.keyFile,
          LLM_UPSTREAM_CA_FILE: certificates.certFile,
          LLM_BACKEND_URL_OPENAI_CHATGPT: `https://localhost:${providerPort}`,
        },
        'test',
      )
      return {
        workspaceId,
        modelId,
        accountId,
        pending,
        kvRead,
        upstreamRequests,
        tunnels,
        logs,
        async key(budgetRub = '100') {
          const task = await db.task.create({ data: { workspaceId, siteId } })
          taskIds.push(task.id)
          const token = `sk-rdt-${randomBytes(32).toString('base64url')}`
          const row = await db.llmKey.create({
            data: {
              keyHash: createHash('sha256').update(token).digest('hex'),
              taskId: task.id,
              taskAttempt: 1,
              sessionId: randomUUID(),
              turnNo: 1,
              firstEpoch: 1,
              driverId: 'codex',
              modelId,
              subscriptionAccountId: accountId,
              reasoningEffort: 'low',
              budgetRub,
              boundSource: '127.0.0.1',
              expiresAt: new Date(Date.now() + 60_000),
              validUntil: new Date(Date.now() + 60_000),
            },
          })
          return { token, id: row.id, taskId: task.id }
        },
        async gateway() {
          const server = createLlmGateway({
            config,
            backends: [codexBackend],
            store: new PostgresGatewayStore(db),
            credentials: createCredentialSource({ kvRead }),
            egress: createEgressTransport(config.egress),
            logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
          })
          servers.push(server)
          return (await server.listen(0)).port
        },
        release() {
          for (const response of pending.splice(0)) response.end(completed)
        },
        async close() {
          for (const response of pending.splice(0)) response.end(completed)
          await Promise.all(servers.map((server) => server.close()))
          for (const socket of sockets) socket.destroy()
          await Promise.all(
            [proxy, provider].map(
              (server) =>
                new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
          )
          await db.tokenUsage.deleteMany({ where: { taskId: { in: taskIds } } })
          await db.llmCall.deleteMany({ where: { subscriptionAccountId: accountId } })
          await db.llmKey.deleteMany({ where: { taskId: { in: taskIds } } })
          await db.task.deleteMany({ where: { id: { in: taskIds } } })
          await db.subscriptionAccount.delete({ where: { id: accountId } })
          await db.credentialRef.delete({ where: { id: credentialRefId } })
          await db.llmModelPrice.deleteMany({ where: { modelId } })
          await db.llmModel.delete({ where: { id: modelId } })
          await db.site.delete({ where: { id: siteId } })
          await db.workspace.delete({ where: { id: workspaceId } })
        },
      }
    }

    function call(
      port: number,
      token: string,
    ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
      return new Promise((resolve, reject) => {
        const body = Buffer.from(
          JSON.stringify({
            model: 'synthetic-model',
            store: false,
            stream: true,
            input: 'Synthetic prompt only',
          }),
        )
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/codex/responses',
            method: 'POST',
            agent: false,
            headers: {
              host: 'gateway.test',
              authorization: `Bearer ${token}`,
              'user-agent': 'codex_cli_rs/0.159.1',
              'content-type': 'application/json',
              'content-length': String(body.length),
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('error', reject)
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            )
          },
        )
        req.on('error', reject)
        req.end(body)
      })
    }

    it('streams Codex through CONNECT, stores exact usage and closes the call atomically', async () => {
      const f = await fixture()
      try {
        const key = await f.key()
        const result = await call(await f.gateway(), key.token)
        expect(result.status).toBe(200)
        expect(result.body).toContain('synthetic text')
        expect(result.body).toContain('response.completed')
        expect(result.headers['x-codex-turn-state']).toBe('synthetic-next-state')
        expect(result.headers['x-ratelimit-private-account']).toBeUndefined()
        await expect
          .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'completed' } }))
          .toBe(1)
        const usage = await db.tokenUsage.findFirstOrThrow({ where: { keyId: key.id } })
        expect(usage).toMatchObject({
          inputUncachedTokens: 8,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          outputTokens: 3,
          reasoningTokens: 1,
          estimated: false,
          billable: true,
          estimateReason: null,
        })
        expect(usage.costRub.toFixed(10)).toBe('0.0014200000')
        expect(f.kvRead).toHaveBeenCalledExactlyOnceWith(`subs/openai-chatgpt/${f.accountId}`)
        expect(f.tunnels).toHaveLength(1)
        expect(f.upstreamRequests[0]!.authorization).toBe(`Bearer ${credential.accessToken}`)
        expect(JSON.parse(f.upstreamRequests[0]!.body)).toMatchObject({
          model: 'synthetic-model',
          store: false,
          stream: true,
        })
        expect(f.logs.join('\n')).not.toContain(credential.refreshToken)
        expect(f.logs.join('\n')).not.toContain(credential.accessToken)
        expect(f.logs.join('\n')).not.toContain(key.token)
      } finally {
        await f.close()
      }
    })

    it('rejects the reserved budget before Vault or any upstream connection', async () => {
      const f = await fixture()
      try {
        const key = await f.key('0.0000000001')
        const result = await call(await f.gateway(), key.token)
        expect(result.status).toBe(429)
        expect(result.body).toContain('raditi_budget')
        expect((await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })).lastRefusal).toBe(
          'budget',
        )
        expect(await db.llmCall.count({ where: { keyId: key.id } })).toBe(0)
        expect(f.kvRead).not.toHaveBeenCalled()
        expect(f.tunnels).toHaveLength(0)
        expect(f.upstreamRequests).toHaveLength(0)
      } finally {
        await f.close()
      }
    })

    it('sanitizes provider failure bodies, headers and logs and spends no budget on a refusal', async () => {
      const f = await fixture({ status: 429 })
      try {
        const key = await f.key()
        const result = await call(await f.gateway(), key.token)
        expect(result.status).toBe(429)
        expect(result.body).not.toContain('private-provider-secret')
        expect(result.body).not.toContain('private-account-id')
        expect(result.headers['x-ratelimit-private-account']).toBeUndefined()
        await expect
          .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'failed' } }))
          .toBe(1)
        // The provider answered with an error before generating: nothing enters the ceiling.
        const usage = await db.tokenUsage.findFirstOrThrow({ where: { keyId: key.id } })
        expect(usage).toMatchObject({
          inputUncachedTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          estimated: false,
          estimateReason: null,
        })
        expect(usage.costRub.toFixed(10)).toBe('0.0000000000')
        expect(f.logs.join('\n')).not.toContain('private-provider-secret')
        expect(f.logs.join('\n')).not.toContain(credential.accessToken)
      } finally {
        await f.close()
      }
    })

    it('serializes an account slot across two native gateway instances and different keys', async () => {
      const f = await fixture({ accountSlots: 1, hold: true })
      try {
        const [keyA, keyB] = await Promise.all([f.key(), f.key()])
        const [portA, portB] = await Promise.all([f.gateway(), f.gateway()])
        const first = call(portA, keyA.token)
        await expect.poll(() => f.pending.length).toBe(1)
        const second = call(portB, keyB.token)
        await expect
          .poll(() =>
            db.llmKey.findUnique({ where: { id: keyB.id } }).then((row) => row?.lastRefusal),
          )
          .toBe('transient')
        expect(
          await db.llmCall.count({ where: { subscriptionAccountId: f.accountId, state: 'open' } }),
        ).toBe(1)
        expect(f.tunnels).toHaveLength(1)
        f.release()
        expect((await first).status).toBe(200)
        await expect.poll(() => f.pending.length).toBe(1)
        f.release()
        expect((await second).status).toBe(200)
        await expect
          .poll(() =>
            db.llmCall.count({ where: { subscriptionAccountId: f.accountId, state: 'completed' } }),
          )
          .toBe(2)
      } finally {
        await f.close()
      }
    })

    it('enforces two requests per key across distinct gateway instances before upstream', async () => {
      const f = await fixture({ accountSlots: 3, hold: true })
      try {
        const key = await f.key()
        const [portA, portB] = await Promise.all([f.gateway(), f.gateway()])
        const running = [call(portA, key.token), call(portB, key.token)]
        await expect.poll(() => f.pending.length).toBe(2)
        const third = await call(portB, key.token)
        expect(third.status).toBe(503)
        expect(third.body).toContain('raditi_transient')
        expect(await db.llmCall.count({ where: { keyId: key.id, state: 'open' } })).toBe(2)
        expect(f.tunnels).toHaveLength(2)
        f.release()
        expect((await Promise.all(running)).map((result) => result.status)).toEqual([200, 200])
        await expect
          .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'completed' } }))
          .toBe(2)
      } finally {
        await f.close()
      }
    })
  },
)

// The synthetic Z.ai of the stands (infra/dev/llm-verify/fake-zai.mjs) as its own process, behind
// the same mTLS CONNECT proxy: the adapter, the role, PostgreSQL and the Vault boundary together.
const zaiKey = 'zai-synthetic-plan-key-for-stands-only'
const zaiMarker = 'synthetic-zai-provider-text-canary'
const zaiCredential = { v: '1', kind: 'zai_api_key', apiKey: zaiKey }
const zaiUserAgent = 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
interface ZaiRecord {
  path: string
  credential: string
  headerNames: string[]
  userAgent: string | null
  accept: string | null
  acceptEncoding: string | null
  body: Record<string, unknown> | null
}
interface ZaiState {
  requests: ZaiRecord[]
  counters: { chat: number; quota: number; generated: number }
}

describe.skipIf(!enabled)(
  'real subscription gateway with the Z.ai adapter: PostgreSQL, Vault boundary, mTLS CONNECT and the synthetic provider',
  () => {
    let db: PrismaClient
    let certificates: ReturnType<typeof createLlmTestCertificates>
    let providerId: string
    let providerWasEnabled: boolean
    let fake: ChildProcess
    let fakePort: number
    let controlUrl: string

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: process.env.DATABASE_URL! })
      const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: 'zai-coding' } })
      providerId = provider.id
      providerWasEnabled = provider.enabled
      await db.llmProvider.update({ where: { id: providerId }, data: { enabled: true } })
      certificates = createLlmTestCertificates()
      fake = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../../../../infra/dev/llm-verify/fake-zai.mjs', import.meta.url)),
          '--tls-key',
          certificates.keyFile,
          '--tls-cert',
          certificates.certFile,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
      const ready = await new Promise<{ port: number; controlPort: number }>((resolve, reject) => {
        let text = ''
        fake.stdout!.on('data', (chunk: Buffer) => {
          text += chunk.toString()
          if (text.includes('\n'))
            resolve(JSON.parse(text) as { port: number; controlPort: number })
        })
        fake.once('exit', () => reject(new Error('The synthetic Z.ai did not start')))
      })
      fakePort = ready.port
      controlUrl = `http://127.0.0.1:${ready.controlPort}/`
    })
    afterAll(async () => {
      if (fake && fake.exitCode === null) {
        fake.kill('SIGTERM')
        await once(fake, 'exit')
      }
      certificates?.close()
      if (providerId)
        await db.llmProvider.update({
          where: { id: providerId },
          data: { enabled: providerWasEnabled },
        })
      await db?.$disconnect()
    })

    /** One message of the fake's control port: `{reset?, scenario?, quota?}`; GET reads the state. */
    async function provider(configuration?: object): Promise<ZaiState> {
      const response = await fetch(
        controlUrl,
        configuration ? { method: 'POST', body: JSON.stringify(configuration) } : { method: 'GET' },
      )
      expect(response.status).toBe(200)
      return (await response.json()) as ZaiState
    }

    async function fixture(scenario: object = {}) {
      await provider({ reset: true, scenario })
      const workspaceId = randomUUID()
      const siteId = randomUUID()
      const modelId = randomUUID()
      const accountId = randomUUID()
      const credentialRefId = randomUUID()
      const taskIds: string[] = []
      const servers: LlmGateway[] = []
      const sockets = new Set<Duplex>()
      const tunnels: string[] = []
      const logs: string[] = []
      const kvRead = vi
        .fn<SecretStore['kvRead']>()
        .mockResolvedValue({ data: encodeSubscriptionCredential(zaiCredential), version: 1 })
      await db.workspace.create({
        data: { id: workspaceId, name: `gateway-zai-${workspaceId}`, dataClass: 'synthetic' },
      })
      await db.site.create({
        data: {
          id: siteId,
          workspaceId,
          name: 'Synthetic gateway integration',
          url: `https://${siteId}.example.invalid`,
          stack: 'wordpress',
        },
      })
      await db.llmModel.create({
        data: {
          id: modelId,
          providerId,
          slug: `gateway-${modelId}`,
          name: 'Synthetic GLM profile',
          providerModelId: 'glm-5.3',
          modelClass: 'standard',
          // What the seeds reserve for a profile of this backend: the policy's output ceiling.
          reserveOutputTokens: 32_000,
          enabled: true,
        },
      })
      await db.llmModelPrice.create({
        data: {
          modelId,
          effectiveFrom: new Date(Date.now() - 60_000),
          inputPer1m: '100',
          cacheReadPer1m: '10',
          outputPer1m: '200',
          vatRate: '0.22',
          sourceUrl: 'https://example.invalid/synthetic',
        },
      })
      await db.credentialRef.create({
        data: {
          id: credentialRefId,
          kind: 'subscription',
          vaultPath: `subs/zai-coding/${accountId}`,
        },
      })
      await db.subscriptionAccount.create({
        data: {
          id: accountId,
          providerId,
          driverId: 'opencode',
          label: `gateway-${accountId}`,
          credentialRefId,
          plan: 'lite',
          // The import settings of the operator command for this backend.
          maxConcurrentTurns: 1,
          maxConcurrentRequests: 2,
          credentialVersion: 1,
          clientIdentity: {},
          enabled: true,
          limitWindows: [
            { name: '5h', usedPct: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
            { name: 'week', usedPct: 1, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
          ],
        },
      })
      const cert = readFileSync(certificates.certFile)
      const key = readFileSync(certificates.keyFile)
      const proxy = createHttpsServer({
        cert,
        key,
        ca: cert,
        requestCert: true,
        rejectUnauthorized: true,
      })
      proxy.on('tlsClientError', () => {})
      proxy.on('connect', (req, socket, head) => {
        tunnels.push(req.url!)
        if (req.url !== `localhost:${fakePort}`) {
          socket.destroy()
          return
        }
        const target = connect(fakePort, '127.0.0.1')
        sockets.add(socket)
        sockets.add(target)
        target.on('error', () => socket.destroy())
        socket.on('error', () => target.destroy())
        target.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) target.write(head)
          socket.pipe(target).pipe(socket)
        })
      })
      proxy.on('connection', (socket) => sockets.add(socket))
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const config = llmConfigFromEnv(
        {
          LLM_GATEWAY_HOSTS: 'gateway.test',
          LLM_GATEWAY_CLIENTS: '127.0.0.1/32',
          LLM_EGRESS_PROXY_URL: `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
          LLM_EGRESS_CA_FILE: certificates.certFile,
          LLM_EGRESS_CLIENT_CERT_FILE: certificates.certFile,
          LLM_EGRESS_CLIENT_KEY_FILE: certificates.keyFile,
          LLM_UPSTREAM_CA_FILE: certificates.certFile,
          LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${fakePort}`,
        },
        'test',
      )
      const server = createLlmGateway({
        config,
        backends: [zaiCodingBackend],
        store: new PostgresGatewayStore(db),
        credentials: createCredentialSource({ kvRead }),
        egress: createEgressTransport(config.egress),
        logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
      })
      servers.push(server)
      const port = (await server.listen(0)).port
      return {
        accountId,
        kvRead,
        tunnels,
        logs,
        port,
        async key(budgetRub = '100') {
          const task = await db.task.create({ data: { workspaceId, siteId } })
          taskIds.push(task.id)
          const token = `sk-rdt-${randomBytes(32).toString('base64url')}`
          const row = await db.llmKey.create({
            data: {
              keyHash: createHash('sha256').update(token).digest('hex'),
              taskId: task.id,
              taskAttempt: 1,
              sessionId: randomUUID(),
              turnNo: 1,
              firstEpoch: 1,
              driverId: 'opencode',
              modelId,
              subscriptionAccountId: accountId,
              reasoningEffort: 'high',
              budgetRub,
              boundSource: '127.0.0.1',
              expiresAt: new Date(Date.now() + 60_000),
              validUntil: new Date(Date.now() + 60_000),
            },
          })
          return { token, id: row.id }
        },
        async close() {
          await Promise.all(servers.map((item) => item.close()))
          for (const socket of sockets) socket.destroy()
          await new Promise<void>((resolve, reject) =>
            proxy.close((error) => (error ? reject(error) : resolve())),
          )
          await db.tokenUsage.deleteMany({ where: { taskId: { in: taskIds } } })
          await db.llmCall.deleteMany({ where: { subscriptionAccountId: accountId } })
          await db.llmKey.deleteMany({ where: { taskId: { in: taskIds } } })
          await db.task.deleteMany({ where: { id: { in: taskIds } } })
          await db.subscriptionAccount.delete({ where: { id: accountId } })
          await db.credentialRef.delete({ where: { id: credentialRefId } })
          await db.llmModelPrice.deleteMany({ where: { modelId } })
          await db.llmModel.delete({ where: { id: modelId } })
          await db.site.delete({ where: { id: siteId } })
          await db.workspace.delete({ where: { id: workspaceId } })
        },
      }
    }

    /** What the pinned CLI sends with its own provider id: no `thinking`, no `reasoning_effort`. */
    function call(
      port: number,
      token: string,
    ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
      return new Promise((resolve, reject) => {
        const body = Buffer.from(
          JSON.stringify({
            model: 'glm-5.3',
            max_tokens: 32_000,
            messages: [{ role: 'user', content: 'Synthetic prompt only' }],
            tool_choice: 'auto',
            tools: [
              {
                type: 'function',
                function: { name: 'bash', description: 'Runs.', parameters: { type: 'object' } },
              },
            ],
            stream: true,
            stream_options: { include_usage: true },
          }),
        )
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/zai/v4/chat/completions',
            method: 'POST',
            agent: false,
            headers: {
              host: 'gateway.test',
              authorization: `Bearer ${token}`,
              'user-agent': zaiUserAgent,
              'content-type': 'application/json',
              'content-length': String(body.length),
              // What the CLI adds and the gateway drops.
              'x-opencode-session-id': 'ses_synthetic',
              'x-session-affinity': 'ses_synthetic',
              'x-session-id': 'ses_synthetic',
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('error', reject)
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            )
          },
        )
        req.on('error', reject)
        req.end(body)
      })
    }
    const events = (text: string) =>
      text
        .split('\n\n')
        .filter(Boolean)
        .map((block) => block.replace(/^event: message\ndata: /, ''))
    const providerHeaderNames = ['set-cookie', 'x-log-id', 'x-request-id', 'ga-traceid', 'alt-svc']

    it('streams GLM through CONNECT, stores the provider usage and shows the provider only the plan key', async () => {
      const f = await fixture({ scenario: 'text' })
      try {
        const key = await f.key()
        const result = await call(f.port, key.token)
        expect(result.status).toBe(200)
        expect(events(result.body).at(-1)).toBe('[DONE]')
        expect(result.body).toContain('"finish_reason":"stop"')
        for (const name of providerHeaderNames) expect(result.headers[name]).toBeUndefined()
        await expect
          .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'completed' } }))
          .toBe(1)
        // 7105 prompt tokens with 6784 cached, 94 completion tokens with 54 of reasoning.
        const usage = await db.tokenUsage.findFirstOrThrow({ where: { keyId: key.id } })
        expect(usage).toMatchObject({
          inputUncachedTokens: 321,
          cacheReadTokens: 6784,
          cacheWriteTokens: 0,
          outputTokens: 94,
          reasoningTokens: 54,
          estimated: false,
          billable: true,
          estimateReason: null,
        })
        expect(usage.costRub.toFixed(10)).toBe('0.1187400000')
        expect(f.kvRead).toHaveBeenCalledExactlyOnceWith(`subs/zai-coding/${f.accountId}`)
        expect(f.tunnels).toEqual([`localhost:${fakePort}`])
        const { requests } = await provider()
        expect(requests).toHaveLength(1)
        const sent = requests[0]!
        expect(sent.path).toBe('/api/coding/paas/v4/chat/completions')
        expect(sent.credential).toBe('plan-key')
        expect(sent.userAgent).toBe(zaiUserAgent)
        expect(sent.accept).toBe('text/event-stream')
        expect(sent.acceptEncoding).toBe('identity')
        // The adapter's five headers and what HTTP itself needs: no session header, no cookie.
        const transport = ['host', 'content-length', 'connection', 'transfer-encoding']
        expect(sent.headerNames.filter((name) => !transport.includes(name))).toEqual([
          'accept',
          'accept-encoding',
          'authorization',
          'content-type',
          'user-agent',
        ])
        // The profile of the key sets the level of reasoning; the request is otherwise the CLI's.
        expect(sent.body).toMatchObject({
          model: 'glm-5.3',
          max_tokens: 32_000,
          thinking: { type: 'enabled', clear_thinking: false },
          reasoning_effort: 'high',
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
        })
        expect(JSON.stringify(sent.body)).not.toContain(key.token)
        for (const secret of [zaiKey, key.token]) expect(f.logs.join('\n')).not.toContain(secret)
      } finally {
        await f.close()
      }
    })

    it('ends the turn on a spent budget with a final 403, before Vault and the provider', async () => {
      const f = await fixture()
      try {
        const key = await f.key('0.0000000001')
        const result = await call(f.port, key.token)
        expect(result.status).toBe(403)
        expect(result.headers['retry-after']).toBeUndefined()
        expect(JSON.parse(result.body)).toEqual({
          error: {
            type: 'invalid_request_error',
            code: 'raditi_budget',
            message: 'The budget of this turn is spent.',
          },
        })
        expect((await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })).lastRefusal).toBe(
          'budget',
        )
        expect(await db.llmCall.count({ where: { keyId: key.id } })).toBe(0)
        expect(f.kvRead).not.toHaveBeenCalled()
        expect(f.tunnels).toHaveLength(0)
        expect((await provider()).requests).toHaveLength(0)
      } finally {
        await f.close()
      }
    })

    it.each([
      [{ scenario: 'error', code: 1308 }, 403, 'subscription_limit', undefined],
      [{ scenario: 'error', code: 1113 }, 403, 'account', undefined],
      [{ scenario: 'error', code: 1311 }, 400, 'profile', undefined],
      [{ scenario: 'error', code: 1301 }, 400, 'policy_flagged', undefined],
      [{ scenario: 'error', code: 4242, status: 429 }, 403, 'account', undefined],
      // The provider asks for eleven days; the sandbox waits no longer than the short pause.
      [{ scenario: 'error', code: 1305, retryAfter: '999999' }, 503, 'transient', '30'],
    ] as const)(
      'answers the provider refusal %j with %s raditi_%s and none of its text',
      async (scenario, status, refusal, retryAfter) => {
        const f = await fixture(scenario)
        try {
          const key = await f.key()
          const result = await call(f.port, key.token)
          expect(result.status).toBe(status)
          expect(result.headers['retry-after']).toBe(retryAfter)
          expect(JSON.parse(result.body)).toMatchObject({ error: { code: `raditi_${refusal}` } })
          expect(result.body).not.toContain(zaiMarker)
          for (const name of providerHeaderNames) expect(result.headers[name]).toBeUndefined()
          await expect
            .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'failed' } }))
            .toBe(1)
          // An error before any generation: nothing enters the budget of the key.
          const usage = await db.tokenUsage.findFirstOrThrow({ where: { keyId: key.id } })
          expect(usage).toMatchObject({ inputUncachedTokens: 0, outputTokens: 0, estimated: false })
          expect(usage.costRub.toFixed(10)).toBe('0.0000000000')
          expect((await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })).lastRefusal).toBe(
            refusal,
          )
          expect((await provider()).requests).toHaveLength(1)
          expect(f.logs.join('\n')).not.toContain(zaiMarker)
        } finally {
          await f.close()
        }
      },
    )

    // After each of these the pinned CLI repeats the request at once and without a limit.
    it.each([
      [{ scenario: 'done_only' }, 'account', true],
      [{ scenario: 'no_finish' }, 'account', true],
      [{ scenario: 'no_finish_no_done' }, 'account', true],
      [{ scenario: 'empty' }, 'account', true],
      // The provider counted these calls: its numbers are kept.
      [{ scenario: 'finish', finish: 'sensitive' }, 'policy_flagged', false],
      [{ scenario: 'finish', finish: 'model_context_window_exceeded' }, 'request_rejected', false],
      [{ scenario: 'stream_error', code: 1308 }, 'subscription_limit', true],
    ] as const)(
      'turns the stream %j into one final error object for the sandbox',
      async (scenario, refusal, estimated) => {
        const f = await fixture(scenario)
        try {
          const key = await f.key()
          const result = await call(f.port, key.token)
          expect(result.status).toBe(200)
          const sent = events(result.body)
          expect(JSON.parse(sent.at(-1)!)).toMatchObject({
            error: { type: 'invalid_request_error', code: `raditi_${refusal}` },
          })
          expect(sent.filter((data) => data.includes('"error"'))).toHaveLength(1)
          expect(result.body).not.toContain('[DONE]')
          expect(result.body).not.toContain(zaiMarker)
          await expect
            .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'failed' } }))
            .toBe(1)
          const usage = await db.tokenUsage.findFirstOrThrow({ where: { keyId: key.id } })
          expect(usage.estimated).toBe(estimated)
          // An estimate of a call the platform cut short is never billed.
          expect(usage.billable).toBe(!estimated)
          if (!estimated)
            expect(usage).toMatchObject({ inputUncachedTokens: 321, cacheReadTokens: 6784 })
          expect((await db.llmKey.findUniqueOrThrow({ where: { id: key.id } })).lastRefusal).toBe(
            refusal,
          )
          // One request reached the provider; the gateway asked for nothing more.
          expect((await provider()).requests).toHaveLength(1)
        } finally {
          await f.close()
        }
      },
    )

    it.each([{ scenario: 'envelope200', code: 500 }, { scenario: 'plain200' }])(
      'never answers the sandbox with HTTP 200 when the provider sent %j instead of a stream',
      async (scenario) => {
        const f = await fixture(scenario)
        try {
          const key = await f.key()
          const result = await call(f.port, key.token)
          expect(result.status).toBe(503)
          expect(Number(result.headers['retry-after'])).toBeLessThanOrEqual(30)
          expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'raditi_transient' } })
          expect(result.body).not.toContain(zaiMarker)
          await expect
            .poll(() => db.llmCall.count({ where: { keyId: key.id, state: 'failed' } }))
            .toBe(1)
        } finally {
          await f.close()
        }
      },
    )
  },
)
