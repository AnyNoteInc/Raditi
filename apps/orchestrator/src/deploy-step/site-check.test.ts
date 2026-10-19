import type { SiteHttpRequest, SiteHttpResponse } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { checkSite, redirectWithinSite, siteCheckLimits } from './site-check.ts'

const verify = {
  origin: 'https://shop.example.ru',
  failureMarkers: ['There has been a critical error on this website', '<b>Fatal error</b>:'],
  pages: ['/', '/shop/'],
}

function site(answers: Record<string, Array<SiteHttpResponse | Error>>) {
  const asked: SiteHttpRequest[] = []
  const transport = async (request: SiteHttpRequest): Promise<SiteHttpResponse> => {
    asked.push(request)
    const url = new URL(request.url)
    const answer = (answers[url.href] ?? answers[url.pathname])?.shift()
    if (!answer || answer instanceof Error) throw answer ?? new Error('no answer')
    return answer
  }
  return { asked, transport }
}

const page = (status: number, text = '<html><body>Магазин</body></html>') => ({
  status,
  body: Buffer.from(text),
})
const moved = (location: string, status = 301) => ({ status, body: Buffer.alloc(0), location })
const noWait = { sleep: async () => {} }

describe('the check of the site after a release (Р30)', () => {
  it('passes when every page answers 2xx without a failure marker', async () => {
    const s = site({ '/': [page(200)], '/shop/': [page(200)] })
    expect(await checkSite(s.transport, verify, noWait)).toEqual({ ok: true, pages: 2, failed: 0 })
    expect(s.asked.map((request) => request.url)).toEqual([
      'https://shop.example.ru/',
      'https://shop.example.ru/shop/',
    ])
    expect(s.asked[0]).toMatchObject({ method: 'GET', maxResponseBytes: siteCheckLimits.pageBytes })
  })

  it('follows a redirect within the site and checks the page it ends on', async () => {
    const fatal = page(200, '<b>Fatal error</b>: x')
    const s = site({
      'https://shop.example.ru/': [moved('/ru/', 302), moved('/ru/', 302)],
      'https://shop.example.ru/ru/': [
        moved('https://www.shop.example.ru/ru/'),
        moved('https://www.shop.example.ru/ru/'),
      ],
      'https://www.shop.example.ru/ru/': [fatal, fatal],
    })
    // The page the redirects end on shows the fatal error: PHP ran there, and it failed.
    const first = await checkSite(s.transport, { ...verify, pages: ['/'] }, noWait)
    expect(first).toEqual({ ok: false, pages: 1, failed: 1 })
    const hops = [
      'https://shop.example.ru/',
      'https://shop.example.ru/ru/',
      'https://www.shop.example.ru/ru/',
    ]
    expect(s.asked.map((request) => request.url)).toEqual([...hops, ...hops])
    const again = site({
      'https://shop.example.ru/': [moved('/ru/', 302)],
      'https://shop.example.ru/ru/': [page(200)],
      '/shop/': [page(200)],
    })
    expect(await checkSite(again.transport, verify, noWait)).toEqual({
      ok: true,
      pages: 2,
      failed: 0,
    })
  })

  it('fails a page that redirects off the site, in a loop or with no Location', async () => {
    for (const answers of [
      [moved('https://elsewhere.example/'), moved('https://elsewhere.example/')],
      [moved('http://shop.example.ru/'), moved('http://shop.example.ru/')],
      [moved('https://shop.example.ru:8443/'), moved('https://shop.example.ru:8443/')],
      [moved('https://user:pass@shop.example.ru/'), moved('https://user:pass@shop.example.ru/')],
      [page(302), page(302)],
      Array.from({ length: 10 }, () => moved('/')),
    ]) {
      const s = site({ '/': answers, '/shop/': [page(200)] })
      expect(await checkSite(s.transport, verify, noWait)).toEqual({
        ok: false,
        pages: 2,
        failed: 1,
      })
      // Nothing outside the site was asked.
      expect(
        s.asked.every((request) => new URL(request.url).hostname.endsWith('shop.example.ru')),
      ).toBe(true)
      expect(s.asked.every((request) => new URL(request.url).port === '')).toBe(true)
    }
    // At most `redirects` hops per try.
    const loop = site({ '/': Array.from({ length: 10 }, () => moved('/')), '/shop/': [page(200)] })
    await checkSite(loop.transport, verify, noWait)
    expect(loop.asked.filter((request) => request.url.endsWith('.ru/'))).toHaveLength(
      2 * (siteCheckLimits.redirects + 1),
    )
  })

  it('fails a page that errs, shows a fatal error or does not answer, after one more try', async () => {
    for (const answers of [
      [page(500), page(502)],
      [
        page(200, '<p>There has been a critical error on this website.</p>'),
        page(200, '<b>Fatal error</b>: x'),
      ],
      [new Error('timeout'), new Error('timeout')],
    ]) {
      const s = site({ '/': answers, '/shop/': [page(200)] })
      expect(await checkSite(s.transport, verify, noWait)).toEqual({
        ok: false,
        pages: 2,
        failed: 1,
      })
      expect(s.asked.filter((request) => request.url.endsWith('.ru/'))).toHaveLength(2)
    }
  })

  it('gives a page a second chance: a cache warming up is not a broken site', async () => {
    const waits: number[] = []
    const s = site({ '/': [page(503), page(200)], '/shop/': [page(200)] })
    const result = await checkSite(s.transport, verify, {
      sleep: async (ms) => void waits.push(ms),
    })
    expect(result.ok).toBe(true)
    expect(waits).toEqual([siteCheckLimits.pauseMs])
  })

  it('never leaves the origin of the site, whatever a page path says', async () => {
    const s = site({ '/': [page(200)] })
    const result = await checkSite(
      s.transport,
      { ...verify, pages: ['/', '//evil.example/'] },
      noWait,
    )
    expect(result).toEqual({ ok: false, pages: 2, failed: 1 })
    expect(s.asked.every((request) => request.url.startsWith('https://shop.example.ru/'))).toBe(
      true,
    )
  })

  it('takes a redirect within the site only: the host or its www twin, https upgrade, same port', () => {
    const origin = new URL('http://example.ru')
    const from = new URL('http://example.ru/')
    expect(redirectWithinSite(from, '/ru/', origin)?.href).toBe('http://example.ru/ru/')
    expect(redirectWithinSite(from, 'https://example.ru/', origin)?.href).toBe(
      'https://example.ru/',
    )
    expect(redirectWithinSite(from, 'https://www.example.ru/a', origin)?.href).toBe(
      'https://www.example.ru/a',
    )
    for (const location of [
      undefined,
      '',
      'https://example.ru:8443/',
      'ftp://example.ru/',
      'https://wwwexample.ru/',
      'https://shop.example.ru/',
      'https://example.ru.evil.example/',
      'http://u:p@example.ru/',
    ])
      expect(redirectWithinSite(from, location, origin)).toBeNull()
    // Never back from https to http.
    expect(
      redirectWithinSite(new URL('https://example.ru/'), 'http://example.ru/', origin),
    ).toBeNull()
    // A local site keeps its port.
    const local = new URL('http://127.0.0.1:8080')
    expect(redirectWithinSite(new URL('http://127.0.0.1:8080/'), '/wp-admin/', local)?.href).toBe(
      'http://127.0.0.1:8080/wp-admin/',
    )
  })

  it('is bounded in time', async () => {
    let now = 0
    const s = site({ '/': [page(500), page(500)], '/shop/': [page(200)] })
    const result = await checkSite(s.transport, verify, {
      now: () => now,
      sleep: async () => {
        now += siteCheckLimits.totalMs
      },
    })
    expect(result).toEqual({ ok: false, pages: 2, failed: 2 })
    expect(s.asked).toHaveLength(1)
  })
})
