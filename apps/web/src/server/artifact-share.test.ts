import { describe, expect, it, vi } from 'vitest'

import { heldToken, holdShareToken, openSharedArtifact, SHARE_COOKIE } from './artifact-share'

vi.mock('server-only', () => ({}))

// The page /a of a link (docs/plan/88-artifacts.md, Ар33; spike 8): the token waits in an HttpOnly
// cookie for the sign-in, «Открыть» takes it from the body or the cookie and clears the cookie.

const token = 'A'.repeat(43)
const post = (body: unknown, cookie?: string) =>
  new Request('https://raditi.test/api/artifact-share/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

describe('the token of a link on its way through the sign-in', () => {
  it('holds a valid token an hour in a cookie of this host only, never a bad one', async () => {
    const held = await holdShareToken(post({ token }), true)
    expect(held.status).toBe(204)
    const cookie = held.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SHARE_COOKIE}=${token}`)
    for (const part of ['Path=/', 'Max-Age=3600', 'Secure', 'HttpOnly', 'SameSite=Lax'])
      expect(cookie).toContain(part)
    expect(held.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await holdShareToken(post({ token: 'short' }), true)).status).toBe(400)
    expect((await holdShareToken(post({ token }), false)).status).toBe(404)
  })

  it('opens by the body or the cookie and clears the cookie', async () => {
    const opener = vi.fn(async () => ({ artifactId: 'a1' }))
    const byCookie = await openSharedArtifact(post({}, `x=1; ${SHARE_COOKIE}=${token}`), {
      open: true,
      opener,
    })
    expect(byCookie.status).toBe(200)
    expect(await byCookie.json()).toEqual({ artifactId: 'a1' })
    expect(opener).toHaveBeenCalledWith(token)
    expect(byCookie.headers.get('set-cookie')).toContain('Max-Age=0')
    const none = await openSharedArtifact(post({}), { open: true, opener })
    expect(none.status).toBe(404)
    const refused = await openSharedArtifact(post({ token }), {
      open: true,
      opener: async () => {
        throw Object.assign(new Error('gone'), { cause: { code: 'ARTIFACT_LINK_GONE' } })
      },
    })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ code: 'ARTIFACT_LINK_GONE' })
  })

  it('reads only a well-formed token from the cookies', () => {
    expect(heldToken(`${SHARE_COOKIE}=${token}`)).toBe(token)
    expect(heldToken(`${SHARE_COOKIE}=bad`)).toBeNull()
    expect(heldToken(null)).toBeNull()
  })
})
