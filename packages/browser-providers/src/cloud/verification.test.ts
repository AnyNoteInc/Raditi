import type {
  BrowserVerificationPlan,
  BrowserVerificationReply,
  BrowserVerifiedObject,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { runVerification, type VerificationResponse } from './verification.ts'

const ORIGIN = 'https://example.ru'
const SITE = { origin: ORIGIN, origins: new Set([ORIGIN, 'https://www.example.ru']) }
const object: BrowserVerifiedObject = {
  kind: 'post',
  objectId: '12',
  title: 'Новость',
  status: 'publish',
  url: `${ORIGIN}/novost/`,
  editUrl: `${ORIGIN}/wp-admin/post.php?post=12&action=edit`,
  images: 2,
  files: 1,
  featuredImage: true,
}
const text = (value: string) => new TextEncoder().encode(value)
const reply = (status: number, body: string, location: string | null = null) =>
  ({ status, location, bytes: text(body) }) satisfies VerificationResponse

/** WordPress's way: a nonce of the signed-in session, then the post read with it. */
function plan(read: BrowserVerificationPlan['read'] = () => ({ state: 'verified', object })) {
  return {
    steps: [
      {
        id: 'nonce',
        method: 'GET',
        path: '/wp-admin/admin-ajax.php?action=rest-nonce',
        readAs: 'text',
      },
      {
        id: 'post',
        method: 'GET',
        path: '/wp-json/wp/v2/posts/12?context=edit',
        headers: { 'X-WP-Nonce': { fromStep: 'nonce' } },
        readAs: 'json',
      },
    ],
    read,
  } satisfies BrowserVerificationPlan
}

describe('the trusted read of a task browser', () => {
  it('sends the plan’s GETs in order, a header taken from an earlier step, and answers the reading', async () => {
    const fetch = vi
      .fn<(url: string, headers: Record<string, string>) => Promise<VerificationResponse>>()
      .mockResolvedValueOnce(reply(200, ' abc123 \n'))
      .mockResolvedValueOnce(reply(200, '{"id":12,"status":"publish"}'))
    const read = vi.fn<(replies: readonly BrowserVerificationReply[]) => never>(
      () => ({ state: 'verified', object }) as never,
    )
    expect(await runVerification(plan(read), SITE, fetch)).toEqual({ state: 'verified', object })
    expect(fetch.mock.calls).toEqual([
      [`${ORIGIN}/wp-admin/admin-ajax.php?action=rest-nonce`, {}],
      [`${ORIGIN}/wp-json/wp/v2/posts/12?context=edit`, { 'X-WP-Nonce': 'abc123' }],
    ])
    expect(read).toHaveBeenCalledWith([
      { id: 'nonce', status: 200, body: ' abc123 \n' },
      { id: 'post', status: 200, body: { id: 12, status: 'publish' } },
    ])
  })

  it('follows a redirect between the site’s own origins, and answers one off it as it is', async () => {
    const fetch = vi
      .fn<(url: string) => Promise<VerificationResponse>>()
      .mockResolvedValueOnce(
        reply(301, '', 'https://www.example.ru/wp-admin/admin-ajax.php?action=rest-nonce&x=1'),
      )
      .mockResolvedValueOnce(reply(200, 'abc123'))
      .mockResolvedValueOnce(reply(302, '', 'https://elsewhere.example/login'))
    const read = vi.fn(
      (_replies: readonly BrowserVerificationReply[]) => ({ state: 'missing' }) as const,
    )
    expect(await runVerification(plan(read), SITE, fetch)).toEqual({ state: 'missing' })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://www.example.ru/wp-admin/admin-ajax.php?action=rest-nonce&x=1',
    )
    expect(read.mock.calls[0]?.[0]).toEqual([
      { id: 'nonce', status: 200, body: 'abc123' },
      { id: 'post', status: 302, body: null },
    ])
  })

  it('is unreadable, never a guess, when anything goes wrong', async () => {
    const ok = () =>
      vi
        .fn<(url: string) => Promise<VerificationResponse>>()
        .mockResolvedValueOnce(reply(200, 'abc123'))
        .mockResolvedValueOnce(reply(200, '{}'))
    // A plan outside the bounds is not run at all.
    const step = { id: 's0', method: 'GET', path: '/nonce', readAs: 'text' } as const
    const tooMany: BrowserVerificationPlan = {
      ...plan(),
      steps: Array.from({ length: 5 }, (_, index) => ({ ...step, id: `s${index}` })),
    }
    const fetch = ok()
    expect(await runVerification(tooMany, SITE, fetch)).toEqual({ state: 'unreadable' })
    expect(fetch).not.toHaveBeenCalled()
    // The site does not answer.
    expect(
      await runVerification(plan(), SITE, vi.fn().mockRejectedValue(new Error('timeout'))),
    ).toEqual({ state: 'unreadable' })
    // A nonce that is no token: never put into a header.
    const badNonce = vi
      .fn<(url: string) => Promise<VerificationResponse>>()
      .mockResolvedValue(reply(200, 'a b\nc'))
    expect(await runVerification(plan(), SITE, badNonce)).toEqual({ state: 'unreadable' })
    expect(badNonce).toHaveBeenCalledTimes(1)
    // Redirects that never end.
    const loop = vi
      .fn<(url: string) => Promise<VerificationResponse>>()
      .mockResolvedValue(reply(302, '', '/again'))
    expect(await runVerification(plan(), SITE, loop)).toEqual({ state: 'unreadable' })
    // The stack's reading throws, or claims what the session would not accept.
    const throwing = plan(() => {
      throw new Error('bad reply')
    })
    expect(await runVerification(throwing, SITE, ok())).toEqual({ state: 'unreadable' })
    const claimed = plan(() => ({
      state: 'verified',
      object: { ...object, editUrl: 'javascript:1' },
    }))
    expect(await runVerification(claimed, SITE, ok())).toEqual({ state: 'unreadable' })
  })

  it('reads a body that is too large or no JSON as none', async () => {
    const fetch = vi
      .fn<(url: string) => Promise<VerificationResponse>>()
      .mockResolvedValueOnce(reply(200, 'abc123'))
      .mockResolvedValueOnce({ status: 200, location: null, bytes: null })
    const read = vi.fn(
      (_replies: readonly BrowserVerificationReply[]) => ({ state: 'unreadable' }) as const,
    )
    await runVerification(plan(read), SITE, fetch)
    expect(read.mock.calls[0]?.[0][1]).toEqual({ id: 'post', status: 200, body: null })
    const notJson = vi
      .fn<(url: string) => Promise<VerificationResponse>>()
      .mockResolvedValueOnce(reply(200, 'abc123'))
      .mockResolvedValueOnce(reply(200, '<html>'))
    await runVerification(plan(read), SITE, notJson)
    expect(read.mock.calls[1]?.[0][1]).toEqual({ id: 'post', status: 200, body: null })
  })
})
