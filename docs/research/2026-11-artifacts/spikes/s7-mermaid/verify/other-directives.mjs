// Skeptic check: config keys outside the proposed `secure` list that a directive can still set and that
// change the picture: arrowMarkerAbsolute (marker URLs), theme (dark), fontSize.   node verify/other-directives.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { sanitizeFinal } = await import(new URL('../lib/sanitize.mjs', import.meta.url))
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']
const base = 'flowchart LR\n  A[Заказ] --> B[Оплата]'
const cases = { plain: base, arrowAbs: '%%{init: {"arrowMarkerAbsolute": true}}%%\n' + base, dark: '%%{init: {"theme": "dark"}}%%\n' + base, font: '%%{init: {"fontSize": 40}}%%\n' + base }
const browser = await chromium.launch()
const ctx = await browser.newContext(); await ctx.route('**/*', (r) => r.abort())
const page = await ctx.newPage()
await page.goto('about:blank')
await page.addScriptTag({ content: readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8') })
for (const [k, src] of Object.entries(cases)) {
  const svg = await page.evaluate(async ({ src, secure }) => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, secure }); return (await window.mermaid.render('o' + Math.random().toString(36).slice(2), src)).svg }, { src, secure: LOCKED })
  const marker = (svg.match(/marker-end="([^"]*)"/) || [])[1]
  const fin = sanitizeFinal(svg).svg
  const markerFinal = (fin.match(/marker-end="([^"]*)"/) || [])[1]
  console.log(k.padEnd(9), 'marker-end raw:', marker, '| final:', markerFinal, '| bg/fill sample:', (svg.match(/\.node rect[^}]*fill:([^;]+)/) || [])[1], '| font-size:', (svg.match(/font-size:([^;]+);/) || [])[1])
}
await browser.close()
