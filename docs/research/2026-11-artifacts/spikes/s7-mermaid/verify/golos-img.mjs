// Skeptic check: is the embedded Golos Text really used inside <img>? Compare the <img> of an SVG with the
// @font-face (data:) and the same SVG with a font name that does not exist (fallback). A difference means the
// embedded face was applied.   node verify/golos-img.mjs [chromium,webkit|firefox]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const pw = require('playwright-core')
const { PNG } = require('pngjs')
const pixelmatch = require('pixelmatch').default || require('pixelmatch')
const { sanitizeFinal } = await import(new URL('../lib/sanitize.mjs', import.meta.url))
const { golosFontFaces } = await import(new URL('../lib/fonts.mjs', import.meta.url))
const raw = readFileSync(new URL('../out/verify/raw/F01.mm-text.svg', import.meta.url), 'utf8')
const golos = golosFontFaces().css
const withFace = sanitizeFinal(raw, { fontCss: golos + 'text,tspan{font-family:"Golos Text",serif!important}' }).svg
const noFace = sanitizeFinal(raw, { fontCss: 'text,tspan{font-family:"Golos Text",serif!important}' }).svg
for (const name of (process.argv[2] || 'chromium,webkit').split(',')) {
  const browser = await pw[name].launch()
  const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 })
  await page.route('**/*', (r) => r.abort())
  await page.setContent('<!doctype html><body style="margin:0"><div id="h"></div></body>')
  const shot = async (svg) => { await page.evaluate(async (src) => { const h = document.getElementById('h'); h.textContent = ''; const i = new Image(); i.src = src; h.appendChild(i); await i.decode() }, 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')); return PNG.sync.read(await page.locator('#h img').screenshot()) }
  const a = await shot(withFace), b = await shot(noFace)
  const n = a.width === b.width && a.height === b.height ? pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) : -1
  console.log(name, 'Golos face vs fallback, differing pixels:', n < 0 ? 'size differs' : `${(100 * n / (a.width * a.height)).toFixed(2)} %`)
  await browser.close()
}
