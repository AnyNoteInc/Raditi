// The layout probe of a frozen frame (spike s3 of plan 88). It runs in an isolated world of the
// page (Page.createIsolatedWorld): it shares the DOM with the frame but none of its globals, so a
// script of the artifact cannot patch getComputedStyle or getBoundingClientRect to fool it.
// Plain browser JavaScript; `raditiLayoutProbe(opts)` returns a JSON-safe object.
// Coordinates are CSS px of the document, the page scrolled to the top.
function raditiLayoutProbe(opts) {
  const T = opts.thresholds
  const started = performance.now()
  const html = document.documentElement
  const body = document.body || html
  const se = document.scrollingElement || html
  // `instant`: a page with `scroll-behavior: smooth` would animate a plain scrollTo.
  const jump = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' })
  jump(0)
  const vw = window.innerWidth
  const vh = window.innerHeight
  const docW = se.scrollWidth
  const docH = se.scrollHeight
  const known = new Set(opts.ids)
  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'OPTION', 'SELECT', 'TITLE'])
  const REPLACED = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'PROGRESS', 'METER', 'PICTURE'])
  const PICTURES = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE'])
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial'])
  const tagOf = (el) => el.tagName.toUpperCase()

  // ---------------------------------------------------------------- helpers
  const styles = new Map()
  const cs = (el) => {
    let s = styles.get(el)
    if (!s) { s = getComputedStyle(el); styles.set(el, s) }
    return s
  }
  const stampedOf = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const v = e.getAttribute('data-raditi-id')
      if (v && known.has(v)) return e
    }
    return null
  }
  const label = (el) => {
    if (!el) return null
    const stamped = stampedOf(el)
    const target = stamped || el
    const raw = target.getAttribute('class') || ''
    const classes = raw.trim().split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]{0,30}$/.test(c)).slice(0, 2)
    return { id: stamped ? stamped.getAttribute('data-raditi-id') : null, tag: target.tagName.toLowerCase() + classes.map((c) => '.' + c).join(''), own: stamped === el }
  }
  const snippet = (text, n = 32) => {
    const t = text.replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n - 1) + '…' : t
  }
  const round = (n) => Math.round(n)
  const rectOf = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })
  const intersect = (a, b) => {
    const x = Math.max(a.x, b.x)
    const y = Math.max(a.y, b.y)
    const r = Math.min(a.x + a.w, b.x + b.w)
    const btm = Math.min(a.y + a.h, b.y + b.h)
    return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null
  }
  const area = (r) => (r ? r.w * r.h : 0)
  const parseColor = (text) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(text || '')
    if (!m) return null
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { r: +m[1], g: +m[2], b: +m[3], a }
  }
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a)
    if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 }
    const mix = (c) => (top[c] * top.a + bottom[c] * bottom.a * (1 - top.a)) / a
    return { r: mix('r'), g: mix('g'), b: mix('b'), a }
  }
  const lum = (c) => {
    const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
  }
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const WHITE = { r: 255, g: 255, b: 255, a: 1 }
  const isFixed = (el) => {
    for (let e = el; e && e !== body && e !== html; e = e.parentElement) { const p = cs(e).position; if (p === 'fixed' || p === 'sticky') return true }
    return false
  }
  const opacities = new Map()
  const opacityOf = (el) => {
    if (!el || el.nodeType !== 1) return 1
    if (opacities.has(el)) return opacities.get(el)
    const v = parseFloat(cs(el).opacity) * opacityOf(el.parentElement)
    opacities.set(el, v)
    return v
  }
  // The box an element is drawn into: the padding boxes of the ancestors that clip overflow.
  const INF = { x: -1e9, y: -1e9, w: 2e9, h: 2e9 }
  const clips = new Map()
  const clipOf = (el) => {
    if (!el || el.nodeType !== 1 || el === html) return INF
    if (clips.has(el)) return clips.get(el)
    const parent = el.parentElement
    let c = clipOf(parent)
    if (parent && parent !== html && parent !== body && cs(el).position !== 'fixed') {
      const s = cs(parent)
      const clipX = s.overflowX !== 'visible'
      const clipY = s.overflowY !== 'visible'
      if (clipX || clipY) {
        const r = parent.getBoundingClientRect()
        const box = { x: clipX ? r.left + parent.clientLeft : -1e9, y: clipY ? r.top + parent.clientTop : -1e9, w: clipX ? parent.clientWidth : 2e9, h: clipY ? parent.clientHeight : 2e9 }
        const inside = intersect(c, box)
        c = inside ? { ...inside, by: parent } : { x: 0, y: 0, w: 0, h: 0, by: parent }
      }
    }
    clips.set(el, c)
    return c
  }

  // ---------------------------------------------------------------- text blocks
  const items = new Map()
  const invisible = new Map()
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let textNodes = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue
    if (!raw || !raw.trim()) continue
    const el = node.parentElement
    if (!el || SKIP_TEXT.has(tagOf(el)) || el.closest('svg')) continue
    textNodes++
    const s = cs(el)
    if (s.visibility !== 'visible' || s.display === 'none') continue
    // display: none above, or skipped content (a closed <details>, content-visibility: hidden)
    if (el.checkVisibility && !el.checkVisibility()) continue
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
    if (!rects.length) continue
    const clip = clipOf(el)
    const shown = []
    let cut = 0
    let total = 0
    for (const r of rects) {
      const rr = rectOf(r)
      const vis = intersect(rr, clip)
      total += area(rr)
      if (vis && area(vis) >= 2) { shown.push(vis); cut += area(rr) - area(vis) } else cut += area(rr)
    }
    if (!shown.length) continue // clipped away on purpose: a closed accordion, a carousel slide
    const chars = raw.trim().length
    if (opacityOf(el) < 0.05) {
      // Laid out inside the frame but drawn transparent: it shows only after a script runs.
      let host = el
      for (let e = el; e && e !== body; e = e.parentElement) if (parseFloat(cs(e).opacity) < 0.05) host = e
      invisible.set(host, (invisible.get(host) || 0) + chars)
      continue
    }
    let item = items.get(el)
    if (!item) {
      item = { n: items.size, el, rects: [], chars: 0, text: '', cutArea: 0, area: 0, clipBy: null }
      items.set(el, item)
    }
    item.rects.push(...shown)
    item.chars += chars
    if (item.text.length < 80) item.text = (item.text + ' ' + raw).trim()
    item.cutArea += cut
    item.area += total
    if (cut > 0 && clip.by) item.clipBy = clip.by
  }

  // ---------------------------------------------------------------- checks
  const meta = document.querySelector('meta[name="viewport" i]')
  const viewportMeta = meta ? meta.getAttribute('content') || '' : null
  const overflowXHidden = ['hidden', 'clip'].includes(cs(html).overflowX) || ['hidden', 'clip'].includes(cs(body).overflowX)
  const issues = []
  const add = (kind, el, data) => issues.push({ kind, ...(el ? label(el) : {}), ...data })
  const all = [...body.getElementsByTagName('*')]

  // 1. Wider than the frame: the elements that poke out first.
  if (docW > vw + 1) {
    const culprits = []
    for (const el of all) {
      if (SKIP_TEXT.has(tagOf(el)) && tagOf(el) !== 'SELECT' && tagOf(el) !== 'TEXTAREA') continue
      const r = el.getBoundingClientRect()
      if ((r.width === 0 && r.height === 0) || r.right <= vw + 1) continue
      const s = cs(el)
      if (s.position === 'fixed') continue
      const clip = clipOf(el)
      if (Math.min(r.right, clip.x + clip.w) <= vw + 1) continue
      const parent = el.parentElement
      if (parent && parent !== body && parent !== html) {
        const pr = parent.getBoundingClientRect()
        const pclip = clipOf(parent)
        if (Math.min(pr.right, pclip.x + pclip.w) > vw + 1) continue
      }
      // A grid whose fixed tracks or a flex row without wrap is wider than itself: the container
      // is the cause, not the item that pokes out.
      let host = el
      let why = ''
      if (parent && parent !== body && parent !== html) {
        const ps = cs(parent)
        const tracks = ps.display.includes('grid') ? ps.gridTemplateColumns.split(' ').filter((v) => /px$/.test(v)) : []
        const gap = parseFloat(ps.columnGap) || 0
        if (tracks.length > 1 && tracks.reduce((a, v) => a + parseFloat(v), 0) + gap * (tracks.length - 1) > parent.clientWidth + 1) {
          host = parent
          why = 'grid-template-columns ' + snippet(ps.gridTemplateColumns, 40)
        } else if (ps.display.includes('flex') && ps.flexWrap === 'nowrap' && ps.flexDirection.startsWith('row') && parent.scrollWidth > parent.clientWidth + 1) {
          host = parent
          why = 'flex row without wrap'
        }
      }
      const hs = cs(host)
      if (!why) {
        if (hs.minWidth && hs.minWidth !== 'auto' && hs.minWidth !== '0px') why = 'min-width ' + hs.minWidth
        else if (host.getAttribute('style') && /width\s*:/.test(host.getAttribute('style'))) why = snippet(host.getAttribute('style'), 40)
        else if (host.getAttribute('width') && tagOf(host) === 'IMG') why = 'width ' + host.getAttribute('width')
        else if (hs.whiteSpace === 'nowrap' || hs.whiteSpace === 'pre') why = 'white-space ' + hs.whiteSpace
      }
      const hr = host === el ? r : host.getBoundingClientRect()
      const content = host === el ? r.width : Math.max(hr.width, host.scrollWidth)
      if (!culprits.some((c) => c.el === host)) culprits.push({ el: host, right: Math.max(r.right, hr.left + content), width: content, why })
    }
    culprits.sort((a, b) => b.right - a.right)
    add(overflowXHidden ? 'cut' : 'hscroll', null, {
      by: round(docW - vw),
      culprits: culprits.slice(0, 4).map((c) => ({ ...label(c.el), width: round(c.width), right: round(c.right), why: c.why })),
      more: Math.max(0, culprits.length - 4),
    })
  }

  // What is under a point of the page, top first; the page is scrolled to bring the point in.
  const stackAt = (x, y) => {
    jump(Math.max(0, y - vh / 2))
    return document.elementsFromPoint(Math.min(Math.max(x, 0), vw - 1), y - window.scrollY)
  }
  // The layers under a text block: its own background and those of the blocks below it.
  const backdropOf = (el, item) => {
    const layers = []
    // Uncertain when a block on the way is positioned (it may lie on a sibling picture) or no
    // opaque background is found at all (a picture may lie under the whole page): ask the stack.
    let uncertain = true
    for (let e = el; e; e = e.parentElement) {
      const es = cs(e)
      if (es.position === 'absolute' || es.position === 'fixed') break
      const bg = parseColor(es.backgroundColor)
      if ((bg && bg.a >= 0.999) || (es.backgroundImage && es.backgroundImage !== 'none')) { uncertain = false; break }
    }
    let chain
    if (uncertain) {
      const r = item.rects[0]
      const stack = stackAt(r.x + r.w / 2, r.y + r.h / 2)
      const i = stack.findIndex((e) => e === el || el.contains(e))
      if (i !== -1) chain = [el, ...stack.slice(i + 1).filter((e) => e !== el && !el.contains(e))]
    }
    if (!chain) { chain = []; for (let e = el; e; e = e.parentElement) chain.push(e) }
    for (const e of chain) {
      if (e !== el && PICTURES.has(tagOf(e))) return { image: e, layers }
      const es = cs(e)
      const bgi = es.backgroundImage
      if (bgi && bgi !== 'none') {
        if (/url\(/.test(bgi)) return { image: e, layers }
        const stops = [...bgi.matchAll(/rgba?\([^)]*\)/g)].map((m) => parseColor(m[0])).filter(Boolean)
        if (stops.length) return { gradient: stops, layers }
      }
      const bg = parseColor(es.backgroundColor)
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 0.999) return { layers } }
    }
    return { layers }
  }

  // 2–3. Per text block: small text, low contrast.
  const onImage = []
  for (const item of items.values()) {
    const el = item.el
    const s = cs(el)
    const size = parseFloat(s.fontSize)
    const weight = parseInt(s.fontWeight, 10) || 400
    item.size = size
    // Stars, arrows, bullets and emoji are pictures made of glyphs: no reading, no verdict.
    if (!/[\p{L}\p{N}]/u.test(item.text)) continue
    if (size < T.smallPx && item.chars >= 2) add('small-text', el, { px: Math.round(size * 10) / 10, text: snippet(item.text), chars: item.chars })
    if (el.closest(':disabled, [aria-disabled="true"]')) continue
    const clipText = (s.webkitBackgroundClip || s.backgroundClip || '').includes('text')
    let fg = parseColor(s.webkitTextFillColor && s.webkitTextFillColor !== s.color ? s.webkitTextFillColor : s.color)
    if (!fg || clipText || fg.a < 0.05) continue
    fg = { ...fg, a: fg.a * opacityOf(el) }
    const back = backdropOf(el, item)
    if (back.image) { onImage.push(item); continue }
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const need = large ? T.contrastLarge : T.contrastNormal
    const composite = (base) => { let c = base; for (let i = back.layers.length - 1; i >= 0; i--) c = over(back.layers[i], c); return c }
    if (back.gradient) {
      const values = back.gradient.map((stop) => { const bg = composite(over(stop, WHITE)); return { bg, k: ratio(over(fg, bg), bg) } })
      const min = values.reduce((a, b) => (b.k < a.k ? b : a))
      const max = values.reduce((a, b) => (b.k > a.k ? b : a))
      if (min.k < need) add('contrast', el, { ratio: Math.round(min.k * 10) / 10, upto: Math.round(max.k * 10) / 10, fg: hex(fg), bg: hex(min.bg) + '…' + hex(max.bg), gradient: true, need, text: snippet(item.text) })
      continue
    }
    const bg = composite(WHITE)
    const k = ratio(over(fg, bg), bg)
    if (k < need) add('contrast', el, { ratio: Math.round(k * 10) / 10, fg: hex(fg), bg: hex(bg), need, text: snippet(item.text) })
  }
  jump(0)

  // 4. Text cut by its own overflow or by a clipping ancestor (not a closed accordion).
  for (const item of items.values()) {
    const el = item.el
    const s = cs(el)
    const ownX = (s.overflowX !== 'visible' || s.textOverflow === 'ellipsis') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1
    const ownY = s.overflowY !== 'visible' && el.clientHeight >= 12 && el.scrollHeight > el.clientHeight + 2
    if (ownX || ownY) {
      add('clipped', el, { axis: ownX ? 'x' : 'y', need: round(ownX ? el.scrollWidth : el.scrollHeight), has: round(ownX ? el.clientWidth : el.clientHeight), text: snippet(item.text) })
      continue
    }
    if (item.clipBy && item.cutArea > item.area * 0.1 && item.clipBy.clientHeight >= 12 && item.clipBy.clientWidth >= 12) add('clipped', el, { axis: 'ancestor', by: label(item.clipBy), text: snippet(item.text) })
  }

  // 5. Text over text: line boxes of different blocks that cross (fixed and sticky blocks aside).
  const lines = []
  for (const item of items.values()) {
    if (isFixed(item.el)) continue
    for (const r of item.rects) if (r.h >= 4 && r.w >= 4) lines.push({ r, item })
  }
  lines.sort((a, b) => a.r.y - b.r.y)
  const pairs = new Map()
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j]
      if (b.r.y >= a.r.y + a.r.h) break
      if (a.item === b.item || a.item.el.contains(b.item.el) || b.item.el.contains(a.item.el)) continue
      const x = intersect(a.r, b.r)
      if (!x || x.h < 4 || x.w < 4 || area(x) < 0.2 * Math.min(area(a.r), area(b.r))) continue
      const key = Math.min(a.item.n, b.item.n) + '-' + Math.max(a.item.n, b.item.n)
      const prev = pairs.get(key)
      if (!prev || area(x) > area(prev.x)) pairs.set(key, { a: a.item, b: b.item, x })
    }
  }
  for (const { a, b, x } of [...pairs.values()].slice(0, 12)) {
    const stack = stackAt(x.x + x.w / 2, x.y + x.h / 2)
    const ia = stack.findIndex((e) => e === a.el || a.el.contains(e))
    const ib = stack.findIndex((e) => e === b.el || b.el.contains(e))
    const [top, under] = ib !== -1 && (ia === -1 || ib < ia) ? [b, a] : [a, b]
    add('overlap', top.el, { text: snippet(top.text, 20), under: { ...label(under.el), text: snippet(under.text, 24) }, ow: round(x.w), oh: round(x.h) })
  }
  jump(0)

  // 6. Large empty areas: vertical bands with no text, picture or control.
  const boxes = []
  for (const item of items.values()) for (const r of item.rects) boxes.push([r.y, r.y + r.h])
  const contentEls = []
  for (const el of all) {
    const tag = tagOf(el)
    if (!REPLACED.has(tag) && !/url\(/.test(cs(el).backgroundImage)) continue
    if (tag !== 'SVG' && el.closest('svg')) continue
    if (tag === 'INPUT' && el.type === 'hidden') continue
    if (opacityOf(el) < 0.05 || cs(el).visibility !== 'visible') continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const vis = intersect(rectOf(r), clipOf(el))
    if (!vis) continue
    boxes.push([vis.y, vis.y + vis.h])
    contentEls.push(el)
  }
  boxes.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const b of boxes) {
    const last = merged[merged.length - 1]
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1])
    else merged.push([b[0], b[1]])
  }
  const minGap = Math.max(T.emptyMinPx, T.emptyFrac * vh)
  const gaps = []
  for (let i = 1; i < merged.length; i++) if (merged[i][0] - merged[i - 1][1] >= minGap) gaps.push([merged[i - 1][1], merged[i][0]])
  if (merged.length && docH > vh + 10 && docH - merged[merged.length - 1][1] >= minGap) gaps.push([merged[merged.length - 1][1], docH])
  if (!merged.length && docH > vh + 10) gaps.push([0, docH])
  const textEls = [...items.keys()]
  const hasContent = (el) => contentEls.some((c) => el.contains(c)) || textEls.some((t) => el.contains(t))
  for (const [y0, y1] of gaps.slice(0, 4)) {
    const h = y1 - y0
    let best = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.height < 1 || r.height > 1.6 * h + 200) continue
      const cover = Math.min(r.bottom, y1) - Math.max(r.top, y0)
      if (cover < 0.6 * h) continue
      const empty = !hasContent(el)
      const score = (empty ? 2 : 1) * cover - (r.width * r.height) / 1e7
      if (!best || score > best.score) best = { el, score, empty }
    }
    add('empty', best ? best.el : null, { y: round(y0), h: round(h), emptyBox: best ? best.empty : false })
  }

  // 7. Broken pictures.
  for (const img of document.images) {
    if (!img.getAttribute('src') && !img.getAttribute('srcset')) continue
    if (img.complete && img.naturalWidth === 0) {
      const src = img.currentSrc || img.src || ''
      add('broken-img', img, { src: src.startsWith('data:') ? snippet(src, 24) : snippet(src, 60) })
    }
  }

  // 8. Fonts: declared faces that failed, families that are not there at all.
  const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status, weight: f.weight }))
  const loaded = new Set(faces.filter((f) => f.status === 'loaded').map((f) => f.family.toLowerCase()))
  const families = new Map()
  for (const item of items.values()) {
    const first = cs(item.el).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
    families.set(first, (families.get(first) || 0) + 1)
  }
  const ctx = document.createElement('canvas').getContext('2d')
  const present = (family) => {
    if (GENERIC.has(family.toLowerCase()) || loaded.has(family.toLowerCase())) return true
    const sample = 'Съешь же ещё этих мягких булок 0123 WwMm'
    return ['monospace', 'serif'].some((fallback) => {
      ctx.font = '40px ' + fallback
      const a = ctx.measureText(sample).width
      ctx.font = '40px "' + family.replace(/"/g, '') + '", ' + fallback
      return Math.abs(ctx.measureText(sample).width - a) > 0.5
    })
  }
  for (const [family, blocks] of families) if (!present(family)) add('font-missing', null, { family: snippet(family, 40), blocks })
  for (const f of faces) if (f.status === 'error') add('font-failed', null, { family: snippet(f.family, 40) })

  // 9. Small touch targets on a phone width.
  if (vw <= 480) {
    let count = 0
    const first = []
    for (const el of body.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"]')) {
      if (el.disabled || (tagOf(el) === 'INPUT' && el.type === 'hidden')) continue
      if (opacityOf(el) < 0.05 || cs(el).visibility !== 'visible') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || (r.width >= T.tapPx && r.height >= T.tapPx)) continue
      if (tagOf(el) === 'A' && cs(el).display === 'inline' && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 3) continue
      if (tagOf(el) === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        const lab = el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'))
        if (lab) { const lr = lab.getBoundingClientRect(); if (lr.width >= T.tapPx && lr.height >= T.tapPx) continue }
      }
      count++
      if (first.length < 3) first.push({ ...label(el), tw: round(r.width), th: round(r.height) })
    }
    if (count) add('tap-small', null, { count, first })
  }

  // 10. Text laid out but transparent: reveal-on-scroll and the like.
  let hiddenChars = 0
  const hosts = []
  for (const [host, chars] of invisible) { hiddenChars += chars; hosts.push({ ...label(host), chars }) }
  if (hiddenChars >= 40) add('invisible', null, { chars: hiddenChars, blocks: hosts.length, first: hosts.sort((a, b) => b.chars - a.chars).slice(0, 3) })

  // 11. A phone visitor of the published page needs the viewport tag.
  if (viewportMeta === null || !/width\s*=\s*device-width/i.test(viewportMeta)) add('no-viewport', null, { content: viewportMeta })

  // ---------------------------------------------------------------- the map
  const rects = []
  for (const el of document.querySelectorAll('[data-raditi-id]')) {
    const id = el.getAttribute('data-raditi-id')
    if (!known.has(id)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    rects.push([id, round(r.left), round(r.top), round(r.width), round(r.height)])
    if (rects.length >= opts.maxRects) break
  }
  const photo = []
  for (const item of new Set(onImage)) {
    const fg = parseColor(cs(item.el).color)
    photo.push({ ...label(item.el), text: snippet(item.text, 24), fg: fg ? { ...fg, a: fg.a * opacityOf(item.el) } : null, size: item.size, large: item.size >= 24 || (item.size >= 18.66 && (parseInt(cs(item.el).fontWeight, 10) || 400) >= 700), rects: item.rects.slice(0, 6).map((r) => [r.x, r.y, r.w, r.h]) })
  }
  jump(0)
  return {
    doc: { vw, vh, docW, docH, overflowXHidden, viewportMeta, title: document.title, textNodes, textBlocks: items.size, elements: all.length },
    faces,
    issues,
    photo,
    rects,
    ms: Math.round(performance.now() - started),
  }
}
