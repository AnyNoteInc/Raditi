// Skeptic check: the tag-stripping regex of normalizeSource crosses ], " and an arrow. Does Mermaid accept
// the text before and after?   node verify/normalize-risk.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { normalizeSource } = await import(new URL('../lib/normalize.mjs', import.meta.url))
const cases = ['flowchart LR\n  A[Цена <s 1000] --> B[Цена 800]', 'flowchart LR\n  A["x <i"] --> B[y]', 'flowchart LR\n  A["Скидка <b>10%</b>"] --> B[Оплата]']
const browser = await chromium.launch()
const ctx = await browser.newContext(); await ctx.route('**/*', (r) => r.abort())
const page = await ctx.newPage()
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
await page.addScriptTag({ content: readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8') })
for (const c of cases) {
  for (const [k, src] of [['before', c], ['after', normalizeSource(c)]]) {
    const r = await page.evaluate(async (src) => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true }); try { const { svg } = await window.mermaid.render('n' + Math.random().toString(36).slice(2), src); const t = [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map((e) => e.textContent).join(' | '); return 'ok: ' + t } catch (e) { return 'ERR ' + String(e.message).split('\n')[0] } }, src)
    console.log(k.padEnd(6), JSON.stringify(src.split('\n')[1]), '→', r.slice(0, 90))
  }
}
await browser.close()
