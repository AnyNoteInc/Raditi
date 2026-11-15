import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkillSecretRead } from './skill-secrets.ts'
import { TokenRenewer } from './token-renewal.ts'
import { upstreamResolver } from './upstream.ts'

const SITE = '0199a000-0000-7000-8000-000000000001'
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function tokenEndpoint(answer: (form: URLSearchParams) => { status: number; body: unknown }) {
  const forms: URLSearchParams[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      forms.push(form)
      const { status, body } = answer(form)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://auth.example.com:${(server.address() as AddressInfo).port}/token`, forms }
}

function renewer(reads: (SkillSecretRead | null)[]) {
  const updates: unknown[] = []
  const writes: { data: Record<string, string>; cas: number | undefined }[] = []
  const locks: unknown[] = []
  const tx = {
    $executeRaw: vi.fn(async (...args: unknown[]) => void locks.push(args)),
    siteAgentSkill: { updateMany: vi.fn(async (args: unknown) => void updates.push(args)) },
  }
  const read = vi.fn<() => Promise<SkillSecretRead | null>>()
  for (const value of reads) read.mockResolvedValueOnce(value)
  const instance = new TokenRenewer({
    prisma: { $transaction: (async (work: (client: typeof tx) => unknown) => work(tx)) as never },
    secrets: { read, forget: vi.fn() },
    vault: {
      kvWrite: vi.fn(async (_path: string, data: Record<string, string>, options) => {
        writes.push({ data, cas: options?.cas })
        return { version: 7 }
      }),
    },
    resolve: upstreamResolver({
      refusedSubnets: [],
      allowLoopback: true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    now: () => new Date('2026-11-15T12:00:00Z'),
  })
  return { instance, updates, writes, locks }
}

const used: SkillSecretRead = {
  secret: { accessToken: 'old-access-token', refreshToken: 'refresh-token-1' },
  version: 3,
}

describe('TokenRenewer', () => {
  it('spends the refresh token under the lock and writes the new tokens by CAS with the expiry', async () => {
    const endpoint = await tokenEndpoint(() => ({
      status: 200,
      body: {
        access_token: 'new-access-token',
        refresh_token: 'refresh-token-2',
        expires_in: 3600,
      },
    }))
    const { instance, updates, writes, locks } = renewer([used])
    const oauth = {
      issuer: 'x',
      tokenEndpoint: endpoint.url,
      clientId: 'client-1',
      resource: 'https://mcp.example.com/mcp',
    }
    expect(await instance.renew(SITE, 'menu', oauth, used)).toEqual({
      secret: { accessToken: 'new-access-token', refreshToken: 'refresh-token-2' },
      version: 7,
    })
    expect(locks).toHaveLength(1)
    expect(Object.fromEntries(endpoint.forms[0]!)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token-1',
      client_id: 'client-1',
      resource: 'https://mcp.example.com/mcp',
    })
    expect(writes).toEqual([
      { data: { accessToken: 'new-access-token', refreshToken: 'refresh-token-2' }, cas: 3 },
    ])
    expect(updates).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          oauth: { ...oauth, expiresAt: '2026-11-15T13:00:00.000Z' },
          authState: 'ok',
        }),
      }),
    ])
  })

  it('takes the token another turn renewed while it waited, and spends nothing', async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 500, body: {} }))
    const fresher: SkillSecretRead = { secret: { accessToken: 'fresher-token-1' }, version: 4 }
    const { instance, writes } = renewer([fresher])
    const oauth = { issuer: 'x', tokenEndpoint: endpoint.url, clientId: 'c', resource: 'r' }
    expect(await instance.renew(SITE, 'menu', oauth, used)).toBe(fresher)
    expect(endpoint.forms).toEqual([])
    expect(writes).toEqual([])
  })

  it('gives nothing back when the server of sign-in refuses, or there is no refresh token', async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    const oauth = { issuer: 'x', tokenEndpoint: endpoint.url, clientId: 'c', resource: 'r' }
    expect(await renewer([used]).instance.renew(SITE, 'menu', oauth, used)).toBeNull()
    const bare: SkillSecretRead = { secret: { accessToken: 'old-access-token' }, version: 3 }
    expect(await renewer([bare]).instance.renew(SITE, 'menu', oauth, bare)).toBeNull()
  })
})
