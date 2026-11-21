// Each of the harness's two lines alone, without the frame CSP and with Chromium's Local Network
// Access checks off, so a loopback trap sees what would leave (skeptic of spike s3, plan 88).
//   route only — the harness's route (document, fonts, 204 for navigations, abort the rest), no proxy
//   proxy only — every request goes on to the network, through the closed proxy 127.0.0.1:9
//   node v14b-each-line.mjs <harness dir>
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = process.argv[2]
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { assembleFrame, ensureAssets, DOC_URL } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, chromiumArgs } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)
const trap = { connections: 0, requests: [] }
const server = createServer((req, res) => { trap.requests.push(`${req.method} ${req.url.split('?')[0]}`); res.end('trap') })
server.on('connection', () => { trap.connections++ })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const boot = await launch(chromium)
const assets = await ensureAssets(boot.browser)
await boot.browser.close(); await boot.server.close()
const frame = assembleFrame('h1-network', { assets, trap: `http://127.0.0.1:${server.address().port}` })
const LNA_OFF = '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'
const out = {}
for (const kind of ['route only', 'proxy only']) {
  const c0 = trap.connections, r0 = trap.requests.length
  const browser = await chromium.launch({ headless: true, args: [...chromiumArgs(), LNA_OFF], proxy: kind === 'proxy only' ? { server: 'http://127.0.0.1:9', bypass: '<-loopback>' } : undefined })
  const ctx = await browser.newContext()
  await ctx.route('**/*', (route) => {
    const r = route.request()
    if (r.url() === DOC_URL) return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: frame.html })
    if (kind === 'proxy only') return route.continue()
    let leaving = false
    try { leaving = r.isNavigationRequest() && r.frame().parentFrame() === null } catch {}
    return leaving ? route.fulfill({ status: 204, body: '' }) : route.abort('blockedbyclient')
  })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.dismiss().catch(() => {}))
  page.on('popup', (p) => p.close().catch(() => {}))
  await page.goto(DOC_URL, { waitUntil: 'commit' }).catch(() => {})
  await page.waitForTimeout(2500)
  await browser.close()
  out[kind] = { connections: trap.connections - c0, requests: [...new Set(trap.requests.slice(r0))].sort() }
}
server.close()
console.log(JSON.stringify(out, null, 1))
