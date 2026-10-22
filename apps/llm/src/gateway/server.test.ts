import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { setTimeout as realDelay } from 'node:timers/promises'

import { badRequest, llmJsonLimits, type LlmBackend, type LlmBackendId } from '@repo/domain'
import { zaiCodingBackend } from '@repo/llm-backends'
import {
  turnKeyHash,
  gatewayFinishSchema,
  GatewayRecordRejected,
  type GatewayFinish,
} from '@repo/turn-keys'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GatewayCall, GatewayKey, GatewayStore } from '../accounting/gateway-types.ts'
import type { LlmConfig } from '../config/llm-config.ts'
import { EgressNotDelivered, type StreamingEgress } from '../egress/egress.ts'
import { createLlmGateway, type LlmGateway, type LlmGatewayOptions } from './server.ts'

const turnKey = `sk-rdt-${Buffer.alloc(32, 7).toString('base64url')}`
const key: GatewayKey = {
  keyId: 'synthetic-key',
  modelId: 'synthetic-model',
  model: 'glm-5.3',
  reasoningEffort: 'high',
  backendId: 'zai-coding',
  providerId: 'synthetic-provider',
  taskId: 'synthetic-task',
  taskAttempt: 0,
  driverId: 'opencode',
  accountId: 'synthetic-account',
  modelSlug: 'synthetic-model',
  reserveOutputTokens: 100,
  budgetRub: '100.00',
  credentialRef: 'subs/synthetic-account',
  credentialVersion: 1,
  maxConcurrentRequests: 2,
  staleWindows: false,
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
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const zaiCredential = { v: '1', kind: 'zai_api_key', apiKey: 'synthetic-zai-plan-key' }
const zaiUserAgent = 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const zaiBody = {
  model: 'glm-5.3',
  max_tokens: 32_000,
  messages: [{ role: 'user', content: 'synthetic prompt' }],
  stream: true,
  stream_options: { include_usage: true },
}
const zaiUsage = {
  prompt_tokens: 19,
  completion_tokens: 6,
  total_tokens: 25,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
}
const chunk = (content: string, finish?: string, usage: unknown = zaiUsage) =>
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
    ...(finish ? { usage } : {}),
  })
const done = 'data: [DONE]\n\n'

/**
 * What a test of the role needs of the adapter whose route it calls: the key of the turn, the
 * credential, a request the body policy accepts, and a finished stream. The same usage in both:
 * 10 input tokens with 2 from the cache, 3 output tokens with 1 of reasoning.
 */
const wires = [
  {
    name: 'Z.ai',
    backend: zaiCodingBackend,
    key: key,
    credential: zaiCredential as Record<string, unknown>,
    authorization: `Bearer ${zaiCredential.apiKey}`,
    path: '/zai/v4/chat/completions',
    userAgent: zaiUserAgent,
    body: zaiBody as Record<string, unknown>,
    conversation: 'messages',
    delta: chunk('abcdef'),
    text: (content: string) => chunk(content),
    completed: (
      usage: unknown = {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    ) => chunk('', 'stop', usage) + done,
    overloaded: event({ error: { code: '1302', message: 'synthetic' } }),
    busy: { error: { code: '1302', message: 'private account id and plan' } },
    rejected: {
      http: { error: { code: '1261', message: 'synthetic' } } as unknown,
      stream: event({ error: { code: '1261', message: 'synthetic' } }),
      code: 'zai_1261',
      seen: '"code":"raditi_request_rejected"',
    },
    terminal: '[DONE]',
    // A spent budget ends the turn of the pinned CLI on a final 403.
    budgetStatus: 403,
    usage: (input: number, cached?: number, output?: number): unknown => ({
      prompt_tokens: input,
      ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
      ...(output === undefined ? {} : { completion_tokens: output }),
    }),
  },
]
type Wire = (typeof wires)[number]
const defaultWire = wires[0]!
// One finished stream of every adapter, for what the role does at the end of any of them.
const finishedStreams = [
  {
    name: 'Z.ai',
    profile: key,
    credential: zaiCredential,
    path: defaultWire.path,
    userAgent: zaiUserAgent,
    body: zaiBody,
    stream: defaultWire.delta + defaultWire.completed(),
    terminal: '[DONE]',
    usage: '"prompt_tokens":10',
  },
]
/**
 * A second adapter with a route, a client and a declared header of its own. What the role does
 * between two backends — a key of one on the route of the other, a header one of them declares —
 * is shown on it, whatever the one adapter of the platform is.
 */
const otherRoute = '/other/v1/chat/completions'
const otherUserAgent = 'other-cli/1.0.0'
const otherBackend: LlmBackend = {
  ...zaiCodingBackend,
  id: 'synthetic-other' as LlmBackendId,
  routes: [{ method: 'POST', path: otherRoute }],
  clientHeaders: ['user-agent', 'x-other-session'],
  validateClientHeaders(headers) {
    if (headers.get('user-agent') !== otherUserAgent) throw badRequest('Invalid client identity')
    // A rule for the value of a header it declares: the gateway knows none of it.
    if ((headers.get('x-other-session')?.length ?? 0) > 16)
      throw badRequest('Invalid client identity')
  },
}
const otherKey: GatewayKey = { ...key, backendId: otherBackend.id }
const cleanups: Array<() => Promise<void>> = []
// The fake store closes calls without PostgreSQL; the real store would reject these outcomes.
const unstorable: GatewayFinish[] = []
const storable = async (_callId: string, outcome: GatewayFinish) => {
  if (!gatewayFinishSchema.safeParse(outcome).success) unstorable.push(outcome)
  return true
}

const controlLifecycle = () => ({
  pause: vi.fn().mockReturnValue(null),
  observe: vi.fn().mockResolvedValue(undefined),
  probeAccounts: vi.fn().mockResolvedValue(undefined),
  refreshAccount: vi.fn().mockResolvedValue(undefined),
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
  wire: Wire = defaultWire,
) {
  const upstream = createServer(handler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const originPort = (upstream.address() as { port: number }).port
  const store = {
    lookup: vi.fn<GatewayStore['lookup']>().mockResolvedValue(wire.key),
    admit: vi.fn<GatewayStore['admit']>().mockImplementation(async (input) => ({
      kind: 'admitted',
      call: { ...makeCall(input.estimatedInputTokens), ...wire.key },
    })),
    refuse: vi.fn<GatewayStore['refuse']>().mockResolvedValue(undefined),
    finish: vi.fn<GatewayStore['finish']>(storable),
    collectLost: vi.fn<GatewayStore['collectLost']>().mockResolvedValue(0),
  }
  const credentials = { get: vi.fn().mockResolvedValue(wire.credential) }
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
    maxCallsPerKey30s: 20,
    maxCallsPerKey: 600,
    egress: { proxyUrl: null, upstreamCaFile: null, backendOrigins: new Map() },
    ...patch,
  }
  const gateway = createLlmGateway({
    config,
    backends: [zaiCodingBackend, otherBackend],
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
  wire: Wire = defaultWire,
) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>(
    (resolve, reject) => {
      const port = (gateway.server.address() as { port: number }).port
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: options.path ?? wire.path,
          method: options.method ?? 'POST',
          agent: false,
          headers: {
            host: 'llm.local',
            authorization: `Bearer ${turnKey}`,
            'content-type': 'application/json',
            'user-agent': wire.userAgent,
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
            : JSON.stringify(options.body ?? wire.body),
      )
    },
  )
}

/** A request whose caller decides when to disconnect; errors after that are expected. */
function stream(gateway: LlmGateway, onData: () => void = () => {}, wire: Wire = defaultWire) {
  const client = request(
    {
      hostname: '127.0.0.1',
      port: (gateway.server.address() as { port: number }).port,
      path: wire.path,
      method: 'POST',
      agent: false,
      headers: {
        host: 'llm.local',
        authorization: `Bearer ${turnKey}`,
        'content-type': 'application/json',
        'user-agent': wire.userAgent,
      },
    },
    (res) => {
      res.on('error', () => {})
      res.on('data', onData)
    },
  )
  client.on('error', () => {})
  client.end(JSON.stringify(wire.body))
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

  it('refreshes old snapshots for core by the rule of freshness, not of unknown windows', async () => {
    const lifecycle = controlLifecycle()
    const { gateway } = await setup(
      (_request, response) => response.end(),
      {},
      { lifecycle, metricsToken: token },
    )
    const accountIds = [randomUUID(), randomUUID()]
    const result = await call(gateway, { path, headers, body: { accountIds, stale: true } })
    expect(result.status).toBe(204)
    expect(lifecycle.refreshAccount.mock.calls).toEqual(accountIds.map((id) => [id]))
    expect(lifecycle.probeAccounts).not.toHaveBeenCalled()
    // The flag is the literal true or absent: nothing else selects a rule.
    for (const stale of [false, 'true', 1])
      expect((await call(gateway, { path, headers, body: { accountIds, stale } })).status).toBe(400)
    expect(lifecycle.refreshAccount).toHaveBeenCalledTimes(2)
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
    // Too large is a body the role does not take, like a malformed one: the same final 400.
    const large = await call(gateway, { path, headers, body: 'x'.repeat(2 * 1024 + 1) })
    expect(large.status).toBe(400)
    expect(JSON.parse(large.body).error.code).toBe('raditi_body')
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

// The harness of the module under the names the tests below shadow with their adapter's forms.
const base = { setup, call, stream, makeCall }
describe.each(wires)('subscription HTTP gateway on the $name adapter', (wire) => {
  const { key, body, delta, completed, backend } = wire
  const setup = (
    handler: Parameters<typeof base.setup>[0],
    patch: Parameters<typeof base.setup>[1] = {},
    runtime: Parameters<typeof base.setup>[2] = {},
  ) => base.setup(handler, patch, runtime, wire)
  const call = (gateway: LlmGateway, options: Parameters<typeof base.call>[1] = {}) =>
    base.call(gateway, options, wire)
  const stream = (gateway: LlmGateway, onData?: () => void) => base.stream(gateway, onData, wire)
  const makeCall = (...estimates: Parameters<typeof base.makeCall>): GatewayCall => ({
    ...base.makeCall(...estimates),
    ...key,
  })
  const success = (req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-provider-state': 'synthetic-next',
      'retry-after': '5',
      'set-cookie': 'secret=must-not-forward',
      'x-provider-used-percent': '20',
    })
    res.end(delta + completed())
  }

  it('checks an account pause before reserving money or contacting the provider', async () => {
    const lifecycle = {
      pause: vi.fn().mockReturnValue({ reason: 'transient', retryAfterMs: 120_000 }),
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

  const refusedKey = (req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: '1000' } }))
  }

  // The pool health learns of a call only here, and it reads what the journal has just written
  // about it: the count of payment refusals, the windows a spent quota has dropped.
  it.each([
    ['a completed call', success, 'completed'],
    ['a provider refusal', refusedKey, 'failed'],
  ] as const)(
    'reports %s to the pool health once, after the journal has it',
    async (_name, handler, state) => {
      const lifecycle = controlLifecycle()
      const { gateway, store } = await setup(handler, {}, { lifecycle })
      await call(gateway)
      await vi.waitFor(() => expect(lifecycle.observe).toHaveBeenCalledOnce())
      expect(store.finish).toHaveBeenCalledOnce()
      const admission = await store.admit.mock.results[0]!.value
      const [callId, finish] = store.finish.mock.calls[0]!
      expect(admission).toMatchObject({ kind: 'admitted', call: { id: callId } })
      expect(finish.state).toBe(state)
      expect(lifecycle.observe).toHaveBeenCalledWith(admission.call, finish)
      expect(store.finish.mock.invocationCallOrder[0]).toBeLessThan(
        lifecycle.observe.mock.invocationCallOrder[0]!,
      )
    },
  )

  it('answers and journals the same when the pool health fails to take a finished call', async () => {
    const plain = await setup(success)
    const expected = await call(plain.gateway)
    const lifecycle = controlLifecycle()
    lifecycle.observe.mockRejectedValue(new Error('private pool error'))
    const { gateway, store, logger } = await setup(success, {}, { lifecycle })
    const result = await call(gateway)
    expect({ status: result.status, body: result.body }).toEqual({
      status: expected.status,
      body: expected.body,
    })
    await vi.waitFor(() =>
      expect(JSON.stringify(logger.warn.mock.calls)).toContain('llm_pool_update_failed'),
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private pool error')
    expect(store.finish.mock.calls).toEqual(plain.store.finish.mock.calls)
    // The journal has the call: nothing closes admission for the next one.
    expect(gateway.stats().healthy).toBe(true)
    expect((await call(gateway)).status).toBe(200)
  })

  it.each([
    [401, '1000'],
    [403, '1113'],
    [429, '1308'],
    [429, '1302'],
    [400, '1261'],
    [500, '500'],
    [503, '1305'],
  ])(
    'asks the provider once and records no provider usage when it answers HTTP %i (%s) before generating',
    async (status, code) => {
      const { gateway, store, egress } = await setup((req, res) => {
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
      // A refusal is the provider's answer: the role never repeats the request by itself.
      expect(egress.request).toHaveBeenCalledOnce()
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

  it.each(finishedStreams)(
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

  it.each(finishedStreams)(
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
      '/zai/v4/models',
      `${wire.path}?x=1`,
      `${wire.path}/`,
      // The last letter of the route as a percent escape.
      wire.path.replace(/s$/, '%73'),
      `http://evil.test${wire.path}`,
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
    expect(backend.clientHeaders).not.toHaveLength(0)
    const duplicated: Array<[string | undefined, Record<string, string[]>]> = [
      [undefined, { authorization: [`Bearer ${turnKey}`, `Bearer ${turnKey}`] }],
      [undefined, { 'content-type': ['application/json', 'application/json'] }],
      // Declared by the adapter of the route, not by the gateway.
      ...backend.clientHeaders.map((name): [undefined, Record<string, string[]>] => [
        undefined,
        { [name]: ['first', 'second'] },
      ]),
      // And by the adapter of another route, on that route.
      [otherRoute, { 'x-other-session': ['first', 'second'] }],
    ]
    for (const [path, headers] of duplicated) {
      const result = await call(gateway, { path, headers })
      expect(result.status).toBe(403)
      expect(JSON.parse(result.body).error.code).toBe('raditi_headers')
    }
    expect((await call(gateway, { headers: { connection: ' AUTHORIZATION ' } })).status).toBe(401)
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it('refuses a body beyond the limit with a final 400, by its declared length and by its bytes, before admission', async () => {
    let reached = 0
    const { gateway, store } = await setup((req, res) => {
      reached += 1
      req.resume()
      res.end()
    })
    const port = (gateway.server.address() as { port: number }).port
    const refused = (declared: number | undefined, send: Buffer[]) =>
      new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port,
              path: wire.path,
              method: 'POST',
              agent: false,
              headers: {
                host: 'llm.local',
                authorization: `Bearer ${turnKey}`,
                'content-type': 'application/json',
                'user-agent': wire.userAgent,
                ...(declared === undefined ? {} : { 'content-length': String(declared) }),
              },
            },
            (res) => {
              const chunks: Buffer[] = []
              res.on('data', (chunk: Buffer) => chunks.push(chunk))
              res.on('error', reject)
              res.on('end', () => {
                resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString(),
                })
                req.destroy()
              })
            },
          )
          req.on('error', reject)
          // Never ended: the answer must not wait for the rest of the body.
          req.flushHeaders()
          for (const chunk of send) req.write(chunk)
        },
      )
    const megabyte = Buffer.alloc(1024 * 1024, 0x20)
    const results = [
      // The headers alone: one byte more than the role takes is refused before a byte is read.
      await refused(llmJsonLimits.bytes + 1, []),
      // No declared length: refused with the first byte past the limit.
      await refused(undefined, [
        ...Array.from({ length: llmJsonLimits.bytes / megabyte.length }, () => megabyte),
        Buffer.from(' '),
      ]),
    ]
    for (const result of results) {
      // 400, not 413: the pinned CLI reads any 413 as an overflow of its context and answers
      // it with a request for a compaction instead of the end of the turn.
      expect(result.status).toBe(400)
      expect(JSON.parse(result.body)).toEqual({
        error: {
          type: 'invalid_request_error',
          code: 'raditi_body',
          message: 'Gateway request is not allowed',
        },
      })
      expect(result.headers['retry-after']).toBeUndefined()
    }
    // After the key and the client were checked, before admission: no call, a final refusal.
    expect(store.lookup).toHaveBeenCalledTimes(2)
    expect(store.refuse.mock.calls.map(([, reason]) => reason)).toEqual(['policy', 'policy'])
    expect(store.admit).not.toHaveBeenCalled()
    expect(reached).toBe(0)
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
    store.lookup.mockResolvedValue(otherKey)
    // The header is declared, so the gateway passes it; its value is the adapter's to refuse.
    const oversized = await call(gateway, {
      path: otherRoute,
      headers: { 'user-agent': otherUserAgent, 'x-other-session': 'x'.repeat(17) },
    })
    expect(oversized.status).toBe(403)
    expect(JSON.parse(oversized.body).error.code).toBe('raditi_client')
    expect(store.lookup).toHaveBeenCalledOnce()
    expect(store.admit).not.toHaveBeenCalled()
    expect(egress.request).not.toHaveBeenCalled()
  })

  it('passes exactly the client and response headers the adapter of the route declares', async () => {
    const seen: Headers[] = []
    let provider: IncomingMessage['headers'] = {}
    // An adapter the gateway has never heard of: its lists alone decide what passes.
    const adapter: LlmBackend = {
      ...backend,
      clientHeaders: ['user-agent', 'x-synthetic-client'],
      responseHeaders: ['x-synthetic-response'],
      upstream(route, normalized, headers, secret) {
        seen.push(headers)
        const target = backend.upstream(route, normalized, headers, secret)
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
          'x-provider-state': 'not-declared-by-this-adapter',
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
        // Declared by another adapter or by none: this one does not, so they never reach it.
        'session-id': 'dropped',
        'x-other-session': 'dropped',
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
    expect(result.headers['x-provider-state']).toBeUndefined()
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
    const { gateway, store, egress, logger } = await setup(success)
    store.lookup.mockResolvedValueOnce(null)
    expect((await call(gateway)).status).toBe(401)
    // The route of another backend, asked with a client its adapter accepts: the key is what
    // is refused.
    const foreign = await call(gateway, {
      path: otherRoute,
      headers: { 'user-agent': otherUserAgent },
    })
    expect(foreign.status).toBe(403)
    expect(JSON.parse(foreign.body).error.code).toBe('raditi_backend')
    const stranger = await call(gateway, { headers: { 'user-agent': 'wrong-cli' } })
    expect(stranger.status).toBe(403)
    expect(JSON.parse(stranger.body).error.code).toBe('raditi_client')
    const logged = () => JSON.parse(logger.log.mock.calls.at(-1)![0] as string) as object
    store.admit.mockResolvedValueOnce({ kind: 'refused', reason: 'budget', keyId: key.keyId })
    expect((await call(gateway)).status).toBe(wire.budgetStatus)
    expect(store.refuse).toHaveBeenCalledWith(key.keyId, 'budget')
    expect(logged()).toMatchObject({ event: 'llm_refusal', status: wire.budgetStatus })
    expect(logged()).not.toHaveProperty('limit')
    // The answer and the journal say `budget` for the money, the pace and the ceiling of a
    // key alike; which of them refused is in the log of the role alone.
    for (const limit of ['money', 'pace', 'calls'] as const) {
      store.admit.mockResolvedValueOnce({
        kind: 'refused',
        reason: 'budget',
        keyId: key.keyId,
        limit,
      })
      const refused = await call(gateway)
      expect(refused.status).toBe(wire.budgetStatus)
      expect(refused.body).not.toContain(limit)
      expect(logged()).toMatchObject({ event: 'llm_refusal', status: wire.budgetStatus, limit })
    }
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
      `{"model":"${key.model}","${wire.conversation}":${'['.repeat(65)}null${']'.repeat(65)}}`,
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

  it('names a rejected field without its indices in the refusal and in full in the log', async () => {
    // An adapter the gateway has never heard of, which numbers the items of its path. A number
    // in the body of a refusal is what a CLI may read as a status worth a retry.
    const adapter: LlmBackend = {
      ...backend,
      normalizeBody() {
        throw badRequest('Request body violates policy', {
          path: 'messages[502].content[3].text',
        })
      },
    }
    const { gateway, store, logger } = await setup(success, {}, { backends: [adapter] })
    const result = await call(gateway)
    expect(result.status).toBe(400)
    expect(JSON.parse(result.body).error.field).toBe('messages[].content[].text')
    expect(result.body).not.toContain('502')
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'policy')
    expect(JSON.parse(logger.log.mock.calls.at(-1)![0] as string)).toMatchObject({
      event: 'llm_refusal',
      field: 'messages[502].content[3].text',
    })
  })

  it.each([
    // The number of an item lies across the 64 characters a path is cut to.
    [
      `messages[1].content[2].${'x'.repeat(37)}[429].text`,
      `messages[].content[].${'x'.repeat(37)}[].tex`,
    ],
    // The cut falls inside the brackets the number was taken out of.
    [`messages[1].${'x'.repeat(52)}[503].text`, `messages[].${'x'.repeat(52)}`],
    // A number that is no index of an item cannot be taken out: nothing of the path is echoed.
    ['messages.502.content', 'unknown'],
    ['input_429.text', 'unknown'],
    ['messages[1].content[2x].text', 'unknown'],
  ])('never echoes a digit of the rejected path %s to the sandbox', async (path, field) => {
    const adapter: LlmBackend = {
      ...backend,
      normalizeBody() {
        throw badRequest('Request body violates policy', { path })
      },
    }
    const { gateway, logger } = await setup(success, {}, { backends: [adapter] })
    const result = await call(gateway)
    expect(result.status).toBe(400)
    expect(JSON.parse(result.body).error.field).toBe(field)
    expect(field.length).toBeLessThanOrEqual(64)
    // No digit anywhere in the answer: a CLI may read one as a status worth a retry.
    expect(result.body).not.toMatch(/\d/)
    expect(JSON.parse(logger.log.mock.calls.at(-1)![0] as string)).toMatchObject({
      event: 'llm_refusal',
      field: path.slice(0, 64),
    })
  })

  it('does not pass off a crash of the body normalizer as a policy violation', async () => {
    const { gateway, store, egress, logger } = await setup(success)
    const normalize = vi.spyOn(backend, 'normalizeBody').mockImplementationOnce(() => {
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
        JSON.stringify({ event: 'llm_body_normalization_failed', backend: backend.id }),
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

  it('refreshes an old window snapshot once before the first call of a key, whatever comes of it', async () => {
    const lifecycle = controlLifecycle()
    const { gateway, store, egress } = await setup(success, {}, { lifecycle })
    // A key that has started a call, or whose account was seen lately: nothing to refresh.
    expect((await call(gateway)).status).toBe(200)
    expect(lifecycle.refreshAccount).not.toHaveBeenCalled()
    store.lookup.mockResolvedValue({ ...key, staleWindows: true })
    expect((await call(gateway)).status).toBe(200)
    expect(lifecycle.refreshAccount).toHaveBeenCalledExactlyOnceWith(key.accountId)
    expect(lifecycle.refreshAccount.mock.invocationCallOrder[0]).toBeLessThan(
      store.admit.mock.invocationCallOrder[1]!,
    )
    // An old snapshot closes nothing by itself, and a refresh that failed changes nothing.
    lifecycle.refreshAccount.mockRejectedValueOnce(new Error('synthetic probe failure'))
    expect((await call(gateway)).status).toBe(200)
    expect(lifecycle.refreshAccount).toHaveBeenCalledTimes(2)
    expect(store.refuse).not.toHaveBeenCalled()
    expect(egress.request).toHaveBeenCalledTimes(3)
    // A paused account is refused before anything is asked of the provider.
    lifecycle.pause.mockReturnValue({ reason: 'transient', retryAfterMs: 1000 })
    expect((await call(gateway)).status).toBe(503)
    expect(lifecycle.refreshAccount).toHaveBeenCalledTimes(2)
  })

  it('asks no refresh for a backend without windows, and tells admission what the backend is', async () => {
    const lifecycle = controlLifecycle()
    // The sample backend as one without windows would declare itself (LlmBackend.capacity).
    const windowless: LlmBackend = { ...zaiCodingBackend, capacity: 'none' }
    const { gateway, store } = await setup(
      success,
      {},
      { lifecycle, backends: [windowless, otherBackend] },
    )
    store.lookup.mockResolvedValue({ ...key, staleWindows: true })
    expect((await call(gateway)).status).toBe(200)
    expect(lifecycle.refreshAccount).not.toHaveBeenCalled()
    expect(store.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ backendId: key.backendId, capacity: 'none' }),
    )
    const windowed = await setup(success, {}, { lifecycle: controlLifecycle() })
    expect((await call(windowed.gateway)).status).toBe(200)
    expect(windowed.store.admit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ capacity: 'windows' }),
    )
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
      res.end(JSON.stringify(wire.busy))
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
          res.end(JSON.stringify(wire.rejected.http))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(wire.rejected.stream)
        }
      })
      const result = await call(gateway)
      // Final for the CLI either way: a 400, or a stream code it ends the turn on.
      if (kind === 'http') {
        expect(result.status).toBe(400)
        expect(result.headers['retry-after']).toBeUndefined()
        expect(JSON.parse(result.body).error.code).toBe('raditi_request_rejected')
      } else expect(result.body).toContain(wire.rejected.seen)
      expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'request_rejected')
      await vi.waitFor(() => expect(store.finish).toHaveBeenCalledOnce())
      expect(store.finish.mock.calls[0]![1]).toMatchObject({
        state: 'failed',
        signal: { kind: 'request_rejected', code: wire.rejected.code },
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
          // Short-lived for either adapter by its status, whatever the body names.
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'server_is_overloaded' } }))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(delta + wire.overloaded)
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
          path: wire.path,
          method: 'POST',
          agent: false,
          headers: {
            host: 'llm.local',
            authorization: `Bearer ${turnKey}`,
            'content-type': 'application/json',
            'user-agent': wire.userAgent,
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

  it('scrubs a provider failure inside a started stream, keeps its refusal and estimates the call at the cost of the platform', async () => {
    const { gateway, store } = await setup((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        delta +
          event({
            id: 'private-response-id',
            error: { code: '1301', message: 'private account and prompt' },
          }),
      )
    })
    const result = await call(gateway)
    expect(result.status).toBe(200)
    expect(result.body).toContain('"code":"raditi_policy_flagged"')
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
            ? wire.usage(1, 2, 3)
            : wire.usage(2_147_483_648, undefined, 3)
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
      res.end(delta + completed(index++ === 0 ? null : wire.usage(1, 2)))
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
        path: wire.path,
        method: 'POST',
        agent: false,
        headers: {
          host: 'llm.local',
          authorization: `Bearer ${turnKey}`,
          'content-type': 'application/json',
          'user-agent': wire.userAgent,
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
      path: wire.path,
      method: 'POST',
      agent: false,
      headers: {
        host: 'llm.local',
        authorization: `Bearer ${turnKey}`,
        'content-type': 'application/json',
        'user-agent': wire.userAgent,
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
        path: wire.path,
        method: 'POST',
        agent: false,
        headers: {
          host: 'llm.local',
          authorization: `Bearer ${turnKey}`,
          'content-type': 'application/json',
          'user-agent': wire.userAgent,
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
    const hugeDelta = wire.text('x'.repeat(512 * 1024))
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
        path: wire.path,
        method: 'POST',
        agent: false,
        headers: {
          host: 'llm.local',
          authorization: `Bearer ${turnKey}`,
          'content-type': 'application/json',
          'user-agent': wire.userAgent,
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
  const userAgent = zaiUserAgent
  async function zai(
    stream: string,
    backend: LlmBackend = zaiCodingBackend,
    // `cut`: the provider's connection breaks after the stream's bytes, without an HTTP end.
    ending: 'end' | 'cut' = 'end',
    // An answer with an error status instead of the stream.
    refusal?: { status: number; body: unknown },
  ) {
    const provider: { headers: IncomingMessage['headers']; body: string }[] = []
    const stand = await setup(
      (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (part: Buffer) => chunks.push(part))
        req.on('end', () => {
          provider.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
          if (refusal) {
            res.writeHead(refusal.status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(refusal.body))
            return
          }
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
    stand.store.lookup.mockResolvedValue(key)
    stand.store.admit.mockImplementation(async (input) => ({
      kind: 'admitted',
      call: { ...makeCall(input.estimatedInputTokens), ...key },
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
    const { send, provider, persisted, store, logger } = await zai(
      chunk('abcdef') + chunk('', 'stop') + done,
    )
    const result = await send()
    expect(result.status).toBe(200)
    // The key of the turn is looked up by its hash and the address of its sender, and the call
    // is admitted under the profile of that key.
    expect(store.lookup).toHaveBeenCalledWith(
      createHash('sha256').update(turnKey).digest('hex'),
      '127.0.0.1',
    )
    expect(store.admit.mock.calls[0]![0]).toMatchObject({ profile: key, backendId: key.backendId })
    expect(events(result.body).at(-1)).toBe('[DONE]')
    expect(result.body).toContain('"finish_reason":"stop"')
    // None of the provider's own headers reaches the sandbox, each one checked by itself.
    for (const name of ['set-cookie', 'x-log-id', 'x-request-id'])
      expect(result.headers[name], name).toBeUndefined()
    // Nor does the pause it names on a successful answer: the pinned CLI would obey it.
    expect(result.headers['retry-after']).toBeUndefined()
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
      billable: true,
      estimateReason: null,
      usage: { input: 19, cacheRead: 3, cacheWrite: 0, output: 6, reasoning: 2 },
    })
    expect(store.refuse).not.toHaveBeenCalled()
    // Neither key is in what the role logs of the call.
    const logged = JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls])
    expect(logged).not.toContain(turnKey)
    expect(logged).not.toContain(zaiCredential.apiKey)
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
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, refusal)
    const finish = await persisted
    expect(finish.state).toBe('failed')
    expect(finish.signal?.kind).toBe(refusal === 'account' ? 'unconfirmed_block' : refusal)
  })

  /** The one `llm_call` line of a stand's log, once the call has been closed. */
  async function callLine(logger: { log: ReturnType<typeof vi.fn> }) {
    const lines = () =>
      logger.log.mock.calls
        .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
        .filter((line) => line.event === 'llm_call')
    await vi.waitFor(() => expect(lines()).toHaveLength(1))
    return lines()[0]!
  }

  it.each([
    ['an error status with a code nobody has listed', 429, '1399', 'unconfirmed_block', 'zai_1399'],
    ['a model the plan lacks', 400, '1211', 'profile', 'zai_1211'],
    ['an account the provider holds back', 429, '1113', 'account_risk', 'zai_1113'],
  ] as const)(
    'writes the signal of %s into the call line of the log, by its code alone',
    async (_name, status, code, kind, logged) => {
      const { send, logger, persisted } = await zai('', zaiCodingBackend, 'end', {
        status,
        body: { error: { code, message: 'private provider text' } },
      })
      expect((await send()).status).toBeGreaterThanOrEqual(400)
      await persisted
      expect(await callLine(logger)).toMatchObject({
        event: 'llm_call',
        backend: 'zai-coding',
        status,
        signal: kind,
        code: logged,
      })
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private provider text')
    },
  )

  it('names the signal of a refusal inside the stream and nothing for a finished answer', async () => {
    const unseen = await zai(chunk('abcdef') + chunk('', 'later_value') + done)
    await unseen.send()
    expect(await callLine(unseen.logger)).toMatchObject({
      status: 200,
      signal: 'unconfirmed_block',
      code: 'zai_finish_reason',
    })
    const finished = await zai(chunk('abcdef') + chunk('', 'stop') + done)
    await finished.send()
    const line = await callLine(finished.logger)
    expect(line).not.toHaveProperty('signal')
    expect(line).not.toHaveProperty('code')
  })

  it('never logs a signal code outside the allowlisted form', async () => {
    // An adapter that broke its contract and put provider text where its own code belongs.
    const leaking: LlmBackend = {
      ...zaiCodingBackend,
      classify: () => ({ kind: 'unconfirmed_block', code: 'provider said: "private text"' }),
    }
    const { send, logger, persisted } = await zai('', leaking, 'end', {
      status: 429,
      body: { error: { code: '1399' } },
    })
    await send()
    await persisted
    const line = await callLine(logger)
    expect(line).toMatchObject({ event: 'llm_call', status: 429, signal: 'invalid' })
    expect(line).not.toHaveProperty('code')
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private text')
    // The store refuses to record such an outcome; that is its own check, kept here as a fact.
    expect(unstorable.splice(0)).toHaveLength(1)
  })

  it('leaves an unfinished stream of an adapter without an end rule to the cut connection', async () => {
    const withoutEnd: LlmBackend = {
      ...zaiCodingBackend,
      streamInspector: () => ({ inspect: zaiCodingBackend.streamInspector().inspect }),
    }
    const { send, persisted, store } = await zai(chunk('abcdef'), withoutEnd)
    await expect(send()).rejects.toThrow()
    expect(store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
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
    expect(broken.store.refuse).toHaveBeenCalledExactlyOnceWith(key.keyId, 'transient')
    expect(end).not.toHaveBeenCalled()
    // Finished, yet without DONE: asked once, and its null leaves the ending as it was.
    const { send, persisted } = await zai(chunk('abcdef') + chunk('', 'stop'), counting)
    expect((await send()).status).toBe(200)
    expect((await persisted).state).toBe('completed')
    expect(end).toHaveBeenCalledOnce()
  })
})
