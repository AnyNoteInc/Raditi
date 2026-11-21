// A fixed clock makes a frame that reads the time (a countdown) draw the same at every render:
//   node clock-check.mjs   — two renders with the real clock, two with context.clock.setFixedTime.
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { assembleFrame, ensureAssets, DOC_URL } from './lib/frames.mjs'
import { launch, framePolicy } from './lib/render.mjs'
const { browser, server } = await launch(chromium)
const assets = await ensureAssets(browser)
const frame = assembleFrame('05-promo-banner', { assets })
const shot = async (fixed) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  if (fixed) await ctx.clock.setFixedTime(new Date('2026-11-19T12:00:00+03:00'))
  await ctx.route('**/*', (r) => r.request().url() === DOC_URL ? r.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': framePolicy() }, body: frame.html }) : r.abort())
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(DOC_URL, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  const text = await page.evaluate(() => [...document.querySelectorAll('.timer b')].map((b) => b.textContent).join(':'))
  const png = createHash('sha256').update(await page.screenshot({ fullPage: true })).digest('hex').slice(0, 12)
  await ctx.close()
  return { text, png, errors }
}
console.log('free  ', await shot(false), await shot(false))
console.log('fixed ', await shot(true), await shot(true))
await browser.close(); await server.close()
