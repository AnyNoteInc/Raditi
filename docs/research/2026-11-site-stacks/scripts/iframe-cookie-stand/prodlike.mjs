// Production-like: TLS, cross-site .ru names, real OpenCart and Joomla, the cabinet's exact iframe.
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { chromium, webkit } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const PORT = 18443
const OC = `https://site-gap10oc-chat-a.raditi-preview.ru:${PORT}`, JM = `https://site-gap10j-chat-a.raditi-preview.ru:${PORT}`
let mode = 'asis'
const attrs = (line) => { const [pair = '', ...a] = line.split(';'); return [pair, a] }
const REWRITE = {
  asis: (l) => { const [p, a] = attrs(l); return [p, ...a.filter((x) => !/^\s*domain\s*(=|$)/i.test(x))].join(';') },
  none: (l) => { const [p, a] = attrs(l); return [p, ...a.filter((x) => !/^\s*(domain|samesite|secure|partitioned)\s*(=|$)/i.test(x)), ' Secure', ' SameSite=None'].join(';') },
  partitioned: (l) => { const [p, a] = attrs(l); return [p, ...a.filter((x) => !/^\s*(domain|samesite|secure|partitioned)\s*(=|$)/i.test(x)), ' Secure', ' SameSite=None', ' Partitioned'].join(';') },
}
const server = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]
  if (host === 'raditi.ru') {
    const u = new URL(req.url, 'https://x'); res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><title>cabinet</title><iframe sandbox="${SANDBOX}" referrerpolicy=no-referrer src="${u.searchParams.get('src')}" style="width:1100px;height:800px"></iframe>`)
  }
  const port = host.startsWith('site-gap10oc') ? 28190 : 28191
  const headers = { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host }
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
    const out = { ...r.headers }; delete out['x-frame-options']
    if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map(REWRITE[mode])
    res.writeHead(r.statusCode, out); r.pipe(res)
  })
  up.on('error', () => { res.writeHead(502); res.end('upstream') }); req.pipe(up)
}).listen(PORT, '127.0.0.1')
const proxy = http.createServer((_q, r) => { r.writeHead(405); r.end() })
proxy.on('connect', (req, socket, head) => { const up = net.connect(PORT, '127.0.0.1', () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up) }); up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()) })
proxy.listen(18888, '127.0.0.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 120)
const child = async (page) => { for (let i = 0; i < 200; i++) { const f = page.frames().find((x) => x !== page.mainFrame()); if (f && f.url() !== 'about:blank' && f.url() !== '') return f; await sleep(50) } throw new Error('no frame') }
async function open(ctx, url, restrict) {
  const page = await ctx.newPage()
  if (restrict) { const cdp = await ctx.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true, disableThirdPartyCookieMetadata: true, disableThirdPartyCookieHeuristics: true }) }
  await page.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(url)}`)
  return { page, f: await child(page) }
}
async function oc(ctx, restrict) {
  const { page, f } = await open(ctx, `${OC}/en-gb/product/iphone`, restrict)
  await f.waitForSelector('#button-cart', { timeout: 20000 })
  await f.click('#button-cart'); await sleep(1500)
  await f.evaluate((u) => { location.href = u }, `${OC}/index.php?route=checkout/cart&language=en-gb`); await sleep(1800)
  const fr = await child(page)
  const text = clean(await fr.locator('#content').first().innerText().catch(() => '(нет страницы)'))
  await page.close(); return /empty/i.test(text) ? 'корзина ПУСТА' : /iPhone/.test(text) ? 'товар в корзине' : text
}
async function jm(ctx, restrict) {
  const { page, f } = await open(ctx, `${JM}/index.php?option=com_users&view=login`, restrict)
  await f.waitForSelector('#username', { timeout: 20000 })
  await f.fill('#username', 'nobody'); await f.fill('#password', '<hidden>')
  await f.evaluate(() => document.querySelector('#com-users-login__form').requestSubmit()); await sleep(2500)
  const fr = page.frames().find((x) => x !== page.mainFrame())
  const url = fr?.url() ?? '(нет кадра)'
  const msg = await fr?.locator('#system-message-container').innerText({ timeout: 800 }).catch(() => '') ?? ''
  await page.close()
  return /error|about:blank/i.test(url) || !msg ? `сбой кадра: ${url.slice(0, 60)}` : /do not match/.test(msg) ? 'форма принята, отказ по паролю' : clean(msg)
}
async function row(name, ctx, restrict) {
  const a = await oc(ctx, restrict).catch((e) => 'сбой: ' + clean(e.message))
  const b = await jm(ctx, restrict).catch((e) => 'сбой: ' + clean(e.message))
  console.log(`${name} | OpenCart: ${a} | Joomla: ${b}`)
}
try {
  for (const [label, type, opts] of [['Chromium', chromium, { args: ['--host-resolver-rules=MAP * 127.0.0.1'] }], ['WebKit', webkit, { proxy: { server: 'http://127.0.0.1:18888' } }]]) {
    const b = await type.launch({ headless: true, ...opts })
    console.log(`\n## ${label} ${b.version()}`)
    for (const m of ['asis', 'none', 'partitioned']) {
      mode = m
      const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } })
      await row(`${m}`, ctx, false); await ctx.close()
      if (label === 'Chromium') { const c2 = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }); await row(`${m}, сторонние заблокированы`, c2, true); await c2.close() }
    }
    await b.close()
  }
} finally { server.close(); proxy.close(); server.closeAllConnections(); proxy.closeAllConnections() }
