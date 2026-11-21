// Base against the planted «autofocus» variant: how long after Enter does the focus reach an
// option of the select editor's list (polled every frame, up to 2 s)?
import { join } from 'node:path'
import { chromium, webkit } from 'playwright-core'
import { serve } from './server.mjs'

for (const [label, type] of [['chromium', chromium], ['webkit', webkit]]) {
  for (const variant of ['base', 'autofocus']) {
    const server = await serve(join(import.meta.dirname, '..', 'variants', variant, 'dist'))
    const browser = await type.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${server.origin}/?rows=300`)
    const out = []
    for (const row of [12, 14, 16]) {
      const sel = `[data-grid] [role=row][aria-rowindex="${row}"] [data-col="category"]`
      await page.locator(sel).click()
      await page.keyboard.press('Enter')
      const t0 = Date.now()
      const ok = await page
        .waitForFunction(() => document.activeElement?.getAttribute('role') === 'option', null, { timeout: 2000, polling: 'raf' })
        .then(() => `${Date.now() - t0} ms`, () => 'not in 2 s')
      const where = await page.evaluate(() => document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName)
      out.push(`${ok} (${where})`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    console.log(`${label} ${variant}: ${out.join('; ')}`)
    await browser.close()
    await server.close()
  }
}
