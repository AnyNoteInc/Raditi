import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ENV_VALUE_MASK } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { McpAccessStore, McpTurnAccess } from '../access/mcp-access.ts'
import { GIT_MCP_REFUSAL, relayText, secretValuesOf, SkillRelay } from './skill-relay.ts'
import type { SkillSecretRead } from './skill-secrets.ts'
import type { RelayedServer, RelayOutcome, SkillServerStore } from './skill-servers.ts'
import { upstreamResolver } from './upstream.ts'

const TOKEN = `mcp_${'a'.repeat(64)}`
const WORKSPACE = '0199a000-0000-7000-8000-000000000001'
const SECRET = 'sk_live_0123456789abcdef'

const servers: Server[] = []
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

interface Seen {
  method: string | undefined
  url: string | undefined
  headers: IncomingMessage['headers']
  body: string
}

async function stand(
  options: {
    answer?: (seen: Seen) => { status: number; headers?: Record<string, string>; body: string }
    server?: Partial<RelayedServer> | null
    secret?: SkillSecretRead | null
    /** What Vault holds when the relay reads it again after a refusal. */
    secretAfter?: SkillSecretRead | null
    findFails?: boolean
    renewed?: SkillSecretRead | null
    workspaceId?: string
    resolveTo?: string
    /** A pass of a scheduled run without its client (docs/plan/82-scheduled-tasks.md, Зп27). */
    unattended?: boolean
    /** The path of the server's address: `/api/v4/mcp` is GitLab's (ПР27). */
    path?: string
  } = {},
) {
  const seen: Seen[] = []
  const upstreamPort = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }
      seen.push(entry)
      const answer = options.answer?.(entry) ?? {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'session-1',
          'set-cookie': 'a=b',
        },
        body: `{"result":"echo ${SECRET}"}`,
      }
      res.writeHead(answer.status, answer.headers ?? {})
      res.end(answer.body)
    })
  })
  const recorded: RelayOutcome[] = []
  const store: SkillServerStore = {
    find: vi.fn(async () => {
      if (options.findFails) throw new Error('database is down')
      return options.server === null
        ? null
        : {
            url: `http://upstream.example.com:${upstreamPort}${options.path ?? '/v1/mcp'}`,
            authKind: 'header' as const,
            headerName: 'X-Api-Key',
            state: 'ok' as const,
            error: null,
            oauth: null,
            ...options.server,
          }
    }),
    record: vi.fn(async (_workspace, _name, outcome) => void recorded.push(outcome)),
  }
  const access: McpAccessStore = {
    authenticate: vi.fn(async (token: string) =>
      token === TOKEN
        ? ({
            keyId: '0199a000-0000-7000-8000-0000000000aa',
            workspaceId: options.workspaceId ?? WORKSPACE,
            unattended: options.unattended ?? false,
          } as McpTurnAccess)
        : null,
    ),
  }
  const forget = vi.fn()
  const relay = new SkillRelay({
    access,
    security: { allowedHosts: ['sandbox-gw', '127.0.0.1'], allowLocalOrigin: false },
    servers: store,
    secrets: {
      read: vi
        .fn<() => Promise<SkillSecretRead | null>>()
        .mockImplementationOnce(async () =>
          options.secret === undefined ? { secret: { value: SECRET }, version: 1 } : options.secret,
        )
        .mockImplementation(async () =>
          options.secretAfter !== undefined
            ? options.secretAfter
            : options.secret === undefined
              ? { secret: { value: SECRET }, version: 1 }
              : options.secret,
        ),
      forget,
    },
    ...(options.renewed === undefined
      ? {}
      : { renewer: { renew: vi.fn(async () => options.renewed ?? null) } }),
    resolve: upstreamResolver({
      refusedSubnets: [],
      allowLoopback: true,
      resolve: async () => [{ address: options.resolveTo ?? '127.0.0.1', family: 4 }],
    }),
  })
  const port = await listen((req, res) => {
    void relay.handle(Object.assign(req, { originalUrl: req.url }), res)
  })
  const call = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>(
      (resolve, reject) => {
        const body = init.body ?? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: init.method ?? 'POST',
            headers: {
              host: 'sandbox-gw',
              authorization: `Bearer ${TOKEN}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': String(Buffer.byteLength(body)),
              ...init.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            )
          },
        )
        req.on('error', reject)
        req.end(body)
      },
    )
  /** A POST without a declared length: its body comes in chunks of 1 MiB. */
  const chunked = (path: string, megabytes: number) =>
    new Promise<number>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            host: 'sandbox-gw',
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      // The relay answers before the body is all there: what is left has nowhere to go.
      req.on('error', () => undefined)
      req.on('close', () => resolve(0))
      for (let index = 0; index < megabytes; index++) req.write('x'.repeat(1024 * 1024))
      req.end()
    })
  return { call, chunked, seen, recorded, store, forget }
}

describe('SkillRelay', () => {
  it("relays the turn's request with the owner's header and takes the key out of the answer", async () => {
    const { call, seen, recorded } = await stand()
    const result = await call('/mcp/skill/menu', {
      headers: { 'mcp-session-id': 'session-1', cookie: 'leak=1', 'x-forwarded-for': '1.2.3.4' },
    })
    expect(result.status).toBe(200)
    expect(result.body).toBe(`{"result":"echo ${ENV_VALUE_MASK}"}`)
    expect(result.headers['mcp-session-id']).toBe('session-1')
    expect(result.headers['set-cookie']).toBeUndefined()
    const [upstream] = seen
    expect(upstream).toMatchObject({
      method: 'POST',
      url: '/v1/mcp',
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    expect(upstream!.headers['x-api-key']).toBe(SECRET)
    // The turn's token, its cookies and anything else it sent stop at the relay.
    expect(upstream!.headers.authorization).toBeUndefined()
    expect(upstream!.headers.cookie).toBeUndefined()
    expect(upstream!.headers['x-forwarded-for']).toBeUndefined()
    expect(upstream!.headers['mcp-session-id']).toBe('session-1')
    // The server's own name, though the connection went to the address that was checked.
    expect(upstream!.headers.host).toMatch(/^upstream\.example\.com:\d+$/)
    expect(recorded).toEqual([expect.objectContaining({ state: 'ok', error: null })])
  })

  it('gives a sign-in its access token as a bearer', async () => {
    const { call, seen } = await stand({
      server: { authKind: 'oauth', headerName: null },
      secret: {
        secret: { accessToken: 'oauth-access-token-1', refreshToken: 'oauth-refresh-1' },
        version: 3,
      },
    })
    expect((await call('/mcp/skill/menu')).status).toBe(200)
    expect(seen[0]!.headers.authorization).toBe('Bearer oauth-access-token-1')
  })

  it('admits only a turn token, and only a server of its workspace', async () => {
    const plain = await stand()
    expect(
      (await plain.call('/mcp/skill/menu', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401)
    expect(
      (
        await plain.call('/mcp/skill/menu', {
          headers: { authorization: `Bearer mcp_${'b'.repeat(64)}` },
        })
      ).status,
    ).toBe(401)
    expect((await plain.call('/mcp/skill/Menu')).status).toBe(404)
    expect(
      (await plain.call('/mcp/skill/menu', { headers: { host: 'evil.example' } })).status,
    ).toBe(403)
    expect((await plain.call('/mcp/skill/menu', { method: 'PUT' })).status).toBe(405)
    expect(plain.seen).toEqual([])
    const noServer = await stand({ server: null })
    expect((await noServer.call('/mcp/skill/menu')).status).toBe(404)
    expect(noServer.seen.length).toBe(0)
  })

  it('records a refused key, forgets it and tells the agent what the owner can do', async () => {
    const header = await stand({ answer: () => ({ status: 401, body: `bad key ${SECRET}` }) })
    const result = await header.call('/mcp/skill/menu')
    expect(result.status).toBe(502)
    expect(JSON.parse(result.body)).toMatchObject({ error: { message: relayText.refused('menu') } })
    expect(result.body).not.toContain(SECRET)
    expect(header.recorded).toEqual([
      expect.objectContaining({ state: 'failed', error: 'unauthorized' }),
    ])
    expect(header.forget).toHaveBeenCalledWith(WORKSPACE, 'menu')
    const oauth = await stand({
      server: { authKind: 'oauth', headerName: null },
      secret: { secret: { accessToken: 'oauth-access-token-1' }, version: 1 },
      answer: () => ({ status: 403, body: '' }),
    })
    await oauth.call('/mcp/skill/menu')
    expect(oauth.recorded).toEqual([
      expect.objectContaining({ state: 'needs_login', error: 'unauthorized' }),
    ])
  })

  it('never connects to an address that is not public', async () => {
    const { call, seen } = await stand({ resolveTo: '10.10.0.10' })
    const result = await call('/mcp/skill/menu')
    expect(result.status).toBe(502)
    expect(JSON.parse(result.body)).toMatchObject({
      error: { message: relayText.addressRefused('menu') },
    })
    expect(seen).toEqual([])
  })

  it('says a server has no key when Vault has none, and follows no redirect', async () => {
    const missing = await stand({ secret: null })
    const result = await missing.call('/mcp/skill/menu')
    expect(result.status).toBe(502)
    expect(JSON.parse(result.body)).toMatchObject({ error: { message: relayText.missing('menu') } })
    expect(missing.recorded).toEqual([
      expect.objectContaining({ state: 'failed', error: 'secret_missing' }),
    ])
    expect(missing.seen).toEqual([])
    const redirect = await stand({
      answer: () => ({ status: 302, headers: { location: 'http://10.0.0.1/' }, body: '' }),
    })
    expect((await redirect.call('/mcp/skill/menu')).status).toBe(502)
    expect(redirect.seen).toHaveLength(1)
  })

  it('refuses a body above its limit before reaching the server', async () => {
    const { call, seen } = await stand()
    const body = 'x'.repeat(4 * 1024 * 1024 + 1)
    expect((await call('/mcp/skill/menu', { body })).status).toBe(413)
    expect(seen).toEqual([])
  })

  it('calls no tool of the server in a pass without its client, with the owner’s key (plan 82, Зп51)', async () => {
    const toolCall = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'menu_create_post', arguments: { title: 'Акция' } },
    })
    const { call, chunked, seen, recorded } = await stand({ unattended: true })
    // The session starts and the tools are listed, as ever: through the relay, with the key.
    const list = await call('/mcp/skill/menu')
    expect(list.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    expect(seen[0]!.headers['x-api-key']).toBe(SECRET)
    // A tool call never reaches the server: its tool's refusal, in the words of the role.
    const refused = await call('/mcp/skill/menu', { body: toolCall })
    expect(refused.status).toBe(200)
    const answer = JSON.parse(refused.body)
    expect(answer).toMatchObject({ jsonrpc: '2.0', id: 7, result: { isError: true } })
    expect(JSON.parse(answer.result.content[0].text)).toMatchObject({
      ok: false,
      code: 'SCHEDULE_FORBIDDEN',
      message: expect.stringMatching(/call no tool of the MCP servers of the workspace/),
    })
    expect(seen).toHaveLength(1)
    // What cannot be read is no guess: a body that is not JSON, a batch that holds a call.
    expect((await call('/mcp/skill/menu', { body: '{"method":"tools/call"' })).status).toBe(400)
    expect((await call('/mcp/skill/menu', { body: `[${toolCall}]` })).status).toBe(400)
    const notification = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    expect((await call('/mcp/skill/menu', { body: notification })).status).toBe(200)
    expect(seen.map((entry) => entry.body)).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      notification,
    ])
    // A key said twice: the server gets the message as it was judged, written again — never a
    // body it might read as the call its first `method` names.
    const twice = '{"jsonrpc":"2.0","id":8,"method":"tools/call","method":"tools/list"}'
    expect((await call('/mcp/skill/menu', { body: twice })).status).toBe(200)
    expect(seen.at(-1)!.body).toBe('{"jsonrpc":"2.0","id":8,"method":"tools/list"}')
    const last = '{"jsonrpc":"2.0","id":9,"method":"tools/list","method":"tools/call"}'
    expect(JSON.parse((await call('/mcp/skill/menu', { body: last })).body)).toMatchObject({
      id: 9,
      result: { isError: true },
    })
    expect(seen).toHaveLength(3)
    // A body above the limit is refused, declared or not, and none of it reaches the server.
    expect((await call('/mcp/skill/menu', { body: 'x'.repeat(4 * 1024 * 1024 + 1) })).status).toBe(
      413,
    )
    expect(await chunked('/mcp/skill/menu', 5)).toBe(413)
    expect(seen).toHaveLength(3)
    // The refusal is the pass's, not the server's: nothing is recorded of the server.
    expect(recorded.filter((outcome) => outcome.state !== 'ok')).toEqual([])
    // Once the client wrote, the same call goes to the server.
    const attended = await stand()
    expect((await attended.call('/mcp/skill/menu', { body: toolCall })).status).toBe(200)
    expect(attended.seen.map((entry) => entry.body)).toEqual([toolCall])
  })

  it('refuses the tools of a code hosting that merge, run builds or change settings in every chat (ПР27)', async () => {
    const callOf = (id: number, name: string) =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
    const { call, seen } = await stand({ path: '/api/v4/mcp' })
    // The session starts and the tools are listed; a tool that reads goes to the server.
    expect((await call('/mcp/skill/menu')).status).toBe(200)
    const read = callOf(3, 'get_merge_request_diffs')
    expect((await call('/mcp/skill/menu', { body: read })).status).toBe(200)
    // Merging, a build run, a variable: never sent, the tool's refusal in the agent's words.
    for (const [id, name] of [
      [4, 'merge_merge_request'],
      [5, 'manage_pipeline'],
      [6, 'set_ci_variable'],
    ] as const) {
      const refused = await call('/mcp/skill/menu', { body: callOf(id, name) })
      expect(refused.status).toBe(200)
      const answer = JSON.parse(refused.body)
      expect(answer).toMatchObject({ jsonrpc: '2.0', id, result: { isError: true } })
      expect(JSON.parse(answer.result.content[0].text)).toMatchObject({
        ok: false,
        code: GIT_MCP_REFUSAL.code,
      })
    }
    // A batch that holds one is refused whole; a call without a name is no guess either.
    expect(
      (await call('/mcp/skill/menu', { body: `[${read},${callOf(7, 'merge_pull_request')}]` }))
        .status,
    ).toBe(400)
    const nameless = '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{}}'
    expect(JSON.parse((await call('/mcp/skill/menu', { body: nameless })).body)).toMatchObject({
      id: 8,
      result: { isError: true },
    })
    expect(seen.map((entry) => entry.body)).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      read,
    ])
    // Another server's tool of the same name is the owner's business.
    const other = await stand()
    expect(
      (await other.call('/mcp/skill/menu', { body: callOf(9, 'merge_merge_request') })).status,
    ).toBe(200)
    expect(other.seen).toHaveLength(1)
  })

  it('masks the key after its scheme and as JSON escapes it', async () => {
    const value = 'Bearer sk_live_quote"slash\\end'
    expect(secretValuesOf({ secret: { value }, version: 1 })).toEqual(
      expect.arrayContaining([value, 'sk_live_quote"slash\\end', 'sk_live_quote\\"slash\\\\end']),
    )
    const { call } = await stand({
      secret: { secret: { value: 'Bearer sk_live_0123456789' }, version: 1 },
      answer: () => ({ status: 200, body: '{"error":"invalid token sk_live_0123456789"}' }),
    })
    expect((await call('/mcp/skill/menu')).body).toBe(`{"error":"invalid token ${ENV_VALUE_MASK}"}`)
  })

  it('takes no compressed answer, which the masking could not read', async () => {
    const { call } = await stand({
      answer: () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: 'x' }),
    })
    expect((await call('/mcp/skill/menu')).status).toBe(502)
  })

  it('does not mark a key refused when the owner has replaced it meanwhile', async () => {
    const { call, recorded } = await stand({
      answer: () => ({ status: 401, body: '' }),
      secretAfter: { secret: { value: 'sk_live_new_0123456789' }, version: 2 },
    })
    const result = await call('/mcp/skill/menu')
    expect(JSON.parse(result.body)).toMatchObject({
      error: { message: relayText.replaced('menu') },
    })
    expect(recorded).toEqual([])
  })

  it('says why a server that does not work now is not served, and a database failure is a refusal', async () => {
    const failed = await stand({ server: { state: 'failed', error: 'unauthorized' } })
    const result = await failed.call('/mcp/skill/menu')
    expect(JSON.parse(result.body)).toMatchObject({ error: { message: relayText.refused('menu') } })
    expect(failed.seen).toEqual([])
    const down = await stand({ findFails: true })
    expect((await down.call('/mcp/skill/menu')).status).toBe(503)
  })

  const signIn = {
    issuer: 'https://auth.example.com',
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-1',
    resource: 'https://mcp.example.com/mcp',
  }

  it('renews a token about to run out before the request, and asks to sign in again when it cannot', async () => {
    const renewing = await stand({
      server: {
        authKind: 'oauth',
        headerName: null,
        oauth: { ...signIn, expiresAt: '2020-01-01T00:00:00.000Z' },
      },
      secret: {
        secret: { accessToken: 'old-access-token', refreshToken: 'refresh-token-1' },
        version: 1,
      },
      renewed: {
        secret: { accessToken: 'new-access-token', refreshToken: 'refresh-token-2' },
        version: 2,
      },
    })
    expect((await renewing.call('/mcp/skill/menu')).status).toBe(200)
    expect(renewing.seen[0]!.headers.authorization).toBe('Bearer new-access-token')
    const refused = await stand({
      server: {
        authKind: 'oauth',
        headerName: null,
        oauth: { ...signIn, expiresAt: '2020-01-01T00:00:00.000Z' },
      },
      secret: { secret: { accessToken: 'old-access-token' }, version: 1 },
      renewed: null,
    })
    const result = await refused.call('/mcp/skill/menu')
    expect(JSON.parse(result.body)).toMatchObject({ error: { message: relayText.refused('menu') } })
    expect(refused.recorded).toEqual([
      expect.objectContaining({ state: 'needs_login', error: 'renewal_refused' }),
    ])
    expect(refused.seen).toEqual([])
  })

  it('renews once after the server refused a token, and the agent asks again', async () => {
    const { call, recorded } = await stand({
      server: { authKind: 'oauth', headerName: null, oauth: signIn },
      secret: {
        secret: { accessToken: 'old-access-token', refreshToken: 'refresh-token-1' },
        version: 1,
      },
      renewed: { secret: { accessToken: 'new-access-token' }, version: 2 },
      answer: () => ({ status: 401, body: '' }),
    })
    const result = await call('/mcp/skill/menu')
    expect(JSON.parse(result.body)).toMatchObject({
      error: { message: relayText.replaced('menu') },
    })
    expect(recorded).toEqual([])
  })
})
