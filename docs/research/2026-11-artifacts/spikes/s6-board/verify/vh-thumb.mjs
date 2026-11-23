// The spike's thumbnail method (thumbs.mjs: measure at 900, grow the viewport, measure again, grow, shoot the
// viewport) on a page with a min-height: 100vh hero: what does the final viewport show?
import { start } from './vserver.mjs'
const { chromium } = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.5 })).newPage()
await p.goto(`http://127.0.0.1:${srv.fp}/vh.html`)
let h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight)); await p.setViewportSize({ width: 1440, height: h })
h = await p.evaluate(() => Math.ceil(document.documentElement.scrollHeight)); await p.setViewportSize({ width: 1440, height: h })
const r = await p.evaluate(() => ({ viewport: innerHeight, content: document.documentElement.scrollHeight, hero: Math.round(document.querySelector('.hero').getBoundingClientRect().height), firstSectionTop: Math.round(document.querySelector('section').getBoundingClientRect().top) }))
console.log(JSON.stringify({ recordedHeight: h, ...r }))
await b.close(); await srv.close()
