// The same matrix on Firefox and on Playwright's WebKit; hostnames reach the stand through a CONNECT proxy.
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { firefox, webkit } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const PORT = 18443
const log = []
const COOKIES = [
  'sc_plain=1; Path=/', 'sc_lax=1; Path=/; SameSite=Lax', 'sc_strict=1; Path=/; SameSite=Strict',
  'sc_none_insecure=1; Path=/; SameSite=None', 'sc_none=1; Path=/; SameSite=None; Secure',
  'sc_chips=1; Path=/; SameSite=None; Secure; Partitioned',
]
const JS = `document.cookie='js_plain=1; path=/';document.cookie='js_lax=1; path=/; SameSite=Lax';document.cookie='js_none=1; path=/; SameSite=None; Secure';document.cookie='js_chips=1; path=/; SameSite=None; Secure; Partitioned';`
const handler = (req, res) => {
  const url = new URL(req.url, 'https://x'); const host = (req.headers.host ?? '').split(':')[0]
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
  log.push({ host, path: url.pathname, cookie: req.headers.cookie ?? '' })
  if (url.pathname === '/cabinet') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>cabinet</title><iframe id=f sandbox="${SANDBOX}" referrerpolicy=no-referrer src="${url.searchParams.get('src')}" width=600 height=400></iframe>`) }
  if (url.pathname === '/set') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': COOKIES }); return res.end(`<!doctype html><title>set</title><script>${JS}</script><p>set</p>`) }
  if (url.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>page</title><form id=f method=post action=/post><button>go</button></form>`) }
  if (url.pathname === '/post') { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>posted</title>ok') }); return }
  if (url.pathname === '/echo') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' })) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>ok')
}
const server = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, handler).listen(PORT, '127.0.0.1')
const proxy = http.createServer((_q, s) => { s.writeHead(405); s.end() })
proxy.on('connect', (req, socket, head) => { const up = net.connect(PORT, '127.0.0.1', () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up) }); up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()) })
proxy.listen(18888, '127.0.0.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const names = (c) => (c ?? '').split(';').map((s) => s.trim().split('=')[0]).filter(Boolean).sort().join(' ') || '(нет)'
const last = (p) => log.filter((e) => e.path === p).at(-1)
const child = async (page) => { for (let i = 0; i < 100; i++) { const f = page.frames().find((x) => x !== page.mainFrame()); if (f && f.url() !== 'about:blank') return f; await sleep(50) } throw new Error('no frame') }
async function run(name, type, opts) {
  const browser = await type.launch({ headless: true, proxy: { server: 'http://127.0.0.1:18888' }, ...opts })
  console.log(`\n## ${name} ${browser.version()}`)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const A = `https://site-a-chat-b.raditi-preview.ru:${PORT}`
  await page.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(A + '/set')}`)
  let f = await child(page); await f.waitForLoadState(); await sleep(200)
  console.log('document.cookie в кадре:', await f.evaluate(() => document.cookie.split('; ').map((s) => s.split('=')[0]).sort().join(' ')))
  await f.evaluate(() => { location.href = '/page' }); await sleep(500); f = await child(page)
  console.log('навигация кадра:', names(last('/page').cookie))
  console.log('fetch кадра:', names((await f.evaluate(async () => (await fetch('/echo', { credentials: 'include' })).json())).cookie))
  await f.evaluate(() => document.getElementById('f').submit()); await sleep(400)
  console.log('POST формы:', names(last('/post')?.cookie))
  const tab = await context.newPage(); await tab.goto(`${A}/page`); await sleep(200)
  console.log('отдельная вкладка видит:', names(last('/page').cookie))
  await tab.goto(`${A}/set`); await tab.goto(`${A}/page`); await sleep(200)
  console.log('отдельная вкладка после записи:', names(last('/page').cookie))
  await tab.close()
  const evil = await context.newPage()
  await evil.goto(`https://evil.example:${PORT}/cabinet?src=${encodeURIComponent(A + '/page')}`); await sleep(500)
  console.log('кадр чужого сайта:', names(last('/page').cookie))
  await browser.close()
}
try {
  await run('Firefox (ETP Standard: cookieBehavior 5, CHIPS on)', firefox, { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5, 'network.cookie.CHIPS.enabled': true } }).catch((e) => console.log('firefox:', e.message.slice(0, 300)))
  if (process.env.WK) await run('Playwright WebKit', webkit, {}).catch((e) => console.log('webkit:', e.message.slice(0, 300)))
} finally { server.close(); proxy.close(); server.closeAllConnections(); proxy.closeAllConnections() }
