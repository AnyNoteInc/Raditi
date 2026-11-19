// Orders of magnitude only, one page per case (no timing loops: other runs share the machine).
// 1. A positive control of the spike's frame probe: a 150 ms busy task must show up as a long
//    task, a long-animation-frame and a long rAF interval — else «0 long tasks» proves nothing.
// 2. One sample of render → paint, JS heap over an empty page and DOM size: 300 and 5 000 rows,
//    laptop and phone with the CPU 4× slower, in the full Chromium (as the spike's measure.mjs).
// 3. One scroll gesture of 3 000 px over 5 000 rows on the laptop: frame p95 and the worst frame.
//   node quick-sanity.mjs <dist dir>
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { serve } from './server.mjs'

const server = await serve(process.argv[2])
const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim().replace(/.*load averages?: /, 'load ')
console.log(uptime())

async function open(profile, rows) {
  const browser = await chromium.launch({ channel: 'chromium' })
  const context = await browser.newContext(profile.ctx)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  if (profile.throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle })
  await page.goto(`${server.origin}/?rows=${rows}&seed=1`)
  await page.waitForFunction(() => window.__spike?.ready === true, null, { timeout: 60_000 })
  await page.waitForTimeout(400)
  await cdp.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(300)
  const { metrics } = await cdp.send('Performance.getMetrics')
  const heap = metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1048576
  const r = await page.evaluate(() => ({
    renderToPaint: window.__spike.marks['table:painted'] - window.__spike.marks['render:start'],
    dom: document.getElementsByTagName('*').length,
  }))
  return { browser, page, cdp, heap, ...r }
}

const stats = (rep) => {
  const iv = rep.intervals.filter((x) => x > 0).sort((a, b) => a - b)
  return { frames: iv.length, p95: iv[Math.floor(0.95 * iv.length)]?.toFixed(1), max: iv.at(-1)?.toFixed(1), long: rep.longTasks.length, loafs: rep.loafs.length }
}

// 1. Positive control.
{
  const { browser, page } = await open({ ctx: { viewport: { width: 1440, height: 900 } } }, 300)
  await page.evaluate(() => window.__spike.frames.start())
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    setTimeout(() => {
      const t = performance.now()
      while (performance.now() - t < 150) {}
    }, 0)
  })
  await page.waitForTimeout(500)
  const rep = await page.evaluate(() => window.__spike.frames.stop())
  console.log('positive control, a 150 ms task:', JSON.stringify(stats(rep)))
  await browser.close()
}

// 2 and 3.
const PROFILES = {
  laptop: { ctx: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  'phone ×4': { ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, throttle: 4 },
}
for (const [name, profile] of Object.entries(PROFILES)) {
  const base = await open(profile, 0)
  const empty = base.heap
  await base.browser.close()
  for (const rows of [300, 5000]) {
    const o = await open(profile, rows)
    let scroll = ''
    if (name === 'laptop' && rows === 5000) {
      await o.page.evaluate(() => window.__spike.frames.start())
      const box = await o.page.locator('[data-grid]').boundingBox()
      await o.cdp.send('Input.synthesizeScrollGesture', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), yDistance: -3000, speed: 1500, gestureSourceType: 'mouse', preventFling: true })
      scroll = ` scroll 3 000 px: ${JSON.stringify(stats(await o.page.evaluate(() => window.__spike.frames.stop())))}`
    }
    console.log(`${name}, ${rows} rows: render → paint ${o.renderToPaint.toFixed(0)} ms, JS heap ${o.heap.toFixed(1)} MB (+${(o.heap - empty).toFixed(1)} over the empty page), DOM ${o.dom}${scroll}`)
    await o.browser.close()
  }
}
console.log(uptime())
await server.close()
