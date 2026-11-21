// node busy-split.mjs   |   HZ=1 node busy-split.mjs — the same with live frames hidden while zooming
// a busy live frame in its own process: does the cabinet stall while panning, while zooming, or idle?
import { startServers } from './server.mjs'
import { launchChromium, LAPTOP, boardUrl, openBoard, mouseDrag, wheel, sleep, frameStats } from './lib.mjs'
const s = await startServers()
for (const [busy, proc] of [[1, 'default'], [0, 'default'], [1, 'shared']]) {
  const browser = await launchChromium(proc === 'shared' ? { disable: ['IsolateSandboxedIframes'] } : {})
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'a', live: 2, pe: 'shield', busy, hz: process.env.HZ, frames: s.origins.sameSite }))
  await page.evaluate(() => { const b = window.__board, f = b.frames[0], r = b.rect(); b.setViewport({ zoom: 0.3, x: r.w / 2 - (f.x + f.w / 2) * 0.3, y: r.h / 2 - (f.y + 700) * 0.3 }) })
  await sleep(800)
  const r = await page.evaluate(() => window.__board.rect())
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const phase = async (name, fn) => { await page.evaluate(() => window.__perf.start()); await fn(); const st = frameStats(await page.evaluate(() => window.__perf.stop())); console.log(`busy=${busy} ${proc} ${name}: fps ${st.fps} p95 ${st.p95} max ${st.max} >50 ${st.over50} longTasks ${st.longTasks}`) }
  await phase('idle 2 s', () => sleep(2000))
  await phase('pan only', async () => { await mouseDrag(page, c, { x: c.x - 300, y: c.y }, { steps: 40, gap: 10 }); await mouseDrag(page, c, { x: c.x + 300, y: c.y }, { steps: 40, gap: 10 }) })
  await phase('zoom only', async () => { await wheel(page, c, { dy: -8, n: 20, ctrl: true }); await wheel(page, c, { dy: 8, n: 20, ctrl: true }) })
  await browser.close()
}
await s.close()
