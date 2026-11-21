// Skeptic check of spike 7: hostile diagrams beyond the builder's eight, with positive controls.
// Own page set-up (Mermaid served by route.fulfill, exposeFunction), not the harness MermaidPage. A hit is reported to
// Node through an exposed function, so a payload that overwrites page globals is still seen.
//   node verify/hostile.mjs   (from the spike folder, after pnpm install and node check.mjs)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { sanitizeFinal } = await import(new URL('../lib/sanitize.mjs', import.meta.url))

const mermaidJs = readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
const LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']
const IMG = (tag) => `<img src=x onerror="__hit('${tag}')">`

const probes = [
  // CTL1: loose + HTML labels. It does not hit — Mermaid 12 runs its own DOMPurify over labels even in
  // loose — but the label's <img> reaches the live page (a request for "x"). The real positive controls of
  // the detection are CTL2 below and CTL3/CTL4 in themecss.mjs.
  { id: 'CTL1', control: true, cfg: { securityLevel: 'loose', htmlLabels: true }, src: `flowchart LR\n  A["${IMG('CTL1')}Фото"] --> B[Ещё]` },
  { id: 'D1', src: `%%{init: {"dompurifyConfig": {"ADD_ATTR": ["onerror"], "ADD_TAGS": ["img"]}}}%%\nflowchart LR\n  A["${IMG('D1')}Фото"] --> B[Ещё]` },
  { id: 'D2', src: `---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n---\nflowchart LR\n  A["${IMG('D2')}Фото"] --> B[Ещё]` },
  { id: 'D3', src: `%%{init: {"flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A["<b>Жирный</b> текст"] --> B[Ещё]` },
  { id: 'D4', src: `%%{init: {"fontFamily": "x{} @import url(https://attacker.example/d4.css); .y{z}"}}%%\nflowchart LR\n  A[Узел] --> B[Узел 2]` },
  { id: 'D5', src: `%%{init: {"themeCSS": ".node rect { stroke-dasharray: 7 13; }"}}%%\nflowchart LR\n  A[Узел] --> B[Узел 2]` },
  { id: 'D5b', src: `%%{init: {"themeCSS": ".node rect { fill: url(https://attacker.example/d5.png); }"}}%%\nflowchart LR\n  A[Узел] --> B[Узел 2]` },
  { id: 'D6', src: `flowchart LR\n  A[Узел] --> B[Узел 2]\n  classDef evil fill:\\75 rl(https://attacker.example/d6.png)\n  class A evil` },
  { id: 'D6b', src: `flowchart LR\n  A[Узел] --> B[Узел 2]\n  style A fill:#fff,stroke:\\000075rl(//attacker.example/d6b.png)` },
  { id: 'D8', src: `sequenceDiagram\n  participant A as Склад\n  participant B as Касса\n  A->>B: ${IMG('D8a')} остатки\n  Note over A,B: ${IMG('D8b')} заметка` },
  { id: 'D9', src: `classDiagram\n  class Заказ["${IMG('D9a')}Заказ"] {\n    +String ${IMG('D9b')}\n  }` },
  { id: 'D10', src: `mindmap\n  root((${IMG('D10a')}Салон))\n    Соцсети\n      ::icon(fa"><img src=x onerror="__hit('D10b')">)` },
  { id: 'D11', src: `stateDiagram-v2\n  state "${IMG('D11')}Новый" as s1\n  [*] --> s1` },
  { id: 'D12', src: `gantt\n  dateFormat YYYY-MM-DD\n  section Работы\n  ${IMG('D12a')} Демонтаж :t1, 2026-11-20, 2d\n  click t1 href "javascript:__hit('D12b')"` },
  { id: 'D13', src: `erDiagram\n  CUSTOMER["${IMG('D13')}Клиент"] ||--o{ ORDER : "делает"` },
  { id: 'D14', src: `journey\n  title ${IMG('D14a')}Путь\n  section Дорога\n    ${IMG('D14b')}Увидел: 3: Гость` },
  { id: 'D15', src: 'timeline\n  title ' + IMG('D15a') + 'История\n  2019 : ' + IMG('D15b') + 'Открыли' },
  { id: 'D16', src: `quadrantChart\n  title ${IMG('D16a')}Задачи\n  quadrant-1 ${IMG('D16b')}Сейчас\n  Ответить: [0.8, 0.7]` },
  { id: 'D17', src: `pie title ${IMG('D17a')}Расходы\n  "${IMG('D17b')}Аренда" : 45\n  "Прочее" : 55` },
  { id: 'D18', src: 'flowchart LR\n  A["`**' + IMG('D18') + '** жирно`"] --> B[Ещё]' },
  { id: 'D19', src: `flowchart LR\n  A[Узел] --> B[Узел 2]\n  click A href "https://attacker.example/d19" _blank` },
]

const browser = await chromium.launch()
const results = []
for (const p of probes) {
  for (const mode of ['default', 'locked']) {
    for (const htmlLabels of p.control ? [true] : [false, true]) {
      const hits = [], requests = []
      const context = await browser.newContext()
      // The render page and Mermaid come from a fulfilled fake origin; every other request is aborted and counted.
      await context.route('**/*', (r) => {
        const u = r.request().url()
        if (u === 'https://render.invalid/') return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><script src="/m.js"></script><body></body>' })
        if (u === 'https://render.invalid/m.js') return r.fulfill({ contentType: 'text/javascript', body: mermaidJs })
        requests.push(u); r.abort().catch(() => {})
      })
      const page = await context.newPage()
      await page.exposeFunction('__hit', (tag) => hits.push(tag))
      await page.goto('https://render.invalid/')
      const cfg = { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels, flowchart: { htmlLabels }, ...(p.cfg || {}) }
      if (mode === 'locked') cfg.secure = LOCKED
      const r = await page.evaluate(async ({ src, cfg }) => {
        window.mermaid.initialize(cfg)
        try { const { svg } = await window.mermaid.render('x' + Math.random().toString(36).slice(2), src); return { svg } } catch (e) { return { error: String(e && e.message || e).split('\n')[0].slice(0, 160) } }
      }, { src: p.src, cfg })
      await page.waitForTimeout(300)
      const row = { id: p.id, mode, htmlLabels, ok: !!r.svg, error: r.error, hitsDuringRender: [...hits], requestsDuringRender: [...requests] }
      if (r.svg) {
        row.raw = { foreignObject: (r.svg.match(/<foreignObject/g) || []).length, import: /@import/i.test(r.svg), attacker: r.svg.includes('attacker.example'), onerror: /onerror/i.test(r.svg), cssEscapeUrl: /\\0*75\s?rl\(/i.test(r.svg), dash: /stroke-dasharray:\s*7/.test(r.svg) }
        const fin = sanitizeFinal(r.svg).svg
        row.final = { attacker: fin.includes('attacker.example'), cssEscapeUrl: /\\0*75\s?rl\(/i.test(fin), onerror: /onerror/i.test(fin), import: /@import/i.test(fin) }
        // Inline both into a blank page of a fresh context with the network blocked; count hits and requests.
        for (const [k, svg] of [['inlineRaw', r.svg], ['inlineFinal', fin]]) {
          const h2 = [], q2 = []
          const c2 = await browser.newContext()
          await c2.route('**/*', (rr) => { q2.push(rr.request().url()); rr.abort().catch(() => {}) })
          const p2 = await c2.newPage()
          await p2.exposeFunction('__hit', (tag) => h2.push(tag))
          await p2.setContent('<!doctype html><meta charset="utf-8"><body><div id="h"></div></body>')
          await p2.evaluate((s) => { document.getElementById('h').innerHTML = s }, svg)
          await p2.waitForTimeout(400)
          row[k] = { hits: h2, requests: q2 }
          await c2.close()
        }
      }
      results.push(row)
      await context.close()
    }
  }
}
// Control 2: the inline path itself detects a handler (SVG <image onerror> after innerHTML).
{
  const h = [], q = []
  const c = await browser.newContext()
  await c.route('**/*', (rr) => { q.push(rr.request().url()); rr.abort().catch(() => {}) })
  const pg = await c.newPage()
  await pg.exposeFunction('__hit', (tag) => h.push(tag))
  await pg.setContent('<!doctype html><body><div id="h"></div></body>')
  await pg.evaluate(() => { document.getElementById('h').innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><image href="x.png" onerror="__hit(\'CTL2\')"/><style>@import url(https://attacker.example/ctl2.css);</style></svg>' })
  await pg.waitForTimeout(400)
  results.push({ id: 'CTL2', control: true, hits: h, requests: q })
  await c.close()
}
await browser.close()
mkdirSync(new URL('../out/verify/', import.meta.url), { recursive: true })
writeFileSync(new URL('../out/verify/hostile.json', import.meta.url), JSON.stringify(results, null, 1))
for (const r of results) {
  if (r.id === 'CTL2') { console.log('CTL2 inline control: hits', JSON.stringify(r.hits), 'requests', r.requests.length); continue }
  const short = (o) => o ? JSON.stringify(o) : ''
  console.log([r.id, r.mode, 'html=' + r.htmlLabels, r.ok ? 'ok' : 'ERR ' + r.error, 'hitsRender=' + JSON.stringify(r.hitsDuringRender), 'req=' + r.requestsDuringRender.length, 'raw=' + short(r.raw), 'final=' + short(r.final), 'inlineRaw=' + (r.inlineRaw ? JSON.stringify(r.inlineRaw.hits) + '/' + r.inlineRaw.requests.length : ''), 'inlineFinal=' + (r.inlineFinal ? JSON.stringify(r.inlineFinal.hits) + '/' + r.inlineFinal.requests.length : '')].join(' | '))
}
