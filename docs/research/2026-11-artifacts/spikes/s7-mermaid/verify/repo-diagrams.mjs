// Skeptic check: all Mermaid blocks of the repository docs (7, four of them not in the corpus) through
// Mermaid (Chromium, strict, locked secure, text labels) and beautiful-mermaid.
//   node verify/repo-diagrams.mjs <repo root>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { renderMermaidSVG } = await import(new URL('../node_modules/beautiful-mermaid/dist/index.js', import.meta.url))
const root = process.argv[2]
const files = ['docs/spec.md', 'docs/research/2026-09-subscriptions/p3-design.md', 'docs/research/2026-09-subscriptions/p3-litellm-design.md', 'docs/research/2026-09-bootstrap/sandbox.md']
const blocks = []
for (const f of files) {
  const lines = readFileSync(`${root}/${f}`, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === '```mermaid') { const s = i + 1; let e = s; while (lines[e].trim() !== '```') e++; blocks.push({ where: `${f}:${s}`, src: lines.slice(s, e).join('\n') }); i = e }
}
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']
const browser = await chromium.launch()
const ctx = await browser.newContext(); await ctx.route('**/*', (r) => r.abort())
const page = await ctx.newPage()
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
await page.addScriptTag({ content: readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8') })
for (const b of blocks) {
  const mm = await page.evaluate(async ({ src, secure }) => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, secure }); try { await window.mermaid.render('r' + Math.random().toString(36).slice(2), src); return 'ok' } catch (e) { return String(e.message).split('\n')[0] } }, { src: b.src, secure: LOCKED })
  let bm; try { renderMermaidSVG(b.src); bm = 'ok' } catch (e) { bm = String(e.message).slice(0, 60) }
  console.log(b.where.padEnd(52), (b.src.split('\n')[0]).padEnd(16), '| Mermaid:', mm.padEnd(26), '| bm:', bm)
}
await browser.close()
