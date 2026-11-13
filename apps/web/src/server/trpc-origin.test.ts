import { describe, expect, it } from 'vitest'

import { refusedCrossOriginPost } from './trpc-origin'

const app = 'https://raditi.ru'
const post = (headers: Record<string, string>) => ({
  method: 'POST',
  headers: new Headers(headers),
})

describe('a POST to the API of the cabinet (plan 69, Ст3)', () => {
  it('goes on from the cabinet itself and without browser headers', () => {
    expect(
      refusedCrossOriginPost(post({ origin: app, 'sec-fetch-site': 'same-origin' }), app),
    ).toBe(false)
    expect(refusedCrossOriginPost(post({}), app)).toBe(false)
    expect(
      refusedCrossOriginPost(
        { method: 'GET', headers: new Headers({ origin: 'https://x.ru' }) },
        app,
      ),
    ).toBe(false)
  })

  it('is refused from a page of the pages domain, which is the same site', () => {
    expect(
      refusedCrossOriginPost(
        post({
          origin: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru',
          'sec-fetch-site': 'same-site',
        }),
        app,
      ),
    ).toBe(true)
    // A sandboxed page has an opaque origin.
    expect(refusedCrossOriginPost(post({ origin: 'null' }), app)).toBe(true)
    expect(refusedCrossOriginPost(post({ 'sec-fetch-site': 'cross-site' }), app)).toBe(true)
  })
})
