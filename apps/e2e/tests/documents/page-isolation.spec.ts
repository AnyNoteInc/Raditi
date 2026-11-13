import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect, test } from '@playwright/test'
import { PAGE_SANDBOX, pageContentSecurityPolicy } from '@repo/domain/preview/hostname'

// A page the agent made, framed by the cabinet from the domain of pages (docs/plan/67-agent-
// documents.md, Д3), in a real browser: the frame and the very CSP web sends (page-response.ts),
// served by a server of the test on two hosts of *.localhost. The page's own script tries what a
// hostile page would — the cabinet, its cookies, the network, a form, the top window — and gets
// nothing. Only Chromium and a free port: no database or web of the stand.

const HOSTILE = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт</title>
<h1>Отчёт</h1><img src="https://example.com/track.png"><form id="f" action="/steal" method="post"><input name="p" value="1"></form>
<script>
const tried = {}
try { tried.parent = String(parent.document.cookie) } catch (e) { tried.parent = 'blocked' }
try { tried.cookie = document.cookie } catch (e) { tried.cookie = 'blocked' }
try { tried.storage = String(localStorage.length) } catch (e) { tried.storage = 'blocked' }
tried.origin = self.origin
fetch('/v/other').then(() => { tried.fetch = 'done'; report() }, () => { tried.fetch = 'blocked'; report() })
try { document.getElementById('f').submit() } catch (e) {}
try { top.location.href = '/stolen' } catch (e) { tried.top = 'blocked' }
function report() { parent.postMessage(JSON.stringify(tried), '*') }
</script></html>`

let server: Server
let port = 0
const hits: string[] = []

test.beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(`${request.headers.host} ${request.method} ${request.url}`)
    const cabinet = `http://localhost:${port}`
    if (request.headers.host === `pages.localhost:${port}` && request.url === '/v/token') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': pageContentSecurityPolicy(cabinet, { scripts: true }),
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
      })
      response.end(HOSTILE)
      return
    }
    if (request.headers.host === `localhost:${port}` && request.url === '/chat') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'session=secret-of-the-cabinet; Path=/; SameSite=Lax',
      })
      response.end(`<!doctype html><title>Кабинет</title><script>
        window.reports = []
        addEventListener('message', (event) => window.reports.push({ origin: event.origin, data: event.data }))
      </script><iframe title="Страница" sandbox="${PAGE_SANDBOX}" referrerpolicy="no-referrer"
        src="http://pages.localhost:${port}/v/token" style="width:600px;height:400px"></iframe>`)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('a page of the agent reaches neither the cabinet nor the network', async ({ page }) => {
  await page.goto(`http://localhost:${port}/chat`)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { reports: unknown[] }).reports.length))
    .toBeGreaterThan(0)
  const [report] = await page.evaluate(
    () => (window as unknown as { reports: { origin: string; data: string }[] }).reports,
  )
  // An opaque origin: its message says «null», its document holds no cookie of anyone.
  expect(report!.origin).toBe('null')
  const tried = JSON.parse(report!.data) as Record<string, string>
  expect(tried.parent).toBe('blocked')
  expect(tried.cookie === '' || tried.cookie === 'blocked').toBe(true)
  expect(tried.storage).toBe('blocked')
  expect(tried.origin).toBe('null')
  expect(tried.fetch).toBe('blocked')
  // The cabinet stays where it was, and nothing but the page itself was asked for.
  expect(page.url()).toBe(`http://localhost:${port}/chat`)
  expect(hits.filter((hit) => hit.startsWith('pages.'))).toEqual([
    `pages.localhost:${port} GET /v/token`,
  ])
})
