import { isPageBrowserError, type PageBrowserConnection } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { createPlaywrightBrowserFactory } from './playwright.ts'

// What the adapter refuses before it reaches a browser; its work on a real one is
// playwright.integration.test.ts.

const ORIGIN = 'http://site-0a1b2c3d-chat-0a1b2c.localhost:8090'
const SECRET_PATH = `/${'s'.repeat(43)}`
const connection: PageBrowserConnection = {
  endpoint: { wsEndpoint: `ws://127.0.0.1:9222${SECRET_PATH}` },
  origin: ORIGIN,
  enterUrl: `${ORIGIN}/__raditi/enter?t=${'T'.repeat(43)}&to=%2F`,
  denyRequest: () => false,
}

describe('the Playwright page browser', () => {
  it('connects only to a control socket on loopback and enters only through the preview', async () => {
    const connect = vi.fn(async () => {
      throw new Error('never reached')
    })
    const factory = createPlaywrightBrowserFactory({ connect })
    for (const wrong of [
      { endpoint: { wsEndpoint: `ws://10.0.0.1:9222${SECRET_PATH}` } },
      { endpoint: { wsEndpoint: `wss://127.0.0.1:9222${SECRET_PATH}` } },
      { endpoint: { wsEndpoint: `http://127.0.0.1:9222${SECRET_PATH}` } },
      { origin: `${ORIGIN}/path` },
      { origin: 'file:///etc' },
      { enterUrl: `http://elsewhere.example/__raditi/enter?t=${'T'.repeat(43)}&to=%2F` },
      { enterUrl: `${ORIGIN}/wp-login.php` },
    ])
      await expect(factory.connect({ ...connection, ...wrong })).rejects.toThrow(
        'Invalid page browser connection',
      )
    expect(connect).not.toHaveBeenCalled()
  })

  it('says a browser it cannot reach is closed, and never names its secret path', async () => {
    const connect = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ws://127.0.0.1:9222${SECRET_PATH}`)
    })
    const error = await createPlaywrightBrowserFactory({ connect, connectTimeoutMs: 1_234 })
      .connect(connection)
      .catch((caught: unknown) => caught)
    expect(isPageBrowserError(error) && error.reason).toBe('closed')
    expect(String((error as Error).message)).not.toContain(SECRET_PATH)
    expect(connect).toHaveBeenCalledExactlyOnceWith(connection.endpoint.wsEndpoint, {
      timeout: 1_234,
    })
  })

  it('takes an entry for one only when the gateway traded the ticket for a redirect', async () => {
    // A minimal browser: the page lands where `landing` says, by the chain `redirected` says.
    const fake = (landing: { url: string; redirected: boolean; status: number }) => {
      let url = 'about:blank'
      const page = {
        on: vi.fn(),
        url: () => url,
        isClosed: () => false,
        mainFrame: () => ({}),
        goto: vi.fn(async () => {
          url = landing.url
          return {
            status: () => landing.status,
            request: () => ({ redirectedFrom: () => (landing.redirected ? {} : null) }),
          }
        }),
      }
      const context = {
        setDefaultTimeout: vi.fn(),
        setDefaultNavigationTimeout: vi.fn(),
        route: vi.fn(async () => undefined),
        on: vi.fn(),
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => undefined),
      }
      const browser = {
        newContext: vi.fn(async () => context),
        isConnected: () => true,
        close: vi.fn(async () => undefined),
      }
      return { browser, connect: vi.fn(async () => browser as never) }
    }
    // A spent or expired ticket: the gateway answers on the entry path, here with 403.
    for (const landing of [
      { url: connection.enterUrl, redirected: false, status: 403 },
      { url: connection.enterUrl, redirected: false, status: 200 },
      // A redirect that ends elsewhere than the preview is no entry either.
      { url: 'http://elsewhere.example/', redirected: true, status: 200 },
    ]) {
      const { browser, connect } = fake(landing)
      const error = await createPlaywrightBrowserFactory({ connect })
        .connect(connection)
        .catch((caught: unknown) => caught)
      expect(isPageBrowserError(error) && error.reason, landing.url).toBe('denied')
      expect(browser.close).toHaveBeenCalled()
    }
    // Entered: the gateway redirected to the page of the ticket, even one that answers 500.
    const { browser, connect } = fake({ url: `${ORIGIN}/`, redirected: true, status: 500 })
    const opened = await createPlaywrightBrowserFactory({ connect }).connect(connection)
    expect(opened.isConnected()).toBe(true)
    expect(browser.close).not.toHaveBeenCalled()
  })

  it('asks a navigation again once when the error page of a refusal took it over and it never landed', async () => {
    let url = 'about:blank'
    const response = {
      status: () => 200,
      request: () => ({ redirectedFrom: () => ({}) }),
    }
    const interrupted = (to: string) =>
      new Error(
        `page.goto: Navigation to "${ORIGIN}/about/" is interrupted by another navigation to "${to}"`,
      )
    const goto = vi
      .fn<(target: string) => Promise<typeof response>>()
      // The entry through the gateway.
      .mockImplementationOnce(async () => {
        url = `${ORIGIN}/`
        return response
      })
      .mockImplementationOnce(async () => {
        throw interrupted('chrome-error://chromewebdata/')
      })
      .mockImplementationOnce(async (target) => {
        url = target
        return response
      })
      // A page of the site that navigates on its own is not asked again.
      .mockImplementationOnce(async () => {
        throw interrupted(`${ORIGIN}/elsewhere/`)
      })
    const page = {
      on: vi.fn(),
      url: () => url,
      title: async () => 'О нас',
      isClosed: () => false,
      mainFrame: () => ({}),
      waitForLoadState: vi.fn(async () => undefined),
      // The interrupted navigation never lands: the browser asks for it again.
      waitForURL: vi.fn(async () => {
        throw new Error('page.waitForURL: Timeout 5000ms exceeded.')
      }),
      goto,
    }
    const context = {
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      route: vi.fn(async () => undefined),
      on: vi.fn(),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }
    const browser = { newContext: vi.fn(async () => context), isConnected: () => true }
    const opened = await createPlaywrightBrowserFactory({
      connect: vi.fn(async () => browser as never),
    }).connect(connection)

    expect(await opened.navigate({ path: '/about/' })).toMatchObject({ path: '/about/' })
    expect(goto).toHaveBeenCalledTimes(3)
    expect(page.waitForURL).toHaveBeenCalledTimes(1)
    await expect(opened.navigate({ path: '/about/' })).rejects.toThrow()
    expect(goto).toHaveBeenCalledTimes(4)
  })

  // The navigation an error page interrupted goes on and lands a moment later: asked again at once,
  // it would interrupt the repeat in turn (preview.yml on GitHub's runners, 30.10.2026).
  it('waits for a navigation the error page of a refusal interrupted instead of asking it again', async () => {
    let url = 'about:blank'
    const response = {
      status: () => 200,
      request: () => ({ redirectedFrom: () => ({}) }),
    }
    const goto = vi
      .fn<(target: string) => Promise<typeof response>>()
      // The entry through the gateway.
      .mockImplementationOnce(async () => {
        url = `${ORIGIN}/`
        return response
      })
      .mockImplementationOnce(async () => {
        throw new Error(
          `page.goto: Navigation to "${ORIGIN}/about/" is interrupted by another navigation to "chrome-error://chromewebdata/"`,
        )
      })
    const page = {
      on: vi.fn(),
      url: () => url,
      title: async () => 'О нас',
      isClosed: () => false,
      mainFrame: () => ({}),
      waitForLoadState: vi.fn(async () => undefined),
      // The interrupted navigation lands.
      waitForURL: vi.fn(async (target: string) => {
        url = target
      }),
      goto,
    }
    const context = {
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      route: vi.fn(async () => undefined),
      on: vi.fn(),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }
    const browser = { newContext: vi.fn(async () => context), isConnected: () => true }
    const opened = await createPlaywrightBrowserFactory({
      connect: vi.fn(async () => browser as never),
    }).connect(connection)

    expect(await opened.navigate({ path: '/about/' })).toMatchObject({ path: '/about/' })
    expect(goto).toHaveBeenCalledTimes(2)
    expect(page.waitForURL).toHaveBeenCalledWith(
      `${ORIGIN}/about/`,
      expect.objectContaining({ waitUntil: 'load' }),
    )
  })

  it('does not connect for a call already given up', async () => {
    const connect = vi.fn()
    const signal = AbortSignal.abort()
    await expect(
      createPlaywrightBrowserFactory({ connect }).connect(connection, signal),
    ).rejects.toBeDefined()
    expect(connect).not.toHaveBeenCalled()
  })
})
