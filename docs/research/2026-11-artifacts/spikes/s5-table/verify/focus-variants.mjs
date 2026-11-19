// Planted variants of the spike (built under ../variants/<name>/dist): does the focus reach the
// list of a select editor, and where does it land after a choice? And does Esc still close the
// filter menu when «Сбросить фильтр» does not close it? Chromium on a laptop, mouse and keys only.
import { join } from 'node:path'
import { chromium, webkit } from 'playwright-core'
import { serve } from './server.mjs'

const name = (page) =>
  page.evaluate(() => {
    const a = document.activeElement
    if (!a || a === document.body) return 'body'
    if (a.hasAttribute('data-grid')) return 'grid'
    return a.getAttribute('role') ?? a.tagName.toLowerCase()
  })

async function selectProbe(browserType, variant) {
  const server = await serve(join(import.meta.dirname, '..', 'variants', variant, 'dist'))
  const browser = await browserType.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${server.origin}/?rows=300`)
  const cellSel = '[data-grid] [role=row][aria-rowindex="12"] [data-col="category"]'
  await page.locator(cellSel).waitFor()
  const before = await page.locator(cellSel).textContent()
  await page.locator(cellSel).click()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const open = await name(page)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const after = await name(page)
  const value = await page.locator(cellSel).textContent()
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(100)
  const moved = await page.evaluate(() => {
    const g = document.querySelector('[data-grid]')
    const el = document.getElementById(g.getAttribute('aria-activedescendant') ?? '')
    return el ? el.closest('[role=row]').getAttribute('aria-rowindex') : null
  })
  await browser.close()
  await server.close()
  return `${variant}: list open → focus on ${open}; after the choice → ${after}; «${before}» → «${value}»; ArrowDown then → row ${moved}`
}

async function menuProbe(browserType, variant) {
  const server = await serve(join(import.meta.dirname, '..', 'variants', variant, 'dist'))
  const browser = await browserType.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${server.origin}/?rows=300`)
  await page.locator('[data-tool=filter]').waitFor()
  await page.locator('[data-tool=filter]').click()
  await page.locator('[data-category="Торты"]').click()
  await page.getByText('Сбросить фильтр').click()
  await page.waitForTimeout(200)
  const focus = await name(page)
  const openBefore = await page.locator('[role=menu]').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const openAfter = await page.locator('[role=menu]').count()
  await browser.close()
  await server.close()
  return `${variant}: after «Сбросить фильтр» menu open ${openBefore}, focus on ${focus}; after Esc menu open ${openAfter}`
}

for (const [label, type] of [['chromium', chromium], ['webkit', webkit]]) {
  console.log(label)
  for (const v of ['base', 'autofocus', 'no-restore', 'no-refocus', 'neither']) console.log(' ', await selectProbe(type, v))
  for (const v of ['base', 'keep-menu']) console.log(' ', await menuProbe(type, v))
}
