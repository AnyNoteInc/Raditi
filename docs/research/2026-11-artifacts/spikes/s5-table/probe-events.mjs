// Which interaction is the longest by Event Timing on the laptop: each step of measure.mjs's
// grid scenario in turn, with the events of ≥ 16 ms it produced.
//
//   node probe-events.mjs   (after node build.mjs)
import { chromium } from 'playwright-core'
import { serve } from './serve.mjs'
const srv = await serve()
for (const rows of [300, 5000]) {
  const browser = await chromium.launch({ channel: 'chromium' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ru-RU', acceptDownloads: true })
  const page = await context.newPage()
  await page.goto(`${srv.origin}/?rows=${rows}&seed=1`)
  await page.waitForFunction(() => window.__spike?.ready === true)
  await page.waitForTimeout(500)
  const take = async (label) => {
    await page.waitForTimeout(250)
    const ev = await page.evaluate(() => window.__spike.events.splice(0).map((x) => Math.round(x.duration)))
    console.log(rows, label.padEnd(24), ev.length ? `max ${Math.max(...ev)} ms (${ev.length} events)` : '—')
  }
  await take('load')
  await page.evaluate(() => window.__spike.grid.focus(3, 'price'))
  await page.keyboard.press('Enter'); await page.waitForFunction(() => window.__spike.grid.editing() !== null)
  await page.keyboard.type('120,50'); await page.keyboard.press('Enter')
  await take('edit price')
  for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowDown')
  await take('arrows')
  const header = (id) => page.locator(`[role=columnheader][data-col="${id}"]`)
  await header('price').click(); await take('price asc (first)')
  await header('price').click(); await take('price desc')
  await header('price').click(); await take('price off')
  await header('name').click(); await take('name asc')
  await header('name').click(); await header('name').click(); await take('name desc, off')
  await page.locator('[data-search]').fill('пирог'); await take('search')
  await page.locator('[data-search]').fill(''); await take('search cleared')
  await page.locator('[data-tool=download]').click(); await take('download menu')
  await Promise.all([page.waitForEvent('download'), page.locator('[data-download=xlsx]').click()]); await take('excel')
  await browser.close()
}
await srv.close()
