import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

import type { EgressRequest, LlmBackend } from '@repo/domain'
import { codexBackend } from '@repo/llm-backends'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { llmConfigFromEnv } from '../config/llm-config.ts'
import { createLlmTestCertificates } from '../testing/llm-certificates.ts'
import { createControlEgress, createEgressTransport, EgressNotSentError } from './egress.ts'
import { EgressNotDelivered } from './types.ts'

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
        'x-codex-turn-state': 'state',
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
      LLM_BACKEND_URL_OPENAI_CHATGPT: `https://localhost:${providerPort}`,
    },
    'test',
  ).egress!
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

const input = (changes: Partial<EgressRequest> = {}): EgressRequest => ({
  url: 'https://chatgpt.com/backend-api/codex/responses',
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
        const url =
          method === 'POST'
            ? 'https://chatgpt.com/backend-api/codex/responses'
            : 'https://chatgpt.com/backend-api/wham/usage'
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
        expect(response.headers.get('x-codex-turn-state')).toBe('state')
        expect(response.rawHeaders).toContain('x-codex-turn-state')
      }
      expect(f.tunnels).toEqual([`localhost:${f.providerPort}`, `localhost:${f.providerPort}`])
      expect(f.requests).toEqual(
        ['/backend-api/codex/responses', '/backend-api/wham/usage'].map((path) => ({
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

  it('rejects disabled egress, foreign origins and credential-bearing URLs before a connection', async () => {
    await expect(
      createEgressTransport(null).request(input(), { signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow(/^Subscription egress unavailable$/)
    const f = await fixture()
    try {
      const transport = createEgressTransport(f.config)
      for (const url of [
        'https://private.example/secret',
        'https://secret:token@chatgpt.com/',
        'https://chatgpt.com/?secret=token',
        'https://chatgpt.com/arbitrary',
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
        ...codexBackend,
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
      ).egress!
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
        input({ url: 'https://chatgpt.com/backend-api/codex/responses' }),
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
      const answer = await createEgressTransport(response.config).request(input(), {
        signal: AbortSignal.timeout(150),
      })
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
    expect(await notSent(createEgressTransport(null).request(input(), { signal: signal() }))).toBe(
      true,
    )
    const refused = await fixture({ proxyStatus: 403 })
    try {
      const transport = createEgressTransport(refused.config)
      expect(
        await notSent(
          transport.request(input({ url: 'https://chatgpt.com/x' }), { signal: signal() }),
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
