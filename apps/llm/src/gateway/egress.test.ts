import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { connect, createServer as createTcpServer } from 'node:net'
import type { Duplex } from 'node:stream'

import type { EgressRequest, LlmBackend } from '@repo/domain'
import { llmBackends, zaiCodingBackend } from '@repo/llm-backends'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { llmConfigFromEnv, type EgressConfig } from '../llm-config.ts'
import { createLlmTestCertificates } from '../testing/llm-certificates.ts'
import {
  createControlEgress,
  createEgressTransport,
  EgressNotDelivered,
  EgressNotSentError,
} from './egress.ts'

let certificates: ReturnType<typeof createLlmTestCertificates>
let certFile: string
let keyFile: string
let otherCertFile: string
let otherKeyFile: string

beforeAll(() => {
  certificates = createLlmTestCertificates()
  ;({ certFile, keyFile, otherCertFile, otherKeyFile } = certificates)
})
afterAll(() => certificates?.close())

async function listen(server: HttpsServer, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return (server.address() as AddressInfo).port
}

async function fixture({
  proxyStatus = 200,
  stallConnect = false,
  stallTls = false,
  stallBody = false,
  stallResponse = false,
  redirect = false,
  bytes = 0,
  proxyHost = '127.0.0.1',
} = {}) {
  const cert = readFileSync(certFile)
  const key = readFileSync(keyFile)
  const sockets = new Set<Duplex>()
  const requests: { path: string; body: string; host: string | undefined }[] = []
  const tunnels: string[] = []
  const provider = createHttpsServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        path: req.url!,
        body: Buffer.concat(chunks).toString(),
        host: req.headers.host,
      })
      if (stallResponse) return
      res.writeHead(redirect ? 302 : 200, {
        'content-type': 'text/event-stream',
        'x-synthetic-state': 'state',
        ...(redirect ? { location: 'https://private.example/secret' } : {}),
      })
      if (stallBody) {
        res.write('data: first\n\n')
        return
      }
      res.write(bytes ? Buffer.alloc(bytes, 65) : 'data: first\n\n')
      res.end(bytes ? undefined : 'data: second\n\n')
    })
  })
  const providerPort = await listen(provider)
  const proxy = createHttpsServer({
    cert,
    key,
    requestCert: true,
    rejectUnauthorized: true,
    ca: cert,
  })
  proxy.on('tlsClientError', () => {})
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url!)
    sockets.add(socket)
    if (stallConnect) return
    if (proxyStatus !== 200) {
      socket.end(`HTTP/1.1 ${proxyStatus} Refused\r\ncontent-length: 0\r\n\r\n`)
      return
    }
    if (stallTls) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      return
    }
    const destination = connect(providerPort, '127.0.0.1')
    sockets.add(destination)
    destination.on('error', () => socket.destroy())
    socket.on('error', () => destination.destroy())
    destination.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) destination.write(head)
      socket.pipe(destination).pipe(socket)
    })
  })
  for (const server of [proxy, provider]) server.on('connection', (socket) => sockets.add(socket))
  const proxyPort = await listen(proxy, proxyHost)
  const config = llmConfigFromEnv(
    {
      LLM_EGRESS_PROXY_URL: `https://${proxyHost === '::1' ? '[::1]' : proxyHost}:${proxyPort}`,
      LLM_EGRESS_CA_FILE: certFile,
      LLM_EGRESS_CLIENT_CERT_FILE: certFile,
      LLM_EGRESS_CLIENT_KEY_FILE: keyFile,
      LLM_UPSTREAM_CA_FILE: certFile,
      LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${providerPort}`,
    },
    'test',
  ).egress
  if (config.proxyUrl === null) throw new Error('The fixture configures a proxy')
  return {
    config,
    tunnels,
    requests,
    providerPort,
    async close() {
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [proxy, provider].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      )
    },
  }
}

/**
 * A role with no egress node: it connects itself, and only where an adapter allows it. Every
 * origin of the real adapters points at a closed loopback port, so a transport that lost that
 * rule fails here and never reaches a provider from a test run.
 */
const withoutProxy: EgressConfig = {
  proxyUrl: null,
  upstreamCaFile: null,
  backendOrigins: new Map(
    llmBackends.flatMap((backend) =>
      backend.egress.map((entry) => [entry.origin, 'https://localhost:1'] as const),
    ),
  ),
}

/** An adapter that says nothing of going without the node: an origin that needs the proxy. */
const behindNode: LlmBackend = {
  ...zaiCodingBackend,
  egress: [
    {
      origin: 'https://provider.invalid',
      overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
      requests: [
        'POST https://provider.invalid/v1/generate',
        'GET https://provider.invalid/v1/usage',
      ],
    },
  ],
}
const behindNodeUrl = 'https://provider.invalid/v1/generate'
const withoutProxyBehindNode: EgressConfig = {
  ...withoutProxy,
  backendOrigins: new Map([['https://provider.invalid', 'https://localhost:1']]),
}

const chatUrl = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const quotaUrl = 'https://api.z.ai/api/monitor/usage/quota/limit'
const input = (changes: Partial<EgressRequest> = {}): EgressRequest => ({
  url: chatUrl,
  method: 'POST',
  headers: new Headers({
    'content-type': 'application/json',
    authorization: 'Bearer synthetic-token',
  }),
  body: Buffer.from('{"synthetic":true}'),
  ...changes,
})

describe('mTLS subscription egress', () => {
  it('normalizes IPv6 proxy brackets before selecting the pinned TLS server name', async () => {
    const f = await fixture({ proxyHost: '::1' })
    try {
      const response = await createControlEgress(createEgressTransport(f.config)).request(input(), {
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(200)
      expect(f.tunnels).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('streams through CONNECT with provider TLS and trusted framing, including GET bodies', async () => {
    const f = await fixture()
    try {
      const transport = createEgressTransport(f.config)
      for (const method of ['POST', 'GET'] as const) {
        const url = method === 'POST' ? chatUrl : quotaUrl
        const response = await transport.request(
          input({
            method,
            url,
            headers: new Headers({
              'content-length': '9000',
              'transfer-encoding': 'chunked',
              host: 'attacker',
            }),
          }),
          { signal: AbortSignal.timeout(2000) },
        )
        const chunks: Buffer[] = []
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
        expect(Buffer.concat(chunks).toString()).toBe('data: first\n\ndata: second\n\n')
        expect(response.headers.get('x-synthetic-state')).toBe('state')
        expect(response.rawHeaders).toContain('x-synthetic-state')
      }
      expect(f.tunnels).toEqual([`localhost:${f.providerPort}`, `localhost:${f.providerPort}`])
      expect(f.requests).toEqual(
        [new URL(chatUrl).pathname, new URL(quotaUrl).pathname].map((path) => ({
          path,
          body: '{"synthetic":true}',
          host: `localhost:${f.providerPort}`,
        })),
      )
    } finally {
      await f.close()
    }
  })

  it('uses built-in provider roots unless an explicit nonproduction fake CA was configured', async () => {
    const f = await fixture()
    try {
      await expect(
        createEgressTransport({ ...f.config, upstreamCaFile: null }).request(input(), {
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
      expect(f.tunnels).toHaveLength(1)
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('requires a client certificate trusted by the proxy', async () => {
    const f = await fixture()
    try {
      await expect(
        createEgressTransport({
          ...f.config,
          clientCertFile: otherCertFile,
          clientKeyFile: otherKeyFile,
        }).request(input(), { signal: AbortSignal.timeout(2000) }),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
      expect(f.tunnels).toHaveLength(0)
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('never bypasses a refusing proxy or follows a redirect', async () => {
    const refused = await fixture({ proxyStatus: 403 })
    try {
      await expect(
        createEgressTransport(refused.config).request(input(), {
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
      expect(refused.requests).toHaveLength(0)
    } finally {
      await refused.close()
    }
    const redirect = await fixture({ redirect: true })
    try {
      // The provider's answer, like any other HTTP error: nothing was generated and nothing
      // is followed. The gateway refuses it without a usage estimate.
      const answer = await createEgressTransport(redirect.config).request(input(), {
        signal: AbortSignal.timeout(2000),
      })
      expect(answer.status).toBe(302)
      answer.close()
      expect(redirect.requests).toHaveLength(1)
      expect(redirect.tunnels).toHaveLength(1)
    } finally {
      await redirect.close()
    }
  })

  it('rejects an origin that needs the absent proxy, foreign origins and credential-bearing URLs before a connection', async () => {
    // A closed port ends in the same error: what tells the rule from it is that no connection
    // of the role's own was even tried.
    const tried: boolean[] = []
    await expect(
      createEgressTransport(withoutProxyBehindNode, [behindNode], {
        onDirectConnection: (established) => tried.push(established),
      }).request(input({ url: behindNodeUrl }), { signal: AbortSignal.timeout(2000) }),
    ).rejects.toBeInstanceOf(EgressNotSentError)
    expect(tried).toEqual([])
    const f = await fixture()
    try {
      const transport = createEgressTransport(f.config)
      for (const url of [
        'https://private.example/secret',
        'https://secret:token@api.z.ai/',
        'https://api.z.ai/?secret=token',
        'https://api.z.ai/arbitrary',
      ])
        await expect(
          transport.request(input({ url }), { signal: AbortSignal.timeout(2000) }),
        ).rejects.toThrow(/^Subscription egress unavailable$/)
      expect(f.tunnels).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('sends exactly the requests its adapters declare; any other is never sent', async () => {
    const f = await fixture()
    try {
      // An adapter the transport has never heard of: its declaration alone opens the way.
      const adapter: LlmBackend = {
        ...zaiCodingBackend,
        egress: [
          {
            origin: 'https://provider.invalid',
            overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
            requests: ['POST https://provider.invalid/v1/declared'],
          },
        ],
      }
      const config = llmConfigFromEnv(
        {
          LLM_EGRESS_PROXY_URL: f.config.proxyUrl.origin,
          LLM_EGRESS_CA_FILE: certFile,
          LLM_EGRESS_CLIENT_CERT_FILE: certFile,
          LLM_EGRESS_CLIENT_KEY_FILE: keyFile,
          LLM_UPSTREAM_CA_FILE: certFile,
          LLM_BACKEND_URL_SYNTHETIC: `https://localhost:${f.providerPort}`,
        },
        'test',
        [adapter],
      ).egress
      const transport = createEgressTransport(config, [adapter])
      const signal = () => AbortSignal.timeout(2000)
      const answer = await transport.request(
        input({ url: 'https://provider.invalid/v1/declared' }),
        { signal: signal() },
      )
      expect(answer.status).toBe(200)
      answer.close()
      expect(f.requests.map((request) => request.path)).toEqual(['/v1/declared'])
      for (const undeclared of [
        input({ url: 'https://provider.invalid/v1/other' }),
        input({ url: 'https://provider.invalid/v1/declared', method: 'GET' }),
        input({ url: 'https://provider.invalid/v1/declared/' }),
        // Declared by the real adapters only, which this transport was not given.
        input(),
      ])
        await expect(transport.request(undeclared, { signal: signal() })).rejects.toBeInstanceOf(
          EgressNotSentError,
        )
      expect(f.tunnels).toHaveLength(1)
      // The default transport knows the real adapters and nothing of this one.
      await expect(
        createEgressTransport(config).request(
          input({ url: 'https://provider.invalid/v1/declared' }),
          { signal: signal() },
        ),
      ).rejects.toBeInstanceOf(EgressNotSentError)
      expect(f.tunnels).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it('aborts a stalled CONNECT handshake and a stalled provider response body', async () => {
    const stalled = await fixture({ stallConnect: true })
    try {
      await expect(
        createEgressTransport(stalled.config).request(input(), {
          signal: AbortSignal.timeout(100),
        }),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
    } finally {
      await stalled.close()
    }
    const tls = await fixture({ stallTls: true })
    try {
      await expect(
        createEgressTransport(tls.config).request(input(), { signal: AbortSignal.timeout(100) }),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
    } finally {
      await tls.close()
    }
    const response = await fixture({ stallBody: true })
    try {
      // The abort comes once the answer has started, whatever the pace of the machine: a
      // deadline counted from the request would at times pass before the answer under load.
      const controller = new AbortController()
      const answer = await createEgressTransport(response.config).request(input(), {
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 50)
      await expect(
        (async () => {
          for await (const _chunk of answer.body) {
            /* Drain until the abort. */
          }
        })(),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
    } finally {
      await response.close()
    }
  })

  it('separates provably unsent requests from requests whose answer was lost', async () => {
    const notSent = async (promise: Promise<unknown>) => {
      const error: unknown = await promise.then(
        () => null,
        (reason: unknown) => reason,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Subscription egress unavailable')
      // The generation path reads the same fact: an unsent request spent no provider quota.
      expect(error instanceof EgressNotDelivered).toBe(error instanceof EgressNotSentError)
      return error instanceof EgressNotSentError
    }
    const signal = () => AbortSignal.timeout(2000)
    // Refused by the rule, before any connection of the role's own.
    const tried: boolean[] = []
    expect(
      await notSent(
        createEgressTransport(withoutProxyBehindNode, [behindNode], {
          onDirectConnection: (established) => tried.push(established),
        }).request(input({ url: behindNodeUrl }), { signal: signal() }),
      ),
    ).toBe(true)
    expect(tried).toEqual([])
    const refused = await fixture({ proxyStatus: 403 })
    try {
      const transport = createEgressTransport(refused.config)
      expect(
        await notSent(
          transport.request(input({ url: 'https://api.z.ai/x' }), { signal: signal() }),
        ),
      ).toBe(true)
      expect(
        await notSent(createControlEgress(transport).request(input(), { signal: signal() })),
      ).toBe(true)
      const aborted = new AbortController()
      aborted.abort()
      expect(await notSent(transport.request(input(), { signal: aborted.signal }))).toBe(true)
    } finally {
      await refused.close()
    }
    for (const stall of [{ stallConnect: true }, { stallTls: true }]) {
      const stalled = await fixture(stall)
      try {
        expect(
          await notSent(
            createEgressTransport(stalled.config).request(input(), {
              signal: AbortSignal.timeout(100),
            }),
          ),
        ).toBe(true)
      } finally {
        await stalled.close()
      }
    }
    const lost = await fixture({ stallResponse: true })
    try {
      expect(
        await notSent(
          createControlEgress(createEgressTransport(lost.config)).request(input(), {
            signal: AbortSignal.timeout(300),
          }),
        ),
      ).toBe(false)
      expect(lost.requests).toHaveLength(1)
    } finally {
      await lost.close()
    }
    const redirect = await fixture({ redirect: true })
    try {
      // A control call keeps rejecting a redirect, as a request that was sent.
      expect(
        await notSent(
          createControlEgress(createEgressTransport(redirect.config)).request(input(), {
            signal: signal(),
          }),
        ),
      ).toBe(false)
      expect(redirect.requests).toHaveLength(1)
    } finally {
      await redirect.close()
    }
  })

  it('reports a provider TLS session that could not even be started as a request never sent', async () => {
    const f = await fixture()
    try {
      // TLS takes no IP address for a server name: Node refuses it before any handshake. The
      // configuration accepts no such override; a transport handed one still says the truth.
      const config = {
        ...f.config,
        backendOrigins: new Map([['https://api.z.ai', `https://127.0.0.1:${f.providerPort}`]]),
      }
      const started = Date.now()
      await expect(
        createEgressTransport(config).request(input(), { signal: AbortSignal.timeout(5000) }),
      ).rejects.toBeInstanceOf(EgressNotSentError)
      // At once, not when the caller gives up: the tunnel is closed and nothing is left hanging.
      expect(Date.now() - started).toBeLessThan(2000)
      expect(f.tunnels).toHaveLength(1)
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('bounds buffered control responses to 64 KiB', async () => {
    const f = await fixture({ bytes: 65_537 })
    try {
      await expect(
        createControlEgress(createEgressTransport(f.config)).request(input(), {
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow(/^Subscription egress unavailable$/)
    } finally {
      await f.close()
    }
  })
})

describe('subscription egress without a proxy', () => {
  const chat = chatUrl
  const quota = quotaUrl
  // The adapter of the platform next to one whose origin needs the node.
  const adapters = [zaiCodingBackend, behindNode]
  const needsNodeUrl = behindNodeUrl

  /** The provider alone, under the loopback name a stand gives it; no proxy exists. */
  async function direct({ stallResponse = false, redirect = false } = {}) {
    const sockets = new Set<Socket>()
    const requests: { method: string; path: string; body: string; headers: object }[] = []
    const provider = createHttpsServer(
      { cert: readFileSync(certFile), key: readFileSync(keyFile) },
      (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          requests.push({
            method: req.method!,
            path: req.url!,
            body: Buffer.concat(chunks).toString(),
            headers: req.headers,
          })
          if (stallResponse) return
          res.writeHead(redirect ? 302 : 200, {
            'content-type': 'text/event-stream',
            ...(redirect ? { location: 'https://private.example/secret' } : {}),
          })
          res.write('data: first\n\n')
          res.end('data: second\n\n')
        })
      },
    )
    // Every TCP connection, also one that never becomes a TLS session.
    let connections = 0
    provider.on('connection', (socket: Socket) => {
      connections += 1
      sockets.add(socket)
    })
    const port = await listen(provider)
    const config = llmConfigFromEnv(
      {
        LLM_UPSTREAM_CA_FILE: certFile,
        LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${port}`,
        // Pointed at the same fake: only the adapter's own word could let a request through.
        LLM_BACKEND_URL_SYNTHETIC: `https://localhost:${port}`,
      },
      'test',
      adapters,
    ).egress
    return {
      config,
      requests,
      port,
      connections: () => connections,
      async close() {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        )
      },
    }
  }
  const signal = () => AbortSignal.timeout(2000)
  const notSent = async (promise: Promise<unknown>) => {
    const error: unknown = await promise.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Subscription egress unavailable')
    return error instanceof EgressNotSentError
  }

  it('connects itself to an origin whose adapter allows it, with provider TLS and trusted framing', async () => {
    const f = await direct()
    try {
      expect(f.config.proxyUrl).toBeNull()
      const transport = createEgressTransport(f.config)
      for (const [method, url] of [
        ['POST', chat],
        ['GET', quota],
      ] as const) {
        const response = await transport.request(
          input({
            method,
            url,
            headers: new Headers({
              authorization: 'Bearer synthetic-plan-key',
              'content-length': '9000',
              'transfer-encoding': 'chunked',
              host: 'attacker',
              'proxy-authorization': 'Basic c2VjcmV0',
            }),
          }),
          { signal: signal() },
        )
        const chunks: Buffer[] = []
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
        expect(response.status).toBe(200)
        expect(Buffer.concat(chunks).toString()).toBe('data: first\n\ndata: second\n\n')
      }
      expect(f.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        {
          method: 'POST',
          path: '/api/coding/paas/v4/chat/completions',
          body: '{"synthetic":true}',
        },
        { method: 'GET', path: '/api/monitor/usage/quota/limit', body: '{"synthetic":true}' },
      ])
      for (const request of f.requests)
        expect(request.headers).toMatchObject({
          host: `localhost:${f.port}`,
          authorization: 'Bearer synthetic-plan-key',
          'content-length': '18',
        })
      expect(JSON.stringify(f.requests)).not.toMatch(/attacker|chunked|c2VjcmV0/)
    } finally {
      await f.close()
    }
  })

  it('never connects to an origin whose adapter says nothing of going without the node', async () => {
    const f = await direct()
    try {
      const transport = createEgressTransport(f.config, adapters)
      expect(
        await notSent(transport.request(input({ url: needsNodeUrl }), { signal: signal() })),
      ).toBe(true)
      // Nor does a control call, which a login or a probe would make.
      expect(
        await notSent(
          createControlEgress(transport).request(
            input({ method: 'GET', url: 'https://provider.invalid/v1/usage' }),
            { signal: signal() },
          ),
        ),
      ).toBe(true)
      expect(f.connections()).toBe(0)
      // The adapter's word alone opens the way: the same origin, declared direct.
      const allowed: LlmBackend = {
        ...behindNode,
        egress: behindNode.egress.map((entry) => ({ ...entry, direct: true })),
      }
      const answer = await createEgressTransport(f.config, [allowed]).request(
        input({ url: needsNodeUrl }),
        { signal: signal() },
      )
      expect(answer.status).toBe(200)
      answer.close()
      expect(f.requests.map((request) => request.path)).toEqual(['/v1/generate'])
    } finally {
      await f.close()
    }
  })

  it('refuses to start when two adapters disagree on whether one origin needs the node', () => {
    // A declaration without `direct` says the node is needed. Read by origin, it would be sent
    // without the node as soon as another adapter said otherwise of the same origin.
    const needsNode: LlmBackend = {
      ...zaiCodingBackend,
      egress: [
        {
          origin: 'https://api.z.ai',
          overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
          requests: ['POST https://api.z.ai/api/paas/v4/chat/completions'],
        },
      ],
    }
    expect(() => createEgressTransport(withoutProxy, [zaiCodingBackend, needsNode])).toThrow(
      /^LLM backends disagree on the egress node for https:\/\/api\.z\.ai$/,
    )
    expect(() => createEgressTransport(withoutProxy, [needsNode, zaiCodingBackend])).toThrow(
      /disagree/,
    )
    // Adapters that say the same of an origin share it.
    const agrees = { ...needsNode, egress: [{ ...needsNode.egress[0]!, direct: true }] }
    expect(() => createEgressTransport(withoutProxy, [zaiCodingBackend, agrees])).not.toThrow()
    expect(() => createEgressTransport(withoutProxy, [needsNode, behindNode])).not.toThrow()
  })

  it('reports a connection that could not even be started as a request never sent', async () => {
    // The role's own connection, under a server name TLS does not take: nothing was opened.
    const config: EgressConfig = {
      proxyUrl: null,
      upstreamCaFile: certFile,
      backendOrigins: new Map([['https://api.z.ai', 'https://127.0.0.1:1']]),
    }
    expect(
      await notSent(
        createEgressTransport(config).request(input({ url: chat }), { signal: signal() }),
      ),
    ).toBe(true)
  })

  it('sends exactly the requests the adapter declares, and nothing to any other host', async () => {
    const f = await direct()
    try {
      const transport = createEgressTransport(f.config, [zaiCodingBackend])
      for (const undeclared of [
        input({ url: 'https://api.z.ai/api/coding/paas/v4/models' }),
        input({ url: 'https://api.z.ai/api/paas/v4/chat/completions' }),
        input({ url: chat, method: 'GET' }),
        input({ url: quota }),
        input({ url: `${chat}/` }),
        input({ url: `${chat}?key=secret` }),
        input({ url: `${chat}#fragment` }),
        input({ url: chat.replace('https://', 'https://secret:token@') }),
        input({ url: chat.replace('api.z.ai', 'api.z.ai.example') }),
        input({ url: chat.replace('api.z.ai', 'api.z.ai:8443') }),
        input({ url: chat.replace('https://', 'http://') }),
        input({ url: `https://localhost:${f.port}/api/coding/paas/v4/chat/completions` }),
        input({ url: 'https://private.example/secret' }),
      ])
        expect(await notSent(transport.request(undeclared, { signal: signal() }))).toBe(true)
      expect(f.connections()).toBe(0)
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('trusts the built-in roots unless a nonproduction fake CA was configured', async () => {
    const f = await direct()
    try {
      // The fake's certificate is no certificate of the provider: the request is never written.
      expect(
        await notSent(
          createEgressTransport({ ...f.config, upstreamCaFile: null }).request(
            input({ url: chat }),
            { signal: signal() },
          ),
        ),
      ).toBe(true)
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('returns a redirect as the provider answer and never follows it', async () => {
    const f = await direct({ redirect: true })
    try {
      const answer = await createEgressTransport(f.config).request(input({ url: chat }), {
        signal: signal(),
      })
      expect(answer.status).toBe(302)
      answer.close()
      expect(f.requests).toHaveLength(1)
      expect(f.connections()).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('gives up a connection the provider does not complete, as a request never sent', async () => {
    // Accepts TCP and stays silent: neither a TLS answer nor a close.
    const sockets = new Set<Socket>()
    const silent = createTcpServer((socket) => sockets.add(socket))
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const port = (silent.address() as AddressInfo).port
    const config = llmConfigFromEnv(
      { LLM_UPSTREAM_CA_FILE: certFile, LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${port}` },
      'test',
    ).egress
    try {
      // Its own deadline, long before the caller's: a turn does not wait out the kernel's.
      const started = Date.now()
      expect(
        await notSent(
          createEgressTransport(config, [zaiCodingBackend], { connectTimeoutMs: 150 }).request(
            input({ url: chat }),
            { signal: AbortSignal.timeout(5000) },
          ),
        ),
      ).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      // The caller's abort during the handshake is the same fact.
      expect(
        await notSent(
          createEgressTransport(config).request(input({ url: chat }), {
            signal: AbortSignal.timeout(100),
          }),
        ),
      ).toBe(true)
      const aborted = new AbortController()
      aborted.abort()
      expect(
        await notSent(
          createEgressTransport(config).request(input({ url: chat }), { signal: aborted.signal }),
        ),
      ).toBe(true)
      // Nothing listens: refused at once.
      const closed = llmConfigFromEnv(
        { LLM_UPSTREAM_CA_FILE: certFile, LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:1' },
        'test',
      ).egress
      expect(
        await notSent(
          createEgressTransport(closed).request(input({ url: chat }), { signal: signal() }),
        ),
      ).toBe(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  it('tells its owner whether a connection of its own was opened, and nothing of other refusals', async () => {
    const f = await direct()
    const seen: boolean[] = []
    const options = { onDirectConnection: (established: boolean) => seen.push(established) }
    try {
      const transport = createEgressTransport(f.config, adapters, options)
      const answer = await transport.request(input({ url: chat }), { signal: signal() })
      answer.close()
      expect(seen).toEqual([true])
      // Refused before any connection, or given up by the caller: no word about the provider.
      expect(
        await notSent(transport.request(input({ url: needsNodeUrl }), { signal: signal() })),
      ).toBe(true)
      expect(
        await notSent(transport.request(input({ url: `${chat}/other` }), { signal: signal() })),
      ).toBe(true)
      const aborted = new AbortController()
      aborted.abort()
      expect(
        await notSent(transport.request(input({ url: chat }), { signal: aborted.signal })),
      ).toBe(true)
      expect(seen).toEqual([true])
      // Nothing listens there: the connection was never opened.
      const closed: EgressConfig = {
        ...f.config,
        backendOrigins: new Map([['https://api.z.ai', 'https://localhost:1']]),
      }
      expect(
        await notSent(
          createEgressTransport(closed, llmBackends, options).request(input({ url: chat }), {
            signal: signal(),
          }),
        ),
      ).toBe(true)
      expect(seen).toEqual([true, false])
    } finally {
      await f.close()
    }
    // An answer that was lost came over a connection that was opened.
    const lost = await direct({ stallResponse: true })
    try {
      seen.length = 0
      expect(
        await notSent(
          createEgressTransport(lost.config, llmBackends, options).request(input({ url: chat }), {
            signal: AbortSignal.timeout(300),
          }),
        ),
      ).toBe(false)
      expect(seen).toEqual([true])
    } finally {
      await lost.close()
    }
    // Through a proxy the channel has a probe of its own: nothing is told.
    const proxied = await fixture()
    try {
      seen.length = 0
      const answer = await createEgressTransport(proxied.config, llmBackends, options).request(
        input(),
        { signal: signal() },
      )
      answer.close()
      expect(seen).toEqual([])
    } finally {
      await proxied.close()
    }
  })

  it('reports a request whose answer was lost as possibly delivered', async () => {
    const f = await direct({ stallResponse: true })
    try {
      expect(
        await notSent(
          createControlEgress(createEgressTransport(f.config)).request(input({ url: chat }), {
            signal: AbortSignal.timeout(300),
          }),
        ),
      ).toBe(false)
      expect(f.requests).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
})
