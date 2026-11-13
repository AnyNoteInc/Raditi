import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { contentSecurityPolicy } from './lib/content-security-policy'
import { pagesOriginOf } from './lib/pages-origin'
import { REQUEST_PATH_HEADER } from './lib/request-path'
import { proxy } from './proxy'

const page = (path = '/chats/2') => new NextRequest(`http://localhost:3000${path}`)

afterEach(() => vi.unstubAllEnvs())

describe('proxy', () => {
  it('frames the previews of the environment the server runs in, read per request', () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('PREVIEW_BASE_DOMAIN', 'raditi-preview.ru')
    vi.stubEnv('PREVIEW_SCHEME', '')
    vi.stubEnv('PREVIEW_PUBLIC_PORT', '')
    const policy = proxy(page()).headers.get('content-security-policy')
    expect(policy).toBe(contentSecurityPolicy('https://*.raditi-preview.ru'))
    expect(policy).toContain("frame-ancestors 'none'")

    // The same image in another environment: its own previews, not the build's.
    vi.stubEnv('APP_ENV', 'development')
    vi.stubEnv('PREVIEW_BASE_DOMAIN', 'localhost')
    vi.stubEnv('PREVIEW_PUBLIC_PORT', '8090')
    expect(proxy(page()).headers.get('content-security-policy')).toContain(
      "frame-src 'self' https://smartcaptcha.cloud.yandex.ru http://*.localhost:8090",
    )
  })

  it('frames no preview where previews are off', () => {
    vi.stubEnv('PREVIEW_BASE_DOMAIN', '')
    expect(proxy(page()).headers.get('content-security-policy')).toBe(contentSecurityPolicy(null))
  })

  it('still passes the requested path to layouts', () => {
    const response = proxy(page('/settings?tab=1'))
    // NextResponse.next carries the rewritten request headers as x-middleware-request-*.
    expect(response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe(
      '/settings?tab=1',
    )
  })

  describe('the domain of pages (docs/plan/67-agent-documents.md, Д3)', () => {
    const at = (host: string, path: string, method = 'GET') =>
      new NextRequest(`http://${host}${path}`, { method, headers: { host } })
    const token = '/v/eyJ0IjoiMSJ9.c2lnbmF0dXJl'

    it('answers its own paths on its host and nothing of the cabinet', () => {
      vi.stubEnv('PAGES_ORIGIN', 'http://pages.localhost:3000')
      const pass = proxy(at('pages.localhost:3000', token))
      expect(pass.status).toBe(200)
      expect(pass.headers.get('x-middleware-next')).toBe('1')
      expect(pass.headers.get('content-security-policy')).toBeNull()
      expect(proxy(at('pages.localhost:3000', '/s/abc.def')).headers.get('x-middleware-next')).toBe(
        '1',
      )
      for (const path of [
        '/',
        '/chats',
        '/api/auth/get-session',
        '/api/trpc/user.me',
        '/api/tasks/x/files/y',
        '/_next/static/chunks/app.js',
        '/v/',
        '/v/nodot',
        '/v/a.b/c',
        '/favicon.ico',
      ]) {
        const response = proxy(at('pages.localhost:3000', path))
        expect(response.status, path).toBe(404)
        expect(response.headers.get('set-cookie'), path).toBeNull()
      }
      expect(proxy(at('pages.localhost:3000', token, 'POST')).status).toBe(404)
      const robots = proxy(at('pages.localhost:3000', '/robots.txt'))
      expect(robots.status).toBe(200)
    })

    it('does not serve the views and links on the cabinet host', () => {
      vi.stubEnv('PAGES_ORIGIN', 'http://pages.localhost:3000')
      expect(proxy(at('localhost:3000', token)).status).toBe(404)
      expect(proxy(at('localhost:3000', '/s/abc.def')).status).toBe(404)
      // Without the domain of pages they are no path of the cabinet either.
      vi.stubEnv('PAGES_ORIGIN', '')
      expect(proxy(at('localhost:3000', token)).status).toBe(404)
    })

    it('frames the pages in the cabinet and leaves its API routes as they were', () => {
      vi.stubEnv('PREVIEW_BASE_DOMAIN', '')
      vi.stubEnv('PAGES_ORIGIN', 'http://pages.localhost:3000')
      expect(proxy(at('localhost:3000', '/chats/1')).headers.get('content-security-policy')).toBe(
        contentSecurityPolicy(null, 'http://pages.localhost:3000'),
      )
      const api = proxy(at('localhost:3000', '/api/health'))
      expect(api.headers.get('x-middleware-next')).toBe('1')
      expect(api.headers.get('content-security-policy')).toBeNull()
    })

    it('takes only an exact origin', () => {
      for (const value of ['pages.localhost', 'http://pages.localhost/', 'ftp://x', 'http://a:b@c'])
        expect(pagesOriginOf({ PAGES_ORIGIN: value }), value).toBeNull()
      expect(pagesOriginOf({ PAGES_ORIGIN: 'https://raditi-pages.ru' })).toBe(
        'https://raditi-pages.ru',
      )
    })
  })
})
