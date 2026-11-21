// Skeptic check of spike 7: (1) jsdom/parse5 and DOMPurify lower-case feDropShadow; (2) with the lower-case
// name Chromium and Firefox stop drawing the node shapes, WebKit does not; (3) <img> of an SVG with
// width="100%" is not shown at its own size. Own minimal clean-up (DOMPurify DOM out + XMLSerializer,
// size by regex), own pixel count (coloured pixels), not the harness sanitizeFinal/images.mjs.
//   node verify/dropshadow.mjs [chromium,webkit|firefox]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const pw = require('playwright-core')
const { JSDOM } = require('jsdom')
const createDOMPurify = require('dompurify')
const { PNG } = require('pngjs')

const which = (process.argv[2] || 'chromium,webkit').split(',')
const raw = (id) => readFileSync(new URL(`../out/verify/raw/${id}.mm-text.svg`, import.meta.url), 'utf8')

// (1) the parser itself
const probe = new JSDOM('<!doctype html><body><svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feDropShadow dx="1"/><feGaussianBlur/></filter></svg></body>')
const names = [...probe.window.document.querySelectorAll('filter > *')].map((e) => e.localName)
const window = new JSDOM('').window
const DOMPurify = createDOMPurify(window)
const clean = (svg) => {
  const frag = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true })
  let out = new window.XMLSerializer().serializeToString(frag.querySelector('svg'))
  const vb = out.match(/viewBox="([^"]+)"/)[1].split(/[\s,]+/).map(Number)
  out = out.replace(/ width="100%"/, ` width="${Math.ceil(vb[2])}"`).replace(/<svg /, `<svg height="${Math.ceil(vb[3])}" `)
  return out
}
const lines = [`jsdom parse of <feDropShadow>: ${JSON.stringify(names)}`]

// coloured pixels: saturation of at least 0.12 and not near white — node fills and strokes of Mermaid's theme
const colored = (buf) => { const p = PNG.sync.read(buf); let n = 0; for (let i = 0; i < p.data.length; i += 4) { const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx > 0 && (mx - mn) / mx >= 0.06 && mn < 250) n++ } return +(100 * n / (p.width * p.height)).toFixed(2) }

mkdirSync(new URL('../out/verify/png/', import.meta.url), { recursive: true })
for (const b of which) {
  const browser = await pw[b].launch()
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 1 })
  const reqs = []
  await ctx.route('**/*', (r) => { reqs.push(r.request().url()); r.abort().catch(() => {}) })
  const page = await ctx.newPage()
  await page.setContent('<!doctype html><body style="margin:0;background:#fff"><div id="h"></div></body>')
  for (const id of ['F01', 'F03', 'ST01', 'C01']) {
    const lower = clean(raw(id))
    const upper = lower.replace(/<fedropshadow\b/g, '<feDropShadow').replace(/<\/fedropshadow>/g, '</feDropShadow>')
    const res = {}
    for (const [k, svg] of [['lower', lower], ['camel', upper], ['raw', raw(id)]]) {
      const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
      const info = await page.evaluate(async (src) => { const h = document.getElementById('h'); h.textContent = ''; const img = new Image(); img.src = src; h.appendChild(img); try { await img.decode() } catch (e) { return { err: String(e) } } return { nw: img.naturalWidth, nh: img.naturalHeight, cw: img.clientWidth, ch: img.clientHeight } }, src)
      let pct = null
      if (!info.err && info.cw > 0) { const buf = await page.locator('#h img').screenshot(); writeFileSync(new URL(`../out/verify/png/${b}-${id}-${k}.png`, import.meta.url), buf); pct = colored(buf) }
      res[k] = { ...info, coloredPct: pct }
    }
    lines.push(`${b} ${id}: lower-case name in clean SVG: ${/<fedropshadow\b/.test(lower)}; coloured px lower ${res.lower.coloredPct}% vs camel ${res.camel.coloredPct}%; <img> size raw ${res.raw.nw}×${res.raw.nh} shown ${res.raw.cw}×${res.raw.ch} | fixed ${res.camel.nw}×${res.camel.nh}`)
  }
  lines.push(`${b} requests from <img>: ${reqs.length}`)
  await browser.close()
}
console.log(lines.join('\n'))
