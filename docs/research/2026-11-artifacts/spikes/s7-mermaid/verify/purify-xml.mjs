// Skeptic check: an alternative to restoring SVG names — DOMPurify parsing the SVG as XML
// (PARSER_MEDIA_TYPE 'application/xhtml+xml'), so parse5's HTML table is never used.   node verify/purify-xml.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { JSDOM } = require('jsdom')
const createDOMPurify = require('dompurify')
const window = new JSDOM('').window
const DOMPurify = createDOMPurify(window)
const dir = new URL('../out/verify/raw/', import.meta.url)
let n = 0, kept = 0, empty = 0, camelLost = 0, xmlOk = 0
const emptyIds = []
for (const f of readdirSync(dir).filter((f) => f.endsWith('.mm-text.svg'))) {
  const raw = readFileSync(new URL(f, dir), 'utf8')
  n++
  const out = DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true, svgFilters: true }, PARSER_MEDIA_TYPE: 'application/xhtml+xml' })
  if (!/<svg\b/.test(out)) { empty++; emptyIds.push(f.split('.')[0]); continue }
  if (/<feDropShadow\b/.test(raw)) { if (/<feDropShadow\b/.test(out)) kept++; else camelLost++ }
  const doc = new window.DOMParser().parseFromString(out, 'image/svg+xml')
  if (!doc.getElementsByTagName('parsererror').length) xmlOk++
}
console.log(JSON.stringify({ diagrams: n, emptyAfterPurify: empty, emptyIds, feDropShadowKept: kept, feDropShadowLost: camelLost, xmlOk }))
