// Which input event on a slow phone is long: typing into the sheet or into the search field.
import { chromium } from 'playwright-core'
import { serve } from './serve.mjs'
const srv = await serve()
const browser = await chromium.launch({ channel: 'chromium' })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await page.goto(srv.origin + '/?rows=300')
await page.waitForFunction(() => window.__spike?.ready === true)
const take = async (label) => {
  await page.waitForTimeout(300)
  const ev = await page.evaluate(() => { const e = window.__spike.events.splice(0); return e.filter((x) => x.duration >= 40).map((x) => `${x.name}:${Math.round(x.duration)}`) })
  console.log(label, JSON.stringify(ev))
}
await take('load')
for (let k = 0; k < 3; k++) {
  await page.locator('[role=listitem] .main').nth(k).tap()
  await page.locator('[data-sheet]').waitFor()
  await take(`open sheet ${k}`)
  await page.locator('[data-field=price]').fill(`${300 + k}`)
  await take(`fill price ${k}`)
  await page.getByRole('button', { name: 'Сохранить' }).tap()
  await page.locator('[data-sheet]').waitFor({ state: 'detached' })
  await take(`save ${k}`)
}
for (const q of ['торт', '', 'пирог', '']) {
  await page.locator('[data-search]').fill(q)
  await take(`search «${q}»`)
}
await browser.close(); await srv.close()
