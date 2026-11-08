// The cabinet's frame of a preview for core's tests (docs/plan/62-site-stacks.md, Т35, step M2k):
// a Chromium of playwright-core and a page on the gateway's APP_URL that holds a preview in an
// iframe exactly as the cabinet does — the same sandbox, no referrer — so a test sees what a
// cross-site frame keeps of the site's cookies. Only for *.test.ts files, like preview-app.ts.
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'

import { PREVIEW_SANDBOX } from '@repo/domain'
import { chromium, type Frame, type FrameLocator, type Page } from 'playwright-core'

export interface CabinetFrameOptions {
  /** http://localhost:<port>: the gateway's APP_URL, the one ancestor it lets frame a preview. */
  appOrigin: string
  /** The entry the frame opens: previewEnterUrl(origin, ticket, to). */
  enterUrl: string
  /** The port the gateway listens on, when it differs from the public port of the address. */
  gatewayPort: number
}

export interface CabinetFrame {
  page: Page
  /** The frame of the preview inside the cabinet's page. */
  frame: FrameLocator
  /** A tab of the same browser: the control that a cookie without attributes lives at the top. */
  tab(enterUrl: string): Promise<Page>
  /** Whether the page keeps a cookie written from script with no attributes. */
  keepsPlainCookie(page: Page | Frame): Promise<boolean>
  close(): Promise<void>
}

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

/**
 * Opens the cabinet's page with the preview in its frame. Every host under `localhost` goes to
 * the gateway's own port on loopback (the public port of the address is another one), the
 * cabinet's page stays on `localhost` itself: the frame is cross-site, as in production.
 */
export async function openCabinetFrame(options: CabinetFrameOptions): Promise<CabinetFrame> {
  if (!existsSync(chromium.executablePath()))
    throw new Error('Chromium is missing: pnpm --filter e2e exec playwright install chromium')
  const app = new URL(options.appOrigin)
  const html =
    `<!doctype html><iframe src="${escapeAttribute(options.enterUrl)}" ` +
    `sandbox="${PREVIEW_SANDBOX}" referrerpolicy="no-referrer" ` +
    `style="width: 100%; height: 90vh; border: 0"></iframe>`
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  })
  server.listen(Number(app.port), '127.0.0.1')
  await once(server, 'listening')
  const closeServer = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  let browser
  try {
    browser = await chromium.launch({
      args: [`--host-rules=MAP *.localhost 127.0.0.1:${options.gatewayPort}`],
    })
  } catch (error) {
    await closeServer()
    throw error
  }
  let context
  let page
  try {
    context = await browser.newContext()
    page = await context.newPage()
    // Only the cabinet's own document: the frame's readiness is the test's to wait for, on its
    // own budget, and a slow frame must not fail here on Playwright's default load limit.
    await page.goto(`${app.origin}/`, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    try {
      await browser.close()
    } finally {
      await closeServer()
    }
    throw error
  }

  return {
    page,
    frame: page.frameLocator('iframe'),
    async tab(enterUrl) {
      const tab = await context.newPage()
      await tab.goto(enterUrl)
      return tab
    },
    async keepsPlainCookie(target) {
      const name = `raditi-plain-${randomBytes(6).toString('hex')}`
      return target.evaluate((cookie) => {
        // Runs in the page: core's types know no DOM.
        const { document } = globalThis as unknown as { document: { cookie: string } }
        document.cookie = `${cookie}=1`
        const kept = document.cookie
          .split('; ')
          .some((pair: string) => pair.startsWith(`${cookie}=`))
        document.cookie = `${cookie}=; Max-Age=0`
        return kept
      }, name)
    },
    async close() {
      try {
        await browser.close()
      } finally {
        await closeServer()
      }
    },
  }
}
