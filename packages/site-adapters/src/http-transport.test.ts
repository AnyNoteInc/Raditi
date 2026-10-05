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
})
