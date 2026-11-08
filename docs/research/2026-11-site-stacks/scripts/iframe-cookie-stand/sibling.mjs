import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { chromium, webkit } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const PORT = 18443, log = []
const s = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
  const u = new URL(req.url, 'https://x'); const host = (req.headers.host ?? '').split(':')[0]
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
  if (u.pathname === '/cabinet') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>cab</title><iframe sandbox="${SANDBOX}" src="${u.searchParams.get('src')}"></iframe>`) }
  if (u.pathname === '/set') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['sess=1; Path=/; HttpOnly; SameSite=None; Secure; Partitioned'] }); return res.end('<!doctype html>set') }
  if (u.pathname === '/target') { log.push({ host, method: req.method, cookie: req.headers.cookie ?? '', site: req.headers['sec-fetch-site'], mode: req.headers['sec-fetch-mode'], dest: req.headers['sec-fetch-dest'] }); req.resume() }
  res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }); res.end('<!doctype html><title>ok</title><form id=f method=post target=_self></form>')
}).listen(PORT, '127.0.0.1')
const proxy = http.createServer((_q, r) => { r.writeHead(405); r.end() })
proxy.on('connect', (req, socket, head) => { const up = net.connect(PORT, '127.0.0.1', () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up) }); up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()) })
proxy.listen(18888, '127.0.0.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = async (p) => { for (let i = 0; i < 200; i++) { const f = p.frames().find((x) => x !== p.mainFrame()); if (f && f.url() !== 'about:blank' && f.url() !== '') return f; await sleep(50) } throw new Error('no frame') }
const VICTIM = `https://site-a-chat-b.raditi-preview.ru:${PORT}`
const show = (e) => e ? `Sec-Fetch-Site=${e.site} mode=${e.mode} dest=${e.dest} ${e.method} cookie=${e.cookie || '(нет)'}` : '(запрос не дошёл)'
async function run(name, type, opts) {
  const b = await type.launch({ headless: true, ...opts })
  console.log(`\n## ${name} ${b.version()}`)
  const c = await b.newContext({ ignoreHTTPSErrors: true })
  const p = await c.newPage()
  await p.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(VICTIM + '/set')}`); await sleep(400)
  for (const [label, attacker] of [['сосед на том же регистрируемом домене (сегодня)', `https://site-c-chat-d.raditi-preview.ru:${PORT}`], ['сосед на другом регистрируемом домене (как после PSL)', `https://site-e-chat-f.other-preview.ru:${PORT}`]]) {
    await p.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(attacker + '/page')}`)
    const f = await child(p); await f.waitForLoadState()
    log.length = 0
    await f.evaluate(async (v) => { await fetch(v + '/target', { credentials: 'include', mode: 'no-cors' }).catch(() => undefined) }, VICTIM); await sleep(250)
    console.log(`${label}\n  fetch: ${show(log.at(-1))}`)
    log.length = 0
    await f.evaluate((v) => { const x = document.getElementById('f'); x.action = v + '/target'; x.submit() }, VICTIM); await sleep(400)
    console.log(`  POST формы: ${show(log.at(-1))}`)
  }
  log.length = 0
  await p.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(VICTIM + '/target')}`); await sleep(400)
  console.log(`вход из кабинета в кадр: ${show(log.at(-1))}`)
  await b.close()
}
try { await run('Chromium', chromium, { args: ['--host-resolver-rules=MAP * 127.0.0.1'] }); await run('WebKit', webkit, { proxy: { server: 'http://127.0.0.1:18888' } }) } finally { s.close(); proxy.close(); s.closeAllConnections(); proxy.closeAllConnections() }
