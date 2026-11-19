// Server-side cleaning of an engine's SVG: DOMPurify (SVG profile) in jsdom, then a small hardening
// pass that DOMPurify does not do (CSS url()/@import, non-fragment href, explicit size), then an
// XML serializer, because the result is shown as <img src="data:image/svg+xml,…"> and must be XML.
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const { window } = dom
export const DOMPurify = createDOMPurify(window)
const xml = new window.XMLSerializer()
const SVG_NS = 'http://www.w3.org/2000/svg'

export const PROFILE_SVG = { USE_PROFILES: { svg: true, svgFilters: true } }
// Keeps Mermaid's HTML labels: foreignObject plus the HTML inside it.
export const PROFILE_SVG_FO = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['foreignObject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
}

function summarizeRemoved(removed) {
  const out = {}
  for (const r of removed) {
    const key = r.element ? `<${String(r.element.nodeName).toLowerCase()}>` : `@${r.attribute && r.attribute.name}`
    out[key] = (out[key] || 0) + 1
  }
  return out
}

/** The naive path: DOMPurify with the SVG profile, string out (HTML serialization). */
export function sanitizeString(svg, profile = PROFILE_SVG) {
  const clean = DOMPurify.sanitize(svg, profile)
  return { svg: clean, removed: summarizeRemoved(DOMPurify.removed) }
}

// SVG element names with capitals. jsdom parses with parse5 8.1.1, whose table of SVG names lacks
// feDropShadow: the element comes out as <fedropshadow>, the filter becomes invalid, and Chromium and
// Firefox then do not draw any shape that uses it (Mermaid 12 puts a drop shadow on every node).
const SVG_CAMEL = Object.fromEntries(['altGlyph', 'altGlyphDef', 'altGlyphItem', 'animateColor', 'animateMotion', 'animateTransform', 'clipPath',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight',
  'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology',
  'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence', 'foreignObject', 'glyphRef', 'linearGradient',
  'radialGradient', 'textPath'].map((n) => [n.toLowerCase(), n]))

function fixSvgNameCase(root, stats) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (el.namespaceURI !== SVG_NS) continue
    const camel = SVG_CAMEL[el.localName.toLowerCase()]
    if (!camel || camel === el.localName) continue
    const fixed = window.document.createElementNS(SVG_NS, camel)
    for (const a of el.attributes) fixed.setAttributeNS(a.namespaceURI, a.name, a.value)
    while (el.firstChild) fixed.appendChild(el.firstChild)
    el.replaceWith(fixed)
    stats.caseFixed = (stats.caseFixed || 0) + 1
  }
}

const EXTERNAL_URL = /url\(\s*(['"]?)(?!#|data:font\/|data:image\/(?:png|jpeg|gif|webp);)[^)]*\1\s*\)/gi
// The URL of an @import may itself contain ';' (Google Fonts: wght@400;500), so match url(…) or a string first.
const IMPORT = /@import\s+(?:url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)|'[^']*'|"[^"]*")[^;]*;?/gi

/**
 * The full path: DOMPurify (DOM out) → hardening → optional font → XMLSerializer.
 * @returns {{ svg: string, removed: object, stripped: object, size: object }}
 */
export function sanitizeFinal(svg, { profile = PROFILE_SVG, fontCss = null, fixSize = true, fixCase = true } = {}) {
  const frag = DOMPurify.sanitize(svg, { ...profile, RETURN_DOM_FRAGMENT: true })
  const removed = summarizeRemoved(DOMPurify.removed)
  const root = frag.querySelector('svg')
  if (!root) return { svg: '', removed, stripped: {}, size: null, empty: true }
  const stripped = { import: 0, url: 0, href: 0 }
  if (fixCase) fixSvgNameCase(root, stripped)
  for (const el of [root, ...root.querySelectorAll('*')]) {
    // An HTML element parsed from text keeps a literal xmlns attribute; the XML serializer adds its
    // own declaration, and two xmlns make the file invalid XML (WebKit and Firefox refuse the image).
    if (el.namespaceURI === 'http://www.w3.org/1999/xhtml' && el.hasAttribute('xmlns')) el.removeAttribute('xmlns')
    if (el.localName === 'style') {
      let css = el.textContent
      css = css.replace(IMPORT, () => { stripped.import++; return '' })
      css = css.replace(EXTERNAL_URL, () => { stripped.url++; return 'none' })
      el.textContent = css
      continue
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if ((name === 'href' || name === 'xlink:href') && !attr.value.trim().startsWith('#')) {
        el.removeAttribute(attr.name)
        stripped.href++
      } else if (/url\(/i.test(attr.value)) {
        const v = attr.value.replace(EXTERNAL_URL, () => { stripped.url++; return 'none' })
        if (v !== attr.value) el.setAttribute(attr.name, v)
      }
    }
  }
  let size = null
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb.every(Number.isFinite)) {
    size = { width: Math.ceil(vb[2]), height: Math.ceil(vb[3]), widthAttr: root.getAttribute('width'), heightAttr: root.getAttribute('height') }
    if (fixSize) {
      root.setAttribute('width', String(size.width))
      root.setAttribute('height', String(size.height))
      const st = root.getAttribute('style')
      if (st) root.setAttribute('style', st.replace(/max-width:[^;]*;?/gi, '').trim())
    }
  }
  if (fontCss) {
    const style = window.document.createElementNS(SVG_NS, 'style')
    style.textContent = fontCss
    root.insertBefore(style, root.firstChild)
  }
  return { svg: xml.serializeToString(root), removed, stripped, size }
}

const NS_URIS = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/XML/1998/namespace', 'http://www.w3.org/2000/xmlns/'])
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'data', 'poster', 'background'])
const EXTERNAL = /^\s*(?:https?:)?\/\//i
const CSS_EXTERNAL = /url\(\s*['"]?\s*(?:https?:)?\/\//i

/**
 * What in this SVG could run script, load from the network or escape <img>. Looks at elements,
 * attributes and CSS only: escaped text such as "&lt;img onerror=…&gt;" in a label is not a finding.
 */
export function scan(svg) {
  const holder = window.document.createElement('div')
  holder.innerHTML = String(svg) // jsdom, never executed
  const r = { script: false, handler: false, jsUrl: false, foreignObject: false, html: 0, externalUrl: 0, import: false, externalCssUrl: false, iframeObjectEmbed: false, dataHtml: false, sample: [] }
  const note = (u) => { if (r.sample.length < 3) r.sample.push(String(u).slice(0, 80)) }
  for (const el of holder.querySelectorAll('*')) {
    const name = el.localName.toLowerCase()
    if (name === 'script') r.script = true
    if (name === 'foreignobject') r.foreignObject = true
    if (['iframe', 'object', 'embed', 'frame'].includes(name)) r.iframeObjectEmbed = true
    if (el.namespaceURI === 'http://www.w3.org/1999/xhtml' && el.closest('svg')) r.html++
    if (name === 'style') {
      const css = el.textContent
      if (/@import/i.test(css)) r.import = true
      if (CSS_EXTERNAL.test(css)) { r.externalCssUrl = true; r.externalUrl++; note(css.match(CSS_EXTERNAL)[0]) }
      continue
    }
    for (const attr of el.attributes) {
      const an = attr.name.toLowerCase()
      const v = attr.value.replace(/[\u0000-\u0020]/g, '')
      if (an.startsWith('on')) r.handler = true
      if (/^(?:javascript|vbscript):/i.test(v) && (URL_ATTRS.has(an) || an.endsWith(':href'))) r.jsUrl = true
      if (/^data:text\/html/i.test(v)) r.dataHtml = true
      if ((URL_ATTRS.has(an) || an.endsWith(':href')) && EXTERNAL.test(attr.value) && !NS_URIS.has(attr.value)) { r.externalUrl++; note(attr.value) }
      if (an === 'xmlns' || an.startsWith('xmlns:')) continue
      if (CSS_EXTERNAL.test(attr.value)) { r.externalCssUrl = true; r.externalUrl++; note(attr.value) }
      if (an === 'style' && /@import/i.test(attr.value)) r.import = true
    }
  }
  return r
}

export function scanClean(r) {
  return !(r.script || r.handler || r.jsUrl || r.externalUrl || r.import || r.externalCssUrl || r.iframeObjectEmbed || r.dataHtml)
}
// foreignObject itself is not unsafe inside <img>; scanClean ignores it, the tables report it apart.

/** Is this string well-formed XML that a browser can load as image/svg+xml? */
export function xmlWellFormed(svg) {
  try {
    const doc = new window.DOMParser().parseFromString(svg, 'image/svg+xml')
    const err = doc.getElementsByTagName('parsererror')[0]
    if (err) return { ok: false, error: err.textContent.split('\n')[0].slice(0, 160) }
    return { ok: doc.documentElement && doc.documentElement.localName === 'svg' }
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 160) }
  }
}

const SKIP = new Set(['style', 'script', 'title', 'desc', 'metadata'])

/** Visible text of the SVG in document order: lines of a <text> joined by a space, <br> → space. */
export function textStream(svg) {
  const holder = window.document.createElement('div')
  holder.innerHTML = svg // jsdom only, never executed
  const parts = []
  const walk = (node, inText) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { parts.push(child.nodeValue); continue }
      if (child.nodeType !== 1) continue
      const name = child.localName
      if (SKIP.has(name)) continue
      if (name === 'br' || name === 'p' || name === 'div') parts.push(' ')
      if (name === 'text' || name === 'foreignobject' || name === 'foreignObject') { parts.push(' '); walk(child, true); parts.push(' '); continue }
      if (name === 'tspan' && inText && (child.hasAttribute('x') || child.hasAttribute('dy'))) parts.push(' ')
      walk(child, inText)
    }
  }
  walk(holder, false)
  return parts.join('').normalize('NFC').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim()
}

const squash = (s) => s.normalize('NFC').replace(/[\s  ]+/g, '')

/** Which expected labels are visible; tolerant to wrapping and spaces. */
export function labelRecall(stream, labels) {
  const flat = squash(stream)
  const missing = labels.filter((l) => !flat.includes(squash(l)))
  return { found: labels.length - missing.length, total: labels.length, missing }
}

/** Markup that leaked into visible text (escaped tags, entities, markdown markers, Mermaid codes). */
export function markupLeak(stream) {
  const hits = stream.match(/<\/?[a-z][^>]{0,40}>|&[a-z]{2,8};|&#\d+;|#lt;|#gt;|\*\*|`/gi) || []
  return hits.slice(0, 6)
}
