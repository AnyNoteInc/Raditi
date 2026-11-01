// Real OpenCart 4 and Joomla 5 behind a stand-in of the gateway, in the cabinet's iframe.
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const OC = 'http://site-gap10oc-chat-a.localhost:28190', JM = 'http://site-gap10j-chat-a.localhost:28191'
let mode = 'asis'
const siteSetCookie = (line) => { // apps/preview/src/gateway/headers.ts:124
  const [pair = '', ...attributes] = line.split(';')
  return [pair, ...attributes.filter((a) => !/^\s*domain\s*(=|$)/i.test(a))].join(';')
}
const rewriteSetCookie = (line) => {
  const [pair = '', ...attributes] = line.split(';')
  const kept = attributes.filter((a) => !/^\s*(domain|samesite|secure|partitioned)\s*(=|$)/i.test(a))
  return [pair, ...kept, ' Secure', ' SameSite=None', ' Partitioned'].join(';')
}
const seen = []
const proxyTo = (port) => http.createServer((req, res) => {
  const headers = { ...req.headers }
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
    const out = { ...r.headers }
    delete out['x-frame-options']
    if (out['set-cookie']) {
      out['set-cookie'] = out['set-cookie'].map(mode === 'rewrite' ? rewriteSetCookie : siteSetCookie)
      seen.push(...out['set-cookie'])
    }
    res.writeHead(r.statusCode, out); r.pipe(res)
  })
  up.on('error', () => { res.writeHead(502); res.end('upstream') })
  req.pipe(up)
})
const p1 = proxyTo(28190).listen(18190, '127.0.0.1'), p2 = proxyTo(28191).listen(18191, '127.0.0.1')
const cab = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>cabinet</title><iframe id=f sandbox="${SANDBOX}" referrerpolicy=no-referrer src="${url.searchParams.get('src')}" style="width:1100px;height:800px"></iframe>`)
}).listen(18080, '127.0.0.1')

const args = [`--host-resolver-rules=MAP site-gap10oc-chat-a.localhost 127.0.0.1:18190, MAP site-gap10j-chat-a.localhost 127.0.0.1:18191`]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const inFrame = async (page, url) => {
  await page.goto(`http://localhost:18080/cabinet?src=${encodeURIComponent(url)}`, { waitUntil: 'load' })
  for (let i = 0; i < 100; i++) { const f = page.frames().find((x) => x !== page.mainFrame()); if (f) { await f.waitForLoadState().catch(() => {}); return f } await sleep(50) }
  throw new Error('no frame')
}
const clean = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 170)

async function oc(ctx, top) {
  const page = await ctx.newPage()
  const url = `${OC}/en-gb/product/iphone`
  const f = top ? (await page.goto(url, { waitUntil: 'load' }), page.mainFrame()) : await inFrame(page, url)
  await f.waitForSelector('#button-cart', { timeout: 15000 })
  await f.click('#button-cart')
  await sleep(1500)
  const alert = await f.locator('#alert .alert').allInnerTexts().catch(() => [])
  await f.evaluate((u) => { location.href = u }, `${OC}/index.php?route=checkout/cart&language=en-gb`)
  await sleep(1500); await f.waitForLoadState().catch(() => {})
  const body = clean(await f.locator('#content').first().innerText().catch(() => '(нет #content)'))
  console.log('  OpenCart: уведомление:', clean(alert.join(' | ')) || '(нет)')
  console.log('  OpenCart: корзина:', body)
  await page.close()
}
async function joomla(ctx, top) {
  const page = await ctx.newPage()
  const url = `${JM}/index.php?option=com_users&view=login`
  const f = top ? (await page.goto(url, { waitUntil: 'load' }), page.mainFrame()) : await inFrame(page, url)
  await f.waitForSelector('#username', { timeout: 15000 })
  await f.fill('#username', 'nobody'); await f.fill('#password', '<hidden>')
  await f.evaluate(() => document.querySelector('form.com-users-login__form, #com-users-login__form, form[action*="login"]').requestSubmit())
  await sleep(2500); await f.waitForLoadState().catch(() => {})
  const msg = await f.locator('#system-message-container').innerText().catch(() => '(нет)')
  console.log('  Joomla: ответ на вход:', clean(msg) || '(пусто)', '| адрес', f.url().replace(JM, ''))
  await page.close()
}
async function run(title, ctx, top) {
  console.log(`\n## ${title}`)
  seen.length = 0
  await oc(ctx, top).catch((e) => console.log('  OpenCart: сбой:', clean(e.message)))
  await joomla(ctx, top).catch((e) => console.log('  Joomla: сбой:', clean(e.message)))
  console.log('  Set-Cookie (первые разные):', [...new Set(seen.map((l) => l.replace(/=[^;]*/, '=…').replace(/expires=[^;]*; /i, '').replace(/Max-Age=\d+; /i, '')))].join('\n      '))
}
try {
  const browser = await chromium.launch({ headless: true, args })
  console.log('Chromium', browser.version())
  mode = 'asis'
  let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await run('Как сейчас: шлюз снимает только Domain, межсайтовый iframe', ctx, false)
  await ctx.close()
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await run('Как сейчас, отдельная вкладка', ctx, true)
  await ctx.close()
  mode = 'rewrite'
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await run('Переписанные Set-Cookie, межсайтовый iframe', ctx, false)
  await ctx.close()
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await run('Переписанные Set-Cookie, отдельная вкладка', ctx, true)
  await ctx.close()
  await browser.close()
  // Third-party cookies blocked by the setting of the profile.
  const dir = mkdtempSync(join(tmpdir(), 'gap10-prof-'))
  mkdirSync(join(dir, 'Default'))
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }))
  const persistent = await chromium.launchPersistentContext(dir, { headless: true, args, viewport: { width: 1280, height: 900 } })
  await run('Переписанные Set-Cookie, iframe, сторонние куки заблокированы профилем', persistent, false)
  mode = 'asis'
  await persistent.close()
} finally { p1.close(); p2.close(); cab.close(); p1.closeAllConnections(); p2.closeAllConnections(); cab.closeAllConnections() }
