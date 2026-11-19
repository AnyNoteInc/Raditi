// Does Network.setCookieControls block third-party cookies in this Chromium? A site with a
// password (s2), then another site (xsite.test) that embeds its files. Result on Chromium
// 153.0.8010.12 (19.11.2026): the call answers ok, and the cookie still goes to the other site —
// the spike blocked third-party cookies with a managed policy instead (README, «Как проверено»).
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import { startStand } from './stand.mjs'
const require = createRequire(import.meta.url)
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
for (const restrict of [false, true]) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, proxy: { server: `http://127.0.0.1:${stand.proxyPort}` } })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  let set = 'not asked'
  if (restrict) set = await cdp.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true, disableThirdPartyCookieMetadata: true, disableThirdPartyCookieHeuristics: true }).then(() => 'ok', (e) => 'failed: ' + e.message)
  const mark = stand.log.length
  await page.goto('https://s2.pages.spike.test/')
  await page.fill('#password', 'секрет-е')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
  const own = stand.log.slice(mark).filter((e) => e.path.startsWith('/_files/')).map((e) => `${e.path.slice(8)} ${e.status} ${e.cookie ? 'cookie' : 'no cookie'}`)
  const mark2 = stand.log.length
  await page.goto('https://xsite.test/xssi?site=s2')
  await page.waitForFunction(() => window.__xssi, null, { timeout: 20000 })
  const x = await page.evaluate(() => window.__xssi)
  const other = stand.log.slice(mark2).filter((e) => e.path.startsWith('/_files/')).map((e) => `${e.path.slice(8)} ${e.status} ${e.cookie ? 'cookie' : 'no cookie'}`)
  console.log(JSON.stringify({ restrict, set, own, xssiScript: x.script, other }))
  await browser.close()
}
await stand.close()
