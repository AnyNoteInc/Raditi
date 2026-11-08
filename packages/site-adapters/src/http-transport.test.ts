import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchSiteTransport } from './http-transport.ts'

const request = {
  url: 'https://site.example.test/?rest_route=%2Fraditi%2Fv1%2Fcontent%2F42',
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', 'x-raditi-site': 'synthetic' },
  body: '{"a":1}',
  timeoutMs: 10_000,
  maxResponseBytes: 16,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchSiteTransport', () => {
  it('sends one request with the given method, headers and body and follows no redirect', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetcher)
    const response = await fetchSiteTransport(request)
    expect(response.status).toBe(200)
    expect(Buffer.from(response.body).toString()).toBe('{"ok":true}')
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(request.url)
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: request.headers,
      body: '{"a":1}',
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns a redirect as its status and sends no body with GET', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'https://foreign.example.test' } }),
      )
    vi.stubGlobal('fetch', fetcher)
    const { body: _body, ...get } = request
    const response = await fetchSiteTransport({ ...get, method: 'GET' })
    expect(response.status).toBe(302)
    expect(response.body.byteLength).toBe(0)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('body')
  })

  it('stops reading at the limit and names no content in its failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(17))))
    await expect(fetchSiteTransport(request)).rejects.toThrow('Site response exceeds its limit')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(16))))
    expect((await fetchSiteTransport(request)).body.byteLength).toBe(16)
  })

  it('bounds the exchange by the given time', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await fetchSiteTransport({ ...request, timeoutMs: 1234 })
    expect(timeout).toHaveBeenCalledWith(1234)
  })

  it('hands over X-Powered-By as the site sent it, also on an answer without a body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { headers: { 'x-powered-by': 'PHP/7.4.33' } })),
    )
    expect((await fetchSiteTransport(request)).poweredBy).toBe('PHP/7.4.33')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://site.example.test/', 'x-powered-by': 'PHP/8.1.2' },
        }),
      ),
    )
    const moved = await fetchSiteTransport(request)
    expect(moved.body.byteLength).toBe(0)
    expect(moved.poweredBy).toBe('PHP/8.1.2')
  })

  it('hands over a repeated X-Powered-By as one string joined with ", "', async () => {
    const headers = new Headers([
      ['x-powered-by', 'PleskLin'],
      ['x-powered-by', 'PHP/7.4.33'],
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers })))
    expect((await fetchSiteTransport(request)).poweredBy).toBe('PleskLin, PHP/7.4.33')
  })

  it('gives no poweredBy without the header or with a value the rule refuses', async () => {
    for (const headers of [
      {},
      { 'x-powered-by': 'P'.repeat(129) },
      { 'x-powered-by': 'PHP/7.4\t33' },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers })))
      expect(await fetchSiteTransport(request)).not.toHaveProperty('poweredBy')
    }
  })
})
