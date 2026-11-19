// Where Excel export starts to need a Web Worker from a blob: URL (a strict cabinet CSP refuses it).
import { chromium } from 'playwright-core'
import { serve } from './serve.mjs'
const srv = await serve()
const browser = await chromium.launch()
for (const n of [300, 500, 700, 1000, 1500, 2000]) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 60)))
  await page.goto(`${srv.origin}/?rows=${n}&csp=strict`)
  await page.waitForFunction(() => window.__spike?.ready === true)
  await page.locator('[data-tool=download]').click()
  const t0 = Date.now()
  const result = page.waitForEvent('download', { timeout: 8000 }).then(() => `file in ${Date.now() - t0} ms`, () => 'no file in 8 s')
  await page.locator('[data-download=xlsx]').click()
  console.log(n, await result, errors.length ? `| ${errors[0]}` : '')
  await context.close()
}
await browser.close(); await srv.close()
