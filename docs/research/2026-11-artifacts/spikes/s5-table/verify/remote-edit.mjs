// Someone else's edits in a view sorted by price: rows must stay where they are, the chip must
// appear. The other person is simulated by the page's remoteEdit hook (the only way in a spike);
// what moved is read from the DOM.
import { chromium } from 'playwright-core'
import { serve } from './server.mjs'

const server = await serve(process.argv[2])
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(`${server.origin}/?rows=300`)
await page.locator('[data-grid] [role=row][aria-rowindex="2"]').waitFor()
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-grid] [role=row][aria-rowindex]')]
      .filter((r) => r.getAttribute('aria-rowindex') !== '1')
      .sort((a, b) => a.getAttribute('aria-rowindex') - b.getAttribute('aria-rowindex'))
      .slice(0, 15)
      .map((r) => `${r.querySelector('[data-col=name]').textContent}|${r.querySelector('[data-col=price]').textContent}`),
  )
await page.locator('[role=columnheader][data-col="price"]').click()
await page.waitForTimeout(100)
const before = await rows()
const chipBefore = await page.getByText('Порядок не обновлён — обновить').count()
for (let k = 0; k < 5; k++) await page.evaluate(() => window.__spike.remoteEdit(3))
await page.waitForTimeout(150)
const after = await rows()
const names = (list) => list.map((x) => x.split('|')[0])
const sameOrder = JSON.stringify(names(before)) === JSON.stringify(names(after))
const changed = after.filter((x, i) => x !== before[i]).length
const chip = await page.getByText('Порядок не обновлён — обновить').count()
console.log(`chip before ${chipBefore}, after ${chip}; first 15 names in the same order: ${sameOrder}; prices changed on screen among them: ${changed}`)
await browser.close()
await server.close()
