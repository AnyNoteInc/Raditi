// Mermaid render of the whole corpus in one Chromium, plus which platform fonts Chromium used for the
// label text. Runs inside mcr.microsoft.com/playwright:v1.63.0-noble (the image of apps/browser) with
// --network none, to see what the production server would measure text with:
//   docker run --rm --name spike88-s7-linux --network none -v <scratch>:/work:ro -v <out>:/out \
//     mcr.microsoft.com/playwright:v1.63.0-noble node /work/render-linux.mjs /out/linux-render.json
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { corpus } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
import { golosFontFaces } from './lib/fonts.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export async function platformFonts(page, svg) {
  await page.evaluate((s) => { const h = document.createElement('div'); h.id = '__pf'; h.innerHTML = s; document.body.appendChild(h) }, svg)
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument', { depth: -1 })
  // Collect the text nodes under the inserted SVG (an element query returns nothing for nested tspans).
  const textNodes = []
  const find = (n) => { if (n.attributes && n.attributes.includes('__pf')) return n; for (const c of n.children || []) { const f = find(c); if (f) return f } return null }
  const walk = (n, inStyle) => {
    if (n.nodeType === 3 && !inStyle && n.nodeValue.trim()) textNodes.push(n.nodeId)
    for (const c of n.children || []) walk(c, inStyle || n.localName === 'style')
  }
  const host = find(root)
  if (host) walk(host, false)
  const fonts = {}
  for (const nodeId of textNodes.slice(0, 60)) {
    try {
      const { fonts: list } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
      for (const f of list) fonts[f.familyName] = (fonts[f.familyName] || 0) + f.glyphCount
    } catch {}
  }
  await session.detach()
  await page.evaluate(() => document.getElementById('__pf')?.remove())
  return fonts
}

// mm-text — Mermaid's own fonts; mm-text-golos — Golos Text loaded in the page and named in the config;
// mm-text-arial — one Arial-metric family for every diagram type (Liberation Sans on Linux, Arial elsewhere).
const FAMILIES = { 'mm-text': undefined, 'mm-text-golos': "'Golos Text', sans-serif", 'mm-text-arial': 'Arial, "Liberation Sans", sans-serif' }

export async function renderSet({ label, timeoutMs = 15000, variants = ['mm-text', 'mm-text-golos'] } = {}) {
  const mermaidJs = readFileSync(join(here, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8')
  const golos = golosFontFaces()
  const browser = await chromium.launch()
  const out = { label, platform: `${os.platform()} ${os.arch()}`, node: process.version, browser: browser.version(), variants: {} }
  for (const variant of variants) {
    const golosOn = variant === 'mm-text-golos'
    const page = await new MermaidPage(browser, { mermaidJs, fontCss: golosOn ? golos.css : undefined }).open()
    const rows = {}
    for (const d of corpus) {
      const r = await page.render(d.source, { htmlLabels: false, seed: d.id, secure: LOCKED_SECURE, fontFamily: FAMILIES[variant] }, timeoutMs)
      const row = { ok: !!r.svg, ms: r.ms, error: r.error, stage: r.stage, timedOut: r.timedOut, svg: r.svg }
      if (r.svg && ['F01', 'F02', 'S01', 'C01', 'E02', 'G01', 'J01', 'M01', 'P01', 'T01', 'Q01', 'ST01'].includes(d.id)) row.fonts = await platformFonts(page.page, r.svg)
      rows[d.id] = row
    }
    out.variants[variant] = rows
    await page.close()
  }
  await browser.close()
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || '/out/linux-render.json'
  const res = await renderSet({ label: 'linux', variants: process.argv[3] ? process.argv[3].split(',') : undefined })
  writeFileSync(target, JSON.stringify(res))
  const ok = Object.fromEntries(Object.entries(res.variants).map(([k, v]) => [k, Object.values(v).filter((x) => x.ok).length]))
  console.log(JSON.stringify({ platform: res.platform, browser: res.browser, ok, fontsF01: Object.fromEntries(Object.entries(res.variants).map(([k, v]) => [k, v.F01?.fonts])) }))
}
