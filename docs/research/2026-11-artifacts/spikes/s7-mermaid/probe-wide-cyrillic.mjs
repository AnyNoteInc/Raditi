// Does the label text fit its box: a hand-made SVG (control) and beautiful-mermaid with wide Cyrillic
// letters, with its default font and with Golos Text embedded.   node probe-wide-cyrillic.mjs
import { chromium, webkit } from 'playwright-core'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { displayRun } from './lib/display.mjs'
import { sanitizeFinal } from './lib/sanitize.mjs'
import { golosFontFaces } from './lib/fonts.mjs'
const wide = 'flowchart LR\n  A[Щщщщщщщщ Жжжжжжжж Шшшшшшшш] --> B[ЩЖШЮЫМДФ ЩЖШЮЫМДФ]\n  B --> C[iiiiiiii llllllll]\n  C --> D[WWWWWWWW MMMMMMMM]'
const manual = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60" viewBox="0 0 300 60"><g><rect x="10" y="10" width="60" height="30" fill="#eee"/><text x="40" y="30" text-anchor="middle" font-size="16">Текст шире рамки</text></g></svg>'
const items = [
  { key: 'manual', svg: manual, inline: true },
  { key: 'bm-wide', svg: sanitizeFinal(renderMermaidSVG(wide)).svg, inline: true },
  { key: 'bm-wide-golos', svg: sanitizeFinal(renderMermaidSVG(wide, { font: 'Golos Text' }), { fontCss: golosFontFaces().css }).svg, inline: true },
]
for (const t of [chromium, webkit]) {
  const r = await displayRun(t, items, new URL('./out/png/probe-' + t.name(), import.meta.url).pathname)
  for (const [k, v] of Object.entries(r.results)) console.log(t.name(), k, JSON.stringify(v.overflow))
}
