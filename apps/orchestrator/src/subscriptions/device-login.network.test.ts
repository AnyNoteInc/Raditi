import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { codexBackend, kimiCodeBackend, zaiCodingBackend } from '@repo/llm-backends'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { llmConfigFromEnv } from '../config/llm-config.ts'
import { createControlEgress, createEgressTransport } from '../llm-gateway/egress.ts'
import { createLlmTestCertificates } from '../testing/llm-certificates.ts'
import { authenticateSubscription } from './device-login.ts'

let certificates: ReturnType<typeof createLlmTestCertificates>
beforeAll(() => {
  certificates = createLlmTestCertificates()
})
afterAll(() => certificates.close())
const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const identity = {
  installationId: 'synthetic-installation',
  deviceId: 'synthetic-device',
  deviceName: '4f9c2a7e1b3d',
}

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
        res.writeHead(302, { location: 'https://auth.openai.com/private-redirect' })
        res.end()
        return
      }
      let reply: object
      if (req.url === '/api/accounts/deviceauth/usercode')
        reply = {
          device_auth_id: 'synthetic-deviceauth',
          user_code: 'synthetic-usercode',
          interval: 1,
        }
      else if (req.url === '/api/accounts/deviceauth/token')
        reply = {
          authorization_code: 'synthetic-code',
          code_verifier: 'synthetic-verifier',
          code_challenge: 'synthetic-challenge',
        }
      else if (req.url === '/oauth/token') {
        const now = Math.floor(Date.now() / 1000)
        reply = {
          access_token: jwt({ iat: now, exp: now + 3600 }),
          refresh_token: 'synthetic-refresh',
          id_token: jwt({
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'synthetic-network-account',
              chatgpt_plan_type: 'plus',
            },
          }),
        }
      } else if (req.url === '/api/monitor/usage/quota/limit') {
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
      } else reply = { usages: { limit_5h: { used_ratio: 0.15 } } }
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
      LLM_BACKEND_URL_OPENAI_CHATGPT: `https://localhost:${providerPort}`,
      LLM_AUTH_URL_OPENAI: `https://localhost:${providerPort}`,
      LLM_BACKEND_URL_KIMI_CODE: `https://localhost:${providerPort}`,
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
  it('completes Codex device flow using all three allowed auth endpoints', async () => {
    const f = await fixture()
    try {
      const shown = vi.fn().mockResolvedValue(undefined)
      const credential = await authenticateSubscription({
        backend: codexBackend,
        identity,
        http: f.http,
        signal: AbortSignal.timeout(5000),
        showDeviceCode: shown,
        readSecret: async () => {
          throw new Error('unused')
        },
        wait: async () => undefined,
      })
      expect(credential.kind).toBe('chatgpt_oauth')
      expect(f.requests).toEqual([
        'POST /api/accounts/deviceauth/usercode',
        'POST /api/accounts/deviceauth/token',
        'POST /oauth/token',
      ])
      expect(shown).toHaveBeenCalledOnce()
    } finally {
      await f.close()
    }
  })
  it.each([
    ['Kimi', kimiCodeBackend, 'kimi_api_key', 'GET /coding/v1/usages'],
    ['Z.ai', zaiCodingBackend, 'zai_api_key', 'GET /api/monitor/usage/quota/limit'],
  ] as const)(
    'validates a %s key through its probe endpoint without generation',
    async (_, backend, kind, probe) => {
      const f = await fixture()
      try {
        const credential = await authenticateSubscription({
          backend,
          identity,
          http: f.http,
          signal: AbortSignal.timeout(5000),
          showDeviceCode: async () => {
            throw new Error('unused')
          },
          readSecret: async () => 'synthetic-api-key',
        })
        expect(credential.kind).toBe(kind)
        expect(f.requests).toEqual([probe])
      } finally {
        await f.close()
      }
    },
  )
  // The first request of each way in: the device flow of Codex, the key probe of Z.ai.
  const entries = [
    ['the device flow', codexBackend, 'POST /api/accounts/deviceauth/usercode'],
    ['a key import', zaiCodingBackend, 'GET /api/monitor/usage/quota/limit'],
  ] as const
  it.each(entries)(
    'rejects an untrusted client certificate before any provider request of %s',
    async (_, backend) => {
      const f = await fixture({ untrustedClient: true })
      try {
        await expect(
          authenticateSubscription({
            backend,
            identity,
            http: f.http,
            signal: AbortSignal.timeout(3000),
            showDeviceCode: async () => undefined,
            readSecret: async () => 'synthetic-api-key',
          }),
        ).rejects.toThrow(/^Subscription login failed$/)
        expect(f.requests).toEqual([])
      } finally {
        await f.close()
      }
    },
  )
  it.each(entries)('refuses a redirect of %s without following it', async (_, backend, first) => {
    const f = await fixture({ redirect: true })
    try {
      await expect(
        authenticateSubscription({
          backend,
          identity,
          http: f.http,
          signal: AbortSignal.timeout(3000),
          showDeviceCode: async () => undefined,
          readSecret: async () => 'synthetic-api-key',
        }),
      ).rejects.toThrow('Subscription login failed')
      expect(f.requests).toEqual([first])
    } finally {
      await f.close()
    }
  })
})
