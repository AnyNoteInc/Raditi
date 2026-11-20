import { afterEach, describe, expect, it, vi } from 'vitest'

import { cabinetOnly } from './cabinet-only'

afterEach(() => vi.unstubAllEnvs())

describe('cabinetOnly', () => {
  const handler = vi.fn(async (_request: Request, id: string) => Response.json({ id }))
  const route = cabinetOnly(handler)
  const at = (host: string) =>
    new Request(`http://${host}/api/attachments/1`, {
      method: 'PUT',
      headers: { host },
      body: new Uint8Array(4),
    })

  it('answers the domain of pages 404 without reaching the route', async () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('APP_URL', 'https://raditi.ru')
    vi.stubEnv('PAGES_BASE_DOMAIN', 'pages.raditi.ru')
    handler.mockClear()
    for (const host of ['pages.raditi.ru', 'Pages.Raditi.Ru:443']) {
      const response = await route(at(host), 'a')
      expect(response.status, host).toBe(404)
      expect(response.headers.get('set-cookie'), host).toBeNull()
      expect(response.headers.get('cache-control'), host).toBe('no-store')
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes the cabinet host and its arguments to the route', async () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('APP_URL', 'https://raditi.ru')
    vi.stubEnv('PAGES_BASE_DOMAIN', 'pages.raditi.ru')
    handler.mockClear()
    expect(await (await route(at('raditi.ru'), 'a')).json()).toEqual({ id: 'a' })
    // A label under the domain of pages is a page of plan 69, not this host.
    expect((await route(at('abc.pages.raditi.ru'), 'b')).status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('passes every host where there is no domain of pages', async () => {
    vi.stubEnv('PAGES_BASE_DOMAIN', '')
    handler.mockClear()
    expect((await route(at('pages.raditi.ru'), 'c')).status).toBe(200)
  })
})
