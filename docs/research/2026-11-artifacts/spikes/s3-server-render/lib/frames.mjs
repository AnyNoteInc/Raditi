// Frames of the spike: the stored artifact HTML (fixtures/*.html), stamped by the server the way
// plan 88 (Ар9) describes, and the document the platform assembles for the frame (§7.2): the
// platform's font faces, `artifact-file:<id>` links turned into signed addresses (Ар12).
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parse } from 'parse5'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const FIXTURES = join(ROOT, 'fixtures')
export const RENDER_ORIGIN = 'https://frame.render.invalid'
export const PLATFORM_ORIGIN = 'https://pages.render.invalid'
export const DOC_URL = `${RENDER_ORIGIN}/v/frame`
const require = createRequire(import.meta.url)

// ------------------------------------------------------------------ fonts of the platform
const FONT_DIR = join(dirname(require.resolve('@fontsource-variable/golos-text/package.json')), 'files')
export const FONT_FACES = [
  ['cyrillic-ext', 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F'],
  ['cyrillic', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'],
  ['latin-ext', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'],
  ['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
].map(([subset, range]) => ({ subset, range, file: `golos-text-${subset}-wght-normal.woff2`, bytes: readFileSync(join(FONT_DIR, `golos-text-${subset}-wght-normal.woff2`)) }))

/** The platform's font CSS: `route` — the library path of the pages host (Ар28), `data` — inline. */
export function fontCss(mode) {
  return FONT_FACES.map((f) => {
    const src = mode === 'data' ? `data:font/woff2;base64,${f.bytes.toString('base64')}` : `${PLATFORM_ORIGIN}/_lib/${f.file}`
    return `@font-face{font-family:"Golos Text";font-style:normal;font-display:swap;font-weight:400 900;src:url(${src}) format("woff2");unicode-range:${f.range}}`
  }).join('\n')
}

// ------------------------------------------------------------------ synthetic pictures
const ASSETS = {
  'hero-bread': [1200, 800, 'warm'], 'bun-1': [640, 480, 'warm'], 'bun-2': [640, 480, 'warm'], 'bun-3': [640, 480, 'warm'],
  map: [800, 450, 'map'], 'cake-1': [640, 480, 'sweet'], 'cake-2': [640, 480, 'sweet'], 'cake-3': [640, 480, 'sweet'],
  'team-1': [480, 480, 'people'], 'team-2': [480, 480, 'people'], 'team-3': [480, 480, 'people'], 'team-4': [480, 480, 'people'],
  'hero-workshop': [1600, 900, 'cool'], 'gallery-1': [800, 600, 'cool'], 'gallery-2': [800, 600, 'cool'], 'gallery-3': [800, 600, 'cool'],
  'gallery-4': [800, 600, 'cool'], 'gallery-5': [800, 600, 'cool'], 'gallery-6': [800, 600, 'cool'], storefront: [800, 600, 'cool'],
  'menu-1': [320, 240, 'coffee'], 'menu-2': [320, 240, 'coffee'], 'menu-3': [320, 240, 'coffee'], 'menu-4': [320, 240, 'sweet'], 'menu-6': [320, 240, 'warm'],
}
const PALETTES = {
  warm: ['#f3d9b1', '#c98b4a', '#8a4b2a', '#5e2f16', '#fff3e0'],
  sweet: ['#fce4ec', '#f8bbd0', '#d81b60', '#6d4c41', '#fff8e1'],
  people: ['#e0c3a8', '#a1887f', '#4e342e', '#90a4ae', '#eceff1'],
  cool: ['#cfd8dc', '#607d8b', '#263238', '#0f62fe', '#eceff1'],
  coffee: ['#d7ccc8', '#8d6e63', '#4e342e', '#3e2723', '#efebe9'],
  map: ['#eef2e6', '#c8e6c9', '#ffffff', '#b0bec5', '#ffcc80'],
}

/** Draw one picture in a Chromium page: seeded blobs, shapes and grain, like a photo for JPEG. */
async function drawJpeg(page, name, [w, h, theme]) {
  return page.evaluate(({ name, w, h, colors, map }) => {
    let seed = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const g = canvas.getContext('2d')
    const bg = g.createLinearGradient(0, 0, w, h)
    bg.addColorStop(0, colors[4]); bg.addColorStop(1, colors[0])
    g.fillStyle = bg; g.fillRect(0, 0, w, h)
    if (map) {
      g.strokeStyle = '#ffffff'; g.lineCap = 'round'
      for (let i = 0; i < 14; i++) { g.lineWidth = 6 + rnd() * 14; g.beginPath(); g.moveTo(rnd() * w, rnd() * h); g.lineTo(rnd() * w, rnd() * h); g.stroke() }
      for (let i = 0; i < 40; i++) { g.fillStyle = colors[1 + Math.floor(rnd() * 3)]; g.fillRect(rnd() * w, rnd() * h, 20 + rnd() * 60, 16 + rnd() * 40) }
      g.fillStyle = '#e65100'; g.beginPath(); g.arc(w * 0.55, h * 0.45, 14, 0, Math.PI * 2); g.fill()
    } else {
      g.filter = 'blur(24px)'
      for (let i = 0; i < 26; i++) { g.fillStyle = colors[Math.floor(rnd() * 4)]; g.globalAlpha = 0.35 + rnd() * 0.5; g.beginPath(); g.arc(rnd() * w, rnd() * h, 20 + rnd() * w / 4, 0, Math.PI * 2); g.fill() }
      g.filter = 'none'; g.globalAlpha = 1
      for (let i = 0; i < 7; i++) {
        g.fillStyle = colors[1 + Math.floor(rnd() * 3)]
        g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 18; g.shadowOffsetY = 8
        g.beginPath(); g.ellipse(rnd() * w, h * (0.35 + rnd() * 0.5), 30 + rnd() * w / 6, 20 + rnd() * h / 8, rnd() * Math.PI, 0, Math.PI * 2); g.fill()
      }
      g.shadowColor = 'transparent'
    }
    const img = g.getImageData(0, 0, w, h)
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 22; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n }
    g.putImageData(img, 0, 0)
    return canvas.toDataURL('image/jpeg', w <= 320 ? 0.6 : 0.82).split(',')[1]
  }, { name, w, h, colors: PALETTES[theme], map: theme === 'map' })
}

/** The pictures, drawn once into <work>/assets with a Chromium page. */
export async function ensureAssets(browser) {
  const dir = join(ROOT, 'assets')
  if (!existsSync(dir)) mkdirSync(dir)
  const missing = Object.keys(ASSETS).filter((name) => !existsSync(join(dir, `${name}.jpg`)))
  if (missing.length) {
    const context = await browser.newContext()
    const page = await context.newPage()
    for (const name of missing) writeFileSync(join(dir, `${name}.jpg`), Buffer.from(await drawJpeg(page, name, ASSETS[name]), 'base64'))
    await context.close()
  }
  return Object.fromEntries(Object.keys(ASSETS).map((name) => [name, readFileSync(join(dir, `${name}.jpg`))]))
}

// ------------------------------------------------------------------ the stamper (Ар9)
const NOT_STAMPED = new Set(['html', 'head', 'meta', 'link', 'title', 'style', 'script', 'noscript', 'template', 'base', 'br', 'wbr', 'source', 'track'])

/**
 * Give every element of the body a `data-raditi-id` by the offsets of parse5 (the source is
 * edited, the DOM is never serialized) and take out the `data-bug` marks of the fixtures, which
 * only the scorer reads.
 */
export function stamp(source) {
  const doc = parse(source, { sourceCodeLocationInfo: true })
  const edits = []
  const ids = []
  const bugs = {}
  const parents = {}
  let n = 0
  const visit = (node, inBody, inSvg, parentId = null) => {
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue
      const loc = child.sourceCodeLocation
      const bug = child.attrs.find((a) => a.name === 'data-bug')
      let id = null
      const body = inBody || child.tagName === 'body'
      if (body && loc && loc.startTag && !NOT_STAMPED.has(child.tagName) && !inSvg) {
        id = `e${++n}`
        ids.push(id)
        parents[id] = parentId
        let at = loc.startTag.endOffset - 1
        if (source[at - 1] === '/') at -= 1
        edits.push({ at, del: 0, text: ` data-raditi-id="${id}"` })
      }
      if (bug && loc && loc.attrs && loc.attrs['data-bug']) {
        const a = loc.attrs['data-bug']
        edits.push({ at: a.startOffset - 1, del: a.endOffset - a.startOffset + 1, text: '' })
        const url = child.attrs.find((x) => x.name === 'href' || x.name === 'src')
        bugs[bug.value] = { id, tag: child.tagName, url: url ? url.value : null }
      }
      if (child.tagName !== 'template') visit(child, body, inSvg || child.tagName === 'svg', id || parentId)
    }
  }
  visit(doc, false, false)
  edits.sort((a, b) => b.at - a.at)
  let out = source
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.del)
  return { html: out, ids, bugs, parents }
}

// ------------------------------------------------------------------ the frame document
export function listFixtures(kind = 'typical') {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.html') && (kind === 'all' || (kind === 'typical' ? /^\d\d-/.test(f) : /^h\d-/.test(f)))).sort().map((f) => f.replace(/\.html$/, ''))
}

/** Stamp the stored frame and assemble the document the frame host gives the browser. */
export function assembleFrame(name, { assets, fonts = 'route', trap = 'http://127.0.0.1:9', memory = 'heap' } = {}) {
  const stored = readFileSync(join(FIXTURES, `${name}.html`), 'utf8')
  const stamped = stamp(stored)
  let html = stamped.html
  html = html.replace(/\{\{DATA_JPEG:([\w-]+)\}\}/g, (_, id) => `data:image/jpeg;base64,${assets[id].toString('base64')}`)
  html = html.replace(/\{\{BROKEN_JPEG\}\}/g, () => `data:image/jpeg;base64,${assets['menu-1'].toString('base64').slice(0, 96)}`)
  html = html.replace(/\{\{TRAP\}\}/g, trap).replace(/\{\{MEMORY_KIND\}\}/g, memory)
  html = html.replace(/artifact-file:([\w-]+)/g, (_, id) => `${PLATFORM_ORIGIN}/_a/${id}.jpg?s=${Buffer.from(id).toString('hex').slice(0, 12)}`)
  html = html.replace(/<head>/i, `<head>\n<style data-raditi="fonts">\n${fontCss(fonts)}\n</style>`)
  return { name, html, ids: stamped.ids, bugs: stamped.bugs, parents: stamped.parents, storedBytes: Buffer.byteLength(stored), stampedBytes: Buffer.byteLength(stamped.html), bytes: Buffer.byteLength(html) }
}

export function manifest() {
  return JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
}
