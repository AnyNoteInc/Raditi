// Independent check of spike s8: a service worker that passes navigations through with
// fetch(event.request) does not put the fragment on the network; one that reports request.url
// does (the risk the plan names for sw.js). Chromium and WebKit of Playwright 1.63.0.
import http from 'node:http'
import { randomBytes } from 'node:crypto'

import { chromium, webkit } from 'playwright-core'

const seen = []
const SW = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  if (new URL(e.request.url).pathname === '/report') fetch('/sw-report?u=' + encodeURIComponent(e.request.url))
  e.respondWith(fetch(e.request))
})`
const server = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`)
  if (req.url === '/sw.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(SW)
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>t</title><p>page</p>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const results = []
for (const [type, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
  const browser = await type.launch({ headless: true })
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${origin}/`)
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
  })
  await page.reload()
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
  const pass = `SWP${randomBytes(6).toString('hex')}`
  const report = `SWR${randomBytes(6).toString('hex')}`
  const before = seen.length
  await page.goto(`${origin}/a#${pass}`)
  await page.goto(`${origin}/report#${report}`)
  await page.waitForTimeout(500)
  const lines = seen.slice(before)
  results.push({
    browser: name,
    version: browser.version(),
    controlled,
    passThroughLeaked: lines.some((l) => l.includes(pass)),
    reportingWorkerLeaked: lines.some((l) => l.includes(report)),
    lines: lines.map((l) => l.replace(pass, '<p>').replace(report, '<r>')),
  })
  await browser.close()
}
server.close()
console.log(JSON.stringify(results, null, 1))
