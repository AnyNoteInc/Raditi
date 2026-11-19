// The same probe, but the grid keeps the text selection away as the spike's grid does
// (mousedown → preventDefault, then focus()): which element gets copy and paste then?
//   node clipboard-target-nosel.mjs [chromium|webkit|firefox]
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
const out = { browser: `${which} ${browser.version()}` }
for (const [label, file] of [['selection inside the grid', 'clip.html'], ['no selection (mousedown prevented)', 'clip-nosel.html']]) {
  await page.goto(`${server.origin}/${file}`)
  await page.locator('#g').click()
  const state = await page.evaluate(() => ({
    active: document.activeElement.id || document.activeElement.tagName,
    selectionIn: (() => {
      const s = getSelection()
      return s.rangeCount ? (s.anchorNode?.parentElement?.id || s.anchorNode?.nodeName) : 'none'
    })(),
  }))
  await page.keyboard.press('ControlOrMeta+C')
  await page.keyboard.press('ControlOrMeta+V')
  await page.waitForTimeout(100)
  const log = await page.evaluate(() => window.log.splice(0))
  out[label] = { ...state, events: log.map((e) => `${e.where}:${e.type}→${e.target}`) }
}
console.log(JSON.stringify(out, null, 1))
await browser.close()
await server.close()
