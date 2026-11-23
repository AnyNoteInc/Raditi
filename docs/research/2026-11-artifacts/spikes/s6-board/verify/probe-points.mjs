// WebKit: is the swallowed wheel tied to an inner scroller under the cursor, or to the whole frame?
// m1-orig (the spike's mockup m1 + bridge, no wheel listener) and tall-nowl with inner scrollers.
import { start } from './vserver.mjs'
const pw = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start({ host: process.env.HOST ?? '127.0.0.1' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await pw[process.argv[2] ?? 'webkit'].launch()
for (const doc of (process.env.DOCS ?? 'm1-orig.html;tall-nowl.html?h=3000&ovx=1').split(';')) for (const mode of ['none', 'shield']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${srv.cp}/pointer.html?${new URLSearchParams({ fo: `http://127.0.0.1:${srv.fp}`, doc, mode, ready: 'load', scale: '0.35', h: '4166', fh: '4166', scrolling: 'no', y: '-300' })}`)
  await page.waitForFunction(() => window.__v?.ready, null, { timeout: 30000 }); await sleep(1200)
  const r = await page.evaluate(() => window.__frameRect())
  const f = page.frames().find((x) => x !== page.mainFrame())
  const out = []
  for (let y = 40; y < 900; y += 110) {
    const x = Math.round((r.left + Math.min(r.right, 1440)) / 2)
    const fy = (y - r.top) / 0.35, fx = (x - r.left) / 0.35
    const under = await f.evaluate(({ fx, fy }) => { let e = document.elementFromPoint(fx, fy); const chain = []; while (e && chain.length < 6) { const cs = getComputedStyle(e); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') chain.push(`${e.className || e.tagName}[${cs.overflowX}/${cs.overflowY}]`); e = e.parentElement } return chain.join('>') || '-' }, { fx, fy })
    await page.mouse.move(x, y); await page.evaluate(() => window.__reset())
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 60); await sleep(60) }
    await sleep(300)
    out.push(`${y}:${(await page.evaluate(() => window.__v.board.wheel))}/3 ${under}`)
  }
  console.log(`${process.argv[2] ?? 'webkit'} ${process.platform} ${doc} ${mode}: ${out.join(' | ')}`)
  await ctx.close()
}
await browser.close(); await srv.close()
