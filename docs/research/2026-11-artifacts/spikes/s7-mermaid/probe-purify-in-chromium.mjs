// DOMPurify inside Chromium (browser HTML parser) instead of jsdom: does it keep feDropShadow and give XML?
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { corpus } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
import { xmlWellFormed, sanitizeFinal } from './lib/sanitize.mjs'
const mermaidJs = readFileSync('node_modules/mermaid/dist/mermaid.min.js', 'utf8')
const purifyJs = readFileSync('node_modules/dompurify/dist/purify.min.js', 'utf8')
const browser = await chromium.launch()
const mp = await new MermaidPage(browser, { mermaidJs }).open()
await mp.page.addScriptTag({ content: purifyJs })
let okXml = 0, camel = 0, n = 0, jsdomCamelLost = 0
for (const d of corpus) {
  for (const htmlLabels of [false, true]) {
    const r = await mp.render(d.source, { htmlLabels, seed: d.id + 'p' + htmlLabels, secure: LOCKED_SECURE }, 10000)
    if (!r.svg) continue
    n++
    const out = await mp.page.evaluate(({ svg, fo }) => {
      const cfg = fo ? { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ['foreignObject'], HTML_INTEGRATION_POINTS: { foreignobject: true }, RETURN_DOM_FRAGMENT: true } : { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true }
      const frag = window.DOMPurify.sanitize(svg, cfg)
      const el = frag.querySelector('svg')
      return el ? new XMLSerializer().serializeToString(el) : ''
    }, { svg: r.svg, fo: htmlLabels })
    if (xmlWellFormed(out).ok) okXml++
    if (/<feDropShadow\b/.test(out)) camel++
    if (/<feDropShadow\b/.test(r.svg) && !/<feDropShadow\b/.test(sanitizeFinal(r.svg, { fixCase: false }).svg)) jsdomCamelLost++
  }
}
console.log(JSON.stringify({ renders: n, browserPurifyXmlOk: okXml, browserPurifyKeepsFeDropShadow: camel, jsdomLosesFeDropShadow: jsdomCamelLost }))
await browser.close()
