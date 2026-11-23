// Would stripping formatting tags (all but <br>) from the text help Mermaid's text labels? And does
// it touch anything else in the corpus (<<choice>>, <|-- and arrows must survive)?
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { corpus } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
import { normalizeSource } from './lib/normalize.mjs'
import { textStream, labelRecall, markupLeak, sanitizeFinal } from './lib/sanitize.mjs'
const TAGS = /(?<!<)<\/?(?:b|i|u|em|strong|span|font|small|big|sup|sub|mark|code|s|strike|del|ins|p|div)\b[^<>]*>/gi
const plain = (s) => normalizeSource(s, { stripTags: false })
const strip = (s) => plain(s).replace(TAGS, '')
const changed = corpus.filter((d) => strip(d.source) !== plain(d.source)).map((d) => d.id)
console.log('changed by stripping:', changed.join(', '))
const mermaidJs = readFileSync('node_modules/mermaid/dist/mermaid.min.js', 'utf8')
const browser = await chromium.launch()
const mp = await new MermaidPage(browser, { mermaidJs }).open()
for (const id of changed) {
  const d = corpus.find((c) => c.id === id)
  for (const [name, src] of [['as is', d.source], ['fence + no-break spaces', plain(d.source)], ['+ tags stripped (normalizeSource)', normalizeSource(d.source)]]) {
    const r = await mp.render(src, { htmlLabels: false, seed: id + name.length, secure: LOCKED_SECURE }, 10000)
    if (!r.svg) { console.log(id, name, 'FAIL', r.error); continue }
    const t = textStream(sanitizeFinal(r.svg).svg)
    const rc = labelRecall(t, d.labels)
    console.log(id, name.padEnd(28), `labels ${rc.found}/${rc.total}`, 'leak', JSON.stringify(markupLeak(t)))
  }
}
await browser.close()
