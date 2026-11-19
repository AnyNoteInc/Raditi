// Independent check of the pointer claims of spike s6 (not the spike's check.mjs):
// a plain page, one sandboxed frame from a second origin on a board that never moves, and counters
// of what the board and the frame received (the frame reports by postMessage).
//   node pointer.mjs --engines=chromium,webkit [--out=out/pointer-mac.json]
//   in the Playwright container: PWCORE=/pw/index.mjs node pointer.mjs --engines=firefox,webkit,chromium --host=0.0.0.0
import fs from 'node:fs'
import { start, HOST_RULES } from './vserver.mjs'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3)
const pw = await import(process.env.PWCORE ?? 'playwright-core')
const engines = arg('engines', 'chromium,webkit').split(',')
const out = arg('out', `out/pointer-${process.platform}.json`)
const srv = await start({ host: arg('host', '127.0.0.1') })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const log = (r) => { rows.push(r); console.log(JSON.stringify(r)) }

async function launch(engine) {
  if (engine === 'chromium') return pw.chromium.launch({ channel: 'chromium', args: [HOST_RULES] })
  return pw[engine].launch()
}
function origins(engine) {
  // Chromium: same site as production (pages.* next to the cabinet), the hosts mapped to 127.0.0.1.
  // WebKit and Firefox: 127.0.0.1 on two ports — also the same site.
  return engine === 'chromium'
    ? { cab: `http://cabinet.example.com:${srv.cp}`, fo: `http://pages.example.com:${srv.fp}` }
    : { cab: `http://127.0.0.1:${srv.cp}`, fo: `http://127.0.0.1:${srv.fp}` }
}

async function open(browser, engine, q) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const o = origins(engine)
  const u = new URL(`${o.cab}/pointer.html`)
  for (const [k, v] of Object.entries({ fo: o.fo, ...q })) u.searchParams.set(k, String(v))
  await page.goto(u.toString())
  await page.waitForFunction(() => window.__v?.ready, null, { timeout: 30000 })
  await sleep(300)
  return { ctx, page }
}
const V = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__v)))
const reset = (page) => page.evaluate(() => window.__reset())

async function gestures(engine, browser, q) {
  const { ctx, page } = await open(browser, engine, q)
  const r = await page.evaluate(() => window.__frameRect())
  const c = { x: Math.round(r.cx), y: Math.round(r.cy) }
  const res = { engine: `${engine} ${process.platform}`, ...q, top: await page.evaluate(({ x, y }) => window.__at(x, y), c) }
  // wheel over the frame
  await reset(page); await page.mouse.move(c.x, c.y)
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 100); await sleep(60) }
  await sleep(400); let v = await V(page)
  res.wheel = { board: v.board.wheel, frame: v.frame.wheel, frameScrollY: v.frame.scrollY }
  // ctrl+wheel over the frame (trackpad pinch)
  await reset(page); await page.keyboard.down('Control')
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -40); await sleep(60) }
  await page.keyboard.up('Control'); await sleep(400); v = await V(page)
  res.ctrlWheel = { board: v.board.wheelCtrl, boardAny: v.board.wheel, frame: v.frame.wheel }
  // drag that starts on the frame
  await reset(page); await page.mouse.move(c.x, c.y); await page.mouse.down()
  for (let i = 1; i <= 20; i++) { await page.mouse.move(c.x + i * 10, c.y); await sleep(8) }
  await page.mouse.up(); await sleep(300); v = await V(page)
  res.dragOnFrame = { boardDown: v.board.pdown, boardMoves: v.board.pmove, frameDown: v.frame.pdown, frameMoves: v.frame.pmove }
  // drag from the background into the frame (the board does not follow, so the pointer really enters it)
  const sx = Math.round(r.left - 100)
  await reset(page); await page.mouse.move(sx, c.y); await page.mouse.down()
  for (let i = 1; i <= 35; i++) { await page.mouse.move(sx + i * 10, c.y); await sleep(8) }
  await page.mouse.up(); await sleep(300); v = await V(page)
  res.dragInto = { boardMoves: v.board.pmove, boardMovesOverFrame: v.board.movesOverFrame, boardMaxX: Math.round(v.board.maxX), frameLeft: Math.round(r.left), endX: sx + 350, boardUp: v.board.pup, frameMoves: v.frame.pmove }
  // double click on the frame
  await reset(page); await page.mouse.dblclick(c.x, c.y); await sleep(300); v = await V(page)
  res.dblclick = { board: v.board.dbl, frame: v.frame.dbl }
  // Escape after a click on the frame (only meaningful when the frame takes the pointer)
  await reset(page); await page.mouse.click(c.x, c.y); await sleep(200); await page.keyboard.press('Escape'); await sleep(300); v = await V(page)
  res.escape = { board: v.board.key, frame: v.frame.key, frameClick: v.frame.click }
  await ctx.close()
  return res
}

for (const engine of engines) {
  let browser
  try { browser = await launch(engine) } catch (e) { log({ engine: `${engine} ${process.platform}`, error: String(e.message).split('\n')[0].slice(0, 300) }); continue }
  const version = browser.version()
  for (const mode of ['auto', 'none', 'shield', 'coveronly']) {
    // board-like frame: full content height, scrolling="no"; and a frame that scrolls itself (900 px of 3000)
    for (const variant of [{ scrolling: 'no', fh: 3000 }, { scrolling: 'auto', fh: 900 }]) {
      try { log({ version, ...(await gestures(engine, browser, { mode, cap: 'move', scale: 0.35, h: 3000, ...variant })) }) } catch (e) { log({ engine, mode, ...variant, error: String(e.message).slice(0, 300) }) }
    }
  }
  // no transform at all (scale 1), pe:none — does the transform matter?
  try { log({ version, ...(await gestures(engine, browser, { mode: 'none', cap: 'move', scale: 1, h: 3000, scrolling: 'no', fh: 3000, x: 100, y: 60 })) }) } catch (e) { log({ engine, error: String(e.message).slice(0, 300) }) }
  // pointer capture strategies for the drag into the frame, no protection
  for (const cap of ['none', 'down']) {
    try { log({ version, ...(await gestures(engine, browser, { mode: 'auto', cap, scale: 0.35, h: 3000, scrolling: 'no', fh: 3000 })) }) } catch (e) { log({ engine, cap, error: String(e.message).slice(0, 300) }) }
  }
  await browser.close()
}
await srv.close()
fs.mkdirSync('out', { recursive: true })
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, rows }, null, 2))
