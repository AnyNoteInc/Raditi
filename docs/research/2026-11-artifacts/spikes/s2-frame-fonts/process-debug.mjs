// Counts Chromium renderer processes and OOPIF targets for frames of the pages root: a fresh
// browser per case, the full Chromium build in its new headless mode (the headless shell has no
// site isolation at all). Prints one line per case.
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import { startStand, CABINET } from './stand.mjs'
const require = createRequire(import.meta.url)
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
const out = []
for (const [sandbox, n] of [['none', 0], ['none', 3], ['art', 1], ['art', 3], ['art', 6]]) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, proxy: { server: `http://127.0.0.1:${stand.proxyPort}` } })
  const cdp = await browser.newBrowserCDPSession()
  const renderers = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').length
  const iframes = async () => (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe').length
  const context = await browser.newContext()
  const page = await context.newPage()
  if (n === 0) await page.goto(`http://${CABINET}/chat?view=${encodeURIComponent('/v/none.x')}&sandbox=none&n=0`)
  else {
    await page.goto(`http://${CABINET}/chat?view=${encodeURIComponent(`/v/view-${sandbox}-c1-R${n}${sandbox}.a1b2c3d4`)}&sandbox=${sandbox}&n=${n}`)
    await page.waitForFunction((k) => Object.keys(window.__results).length >= k, n, { timeout: 60000 })
  }
  await new Promise((r) => setTimeout(r, 1500))
  const line = `${browser.version()} sandbox=${sandbox} frames=${n}: renderer processes=${await renderers()} iframe targets=${await iframes()}`
  out.push(line)
  console.log(line)
  await browser.close()
}
await stand.close()
