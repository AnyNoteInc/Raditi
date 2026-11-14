import { PAGE_CSP, PAGE_SANDBOX } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { getPageView, pageHeaders } from './page-response'

vi.mock('server-only', () => ({}))

const APP = 'https://raditi.ru'
const view = {
  taskId: '0199a3f2-0000-7000-8000-0000000000b1',
  fileId: '0199a3f2-0000-8000-8000-0000000000f1',
  userId: 'user-1',
}
const html = new TextEncoder().encode('<!doctype html><title>Отчёт</title>')

function deps(overrides: Partial<Parameters<typeof getPageView>[2]> = {}) {
  return {
    pages: () => ({ host: 'pages.raditi.ru', appOrigin: APP, viewKey: new Uint8Array(32) }),
    readView: vi.fn(() => view),
    read: vi.fn(async () => ({ name: 'Отчёт.html', bytes: html })),
    ...overrides,
  }
}
const get = (host = 'pages.raditi.ru') =>
  new Request('https://pages.raditi.ru/v/a.b', { headers: { host } })

describe('the headers of a page (docs/plan/67-agent-documents.md, Д3; docs/plan/69-pages.md, Ст9)', () => {
  it('are these, byte for byte', () => {
    expect(pageHeaders(APP, 7)).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': '7',
      'Content-Security-Policy':
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; script-src 'unsafe-inline'; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors https://raditi.ru; object-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'",
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), cross-origin-isolated=()',
    })
  })

  it('are the policy of a published page but for its framing: one CSP for both plans', () => {
    const policy = pageHeaders(APP, 7)['Content-Security-Policy']!
    expect(policy).toBe(
      PAGE_CSP.replace("frame-ancestors 'none'", 'frame-ancestors https://raditi.ru').replaceAll(
        ' https:;',
        ';',
      ),
    )
    // A page of a chat loads nothing by https: (Д3), unlike a published one (Ст9).
    expect(policy).not.toContain('https:;')
    // The frame of the cabinet carries the very sandbox of the policy.
    expect(policy.split('; ')[0]).toBe(`sandbox ${PAGE_SANDBOX}`)
    for (const forbidden of ['allow-same-origin', 'allow-forms', 'allow-top-navigation'])
      expect(PAGE_SANDBOX).not.toContain(forbidden)
  })
})

describe('GET /v/<token>', () => {
  it('serves the page of the view to its member, with no cookie', async () => {
    const d = deps()
    const response = await getPageView(get(), 'a.b', d)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(html)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://raditi.ru',
    )
    expect(d.read).toHaveBeenCalledWith(view)
  })

  it('answers an expired token 410 and a forged one, another host or no page 404', async () => {
    expect((await getPageView(get(), 'a.b', deps({ readView: () => 'expired' }))).status).toBe(410)
    expect((await getPageView(get(), 'a.b', deps({ readView: () => null }))).status).toBe(404)
    expect((await getPageView(get('raditi.ru'), 'a.b', deps())).status).toBe(404)
    expect((await getPageView(get(), 'a.b', deps({ pages: () => null }))).status).toBe(404)
    // Someone else's chat, a file that is gone, a text document under the token of a page.
    expect((await getPageView(get(), 'a.b', deps({ read: async () => null }))).status).toBe(404)
    const md = deps({ read: async () => ({ name: 'a.md', bytes: html }) })
    expect((await getPageView(get(), 'a.b', md)).status).toBe(404)
  })

  it('says nothing of a failure', async () => {
    const failed = deps({ read: async () => Promise.reject(new Error('s3 down')) })
    const response = await getPageView(get(), 'a.b', failed)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('s3')
  })
})
