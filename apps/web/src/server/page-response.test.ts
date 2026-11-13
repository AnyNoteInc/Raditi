import { PAGE_SANDBOX } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { getPageView, pageContentSecurityPolicy, pageHeaders } from './page-response'

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

describe('the headers of a page (docs/plan/67-agent-documents.md, Д3)', () => {
  it('are these, byte for byte', () => {
    expect(pageHeaders(APP, { scripts: true, length: 7 })).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'content-length': '7',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors https://raditi.ru",
      'permissions-policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), cross-origin-isolated=()',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'cache-control': 'private, no-store',
    })
  })

  it('sandbox the page with the very set its frame has, and a shared text with no script', () => {
    const sandbox = (policy: string) => policy.split('; ')[0]!.replace(/^sandbox /, '')
    expect(sandbox(pageContentSecurityPolicy(APP, { scripts: true }))).toBe(PAGE_SANDBOX)
    expect(PAGE_SANDBOX.split(' ')).not.toEqual(expect.arrayContaining(['allow-same-origin']))
    for (const forbidden of ['allow-same-origin', 'allow-forms', 'allow-top-navigation'])
      expect(PAGE_SANDBOX).not.toContain(forbidden)
    const text = pageContentSecurityPolicy(APP, { scripts: false })
    expect(sandbox(text)).not.toContain('allow-scripts')
    expect(text).toContain("script-src 'none'")
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
