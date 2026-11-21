// Skeptic check of spike 7: how many expected labels survive DOMPurify's SVG profile, counted by the
// browser's XML parser (DOMParser image/svg+xml in Chromium) instead of the harness's jsdom text walk.
// Own minimal clean-up: DOMPurify (jsdom) DOM out + XMLSerializer, no hardening.   node verify/labels.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const { JSDOM } = require('jsdom')
const createDOMPurify = require('dompurify')
const { corpus } = await import(new URL('../corpus.mjs', import.meta.url))

const dir = new URL('../out/verify/raw/', import.meta.url)
const window = new JSDOM('').window
const DOMPurify = createDOMPurify(window)
const clean = (svg, fo) => {
  const cfg = fo ? { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ['foreignObject'], HTML_INTEGRATION_POINTS: { foreignobject: true }, RETURN_DOM_FRAGMENT: true } : { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true }
  const frag = DOMPurify.sanitize(svg, cfg)
  const el = frag.querySelector('svg')
  for (const h of el.querySelectorAll('*')) if (h.namespaceURI === 'http://www.w3.org/1999/xhtml') h.removeAttribute('xmlns')
  return new window.XMLSerializer().serializeToString(el)
}
const files = readdirSync(dir)
const browser = await chromium.launch()
const page = await browser.newPage()
const squash = (s) => s.normalize('NFC').replace(/[\s   ]+/g, '')
const totals = {}
let foRaw = 0, foDiagrams = 0
for (const variant of ['mm-text', 'mm-html', 'mm-html+fo']) {
  let found = 0, total = 0, allSeen = 0, n = 0
  for (const d of corpus) {
    const f = `${d.id}.${variant.replace('+fo', '')}.svg`
    if (!files.includes(f)) continue
    const raw = readFileSync(new URL(f, dir), 'utf8')
    if (variant === 'mm-html') { const c = (raw.match(/<foreignObject\b/g) || []).length; foRaw += c; if (c) foDiagrams++ }
    const svg = clean(raw, variant.endsWith('+fo'))
    const text = await page.evaluate((s) => {
      const doc = new DOMParser().parseFromString(s, 'image/svg+xml')
      if (doc.querySelector('parsererror')) return null
      return [...doc.querySelectorAll('text, foreignObject')].map((e) => e.textContent).join(' ')
    }, svg)
    n++
    if (text == null) { total += d.labels.length; continue }
    const flat = squash(text)
    const seen = d.labels.filter((l) => flat.includes(squash(l))).length
    found += seen; total += d.labels.length; if (seen === d.labels.length) allSeen++
  }
  totals[variant] = { diagrams: n, allLabelsSeen: allSeen, found, total }
}
console.log(JSON.stringify({ totals, foreignObjectsInRawHtml: foRaw, diagramsWithForeignObject: foDiagrams }, null, 1))
await browser.close()
