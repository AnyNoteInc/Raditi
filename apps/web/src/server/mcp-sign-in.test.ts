import { DomainError } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { finishSignIn, startSignIn } = await import('./mcp-sign-in')
const { McpOAuthRefused } = await import('./mcp-oauth')
const { MCP_SIGN_IN_COOKIE, openSignIn, sealSignIn } = await import('./mcp-sign-in-cookie')
type Deps = Parameters<typeof startSignIn>[1]

const APP = 'https://raditi.example'
const SECRET = 'synthetic-better-auth-secret-for-tests-only'
const WORKSPACE = '0199a000-0000-7000-8000-000000000001'
const NOW = 1_800_000_000_000

const pending = {
  url: 'https://mcp.example.com/mcp',
  issuer: 'https://auth.example.com',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-1',
  verifier: 'verifier-0123456789',
  state: 'state-0123456789',
  redirectUri: `${APP}/api/mcp-oauth/callback`,
}

function deps(overrides: Partial<Deps> = {}) {
  const connect = vi.fn(async () => undefined)
  const finish = vi.fn(async () => ({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-1',
    expiresIn: 60,
  }))
  const start = vi.fn(async () => ({
    authorizationUrl: 'https://auth.example.com/authorize?x=1',
    pending,
  }))
  const value: Deps = {
    appUrl: () => APP,
    secret: () => SECRET,
    now: () => NOW,
    userOf: async () => 'user-1',
    check: vi.fn(async (_headers, input) => ({
      workspaceId: input.workspaceId ?? WORKSPACE,
      name: input.name,
      url: input.url,
    })),
    client: () => ({ start, finish }) as unknown as ReturnType<Deps['client']>,
    connect,
    clientIp: () => '203.0.113.5',
    ...overrides,
  }
  return { value, connect, finish, start }
}

const startRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${APP}/api/mcp-oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP, ...headers },
    body: JSON.stringify(body),
  })

const sealed = (patch: Record<string, unknown> = {}) =>
  sealSignIn(
    { workspaceId: WORKSPACE, name: 'menu', userId: 'user-1', expiresAt: NOW + 60_000, pending, ...patch },
    SECRET,
  )

const callback = (query: string, token = sealed()) =>
  new Request(`${APP}/api/mcp-oauth/callback?${query}`, {
    headers: { cookie: `other=1; ${MCP_SIGN_IN_COOKIE}=${token}` },
  })

describe('startSignIn', () => {
  it('checks the site and the name, then answers the address and seals the sign-in in a cookie', async () => {
    const { value, start } = deps()
    const response = await startSignIn(
      startRequest({ workspaceId: WORKSPACE, name: 'menu', url: pending.url }),
      value,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authorizationUrl: 'https://auth.example.com/authorize?x=1',
    })
    expect(start).toHaveBeenCalledWith(pending.url, `${APP}/api/mcp-oauth/callback`)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/Path=\/api\/mcp-oauth; HttpOnly; SameSite=Lax; Max-Age=600; Secure/)
    const token = /raditi_mcp_sign_in=([^;]+)/.exec(cookie)?.[1]
    expect(openSignIn(token, SECRET, NOW)).toMatchObject({
      workspaceId: WORKSPACE,
      name: 'menu',
      userId: 'user-1',
      pending,
    })
    // The verifier is in no answer: only in the sealed cookie.
    expect(cookie).not.toContain(pending.verifier)
  })

  it('refuses another origin, a guest, and says the refusal of the procedure or of the sign-in', async () => {
    const { value } = deps()
    expect(
      (await startSignIn(startRequest({}, { origin: 'https://evil.example' }), value)).status,
    ).toBe(403)
    expect(
      (
        await startSignIn(
          startRequest({ workspaceId: WORKSPACE, name: 'menu', url: pending.url }),
          deps({ userOf: async () => null }).value,
        )
      ).status,
    ).toBe(401)
    const forbidden = deps({
      check: async () => {
        throw Object.assign(
          new Error('Менять навыки агента могут только владелец и администраторы'),
          { code: 'FORBIDDEN' },
        )
      },
    })
    const refused = await startSignIn(
      startRequest({ workspaceId: WORKSPACE, name: 'menu', url: pending.url }),
      forbidden.value,
    )
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({
      message: 'Менять навыки агента могут только владелец и администраторы',
    })
    const noSignIn = deps()
    noSignIn.start.mockRejectedValueOnce(new McpOAuthRefused('no_sign_in'))
    const unsupported = await startSignIn(
      startRequest({ workspaceId: WORKSPACE, name: 'menu', url: pending.url }),
      noSignIn.value,
    )
    expect(unsupported.status).toBe(422)
    expect(await unsupported.json()).toEqual({ reason: 'no_sign_in' })
  })
})

describe('finishSignIn', () => {
  it('exchanges the code and connects the server, then sends the owner back to the settings', async () => {
    const { value, connect, finish } = deps()
    const response = await finishSignIn(callback(`code=code-1&state=${pending.state}`), value)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      `${APP}/settings/skills?mcp=signed-in&skill=menu`,
    )
    expect(response.headers.get('set-cookie')).toMatch(/raditi_mcp_sign_in=; .*Max-Age=0/)
    expect(finish).toHaveBeenCalledWith(pending, 'code-1')
    expect(connect).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: WORKSPACE,
      name: 'menu',
      url: pending.url,
      ip: '203.0.113.5',
      tokens: { accessToken: 'access-token-1', refreshToken: 'refresh-1', expiresIn: 60 },
      oauth: {
        issuer: pending.issuer,
        tokenEndpoint: pending.tokenEndpoint,
        clientId: 'client-1',
        resource: pending.url,
      },
    })
  })

  it('refuses another state, another user, an error of the server and a sign-in past its time', async () => {
    for (const [request, override, outcome] of [
      [callback('code=code-1&state=forged'), {}, 'refused'],
      [callback(`code=code-1&state=${pending.state}`), { userOf: async () => 'user-2' }, 'refused'],
      [callback('error=access_denied'), {}, 'refused'],
    ] as const) {
      const { value, connect } = deps(override)
      const response = await finishSignIn(request, value)
      expect(response.headers.get('location')).toContain(`mcp=${outcome}`)
      expect(connect).not.toHaveBeenCalled()
    }
    const late = await finishSignIn(
      callback(`code=code-1&state=${pending.state}`, sealed({ expiresAt: NOW - 1 })),
      deps().value,
    )
    expect(late.headers.get('location')).toBe(`${APP}/settings/skills?mcp=expired`)
  })

  it('says a check that failed after the sign-in, and a Vault that is off', async () => {
    const failed = deps({
      connect: async () => {
        throw new DomainError('AGENT_SKILL_CHECK_FAILED', 'x', 422, { reason: 'not_mcp' })
      },
    })
    expect(
      (
        await finishSignIn(callback(`code=code-1&state=${pending.state}`), failed.value)
      ).headers.get('location'),
    ).toContain('mcp=failed')
    const off = deps({
      connect: async () => {
        throw new DomainError('AGENT_SKILL_AUTH_UNAVAILABLE', 'x', 503)
      },
    })
    expect(
      (await finishSignIn(callback(`code=code-1&state=${pending.state}`), off.value)).headers.get(
        'location',
      ),
    ).toContain('mcp=unavailable')
  })
})
