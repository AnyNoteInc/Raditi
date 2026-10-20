import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { zaiCodingBackend } from '@repo/llm-backends'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { llmConfigFromEnv } from '../llm-config.ts'
import { createControlEgress, createEgressTransport } from '../gateway/egress.ts'
import { createLlmTestCertificates } from '../testing/llm-certificates.ts'
import { authenticateSubscription } from './key-import.ts'

let certificates: ReturnType<typeof createLlmTestCertificates>
beforeAll(() => {
  certificates = createLlmTestCertificates()
})
afterAll(() => certificates.close())

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}
async function fixture({ redirect = false, untrustedClient = false } = {}) {
  const cert = readFileSync(certificates.certFile)
  const key = readFileSync(certificates.keyFile)
  const sockets = new Set<Duplex>()
  const requests: string[] = []
  const provider = createServer({ cert, key }, (req, res) => {
    req.resume()
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`)
      if (redirect) {
        res.writeHead(302, { location: 'https://redirect.invalid/private-redirect' })
        res.end()
        return
      }
      let reply: object
      if (req.url === '/api/monitor/usage/quota/limit') {
        // The quota answer of an active plan, in the form of the recorded ones.
        const window = (unit: number, number: number, usage: number, resetInMs: number) => ({
          type: 'CREDIT_LIMIT',
          unit,
          number,
          usage,
          currentValue: 20,
          remaining: usage - 21,
          percentage: 1,
          nextResetTime: Date.now() + resetInMs,
        })
        reply = {
          code: 200,
          msg: 'Operation successful',
          success: true,
          data: {
            level: 'lite',
            limits: [window(3, 5, 2000, 3_600_000), window(6, 1, 10_000, 86_400_000)],
          },
        }
      } else reply = { code: 500, msg: '404 NOT_FOUND', success: false }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  const providerPort = await listen(provider)
  const proxy = createServer({ cert, key, requestCert: true, rejectUnauthorized: true, ca: cert })
  proxy.on('tlsClientError', () => undefined)
  proxy.on('connect', (_req, socket, head) => {
    sockets.add(socket)
    const target = connect(providerPort, '127.0.0.1')
    sockets.add(target)
    socket.on('error', () => target.destroy())
    target.on('error', () => socket.destroy())
    target.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target).pipe(socket)
    })
  })
  for (const server of [provider, proxy]) server.on('connection', (socket) => sockets.add(socket))
  const proxyPort = await listen(proxy)
  const config = llmConfigFromEnv(
    {
      LLM_EGRESS_PROXY_URL: `https://127.0.0.1:${proxyPort}`,
      LLM_EGRESS_CA_FILE: certificates.certFile,
      LLM_EGRESS_CLIENT_CERT_FILE: untrustedClient
        ? certificates.otherCertFile
        : certificates.certFile,
      LLM_EGRESS_CLIENT_KEY_FILE: untrustedClient
        ? certificates.otherKeyFile
        : certificates.keyFile,
      LLM_UPSTREAM_CA_FILE: certificates.certFile,
      LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${providerPort}`,
    },
    'test',
  )
  return {
    requests,
    http: createControlEgress(createEgressTransport(config.egress)),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [provider, proxy].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      )
    },
  }
}

describe('subscription login through an authenticated CONNECT tunnel', () => {
  it('validates a key through the probe endpoint of its backend without generation', async () => {
    const f = await fixture()
    try {
      const credential = await authenticateSubscription({
        backend: zaiCodingBackend,
        http: f.http,
        signal: AbortSignal.timeout(5000),
        readSecret: async () => 'synthetic-api-key',
      })
      expect(credential.kind).toBe('zai_api_key')
      expect(f.requests).toEqual(['GET /api/monitor/usage/quota/limit'])
    } finally {
      await f.close()
    }
  })
  it('rejects an untrusted client certificate before any provider request of a key import', async () => {
    const f = await fixture({ untrustedClient: true })
    try {
      await expect(
        authenticateSubscription({
          backend: zaiCodingBackend,
          http: f.http,
          signal: AbortSignal.timeout(3000),
          readSecret: async () => 'synthetic-api-key',
        }),
      ).rejects.toThrow(/^Subscription login failed$/)
      expect(f.requests).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('refuses a redirect of a key import without following it', async () => {
    const f = await fixture({ redirect: true })
    try {
      await expect(
        authenticateSubscription({
          backend: zaiCodingBackend,
          http: f.http,
          signal: AbortSignal.timeout(3000),
          readSecret: async () => 'synthetic-api-key',
        }),
      ).rejects.toThrow('Subscription login failed')
      expect(f.requests).toEqual(['GET /api/monitor/usage/quota/limit'])
    } finally {
      await f.close()
    }
  })
})
