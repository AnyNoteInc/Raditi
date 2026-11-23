import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'

// The cleaning of an SVG Mermaid drew (docs/plan/88-artifacts.md, §7.13, slice 88.24а; spike 7):
// DOMPurify with the SVG profile in jsdom, a DOM out, then what DOMPurify does not do, then
// XMLSerializer — the picture is an `<img>` of `image/svg+xml`, and a string of `sanitize()` is HTML,
// not XML: `<br>` and `&nbsp;` break the image.

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

const { window } = new JSDOM('<!doctype html><html><body></body></html>')
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0])
const serializer = new window.XMLSerializer()

/**
 * SVG names with capitals: parse5 in jsdom lacks some (`feDropShadow` comes out `fedropshadow`), the
 * filter turns invalid, and Chromium and Firefox then draw no node that uses it — Mermaid 12 shades
 * every node.
 */
const SVG_CAMEL = new Map(
  [
    'altGlyph',
    'altGlyphDef',
    'altGlyphItem',
    'animateColor',
    'animateMotion',
    'animateTransform',
    'clipPath',
    'feBlend',
    'feColorMatrix',
    'feComponentTransfer',
    'feComposite',
    'feConvolveMatrix',
    'feDiffuseLighting',
    'feDisplacementMap',
    'feDistantLight',
    'feDropShadow',
    'feFlood',
    'feFuncA',
    'feFuncB',
    'feFuncG',
    'feFuncR',
    'feGaussianBlur',
    'feImage',
    'feMerge',
    'feMergeNode',
    'feMorphology',
    'feOffset',
    'fePointLight',
    'feSpecularLighting',
    'feSpotLight',
    'feTile',
    'feTurbulence',
    'foreignObject',
    'glyphRef',
    'linearGradient',
    'radialGradient',
    'textPath',
  ].map((name) => [name.toLowerCase(), name]),
)

/** `url(…)` that leaves the picture: only `#…` and inline fonts and pictures stay. */
const EXTERNAL_URL =
  /url\(\s*(['"]?)(?!#|data:font\/|data:image\/(?:png|jpeg|gif|webp);)[^)]*\1\s*\)/gi
/** An `@import`, whose URL may itself hold `;` (`wght@400;500`): a `url(…)` or a string first. */
const IMPORT = /@import\s+(?:url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)|'[^']*'|"[^"]*")[^;]*;?/gi

export interface CleanDiagram {
  svg: string
  width: number
  height: number
}

function fixNameCase(root: Element): void {
  for (const element of [...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== SVG_NS) continue
    const camel = SVG_CAMEL.get(element.localName.toLowerCase())
    if (!camel || camel === element.localName) continue
    const fixed = window.document.createElementNS(SVG_NS, camel)
    for (const attribute of [...element.attributes])
      fixed.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
    while (element.firstChild) fixed.appendChild(element.firstChild)
    element.replaceWith(fixed)
  }
}

/**
 * The clean XML of an SVG with its size from its `viewBox`; null — nothing of an SVG is left, or it
 * has no size to show it by.
 */
export function cleanDiagramSvg(raw: string): CleanDiagram | null {
  const fragment = purify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment
  const root = fragment.querySelector('svg')
  if (!root) return null
  fixNameCase(root)
  for (const element of [root, ...root.querySelectorAll('*')]) {
    // A literal xmlns beside the serializer's own makes the file invalid XML.
    if (element.namespaceURI === XHTML_NS && element.hasAttribute('xmlns'))
      element.removeAttribute('xmlns')
    if (element.localName === 'style') {
      element.textContent = (element.textContent ?? '')
        .replace(IMPORT, '')
        .replace(EXTERNAL_URL, 'none')
      continue
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if ((name === 'href' || name === 'xlink:href') && !attribute.value.trim().startsWith('#'))
        element.removeAttribute(attribute.name)
      else if (/url\(/i.test(attribute.value)) {
        const value = attribute.value.replace(EXTERNAL_URL, 'none')
        if (value !== attribute.value) element.setAttribute(attribute.name, value)
      }
    }
  }
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0) return null
  const width = Math.ceil(box[2]!)
  const height = Math.ceil(box[3]!)
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  const style = root.getAttribute('style')
  if (style) root.setAttribute('style', style.replace(/max-width:[^;]*;?/gi, '').trim())
  return { svg: serializer.serializeToString(root), width, height }
}
