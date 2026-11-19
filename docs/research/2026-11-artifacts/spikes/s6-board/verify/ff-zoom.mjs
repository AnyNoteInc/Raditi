// Firefox: does ctrl+wheel that lands in an unprotected frame zoom the whole tab (browser zoom), so the
// later pointer coordinates of the same page are off? Then a clean drag with each capture strategy.
import { start } from './vserver.mjs'
const pw = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const engine = process.argv[2] ?? 'firefox'
const browser = await pw[engine].launch()
const open = async (q) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${srv.cp}/pointer.html?${new URLSearchParams({ fo: `http://127.0.0.1:${srv.fp}`, ready: 'load', scale: '0.35', h: '3000', fh: '3000', scrolling: 'no', ...q })}`)
  await page.waitForFunction(() => window.__v?.ready, null, { timeout: 30000 }); await sleep(500)
  return { ctx, page }
}
const env = (page) => page.evaluate(() => ({ dpr: devicePixelRatio, innerWidth, vvScale: visualViewport?.scale }))
for (const mode of ['auto', 'none']) {
  const { ctx, page } = await open({ mode })
  const r = await page.evaluate(() => window.__frameRect())
  const before = await env(page)
  await page.mouse.move(Math.round(r.cx), Math.round(r.cy))
  await page.keyboard.down('Control'); for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -10); await sleep(40) } await page.keyboard.up('Control')
  await sleep(500)
  console.log(JSON.stringify({ engine, mode, step: 'ctrl+wheel over the frame', before, after: await env(page), boardCtrlWheel: (await page.evaluate(() => window.__v.board.wheelCtrl)) }))
  await ctx.close()
}
for (const cap of ['none', 'down', 'move']) {
  const { ctx, page } = await open({ mode: 'auto', cap })
  const r = await page.evaluate(() => window.__frameRect())
  const y = Math.round(r.cy), sx = Math.round(r.left - 100)
  await page.evaluate(() => { window.__log.length = 0; window.__reset() })
  await page.mouse.move(sx, y); await page.mouse.down()
  for (let i = 1; i <= 35; i++) { await page.mouse.move(sx + i * 10, y); await sleep(8) }
  await page.mouse.up(); await sleep(300)
  const log = await page.evaluate(() => window.__log)
  const v = await page.evaluate(() => window.__v)
  const pm = log.filter((x) => x.startsWith('pointermove')).map((x) => Number(x.split(':')[1]))
  console.log(JSON.stringify({ engine, mode: 'auto', cap, step: 'drag from the background into the frame', parentPointermoves: pm.length, lastX: pm.at(-1), frameLeft: Math.round(r.left), endX: sx + 350, frameMoves: v.frame.pmove, parentPointerup: log.includes(`pointerup:${sx + 350}`) }))
  await ctx.close()
}
await browser.close(); await srv.close()
