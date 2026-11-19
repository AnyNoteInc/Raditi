// Positive controls for «the network is closed by two lines» (skeptic of spike s3, plan 88). The
// harness proves 0 connections reach its loopback trap, but never shows the trap would see them
// with a line removed. Here the hostile frame h1-network runs with each line taken away in turn:
//   A. no CSP, no route block, no proxy        — the trap must see the frame's requests
//   B. the frame CSP only (route lets all through, no proxy) — what the CSP alone stops
//   C. CSP and the closed proxy, route lets all through     — the proxy line alone behind the CSP
//   D. the harness as is (route + proxy + CSP)
//   A2/B2 — A and B with Chromium's Local Network Access checks off: a public origin asking
//   for a loopback address is refused by Chromium itself, which blinds a loopback trap
//   node v14-network-lines.mjs <harness dir>
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.argv[2]
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { assembleFrame, ensureAssets, DOC_URL } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, renderFrame, framePolicy, chromiumArgs } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)

const trap = { connections: 0, requests: [] }
const server = createServer((req, res) => { trap.requests.push(`${req.method} ${req.url.split('?')[0]}`); res.end('trap') })
server.on('connection', () => { trap.connections++ })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const trapOrigin = `http://127.0.0.1:${server.address().port}`

const boot = await launch(chromium)
const assets = await ensureAssets(boot.browser)
await boot.browser.close(); await boot.server.close()
const frame = assembleFrame('h1-network', { assets, trap: trapOrigin })

async function open(kind) {
  const proxy = kind === 'C' ? { server: 'http://127.0.0.1:9', bypass: '<-loopback>' } : undefined
  const lna = kind.endsWith('2') ? ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'] : []
  const browser = await chromium.launch({ headless: true, args: [...chromiumArgs(), ...lna], proxy })
  const ctx = await browser.newContext()
  const policy = kind.startsWith('A') ? null : framePolicy()
  await ctx.route('**/*', (route) => {
    if (route.request().url() === DOC_URL) return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(policy ? { 'content-security-policy': policy } : {}) }, body: frame.html })
    return route.continue()
  })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.dismiss().catch(() => {}))
  page.on('popup', (p) => p.close().catch(() => {}))
  await page.goto(DOC_URL, { waitUntil: 'commit' }).catch(() => {})
  await page.waitForTimeout(2500)
  await browser.close()
}
const out = {}
for (const kind of ['A', 'A2', 'B', 'B2', 'C']) {
  const c0 = trap.connections, r0 = trap.requests.length
  await open(kind)
  out[kind] = { connections: trap.connections - c0, requests: [...new Set(trap.requests.slice(r0))].sort() }
}
{
  const c0 = trap.connections, r0 = trap.requests.length
  const { browser, server: s } = await launch(chromium)
  const r = await renderFrame(browser, frame, { width: 1440, assets, outputs: { png: true } })
  await new Promise((res) => setTimeout(res, 1500))
  await browser.close(); await s.close()
  out.D = { connections: trap.connections - c0, requests: trap.requests.slice(r0), navigationsHeld: r.events.navigations.length, cspRefusals: r.events.csp.length }
}
server.close()
console.log(JSON.stringify(out, null, 1))
