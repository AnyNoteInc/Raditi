import { createHash } from 'node:crypto'

import { DomainError, gitConnectUnavailable, gitProviderFailed } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { finishGitlabSignIn, startGitlabSignIn, GITLAB_SCOPES } = await import('./git-sign-in')
const { GIT_SIGN_IN_COOKIE, openGitSignIn, sealGitSignIn } = await import('./git-sign-in-cookie')
const { gitHostResolver } = await import('./git-services')
type Deps = Parameters<typeof startGitlabSignIn>[1]

// The sign-in on gitlab.com (docs/plan/84-projects.md, ПР10; slice 84.17): PKCE S256, the state
// bound to a cookie of these routes, the code exchanged by the sign-in adapter, the tokens handed
// to the writer of Vault and never answered.

const APP = 'https://raditi.example'
const SECRET = 'synthetic-better-auth-secret-for-tests-only'
const PROJECT = '0199a000-0000-7000-8000-00000000c001'
const NOW = 1_800_000_000_000

function deps(overrides: Partial<Deps> = {}) {
  const save = vi.fn(async () => undefined)
  const exchangeCode = vi.fn(async () => ({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(NOW + 7_200_000),
  }))
  const signedInUser = vi.fn(async () => ({ login: 'elena.k', id: '42' }))
  const checkProject = vi.fn(async () => undefined)
  const value: Deps = {
    appUrl: () => APP,
    secret: () => SECRET,
    now: () => NOW,
    userOf: async () => 'user-1',
    checkProject,
    gitlab: () => ({
      app: { host: 'gitlab.com', clientId: 'client-1', clientSecret: 'client-secret' },
      authorizeOrigin: 'https://gitlab.com',
    }),
    connect: () => ({ exchangeCode, signedInUser, refreshAccess: vi.fn() }),
    save,
    clientIp: () => '203.0.113.5',
    ...overrides,
  }
  return { value, save, exchangeCode, signedInUser, checkProject }
}

const start = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${APP}/api/git/gitlab/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP, ...headers },
    body: JSON.stringify(body),
  })

const cookieValue = (response: Response) =>
  /raditi_git_sign_in=([^;]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? ''

const callback = (query: string, cookie?: string) =>
  new Request(`${APP}/api/git/gitlab/callback?${query}`, {
    headers: cookie === undefined ? {} : { cookie: `${GIT_SIGN_IN_COOKIE}=${cookie}` },
  })

describe('the start of a sign-in on gitlab.com', () => {
  it('answers the address of gitlab.com with PKCE S256 and seals the verifier in a cookie', async () => {
    const d = deps()
    const response = await startGitlabSignIn(start({ projectId: PROJECT }), d.value)
    expect(response.status).toBe(200)
    const { authorizationUrl } = (await response.json()) as { authorizationUrl: string }
    const url = new URL(authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://gitlab.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP}/api/git/gitlab/callback`)
    expect(url.searchParams.get('scope')).toBe(GITLAB_SCOPES)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toMatch(/Path=\/api\/git\/gitlab; HttpOnly; SameSite=Lax; Max-Age=600; Secure/)
    const sealed = openGitSignIn(cookieValue(response), SECRET, NOW)!
    expect(sealed).toMatchObject({ userId: 'user-1', projectId: PROJECT })
    expect(url.searchParams.get('state')).toBe(sealed.state)
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(sealed.verifier).digest('base64url'),
    )
    // Neither the verifier nor the secret of the app goes to the browser.
    expect(authorizationUrl).not.toContain(sealed.verifier)
    expect(authorizationUrl).not.toContain('client-secret')
    expect(d.checkProject).toHaveBeenCalledWith(expect.any(Headers), PROJECT)
  })

  it('refuses another origin, a stranger, a project not theirs and a GitLab.com not offered', async () => {
    expect(
      (
        await startGitlabSignIn(
          start({ projectId: PROJECT }, { origin: 'https://evil.example' }),
          deps().value,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await startGitlabSignIn(
          start({ projectId: PROJECT }),
          deps({ userOf: async () => null }).value,
        )
      ).status,
    ).toBe(401)
    const notTheirs = deps({
      checkProject: async () => {
        throw Object.assign(new Error('Проекта нет или он удалён'), { code: 'NOT_FOUND' })
      },
    })
    const refused = await startGitlabSignIn(start({ projectId: PROJECT }), notTheirs.value)
    expect(refused.status).toBe(404)
    expect(refused.headers.get('set-cookie')).toBeNull()
    expect(
      (await startGitlabSignIn(start({ projectId: PROJECT }), deps({ gitlab: () => null }).value))
        .status,
    ).toBe(503)
  })
})

describe('the return from gitlab.com', () => {
  const sealed = (overrides: Partial<Parameters<typeof sealGitSignIn>[0]> = {}) =>
    sealGitSignIn(
      {
        userId: 'user-1',
        projectId: PROJECT,
        state: 'state-0123456789abcdef',
        verifier: 'v'.repeat(43),
        expiresAt: NOW + 60_000,
        ...overrides,
      },
      SECRET,
    )

  it('exchanges the code with the verifier, hands the tokens to Vault and answers nothing of them', async () => {
    const d = deps()
    const response = await finishGitlabSignIn(
      callback('code=code-1&state=state-0123456789abcdef', sealed()),
      d.value,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=connected`)
    expect(response.headers.get('set-cookie')).toMatch(/raditi_git_sign_in=; .*Max-Age=0/)
    expect(d.exchangeCode).toHaveBeenCalledWith(
      {
        host: 'gitlab.com',
        clientId: 'client-1',
        clientSecret: 'client-secret',
        redirectUri: `${APP}/api/git/gitlab/callback`,
      },
      'code-1',
      'v'.repeat(43),
    )
    expect(d.save).toHaveBeenCalledWith({
      userId: 'user-1',
      account: { login: 'elena.k', id: '42' },
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: expect.any(Date) },
      ip: '203.0.113.5',
    })
    expect(JSON.stringify([...response.headers])).not.toContain('access-1')
  })

  it('a return without the cookie of this browser, with another state or user, is refused', async () => {
    const none = deps()
    const lost = await finishGitlabSignIn(
      callback('code=c&state=state-0123456789abcdef'),
      none.value,
    )
    expect(lost.headers.get('location')).toBe(`${APP}/projects?git=expired`)
    const forged = await finishGitlabSignIn(
      callback('code=c&state=state-0123456789abcdef', sealed().slice(0, -2) + 'AA'),
      none.value,
    )
    expect(forged.headers.get('location')).toBe(`${APP}/projects?git=expired`)
    const old = await finishGitlabSignIn(
      callback('code=c&state=state-0123456789abcdef', sealed({ expiresAt: NOW - 1 })),
      none.value,
    )
    expect(old.headers.get('location')).toBe(`${APP}/projects?git=expired`)
    const state = await finishGitlabSignIn(
      callback('code=c&state=another-state', sealed()),
      none.value,
    )
    expect(state.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=refused`)
    const denied = await finishGitlabSignIn(
      callback('error=access_denied&state=state-0123456789abcdef', sealed()),
      none.value,
    )
    expect(denied.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=refused`)
    const stranger = deps({ userOf: async () => 'user-2' })
    const other = await finishGitlabSignIn(
      callback('code=c&state=state-0123456789abcdef', sealed()),
      stranger.value,
    )
    expect(other.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=refused`)
    expect(none.exchangeCode).not.toHaveBeenCalled()
    expect(stranger.exchangeCode).not.toHaveBeenCalled()
  })

  it('a refused exchange is `failed`, a sign-in not offered any more is `unavailable`', async () => {
    const refused = deps()
    refused.exchangeCode.mockRejectedValueOnce(gitProviderFailed('refused', 400))
    const failed = await finishGitlabSignIn(
      callback('code=c&state=state-0123456789abcdef', sealed()),
      refused.value,
    )
    expect(failed.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=failed`)
    expect(refused.save).not.toHaveBeenCalled()
    const off = deps()
    off.save.mockRejectedValueOnce(gitConnectUnavailable())
    const unavailable = await finishGitlabSignIn(
      callback('code=c&state=state-0123456789abcdef', sealed()),
      off.value,
    )
    expect(unavailable.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=unavailable`)
    expect(DomainError).toBeDefined()
  })
})

describe('the check of a git host from web (§4.6)', () => {
  const resolving =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address, family: 4 }))

  it('refuses a host that resolves to a private address, and an address literal', async () => {
    const check = gitHostResolver({
      refusedSubnets: [],
      allowLoopback: false,
      resolve: resolving('10.0.0.5'),
    })
    await expect(check('git.kolos-bakery.ru')).rejects.toMatchObject({ code: 'GIT_HOST_REFUSED' })
    await expect(check('192.168.0.1')).rejects.toMatchObject({ code: 'GIT_HOST_REFUSED' })
    const open = gitHostResolver({
      refusedSubnets: [],
      allowLoopback: false,
      resolve: resolving('8.8.8.8'),
    })
    expect(await open('git.kolos-bakery.ru')).toBe('8.8.8.8')
  })
})
