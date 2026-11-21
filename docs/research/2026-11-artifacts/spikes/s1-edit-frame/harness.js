// The cabinet side of the spike: a parent page on the cabinet's origin drives a frame with
// sandbox="allow-same-origin" and no allow-scripts. Plain script, no build step.
;(() => {
  'use strict'
  const H = (window.H = {})
  window.__ran = []
  window.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('ran:')) window.__ran.push(e.data.slice(4))
  })
  const stage = document.getElementById('stage')
  // The frame's own methods may be clobbered by named elements (<img name="addEventListener">):
  // take them from this realm's prototypes.
  const add = EventTarget.prototype.addEventListener
  const qs = Document.prototype.querySelector
  const byId = Document.prototype.getElementById
  H.frame = null
  H.ac = null
  H.events = []

  const ridOf = (n) => {
    if (!n) return null
    if (n.nodeType === 9) return 'document'
    if (n.nodeType === 3) n = n.parentElement
    if (!n || n.nodeType !== 1) return String(n && n.nodeName)
    return n.getAttribute('id') || n.getAttribute('data-rid') || n.nodeName.toLowerCase()
  }
  const doc = () => H.frame.contentDocument
  const win = () => H.frame.contentWindow
  const q = (id) => byId.call(doc(), id)

  H.mount = async (o) => {
    if (H.ac) H.ac.abort()
    H.ac = null
    stage.textContent = ''
    const f = document.createElement('iframe')
    if (o.sandbox !== null && o.sandbox !== undefined) f.setAttribute('sandbox', o.sandbox)
    f.width = String(o.width ?? 800)
    f.height = String(o.height ?? 600)
    f.title = 'артефакт'
    const qsArgs = `t=${o.t}&meta=${o.meta ? 1 : 0}&stamp=${o.stamp ? 1 : 0}&clean=${o.clean ? 1 : 0}`
    if (o.kind === 'srcdoc') {
      const html = await (await fetch(`/corpus/${o.doc}?${qsArgs}`)).text()
      f.srcdoc = html
    } else {
      f.src = `/api/artifacts/${o.doc}/edit-frame?${qsArgs}&h=${o.h}`
    }
    const loaded = new Promise((ok) => f.addEventListener('load', () => ok(true), { once: true }))
    stage.appendChild(f)
    H.frame = f
    const gotLoad = await Promise.race([loaded, new Promise((ok) => setTimeout(() => ok(false), o.timeout ?? 4000))])
    return H.state(gotLoad)
  }

  /** What the parent can see of the frame now. */
  H.state = (gotLoad = null) => {
    const f = H.frame
    const s = { gotLoad, access: false, artifact: false, origin: null, url: null, err: null, ran: [] }
    try {
      const d = f.contentDocument
      s.access = !!d
      if (d) {
        s.url = d.URL
        s.artifact = !!d.documentElement && d.documentElement.getAttribute('data-artifact') === '1'
        if (d.documentElement) s.ran = [...d.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-ran-')).map((n) => n.slice(9))
      }
      s.origin = f.contentWindow.origin
    } catch (e) {
      s.err = String(e && e.message ? e.message : e)
    }
    return s
  }

  H.ranAll = () => {
    const s = H.state()
    return [...new Set([...window.__ran, ...s.ran])]
  }
  H.resetRan = () => {
    window.__ran.length = 0
  }

  const TYPES = [
    'click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointermove', 'pointerup', 'pointerover', 'pointerout',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'paste', 'copy', 'cut', 'selectionchange', 'focusin', 'focusout', 'focus', 'blur', 'compositionstart',
    'compositionupdate', 'compositionend', 'scroll', 'wheel', 'touchstart', 'touchend', 'touchmove', 'submit',
  ]

  /** Listeners of this realm on the frame's document, capture and bubble, and on its window. */
  H.attach = () => {
    const d = doc()
    const w = win()
    const ac = (H.ac = new AbortController())
    H.events = []
    for (const type of TYPES)
      for (const capture of [true, false])
        add.call(
          d,
          type,
          (e) => {
            H.events.push({
              type,
              phase: capture ? 'capture' : 'bubble',
              target: ridOf(e.target),
              trusted: e.isTrusted,
              inputType: e.inputType ?? null,
              data: typeof e.data === 'string' ? e.data : null,
              key: e.key ?? null,
              cancelable: e.cancelable,
              t: performance.now(),
            })
          },
          { capture, signal: ac.signal },
        )
    for (const type of ['resize', 'scroll']) add.call(w, type, (e) => H.events.push({ type: `window-${type}`, phase: 'window', trusted: e.isTrusted }), { signal: ac.signal })
    return true
  }
  H.clearEvents = () => {
    H.events = []
  }
  H.summary = () => {
    const out = {}
    for (const e of H.events) {
      const k = e.type
      out[k] ??= { capture: 0, bubble: 0, window: 0, trusted: 0, inputTypes: [], targets: [] }
      out[k][e.phase]++
      if (e.trusted) out[k].trusted++
      if (e.inputType && !out[k].inputTypes.includes(e.inputType)) out[k].inputTypes.push(e.inputType)
      if (e.target && out[k].targets.length < 6 && !out[k].targets.includes(e.target)) out[k].targets.push(e.target)
    }
    return out
  }

  /** A capture listener that cancels the default action of links (and of middle clicks). */
  H.blockLinks = ({ aux = false } = {}) => {
    const d = doc()
    const ac = H.ac ?? (H.ac = new AbortController())
    H.blocked = []
    const stop = (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href],area[href]') : null
      if (a) {
        e.preventDefault()
        H.blocked.push({ type: e.type, href: a.getAttribute('href'), prevented: e.defaultPrevented })
      }
    }
    add.call(d, 'click', stop, { capture: true, signal: ac.signal })
    if (aux) add.call(d, 'auxclick', stop, { capture: true, signal: ac.signal })
    return true
  }

  H.setEditable = (id, mode) => {
    const el = q(id)
    el.setAttribute('contenteditable', mode)
    return { attr: el.getAttribute('contenteditable'), isContentEditable: el.isContentEditable, prop: el.contentEditable }
  }
  /** «Править текст» when the parent turns editing on at pointerdown. */
  H.editOnPointerDown = (mode) => {
    const d = doc()
    const ac = H.ac ?? (H.ac = new AbortController())
    add.call(
      d,
      'pointerdown',
      (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[id]') : null
        if (el && el.getAttribute('contenteditable') !== mode) el.setAttribute('contenteditable', mode)
      },
      { capture: true, signal: ac.signal },
    )
    return true
  }
  /** «Править текст» when the parent turns editing on at click and puts the caret from the point. */
  H.editOnClick = (mode) => {
    const d = doc()
    const ac = H.ac ?? (H.ac = new AbortController())
    add.call(
      d,
      'click',
      (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[id]') : null
        if (!el) return
        el.setAttribute('contenteditable', mode)
        el.focus()
        const pos = caretAt(e.clientX, e.clientY)
        if (pos) {
          const r = d.createRange()
          r.setStart(pos.node, pos.offset)
          r.collapse(true)
          const s = d.getSelection()
          s.removeAllRanges()
          s.addRange(r)
        }
      },
      { capture: true, signal: ac.signal },
    )
    return true
  }
  const caretAt = (x, y) => {
    const d = doc()
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y)
      return p ? { node: p.offsetNode, offset: p.offset, api: 'caretPositionFromPoint' } : null
    }
    if (d.caretRangeFromPoint) {
      const r = d.caretRangeFromPoint(x, y)
      return r ? { node: r.startContainer, offset: r.startOffset, api: 'caretRangeFromPoint' } : null
    }
    return null
  }
  H.caretApis = () => ({ caretPositionFromPoint: typeof doc().caretPositionFromPoint === 'function', caretRangeFromPoint: typeof doc().caretRangeFromPoint === 'function' })
  H.caretFromPoint = (x, y) => {
    const p = caretAt(x, y)
    return p ? { target: ridOf(p.node), offset: p.offset, api: p.api, text: p.node.nodeType === 3 ? p.node.data : null } : null
  }
  H.text = (id) => {
    const el = q(id)
    return { textContent: el.textContent, innerText: el.innerText, html: el.innerHTML, nbsp: (el.textContent.match(/ /g) || []).length }
  }
  H.selection = () => {
    const s = doc().getSelection()
    return { anchor: ridOf(s.anchorNode), offset: s.anchorOffset, collapsed: s.isCollapsed, text: s.toString(), active: ridOf(doc().activeElement), parentActive: document.activeElement === H.frame }
  }
  H.focusIn = (id) => {
    q(id).focus()
    return { active: ridOf(doc().activeElement), parentActive: document.activeElement === H.frame, hasFocus: doc().hasFocus() }
  }
  H.caretToEnd = (id) => {
    const el = q(id)
    el.focus()
    const r = doc().createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    const s = doc().getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return H.selection()
  }
  H.exec = (cmd, value) => {
    try {
      return { ok: doc().execCommand(cmd, false, value ?? null) }
    } catch (e) {
      return { ok: false, err: String(e && e.message ? e.message : e) }
    }
  }
  /** Copy rich HTML from the parent: the next copy writes these two types. */
  H.prepareCopy = (html, plain) => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
    window.focus()
    document.addEventListener(
      'copy',
      (e) => {
        e.clipboardData.setData('text/html', html)
        e.clipboardData.setData('text/plain', plain)
        e.preventDefault()
        H.copied = true
      },
      { once: true },
    )
    const src = document.getElementById('copysrc')
    const r = document.createRange()
    r.selectNodeContents(src)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    H.copied = false
    return true
  }
  /** mode: 'native' — only record; 'plain' — cancel and insert the plain text. */
  H.onPaste = (mode) => {
    const d = doc()
    const ac = H.ac ?? (H.ac = new AbortController())
    H.pastes = []
    add.call(
      d,
      'paste',
      (e) => {
        const dt = e.clipboardData
        H.pastes.push({ trusted: e.isTrusted, types: dt ? [...dt.types] : null, html: dt ? dt.getData('text/html') : null, plain: dt ? dt.getData('text/plain') : null })
        if (mode === 'plain' && dt) {
          e.preventDefault()
          doc().execCommand('insertText', false, dt.getData('text/plain'))
        }
      },
      { capture: true, signal: ac.signal },
    )
    return true
  }
  /** A paste event this realm builds itself (untrusted): checks the listener path only. */
  H.syntheticPaste = (id, html, plain) => {
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    dt.setData('text/plain', plain)
    let ev
    try {
      ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    } catch (e) {
      return { err: String(e) }
    }
    const notCancelled = q(id).dispatchEvent(ev)
    return { dispatched: true, notCancelled, hasData: !!ev.clipboardData }
  }
  /** Cancels beforeinput of the given input types; records what was cancelable. */
  H.cancelInputs = (types) => {
    const d = doc()
    const ac = H.ac ?? (H.ac = new AbortController())
    H.cancelled = []
    add.call(
      d,
      'beforeinput',
      (e) => {
        if (types.includes(e.inputType)) {
          e.preventDefault()
          H.cancelled.push({ inputType: e.inputType, cancelable: e.cancelable, prevented: e.defaultPrevented })
        }
      },
      { capture: true, signal: ac.signal },
    )
    return true
  }

  // Geometry.
  H.pageRect = (id) => {
    const f = H.frame
    const fr = f.getBoundingClientRect()
    const r = q(id).getBoundingClientRect()
    return { x: fr.left + f.clientLeft + r.left, y: fr.top + f.clientTop + r.top, w: r.width, h: r.height, fx: r.left, fy: r.top }
  }
  H.framePoint = (px, py) => {
    const f = H.frame
    const fr = f.getBoundingClientRect()
    return { x: px - fr.left - f.clientLeft, y: py - fr.top - f.clientTop }
  }
  H.hit = (fx, fy) => ridOf(doc().elementFromPoint(fx, fy))
  H.textRects = (id) => {
    const el = q(id)
    const t = [...el.childNodes].find((n) => n.nodeType === 3)
    const r = doc().createRange()
    r.selectNodeContents(t)
    return [...r.getClientRects()].map((x) => ({ x: x.left, y: x.top, w: x.width, h: x.height }))
  }
  H.scrollFrame = (y) => {
    win().scrollTo(0, y)
    return { scrollY: win().scrollY, top: doc().scrollingElement.scrollTop }
  }
  H.scrollInner = (id, y) => {
    q(id).scrollTop = y
    return q(id).scrollTop
  }
  H.resize = (w, h) => {
    H.frame.width = String(w)
    if (h) H.frame.height = String(h)
    return true
  }
  H.media = () => ({ innerWidth: win().innerWidth, narrow: win().matchMedia('(max-width: 600px)').matches, h1: win().getComputedStyle(q('hero')).fontSize })
  H.overlay = (id, color) => {
    let o = document.getElementById('ov')
    if (!o) {
      o = document.createElement('div')
      o.id = 'ov'
      o.style.cssText = `position:fixed;pointer-events:none;box-sizing:border-box;border:3px solid ${color};z-index:10`
      document.body.appendChild(o)
    }
    const r = H.pageRect(id)
    o.style.left = `${r.x - 3}px`
    o.style.top = `${r.y - 3}px`
    o.style.width = `${r.w + 6}px`
    o.style.height = `${r.h + 6}px`
    return r
  }
  H.removeOverlay = () => document.getElementById('ov')?.remove()
  /** Keeps the outline over the hovered element: mouseover and scroll in the frame move it. */
  H.followHover = (color) => {
    const d = doc()
    const ac = H.ac ?? (H.ac = new AbortController())
    H.hovered = null
    const draw = () => H.hovered && H.overlay(H.hovered, color)
    add.call(d, 'mouseover', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[id]') : null
      if (el) {
        H.hovered = el.id
        draw()
      }
    }, { capture: true, signal: ac.signal })
    add.call(d, 'scroll', draw, { capture: true, signal: ac.signal })
    add.call(win(), 'resize', draw, { signal: ac.signal })
    return true
  }
  H.injectStyle = (css) => {
    const d = doc()
    const s = d.createElement('style')
    s.textContent = css
    d.head.appendChild(s)
    return true
  }
  H.adoptStyle = (css) => {
    try {
      const sh = new (win().CSSStyleSheet)()
      sh.replaceSync(css)
      doc().adoptedStyleSheets = [...doc().adoptedStyleSheets, sh]
      return { ok: true }
    } catch (e) {
      return { ok: false, err: String(e && e.message ? e.message : e) }
    }
  }
  H.setAttr = (id, name, value) => {
    q(id).setAttribute(name, value)
    return true
  }
  H.computed = (id, prop) => win().getComputedStyle(q(id)).getPropertyValue(prop)
  H.styleProp = (id, prop, value) => {
    q(id).style.setProperty(prop, value)
    return win().getComputedStyle(q(id)).getPropertyValue(prop)
  }

  // Script the parent itself tries in the frame. `snips` — name → code of corpus.mark.
  H.parentVectors = (snips, ext, t) => {
    const d = doc()
    const w = win()
    const out = {}
    const tryIt = (name, fn) => {
      try {
        fn()
        out[name] = 'called'
      } catch (e) {
        out[name] = `threw: ${String(e && e.message ? e.message : e).slice(0, 160)}`
      }
    }
    tryIt('parent-created-script', () => {
      const s = d.createElement('script')
      s.textContent = snips['parent-created-script']
      d.body.appendChild(s)
    })
    tryIt('parent-created-script-src', () => {
      const s = d.createElement('script')
      s.src = `${ext}/js?t=${t}&v=parent-created-script-src`
      d.body.appendChild(s)
    })
    tryIt('parent-innerhtml-onerror', () => {
      const div = d.createElement('div')
      div.innerHTML = `<img alt="" src="data:image/png;base64,AAAA" onerror="${snips['parent-innerhtml-onerror'].replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
      d.body.appendChild(div)
    })
    tryIt('parent-setattribute-onclick', () => {
      const b = d.createElement('button')
      b.setAttribute('onclick', snips['parent-setattribute-onclick'])
      d.body.appendChild(b)
      b.click()
    })
    tryIt('parent-eval', () => w.eval(snips['parent-eval']))
    tryIt('parent-function', () => new w.Function(snips['parent-function'])())
    tryIt('parent-settimeout-string', () => w.setTimeout(snips['parent-settimeout-string'], 0))
    return out
  }
  /** This realm's callbacks scheduled through the frame's APIs (they are the cabinet's own code). */
  H.frameApis = () => {
    const d = doc()
    const w = win()
    const out = {}
    const tryIt = (name, fn) => {
      try {
        fn()
        out[name] = 'called'
      } catch (e) {
        out[name] = `threw: ${String(e && e.message ? e.message : e).slice(0, 160)}`
      }
    }
    const got = (n) => () => window.__ran.push(n)
    tryIt('frame-settimeout-fn', () => w.setTimeout(got('frame-settimeout-fn'), 0))
    tryIt('frame-raf-fn', () => w.requestAnimationFrame(got('frame-raf-fn')))
    tryIt('frame-queuemicrotask-fn', () => w.queueMicrotask(got('frame-queuemicrotask-fn')))
    tryIt('frame-promise-then', () => w.Promise.resolve().then(got('frame-promise-then')))
    tryIt('frame-mutationobserver', () => {
      const mo = new w.MutationObserver(got('frame-mutationobserver'))
      mo.observe(d.body, { childList: true })
      d.body.appendChild(d.createElement('i'))
    })
    tryIt('parent-mutationobserver', () => {
      const mo = new MutationObserver(got('parent-mutationobserver'))
      mo.observe(d.body, { childList: true, subtree: true, characterData: true })
      d.body.appendChild(d.createElement('i'))
    })
    tryIt('frame-resizeobserver', () => {
      const ro = new w.ResizeObserver(got('frame-resizeobserver'))
      ro.observe(d.body)
    })
    tryIt('parent-resizeobserver', () => {
      const ro = new ResizeObserver(got('parent-resizeobserver'))
      ro.observe(d.body)
    })
    tryIt('frame-intersectionobserver', () => {
      const io = new w.IntersectionObserver(got('frame-intersectionobserver'))
      io.observe(d.body)
    })
    tryIt('el-onclick-property', () => {
      const b = d.createElement('button')
      b.onclick = got('el-onclick-property')
      d.body.appendChild(b)
      b.click()
    })
    tryIt('el-listener-dispatch', () => {
      const b = d.createElement('button')
      add.call(b, 'click', got('el-listener-dispatch'))
      d.body.appendChild(b)
      b.click()
    })
    return out
  }
  H.documentWrite = (snip) => {
    try {
      const d = doc()
      d.open()
      d.write(`<!doctype html><html data-artifact="1"><body><p>перезапись</p><script>${snip}<\/script></body></html>`)
      d.close()
      return 'called'
    } catch (e) {
      return `threw: ${String(e && e.message ? e.message : e).slice(0, 160)}`
    }
  }
  H.locationJavascript = (snip) => {
    try {
      win().location.href = `javascript:${snip}`
      return 'called'
    } catch (e) {
      return `threw: ${String(e && e.message ? e.message : e).slice(0, 160)}`
    }
  }

  // DOM clobbering: what plain calls on the frame's document return when names are taken.
  H.clobber = () => {
    const d = doc()
    const out = {}
    for (const name of ['addEventListener', 'querySelector', 'getSelection', 'createElement', 'body', 'defaultView', 'execCommand', 'documentElement', 'activeElement']) {
      const v = d[name]
      out[name] = typeof v === 'function' ? 'function' : v && v.nodeType === 1 ? `element <${v.nodeName.toLowerCase()}>` : v && v.nodeType === 9 ? 'document' : String(v && v.constructor && v.constructor.name)
    }
    const safe = {}
    try {
      add.call(d, 'click', () => {})
      safe.addEventListener = 'ok'
    } catch (e) {
      safe.addEventListener = String(e)
    }
    try {
      safe.querySelector = qs.call(d, 'h1') ? 'ok' : 'null'
    } catch (e) {
      safe.querySelector = String(e)
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'body')
      safe.body = desc.get.call(d).nodeName
    } catch (e) {
      safe.body = String(e)
    }
    try {
      safe.getSelection = Document.prototype.getSelection.call(d) ? 'ok' : 'null'
    } catch (e) {
      safe.getSelection = String(e)
    }
    let plain
    try {
      d.addEventListener('click', () => {})
      plain = 'ok'
    } catch (e) {
      plain = `threw: ${String(e && e.message ? e.message : e).slice(0, 120)}`
    }
    return { plain: out, plainAddEventListener: plain, safe }
  }

  // «Править текст»: text slots of a stamped element and the commit to the server.
  const shapeOf = (el) => [...el.childNodes].filter((c) => c.nodeType !== 3).map((c) => (c.nodeType === 1 ? `${c.nodeName.toLowerCase()}#${c.getAttribute('data-rid') ?? ''}` : c.nodeName))
  const slotsOf = (el) => {
    const slots = [null]
    for (const c of el.childNodes) {
      if (c.nodeType === 3) slots[slots.length - 1] = (slots[slots.length - 1] ?? '') + c.data
      else slots.push(null)
    }
    return slots
  }
  H.snapshot = (id) => {
    const el = q(id)
    H.snap = { id, rid: el.getAttribute('data-rid'), shape: shapeOf(el), slots: slotsOf(el) }
    return H.snap
  }
  H.commit = async (key) => {
    const el = q(H.snap.id)
    el.normalize()
    const shape = shapeOf(el)
    if (JSON.stringify(shape) !== JSON.stringify(H.snap.shape)) return { refused: 'SHAPE_CHANGED_IN_FRAME', shape, before: H.snap.shape }
    const slots = slotsOf(el)
    const edits = []
    slots.forEach((s, i) => {
      if ((s ?? '') !== (H.snap.slots[i] ?? '')) edits.push({ slot: i, text: s ?? '' })
    })
    const r = await fetch('/patch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id: H.snap.rid, shape: H.snap.shape, edits }) })
    return { edits, server: await r.json() }
  }
  H.store = async (key, name, t) => (await fetch('/store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, name, t }) })).json()
  // «Выбрать элемент» and «Править текст» without a single listener inside the frame: the cabinet
  // takes input on its own nodes and only calls native methods of the frame (works in WebKit too).
  H.overlayMode = (color) => {
    const f = H.frame
    f.style.pointerEvents = 'none'
    const st = stage
    H.ov = { moves: 0, hovered: null, selected: null, wheel: 0 }
    const ac = H.ac ?? (H.ac = new AbortController())
    const pick = (e) => {
      const p = H.framePoint(e.clientX, e.clientY)
      const el = Document.prototype.elementFromPoint.call(doc(), p.x, p.y)
      const withId = el && el.closest ? el.closest('[id]') : null
      return withId ? withId.id : null
    }
    st.addEventListener('pointermove', (e) => {
      H.ov.moves++
      const id = pick(e)
      if (id) {
        H.ov.hovered = id
        H.overlay(id, color)
      }
    }, { signal: ac.signal })
    st.addEventListener('click', (e) => {
      H.ov.selected = pick(e)
      H.ov.point = H.framePoint(e.clientX, e.clientY)
    }, { signal: ac.signal })
    st.addEventListener('wheel', (e) => {
      H.ov.wheel++
      win().scrollBy({ top: e.deltaY, left: e.deltaX })
      if (H.ov.hovered) H.overlay(H.ov.hovered, color)
    }, { signal: ac.signal, passive: true })
    return true
  }
  /** Edit the selected element in place: caret from the click point, native typing, MutationObserver. */
  H.overlayEdit = (id, mode) => {
    const el = q(id)
    H.snapshot(id)
    el.setAttribute('contenteditable', mode)
    H.frame.style.pointerEvents = 'auto'
    const pt = H.ov && H.ov.point
    el.focus()
    if (pt) {
      const pos = caretAt(pt.x, pt.y)
      if (pos) {
        const r = doc().createRange()
        r.setStart(pos.node, pos.offset)
        r.collapse(true)
        const s = Document.prototype.getSelection.call(doc())
        s.removeAllRanges()
        s.addRange(r)
      }
    }
    H.mutations = []
    const mo = new MutationObserver((list) => {
      for (const m of list) H.mutations.push({ type: m.type, target: ridOf(m.target), added: [...m.addedNodes].map((n) => n.nodeName) })
    })
    mo.observe(el, { characterData: true, childList: true, subtree: true })
    H.mo = mo
    // The cabinet learns that editing ended from its own nodes: a click outside the frame.
    H.ended = null
    document.addEventListener('pointerdown', () => (H.ended ??= 'parent-pointerdown'), { once: true, capture: true })
    window.addEventListener('focus', () => (H.ended ??= 'parent-window-focus'), { once: true })
    return { selection: H.selection(), focusInFrame: document.activeElement === H.frame }
  }
  /** «Править текст» in the cabinet's own field over the element (the frame stays a picture). */
  H.fieldOver = (id) => {
    const el = q(id)
    const cs = win().getComputedStyle(el)
    const r = H.pageRect(id)
    const ta = document.createElement('textarea')
    ta.id = 'field'
    for (const p of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-align', 'text-transform', 'padding-top', 'padding-left', 'padding-right', 'padding-bottom'])
      ta.style.setProperty(p, cs.getPropertyValue(p))
    ta.style.cssText += `;position:fixed;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;margin:0;border:0;outline:2px solid rgb(255,0,128);background:${cs.backgroundColor};resize:none;overflow:hidden;z-index:20;box-sizing:border-box`
    ta.value = el.textContent
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    H.fieldKeys = []
    ta.addEventListener('keydown', (e) => H.fieldKeys.push(e.key))
    return { font: cs.getPropertyValue('font-size'), family: cs.getPropertyValue('font-family').slice(0, 40) }
  }
  H.fieldValue = () => document.getElementById('field')?.value ?? null
  H.fieldCommit = async (key) => {
    const ta = document.getElementById('field')
    const el = q(H.snap.id)
    // One text slot only: the field edits an element whose children are text.
    const r = await fetch('/patch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id: H.snap.rid, shape: H.snap.shape, edits: [{ slot: 0, text: ta.value }] }) })
    ta.remove()
    return { server: await r.json(), shownBefore: el.textContent }
  }
  H.probeListeners = () => {
    // Feature check: does a listener of this realm run on a node of the frame?
    let ran = false
    const d = doc()
    const el = d.createElement('i')
    add.call(el, 'raditi-probe', () => (ran = true))
    d.body.appendChild(el)
    el.dispatchEvent(new Event('raditi-probe'))
    el.remove()
    return ran
  }

  H.ridsInFrame = () => {
    const all = [...doc().querySelectorAll('[data-rid]')].map((e) => e.getAttribute('data-rid'))
    const dup = all.filter((x, i) => all.indexOf(x) !== i)
    return { count: all.length, dup: [...new Set(dup)], noscriptP: !!doc().querySelector('noscript p'), noscriptPRid: doc().querySelector('noscript p')?.getAttribute('data-rid') ?? null }
  }
})()
