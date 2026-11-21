// Which %%{init}%% directives Mermaid 12 applies with the default "secure" keys and with the extended
// list: themeCSS with url(), htmlLabels, fontFamily.   node probe-directives.mjs
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { hostile } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
const mermaidJs = readFileSync('node_modules/mermaid/dist/mermaid.min.js', 'utf8')
const browser = await chromium.launch()
const mp = await new MermaidPage(browser, { mermaidJs }).open()
const variants = {
  H03: hostile.find((h) => h.id === 'H03').source,
  'H03-noUrl': '%%{init: {"themeCSS": ".node rect { fill: #ff0000 !important }"}}%%\nflowchart LR\n    A[Узел] --> B[Узел 2]',
  'init-html': '%%{init: {"htmlLabels": true}}%%\nflowchart LR\n    A[Узел] --> B[Узел 2]',
  'init-font': '%%{init: {"fontFamily": "Comic Sans MS"}}%%\nflowchart LR\n    A[Узел] --> B[Узел 2]',
}
for (const [name, src] of Object.entries(variants)) {
  for (const [mode, secure] of [['default', undefined], ['locked', LOCKED_SECURE]]) {
    const r = await mp.render(src, { htmlLabels: false, seed: name + mode, secure }, 10000)
    const svg = r.svg || ''
    console.log(name.padEnd(10), mode.padEnd(8), 'ok', !!r.svg, 'attacker', svg.includes('attacker'), 'ff0000', svg.includes('#ff0000'), 'foreignObject', svg.includes('<foreignObject'), 'comic', /comic/i.test(svg), r.error ? r.error.slice(0, 80) : '')
  }
}
await browser.close()
