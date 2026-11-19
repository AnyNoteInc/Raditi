// auto4: after zooming in (live frames appear) and back out (they become thumbnails), is the memory of the
// frames' process given back later? Renderers and memory at +1, +5 and +15 s after zooming out.
import { startServers } from '../server.mjs'
import { launchChromium, LAPTOP, boardUrl, openBoard, memoryDump, summarizeMemory, processes, sleep } from '../lib.mjs'
const here = new URL('../', import.meta.url).pathname
const s = await startServers({ dist: here + 'dist', thumbs: here + 'thumbs' })
const browser = await launchChromium()
const page = await (await browser.newContext(LAPTOP)).newPage()
await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'a', live: 'auto4', pe: 'shield', frames: s.origins.sameSite }))
await sleep(2000)
const bs = await browser.newBrowserCDPSession()
const snap = async (label) => { const p = await processes(bs); const m = summarizeMemory(await memoryDump(bs), p); console.log(JSON.stringify({ label, live: await page.evaluate(() => window.__board.liveIds().length), renderers: p.filter((x) => x.type === 'renderer').length, totalMB: Math.round(m.total), gpuMB: Math.round(m.gpu) })) }
await snap('общий вид после загрузки')
await page.evaluate(() => { const b = window.__board, f = b.frames.find((x) => x.id === 'm2-a@1440'), r = b.rect(); b.setViewport({ zoom: 0.45, x: r.w / 2 - (f.x + f.w / 2) * 0.45, y: r.h / 2 - (f.y + 700) * 0.45 }) })
await sleep(500); await page.evaluate(() => window.__board.idle()); await sleep(1500)
await snap('приблизили, живые рамки')
await page.evaluate(() => window.__board.fitAll())
for (const t of [1, 5, 15]) { await sleep(t === 1 ? 1000 : t === 5 ? 4000 : 10000); await snap(`общий вид, +${t} с`) }
await browser.close(); await s.close()
