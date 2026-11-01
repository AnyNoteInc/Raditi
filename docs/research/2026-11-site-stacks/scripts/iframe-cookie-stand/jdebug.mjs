import http from 'node:http'
import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const JM = 'http://site-gap10j-chat-a.localhost:28191'
const px = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: 28191, method: req.method, path: req.url, headers: req.headers }, (r) => {
    const out = { ...r.headers }; const xfo = out['x-frame-options']; delete out['x-frame-options']
    if (!/\.(js|css|png|svg|woff2?)/.test(req.url)) console.log(req.method, req.url.slice(0, 70), '→', r.statusCode, 'loc=', out.location ?? '-', 'xfo=', xfo ?? '-', 'csp=', out['content-security-policy'] ?? '-', 'cookie-in=', (req.headers.cookie ?? '').slice(0, 40), 'set=', (out['set-cookie'] ?? []).length)
    res.writeHead(r.statusCode, out); r.pipe(res)
  })
  up.on('error', (e) => { console.log('UPERR', e.message); res.writeHead(502); res.end('upstream') })
  req.pipe(up)
}).listen(18191, '127.0.0.1')
const cab = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><iframe id=f sandbox="${SANDBOX}" referrerpolicy=no-referrer src="${url.searchParams.get('src')}" style="width:1100px;height:800px"></iframe>`) }).listen(18080, '127.0.0.1')
const b = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP site-gap10j-chat-a.localhost 127.0.0.1:18191'] })
const c = await b.newContext(); const p = await c.newPage()
p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 200)))
p.on('requestfailed', (r) => console.log('FAILED', r.method(), r.url().slice(0, 90), r.failure()?.errorText))
await p.goto(`http://localhost:18080/x?src=${encodeURIComponent(JM + '/index.php?option=com_users&view=login')}`)
let f; for (let i = 0; i < 100 && !f; i++) { f = p.frames().find((x) => x !== p.mainFrame()); await new Promise((r) => setTimeout(r, 50)) }
await f.waitForSelector('#username')
await f.fill('#username', 'nobody'); await f.fill('#password', '<hidden>')
console.log('form action', await f.evaluate(() => { const x = document.querySelector('form.com-users-login__form, #com-users-login__form, form[action*="login"]'); return x?.action + ' id=' + x?.id }))
await f.evaluate(() => document.querySelector('form.com-users-login__form, #com-users-login__form, form[action*="login"]').requestSubmit())
await new Promise((r) => setTimeout(r, 3000))
console.log('frame url', f.url()); console.log((await f.locator('body').innerText().catch(() => '(нет)')).replace(/\s+/g, ' ').slice(0, 300))
await b.close(); px.close(); cab.close(); px.closeAllConnections(); cab.closeAllConnections()
