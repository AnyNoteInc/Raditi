// Spike s8, a side check: a service worker with a fetch handler sees the fragment of a navigation
// in event.request.url (the network never does). The cabinet's sw.js has no fetch handler today.
//   node sw-fragment.mjs [--out <file.json>]
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { chromium, webkit } from 'playwright-core'

import { marker } from './lib.mjs'

const { values } = parseArgs({ options: { out: { type: 'string' } } })
const seen = []
const SW = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  e.respondWith(new Response('sw saw ' + e.request.url, { headers: { 'content-type': 'text/plain' } }))
})`
const server = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`)
  if (req.url === '/sw.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(SW)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>s8</title><p>page</p>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
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
  const token = marker('F', `sw${name.slice(0, 2)}`)
  const before = seen.length
  await page.goto(`${origin}/a#${token}`)
  const text = await page.textContent('body')
  results.push({
    browser: name,
    version: browser.version(),
    serviceWorkerSawToken: text.includes(token),
    networkLines: seen.slice(before),
    networkSawToken: seen.slice(before).some((l) => l.includes(token)),
  })
  await browser.close()
}
server.close()
const out = { results }
if (values.out) writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out, null, 2))
