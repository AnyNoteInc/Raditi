// Independent check of spike s8: does the fragment of /a#<token> ever leave the browser? Not the
// builder's path (no Traefik, no forward proxy for https): a raw TLS and a raw TCP server record
// every byte of every request head; the page's own script sends fetch (default, unsafe-url,
// fetch(location.href)), sendBeacon and an image; a link click; server redirects without and with
// a fragment of their own; then the same through a recording HTTP proxy.
//   node ind-fragment.mjs --cert <crt> --key <key> --browsers chromium,webkit[,firefox] --platform <name>
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import * as pw from 'playwright-core'

const { values } = parseArgs({ options: { cert: { type: 'string' }, key: { type: 'string' }, browsers: { type: 'string' }, platform: { type: 'string' } } })
const seen = [] // every request head, as bytes arrived
const tok = (id) => `FRAG${id}${randomBytes(6).toString('hex')}`

const PAGE_A = `<!doctype html><meta charset=utf-8><title>a</title><a id=go href="/next">next</a>
<script>
window.__hash = location.hash
window.__run = async () => {
  await fetch('/f-default')
  await fetch('/f-unsafe', { referrerPolicy: 'unsafe-url' })
  await fetch(location.href.replace('/a', '/f-href'))
  navigator.sendBeacon('/beacon', 'x')
  await new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = '/img' })
  return true
}
</script>`
const PAGE_NEXT = `<!doctype html><meta charset=utf-8><title>next</title><script>window.__ref = document.referrer</script>`

function respond(socket, head) {
  const line = head.split('\r\n')[0]
  const target = line.split(' ')[1] ?? ''
  const send = (status, headers, body = '') =>
    socket.end(`HTTP/1.1 ${status}\r\n${Object.entries({ 'content-length': Buffer.byteLength(body), connection: 'close', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`)
  // The policy every page of the cabinet sends today (next.config.ts)
  const html = { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'strict-origin-when-cross-origin' }
  if (target.startsWith('/r302f')) return send('302 Found', { location: '/a#fromserver' })
  if (target.startsWith('/r302')) return send('302 Found', { location: '/a' })
  if (target.startsWith('/a')) return send('200 OK', html, PAGE_A)
  if (target.startsWith('/next')) return send('200 OK', html, PAGE_NEXT)
  if (target.startsWith('/img')) return send('200 OK', { 'content-type': 'image/gif' }, '')
  return send('200 OK', { 'content-type': 'text/plain' }, 'ok')
}
function recorder(socket) {
  let data = ''
  socket.on('data', (chunk) => {
    data += chunk.toString('latin1')
    const end = data.indexOf('\r\n\r\n')
    if (end < 0) return
    const head = data.slice(0, end)
    seen.push(head)
    respond(socket, head)
  })
  socket.on('error', () => {})
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const httpsPort = await listen(tls.createServer({ key: readFileSync(values.key), cert: readFileSync(values.cert) }, recorder))
const httpPort = await listen(net.createServer(recorder))
// A forward proxy that records the request line and answers itself (it forwards nothing)
const proxySeen = []
const proxyPort = await listen(net.createServer((socket) => {
  let data = ''
  socket.on('data', (chunk) => {
    data += chunk.toString('latin1')
    const end = data.indexOf('\r\n\r\n')
    if (end < 0) return
    proxySeen.push(data.slice(0, end).split('\r\n')[0])
    socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok')
  })
  socket.on('error', () => {})
}))

const results = []
for (const name of values.browsers.split(',')) {
  const type = pw[name]
  const out = { browser: name, platform: values.platform }
  try {
    const browser = await type.launch({ headless: true })
    out.version = browser.version()
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const tokens = {}
    const start = seen.length

    tokens.nav = tok('n')
    await page.goto(`https://127.0.0.1:${httpsPort}/a#${tokens.nav}`)
    out.hashOnPage = (await page.evaluate(() => window.__hash)) === `#${tokens.nav}`
    await page.evaluate(() => window.__run())
    await page.waitForTimeout(300)
    await Promise.all([page.waitForURL('**/next'), page.click('#go')])
    out.documentReferrer = (await page.evaluate(() => window.__ref)).replace(String(httpsPort), '<port>')

    tokens.redirect = tok('r')
    await page.goto(`https://127.0.0.1:${httpsPort}/r302#${tokens.redirect}`)
    out.redirectKeepsFragment = page.url().endsWith(`#${tokens.redirect}`)
    tokens.redirectOwn = tok('o')
    await page.goto(`https://127.0.0.1:${httpsPort}/r302f#${tokens.redirectOwn}`)
    out.redirectWithOwnFragment = page.url().replace(/^.*\/a/, '/a').replace(tokens.redirectOwn, '<token>')

    tokens.plain = tok('p')
    await page.goto(`http://127.0.0.1:${httpPort}/a#${tokens.plain}`)
    await browser.close()

    const heads = seen.slice(start)
    out.requestLines = heads.map((h) => h.split('\r\n')[0].replace(/\d{4,5}/g, '<port>'))
    out.referers = [...new Set(heads.map((h) => /^referer: (.*)$/im.exec(h)?.[1]).filter(Boolean).map((r) => r.replace(/:\d+\//, ':<port>/')))]
    out.tokenInAnyRequestHead = Object.values(tokens).some((t) => heads.some((h) => h.includes(t)))

    // Through a recording HTTP proxy: a plain http:// address and an https:// one
    const proxied = await type.launch({ headless: true, proxy: { server: `http://127.0.0.1:${proxyPort}` } })
    const p2 = await (await proxied.newContext({ ignoreHTTPSErrors: true })).newPage()
    const before = proxySeen.length
    tokens.proxyHttp = tok('h')
    await p2.goto(`http://plain.ind.test/a#${tokens.proxyHttp}`).catch(() => {})
    tokens.proxyHttps = tok('s')
    await p2.goto(`https://tls.ind.test/a#${tokens.proxyHttps}`).catch(() => {})
    await proxied.close()
    const lines = proxySeen.slice(before)
    out.proxyLines = lines.map((l) => l.replace(tokens.proxyHttp, '<token>').replace(tokens.proxyHttps, '<token>'))
    out.tokenAtProxy = { http: lines.some((l) => l.includes(tokens.proxyHttp)), https: lines.some((l) => l.includes(tokens.proxyHttps)) }
  } catch (error) {
    out.error = String(error).split('\n').slice(0, 4).join(' | ').slice(0, 400)
  }
  results.push(out)
}
process.stdout.write(`${JSON.stringify({ node: process.version, results })}\n`)
process.exit(0)
