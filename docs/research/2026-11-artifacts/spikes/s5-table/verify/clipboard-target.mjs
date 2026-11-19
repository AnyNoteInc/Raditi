// Where do copy and paste go when a focused element is not editable? A page without React or
// MUI: a div with tabindex, listeners on the div and on the document. Then the real keys, and
// a synthetic ClipboardEvent with a DataTransfer.
//   node clipboard-target.mjs [chromium|webkit|firefox]
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import { serve } from './server.mjs'

const which = process.argv[2] ?? 'chromium'
const type = { chromium, firefox, webkit }[which]
const server = await serve(join(import.meta.dirname, 'pages'))
const browser = await type.launch()
const context = await browser.newContext()
if (which === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin })
const page = await context.newPage()
await page.goto(`${server.origin}/clip.html`)
await page.locator('#g').click()
const focused = await page.evaluate(() => document.activeElement.id)
let wrote = 'n/a'
try {
  await page.evaluate(() => navigator.clipboard.writeText('hello from the clipboard'))
  wrote = 'ok'
} catch (e) {
  wrote = String(e).slice(0, 80)
}
await page.locator('#g').focus()
await page.keyboard.press('ControlOrMeta+C')
await page.keyboard.press('ControlOrMeta+V')
await page.waitForTimeout(100)
const real = await page.evaluate(() => window.log.splice(0))
let readBack = 'n/a'
try {
  readBack = await page.evaluate(() => navigator.clipboard.readText())
} catch (e) {
  readBack = String(e).slice(0, 80)
}
const synthetic = await page.evaluate(() => {
  const dt = new DataTransfer()
  dt.setData('text/plain', 'synthetic text')
  document.getElementById('g').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  return window.log.splice(0)
})
console.log(JSON.stringify({ browser: `${which} ${browser.version()}`, focused, wrote, real, readBack, synthetic }, null, 1))
await browser.close()
await server.close()
