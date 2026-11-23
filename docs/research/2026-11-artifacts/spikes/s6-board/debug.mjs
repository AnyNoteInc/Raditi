// Development helper: open one board, print errors, processes and a memory dump, save a screenshot.
// node debug.mjs impl=a live=2 [site=cross] [phone=1] [shot=out/x.png]
import { startServers } from './server.mjs'
import { launchChromium, LAPTOP, PHONE, boardUrl, openBoard, processes, memoryDump, summarizeMemory } from './lib.mjs'

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')))
const s = await startServers()
const browser = await launchChromium()
const context = await browser.newContext(arg.phone ? PHONE : LAPTOP)
const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.type(), m.text()) })
page.on('pageerror', (e) => console.log('pageerror', e.message))
const frames = arg.site === 'cross' ? s.origins.crossSite : s.origins.sameSite
const url = boardUrl(s.origins.cabinet, { impl: arg.impl ?? 'a', live: arg.live ?? '2', pe: arg.pe ?? 'none', frames, busy: arg.busy })
const r = await openBoard(page, url)
console.log('ready', Math.round(r.t), 'ms; wall', r.wall, 'loads', r.loads.length)
console.log('viewport', JSON.stringify(await page.evaluate(() => window.__board.getViewport())))
console.log('live', JSON.stringify(await page.evaluate(() => window.__board.liveIds())))
await page.waitForTimeout(1500)
console.log('heights', JSON.stringify(await page.evaluate(() => [...window.__heights])))
const bs = await browser.newBrowserCDPSession()
const procs = await processes(bs)
console.log('procs', JSON.stringify(procs.map((p) => [p.type, p.pid])))
const dump = await memoryDump(bs)
console.log('dump ok', dump.ok, 'n', dump.procs.length)
console.log(JSON.stringify(summarizeMemory(dump, procs), null, 1))
if (arg.shot) await page.screenshot({ path: arg.shot })
await browser.close()
await s.close()
