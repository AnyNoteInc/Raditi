import { describe, expect, it } from 'vitest'

import {
  pageKeys,
  PAGE_VIEW_TTL_MS,
  readPageView,
  shareIdOf,
  shareToken,
  signPageView,
} from './page-tokens.ts'

const keys = pageKeys('a-secret-of-the-pages-that-is-long-enough')
const view = {
  taskId: '0199a3f2-0000-7000-8000-0000000000b1',
  fileId: '0199a3f2-0000-8000-8000-0000000000f1',
  userId: 'user-1',
  expiresAt: 1_000_000 + PAGE_VIEW_TTL_MS,
}

describe('page tokens (docs/plan/67, Д3, Д8)', () => {
  it('reads back a view it signed, until it expires', () => {
    const token = signPageView(keys.view, view)
    expect(readPageView(keys.view, token, 1_000_000)).toEqual(view)
    expect(readPageView(keys.view, token, view.expiresAt)).toBe('expired')
  })

  it('refuses a token changed, signed with another key or of the other kind', () => {
    const token = signPageView(keys.view, view)
    const [data, mac] = token.split('.') as [string, string]
    const other = pageKeys('another-secret-of-the-pages-long-enough')
    const forged = Buffer.from(
      JSON.stringify({ t: view.taskId, f: view.fileId, u: 'user-2', e: view.expiresAt }),
    ).toString('base64url')
    for (const bad of [
      `${forged}.${mac}`,
      `${data}.${mac.slice(0, -2)}AA`,
      signPageView(other.view, view),
      // A view token signed with the share key, and a share token read as a view.
      signPageView(keys.share, view),
      shareToken(keys.share, view.taskId),
      `${data}`,
      `${data}.${mac}.x`,
      'a.b',
      '',
      'не.токен',
    ])
      expect(readPageView(keys.view, bad, 0)).toBeNull()
  })

  it('gives the same link of a share every time and reads its id back', () => {
    const id = '0199a3f2-0000-7000-8000-0000000000c1'
    expect(shareToken(keys.share, id)).toBe(shareToken(keys.share, id.toUpperCase()))
    expect(shareIdOf(keys.share, shareToken(keys.share, id))).toBe(id)
    expect(shareIdOf(keys.view, shareToken(keys.share, id))).toBeNull()
    expect(shareIdOf(keys.share, signPageView(keys.view, view))).toBeNull()
    expect(
      shareIdOf(pageKeys('a-third-secret-long-enough-for-this').share, shareToken(keys.share, id)),
    ).toBeNull()
  })

  it('needs a secret', () => {
    expect(() => pageKeys('')).toThrow()
  })
})
