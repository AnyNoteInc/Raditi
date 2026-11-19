// Extra checks the spike did not make: Ctrl+A on the grid (claimed, not tested by check.mjs),
// axe-core on the whole page (not only the grid), on the phone's cards and on the open sheet.
import AxeBuilder from '@axe-core/playwright'
import { chromium, webkit } from 'playwright-core'
import { serve } from './server.mjs'

const server = await serve(process.argv[2])
const axe = async (page, include) => {
  const b = new AxeBuilder({ page })
  if (include) b.include(include)
  const r = await b.analyze()
  return r.violations.map((v) => `${v.id}(${v.impact}, ${v.nodes.length})`).join(', ') || 'none'
}
for (const [label, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch()
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await page.goto(`${server.origin}/?rows=300`)
  await page.locator('[data-grid] [role=row][aria-rowindex="2"]').waitFor()
  await page.locator('[data-grid] [role=row][aria-rowindex="3"] [data-col="unit"]').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.waitForTimeout(80)
  const sel = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-grid] [role=row][aria-rowindex] [data-col]')].filter((c) => c.closest('[role=row]').getAttribute('aria-rowindex') !== '1')
    return { cells: cells.length, selected: cells.filter((c) => c.classList.contains('sel')).length }
  })
  console.log(`${label} laptop: Ctrl+A selects ${sel.selected} of ${sel.cells} rendered cells`)
  console.log(`${label} laptop: axe on the whole page — ${await axe(page)}`)
  await browser.close()
  const phone = await type.launch()
  const ctx = await phone.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: label === 'chromium', hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(`${server.origin}/?rows=300`)
  await p.locator('[data-cards] [role=listitem]').first().waitFor()
  console.log(`${label} phone: axe on the cards page — ${await axe(p)}`)
  await p.locator('[role=listitem] .main').first().tap()
  await p.locator('[data-sheet]').waitFor()
  await p.waitForTimeout(300)
  console.log(`${label} phone: axe with the sheet open — ${await axe(p)}`)
  await phone.close()
}
await server.close()
