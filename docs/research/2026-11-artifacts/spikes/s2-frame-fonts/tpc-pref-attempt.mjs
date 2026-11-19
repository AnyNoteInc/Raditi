// A Chromium profile where the user blocked third-party cookies (the pref Chrome itself writes:
// profile.cookie_controls_mode = 2): a site with a password, then another site embeds its files.
// Result on Chromium 153.0.8010.12 (19.11.2026): the pref is not honoured this way, the cookie
// still goes to the other site — the spike used a managed policy instead (README).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import { startStand } from './stand.mjs'
const require = createRequire(import.meta.url)
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
for (const mode of [0, 2]) {
  const dir = new URL(`./tmp/chrome-profile-${mode}`, import.meta.url).pathname
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(`${dir}/Default`, { recursive: true })
  writeFileSync(`${dir}/Default/Preferences`, JSON.stringify({ profile: { cookie_controls_mode: mode, block_third_party_cookies: mode === 2 } }))
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, ignoreHTTPSErrors: true, proxy: { server: `http://127.0.0.1:${stand.proxyPort}` } })
  const page = context.pages()[0] ?? (await context.newPage())
  const mark = stand.log.length
  await page.goto('https://s2.pages.spike.test/')
  await page.fill('#password', 'секрет-е')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
  const own = stand.log.slice(mark).filter((e) => e.path.startsWith('/_files/')).map((e) => `${e.path.slice(8)} ${e.status} ${e.cookie ? 'cookie' : 'no cookie'}`)
  const css = await page.evaluate(() => getComputedStyle(document.getElementById('css-files')).width).catch((e) => 'err ' + e.message)
  const mark2 = stand.log.length
  await page.goto('https://xsite.test/xssi?site=s2')
  await page.waitForFunction(() => window.__xssi, null, { timeout: 20000 })
  const x = await page.evaluate(() => window.__xssi)
  const other = stand.log.slice(mark2).filter((e) => e.path.startsWith('/_files/')).map((e) => `${e.path.slice(8)} ${e.status} ${e.cookie ? 'cookie' : 'no cookie'}`)
  console.log(JSON.stringify({ cookie_controls_mode: mode, ownCss: css, own, xssiScript: x.script, other }))
  await context.close()
}
await stand.close()
