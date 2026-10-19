import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { contentSecurityPolicy } from './lib/content-security-policy'
import { REQUEST_PATH_HEADER } from './lib/request-path'
import { proxy } from './proxy'

const page = (path = '/projects/1/chat/2') => new NextRequest(`http://localhost:3000${path}`)

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
})
