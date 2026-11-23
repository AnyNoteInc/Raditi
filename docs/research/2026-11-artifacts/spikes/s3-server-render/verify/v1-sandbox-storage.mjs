// Independent check of the s3 claims about the frame sandbox (spike s3 of plan 88, skeptic).
// Another path than the harness: a real HTTP server on loopback, plain chromium.launch, no routes,
// the product's own policy strings imported from packages/domain/src/pages/headers.ts.
//   node v1-sandbox-storage.mjs <repo root> <calculator fixture>
// Prints JSON: storage APIs and the calculator's total under each policy, the iframe attribute
// sandbox (the cabinet's /v/ frame), and a meta CSP sandbox, which CSP ignores.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [repo, calculatorPath] = process.argv.slice(2)
const { pagePolicy } = await import(join(repo, 'packages/domain/src/pages/headers.ts'))
const calculator = readFileSync(calculatorPath, 'utf8')
const CABINET = 'http://localhost:1'

const policies = {
  none: null,
  published: pagePolicy('html'), // a published page (plan 69)
  framed: pagePolicy('html', CABINET), // a page of a chat framed by the cabinet (plan 67)
  artifact: pagePolicy('html', CABINET).replace('allow-scripts allow-popups allow-popups-to-escape-sandbox', 'allow-scripts'), // Ар28
}

const PROBE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>probe</title></head><body><pre id="out">…</pre>
<script>
  const r = {}
  const t = (name, fn) => { try { const v = fn(); r[name] = 'ok' + (v === undefined ? '' : ':' + String(v).slice(0, 20)) } catch (e) { r[name] = e.name } }
  t('origin', () => self.origin)
  t('localStorage', () => { localStorage.setItem('k', 'v'); return localStorage.getItem('k') })
  t('sessionStorage', () => { sessionStorage.setItem('k', 'v'); return sessionStorage.getItem('k') })
  t('cookie', () => { document.cookie = 'a=b'; return document.cookie })
  t('indexedDB', () => indexedDB.open('x') && 'opened')
  t('caches', () => typeof caches)
  t('serviceWorker', () => navigator.serviceWorker.register('/sw.js') && 'called')
  // A script that guards its storage keeps going.
  let guarded = 'stopped'
  try { localStorage.getItem('x') } catch (e) { /* the sandbox */ }
  guarded = 'went on'
  r.guarded = guarded
  document.getElementById('out').textContent = JSON.stringify(r)
</script></body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const policy = policies[url.searchParams.get('policy') || 'none']
  const headers = { 'content-type': 'text/html; charset=utf-8', ...(policy ? { 'content-security-policy': policy } : {}) }
  if (url.pathname === '/probe') { res.writeHead(200, headers); return res.end(PROBE) }
  if (url.pathname === '/calc') { res.writeHead(200, headers); return res.end(calculator) }
  if (url.pathname === '/meta') {
    // The sandbox directive in a meta element: CSP ignores it there.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(PROBE.replace('<title>', '<meta http-equiv="Content-Security-Policy" content="sandbox allow-scripts"><title>'))
  }
  if (url.pathname === '/parent') {
    // The cabinet's frame: the sandbox attribute alone (the child answer carries no CSP).
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><iframe id="f" sandbox="${url.searchParams.get('sandbox')}" src="/${url.searchParams.get('child')}?policy=none" style="width:1200px;height:900px"></iframe>`)
  }
  res.writeHead(404); res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
const out = { chromium: browser.version(), top: {}, iframe: {}, meta: null }
const read = async (frame, selector) => {
  await frame.waitForFunction((s) => { const e = document.querySelector(s); return e && e.textContent !== '…' && e.textContent !== '—' }, selector, { timeout: 2500 }).catch(() => {})
  return frame.$eval(selector, (e) => e.textContent).catch((e) => `error: ${e.message.slice(0, 80)}`)
}
const parse = (t) => { try { return JSON.parse(t) } catch { return { raw: t } } }

for (const name of Object.keys(policies)) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)))
  await page.goto(`${origin}/probe?policy=${name}`)
  const probe = parse(await read(page, '#out'))
  await page.goto(`${origin}/calc?policy=${name}`)
  const total = await read(page, '#total')
  out.top[name] = { probe, calculatorTotal: total, calculatorErrors: errors }
  await ctx.close()
}
for (const sandbox of ['allow-scripts', 'allow-scripts allow-popups allow-popups-to-escape-sandbox']) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)))
  await page.goto(`${origin}/parent?sandbox=${encodeURIComponent(sandbox)}&child=probe`)
  await page.waitForTimeout(300)
  const probe = parse(await read(page.frames()[1], '#out'))
  await page.goto(`${origin}/parent?sandbox=${encodeURIComponent(sandbox)}&child=calc`)
  await page.waitForTimeout(300)
  const total = await read(page.frames()[1], '#total')
  out.iframe[sandbox] = { probe, calculatorTotal: total, calculatorErrors: errors }
  await ctx.close()
}
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(`${origin}/meta`)
  // page.setContent carries no header: the most it could carry is this meta element (v1b-setcontent.mjs).
  out.meta = parse(await read(page, '#out'))
  await ctx.close()
}
await browser.close()
server.close()
console.log(JSON.stringify(out, null, 1))
