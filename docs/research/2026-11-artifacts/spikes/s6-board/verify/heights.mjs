// Independent check of «высота от моста совпадает с серверным рендером»: bridge heights from frames that
// are not pre-sized to the content, against the PNG heights of the thumbnails (IHDR, ×2) for all 10 screens.
import fs from 'node:fs'
import { startServers, SCREENS } from '../server.mjs'
const { chromium, webkit } = await import(process.env.PWCORE ?? 'playwright-core')
const here = new URL('../', import.meta.url).pathname
// the page must come from the spike's cabinet server (frame-ancestors of /v/), so it goes into its dist/
fs.copyFileSync(new URL('./pages/heights.html', import.meta.url), here + 'dist/heights.html')
const s = await startServers({ dist: here + 'dist', thumbs: here + 'thumbs' })
const png = (f) => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }
const tokens = SCREENS.map((x) => x.token)
const manifest = JSON.parse(fs.readFileSync(here + 'thumbs/screens.json', 'utf8')).screens
for (const [name, launch] of [['chromium', () => chromium.launch({ channel: 'chromium' })], ['webkit', () => webkit.launch()]]) {
  const browser = await launch()
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage()
  await page.goto(`${s.origins.cabinetLocal}/heights.html?${new URLSearchParams({ fo: s.origins.framesLoopback, tokens: tokens.join(',') })}`)
  await page.waitForFunction((n) => Object.keys(window.__h).length >= n, tokens.length * 2, { timeout: 60000 })
  await new Promise((r) => setTimeout(r, 2500)) // reveal transitions, carousels
  const h = await page.evaluate(() => window.__h)
  const mx = await page.evaluate(() => window.__max)
  const diffs = []
  for (const t of tokens) for (const w of [1440, 390]) {
    const p = png(`${here}thumbs/${t}-${w}.png`)
    const m = manifest.find((x) => x.token === t)[`h${w}`]
    diffs.push({ id: `${t}@${w}`, bridge: h[`${t}@${w}`], pngX2: p.h * 2, manifest: m, d: h[`${t}@${w}`] - m })
  }
  const seq = await page.evaluate(() => window.__seq)
  const odd = diffs.filter((x) => x.d !== 0 && name === 'chromium').map((x) => `${x.id}: ${seq[x.id]?.join(' ')}`)
  if (odd.length) console.log('  odd sequences:', odd.join(' | '))
  const transient = Object.entries(mx).filter(([id, v]) => v !== h[id]).map(([id, v]) => `${id}: ${v} → ${h[id]}`)
  console.log(name, JSON.stringify({ maxAbsDiffLast: Math.max(...diffs.map((x) => Math.abs(x.d))), transientLarger: transient, rows: diffs.map((x) => `${x.id}:${x.bridge}/${x.manifest}/${x.pngX2}`).join(' ') }))
  await browser.close()
}
await s.close()
