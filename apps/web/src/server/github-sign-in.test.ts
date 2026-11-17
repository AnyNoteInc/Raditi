import { createHash } from 'node:crypto'

import type { VerifiedInstallation } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { finishGithubSignIn, startGithubSignIn } = await import('./github-sign-in')
const { GITHUB_SIGN_IN_COOKIE, openGitSignIn, sealGitSignIn } = await import('./git-sign-in-cookie')
type Deps = Parameters<typeof startGithubSignIn>[1]

// The connection of the GitHub App (docs/plan/84-projects.md, ПР10; slice 84.25): the state bound
// to a cookie of these routes, the `installation_id` of the return kept until the app's user signs
// in with PKCE, and the installation checked by that user's own token — a forged id connects
// nothing.

const APP = 'https://raditi.example'
const SECRET = 'synthetic-better-auth-secret-for-tests-only'
const PROJECT = '0199a000-0000-7000-8000-00000000c001'
const NOW = 1_800_000_000_000
const CONNECTION = '0199a000-0000-4000-8000-0000000000aa'

const verified: VerifiedInstallation = {
  installationId: '77',
  account: { login: 'acme', id: '500' },
  user: { login: 'elena-k', id: '9' },
  repositories: [],
}

function deps(overrides: Partial<Deps> = {}) {
  const save = vi.fn(async () => ({ connectionId: CONNECTION }))
  const exchangeCode = vi.fn(async () => ({
    accessToken: 'ghu_user',
    refreshToken: null,
    expiresAt: null,
  }))
  const verifyInstallation = vi.fn(
    async (_token: string, id: string): Promise<VerifiedInstallation | null> =>
      id === '77' ? verified : null,
  )
  const value: Deps = {
    appUrl: () => APP,
    secret: () => SECRET,
    now: () => NOW,
    userOf: async () => 'user-1',
    checkProject: vi.fn(async () => undefined),
    github: () => ({
      slug: 'raditi',
      app: { host: 'github.com', clientId: 'Iv1.client', clientSecret: 'client-secret' },
      webOrigin: 'https://github.com',
    }),
    connect: () => ({
      exchangeCode,
      signedInUser: vi.fn(),
      refreshAccess: vi.fn(),
      verifyInstallation,
    }),
    save,
    clientIp: () => '203.0.113.5',
    ...overrides,
  }
  return { value, save, exchangeCode, verifyInstallation }
}

const cookieValue = (response: Response) =>
  new RegExp(`${GITHUB_SIGN_IN_COOKIE}=([^;]*)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1] ?? ''

const get = (path: string, cookie?: string) =>
  new Request(`${APP}${path}`, {
    headers: cookie ? { cookie: `${GITHUB_SIGN_IN_COOKIE}=${cookie}` } : {},
  })

/** A start, and the cookie it set. */
async function started(d = deps()) {
  const response = await startGithubSignIn(get(`/api/git/github/start?project=${PROJECT}`), d.value)
  return { response, cookie: cookieValue(response), d }
}

/** A start and the return of the installation: the cookie that holds its id. */
async function installed(id = '77', d = deps()) {
  const { cookie } = await started(d)
  const response = await finishGithubSignIn(
    get(`/api/git/github/callback?installation_id=${id}&setup_action=install`, cookie),
    d.value,
  )
  return { response, cookie: cookieValue(response), d }
}

describe('the start of the connection of the GitHub App', () => {
  it('sends the browser to install the app, with the state sealed in a cookie of these routes', async () => {
    const { response, cookie } = await started()
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://github.com/apps/raditi/installations/new',
    )
    const sealed = openGitSignIn(cookie, SECRET, NOW)
    expect(sealed).toMatchObject({ userId: 'user-1', projectId: PROJECT })
    expect(location.searchParams.get('state')).toBe(sealed!.state)
    const header = response.headers.get('set-cookie')!
    expect(header).toContain('Path=/api/git/github')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Secure')
  })

  it('without a session, a project or the app it starts nothing', async () => {
    const none = await startGithubSignIn(
      get(`/api/git/github/start?project=${PROJECT}`),
      deps({ userOf: async () => null }).value,
    )
    expect(none.headers.get('location')).toBe(`${APP}/projects?git=expired`)
    const off = await startGithubSignIn(
      get(`/api/git/github/start?project=${PROJECT}`),
      deps({ github: () => null }).value,
    )
    expect(off.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=github-unavailable`)
    const bad = await startGithubSignIn(get('/api/git/github/start?project=x'), deps().value)
    expect(bad.headers.get('location')).toBe(`${APP}/projects?git=expired`)
  })
})

describe('the returns from github.com', () => {
  it("a return without this browser's cookie is «Начните подключение из Радити»", async () => {
    const d = deps()
    const { cookie: sealedElsewhere } = await started()
    const state = openGitSignIn(sealedElsewhere, SECRET, NOW)!.state
    for (const query of [
      `installation_id=77&setup_action=install&state=${state}`,
      `code=abc&state=${state}`,
    ]) {
      const response = await finishGithubSignIn(get(`/api/git/github/callback?${query}`), d.value)
      expect(response.headers.get('location')).toBe(`${APP}/projects?git=expired`)
    }
    expect(d.exchangeCode).not.toHaveBeenCalled()
    expect(d.save).not.toHaveBeenCalled()
  })

  it('the return of an installation goes on to the sign-in of the app with PKCE', async () => {
    const { response, cookie } = await installed()
    const location = new URL(response.headers.get('location')!)
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    )
    const sealed = openGitSignIn(cookie, SECRET, NOW)!
    expect(sealed.installationId).toBe('77')
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: 'Iv1.client',
      redirect_uri: `${APP}/api/git/github/callback`,
      state: sealed.state,
      code_challenge: createHash('sha256').update(sealed.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })
  })

  it("connects the installation the user's own token sees and forgets the token", async () => {
    const d = deps()
    const { cookie } = await installed('77', d)
    const state = openGitSignIn(cookie, SECRET, NOW)!.state
    const response = await finishGithubSignIn(
      get(`/api/git/github/callback?code=abc&state=${state}`, cookie),
      d.value,
    )
    expect(response.headers.get('location')).toBe(
      `${APP}/projects/${PROJECT}?git=connected&connection=${CONNECTION}`,
    )
    expect(d.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: `${APP}/api/git/github/callback` }),
      'abc',
      openGitSignIn(cookie, SECRET, NOW)!.verifier,
    )
    expect(d.verifyInstallation).toHaveBeenCalledWith('ghu_user', '77')
    expect(d.save).toHaveBeenCalledWith({
      userId: 'user-1',
      installation: verified,
      ip: '203.0.113.5',
    })
    // The cookie is cleared; nothing secret is in the answer.
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(JSON.stringify([...response.headers])).not.toContain('ghu_user')
  })

  it("a forged installation_id — not among the user's installations — connects nothing", async () => {
    const d = deps()
    const { cookie } = await installed('78', d)
    const state = openGitSignIn(cookie, SECRET, NOW)!.state
    const response = await finishGithubSignIn(
      get(`/api/git/github/callback?code=abc&state=${state}`, cookie),
      d.value,
    )
    expect(response.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=github-refused`)
    expect(d.verifyInstallation).toHaveBeenCalledWith('ghu_user', '78')
    expect(d.save).not.toHaveBeenCalled()
  })

  it('a code with another state, without an installation, or of another user is refused', async () => {
    const d = deps()
    const { cookie } = await installed('77', d)
    const state = openGitSignIn(cookie, SECRET, NOW)!.state
    const other = await finishGithubSignIn(
      get('/api/git/github/callback?code=abc&state=not-the-state-of-this-browser', cookie),
      d.value,
    )
    expect(other.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=github-refused`)
    // A code straight after the start, without the return of an installation.
    const { cookie: fresh } = await started(d)
    const freshState = openGitSignIn(fresh, SECRET, NOW)!.state
    const early = await finishGithubSignIn(
      get(`/api/git/github/callback?code=abc&state=${freshState}`, fresh),
      d.value,
    )
    expect(early.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=github-refused`)
    const stranger = await finishGithubSignIn(
      get(`/api/git/github/callback?code=abc&state=${state}`, cookie),
      deps({ userOf: async () => 'user-2' }).value,
    )
    expect(stranger.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=github-refused`)
    expect(d.exchangeCode).not.toHaveBeenCalled()
  })

  it("an installation an organisation's owner must approve is said so", async () => {
    const { cookie } = await started()
    const response = await finishGithubSignIn(
      get('/api/git/github/callback?setup_action=request', cookie),
      deps().value,
    )
    expect(response.headers.get('location')).toBe(`${APP}/projects/${PROJECT}?git=github-requested`)
  })

  it('a forged cookie is no cookie', async () => {
    const forged = sealGitSignIn(
      {
        userId: 'user-1',
        projectId: PROJECT,
        state: 's'.repeat(32),
        verifier: 'v'.repeat(43),
        expiresAt: NOW + 1,
      },
      'another-secret-of-another-server-for-tests',
    )
    const response = await finishGithubSignIn(
      get('/api/git/github/callback?installation_id=77&setup_action=install', forged),
      deps().value,
    )
    expect(response.headers.get('location')).toBe(`${APP}/projects?git=expired`)
  })
})
