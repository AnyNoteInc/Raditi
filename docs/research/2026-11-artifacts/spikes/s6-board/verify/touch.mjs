// Touch in Chromium phone emulation (Pixel 7) on my plain board: one finger and two fingers that start on
// the frame — who gets the pointer events, the board or the frame? (not the spike's check T)
import { start, HOST_RULES } from './vserver.mjs'
const { chromium, devices } = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ channel: 'chromium', args: [HOST_RULES] })
for (const mode of ['auto', 'none', 'shield']) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await ctx.newPage()
  await page.goto(`http://cabinet.example.com:${srv.cp}/pointer.html?${new URLSearchParams({ fo: `http://pages.example.com:${srv.fp}`, mode, ready: 'load', scale: '0.2', h: '3000', fh: '3000', scrolling: 'no', x: '60', y: '60' })}`)
  await page.waitForFunction(() => window.__v?.ready, null, { timeout: 30000 }); await sleep(400)
  const r = await page.evaluate(() => window.__frameRect())
  const c = { x: Math.round(r.cx), y: Math.round(r.cy) }
  const cdp = await ctx.newCDPSession(page)
  await page.evaluate(() => window.__reset())
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] })
  for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + i * 8, y: c.y + i * 5, id: 1 }] }); await sleep(12) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(300)
  const one = await page.evaluate(() => JSON.parse(JSON.stringify(window.__v)))
  await page.evaluate(() => window.__reset())
  const pts = (d) => [{ x: c.x - d / 2, y: c.y, id: 1 }, { x: c.x + d / 2, y: c.y, id: 2 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) })
  for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(40 + i * 8) }); await sleep(12) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(300)
  const two = await page.evaluate(() => JSON.parse(JSON.stringify(window.__v)))
  console.log(JSON.stringify({ mode, oneFinger: { boardDown: one.board.pdown, boardMoves: one.board.pmove, frameDown: one.frame.pdown, frameMoves: one.frame.pmove }, twoFingers: { boardDown: two.board.pdown, boardMoves: two.board.pmove, frameDown: two.frame.pdown, frameMoves: two.frame.pmove }, pageScale: await page.evaluate(() => visualViewport.scale) }))
  await ctx.close()
}
await browser.close(); await srv.close()
