import { describe, expect, it } from 'vitest'

import {
  browserResponseHeaders,
  isServiceWorkerScript,
  siteSetCookie,
  upstreamRequestHeaders,
  withoutFrameAncestors,
} from './headers.ts'

const context = { originHost: 'site-abcd1234-chat-ef5678.localhost:8090', scheme: 'http' }
const appOrigin = 'http://localhost:3000'

describe('headers towards the site', () => {
  it('drops the gateway cookie, hop-by-hop and every forwarding header a client chose', () => {
    const headers = upstreamRequestHeaders(
      {
        host: 'evil.example',
        cookie: '__Host-raditi-preview=s.m; wp=1',
        connection: 'keep-alive, x-secret-hop',
        'x-secret-hop': 'gone',
        'keep-alive': 'timeout=5',
        'proxy-authorization': 'Basic x',
        'proxy-connection': 'keep-alive',
        'transfer-encoding': 'chunked',
        te: 'trailers',
        upgrade: 'h2c',
        expect: '100-continue',
        forwarded: 'for=1.2.3.4;host=evil.example',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-real-ip': '1.2.3.4',
        accept: 'text/html',
        'user-agent': 'test',
      },
      context,
    )
    expect(headers).toEqual({
      accept: 'text/html',
      'user-agent': 'test',
      cookie: 'wp=1',
      host: context.originHost,
      'x-forwarded-host': context.originHost,
      'x-forwarded-proto': 'http',
    })
  })

  it('sends no Cookie header when only the gateway cookie came', () => {
    const headers = upstreamRequestHeaders({ cookie: '__Host-raditi-preview=s.m' }, context)
    expect(headers.cookie).toBeUndefined()
  })

  it('keeps the two hop-by-hop headers a websocket handshake needs', () => {
    const headers = upstreamRequestHeaders(
      {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'k',
        'sec-websocket-version': '13',
      },
      { ...context, websocket: true },
    )
    expect(headers).toMatchObject({
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'k',
      'sec-websocket-version': '13',
    })
  })
})

describe('headers towards the browser', () => {
  it('lets only the cabinet frame a page and never lets it be indexed', () => {
    const headers = browserResponseHeaders(
      {
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy':
          "default-src 'self'; frame-ancestors 'self' https://evil.example; img-src *",
        'content-security-policy-report-only': "frame-ancestors 'none'",
        'x-robots-tag': 'all',
        'content-type': 'text/html',
      },
      { appOrigin },
    )
    expect(headers['x-frame-options']).toBeUndefined()
    expect(headers['content-security-policy']).toEqual([
      "default-src 'self'; img-src *",
      `frame-ancestors ${appOrigin}`,
    ])
    expect(headers['content-security-policy-report-only']).toBeUndefined()
    expect(headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(headers['content-type']).toBe('text/html')
    expect(headers['clear-site-data']).toBeUndefined()
  })

  it('adds its own frame-ancestors when the site sent no policy', () => {
    expect(browserResponseHeaders({}, { appOrigin })['content-security-policy']).toEqual([
      `frame-ancestors ${appOrigin}`,
    ])
  })

  it('takes Domain off the site cookies and drops any that pass for the gateway one', () => {
    const headers = browserResponseHeaders(
      {
        'set-cookie': [
          'wordpress_test_cookie=WP%20Cookie%20check; path=/; domain=.example.ru; HttpOnly',
          '__Host-raditi-preview=forged; Path=/; Secure',
          'Raditi-Preview=forged',
          'theme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Domain=localhost',
        ],
      },
      { appOrigin },
    )
    expect(headers['set-cookie']).toEqual([
      'wordpress_test_cookie=WP%20Cookie%20check; path=/; HttpOnly',
      'theme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
    ])
    expect(siteSetCookie('=nameless')).toBeNull()
  })

  it('owns transport, data wiping and service workers', () => {
    const headers = browserResponseHeaders(
      {
        'strict-transport-security': 'max-age=63072000; includeSubDomains',
        'alt-svc': 'h3=":443"',
        'clear-site-data': '"cookies"',
        'service-worker-allowed': '/',
        connection: 'close',
        'transfer-encoding': 'chunked',
        'keep-alive': 'timeout=5',
      },
      { appOrigin, clearForRevision: 3 },
    )
    expect(Object.keys(headers).sort()).toEqual([
      'clear-site-data',
      'content-security-policy',
      'set-cookie',
      'x-robots-tag',
    ])
    expect(headers['clear-site-data']).toBe('"cache", "storage"')
    // The browser records the revision it was cleared for, in the gateway's own cookie.
    expect(headers['set-cookie']).toEqual([
      '__Host-raditi-preview-rev=3; Max-Age=2678400; HttpOnly; Secure; SameSite=None; Partitioned; Path=/',
    ])
  })

  it('records the revision next to the cookies of the site, never instead of them', () => {
    const headers = browserResponseHeaders(
      { 'set-cookie': ['wp=1; path=/', '__Host-raditi-preview-rev=9; Path=/'] },
      { appOrigin, clearForRevision: 4 },
    )
    expect(headers['set-cookie']).toEqual([
      'wp=1; path=/',
      '__Host-raditi-preview-rev=4; Max-Age=2678400; HttpOnly; Secure; SameSite=None; Partitioned; Path=/',
    ])
  })

  it('strips frame-ancestors from every policy of a joined header', () => {
    expect(
      withoutFrameAncestors("frame-ancestors 'none', default-src 'self'; frame-ancestors x"),
    ).toBe("default-src 'self'")
    expect(withoutFrameAncestors("frame-ancestors 'none'")).toBeNull()
    expect(withoutFrameAncestors('FRAME-ANCESTORS *; script-src a')).toBe('script-src a')
  })

  it('recognises a service worker registration', () => {
    expect(isServiceWorkerScript({ 'service-worker': 'script' })).toBe(true)
    expect(isServiceWorkerScript({ 'service-worker': ' Script ' })).toBe(true)
    expect(isServiceWorkerScript({})).toBe(false)
  })
})
