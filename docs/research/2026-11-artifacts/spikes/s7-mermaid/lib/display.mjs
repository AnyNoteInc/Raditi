// Show SVGs the way the cabinet would — <img src="data:image/svg+xml;base64,…"> — in Chromium, WebKit
// and Firefox; then the same SVG inline, to measure whether label text fits its box with the fonts
// this browser has (an <img> uses the same system fonts as an inline SVG, and fonts the SVG embeds).
import { writeFileSync, mkdirSync } from 'node:fs'
import { decode, ink, pixelDiff, pixelDiffCrop } from './images.mjs'

const OVERFLOW = String.raw`
window.__overflow = (svgEl) => {
  const SHAPES = new Set(['rect', 'polygon', 'circle', 'ellipse', 'path'])
  const texts = [...svgEl.querySelectorAll('text')].filter((t) => t.textContent.trim())
  let checked = 0, over = 0, maxOver = 0
  const worst = []
  for (const t of texts) {
    const tr = t.getBoundingClientRect()
    if (tr.width < 1) continue
    const cx = tr.x + tr.width / 2, cy = tr.y + tr.height / 2
    let box = null
    let a = t.parentElement
    for (let level = 0; level < 4 && a && a !== svgEl.parentElement; level++, a = a.parentElement) {
      let best = null
      for (const c of a.children) {
        if (!SHAPES.has(c.localName) || c.contains(t)) continue
        const r = c.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) {
          if (!best || r.width * r.height < best.width * best.height) best = r
        }
      }
      if (best) { box = best; break }
    }
    if (!box) continue
    checked++
    const o = Math.max(0, box.x - tr.x, tr.x + tr.width - (box.x + box.width))
    if (o > 1) { over++; worst.push({ text: t.textContent.trim().slice(0, 40), over: +o.toFixed(1), box: +box.width.toFixed(1), text_w: +tr.width.toFixed(1) }) }
    if (o > maxOver) maxOver = o
  }
  worst.sort((x, y) => y.over - x.over)
  // HTML labels: the foreignObject has the size measured on the server; content larger than it is cut.
  let foChecked = 0, foClipped = 0
  const foWorst = []
  for (const fo of svgEl.querySelectorAll('foreignObject')) {
    const inner = fo.firstElementChild
    if (!inner || !inner.textContent.trim()) continue
    foChecked++
    const w = parseFloat(fo.getAttribute('width')) || 0, h = parseFloat(fo.getAttribute('height')) || 0
    const r = inner.getBoundingClientRect()
    const dw = r.width - w, dh = Math.max(inner.scrollHeight, r.height) - h
    if (dw > 1 || dh > 1) { foClipped++; foWorst.push({ text: inner.textContent.trim().slice(0, 40), dw: +dw.toFixed(1), dh: +dh.toFixed(1) }) }
  }
  return { texts: texts.length, checked, over, maxOver: +maxOver.toFixed(1), worst: worst.slice(0, 3), foChecked, foClipped, foWorst: foWorst.slice(0, 3) }
}
`

/**
 * @param {import('playwright-core').BrowserType} type
 * @param {{ key: string, svg: string, inline?: boolean }[]} items
 * @param {string} pngDir where screenshots go (work dir only)
 */
export async function displayRun(type, items, pngDir) {
  mkdirSync(pngDir, { recursive: true })
  const browser = await type.launch()
  const version = browser.version()
  // Two contexts: <img> only, and inline SVG (measurement and the engine's own render as reference).
  // Requests are recorded apart: an <img> must never make one; an inline raw SVG may (bm's @import).
  const requests = [], inlineRequests = []
  const imgContext = await browser.newContext({ viewport: { width: 2600, height: 2600 }, deviceScaleFactor: 1 })
  await imgContext.route('**/*', (route) => { requests.push(route.request().url()); route.abort().catch(() => {}) })
  const inlineContext = await browser.newContext({ viewport: { width: 2600, height: 2600 }, deviceScaleFactor: 1 })
  await inlineContext.route('**/*', (route) => { inlineRequests.push(route.request().url()); route.abort().catch(() => {}) })
  const imgPage = await imgContext.newPage()
  const inlinePage = await inlineContext.newPage()
  const blank = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}#host{display:inline-block;padding:0}img,svg{display:block}</style></head><body><div id="host"></div></body></html>'
  await imgPage.setContent(blank)
  await inlinePage.setContent(blank)
  await inlinePage.addScriptTag({ content: OVERFLOW })
  const out = {}
  for (const item of items) {
    const r = { }
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(item.svg, 'utf8').toString('base64')
    const loaded = await imgPage.evaluate(async (src) => {
      const host = document.getElementById('host')
      host.textContent = ''
      const img = new Image()
      img.src = src
      host.appendChild(img)
      try { await img.decode() } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 120), w: img.naturalWidth, h: img.naturalHeight } }
      return { ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight, cw: img.clientWidth, ch: img.clientHeight }
    }, dataUrl)
    Object.assign(r, { loaded: loaded.ok, naturalWidth: loaded.w, naturalHeight: loaded.h, shownWidth: loaded.cw, shownHeight: loaded.ch, error: loaded.error })
    let imgPng = null
    if (loaded.ok && loaded.cw > 0 && loaded.ch > 0) {
      const buf = await imgPage.locator('#host img').screenshot({ animations: 'disabled' })
      writeFileSync(`${pngDir}/${item.key}.img.png`, buf)
      imgPng = decode(buf)
      r.ink = ink(imgPng)
    }
    if (item.inline) {
      const res = await inlinePage.evaluate(async (svg) => {
        const host = document.getElementById('host')
        host.innerHTML = svg // sanitized SVG, in a disposable page with the network blocked
        await document.fonts.ready
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const el = host.querySelector('svg')
        if (!el) return { error: 'no svg' }
        const rect = el.getBoundingClientRect()
        const t = el.querySelector('text')
        return { ...window.__overflow(el), w: Math.round(rect.width), h: Math.round(rect.height), font: t ? getComputedStyle(t).fontFamily : null }
      }, item.svg)
      r.overflow = res
      if (!res.error && res.w > 0 && res.h > 0) {
        const buf = await inlinePage.locator('#host svg').screenshot({ animations: 'disabled' })
        writeFileSync(`${pngDir}/${item.key}.inline.png`, buf)
        const inlinePng = decode(buf)
        if (imgPng) r.imgVsInline = pixelDiff(imgPng, inlinePng)
      }
    }
    // Reference: the engine's own SVG, inserted into a page the way its documentation does, at the
    // same width. A large difference means the pipeline lost something (labels, shapes).
    if (item.ref && imgPng) {
      const ok = await inlinePage.evaluate(async ({ svg, w }) => {
        const host = document.getElementById('host')
        host.innerHTML = '<div id="refbox" style="width:' + w + 'px">' + svg + '</div>' // engine output, blocked page
        await document.fonts.ready
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const el = host.querySelector('svg')
        if (!el) return false
        el.style.display = 'block'
        return el.getBoundingClientRect().width > 0
      }, { svg: item.ref, w: loaded.w })
      if (ok) {
        const buf = await inlinePage.locator('#host svg').first().screenshot({ animations: 'disabled' })
        writeFileSync(`${pngDir}/${item.key}.ref.png`, buf)
        const refPng = decode(buf)
        r.refInk = ink(refPng)
        r.vsRef = pixelDiffCrop(imgPng, refPng)
      }
    }
    out[item.key] = r
  }
  await browser.close()
  return { version, results: out, requests, inlineRequests: [...new Set(inlineRequests)] }
}
