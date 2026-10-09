import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { setTimeout as realDelay } from 'node:timers/promises'

import type { LlmBackend } from '@repo/domain'
import { codexBackend, kimiCodeBackend, zaiCodingBackend } from '@repo/llm-backends'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LlmConfig } from '../config/llm-config.ts'
import { turnKeyHash } from '../llm/turn-key.ts'
import type { StreamingEgress } from './egress.ts'
import { createLlmGateway, type LlmGateway, type LlmGatewayOptions } from './server.ts'
import { gatewayFinishSchema } from './store.ts'
import {
  EgressNotDelivered,
  GatewayRecordRejected,
  type GatewayCall,
  type GatewayFinish,
  type GatewayKey,
  type GatewayStore,
} from './types.ts'

const turnKey = `sk-rdt-${Buffer.alloc(32, 7).toString('base64url')}`
const key: GatewayKey = {
  keyId: 'synthetic-key',
  modelId: 'synthetic-model',
  model: 'gpt-6-sol',
  reasoningEffort: 'medium',
  cacheKey: `rdt_${'a'.repeat(32)}`,
  backendId: 'openai-chatgpt',
  providerId: 'synthetic-provider',
  taskId: 'synthetic-task',
  taskAttempt: 0,
  driverId: 'codex',
  accountId: 'synthetic-account',
  modelSlug: 'synthetic-model',
  reserveOutputTokens: 100,
  budgetRub: '100.00',
  credentialRef: 'subs/synthetic-account',
  credentialVersion: 1,
  clientIdentity: { installationId: 'synthetic-installation' },
  maxConcurrentRequests: 2,
}
const makeCall = (estimatedInputTokens = 10, estimatedCacheReadTokens = 0): GatewayCall => ({
  ...key,
  id: 'synthetic-call',
  priceId: 'synthetic-price',
  reservedRub: '1.0000000000',
  prices: { inputPer1m: '1', outputPer1m: '2', cacheReadPer1m: null, cacheWritePer1m: null },
  estimatedInputTokens,
  estimatedCacheReadTokens,
  startedAt: new Date(),
})
const noUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
const jwt = (claims: unknown) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
const credential = {
  v: '1',
  kind: 'chatgpt_oauth',
  accessToken: jwt({}),
  refreshToken: 'synthetic-refresh-secret',
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
const body = { model: key.model, store: false, stream: true, input: 'synthetic prompt' }
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const delta = event({ type: 'response.output_text.delta', delta: 'abcdef' })
const completed = (
  usage: unknown = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 1 },
  },
) => event({ type: 'response.completed', response: { usage } })
const kimiKey: GatewayKey = {
  ...key,
  backendId: 'kimi-code',
  model: 'k3-256k',
  reasoningEffort: 'high',
  driverId: 'kimi',
  clientIdentity: { deviceId: 'synthetic-device', deviceName: 'synthetic-device' },
}
const successStreams = [
  {
    name: 'Codex',
    profile: key,
    credential,
    path: '/codex/responses',
    userAgent: 'codex_exec/0.159.1',
    body,
    stream: delta + completed(),
    terminal: 'response.completed',
    usage: '"input_tokens":10',
  },
  {
    name: 'Kimi',
    profile: kimiKey,
    credential: { v: '1', kind: 'kimi_api_key', apiKey: 'synthetic-kimi-secret' },
    path: '/kimi/v1/chat/completions',
    userAgent: 'kimi-code-cli/2.1.1',
    body: {
      model: kimiKey.model,
      stream: true,
      messages: [{ role: 'user', content: 'synthetic prompt' }],
    },
    stream:
      event({ choices: [{ delta: { content: 'abcdef' }, finish_reason: null }] }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      event({
        choices: [],
        usage: {
          prompt_tokens: 10,
          cached_tokens: 2,
          completion_tokens: 3,
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }) +
      'data: [DONE]\n\n',
    terminal: '[DONE]',
    usage: '"prompt_tokens":10',
  },
]
const cleanups: Array<() => Promise<void>> = []
// The fake store closes calls without PostgreSQL; the real store would reject these outcomes.
const unstorable: GatewayFinish[] = []
const storable = async (_callId: string, outcome: GatewayFinish) => {
  if (!gatewayFinishSchema.safeParse(outcome).success) unstorable.push(outcome)
  return true
}

const controlLifecycle = () => ({
  pause: vi.fn().mockReturnValue(null),
  refresh: vi.fn().mockResolvedValue(null),
  observe: vi.fn().mockResolvedValue(undefined),
  probeAccounts: vi.fn().mockResolvedValue(undefined),
})

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(unstorable.splice(0)).toEqual([])
})

async function setup(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  patch: Partial<LlmConfig> = {},
  runtime: Partial<
    Pick<LlmGatewayOptions, 'ready' | 'health' | 'metricsToken' | 'lifecycle' | 'backends'>
  > = {},
) {
  const upstream = createServer(handler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const originPort = (upstream.address() as { port: number }).port
  const store = {
    lookup: vi.fn<GatewayStore['lookup']>().mockResolvedValue(key),
    admit: vi.fn<GatewayStore['admit']>().mockImplementation(async (input) => ({
      kind: 'admitted',
      call: makeCall(input.estimatedInputTokens),
    })),
    refuse: vi.fn<GatewayStore['refuse']>().mockResolvedValue(undefined),
    finish: vi.fn<GatewayStore['finish']>(storable),
    collectLost: vi.fn<GatewayStore['collectLost']>().mockResolvedValue(0),
  }
  const credentials = {
    get: vi.fn().mockResolvedValue(credential),
    versionOf: vi.fn().mockReturnValue(null),
  }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const egress: StreamingEgress = {
    request: vi.fn<StreamingEgress['request']>(
      async (target, options) =>
        new Promise<Awaited<ReturnType<StreamingEgress['request']>>>((resolve, reject) => {
          // This injected test transport can reach only the fixture on loopback.
          const outgoing = request(
            {
              hostname: '127.0.0.1',
              port: originPort,
              method: target.method,
              path: new URL(target.url).pathname,
              headers: Object.fromEntries(target.headers),
              signal: options.signal,
              agent: false,
            },
            (response) =>
              resolve({
                status: response.statusCode!,
                headers: new Headers(
                  Object.entries(response.headers).flatMap(([name, value]) =>
                    value === undefined
                      ? []
                      : [[name, Array.isArray(value) ? value.join(', ') : value]],
                  ),
                ),
                rawHeaders: response.rawHeaders,
                body: response,
                close: () => {
                  response.destroy()
                  outgoing.destroy()
                },
              }),
          )
          outgoing.on('error', reject)
          outgoing.end(target.body)
        }),
    ),
  }
  const config: LlmConfig = {
    appEnv: 'test',
    port: 0,
    listenHost: '127.0.0.1',
    clients: [{ address: '127.0.0.1', prefix: 32, family: 'ipv4' }],
    hosts: ['llm.local'],
    maxRequestsPerKey: 2,
    egress: null,
    ...patch,
  }
  const gateway = createLlmGateway({
    config,
    backends: [codexBackend, kimiCodeBackend],
    store,
    credentials,
    egress,
    logger,
    ...runtime,
  })
  await gateway.listen()
  cleanups.push(async () => {
    await gateway.close()
    upstream.closeAllConnections()
    if (upstream.listening) {
      upstream.close()
      await once(upstream, 'close')
    }
  })
  return { gateway, store, egress, credentials, logger }
}

function call(
  gateway: LlmGateway,
  options: {
    path?: string
    method?: string
    headers?: Record<string, string | string[]>
    body?: unknown
  } = {},
) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>(
    (resolve, reject) => {
      const port = (gateway.server.address() as { port: number }).port
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: options.path ?? '/codex/responses',
          method: options.method ?? 'POST',
          agent: false,
          headers: {
            host: 'llm.local',
            authorization: `Bearer ${turnKey}`,
            'content-type': 'application/json',
            'user-agent': 'codex_exec/0.159.1 (Mac OS 15.0; arm64)',
            ...options.headers,
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
      req.end(
        options.method === 'GET' && options.body === undefined
          ? undefined
          : typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body ?? body),
      )
    },
  )
}

/** A Codex request whose caller decides when to disconnect; errors after that are expected. */
function stream(gateway: LlmGateway, onData: () => void = () => {}) {
  const client = request(
    {
      hostname: '127.0.0.1',
      port: (gateway.server.address() as { port: number }).port,
      path: '/codex/responses',
      method: 'POST',
      agent: false,
      headers: {
        host: 'llm.local',
        authorization: `Bearer ${turnKey}`,
        'content-type': 'application/json',
        'user-agent': 'codex_exec/0.159.1',
      },
    },
    (res) => {
      res.on('error', () => {})
      res.on('data', onData)
    },
  )
  client.on('error', () => {})
  client.end(JSON.stringify(body))
  return client
}

describe('private core pool probe endpoint', () => {
  const path = '/internal/subscriptions/probe'
  const token = 'synthetic-control-token'
  const headers = { authorization: `Bearer ${token}` }

  it('probes authenticated account identifiers without reading credentials or reserving generation', async () => {
    const lifecycle = controlLifecycle()
    const { gateway, store, egress, credentials, logger } = await setup(
      (_request, response) => response.end(),
      {},
      { lifecycle, metricsToken: token },
    )
    const accountIds = [randomUUID(), randomUUID()]
    const result = await call(gateway, { path, headers, body: { accountIds } })
    expect(result.status).toBe(204)
    expect(result.body).toBe('')
    expect(lifecycle.probeAccounts).toHaveBeenCalledExactlyOnceWith(accountIds)
    expect(store.lookup).not.toHaveBeenCalled()
    expect(store.admit).not.toHaveBeenCalled()
    expect(store.finish).not.toHaveBeenCalled()
    expect(credentials.get).not.toHaveBeenCalled()
    expect(egress.request).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(accountIds[0])
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token)
    expect(gateway.stats().activeRequests).toBe(0)
  })

  it('requires the control bearer token and never accepts a turn key', async () => {
    const lifecycle = controlLifecycle()
    const { gateway } = await setup(
      (_request, response) => response.end(),
      {},
      { lifecycle, metricsToken: token },
    )
    for (const authorization of [`Bearer ${turnKey}`, 'Bearer invalid', '']) {
      expect(
        (
          await call(gateway, {
            path,
            headers: { authorization },
            body: { accountIds: [randomUUID()] },
          })
        ).status,
      ).toBe(401)
    }
    expect(lifecycle.probeAccounts).not.toHaveBeenCalled()
  })

  it.each([
    { hosts: ['other.host'] },
    { clients: [{ address: '192.168.0.0', prefix: 16, family: 'ipv4' as const }] },
  ])('uses the same Host/CIDR ingress fence %j', async (config) => {
    const lifecycle = controlLifecycle()
    const { gateway } = await setup((_request, response) => response.end(), config, {
      lifecycle,
      metricsToken: token,
    })
    expect(
      (await call(gateway, { path, headers, body: { accountIds: [randomUUID()] } })).status,
    ).toBe(403)
    expect(lifecycle.probeAccounts).not.toHaveBeenCalled()
  })

  it('closes control admission until llm runtime is ready', async () => {
    const lifecycle = controlLifecycle()
    const { gateway } = await setup(
      (_request, response) => response.end(),
      {},
      { lifecycle, metricsToken: token, ready: () => false },
    )
    expect(
      (await call(gateway, { path, headers, body: { accountIds: [randomUUID()] } })).status,
    ).toBe(503)
    expect(lifecycle.probeAccounts).not.toHaveBeenCalled()
  })

  it('rejects alternate methods, query strings and malformed control body', async () => {
    const lifecycle = controlLifecycle()
    const { gateway } = await setup(
      (_request, response) => response.end(),
      {},
      { lifecycle, metricsToken: token },
    )
    const id = randomUUID()
    for (const payload of [
      { accountIds: [] },
      { accountIds: ['bad-id'] },
      { accountIds: [id, id] },
      { accountIds: [id], prompt: 'private customer body' },
      { accountIds: Array.from({ length: 11 }, () => randomUUID()) },
      'malformed',
    ]) {
      expect((await call(gateway, { path, headers, body: payload })).status).toBe(400)
    }
    expect(
      (
        await call(gateway, {
          path,
          headers: { ...headers, 'content-type': 'text/plain' },
          body: { accountIds: [id] },
        })
      ).status,
    ).toBe(400)
    expect((await call(gateway, { path, headers, body: 'x'.repeat(2 * 1024 + 1) })).status).toBe(
      413,
    )
    expect(
      (await call(gateway, { path: `${path}?detail=1`, headers, body: { accountIds: [id] } }))
        .status,
    ).toBe(403)
    expect((await call(gateway, { path, method: 'GET', headers })).status).toBe(403)
    expect(lifecycle.probeAccounts).not.toHaveBeenCalled()
  })

  it('returns a bounded failure if the probe cannot finish without exposing account data', async () => {
    const lifecycle = controlLifecycle()
    const started = Promise.withResolvers<void>()
    lifecycle.probeAccounts.mockImplementation(async () => {
      started.resolve()
      return new Promise<void>(() => {})
    })
    const { gateway, logger } = await setup(
      (_request, response) => response.end(),
      {},
      { lifecycle, metricsToken: token },
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const accountId = randomUUID()
    const pending = call(gateway, { path, headers, body: { accountIds: [accountId] } })
    await started.promise
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    expect(result.status).toBe(503)
    expect(result.body).not.toContain(accountId)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(accountId)
  })
})

const success = (req: IncomingMessage, res: ServerResponse) => {
  req.resume()
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'x-codex-turn-state': 'synthetic-next',
    'retry-after': '5',
    'set-cookie': 'secret=must-not-forward',
    'x-codex-primary-used-percent': '20',
  })
  res.end(delta + completed())
}

describe('subscription HTTP gateway', () => {
  it('checks an account pause before reserving money or contacting the provider', async () => {
    const lifecycle = {
      pause: vi.fn().mockReturnValue({ reason: 'transient', retryAfterMs: 120_000 }),
      refresh: vi.fn(),
      observe: vi.fn(),
    }
    const { gateway, store, egress } = await setup(success, {}, { lifecycle })
    const result = await call(gateway)
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(store.admit).not.toHaveBeenCalled()
    expect(egress.request).not.toHaveBeenCalled()
    expect(lifecycle.observe).not.toHaveBeenCalled()
  })

  it('refreshes a rejected token and retries once within the same journal reservation', async () => {
    const next = { ...credential, accessToken: jwt({ synthetic_new_token: true }) }
    const seenTokens: Array<string | undefined> = []
    const lifecycle = {
      pause: vi.fn().mockReturnValue(null),
      refresh: vi.fn().mockResolvedValue(next),
      observe: vi.fn().mockResolvedValue(undefined),
    }
    const { gateway, store } = await setup(
      (req, res) => {
        seenTokens.push(req.headers.authorization)
        if (seenTokens.length === 1) {
          req.resume()
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }))
        } else success(req, res)
      },
      {},
      { lifecycle },
    )
    const result = await call(gateway)
    expect(result.status).toBe(200)
    expect(seenTokens).toEqual([`Bearer ${credential.accessToken}`, `Bearer ${next.accessToken}`])
    expect(lifecycle.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'synthetic-call', credentialVersion: 1 }),
      codexBackend,
      1,
    )
    expect(store.admit).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(lifecycle.observe).toHaveBeenCalledOnce())
    expect(store.finish).toHaveBeenCalledOnce()
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({ state: 'completed', estimated: false, billable: true }),
    )
    expect(store.finish.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.observe.mock.invocationCallOrder[0]!,
    )
  })

  it.each([null, { ...credential, accessToken: jwt({ synthetic_new_token: true }) }])(
    'does not loop on a final 401 or charge a rejected generation',
    async (fresh) => {
      const lifecycle = {
        pause: vi.fn().mockReturnValue(null),
        refresh: vi.fn().mockResolvedValue(fresh),
        observe: vi.fn().mockResolvedValue(undefined),
      }
      const { gateway, store, egress } = await setup(
        (req, res) => {
          req.resume()
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }))
        },
        {},
        { lifecycle },
      )
      const result = await call(gateway)
      expect(result.status).toBe(429)
      expect(lifecycle.refresh).toHaveBeenCalledOnce()
      expect(egress.request).toHaveBeenCalledTimes(fresh ? 2 : 1)
      await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
      // A provider that refuses the token generates nothing: the attempt ceiling stays intact.
      expect(store.finish).toHaveBeenCalledWith(
        'synthetic-call',
        expect.objectContaining({
          state: 'failed',
          usage: noUsage,
          estimated: false,
          estimateReason: null,
          upstreamStatus: 401,
        }),
      )
    },
  )

  it.each([
    [401, 'invalid_api_key'],
    [403, 'unsupported_country_region_territory'],
    [429, 'usage_limit_reached'],
    [429, 'rate_limit_exceeded'],
    [400, 'context_length_exceeded'],
    [500, 'server_error'],
    [503, 'server_is_overloaded'],
  ])(
    'records no provider usage when the provider answers HTTP %i (%s) before generating',
    async (status, code) => {
      const { gateway, store } = await setup((req, res) => {
        req.resume()
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code } }))
      })
      store.admit.mockImplementation(async () => ({
        kind: 'admitted',
        call: makeCall(150_000),
      }))
      await call(gateway)
      await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
      expect(store.finish).toHaveBeenCalledWith(
        'synthetic-call',
        expect.objectContaining({
          state: 'failed',
          usage: noUsage,
          estimated: false,
          estimateReason: null,
          upstreamStatus: status,
        }),
      )
    },
  )

  it('reports the version actually sent when a concurrent rotation overtook admission', async () => {
    const lifecycle = {
      pause: vi.fn().mockReturnValue(null),
      refresh: vi.fn().mockResolvedValue(null),
      observe: vi.fn().mockResolvedValue(undefined),
    }
    const { gateway, credentials } = await setup(
      (req, res) => {
        req.resume()
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }))
      },
      {},
      { lifecycle },
    )
    credentials.versionOf.mockReturnValue(2)
    await call(gateway)
    expect(lifecycle.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ credentialVersion: 1 }),
      codexBackend,
      2,
    )
  })

  it('never starts token refresh after provider response bytes have reached the client', async () => {
    const lifecycle = {
      pause: vi.fn().mockReturnValue(null),
      refresh: vi.fn(),
      observe: vi.fn().mockResolvedValue(undefined),
    }
    const { gateway, store } = await setup(
      (req, res) => {
        req.resume()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          delta +
            event({ type: 'response.failed', response: { error: { code: 'invalid_api_key' } } }),
        )
      },
      {},
      { lifecycle },
    )
    expect((await call(gateway)).status).toBe(200)
    expect(lifecycle.refresh).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({ billable: false }),
    )
  })

  it('normalizes the body before atomic admission, injects credentials, streams and persists exact usage', async () => {
    let upstreamHeaders: IncomingMessage['headers'] = {}
    let normalized = ''
    const { gateway, store, logger } = await setup((req, res) => {
      upstreamHeaders = req.headers
      req.on('data', (chunk: Buffer) => {
        normalized += chunk.toString()
      })
      req.on('end', () => success(req, res))
    })
    const result = await call(gateway, {
      body: { ...body, service_tier: 'priority', prompt_cache_key: 'untrusted' },
      headers: { cookie: 'must-not-forward' },
    })
    expect(result.status).toBe(200)
    expect(result.body).toContain('abcdef')
    expect(result.body).toContain('response.completed')
    expect(result.headers).toMatchObject({
      'x-codex-turn-state': 'synthetic-next',
      'retry-after': '5',
    })
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['x-codex-primary-used-percent']).toBeUndefined()
    expect(upstreamHeaders.authorization).toBe(`Bearer ${credential.accessToken}`)
    expect(upstreamHeaders.cookie).toBeUndefined()
    expect(JSON.parse(normalized)).toMatchObject({ prompt_cache_key: key.cacheKey })
    expect(JSON.parse(normalized)).not.toHaveProperty('service_tier')
    expect(store.lookup).toHaveBeenCalledWith(
      createHash('sha256').update(turnKey).digest('hex'),
      '127.0.0.1',
    )
    expect(store.admit.mock.calls[0]![0]).toMatchObject({ profile: key, backendId: key.backendId })
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'completed',
        estimated: false,
        billable: true,
        estimateReason: null,
        usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 1 },
      }),
    )
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(turnKey)
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(credential.accessToken)
  })

  it.each(successStreams)(
    '$name ignores invalid UTF-8 after a successful terminal in the same chunk',
    async (fixture) => {
      const { gateway, store, credentials } = await setup((req, res) => {
        req.resume()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(Buffer.concat([Buffer.from(fixture.stream), Buffer.from([0xff, 10])]))
      })
      store.lookup.mockResolvedValue(fixture.profile)
      store.admit.mockImplementation(async (input) => ({
        kind: 'admitted',
        call: { ...makeCall(input.estimatedInputTokens), ...fixture.profile },
      }))
      credentials.get.mockResolvedValue(fixture.credential)
      const result = await call(gateway, {
        path: fixture.path,
        headers: { 'user-agent': fixture.userAgent },
        body: fixture.body,
      })
      expect(result.status).toBe(200)
      expect(result.body).toContain(fixture.terminal)
      expect(result.body).toContain(fixture.usage)
      expect(result.body).not.toContain('\uFFFD')
      expect(store.finish).toHaveBeenCalledWith(
        'synthetic-call',
        expect.objectContaining({
          state: 'completed',
          estimated: false,
          billable: true,
          estimateReason: null,
          usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 1 },
        }),
      )
    },
  )

  it.each(successStreams)(
    '$name completes and closes an upstream that stays open after its terminal',
    async (fixture) => {
      let upstreamClosed = false
      const { gateway, store, credentials } = await setup((req, res) => {
        req.resume()
        res.once('close', () => {
          upstreamClosed = true
        })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(fixture.stream)
      })
      store.lookup.mockResolvedValue(fixture.profile)
      store.admit.mockImplementation(async (input) => ({
        kind: 'admitted',
        call: { ...makeCall(input.estimatedInputTokens), ...fixture.profile },
      }))
      credentials.get.mockResolvedValue(fixture.credential)
      const result = await call(gateway, {
        path: fixture.path,
        headers: { 'user-agent': fixture.userAgent },
        body: fixture.body,
      })
      expect(result.status).toBe(200)
      expect(result.body).toContain(fixture.terminal)
      expect(result.body).toContain(fixture.usage)
      await vi.waitFor(() => expect(upstreamClosed).toBe(true))
      expect(store.finish).toHaveBeenCalledWith(
        'synthetic-call',
        expect.objectContaining({
          state: 'completed',
          estimated: false,
          billable: true,
          estimateReason: null,
          usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 1 },
        }),
      )
      expect(gateway.stats().activeRequests).toBe(0)
    },
  )

  it('rejects methods, literal alternate paths, hosts and disallowed client CIDRs before lookup', async () => {
    const { gateway, store } = await setup(success)
    for (const path of [
      '/v1/responses',
      '/codex/models',
      '/codex/%72esponses',
      '/codex/responses?x=1',
      'http://evil.test/codex/responses',
    ])
      expect((await call(gateway, { path })).status).toBe(403)
    expect((await call(gateway, { method: 'GET' })).status).toBe(403)
    expect((await call(gateway, { headers: { host: 'evil.test' } })).status).toBe(403)
    expect(store.lookup).not.toHaveBeenCalled()
    const denied = await setup(success, {
      clients: [{ address: '192.0.2.0', prefix: 24, family: 'ipv4' }],
    })
    expect((await call(denied.gateway)).status).toBe(403)
    expect(denied.store.lookup).not.toHaveBeenCalled()
  })

  it("refuses a duplicate of a header it reads or its route's adapter declares, and a Connection-nominated authorization", async () => {
    const { gateway, store } = await setup(success)
    const duplicated: Array<[string | undefined, Record<string, string[]>]> = [
      [undefined, { authorization: [`Bearer ${turnKey}`, `Bearer ${turnKey}`] }],
      [undefined, { 'content-type': ['application/json', 'application/json'] }],
      // Declared by the adapter of the route, not by the gateway.
      [undefined, { 'session-id': ['first', 'second'] }],
      [undefined, { 'x-openai-internal-codex-responses-lite': ['true', 'true'] }],
      ['/kimi/v1/chat/completions', { 'x-msh-platform': ['first', 'second'] }],
    ]
    for (const [path, headers] of duplicated) {
      const result = await call(gateway, { path, headers })
      expect(result.status).toBe(403)
      expect(JSON.parse(result.body).error.code).toBe('raditi_headers')
    }
    expect((await call(gateway, { headers: { connection: ' AUTHORIZATION ' } })).status).toBe(401)
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it('looks a turn key up only in the format its issuer writes, by the hash its issuer stores', async () => {
    const { gateway, store } = await setup(success)
    for (const authorization of [
      'Bearer invalid',
      `Bearer ${turnKey}x`,
      `Bearer ${turnKey.slice(0, -1)}`,
      // The scheme is case-insensitive; the key is not.
      `bearer ${turnKey.replace('sk-rdt-', 'SK-RDT-')}`,
      `Basic ${turnKey}`,
    ]) {
      const refused = await call(gateway, { headers: { authorization } })
      expect(refused.status).toBe(401)
      expect(JSON.parse(refused.body).error.code).toBe('raditi_key')
    }
    expect(store.lookup).not.toHaveBeenCalled()
    expect((await call(gateway, { headers: { authorization: `bearer ${turnKey}` } })).status).toBe(
      200,
    )
    expect(store.lookup).toHaveBeenCalledExactlyOnceWith(turnKeyHash(turnKey), '127.0.0.1')
  })

  it('leaves the value rules of provider headers to the adapter of the key', async () => {
    const { gateway, store, egress } = await setup(success)
    const lite = await call(gateway, {
      headers: { 'x-openai-internal-codex-responses-lite': 'false' },
    })
    expect(lite.status).toBe(403)
    expect(JSON.parse(lite.body).error.code).toBe('raditi_client')
    store.lookup.mockResolvedValue(kimiKey)
    const oversized = await call(gateway, {
      path: '/kimi/v1/chat/completions',
      headers: { 'user-agent': 'kimi-code-cli/2.1.1', 'x-msh-version': 'x'.repeat(257) },
    })
    expect(oversized.status).toBe(403)
    expect(JSON.parse(oversized.body).error.code).toBe('raditi_client')
    expect(store.lookup).toHaveBeenCalledTimes(2)
    expect(store.admit).not.toHaveBeenCalled()
    expect(egress.request).not.toHaveBeenCalled()
  })

  it('passes exactly the client and response headers the adapter of the route declares', async () => {
    const seen: Headers[] = []
    let provider: IncomingMessage['headers'] = {}
    // An adapter the gateway has never heard of: its lists alone decide what passes.
    const adapter: LlmBackend = {
      ...codexBackend,
      clientHeaders: ['user-agent', 'x-synthetic-client'],
      responseHeaders: ['x-synthetic-response'],
      upstream(route, normalized, headers, secret, identity) {
        seen.push(headers)
        const target = codexBackend.upstream(route, normalized, headers, secret, identity)
        target.headers.set('x-synthetic-client', headers.get('x-synthetic-client') ?? 'missing')
        return target
      },
    }
    const { gateway, store } = await setup(
      (req, res) => {
        provider = req.headers
        req.resume()
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-synthetic-response': 'declared',
          'x-codex-turn-state': 'not-declared-by-this-adapter',
          'x-synthetic-other': 'undeclared',
        })
        res.end(delta + completed())
      },
      {},
      { backends: [adapter] },
    )
    const result = await call(gateway, {
      headers: {
        'x-synthetic-client': 'declared',
        'x-synthetic-undeclared': 'dropped',
        // Declared by the real adapters only: this one does not, so they never reach it.
        'session-id': 'dropped',
        'x-msh-platform': 'dropped',
      },
    })
    expect(result.status).toBe(200)
    expect([...seen[0]!.keys()].sort()).toEqual([
      'authorization',
      'content-type',
      'user-agent',
      'x-synthetic-client',
    ])
    expect(provider['x-synthetic-client']).toBe('declared')
    expect(provider['session-id']).toBeUndefined()
    expect(result.headers['x-synthetic-response']).toBe('declared')
    expect(result.headers['x-codex-turn-state']).toBeUndefined()
    expect(result.headers['x-synthetic-other']).toBeUndefined()
    // A duplicate of a header this adapter declares is refused before the key lookup.
    store.lookup.mockClear()
    const duplicate = await call(gateway, { headers: { 'x-synthetic-client': ['a', 'b'] } })
    expect(duplicate.status).toBe(403)
    expect(store.lookup).not.toHaveBeenCalled()
    // One it does not declare is not the gateway's concern.
    expect((await call(gateway, { headers: { 'session-id': ['a', 'b'] } })).status).toBe(200)
  })

  it('fails closed for unknown keys, backend mismatches, invalid CLI identity and atomic refusals', async () => {
    const { gateway, store, egress } = await setup(success)
    store.lookup.mockResolvedValueOnce(null)
    expect((await call(gateway)).status).toBe(401)
    expect((await call(gateway, { path: '/kimi/v1/chat/completions' })).status).toBe(403)
    expect((await call(gateway, { headers: { 'user-agent': 'wrong-cli' } })).status).toBe(403)
    store.admit.mockResolvedValueOnce({ kind: 'refused', reason: 'budget', keyId: key.keyId })
    expect((await call(gateway)).status).toBe(429)
    expect(store.refuse).toHaveBeenCalledWith(key.keyId, 'budget')
    expect(egress.request).not.toHaveBeenCalled()
  })

  it('uses the body policy before admission, including bounded JSON structure and model/profile binding', async () => {
    const { gateway, store, egress, logger } = await setup(success)
    for (const invalid of [
      '{"constructor":{}}',
      '{"secret-sensitive-unknown-field":1}',
      '{broken',
      JSON.stringify({ ...body, model: 'unapproved-model' }),
      JSON.stringify({ ...body, metadata: { secret: 'hidden' } }),
      `{"model":"gpt-6-sol","input":${'['.repeat(65)}null${']'.repeat(65)}}`,
    ]) {
      const result = await call(gateway, { body: invalid })
      expect(result.status).toBe(400)
      expect(JSON.parse(result.body).error.field.length).toBeLessThanOrEqual(64)
      expect(result.body).not.toContain('secret-sensitive-unknown-field')
    }
    expect(store.admit).not.toHaveBeenCalled()
    expect(egress.request).not.toHaveBeenCalled()
    expect(store.refuse).toHaveBeenCalledWith(key.keyId, 'policy')
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('secret-sensitive-unknown-field')
  })

  it('does not pass off a crash of the body normalizer as a policy violation', async () => {
    const { gateway, store, egress, logger } = await setup(success)
    const normalize = vi.spyOn(codexBackend, 'normalizeBody').mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    try {
      const result = await call(gateway)
      expect(result.status).toBe(503)
      expect(result.headers['retry-after']).toBe('30')
      expect(JSON.parse(result.body).error.code).toBe('raditi_transient')
      expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
      expect(store.admit).not.toHaveBeenCalled()
      expect(egress.request).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        JSON.stringify({ event: 'llm_body_normalization_failed', backend: codexBackend.id }),
      )
    } finally {
      normalize.mockRestore()
    }
  })

  it('waits outside admission transactions for an occupied account slot and retries fresh admission', async () => {
    const { gateway, store } = await setup(success)
    store.admit.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'transient',
      waitForSlot: true,
      retryAfterMs: 1000,
    })
    expect((await call(gateway)).status).toBe(200)
    expect(store.admit).toHaveBeenCalledTimes(2)
    expect(store.admit.mock.calls[0]).toEqual(store.admit.mock.calls[1])
  })

  it('probes an account with unknown windows once, then admits the running turn afresh', async () => {
    const lifecycle = controlLifecycle()
    const { gateway, store, egress } = await setup(success, {}, { lifecycle })
    const limitsSeenAt = new Date('2026-10-03T10:00:00Z')
    store.admit.mockResolvedValueOnce({
      kind: 'refused',
      keyId: key.keyId,
      reason: 'transient',
      retryAfterMs: 30_000,
      probeAccount: true,
      limitsSeenAt,
    })
    expect((await call(gateway)).status).toBe(200)
    // The probe gets the snapshot admission read: a remembered older probe is not an answer.
    expect(lifecycle.probeAccounts).toHaveBeenCalledExactlyOnceWith([key.accountId], {
      limitsSeenAt,
    })
    expect(store.admit).toHaveBeenCalledTimes(2)
    expect(lifecycle.probeAccounts.mock.invocationCallOrder[0]).toBeLessThan(
      store.admit.mock.invocationCallOrder[1]!,
    )
    expect(egress.request).toHaveBeenCalledOnce()
    expect(store.refuse).not.toHaveBeenCalled()
  })

  it('holds a turn whose windows stay unknown after its one probe as short-lived', async () => {
    const lifecycle = controlLifecycle()
    const { gateway, store, egress } = await setup(success, {}, { lifecycle })
    store.admit.mockResolvedValue({
      kind: 'refused',
      keyId: key.keyId,
      reason: 'transient',
      retryAfterMs: 30_000,
      probeAccount: true,
    })
    const result = await call(gateway)
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(JSON.parse(result.body).error.code).toBe('raditi_transient')
    expect(lifecycle.probeAccounts).toHaveBeenCalledOnce()
    expect(store.admit).toHaveBeenCalledTimes(2)
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    expect(egress.request).not.toHaveBeenCalled()
    // A failed or slow probe is no different: the turn is held, never refused for good.
    lifecycle.probeAccounts.mockRejectedValueOnce(new Error('synthetic probe failure'))
    expect((await call(gateway)).status).toBe(503)
    expect(store.refuse).toHaveBeenLastCalledWith(key.keyId, 'transient')
  })

  it('does not retry per-key admission limits and closes a failed credential lookup without provider usage', async () => {
    const { gateway, store, credentials, egress } = await setup(success)
    store.admit.mockResolvedValueOnce({ kind: 'refused', reason: 'transient', retryAfterMs: 1000 })
    expect((await call(gateway)).status).toBe(503)
    expect(store.admit).toHaveBeenCalledTimes(1)
    credentials.get.mockRejectedValueOnce(new Error('secret vault failure'))
    const result = await call(gateway)
    expect(result.status).toBe(503)
    expect(result.body).not.toContain('secret vault')
    expect(egress.request).not.toHaveBeenCalled()
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'failed',
        estimated: false,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }),
    )
  })

  it('replaces provider HTTP errors with local refusals without disclosing account details', async () => {
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9999' })
      res.end(
        JSON.stringify({
          error: { code: 'rate_limit_exceeded', message: 'private account id and plan' },
        }),
      )
    })
    const result = await call(gateway)
    // Provider overload is short-lived: the CLI must retry, after at most thirty seconds.
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(JSON.parse(result.body).error.code).toBe('raditi_transient')
    expect(result.body).not.toContain('private account')
    expect(store.refuse).toHaveBeenCalledWith(key.keyId, 'transient')
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({ state: 'failed', usage: noUsage, estimated: false }),
    )
  })

  it.each(['http', 'stream'] as const)(
    'ends the turn when the provider rejects this request over %s, without blaming the profile',
    async (kind) => {
      const { gateway, store } = await setup((req, res) => {
        req.resume()
        if (kind === 'http') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'context_length_exceeded' } }))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            event({
              type: 'response.failed',
              response: { error: { code: 'context_length_exceeded' } },
            }),
          )
        }
      })
      const result = await call(gateway)
      // Final for the CLI either way: a 400, or a stream code it ends the turn on.
      if (kind === 'http') {
        expect(result.status).toBe(400)
        expect(result.headers['retry-after']).toBeUndefined()
        expect(JSON.parse(result.body).error.code).toBe('raditi_request_rejected')
      } else expect(result.body).toContain('"code":"context_length_exceeded"')
      expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'request_rejected')
      await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
      expect(store.finish.mock.calls[0]![1]).toMatchObject({
        state: 'failed',
        signal: { kind: 'request_rejected', code: 'context_length_exceeded' },
      })
    },
  )

  it('refuses a provider redirect as short-lived, with no usage estimate', async () => {
    // The fake egress resolves a 3xx like the real transport: an answer, never followed.
    const { gateway, store, egress } = await setup((req, res) => {
      req.resume()
      res.writeHead(302, { location: 'https://private.example/login' })
      res.end()
    })
    const result = await call(gateway)
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(JSON.parse(result.body).error.code).toBe('raditi_transient')
    expect(result.headers.location).toBeUndefined()
    expect(egress.request).toHaveBeenCalledOnce()
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'failed',
        usage: noUsage,
        estimated: false,
        billable: true,
        estimateReason: null,
        upstreamStatus: 302,
      }),
    )
  })

  it('answers an egress failure as short-lived and keeps the estimate of a possibly delivered request', async () => {
    const { gateway, store, egress } = await setup(success)
    vi.mocked(egress.request).mockRejectedValueOnce(new Error('Subscription egress unavailable'))
    const result = await call(gateway)
    // One reset tunnel must not end the turn: the CLI retries a 503, never a 429.
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(JSON.parse(result.body).error.code).toBe('raditi_transient')
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'failed',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
      }),
    )
    expect((await call(gateway)).status).toBe(200)
  })

  it('records no usage when the egress proves the request never reached the provider', async () => {
    const { gateway, store, egress } = await setup(success)
    vi.mocked(egress.request).mockRejectedValueOnce(new EgressNotDelivered())
    const result = await call(gateway)
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'failed',
        usage: noUsage,
        estimated: false,
        estimateReason: null,
      }),
    )
  })

  it.each(['http', 'stream'] as const)(
    'keeps an observed %s provider failure nonbillable when the client disconnects during refusal journaling',
    async (kind) => {
      const { gateway, store } = await setup((req, res) => {
        req.resume()
        if (kind === 'http') {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'server_is_overloaded' } }))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            delta +
              event({
                type: 'response.failed',
                response: { error: { code: 'server_is_overloaded' } },
              }),
          )
        }
      })
      const refusing = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const disconnected = Promise.withResolvers<void>()
      store.refuse.mockImplementationOnce(async () => {
        refusing.resolve()
        await release.promise
      })
      gateway.server.once('connection', (socket) => socket.once('close', disconnected.resolve))
      const client = request(
        {
          hostname: '127.0.0.1',
          port: (gateway.server.address() as { port: number }).port,
          path: '/codex/responses',
          method: 'POST',
          agent: false,
          headers: {
            host: 'llm.local',
            authorization: `Bearer ${turnKey}`,
            'content-type': 'application/json',
            'user-agent': 'codex_exec/0.159.1',
          },
        },
        (res) => {
          res.on('error', () => {})
          res.resume()
        },
      )
      client.on('error', () => {})
      client.end(JSON.stringify(body))
      try {
        await refusing.promise
        client.destroy()
        await disconnected.promise
      } finally {
        release.resolve()
        client.destroy()
      }
      await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
      expect(store.finish).toHaveBeenCalledWith(
        'synthetic-call',
        expect.objectContaining({
          // The client of an HTTP error left before any answer. The client of a stream has
          // read the failure event and reconnects at once: its call failed, whichever of the
          // disconnect and the journal write comes first.
          state: kind === 'http' ? 'aborted' : 'failed',
          // An HTTP error answer generated nothing; a failed stream may have, so it estimates.
          ...(kind === 'http'
            ? { usage: noUsage, estimated: false, estimateReason: null }
            : { estimated: true, billable: false, estimateReason: 'aborted_platform' }),
          upstreamStatus: kind === 'http' ? 500 : 200,
          signal: { kind: 'transient', retryAfterMs: 30_000 },
        }),
      )
    },
  )

  it('sanitizes native failed SSE events before forwarding and retains the structural refusal', async () => {
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        delta +
          event({
            type: 'response.failed',
            response: {
              id: 'private-response-id',
              error: { code: 'cyber_policy', message: 'private account and prompt' },
            },
          }),
      )
    })
    const result = await call(gateway)
    expect(result.status).toBe(200)
    expect(result.body).toContain('response.failed')
    expect(result.body).not.toContain('private account')
    expect(result.body).not.toContain('private-response-id')
    expect(store.refuse).toHaveBeenCalledWith(key.keyId, 'policy_flagged')
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'failed',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
        usage: expect.objectContaining({ output: 2 }),
      }),
    )
  })

  it('estimates only delta text for completed streams with missing or invalid usage', async () => {
    let index = 0
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const current = index++
      const usage =
        current === 0
          ? null
          : current === 1
            ? { input_tokens: 1, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3 }
            : { input_tokens: 2_147_483_648, output_tokens: 3 }
      res.end(delta + completed(usage))
    })
    for (const reason of ['no_usage', 'invalid_usage', 'invalid_usage']) {
      expect((await call(gateway)).status).toBe(200)
      expect(store.finish.mock.calls.at(-1)![1]).toMatchObject({
        state: 'completed',
        estimated: true,
        billable: true,
        estimateReason: reason,
        usage: { output: 2 },
      })
    }
  })

  it('splits the input of its own estimates by the cache share admission reserved with', async () => {
    let index = 0
    const { gateway, store, egress } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        delta +
          completed(
            index++ === 0 ? null : { input_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
          ),
      )
    })
    let estimatedInputTokens = 0
    store.admit.mockImplementation(async (input) => {
      estimatedInputTokens = input.estimatedInputTokens
      // As admission after a call with 90 % cache: the reserve priced this part as cache reads.
      return { kind: 'admitted', call: makeCall(estimatedInputTokens, estimatedInputTokens - 1) }
    })
    vi.mocked(egress.request).mockRejectedValueOnce(new Error('Subscription egress unavailable'))
    expect((await call(gateway)).status).toBe(503)
    expect((await call(gateway)).status).toBe(200)
    expect((await call(gateway)).status).toBe(200)
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalledTimes(3))
    expect(estimatedInputTokens).toBeGreaterThan(1)
    expect(store.finish.mock.calls.map(([, finish]) => finish.estimateReason)).toEqual([
      'aborted_platform',
      'no_usage',
      'invalid_usage',
    ])
    for (const [, finish] of store.finish.mock.calls)
      expect(finish.usage).toMatchObject({
        input: estimatedInputTokens,
        cacheRead: estimatedInputTokens - 1,
        cacheWrite: 0,
      })
  })

  it('blocks new admission while completion cannot be journaled and resumes after persistence recovers', async () => {
    const { gateway, store } = await setup(success)
    store.finish.mockRejectedValueOnce(new Error('private database error'))
    expect((await call(gateway)).status).toBe(200)
    expect(gateway.stats().healthy).toBe(false)
    const closed = await call(gateway)
    // The CLI waits out a journal retry instead of spending its few retries in seconds,
    // and core learns from the key why its turn was refused.
    expect(closed.status).toBe(503)
    expect(closed.headers['retry-after']).toBe('30')
    expect(JSON.parse(closed.body).error.code).toBe('raditi_transient')
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    expect(store.admit).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(gateway.stats().healthy).toBe(true), { timeout: 2000 })
    expect(store.finish).toHaveBeenCalledTimes(2)
    expect(store.finish.mock.calls[0]).toEqual(store.finish.mock.calls[1])
  })

  it('reopens admission when a journal retry window ends and leaves the open call to the collector', async () => {
    const { gateway, store, logger } = await setup(success)
    store.finish.mockRejectedValue(new Error('private database error'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    expect((await call(gateway)).status).toBe(200)
    expect(gateway.stats().healthy).toBe(false)
    expect((await call(gateway)).status).toBe(503)
    await vi.advanceTimersByTimeAsync(600_000)
    await vi.waitFor(() => expect(gateway.stats().persistenceFailed).toBe(1))
    // PostgreSQL that stays down keeps admission closed through the collector's health;
    // this process itself must not refuse every later turn until it is restarted.
    expect(gateway.stats().healthy).toBe(true)
    store.finish.mockImplementation(storable)
    expect((await call(gateway)).status).toBe(200)
    expect(store.admit).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('llm_usage_journal_failed')
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private database error')
  })

  it('neither retries nor closes admission for an outcome the store can never record', async () => {
    const { gateway, store, logger } = await setup(success)
    store.finish.mockRejectedValueOnce(new GatewayRecordRejected())
    expect((await call(gateway)).status).toBe(200)
    await vi.waitFor(() => expect(gateway.stats().persistenceFailed).toBe(1))
    expect(gateway.stats().healthy).toBe(true)
    await realDelay(1_100)
    expect(store.finish).toHaveBeenCalledOnce()
    expect(gateway.stats().persistenceRetries).toBe(0)
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('llm_usage_journal_rejected')
    expect((await call(gateway)).status).toBe(200)
  })

  it('answers a failed key lookup as a short-lived platform failure', async () => {
    const { gateway, store } = await setup(success)
    store.lookup.mockRejectedValueOnce(new Error('private database error'))
    const result = await call(gateway)
    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('30')
    expect(result.body).not.toContain('private')
    expect(store.admit).not.toHaveBeenCalled()
  })

  it('limits a source to sixteen concurrent admitted requests', async () => {
    const { gateway, store } = await setup((req) => req.resume())
    const pending = Array.from({ length: 16 }, () => call(gateway).catch(() => undefined))
    await vi.waitFor(() => expect(store.admit).toHaveBeenCalledTimes(16))
    const busy = await call(gateway)
    expect(busy.status).toBe(503)
    // A request slot frees within seconds: a short retry suits this momentary local limit.
    expect(busy.headers['retry-after']).toBe('1')
    expect(store.admit).toHaveBeenCalledTimes(16)
    await gateway.close()
    await Promise.all(pending)
    expect(gateway.stats().activeRequests).toBe(0)
  })

  it('reports minimal health and token-protected aggregate metrics while runtime admission is closed', async () => {
    const { gateway, store } = await setup(
      success,
      {},
      { ready: () => false, health: async () => true, metricsToken: 'synthetic-metrics-token' },
    )
    const health = await call(gateway, { method: 'GET', path: '/health' })
    expect(health.status).toBe(503)
    expect(JSON.parse(health.body)).toEqual({ status: 'degraded' })
    const closed = await call(gateway)
    expect(closed.status).toBe(503)
    expect(closed.headers['retry-after']).toBe('30')
    expect(JSON.parse(closed.body).error.code).toBe('raditi_transient')
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    expect(store.admit).not.toHaveBeenCalled()
    // Without a turn key there is nothing to journal: authentication still comes first.
    expect((await call(gateway, { headers: { authorization: 'Bearer invalid' } })).status).toBe(401)
    expect((await call(gateway, { method: 'GET', path: '/metrics' })).status).toBe(401)
    const metrics = await call(gateway, {
      method: 'GET',
      path: '/metrics',
      headers: { authorization: 'Bearer synthetic-metrics-token' },
    })
    expect(metrics.status).toBe(200)
    expect(metrics.body).toContain('raditi_llm_active_requests{app="llm"} 0')
    expect(metrics.body).not.toContain(key.keyId)
    expect(metrics.body).not.toContain('synthetic-metrics-token')
    expect((await call(gateway, { method: 'GET', path: '/health?detail=1' })).status).toBe(403)
  })

  it('aborts generation at ten minutes and records a nonbillable platform estimate', async () => {
    const started = Promise.withResolvers<void>()
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // A live provider: one delta a minute, never a terminal.
      const tick = () => {
        if (res.destroyed) return
        res.write(delta)
        setTimeout(tick, 60_000)
      }
      tick()
      started.resolve()
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const client = stream(gateway)
    await started.promise
    await vi.advanceTimersByTimeAsync(600_000 - 1)
    expect(store.finish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
      }),
    )
    client.destroy()
  })

  it('closes a call as a platform stall when the provider stays silent for five minutes', async () => {
    const started = Promise.withResolvers<void>()
    const { gateway, store } = await setup((req) => {
      req.resume()
      started.resolve()
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pending = call(gateway)
    await started.promise
    await vi.advanceTimersByTimeAsync(300_000 - 1)
    expect(store.finish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status).toBe(503)
    // The account slot and the reservation are released, and the stall is not billed.
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
      }),
    )
    expect(gateway.stats().activeRequests).toBe(0)
  })

  it('does not bill a client that gives up on a provider silent for over a minute', async () => {
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(delta)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const received = Promise.withResolvers<void>()
    const client = stream(gateway, () => received.resolve())
    await received.promise
    await vi.advanceTimersByTimeAsync(60_000)
    client.destroy()
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
        usage: expect.objectContaining({ output: 2 }),
      }),
    )
  })

  it('does not bill a client that leaves before the provider answered', async () => {
    const { gateway, store, egress } = await setup((req) => req.resume())
    const client = stream(gateway)
    await vi.waitFor(() => expect(egress.request).toHaveBeenCalled())
    await realDelay(20)
    client.destroy()
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
    // The provider may have read the prompt: the estimate enters the ceiling, not the price.
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
      }),
    )
  })

  it('does not bill a client that leaves a refreshed retry the provider has not answered', async () => {
    const next = { ...credential, accessToken: jwt({ synthetic_new_token: true }) }
    const lifecycle = { ...controlLifecycle(), refresh: vi.fn().mockResolvedValue(next) }
    let attempts = 0
    const { gateway, store, egress } = await setup(
      (req, res) => {
        req.resume()
        attempts += 1
        if (attempts > 1) return
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }))
      },
      {},
      { lifecycle },
    )
    const client = stream(gateway)
    await vi.waitFor(() => expect(egress.request).toHaveBeenCalledTimes(2))
    await realDelay(20)
    client.destroy()
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
    // The 401 was the provider's answer to the first request, not to the one the client left.
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
      }),
    )
  })

  it('cancels upstream on client disconnect and preserves the delta-only client estimate', async () => {
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(delta)
    })
    const port = (gateway.server.address() as { port: number }).port
    const client = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/codex/responses',
        method: 'POST',
        agent: false,
        headers: {
          host: 'llm.local',
          authorization: `Bearer ${turnKey}`,
          'content-type': 'application/json',
          'user-agent': 'codex_exec/0.159.1',
        },
      },
      (res) => {
        res.on('error', () => {})
        res.once('data', () => res.destroy())
      },
    )
    client.on('error', () => {})
    client.end(JSON.stringify(body))
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: true,
        estimateReason: 'aborted_client',
        usage: expect.objectContaining({ output: 2 }),
      }),
    )
    client.destroy()
  })

  it('observes a late admission commit after client disconnect and closes it with zero usage', async () => {
    const { gateway, store, credentials, egress } = await setup(success)
    const admission = Promise.withResolvers<Awaited<ReturnType<GatewayStore['admit']>>>()
    const started = Promise.withResolvers<void>()
    store.admit.mockImplementationOnce(() => {
      started.resolve()
      return admission.promise
    })
    const port = (gateway.server.address() as { port: number }).port
    const client = request({
      hostname: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      agent: false,
      headers: {
        host: 'llm.local',
        authorization: `Bearer ${turnKey}`,
        'content-type': 'application/json',
        'user-agent': 'codex_exec/0.159.1',
      },
    })
    client.on('error', () => {})
    client.end(JSON.stringify(body))
    await started.promise
    const closed = new Promise<void>((resolve) => client.once('close', resolve))
    try {
      client.destroy()
      await closed
      await realDelay(10)
      expect(store.finish).not.toHaveBeenCalled()
    } finally {
      admission.resolve({ kind: 'admitted', call: makeCall() })
    }
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled())
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: false,
        estimateReason: null,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }),
    )
    expect(credentials.get).not.toHaveBeenCalled()
    expect(egress.request).not.toHaveBeenCalled()
  })

  it('classifies an active stream closed during shutdown as a nonbillable platform interruption', async () => {
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(delta)
    })
    const started = Promise.withResolvers<void>()
    const client = request(
      {
        hostname: '127.0.0.1',
        port: (gateway.server.address() as { port: number }).port,
        path: '/codex/responses',
        method: 'POST',
        agent: false,
        headers: {
          host: 'llm.local',
          authorization: `Bearer ${turnKey}`,
          'content-type': 'application/json',
          'user-agent': 'codex_exec/0.159.1',
        },
      },
      (res) => {
        res.on('error', () => {})
        res.once('data', () => started.resolve())
      },
    )
    client.on('error', () => {})
    client.end(JSON.stringify(body))
    await started.promise
    await gateway.close()
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
        usage: expect.objectContaining({ output: 2 }),
      }),
    )
    client.destroy()
  })

  it('aborts after sixty seconds when a paused client stops draining the SSE stream', async () => {
    const hugeDelta = event({ type: 'response.output_text.delta', delta: 'x'.repeat(512 * 1024) })
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      void (async () => {
        for (let index = 0; index < 40; index++) if (!res.write(hugeDelta)) await once(res, 'drain')
      })().catch(() => res.destroy())
    })
    const started = Promise.withResolvers<IncomingMessage>()
    const persisted = Promise.withResolvers<void>()
    store.finish.mockImplementation(async () => {
      persisted.resolve()
      return true
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = request(
      {
        hostname: '127.0.0.1',
        port: (gateway.server.address() as { port: number }).port,
        path: '/codex/responses',
        method: 'POST',
        agent: false,
        headers: {
          host: 'llm.local',
          authorization: `Bearer ${turnKey}`,
          'content-type': 'application/json',
          'user-agent': 'codex_exec/0.159.1',
        },
      },
      (res) => {
        res.on('error', () => {})
        res.pause()
        started.resolve(res)
      },
    )
    client.on('error', () => {})
    client.end(JSON.stringify(body))
    const response = await started.promise
    // The stall timer stays armed only once the buffers between the gateway and the paused client
    // are full, and how much they hold depends on the platform (megabytes on Linux): a fixed pause
    // here was a race, and a timer armed after the clock moved never fires. The request timer, the
    // provider idle timer and the stall timer make three; wait until all three hold without a break.
    let armedSince: number | undefined
    for (const giveUpAt = performance.now() + 20_000; ;) {
      if (vi.getTimerCount() < 3) armedSince = undefined
      else if (performance.now() - (armedSince ??= performance.now()) >= 500) break
      if (performance.now() > giveUpAt)
        throw new Error('The gateway never stalled on the paused client')
      await realDelay(20)
    }
    await vi.advanceTimersByTimeAsync(60_000 - 1)
    expect(store.finish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await persisted.promise
    expect(store.finish).toHaveBeenCalledWith(
      'synthetic-call',
      expect.objectContaining({
        state: 'aborted',
        estimated: true,
        billable: false,
        estimateReason: 'aborted_platform',
      }),
    )
    response.destroy()
    client.destroy()
    // Filling the buffers takes real time: seconds on a loaded machine, not the default five.
  }, 30_000)
})

// The pinned OpenCode CLI answers these with the same request again, at once and without a limit
// (docs/plan/40-opencode-spike.md, section 4): the sandbox must read one error object instead.
describe('Z.ai streams the CLI cannot stop on', () => {
  const zaiKey: GatewayKey = {
    ...key,
    backendId: 'zai-coding',
    model: 'glm-5.3',
    reasoningEffort: 'high',
    driverId: 'opencode',
    clientIdentity: {},
  }
  const zaiCredential = { v: '1', kind: 'zai_api_key', apiKey: 'synthetic-zai-plan-key' }
  const userAgent = 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
  const zaiBody = {
    model: 'glm-5.3',
    max_tokens: 32_000,
    messages: [{ role: 'user', content: 'synthetic prompt' }],
    stream: true,
    stream_options: { include_usage: true },
  }
  const chunk = (content: string, finish?: string) =>
    event({
      id: '202601010000000000000000000001',
      created: 1767225600,
      object: 'chat.completion.chunk',
      model: 'glm-5.3',
      choices: [
        {
          index: 0,
          ...(finish ? { finish_reason: finish } : {}),
          delta: { role: 'assistant', content },
        },
      ],
      ...(finish
        ? {
            usage: {
              prompt_tokens: 19,
              completion_tokens: 6,
              total_tokens: 25,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          }
        : {}),
    })
  const done = 'data: [DONE]\n\n'
  async function zai(
    stream: string,
    backend: LlmBackend = zaiCodingBackend,
    // `cut`: the provider's connection breaks after the stream's bytes, without an HTTP end.
    ending: 'end' | 'cut' = 'end',
  ) {
    const provider: { headers: IncomingMessage['headers']; body: string }[] = []
    const stand = await setup(
      (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (part: Buffer) => chunks.push(part))
        req.on('end', () => {
          provider.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
          res.writeHead(200, {
            'content-type': 'text/event-stream;charset=UTF-8',
            'set-cookie': 'acw_tc=synthetic-cookie; Path=/; HttpOnly',
            'x-log-id': 'synthetic-log-id',
            'x-request-id': 'synthetic-request-id',
            'retry-after': '999999',
          })
          if (ending === 'end') res.end(stream)
          // Let the bytes leave before the socket goes.
          else res.write(stream, () => void realDelay(20).then(() => res.destroy()))
        })
      },
      {},
      { backends: [backend] },
    )
    stand.store.lookup.mockResolvedValue(zaiKey)
    stand.store.admit.mockImplementation(async (input) => ({
      kind: 'admitted',
      call: { ...makeCall(input.estimatedInputTokens), ...zaiKey },
    }))
    stand.credentials.get.mockResolvedValue(zaiCredential)
    const persisted = Promise.withResolvers<GatewayFinish>()
    stand.store.finish.mockImplementation(async (_callId, outcome) => {
      persisted.resolve(outcome)
      return storable(_callId, outcome)
    })
    const send = () =>
      call(stand.gateway, {
        path: '/zai/v4/chat/completions',
        headers: {
          'user-agent': userAgent,
          'x-session-id': 'ses_synthetic',
          cookie: 'acw_tc=client-cookie',
        },
        body: zaiBody,
      })
    return { ...stand, provider, persisted: persisted.promise, send }
  }
  const events = (text: string) =>
    text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => block.replace(/^event: message\ndata: /, ''))

  it('streams a finished answer, with the plan key and nothing of the client but its body', async () => {
    const { send, provider, persisted, store } = await zai(
      chunk('abcdef') + chunk('', 'stop') + done,
    )
    const result = await send()
    expect(result.status).toBe(200)
    expect(events(result.body).at(-1)).toBe('[DONE]')
    expect(result.body).toContain('"finish_reason":"stop"')
    // None of the provider's own headers reaches the sandbox, each one checked by itself.
    for (const name of ['set-cookie', 'x-log-id', 'x-request-id'])
      expect(result.headers[name], name).toBeUndefined()
    // Decision 7(а) of the pivot plan belongs to G4: until then the pause a provider names on
    // a successful answer still passes, and the CLI obeys it. G4 turns this line around.
    expect(result.headers['retry-after']).toBe('999999')
    expect(provider).toHaveLength(1)
    expect(provider[0]!.headers.authorization).toBe('Bearer synthetic-zai-plan-key')
    expect(provider[0]!.headers['user-agent']).toBe(userAgent)
    expect(provider[0]!.headers.accept).toBe('text/event-stream')
    expect(provider[0]!.headers['accept-encoding']).toBe('identity')
    expect(provider[0]!.headers['x-session-id']).toBeUndefined()
    expect(provider[0]!.headers.cookie).toBeUndefined()
    expect(provider[0]!.body).not.toContain(turnKey)
    // The profile of the turn, not the request, sets the level of reasoning.
    expect(JSON.parse(provider[0]!.body)).toMatchObject({
      model: 'glm-5.3',
      max_tokens: 32_000,
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(await persisted).toMatchObject({
      state: 'completed',
      estimated: false,
      usage: { input: 19, cacheRead: 3, cacheWrite: 0, output: 6, reasoning: 2 },
    })
    expect(store.refuse).not.toHaveBeenCalled()
  })

  it.each([
    ['finish_reason sensitive', chunk('abcdef') + chunk('', 'sensitive') + done, 'policy_flagged'],
    [
      'finish_reason model_context_window_exceeded',
      chunk('abcdef') + chunk('', 'model_context_window_exceeded') + done,
      'request_rejected',
    ],
    [
      'a finish_reason nobody has seen',
      chunk('abcdef') + chunk('', 'later_value') + done,
      'account',
    ],
    ['DONE alone', done, 'account'],
    ['text and DONE without a finish_reason', chunk('abcdef') + done, 'account'],
    ['text without a finish_reason and without DONE', chunk('abcdef'), 'account'],
    ['an empty stream', '', 'account'],
  ] as const)('answers %s with one final error object', async (_name, stream, refusal) => {
    const { send, provider, persisted, store, egress } = await zai(stream)
    const result = await send()
    // The stream was already started: the refusal is its last event, and the response ends cleanly.
    expect(result.status).toBe(200)
    const sent = events(result.body)
    expect(JSON.parse(sent.at(-1)!)).toEqual({
      error: {
        type: 'invalid_request_error',
        code: `raditi_${refusal}`,
        message: expect.any(String) as string,
      },
    })
    expect(sent.filter((data) => data.includes('"error"'))).toHaveLength(1)
    expect(result.body).not.toContain('[DONE]')
    expect(result.body).not.toMatch(/sensitive|model_context_window_exceeded|later_value/)
    expect(provider).toHaveLength(1)
    expect(egress.request).toHaveBeenCalledOnce()
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(zaiKey.keyId, refusal)
    const finish = await persisted
    expect(finish.state).toBe('failed')
    expect(finish.signal?.kind).toBe(refusal === 'account' ? 'unconfirmed_block' : refusal)
  })

  it('leaves an unfinished stream of an adapter without an end rule to the cut connection', async () => {
    const withoutEnd: LlmBackend = {
      ...zaiCodingBackend,
      streamInspector: () => ({ inspect: zaiCodingBackend.streamInspector().inspect }),
    }
    const { send, persisted, store } = await zai(chunk('abcdef'), withoutEnd)
    await expect(send()).rejects.toThrow()
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(zaiKey.keyId, 'transient')
    expect((await persisted).state).toBe('failed')
  })

  it('asks the adapter for the end only when the provider closed the stream itself', async () => {
    const end = vi.fn(() => null)
    const counting: LlmBackend = {
      ...zaiCodingBackend,
      streamInspector: () => ({ inspect: zaiCodingBackend.streamInspector().inspect, end }),
    }
    // A finished answer and a failure inside the stream: the adapter has had its word.
    for (const stream of [chunk('abcdef') + chunk('', 'stop') + done, done]) {
      const { send, persisted } = await zai(stream, counting)
      await send()
      await persisted
    }
    // A connection that broke in the middle of the answer is no end of the stream: the sandbox
    // gets the same cut, which the CLI repeats with pauses, and no final refusal is made of it.
    const broken = await zai(chunk('abcdef'), counting, 'cut')
    await expect(broken.send()).rejects.toThrow()
    expect((await broken.persisted).state).toBe('failed')
    expect(broken.store.refuse).toHaveBeenCalledExactlyOnceWith(zaiKey.keyId, 'transient')
    expect(end).not.toHaveBeenCalled()
    // Finished, yet without DONE: asked once, and its null leaves the ending as it was.
    const { send, persisted } = await zai(chunk('abcdef') + chunk('', 'stop'), counting)
    expect((await send()).status).toBe(200)
    expect((await persisted).state).toBe('completed')
    expect(end).toHaveBeenCalledOnce()
  })
})
