// Skeptic check of spike 7, engines: Mermaid parse() and render() in Chromium and in WebKit (Mermaid served
// from a fulfilled fake origin, not addScriptTag), beautiful-mermaid in the main thread (no worker).
// Saves the raw SVGs for xmllint and for labels.mjs.   node verify/engines.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium, webkit } = require('playwright-core')
const { renderMermaidSVG } = await import(new URL('../node_modules/beautiful-mermaid/dist/index.js', import.meta.url))
const { corpus } = await import(new URL('../corpus.mjs', import.meta.url))

const OUT = new URL('../out/verify/raw/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const mermaidJs = readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']

async function mermaidPage(type) {
  const browser = await type.launch()
  const context = await browser.newContext()
  const stray = []
  await context.route('**/*', (r) => {
    const u = r.request().url()
    if (u === 'https://render.invalid/') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script src="/m.js"></script><body></body>' })
    if (u === 'https://render.invalid/m.js') return r.fulfill({ contentType: 'text/javascript', body: mermaidJs })
    stray.push(u); r.abort().catch(() => {})
  })
  const page = await context.newPage()
  await page.goto('https://render.invalid/')
  return { browser, page, stray }
}

const run = async (page, src, htmlLabels, parseOnly) => page.evaluate(async ({ src, htmlLabels, parseOnly, secure }) => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels, flowchart: { htmlLabels }, secure })
  try {
    if (parseOnly) { const r = await window.mermaid.parse(src); return { ok: true, type: r && r.diagramType } }
    const { svg, diagramType } = await window.mermaid.render('v' + Math.random().toString(36).slice(2), src)
    return { ok: true, svg, type: diagramType }
  } catch (e) { return { ok: false, error: String(e && (e.message || e.str) || e).split('\n')[0].slice(0, 120) } }
}, { src, htmlLabels, parseOnly, secure: LOCKED })

const rows = {}
for (const d of corpus) rows[d.id] = { id: d.id, type: d.type, valid: d.valid }
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const { browser, page, stray } = await mermaidPage(type)
  for (const d of corpus) {
    const p = await run(page, d.source, false, true)
    const t = await run(page, d.source, false, false)
    rows[d.id][`${name}Parse`] = p.ok ? 'ok' : p.error
    rows[d.id][`${name}Render`] = t.ok ? 'ok' : t.error
    if (name === 'chromium') {
      if (t.ok) writeFileSync(`${OUT}${d.id}.mm-text.svg`, t.svg)
      const h = await run(page, d.source, true, false)
      if (h.ok) writeFileSync(`${OUT}${d.id}.mm-html.svg`, h.svg)
    }
  }
  rows._stray = { ...(rows._stray || {}), [name]: stray }
  await browser.close()
}
for (const d of corpus) {
  try { const svg = renderMermaidSVG(d.source); rows[d.id].bm = 'ok'; writeFileSync(`${OUT}${d.id}.bm.svg`, svg) } catch (e) { rows[d.id].bm = String(e.message).slice(0, 100) }
}
writeFileSync(new URL('../out/verify/engines.json', import.meta.url), JSON.stringify(rows, null, 1))
const ids = corpus.map((d) => d.id)
const count = (k) => ids.filter((id) => rows[id][k] === 'ok').length
console.log('ok of 30:', Object.fromEntries(['chromiumParse', 'chromiumRender', 'webkitParse', 'webkitRender', 'bm'].map((k) => [k, count(k)])))
const by = (pred) => ids.filter((id) => pred(rows[id]))
console.log('valid=true rendered by Mermaid (chromium):', by((r) => r.valid === true && r.chromiumRender === 'ok').length, 'of', by((r) => r.valid === true).length)
console.log('parse ok but render failed (chromium):', by((r) => r.chromiumParse === 'ok' && r.chromiumRender !== 'ok').join(','))
console.log('chromium vs webkit disagree:', by((r) => r.chromiumRender !== r.webkitRender).join(',') || 'none')
for (const id of ids) { const r = rows[id]; if (r.chromiumRender !== 'ok' || r.bm !== 'ok') console.log(id, r.type, r.valid, '| mm:', r.chromiumRender, '| bm:', r.bm) }
console.log('stray requests:', JSON.stringify(rows._stray))
