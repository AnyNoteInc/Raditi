// The planted «keep-menu» variant: where is the focus right after «Сбросить фильтр» disappears,
// and does Esc close the menu at once (0 ms) and a little later (200 ms)?
import { join } from 'node:path'
import { chromium, webkit } from 'playwright-core'
import { serve } from './server.mjs'

for (const [label, type] of [['chromium', chromium], ['webkit', webkit]]) {
  for (const wait of [0, 200]) {
    const server = await serve(join(import.meta.dirname, '..', 'variants', 'keep-menu', 'dist'))
    const browser = await type.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${server.origin}/?rows=300`)
    await page.locator('[data-tool=filter]').click()
    await page.locator('[data-category="Торты"]').click()
    await page.getByText('Сбросить фильтр').click()
    const right = await page.evaluate(() => {
      const a = document.activeElement
      return a === document.body ? 'body' : `${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]} role=${a.getAttribute('role')}`
    })
    if (wait) await page.waitForTimeout(wait)
    const later = await page.evaluate(() => {
      const a = document.activeElement
      return a === document.body ? 'body' : `${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]} role=${a.getAttribute('role')}`
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    const open = await page.locator('[role=menu]').count()
    console.log(`${label}, Esc after ${wait} ms: focus right after the click — ${right}; before Esc — ${later}; menu open after Esc: ${open}`)
    await browser.close()
    await server.close()
  }
}
