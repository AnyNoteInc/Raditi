// Scratch stand for gap 10: real Chromium, the exact iframe attributes of the cabinet, real site-ish hosts.
import https from 'node:https'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const PORT = 18443, HTTP_PORT = 18080
const log = []
const COOKIES = {
  sc_plain: 'sc_plain=1; Path=/',
  sc_lax: 'sc_lax=1; Path=/; SameSite=Lax',
  sc_strict: 'sc_strict=1; Path=/; SameSite=Strict',
  sc_none_insecure: 'sc_none_insecure=1; Path=/; SameSite=None',
  sc_none: 'sc_none=1; Path=/; SameSite=None; Secure',
  sc_chips: 'sc_chips=1; Path=/; SameSite=None; Secure; Partitioned',
  sc_chips_laxattr: 'sc_chips_lax=1; Path=/; SameSite=Lax; Secure; Partitioned',
}
const JS = `
document.cookie='js_plain=1; path=/';
document.cookie='js_lax=1; path=/; SameSite=Lax';
document.cookie='js_none=1; path=/; SameSite=None; Secure';
document.cookie='js_chips=1; path=/; SameSite=None; Secure; Partitioned';
`
const handler = (req, res) => {
  const url = new URL(req.url, 'https://x')
  const host = (req.headers.host ?? '').split(':')[0]
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
  log.push({ host, path: url.pathname, method: req.method, cookie: req.headers.cookie ?? '', dest: req.headers['sec-fetch-dest'], site: req.headers['sec-fetch-site'] })
  if (url.pathname === '/cabinet') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><title>cabinet</title><iframe id=f sandbox="${url.searchParams.get('nosandbox') ? '' : SANDBOX}" ${url.searchParams.get('nosandbox') ? 'data-x' : ''} referrerpolicy=no-referrer src="${url.searchParams.get('src')}" width=600 height=400></iframe>`)
  }
  if (url.pathname === '/set') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': Object.values(COOKIES) })
    return res.end(`<!doctype html><title>set</title><script>${JS}</script><p>set</p>`)
  }
  if (url.pathname === '/setbig') {
    const n = Number(url.searchParams.get('n') ?? 8), tag = url.searchParams.get('tag') ?? 'a'
    const lines = Array.from({ length: n }, (_, i) => `${tag}${i}=${'x'.repeat(1000)}; Path=/; SameSite=None; Secure; Partitioned`)
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': lines })
    return res.end('<!doctype html><title>big</title><p>big</p>')
  }
  if (url.pathname === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><title>page</title><form id=f method=post action=/post><button>go</button></form>`)
  }
  if (url.pathname === '/post') {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>posted</title>ok') })
    return
  }
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' }))
  }
  if (url.pathname === '/dialogs') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><title>dialogs</title><script>
      let a; try { a = window.confirm('x') } catch (e) { a = 'throw ' + e.name }
      let p; try { p = window.prompt('x') } catch (e) { p = 'throw ' + e.name }
      document.title = 'confirm=' + a + ' prompt=' + p</script>`)
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>ok</title>ok')
}
const tls = { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }
const server = https.createServer(tls, handler).listen(PORT, '127.0.0.1')
const plain = http.createServer(handler).listen(HTTP_PORT, '127.0.0.1')

const lastFor = (path, host) => log.filter((e) => e.path === path && (!host || e.host === host)).at(-1)
const names = (cookie) => (cookie ?? '').split(';').map((s) => s.trim().split('=')[0]).filter(Boolean).sort().join(' ') || '(нет)'
const previewFrame = async (page, re) => { for (let i = 0; i < 100; i++) { const f = page.frames().find((x) => re.test(x.url())); if (f) return f; await new Promise((r) => setTimeout(r, 50)) } throw new Error('no frame') }

async function scenario(title, launchArgs) {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * 127.0.0.1', ...launchArgs] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  console.log(`\n## ${title} (Chromium ${browser.version()})`)
  const page = await context.newPage()
  const A = `https://site-a-chat-b.raditi-preview.ru:${PORT}`
  await page.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(A + '/set')}`)
  let f = await previewFrame(page, /\/set$/); await f.waitForLoadState()
  console.log('document.cookie в кадре после записи:', await f.evaluate(() => document.cookie.split('; ').map((s) => s.split('=')[0]).sort().join(' ')))
  await f.goto(`${A}/page`); await f.waitForLoadState()
  console.log('навигация кадра, Cookie:', names(lastFor('/page', 'site-a-chat-b.raditi-preview.ru').cookie), '| sec-fetch-site', lastFor('/page').site)
  const fetched = await f.evaluate(async () => (await fetch('/echo', { credentials: 'include' })).json())
  console.log('fetch из кадра, Cookie:', names(fetched.cookie))
  await f.evaluate(() => document.getElementById('f').submit()); await new Promise((r) => setTimeout(r, 300))
  console.log('POST формы в кадре, Cookie:', names(lastFor('/post').cookie))
  console.log('jar:', (await context.cookies()).map((c) => `${c.name}${c.partitionKey ? '[part:' + c.partitionKey + ']' : ''}`).sort().join(' '))

  // The same origin in a tab of its own: which jar does it read?
  const tab = await context.newPage()
  await tab.goto(`${A}/page`)
  console.log('отдельная вкладка, те же куки видит:', names(lastFor('/page').cookie))
  await tab.goto(`${A}/set`); await tab.goto(`${A}/page`)
  console.log('отдельная вкладка после своей записи:', names(lastFor('/page').cookie))
  await tab.close()

  // A foreign top-level page: frame and credentialed fetch.
  const evil = await context.newPage()
  await evil.goto(`https://evil.example:${PORT}/cabinet?src=${encodeURIComponent(A + '/page')}`)
  await previewFrame(evil, /\/page$/)
  await new Promise((r) => setTimeout(r, 200))
  console.log('кадр чужого сайта, Cookie:', names(lastFor('/page').cookie))
  await evil.evaluate(async (a) => { await fetch(a + '/post', { method: 'POST', mode: 'no-cors', credentials: 'include', body: 'x' }).catch(() => undefined) }, A)
  await new Promise((r) => setTimeout(r, 200))
  console.log('POST с чужого сайта (CSRF), Cookie:', names(lastFor('/post').cookie))
  await evil.close()
  await browser.close()
}

async function partitionLimit() {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * 127.0.0.1'] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const count = async (origin) => {
    await page.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(origin + '/page')}`)
    const f = await previewFrame(page, /\/page$/); await f.waitForLoadState()
    const r = await f.evaluate(async () => (await fetch('/echo', { credentials: 'include' })).json())
    const list = r.cookie === '' ? [] : r.cookie.split('; ')
    return { n: list.length, bytes: r.cookie.length }
  }
  const put = async (origin, tag, n) => {
    await page.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(`${origin}/setbig?n=${n}&tag=${tag}`)}`)
    const f = await previewFrame(page, /setbig/); await f.waitForLoadState()
  }
  const A = `https://site-a-chat-b.raditi-preview.ru:${PORT}`, B = `https://site-c-chat-d.raditi-preview.ru:${PORT}`, C = `https://site-e-chat-f.other-preview.ru:${PORT}`
  console.log('\n## Предел разделённых кук на партицию')
  await put(A, 'a', 6); console.log('A после 6×1 КиБ:', await count(A))
  await put(B, 'b', 6); console.log('B (тот же регистрируемый домен) после 6×1 КиБ:', await count(B)); console.log('A теперь:', await count(A))
  await put(C, 'c', 6); console.log('C (другой регистрируемый домен) после 6×1 КиБ:', await count(C)); console.log('A теперь:', await count(A)); console.log('B теперь:', await count(B))
  await put(A, 'z', 12); console.log('A после ещё 12×1 КиБ одним ответом:', await count(A))
  await browser.close()
}

async function dev() {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * 127.0.0.1'] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  console.log('\n## dev: http://localhost и http://site-a-chat-b.localhost')
  const A = `http://site-a-chat-b.localhost:${HTTP_PORT}`
  await page.goto(`http://localhost:${HTTP_PORT}/cabinet?src=${encodeURIComponent(A + '/set')}`)
  const f = await previewFrame(page, /\/set$/); await f.waitForLoadState()
  await f.goto(`${A}/page`); await f.waitForLoadState()
  console.log('навигация кадра, Cookie:', names(lastFor('/page', 'site-a-chat-b.localhost').cookie), '| sec-fetch-site', lastFor('/page').site)
  await browser.close()
}

async function dialogs() {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * 127.0.0.1'] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.on('dialog', (d) => d.accept())
  console.log('\n## confirm и prompt')
  const A = `https://site-a-chat-b.raditi-preview.ru:${PORT}`
  await page.goto(`https://raditi.ru:${PORT}/cabinet?src=${encodeURIComponent(A + '/dialogs')}`)
  let f = await previewFrame(page, /dialogs/); await f.waitForLoadState()
  console.log('кадр с sandbox кабинета:', await f.title())
  await page.goto(`https://raditi.ru:${PORT}/cabinet?nosandbox=1&src=${encodeURIComponent(A + '/dialogs')}`)
  await new Promise((r) => setTimeout(r, 500))
  await browser.close()
}

try {
  await scenario('Сторонние куки разрешены', [])
  await scenario('Сторонние куки заблокированы', ['--test-third-party-cookie-phaseout'])
  await partitionLimit()
  await dev()
  await dialogs()
} finally { server.close(); plain.close(); server.closeAllConnections(); plain.closeAllConnections() }
