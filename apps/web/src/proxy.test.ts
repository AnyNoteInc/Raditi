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
    // The root of PAGES_BASE_DOMAIN with web's port (docs/plan/69-pages.md, Ст3).
    const pagesAt = (domain: string, appEnv = 'development', appUrl = 'http://localhost:3000') => {
      vi.stubEnv('APP_ENV', appEnv)
      vi.stubEnv('APP_URL', appUrl)
      vi.stubEnv('PAGES_BASE_DOMAIN', domain)
    }

    it('answers its own paths on its host and nothing of the cabinet', () => {
      pagesAt('pages.localhost')
      const pass = proxy(at('pages.localhost:3000', token))
      expect(pass.status).toBe(200)
      expect(pass.headers.get('x-middleware-next')).toBe('1')
      expect(pass.headers.get('content-security-policy')).toBeNull()
      // A shared link is plan 69's: no path of this domain yet.
      expect(proxy(at('pages.localhost:3000', '/s/abc.def')).status).toBe(404)
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
      pagesAt('pages.localhost')
      expect(proxy(at('localhost:3000', token)).status).toBe(404)
      expect(proxy(at('localhost:3000', '/s/abc.def')).status).toBe(404)
      // Without the domain of pages they are no path of the cabinet either.
      pagesAt('')
      expect(proxy(at('localhost:3000', token)).status).toBe(404)
    })

    it('frames the pages in the cabinet and leaves its API routes as they were', () => {
      vi.stubEnv('PREVIEW_BASE_DOMAIN', '')
      pagesAt('pages.localhost')
      expect(proxy(at('localhost:3000', '/chats/1')).headers.get('content-security-policy')).toBe(
        contentSecurityPolicy(null, 'http://pages.localhost:3000'),
      )
      const api = proxy(at('localhost:3000', '/api/health'))
      expect(api.headers.get('x-middleware-next')).toBe('1')
      expect(api.headers.get('content-security-policy')).toBeNull()
    })

    it('takes a default port in the header for the same host', () => {
      pagesAt('pages.raditi.ru', 'production', 'https://raditi.ru')
      expect(proxy(at('pages.raditi.ru:443', token)).headers.get('x-middleware-next')).toBe('1')
      expect(proxy(at('pages.raditi.ru:443', '/chats')).status).toBe(404)
    })

    it('derives the origin of the root from PAGES_BASE_DOMAIN', () => {
      const dev = { APP_ENV: 'development', APP_URL: 'http://localhost:3000' }
      for (const value of ['', 'Pages.Localhost', 'pages.localhost.', 'http://pages.localhost'])
        expect(pagesOriginOf({ ...dev, PAGES_BASE_DOMAIN: value }), value).toBeNull()
      // Outside production the root is web's, so it carries web's port, never the pages' own.
      expect(
        pagesOriginOf({ ...dev, PAGES_BASE_DOMAIN: 'pages.localhost', PAGES_PUBLIC_PORT: '8092' }),
      ).toBe('http://pages.localhost:3000')
      expect(
        pagesOriginOf({
          APP_ENV: 'production',
          APP_URL: 'https://raditi.ru',
          PAGES_BASE_DOMAIN: 'pages.raditi.ru',
        }),
      ).toBe('https://pages.raditi.ru')
    })
  })
})
