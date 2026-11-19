// A clean drag from the background into an unprotected frame: a fresh browser per case (Firefox keeps
// the zoom of a site across contexts), no ctrl+wheel before. Capture strategies: none, on pointerdown,
// after 3 px of movement (as the spike's board A does).
import { start } from './vserver.mjs'
const pw = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const engine = process.argv[2] ?? 'firefox'
for (const [mode, cap] of [['auto', 'none'], ['auto', 'down'], ['auto', 'move'], ['none', 'none'], ['shield', 'none']]) {
  const browser = await pw[engine].launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${srv.cp}/pointer.html?${new URLSearchParams({ fo: `http://127.0.0.1:${srv.fp}`, ready: 'load', scale: '0.35', h: '3000', fh: '3000', scrolling: 'no', mode, cap })}`)
  await page.waitForFunction(() => window.__v?.ready, null, { timeout: 30000 }); await sleep(500)
  const iw = await page.evaluate(() => innerWidth)
  const r = await page.evaluate(() => window.__frameRect())
  const y = Math.round(r.cy), sx = Math.round(r.left - 100)
  await page.evaluate(() => { window.__log.length = 0; window.__reset() })
  await page.mouse.move(sx, y); await page.mouse.down()
  for (let i = 1; i <= 35; i++) { await page.mouse.move(sx + i * 10, y); await sleep(8) }
  await page.mouse.up(); await sleep(300)
  const log = await page.evaluate(() => window.__log)
  const v = await page.evaluate(() => window.__v)
  const pm = log.filter((x) => x.startsWith('pointermove')).map((x) => Number(x.split(':')[1]))
  console.log(JSON.stringify({ engine: `${engine} ${process.platform}`, mode, cap, innerWidth: iw, parentPointermoves: pm.length, lastX: pm.at(-1), frameLeft: Math.round(r.left), endX: sx + 350, frameMoves: v.frame.pmove, parentPointerup: log.includes(`pointerup:${sx + 350}`) }))
  await browser.close()
}
await srv.close()
