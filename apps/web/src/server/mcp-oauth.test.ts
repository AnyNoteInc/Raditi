import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { McpOAuthRefused, mcpOAuthClient } = await import('./mcp-oauth')
const { publicRequester } = await import('./public-request')

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

interface Seen {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  body: string
}

/** A synthetic MCP server that wants a sign-in, with its server of sign-in on the same port. */
async function signInServer(
  options: { s256?: boolean; registration?: boolean; named?: boolean } = {},
) {
  const seen: Seen[] = []
  let origin = ''
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        res
          .writeHead(status, { 'content-type': 'application/json', ...headers })
          .end(JSON.stringify(value))
      if (req.url === '/v1/mcp')
        return send(
          401,
          { error: 'unauthorized' },
          options.named === false
            ? {}
            : { 'www-authenticate': `Bearer resource_metadata="${origin}/meta/resource"` },
        )
      if (
        req.url === '/meta/resource' ||
        req.url === '/.well-known/oauth-protected-resource/v1/mcp'
      )
        return send(200, {
          resource: `${origin}/v1/mcp`,
          authorization_servers: [`${origin}/auth`],
          scopes_supported: ['menu.read', 'menu.write'],
        })
      if (req.url === '/.well-known/oauth-authorization-server/auth')
        return send(200, {
          issuer: `${origin}/auth`,
          authorization_endpoint: `${origin}/auth/authorize`,
          token_endpoint: `${origin}/auth/token`,
          ...(options.registration === false
            ? {}
            : { registration_endpoint: `${origin}/auth/register` }),
          code_challenge_methods_supported: options.s256 === false ? ['plain'] : ['S256'],
        })
      if (req.url === '/auth/register') return send(201, { client_id: 'client-1' })
      if (req.url === '/auth/token') {
        const form = new URLSearchParams(body)
        if (form.get('code') !== 'code-1') return send(400, { error: 'invalid_grant' })
        return send(200, {
          access_token: 'access-token-1',
          refresh_token: 'refresh-token-1',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }
      send(404, {})
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://localhost:${(server.address() as AddressInfo).port}`
  return { origin, url: `${origin}/v1/mcp`, seen }
}

const client = () =>
  mcpOAuthClient(
    publicRequester({
      refusedSubnets: [],
      allowLoopback: true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
  )

const redirectUri = 'https://raditi.example/api/mcp-oauth/callback'

describe('mcpOAuthClient', () => {
  it('finds the sign-in, registers a public client and sends the owner with PKCE and the resource', async () => {
    const { url, origin, seen } = await signInServer()
    const { authorizationUrl, pending } = await client().start(url, redirectUri)
    const address = new URL(authorizationUrl)
    expect(`${address.origin}${address.pathname}`).toBe(`${origin}/auth/authorize`)
    expect(Object.fromEntries(address.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: pending.state,
      resource: url,
      scope: 'menu.read menu.write',
    })
    expect(pending).toMatchObject({
      url,
      issuer: `${origin}/auth`,
      tokenEndpoint: `${origin}/auth/token`,
      clientId: 'client-1',
    })
    const registration = JSON.parse(seen.find((entry) => entry.url === '/auth/register')!.body)
    expect(registration).toMatchObject({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    })
  })

  it('finds the metadata at its well-known address when the server names none', async () => {
    const { url } = await signInServer({ named: false })
    expect((await client().start(url, redirectUri)).pending.clientId).toBe('client-1')
  })

  it('exchanges the code for tokens with the verifier and the resource', async () => {
    const { url, seen } = await signInServer()
    const { pending } = await client().start(url, redirectUri)
    expect(await client().finish(pending, 'code-1')).toEqual({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      expiresIn: 3600,
    })
    const form = new URLSearchParams(seen.at(-1)!.body)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: redirectUri,
      client_id: 'client-1',
      code_verifier: pending.verifier,
      resource: url,
    })
    await expect(client().finish(pending, 'wrong')).rejects.toMatchObject({ reason: 'refused' })
  })

  it('refuses a server of sign-in without S256 or a registration of clients', async () => {
    for (const options of [{ s256: false }, { registration: false }]) {
      const { url } = await signInServer(options)
      const error = await client()
        .start(url, redirectUri)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(McpOAuthRefused)
      expect((error as InstanceType<typeof McpOAuthRefused>).reason).toBe('unsupported')
    }
  })
})
