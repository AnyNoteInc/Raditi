// Ctrl+Я with a Russian layout (key «я», code KeyZ) as a trusted CDP key event, after an edit:
// does the grid undo it? The report says so; no script of the spike tests it.
import { chromium } from 'playwright-core'
import { serve } from './server.mjs'

const server = await serve(process.argv[2])
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const cdp = await page.context().newCDPSession(page)
await page.goto(`${server.origin}/?rows=300`)
const sel = '[data-grid] [role=row][aria-rowindex="4"] [data-col="price"] .txt'
await page.locator(sel).waitFor()
const original = await page.locator(sel).textContent()
await page.locator('[data-grid] [role=row][aria-rowindex="4"] [data-col="price"]').click()
await page.keyboard.press('7')
await page.keyboard.type('77')
await page.keyboard.press('Enter')
await page.waitForTimeout(80)
const edited = await page.locator(sel).textContent()
const key = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'я', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 })
await key('rawKeyDown')
await key('keyUp')
await page.waitForTimeout(80)
const after = await page.locator(sel).textContent()
const message = await page.locator('[data-message]').textContent()
console.log(JSON.stringify({ original, edited, afterCtrlYa: after, undone: after === original, message }))
await browser.close()
await server.close()
