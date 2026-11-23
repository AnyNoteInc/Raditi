// Independent check: does Playwright's route.fulfill hide a missing Access-Control-Allow-Origin
// on a font a sandboxed (opaque-origin) document asks for? (skeptic of spike s3, plan 88)
//   node v2-acao.mjs <woff2 file>
// The document comes from one loopback server with the frame's CSP sandbox; the font from a second
// one (another origin) — either for real or answered by context.route without touching the server.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const font = readFileSync(process.argv[2])
const listen = (handler) => new Promise((resolve) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)) })
const fontHits = []
const fonts = await listen((req, res) => {
  fontHits.push({ url: req.url, origin: req.headers.origin || null })
  const headers = { 'content-type': 'font/woff2', 'cross-origin-resource-policy': 'cross-origin' }
  if (req.url.includes('acao=1')) headers['access-control-allow-origin'] = '*'
  res.writeHead(200, headers)
  res.end(font)
})
const fontOrigin = `http://127.0.0.1:${fonts.address().port}`
const doc = (q) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
@font-face { font-family: Probe; src: url("${fontOrigin}/golos.woff2?${q}") format("woff2"); }
body { font: 32px Probe, monospace }</style></head><body><p>Съешь же ещё этих мягких булок</p><pre id="out">…</pre>
<script>document.fonts.load('32px Probe').then(() => { document.getElementById('out').textContent = [...document.fonts].map((f) => f.family + ':' + f.status).join(',') }, (e) => { document.getElementById('out').textContent = 'error ' + e.name })</script></body></html>`
const pages = await listen((req, res) => {
  const q = new URL(req.url, 'http://x').search.slice(1)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src ${fontOrigin}` })
  res.end(doc(q))
})
const pageOrigin = `http://127.0.0.1:${pages.address().port}`

const browser = await chromium.launch({ headless: true })
const out = { chromium: browser.version(), cases: {} }
for (const [name, viaRoute, acao] of [['server, no ACAO', false, false], ['server, ACAO *', false, true], ['route.fulfill, no ACAO', true, false], ['route.fulfill, ACAO *', true, true]]) {
  const ctx = await browser.newContext()
  let routed = null
  if (viaRoute) {
    await ctx.route(`${fontOrigin}/**`, async (route) => {
      routed = { origin: route.request().headers().origin || null }
      const headers = { 'content-type': 'font/woff2', 'cross-origin-resource-policy': 'cross-origin' }
      if (acao) headers['access-control-allow-origin'] = '*'
      const response = await route.fulfill({ status: 200, headers, body: font })
      return response
    })
  }
  const page = await ctx.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)) })
  const q = `case=${encodeURIComponent(name)}&acao=${acao ? 1 : 0}`
  await page.goto(`${pageOrigin}/?${q}`)
  await page.waitForFunction(() => document.getElementById('out').textContent !== '…', null, { timeout: 4000 }).catch(() => {})
  out.cases[name] = { fonts: await page.$eval('#out', (e) => e.textContent), routedRequestOrigin: routed && routed.origin, consoleErrors }
  await ctx.close()
}
out.serverSaw = fontHits
await browser.close()
fonts.close(); pages.close()
console.log(JSON.stringify(out, null, 1))
