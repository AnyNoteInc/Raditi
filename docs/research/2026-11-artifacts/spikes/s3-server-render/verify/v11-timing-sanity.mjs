// Order-of-magnitude check of the s3 timings (skeptic; not a measurement — other spikes share the
// machine). Three frames, both widths, two passes: all outputs one by one, and the artifact_layout
// path (map of both widths side by side, no pictures).
//   node v11-timing-sanity.mjs <harness dir>
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.argv[2]
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { assembleFrame, ensureAssets } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, renderFrame } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)
const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim()
const FULL = { png: true, pdf: true, thumb: true, thumbWebp: true, strips: true }
const out = { before: uptime(), full: [], layout: [] }
const { browser, server, launchMs } = await launch(chromium)
out.launchMs = launchMs
const assets = await ensureAssets(browser)
for (let pass = 1; pass <= 2; pass++) {
  for (const name of ['02-price-list', '05-promo-banner', '10-one-page-site']) {
    const frame = assembleFrame(name, { assets })
    for (const width of [1440, 390]) {
      const r = await renderFrame(browser, frame, { width, assets, outputs: FULL })
      out.full.push({ pass, name, width, ms: r.t.total, error: r.error || null })
    }
    const t0 = performance.now()
    const both = await Promise.all([1440, 390].map((width) => renderFrame(browser, frame, { width, assets, outputs: {} })))
    out.layout.push({ pass, name, ms: Math.round(performance.now() - t0), errors: both.filter((b) => b.error).length })
  }
}
await browser.close(); await server.close()
out.after = uptime()
const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
out.summary = { fullMedianMs: med(out.full.filter((x) => x.pass === 2).map((x) => x.ms)), fullRange: [Math.min(...out.full.map((x) => x.ms)), Math.max(...out.full.map((x) => x.ms))], layoutMedianMs: med(out.layout.filter((x) => x.pass === 2).map((x) => x.ms)), layoutRange: [Math.min(...out.layout.map((x) => x.ms)), Math.max(...out.layout.map((x) => x.ms))] }
console.log(JSON.stringify(out, null, 1))
