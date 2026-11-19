// Thumbnails, as the server would render them in apps/browser (Ар32, §7.13 «Выгрузка»): every screen
// at 1440 and 390, full height, PNG at half of CSS size (deviceScaleFactor 0.5) for the board;
// and the first phone screen (390×844) at 2× for the phone list (Ар49). Writes thumbs/screens.json
// with the content heights, which the board uses to size frames and thumbnails alike.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServers, SCREENS } from './server.mjs'
import { makeAssets } from './assets.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'thumbs')

async function shot(browser, url, { width, height, scale, full }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'load' })
  let h = height
  if (full) {
    h = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight))
    await page.setViewportSize({ width, height: h })
    // the real height after the viewport grew (sticky headers, vh units)
    h = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight))
    await page.setViewportSize({ width, height: h })
  }
  await page.waitForTimeout(1900) // reveal transitions and counters finish
  const buf = await page.screenshot({ animations: 'disabled', type: 'png' })
  await context.close()
  return { buf, h }
}

export async function makeThumbs({ force = false } = {}) {
  const manifest = path.join(out, 'screens.json')
  if (!force && fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8'))
  await makeAssets()
  fs.mkdirSync(out, { recursive: true })
  const s = await startServers()
  const browser = await chromium.launch()
  const screens = []
  let bytes = 0
  for (const sc of SCREENS) {
    const url = `${s.origins.framesLoopback}/v/${sc.token}`
    const d = await shot(browser, url, { width: 1440, height: 900, scale: 0.5, full: true })
    const p = await shot(browser, url, { width: 390, height: 844, scale: 0.5, full: true })
    const l = await shot(browser, url, { width: 390, height: 844, scale: 2, full: false })
    fs.writeFileSync(path.join(out, `${sc.token}-1440.png`), d.buf)
    fs.writeFileSync(path.join(out, `${sc.token}-390.png`), p.buf)
    fs.writeFileSync(path.join(out, `${sc.token}-list.png`), l.buf)
    bytes += d.buf.length + p.buf.length + l.buf.length
    screens.push({ ...sc, h1440: d.h, h390: p.h, bytes1440: d.buf.length, bytes390: p.buf.length, bytesList: l.buf.length })
  }
  await browser.close()
  await s.close()
  fs.writeFileSync(manifest, JSON.stringify({ made: new Date().toISOString(), scale: 0.5, screens }, null, 2))
  return { screens, bytes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t = Date.now()
  const r = await makeThumbs({ force: process.argv.includes('--force') })
  console.log(JSON.stringify(r.screens.map((x) => [x.token, x.h1440, x.h390, x.bytes1440, x.bytes390, x.bytesList])), `${Date.now() - t} ms`)
}
