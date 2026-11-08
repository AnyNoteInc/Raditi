import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { chromium, webkit } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const PORT = 18443, seen = []
const SHIM = `(()=>{const d=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');Object.defineProperty(document,'cookie',{configurable:true,get(){return d.get.call(document)},set(v){if(!/;\\s*partitioned/i.test(v))v=v.replace(/;\\s*samesite=[^;]*/ig,'').replace(/;\\s*secure/ig,'')+'; SameSite=None; Secure; Partitioned';d.set.call(document,v)}})})()`
const s = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
  const u = new URL(req.url, 'https://x')
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
  if (u.pathname === '/cabinet') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>cab</title><iframe sandbox="${SANDBOX}" referrerpolicy=no-referrer src="${u.searchParams.get('src')}"></iframe>`) }
  if (u.pathname === '/gw') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['__Host-raditi-preview=sess.mac; HttpOnly; Secure; SameSite=None; Partitioned; Path=/', '__Host-raditi-preview-rev=5; Max-Age=2678400; HttpOnly; Secure; SameSite=None; Partitioned; Path=/'] }); return res.end('<!doctype html><title>gw</title>') }
  if (u.pathname === '/shim') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>shim</title><script>${SHIM}</script><script>document.cookie='consent=yes; path=/';document.cookie='theme=dark; path=/; max-age=3600; SameSite=Lax';</script>`) }
  if (u.pathname === '/noshim') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>noshim</title><script>document.cookie='consent2=yes; path=/'</script>`) }
  if (u.pathname === '/dialogs') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>dialogs</title><script>let a,p;try{a=window.confirm('x')}catch(e){a='throw '+e.name}try{p=window.prompt('x','v')}catch(e){p='throw '+e.name}document.title='confirm='+a+' prompt='+p</script>`) }
  seen.push(req.headers.cookie ?? ''); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>page</title>ok')
}).listen(PORT, '127.0.0.1')
const proxy = http.createServer((_q, r) => { r.writeHead(405); r.end() })
proxy.on('connect', (req, socket, head) => { const up = net.connect(PORT, '127.0.0.1', () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up) }); up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()) })
proxy.listen(18888, '127.0.0.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = async (page) => { for (let i = 0; i < 100; i++) { const f = page.frames().find((x) => x !== page.mainFrame()); if (f && f.url() !== 'about:blank') return f; await sleep(50) } throw new Error('no frame') }
const names = (c) => (c ?? '').split(';').map((x) => x.trim().split('=')[0]).filter(Boolean).sort().join(' ') || '(нет)'
const A = `https://site-a-chat-b.raditi-preview.ru:${PORT}`
async function run(name, type) {
  const b = await type.launch({ headless: true, proxy: { server: 'http://127.0.0.1:18888' } })
  console.log(`\n## ${name} ${b.version()}`)
  const c = await b.newContext({ ignoreHTTPSErrors: true })
  const p = await c.newPage()
  p.on('dialog', (d) => d.accept('from-user'))
  const open = async (path) => { await p.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(A + path)}`); const f = await child(p); await f.waitForLoadState(); await sleep(250); return f }
  await open('/gw'); let f = await child(p); await f.evaluate(() => { location.href = '/page' }); await sleep(400)
  console.log('кука шлюза с атрибутами продукта, кадр:', names(seen.at(-1)))
  f = await open('/noshim'); await f.evaluate(() => { location.href = '/page' }); await sleep(400)
  console.log('запись JS без шима, кадр:', names(seen.at(-1)))
  f = await open('/shim'); console.log('document.cookie с шимом:', await f.evaluate(() => document.cookie.split('; ').map((x) => x.split('=')[0]).sort().join(' ')))
  await f.evaluate(() => { location.href = '/page' }); await sleep(400)
  console.log('запись JS с шимом, кадр:', names(seen.at(-1)))
  f = await open('/dialogs'); console.log('sandbox кабинета:', await f.title())
  const t = await c.newPage(); t.on('dialog', (d) => d.accept('from-user')); await t.goto(`${A}/dialogs`); console.log('вкладка:', await t.title())
  await b.close()
}
try { await run('Chromium', chromium); await run('Playwright WebKit', webkit) } finally { s.close(); proxy.close(); s.closeAllConnections(); proxy.closeAllConnections() }
