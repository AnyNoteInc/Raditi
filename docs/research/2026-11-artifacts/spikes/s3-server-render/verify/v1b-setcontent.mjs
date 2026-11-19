// Does page.setContent() in a fresh context reproduce the frame's storage failure? (skeptic of s3)
//   node v1b-setcontent.mjs <calculator fixture>
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const html = readFileSync(process.argv[2], 'utf8')
const browser = await chromium.launch({ headless: true })
const out = {}
for (const [name, prep] of [['fresh about:blank', null], ['after goto data:', 'data:text/html,<p>x']]) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 110)))
  if (prep) await page.goto(prep)
  await page.setContent(html)
  await page.waitForTimeout(300)
  out[name] = { url: page.url(), origin: await page.evaluate(() => self.origin), total: await page.$eval('#total', (e) => e.textContent), errors, popup: await page.evaluate(() => { try { return Boolean(window.open('about:blank')) } catch (e) { return e.name } }) }
  await ctx.close()
}
await browser.close()
console.log(JSON.stringify(out, null, 1))
