import https from 'node:https'
import { readFileSync } from 'node:fs'
import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const seen = []
const s = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
  const u = new URL(req.url, 'https://x')
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
  if (u.pathname === '/cabinet') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><iframe sandbox="${SANDBOX}" src="${u.searchParams.get('src')}"></iframe>`) }
  if (u.pathname === '/set') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['sc_none=1; Path=/; SameSite=None; Secure', 'sc_chips=1; Path=/; SameSite=None; Secure; Partitioned'] }); return res.end(`<!doctype html><script>document.cookie='js_none=1; path=/; SameSite=None; Secure';document.cookie='js_chips=1; path=/; SameSite=None; Secure; Partitioned'</script>`) }
  seen.push(req.headers.cookie ?? ''); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>ok')
}).listen(18443, '127.0.0.1')
const b = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-features'], args: ['--host-resolver-rules=MAP * 127.0.0.1'] })
const c = await b.newContext({ ignoreHTTPSErrors: true })
const p = await c.newPage()
const cdp = await c.newCDPSession(p)
await cdp.send('Network.enable')
try { await cdp.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true, disableThirdPartyCookieMetadata: true, disableThirdPartyCookieHeuristics: true }); console.log('setCookieControls ok') } catch (e) { console.log('setCookieControls:', e.message) }
const A = 'https://site-a-chat-b.raditi-preview.ru:18443'
await p.goto(`https://raditi.ru:18443/cabinet?src=${encodeURIComponent(A + '/set')}`); await new Promise((r) => setTimeout(r, 500))
await p.reload(); await new Promise((r) => setTimeout(r, 500))
const f = p.frames().find((x) => x !== p.mainFrame())
await f.evaluate(() => { location.href = '/page' }); await new Promise((r) => setTimeout(r, 600))
console.log('сторонние заблокированы, навигация кадра, Cookie:', seen.at(-1) || '(нет)')
await b.close(); s.close(); s.closeAllConnections()
