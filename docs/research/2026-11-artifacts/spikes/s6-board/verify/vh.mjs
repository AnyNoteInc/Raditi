// Does a frame sized from its bridge's height run away on a page with min-height: 100vh? And what does
// the spike's full-page thumbnail method (measure, grow the viewport, measure again) give for it?
import { start } from './vserver.mjs'
const { chromium, webkit } = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
for (const [name, launch] of [['chromium', () => chromium.launch({ channel: 'chromium' })], ['webkit', () => webkit.launch()]]) {
  const browser = await launch()
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage()
  await page.goto(`http://127.0.0.1:${srv.cp}/vh.html?fo=http://127.0.0.1:${srv.fp}`)
  await new Promise((r) => setTimeout(r, 3000))
  const steps = await page.evaluate(() => window.__steps)
  // the thumbnail method of the spike's thumbs.mjs on the same page, top level
  const p2 = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await p2.goto(`http://127.0.0.1:${srv.fp}/vh.html`)
  let h = await p2.evaluate(() => Math.ceil(document.documentElement.scrollHeight)); const h1 = h
  await p2.setViewportSize({ width: 1440, height: h }); h = await p2.evaluate(() => Math.ceil(document.documentElement.scrollHeight))
  console.log(name, JSON.stringify({ bridgeSteps: steps.length, first: steps.slice(0, 5), last: steps.at(-1), thumbsMethod: { atViewport900: h1, afterGrow: h } }))
  await browser.close()
}
await srv.close()
