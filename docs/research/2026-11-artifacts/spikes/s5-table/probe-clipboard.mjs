import { firefox, webkit, chromium } from 'playwright-core'
import { serve } from './serve.mjs'
import { excelRu3x3 } from './fixtures/paste.mjs'
const srv = await serve()
const which = process.argv[2] ?? 'firefox'
const type = { firefox, webkit, chromium }[which]
const browser = await type.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
if (which === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.origin })
const page = await context.newPage()
await page.goto(srv.origin + '/?rows=300')
await page.waitForFunction(() => window.__spike?.ready === true)
await page.evaluate(() => window.__spike.grid.focus(20, 'unit'))
const synthetic = await page.evaluate((t) => {
  const dt = new DataTransfer()
  dt.setData('text/plain', t)
  let seen = null
  document.addEventListener('paste', (e) => { seen = { len: e.clipboardData?.getData('text/plain')?.length ?? null, hasCD: !!e.clipboardData, trusted: e.isTrusted } }, { once: true, capture: true })
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  return { seen, dtLen: dt.getData('text/plain').length }
}, excelRu3x3)
console.log(which, 'synthetic', JSON.stringify(synthetic))
// real keyboard paste
let wrote = null
try {
  wrote = await page.evaluate(async (t) => { await navigator.clipboard.writeText(t); return 'ok' }, excelRu3x3)
} catch (e) { wrote = String(e).slice(0, 120) }
await page.evaluate(() => { window.__realPaste = null; document.addEventListener('paste', (e) => { window.__realPaste = { len: e.clipboardData?.getData('text/plain')?.length ?? null, target: e.target?.getAttribute?.('role') ?? e.target?.tagName } }, { once: true, capture: true }) })
await page.evaluate(() => window.__spike.grid.focus(50, 'unit'))
await page.keyboard.press('ControlOrMeta+V')
await page.waitForTimeout(200)
console.log(which, 'writeText', wrote, 'real paste event', JSON.stringify(await page.evaluate(() => window.__realPaste)), 'row50', JSON.stringify(await page.evaluate(() => { const r = window.__spike.store.get(window.__spike.view[50]); return [r.unit, r.price, r.inStock] })))
// a range copy
await page.evaluate(() => { window.__realCopy = null; document.addEventListener('copy', (e) => { window.__realCopy = { target: e.target?.getAttribute?.('role') } }, { once: true, capture: true }) })
await page.evaluate(() => window.__spike.grid.select(50, 'unit', 51, 'price'))
await page.keyboard.press('ControlOrMeta+C')
await page.waitForTimeout(200)
console.log(which, 'real copy event', JSON.stringify(await page.evaluate(() => window.__realCopy)))
await browser.close(); await srv.close()
