// Independent check of spike 1 (plan 88, Э0а), written by the skeptic: own server, own corpus of
// vectors, own markers (localStorage of the cabinet's origin, beacons to two other origins,
// postMessage), driven from Playwright page.evaluate, without the builder's harness.js.
// node vcheck.mjs --engines=chromium,webkit --out=out/darwin.json [--only=safety,listeners]
import { chromium, webkit, firefox } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execSync } from 'node:child_process'
import os from 'node:os'

import { startServers, proposedHeaders, metaCsp, cabinetHeaders } from './vserver.mjs'
import { editCopy } from '../stamp.mjs'
import { pixelAt } from './vpng.mjs'

const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const ENGINES = (argv.engines ?? 'chromium,webkit').split(',')
const ALL = ['safety', 'net', 'listeners', 'cancel', 'overlay', 'delivery', 'toggle', 'anchor', 'editcopy', 'feval', 'typing', 'clobber', 'coep', 'slip', 'feval2', 'feval3', 'anchor2']
const GROUPS = argv.only ? argv.only.split(',') : ALL
const OUT = argv.out ?? 'out/result.json'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const uptime = () => {
  try {
    return execSync('uptime').toString().trim()
  } catch {
    return os.loadavg().join(' ')
  }
}
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const wrap = (body, { bodyAttrs = '' } = {}) =>
  `<!doctype html><html lang="ru" data-artifact="1"><head><meta charset="utf-8"><title>Артефакт</title></head><body${bodyAttrs}>${body}</body></html>`

const srv = await startServers()
let seq = 0
const tok = (s) => `${s}${++seq}`
/** A synthetic marker: each channel it can reach records `name`. */
const mk = (name) =>
  `try{localStorage.setItem('ran:${name}','1')}catch(e){}` +
  `try{(new Image).src='${srv.PAGES}/b?v=${name}'}catch(e){}` +
  `try{(new Image).src='${srv.FOREIGN}/b?v=${name}'}catch(e){}` +
  `try{top.postMessage('ran:${name}','*')}catch(e){}`

const V = {
  control: (id, html) => (srv.put(id, html, {}), { kind: 'src', sandbox: null, src: `${srv.CAB}/f/${id}` }),
  route: (id, html) => (srv.put(id, html, proposedHeaders(srv.PAGES)), { kind: 'src', sandbox: 'allow-same-origin', src: `${srv.CAB}/f/${id}` }),
  srcdocMeta: (id, html) => ({ kind: 'srcdoc', sandbox: 'allow-same-origin', srcdoc: html.replace('<head>', `<head>${metaCsp(srv.PAGES)}`) }),
  routeSlip: (id, html) => (srv.put(id, html, proposedHeaders(srv.PAGES)), { kind: 'src', sandbox: 'allow-same-origin allow-scripts', src: `${srv.CAB}/f/${id}` }),
}

async function openCabinet(ctx, path = '/cab') {
  const page = await ctx.newPage()
  page.consoleLines = []
  page.on('console', (m) => page.consoleLines.push(m.text().slice(0, 200)))
  page.on('dialog', (d) => d.dismiss().catch(() => {}))
  await page.goto(`${srv.CAB}${path}`)
  await page.evaluate(() => {
    window.__ran = []
    addEventListener('message', (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('ran:')) window.__ran.push(e.data.slice(4))
    })
  })
  return page
}

async function mount(page, v, { w = 700, h = 420 } = {}) {
  return page.evaluate(
    async ({ kind, sandbox, src, srcdoc, w, h }) => {
      try {
        localStorage.clear()
      } catch {}
      window.__ran = []
      const host = document.getElementById('host')
      host.textContent = ''
      const f = document.createElement('iframe')
      if (sandbox !== null) f.setAttribute('sandbox', sandbox)
      f.width = String(w)
      f.height = String(h)
      if (kind === 'srcdoc') f.srcdoc = srcdoc
      else f.src = src
      const loaded = new Promise((ok) => f.addEventListener('load', () => ok(true), { once: true }))
      host.appendChild(f)
      const got = await Promise.race([loaded, new Promise((ok) => setTimeout(() => ok(false), 8000))])
      let access = false
      let url = null
      try {
        access = !!f.contentDocument?.documentElement
        url = f.contentDocument?.URL ?? null
      } catch {}
      return { got, access, url }
    },
    { kind: v.kind, sandbox: v.sandbox, src: v.src ?? null, srcdoc: v.srcdoc ?? null, w, h },
  )
}

/** Every channel: localStorage of the cabinet, postMessage, beacons on the other origins. */
async function ranOf(page, prefix) {
  const fromPage = await page
    .evaluate((p) => {
      const ls = []
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k.startsWith(`ran:${p}`)) ls.push(k.slice(4))
        }
      } catch {}
      return { ls, msg: window.__ran.filter((x) => x.startsWith(p)) }
    }, prefix)
    .catch(() => ({ ls: [], msg: [] }))
  const net = srv.log.filter((r) => r.path === '/b' && r.v && r.v.startsWith(prefix)).map((r) => r.v)
  return [...new Set([...fromPage.ls, ...fromPage.msg, ...net])].map((x) => x.slice(prefix.length))
}

const frameRect = (page, sel) =>
  page.evaluate((sel) => {
    const f = document.querySelector('#host iframe')
    const fr = f.getBoundingClientRect()
    const el = f.contentDocument.querySelector(sel)
    const r = el.getBoundingClientRect()
    return { x: fr.left + f.clientLeft + r.left, y: fr.top + f.clientTop + r.top, w: r.width, h: r.height }
  }, sel)

// ---------- corpus (written for this check; the builder's corpus is not reused) ----------
function autoVectors(m) {
  const svgDoc = (inner) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${inner}`)}`
  return [
    ['script', `<script>${m('script')}</script>`],
    ['nested-escalate', `<iframe width="20" height="20" sandbox="allow-scripts allow-same-origin" srcdoc="${attr(`<script>${m('nested-escalate')}</script>`)}"></iframe>`],
    ['nested-data', `<iframe width="20" height="20" src="data:text/html,${encodeURIComponent(`<script>${m('nested-data')}</script>`)}"></iframe>`],
    ['object-svg-onload', `<object width="20" height="20" type="image/svg+xml" data="${svgDoc(`onload="${attr(m('object-svg-onload'))}"/>`)}"></object>`],
    ['object-svg-script', `<object width="20" height="20" type="image/svg+xml" data="${svgDoc(`><script>${m('object-svg-script')}</script></svg>`)}"></object>`],
    ['embed-svg-onload', `<embed width="20" height="20" type="image/svg+xml" src="${svgDoc(`onload="${attr(m('embed-svg-onload'))}"/>`)}">`],
    ['animationstart', `<style>@keyframes vk{from{opacity:.5}to{opacity:1}}</style><div style="animation:vk 60ms" onanimationstart="${attr(m('animationstart'))}">анимация</div>`],
    ['video-error', `<video src="data:video/mp4,xx" onerror="${attr(m('video-error'))}"></video>`],
    ['input-image-error', `<input type="image" alt="" src="data:image/png,xx" onerror="${attr(m('input-image-error'))}">`],
    ['link-preload-onload', `<link rel="preload" as="image" href="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onload="${attr(m('link-preload-onload'))}">`],
    ['select-autofocus', `<select autofocus onfocus="${attr(m('select-autofocus'))}"><option>1</option></select>`],
    ['svg-set-onbegin', `<svg width="2" height="2"><rect width="1" height="1"><set attributeName="width" to="2" begin="0s" onbegin="${attr(m('svg-set-onbegin'))}"/></rect></svg>`],
    ['dsd-onerror', `<div><template shadowrootmode="open"><img alt="" src="data:image/png,xx" onerror="${attr(m('dsd-onerror'))}"></template></div>`],
    ['body-pageshow', null],
  ]
}
function clickVectors(m) {
  const big = 'display:block;width:220px;height:44px;background:#ccc'
  return [
    ['svg-xlink-js', `<svg id="c" width="220" height="44"><a xlink:href="javascript:${attr(m('svg-xlink-js'))}"><rect width="220" height="44" fill="#c33"/></a></svg>`],
    ['formaction-js', `<form><button id="c" style="width:220px;height:44px" formaction="javascript:${attr(m('formaction-js'))}">Отправить</button></form>`],
    ['js-target-top', `<a id="c" style="${big}" href="javascript:${attr(m('js-target-top'))}" target="_top">ссылка</a>`],
    ['details-ontoggle', `<details ontoggle="${attr(m('details-ontoggle'))}"><summary id="c" style="width:220px;height:44px">Подробнее</summary>текст</details>`],
  ]
}

async function groupSafety(ctx, eng) {
  const out = {}
  const page = await openCabinet(ctx)
  for (const variant of ['control', 'route', 'srcdocMeta', 'routeSlip']) {
    if (process.env.VDEBUG) console.log(`  safety ${variant}`)
    const r = {}
    // On load.
    const p1 = tok(`${eng}.${variant}.a.`)
    const m1 = (n) => mk(`${p1}${n}`)
    const body = autoVectors(m1)
      .filter(([, h]) => h)
      .map(([n, h]) => `<div data-v="${n}">${h}</div>`)
      .join('\n')
    const st = await mount(page, V[variant](p1.replace(/\./g, '_'), wrap(body, { bodyAttrs: ` onpageshow="${attr(m1('body-pageshow'))}"` })))
    await sleep(3000)
    r.load = { mounted: st, ran: await ranOf(page, p1) }
    // Clicks of the user.
    r.click = {}
    for (const [n] of clickVectors(() => '')) {
      if (!page.url().endsWith('/cab')) await page.goto(`${srv.CAB}/cab`).then(() => page.evaluate(() => { window.__ran = []; addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('ran:')) window.__ran.push(e.data.slice(4)) }) }))
      const p2 = tok(`${eng}.${variant}.c.`)
      const html = wrap(clickVectors((x) => mk(`${p2}${x}`)).find(([k]) => k === n)[1])
      const s2 = await mount(page, V[variant](p2.replace(/\./g, '_'), html))
      if (!s2.access) {
        r.click[n] = { error: 'no access', s2 }
        continue
      }
      const b = await frameRect(page, '#c')
      await page.mouse.click(b.x + Math.min(30, b.w / 2), b.y + b.h / 2)
      await sleep(1300)
      const topMoved = !page.url().endsWith('/cab')
      r.click[n] = { ran: await ranOf(page, p2), topMoved }
    }
    // Code the cabinet itself puts into the frame.
    if (!page.url().endsWith('/cab')) await page.goto(`${srv.CAB}/cab`)
    const p3 = tok(`${eng}.${variant}.p.`)
    await mount(page, V[variant](p3.replace(/\./g, '_'), wrap('<p id="t">Текст</p>')))
    const snips = Object.fromEntries(['insertHTML', 'fragment', 'insertAdjacentHTML', 'setHTMLUnsafe', 'eval', 'function'].map((n) => [n, mk(`${p3}${n}`)]))
    r.parentCalls = await page.evaluate((s) => {
      const f = document.querySelector('#host iframe')
      const d = f.contentDocument
      const w = f.contentWindow
      const res = {}
      const tr = (n, fn) => {
        try {
          fn()
          res[n] = 'called'
        } catch (e) {
          res[n] = `threw: ${String(e).slice(0, 90)}`
        }
      }
      tr('insertHTML', () => {
        const ed = d.createElement('div')
        ed.setAttribute('contenteditable', 'true')
        d.body.appendChild(ed)
        ed.focus()
        const ok = d.execCommand('insertHTML', false, `<img alt="" src="data:image/png,xx" onerror="${s.insertHTML.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`)
        res.insertHTMLok = ok && !!ed.querySelector('img')
      })
      tr('fragment', () => d.body.appendChild(d.createRange().createContextualFragment(`<script>${s.fragment}<\/script>`)))
      tr('insertAdjacentHTML', () => d.body.insertAdjacentHTML('beforeend', `<img alt="" src="data:image/png,xx" onerror="${s.insertAdjacentHTML.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`))
      tr('setHTMLUnsafe', () => {
        const div = d.createElement('div')
        d.body.appendChild(div)
        if (typeof div.setHTMLUnsafe !== 'function') throw new Error('no setHTMLUnsafe')
        div.setHTMLUnsafe(`<img alt="" src="data:image/png,xx" onerror="${s.setHTMLUnsafe.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`)
      })
      tr('eval', () => w.eval(s.eval))
      tr('function', () => new w.Function(s.function)())
      return res
    }, snips)
    await sleep(1200)
    r.parentRan = await ranOf(page, p3)
    // A real paste of rich HTML with a handler into contenteditable="true" of the frame.
    const p4 = tok(`${eng}.${variant}.v.`)
    await mount(page, V[variant](p4.replace(/\./g, '_'), wrap('<div id="ed">Текст</div>')))
    const pasteHtml = `<img alt="" src="data:image/png,xx" onerror="${attr(mk(`${p4}paste`))}">вставка`
    await page.evaluate((html) => {
      document.addEventListener(
        'copy',
        (e) => {
          e.clipboardData.setData('text/html', html)
          e.clipboardData.setData('text/plain', 'вставка')
          e.preventDefault()
        },
        { once: true },
      )
      const r = document.createRange()
      r.selectNodeContents(document.getElementById('copy'))
      getSelection().removeAllRanges()
      getSelection().addRange(r)
    }, pasteHtml)
    await page.keyboard.press(`${MOD}+KeyC`)
    await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      const d = f.contentDocument
      const ed = d.getElementById('ed')
      ed.setAttribute('contenteditable', 'true')
      ed.focus()
      const rg = d.createRange()
      rg.selectNodeContents(ed)
      rg.collapse(false)
      const s = Document.prototype.getSelection.call(d)
      s.removeAllRanges()
      s.addRange(rg)
    })
    await page.keyboard.press(`${MOD}+KeyV`)
    await sleep(1200)
    r.paste = {
      inserted: await page.evaluate(() => {
        const ed = document.querySelector('#host iframe').contentDocument.getElementById('ed')
        return { img: !!ed.querySelector('img'), text: ed.textContent.slice(0, 40) }
      }),
      ran: await ranOf(page, p4),
    }
    out[variant] = r
  }
  out.consoleBlocked = page.consoleLines.filter((l) => /Blocked script execution/.test(l)).length
  await page.close()
  return out
}

/** Requests the proposed route policy lets out: only the root of pages, by design (Ар12). */
async function groupNet(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  const vs = [
    ['css-import-foreign', `<style>@import url('${srv.FOREIGN}/r?v=%V%&type=css');</style>`],
    ['link-css-pages', `<link rel="stylesheet" href="${srv.PAGES}/r?v=%V%&type=css">`],
    ['img-foreign', `<img alt="" src="${srv.FOREIGN}/r?v=%V%">`],
    ['img-pages', `<img alt="" src="${srv.PAGES}/r?v=%V%">`],
    ['font-pages', `<style>@font-face{font-family:Q;src:url('${srv.PAGES}/r?v=%V%') format('woff2')}.q{font-family:Q}</style><span class="q">шрифт</span>`],
    ['audio-pages', `<audio preload="auto" src="${srv.PAGES}/r?v=%V%&type=audio"></audio>`],
    ['prefetch-foreign', `<link rel="prefetch" href="${srv.FOREIGN}/r?v=%V%">`],
    ['bg-foreign', `<div style="width:10px;height:10px;background:url('${srv.FOREIGN}/r?v=%V%')"></div>`],
    ['same-origin-img', `<img alt="" src="${srv.CAB}/b?v=%V%">`],
  ]
  for (const variant of ['control', 'route', 'srcdocMeta']) {
    const p = tok(`${eng}.${variant}.n.`)
    const body = vs.map(([n, h]) => h.replace(/%V%/g, `${p}${n}`)).join('\n')
    await mount(page, V[variant](p.replace(/\./g, '_'), wrap(body)))
    await sleep(2500)
    const hits = srv.log.filter((r) => r.v && r.v.startsWith(p))
    out[variant] = Object.fromEntries(vs.map(([n]) => [n, hits.filter((h) => h.v === `${p}${n}`).map((h) => `${h.origin}${h.cookie ? '+cookie' : ''}`).join(',') || '-']))
  }
  await page.close()
  return out
}

/** Listeners of the cabinet on the frame's nodes, registered three ways; observers of the cabinet. */
async function groupListeners(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  for (const variant of ['route', 'srcdocMeta']) {
    await mount(page, V[variant](tok(`${eng}_l_`), wrap('<p id="t" style="font:28px sans-serif;margin:20px">Щёлкните здесь</p><div style="height:2000px"></div>')))
    await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      const d = f.contentDocument
      const w = f.contentWindow
      window.L = { protoClick: 0, ownPointerdown: 0, propMousedown: 0, winScroll: 0, mo: 0, ro: 0 }
      EventTarget.prototype.addEventListener.call(d, 'click', () => L.protoClick++, true)
      d.addEventListener('pointerdown', () => L.ownPointerdown++)
      d.body.onmousedown = () => L.propMousedown++
      w.addEventListener('scroll', () => L.winScroll++)
      new MutationObserver((l) => (L.mo += l.length)).observe(d.body, { childList: true, subtree: true, characterData: true })
      new ResizeObserver(() => L.ro++).observe(d.body)
    })
    const b = await frameRect(page, '#t')
    await page.mouse.click(b.x + 20, b.y + b.h / 2)
    await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      f.contentDocument.body.appendChild(f.contentDocument.createElement('i'))
      f.width = '650'
      f.contentWindow.scrollTo(0, 300)
    })
    await sleep(800)
    out[variant] = await page.evaluate(() => window.L)
  }
  out.blockedConsole = page.consoleLines.filter((l) => /Blocked script execution/.test(l)).slice(0, 2)
  await page.close()
  return out
}

/** A capture click listener of the cabinet with preventDefault, a real click on a link in the frame. */
async function groupCancel(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  // FOREIGN is not in the cabinet's frame-src, PAGES is (as the domain of pages in production).
  for (const [target, origin] of [['foreign site', srv.FOREIGN], ['root of pages', srv.PAGES]]) {
    for (const variant of ['route', 'srcdocMeta']) {
      for (const prevent of [false, true]) {
        const p = tok(`${eng}.${variant}.k.`)
        await mount(page, V[variant](p.replace(/\./g, '_'), wrap(`<a id="c" style="display:block;width:220px;height:44px;background:#ccc" href="${origin}/nav?v=${p}link">ссылка</a>`)))
        if (prevent)
          await page.evaluate(() => {
            const d = document.querySelector('#host iframe').contentDocument
            EventTarget.prototype.addEventListener.call(d, 'click', (e) => e.preventDefault(), true)
            EventTarget.prototype.addEventListener.call(d, 'auxclick', (e) => e.preventDefault(), true)
          })
        const b = await frameRect(page, '#c')
        await page.mouse.click(b.x + 20, b.y + b.h / 2)
        await sleep(1500)
        const navigated = srv.log.some((r) => r.path === '/nav' && r.v === `${p}link`)
        const still = await page.evaluate(() => {
          try {
            return document.querySelector('#host iframe').contentDocument?.documentElement?.getAttribute('data-artifact') === '1'
          } catch {
            return false
          }
        })
        const fr = await (await page.$('#host iframe')).contentFrame()
        out[`${target} | ${variant}${prevent ? ' + preventDefault' : ''}`] = { request: navigated, documentStays: still, frameUrl: fr ? fr.url().replace(srv.CAB, '<cab>').replace(srv.PAGES, '<pages>').replace(srv.FOREIGN, '<foreign>').slice(0, 60) : null }
      }
    }
  }
  await page.close()
  return out
}

/** «Выбрать элемент» and «Править текст» with no listener inside the frame: own layer of the cabinet. */
async function groupOverlay(ctx, eng) {
  const out = {}
  for (const variant of ['route', 'srcdocMeta']) {
    const page = await openCabinet(ctx)
    const text = 'Кофейня у реки и пекарня'
    await mount(page, V[variant](tok(`${eng}_o_`), wrap(`<h1 id="h" style="font:32px/1.3 sans-serif;margin:24px">${text}</h1><p id="p" style="font:18px sans-serif;margin:24px">Второй абзац</p>`)))
    await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      f.style.pointerEvents = 'none'
      const r = f.getBoundingClientRect()
      const layer = document.createElement('div')
      layer.id = 'layer'
      layer.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:5`
      document.body.appendChild(layer)
      window.OV = { hover: [], picked: null, pt: null }
      const pick = (e) => {
        const fr = f.getBoundingClientRect()
        const x = e.clientX - fr.left - f.clientLeft
        const y = e.clientY - fr.top - f.clientTop
        const el = Document.prototype.elementFromPoint.call(f.contentDocument, x, y)
        return { id: el?.closest?.('[id]')?.id ?? null, x, y }
      }
      layer.addEventListener('pointermove', (e) => {
        const id = pick(e).id
        if (id && OV.hover.at(-1) !== id) OV.hover.push(id)
      })
      layer.addEventListener('click', (e) => {
        const p = pick(e)
        OV.picked = p.id
        OV.pt = { x: p.x, y: p.y }
      })
    })
    // Where the text of the heading is: a Range over its text node.
    const tr = await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      const fr = f.getBoundingClientRect()
      const d = f.contentDocument
      const rg = d.createRange()
      rg.selectNodeContents(d.getElementById('h').firstChild)
      const r = rg.getBoundingClientRect()
      const p = d.getElementById('p').getBoundingClientRect()
      return { x: fr.left + f.clientLeft + r.left, y: fr.top + f.clientTop + r.top, w: r.width, h: r.height, px: fr.left + f.clientLeft + p.left, py: fr.top + f.clientTop + p.top, ph: p.height }
    })
    await page.mouse.move(tr.px + 10, tr.py + tr.ph / 2, { steps: 3 })
    await page.mouse.move(tr.x + 10, tr.y + tr.h / 2, { steps: 3 })
    await page.mouse.click(tr.x + tr.w * 0.5, tr.y + tr.h / 2)
    const picked = await page.evaluate(() => ({ hover: OV.hover, picked: OV.picked }))
    const caret = await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      const d = f.contentDocument
      document.getElementById('layer').remove()
      f.style.pointerEvents = 'auto'
      const el = d.getElementById(OV.picked)
      el.setAttribute('contenteditable', 'plaintext-only')
      window.MO = 0
      new MutationObserver((l) => (window.MO += l.length)).observe(el, { characterData: true, childList: true, subtree: true })
      el.focus()
      const cp = typeof d.caretPositionFromPoint === 'function' ? d.caretPositionFromPoint(OV.pt.x, OV.pt.y) : null
      const cr = !cp && typeof d.caretRangeFromPoint === 'function' ? d.caretRangeFromPoint(OV.pt.x, OV.pt.y) : null
      const node = cp ? cp.offsetNode : cr.startContainer
      const off = cp ? cp.offset : cr.startOffset
      const rg = d.createRange()
      rg.setStart(node, off)
      rg.collapse(true)
      const s = Document.prototype.getSelection.call(d)
      s.removeAllRanges()
      s.addRange(rg)
      window.END = null
      document.addEventListener('pointerdown', () => (window.END ??= 'cabinet pointerdown'), { capture: true, once: true })
      return { off, api: cp ? 'caretPositionFromPoint' : 'caretRangeFromPoint', frameFocused: document.activeElement === f, inner: d.activeElement?.id ?? null }
    })
    await page.keyboard.type('XY')
    await page.keyboard.insertText('ёж')
    await sleep(200)
    const after = await page.evaluate(() => ({ text: document.querySelector('#host iframe').contentDocument.getElementById('h').textContent, mo: window.MO }))
    await page.mouse.click(10, 780)
    await sleep(200)
    const end = await page.evaluate(() => window.END)
    const want = text.slice(0, caret.off) + 'XYёж' + text.slice(caret.off)
    out[variant] = { ...picked, caret, typed: after.text, expected: want, ok: after.text === want, mutations: after.mo, endSeen: end }
    await page.close()
  }
  return out
}

/** Headers of the route, a top-level visit, the cookie and Fetch Metadata of each request. */
async function groupDelivery(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  const doc = (p) => wrap(`<p>Документ</p><script>${mk(`${p}s`)}</script><img alt="" src="data:image/png,xx" onerror="${attr(mk(`${p}e`))}">`)
  const cases = {
    'cabinet headers (route left in headers())': cabinetHeaders(srv.PAGES),
    'proposed headers': proposedHeaders(srv.PAGES),
    'proposed + X-Frame-Options: DENY': { ...proposedHeaders(srv.PAGES), 'X-Frame-Options': 'DENY' },
  }
  for (const [label, headers] of Object.entries(cases)) {
    const p = tok(`${eng}.d.`)
    const id = p.replace(/\./g, '_')
    srv.put(id, doc(p), headers)
    const st = await mount(page, { kind: 'src', sandbox: 'allow-same-origin', src: `${srv.CAB}/f/${id}` })
    await sleep(800)
    const req = srv.log.filter((r) => r.path === `/f/${id}`)
    out[label] = { access: st.access, ran: await ranOf(page, p), requests: req.map((r) => ({ cookie: r.cookie, dest: r.dest, site: r.site })) }
  }
  // Opened as a tab: only the response headers stand between the artifact and the cabinet's origin.
  for (const [label, headers] of [['top-level, proposed headers', proposedHeaders(srv.PAGES)], ['top-level, no headers (control)', {}]]) {
    const p = tok(`${eng}.t.`)
    const id = p.replace(/\./g, '_')
    srv.put(id, doc(p), headers)
    const tab = await ctx.newPage()
    await tab.goto(`${srv.CAB}/f/${id}`)
    await sleep(1500)
    const ls = await tab.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ran:'))).catch((e) => [`evaluate failed: ${String(e).slice(0, 80)}`])
    const req = srv.log.filter((r) => r.path === `/f/${id}`)
    out[label] = { localStorage: ls, beacons: srv.log.filter((r) => r.path === '/b' && r.v?.startsWith(p)).length, requests: req.map((r) => ({ cookie: r.cookie, dest: r.dest, site: r.site })) }
    await tab.evaluate(() => localStorage.clear()).catch(() => {})
    await tab.close()
  }
  await page.close()
  return out
}

/** One iframe element switched view → edit by attributes, plain DOM (no React). */
async function groupToggle(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  const editRoute = (p) => {
    const id = p.replace(/\./g, '_')
    srv.put(id, wrap(`<p>правка</p><script>${mk(`${p}edit`)}</script>`), proposedHeaders(srv.PAGES))
    return `${srv.CAB}/f/${id}`
  }
  for (const edit of ['route with the proposed CSP', 'srcdoc without CSP']) {
    for (const order of ['source first', 'sandbox first']) {
      const p = tok(`${eng}.g.`)
      const res = await page.evaluate(
        async ({ view, edit, editSrc, editSrcdoc, order }) => {
          try {
            localStorage.clear()
          } catch {}
          window.__ran = []
          const host = document.getElementById('host')
          host.textContent = ''
          const f = document.createElement('iframe')
          f.setAttribute('sandbox', 'allow-scripts')
          f.src = view
          const load = () => new Promise((ok) => {
            const t = setTimeout(() => ok(false), 6000)
            f.addEventListener('load', () => (clearTimeout(t), ok(true)), { once: true })
          })
          let l = load()
          host.appendChild(f)
          await l
          await new Promise((ok) => setTimeout(ok, 300))
          const viewRan = window.__ran.length > 0
          l = load()
          if (order === 'source first') {
            if (edit === 'srcdoc without CSP') f.srcdoc = editSrcdoc
            else f.src = editSrc
            f.setAttribute('sandbox', 'allow-same-origin')
          } else {
            f.setAttribute('sandbox', 'allow-same-origin')
            if (edit === 'srcdoc without CSP') f.srcdoc = editSrcdoc
            else f.src = editSrc
          }
          await l
          await new Promise((ok) => setTimeout(ok, 500))
          let access = false
          try {
            access = f.contentDocument?.documentElement?.getAttribute('data-artifact') === '1'
          } catch {}
          return { viewRan, access }
        },
        { view: `${srv.PAGES}/view?v=${p}view`, edit, editSrc: editRoute(p), editSrcdoc: wrap(`<p>правка</p><script>${mk(`${p}edit`)}</script>`), order },
      )
      const ran = await ranOf(page, p)
      out[`${edit} | ${order}`] = { ...res, editScriptRan: ran.includes('edit') }
    }
  }
  await page.close()
  return out
}

/** The product's reading page in srcdoc (agent-document.tsx): anchors and links from the root. */
async function groupAnchor(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  const bounded = (p, ms, what) => Promise.race([p, sleep(ms).then(() => ({ timeout: what }))])
  for (const href of ['#doc-razdel', 'about:srcdoc#doc-razdel', '/uslugi/remont']) {
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title><style>body{margin:0}#toc{display:block;width:300px;height:40px;background:#eee}</style></head><body><main><article><a id="toc" href="${href}">К разделу</a><div style="height:2500px"></div><h2 id="doc-razdel">Раздел</h2></article></main></body></html>`
    await page.evaluate((html) => {
      const host = document.getElementById('host')
      host.textContent = ''
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
      f.setAttribute('referrerpolicy', 'no-referrer')
      f.width = '600'
      f.height = '400'
      f.srcdoc = html
      host.appendChild(f)
      return new Promise((ok) => f.addEventListener('load', ok, { once: true }))
    }, html)
    // The frame is opaque: the link sits at a known place, the click comes from the mouse.
    const box = await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      const r = f.getBoundingClientRect()
      return { x: r.left + f.clientLeft, y: r.top + f.clientTop }
    })
    await page.mouse.click(box.x + 20, box.y + 20)
    await sleep(1500)
    const handle = await page.$('#host iframe')
    const fr = handle ? await bounded(handle.contentFrame(), 5000, 'contentFrame') : null
    const url = fr && !fr.timeout ? fr.url().replace(srv.CAB, '<cabinet>') : '(no frame)'
    const inside = fr && !fr.timeout ? await bounded(fr.evaluate(() => ({ y: Math.round(scrollY), heading: !!document.getElementById('doc-razdel') })).catch((e) => ({ error: String(e).slice(0, 60) })), 5000, 'evaluate') : null
    out[href] = { url, inside }
  }
  await page.close()
  return out
}

/** Links the edit copy of the spike (stamp.mjs editCopy) does not neutralize, clicked in the route. */
async function groupEditcopy(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  const navs = (p) => [
    ['a-href', `<a id="c" style="display:block;width:220px;height:44px;background:#ccc" href="${srv.CAB}/nav?v=${p}a-href">ссылка</a>`],
    ['svg-a-href', `<svg id="c" width="220" height="44"><a href="${srv.CAB}/nav?v=${p}svg-a-href"><rect width="220" height="44" fill="#c33"/></a></svg>`],
    ['svg-a-xlink-href', `<svg id="c" width="220" height="44"><a xlink:href="${srv.CAB}/nav?v=${p}svg-a-xlink-href"><rect width="220" height="44" fill="#3c3"/></a></svg>`],
    ['mathml-href', `<math id="c" style="font-size:40px"><mtext href="${srv.CAB}/nav?v=${p}mathml-href">ссылка</mtext></math>`],
    ['nested-srcdoc-link', `<iframe id="c" width="240" height="60" srcdoc="${attr(`<a style="display:block;width:220px;height:44px;background:#ccc" href="${srv.CAB}/nav?v=${p}nested-srcdoc-link">ссылка</a>`)}"></iframe>`],
  ]
  for (const copy of [false, true]) {
    for (const [n] of navs('')) {
      const p = tok(`${eng}.e.`)
      let html = wrap(navs(p).find(([k]) => k === n)[1])
      if (copy) html = editCopy(html)
      const st = await mount(page, V.route(p.replace(/\./g, '_'), html))
      const b = await frameRect(page, '#c')
      await page.mouse.click(b.x + 20, b.y + Math.min(22, b.h / 2))
      await sleep(1500)
      const req = srv.log.some((r) => r.path === '/nav' && r.v === `${p}${n}`)
      const still = await page.evaluate(() => {
        try {
          return document.querySelector('#host iframe').contentDocument?.documentElement?.getAttribute('data-artifact') === '1'
        } catch {
          return false
        }
      })
      out[`${copy ? 'edit copy' : 'as stored'} | ${n}`] = { mounted: st.access, requestToForeign: req, documentStays: still, hrefLeft: copy ? /nav\?v=/.test(html) : null }
    }
  }
  await page.close()
  return out
}

/** The cabinet's own script calls the frame's eval under a cabinet policy without 'unsafe-eval'. */
async function groupFeval(ctx, eng) {
  const out = {}
  for (const [label, csp] of [
    ['frame script-src none', proposedHeaders(srv.PAGES)],
    ["frame script-src 'unsafe-eval'", { ...proposedHeaders(srv.PAGES), 'Content-Security-Policy': proposedHeaders(srv.PAGES)['Content-Security-Policy'].replace("script-src 'none'", "script-src 'unsafe-eval'") }],
  ]) {
    for (const cabinet of ['/cab', '/cabstrict']) {
      const page = await ctx.newPage()
      await page.goto(`${srv.CAB}${cabinet}`)
      const id = tok(`${eng}_f_`)
      srv.put(id, wrap('<p>правка</p>'), csp)
      await mount(page, { kind: 'src', sandbox: 'allow-same-origin', src: `${srv.CAB}/f/${id}` })
      if (cabinet === '/cab')
        // No cabinet script on /cab: the call comes from the evaluation (the cabinet's realm).
        await page.evaluate(() => {
          const f = document.querySelector('#host iframe')
          try {
            f.contentWindow.eval("try{localStorage.setItem('ran:feval','1')}catch(e){}")
            window.__evalResult = { frame: 'called' }
          } catch (e) {
            window.__evalResult = { frame: `threw: ${String(e).slice(0, 100)}` }
          }
        })
      else await page.click('#outside')
      await sleep(400)
      out[`${cabinet} | ${label}`] = { ...(await page.evaluate(() => window.__evalResult)), ran: await page.evaluate(() => localStorage.getItem('ran:feval') === '1') }
      await page.evaluate(() => localStorage.clear())
      await page.close()
    }
  }
  return out
}


/** Native editing without handlers: Enter, typed spaces, a paste of rich HTML into plaintext-only. */
async function groupTyping(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  const setup = async (ws) => {
    await mount(page, V.route(tok(`${eng}_y_`), wrap(`<h1 id="h" style="font:28px sans-serif;margin:20px${ws ? `;white-space:${ws}` : ''}">Заголовок</h1>`)))
    await page.evaluate(() => {
      const d = document.querySelector('#host iframe').contentDocument
      const h = d.getElementById('h')
      h.setAttribute('contenteditable', 'plaintext-only')
      h.focus()
      const r = d.createRange()
      r.selectNodeContents(h)
      r.collapse(false)
      const s = Document.prototype.getSelection.call(d)
      s.removeAllRanges()
      s.addRange(r)
    })
  }
  const read = () => page.evaluate(() => {
    const h = document.querySelector('#host iframe').contentDocument.getElementById('h')
    return { html: h.innerHTML, nbsp: (h.textContent.match(/ /g) || []).length, text: h.textContent }
  })
  await setup(null)
  await page.keyboard.press('Enter')
  await page.keyboard.type('X')
  const e = await read()
  out.enter = { br: /<br>/.test(e.html), newline: e.text.includes('\n'), div: /<div/.test(e.html) }
  for (const ws of ['normal', 'pre-wrap']) {
    await setup(ws === 'normal' ? null : ws)
    await page.keyboard.type(' а  б ')
    out[`nbsp, white-space ${ws}`] = (await read()).nbsp
  }
  await setup(null)
  await page.evaluate(() => {
    document.activeElement?.blur()
    window.focus()
    document.addEventListener('copy', (ev) => {
      ev.clipboardData.setData('text/html', '<b>Жирный</b> <a href="https://example.test">ссылка</a>')
      ev.clipboardData.setData('text/plain', 'Жирный ссылка')
      ev.preventDefault()
    }, { once: true })
    const r = document.createRange()
    r.selectNodeContents(document.getElementById('copy'))
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  })
  await page.keyboard.press(`${MOD}+KeyC`)
  await page.evaluate(() => {
    const d = document.querySelector('#host iframe').contentDocument
    const h = d.getElementById('h')
    h.focus()
    const r = d.createRange()
    r.selectNodeContents(h)
    r.collapse(false)
    const s = Document.prototype.getSelection.call(d)
    s.removeAllRanges()
    s.addRange(r)
  })
  await page.keyboard.press(`${MOD}+KeyV`)
  await sleep(300)
  const p = await read()
  out.pastePlaintextOnly = { pasted: p.text.includes('Жирный'), elements: /<(b|a|strong|span)\b/.test(p.html) }
  await page.close()
  return out
}

/** Named elements of the artifact shadow the frame document's own members. */
async function groupClobber(ctx, eng) {
  const page = await openCabinet(ctx)
  await mount(page, V.route(tok(`${eng}_cl_`), wrap('<h1 id="t">Заголовок</h1><img name="addEventListener" alt="" src="data:,"><form name="getSelection"></form><img name="body" alt="" src="data:,"><img name="elementFromPoint" alt="" src="data:,">')))
  const out = await page.evaluate(() => {
    const d = document.querySelector('#host iframe').contentDocument
    const r = {}
    r.plainAddEventListener = typeof d.addEventListener
    r.plainBody = d.body?.nodeName
    r.plainGetSelection = typeof d.getSelection
    r.plainElementFromPoint = typeof d.elementFromPoint
    try {
      d.addEventListener('click', () => {})
      r.plainCall = 'ok'
    } catch (e) {
      r.plainCall = `threw ${e.name}`
    }
    try {
      EventTarget.prototype.addEventListener.call(d, 'click', () => {})
      r.protoAddEventListener = 'ok'
    } catch (e) {
      r.protoAddEventListener = `threw ${e.name}`
    }
    r.protoBody = Object.getOwnPropertyDescriptor(Document.prototype, 'body').get.call(d).nodeName
    r.protoSelection = typeof Document.prototype.getSelection.call(d)?.addRange
    r.protoElementFromPoint = Document.prototype.elementFromPoint.call(d, 10, 10)?.nodeName ?? null
    return r
  })
  await page.close()
  return out
}

/** A cabinet with COEP require-corp: the route without COEP and with it. */
async function groupCoep(ctx, eng) {
  const page = await openCabinet(ctx, '/cabcoep')
  const out = {}
  for (const [label, extra] of [['route without COEP', {}], ['route with COEP', { 'Cross-Origin-Embedder-Policy': 'require-corp' }]]) {
    const id = tok(`${eng}_co_`)
    srv.put(id, wrap('<p>правка</p>'), { ...proposedHeaders(srv.PAGES), ...extra })
    out[label] = (await mount(page, { kind: 'src', sandbox: 'allow-same-origin', src: `${srv.CAB}/f/${id}` })).access
  }
  await page.close()
  return out
}

/** allow-scripts slipped into the attribute: does <meta http-equiv="refresh"> lead the frame away? */
async function groupSlipRefresh(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  for (const variant of ['route', 'routeSlip', 'srcdocMeta', 'srcdocMetaSlip']) {
    const p = tok(`${eng}.r.`)
    const html = wrap('<p>правка</p>').replace('</head>', `<meta http-equiv="refresh" content="0;url=${srv.PAGES}/nav?v=${p}refresh"></head>`)
    const v = variant === 'srcdocMetaSlip' ? { ...V.srcdocMeta(p, html), sandbox: 'allow-same-origin allow-scripts' } : V[variant](p.replace(/\./g, '_'), html)
    await mount(page, v)
    await sleep(2000)
    out[variant] = srv.log.some((r) => r.path === '/nav' && r.v === `${p}refresh`)
  }
  await page.close()
  return out
}

/** Who decides on the frame's eval: the cabinet's policy, the frame's, or the caller's kind. */
async function groupFeval2(ctx, eng) {
  const out = {}
  const frames = {
    "frame script-src 'none'": proposedHeaders(srv.PAGES),
    "frame script-src 'unsafe-eval'": { ...proposedHeaders(srv.PAGES), 'Content-Security-Policy': proposedHeaders(srv.PAGES)['Content-Security-Policy'].replace("script-src 'none'", "script-src 'unsafe-eval'") },
    'frame without CSP': {},
  }
  for (const cabinet of ['/cabjs', '/cabstrict']) {
    for (const [label, headers] of Object.entries(frames)) {
      for (const caller of ['cabinet script', 'playwright evaluate']) {
        const page = await ctx.newPage()
        await page.goto(`${srv.CAB}${cabinet}`)
        const id = tok(`${eng}_f2_`)
        srv.put(id, wrap('<p>правка</p>'), headers)
        await mount(page, { kind: 'src', sandbox: 'allow-same-origin', src: `${srv.CAB}/f/${id}` })
        if (caller === 'cabinet script') await page.click('#outside')
        else
          await page.evaluate(() => {
            const f = document.querySelector('#host iframe')
            try {
              f.contentWindow.eval("try{localStorage.setItem('ran:feval','1')}catch(e){}")
              window.__evalResult = { frame: 'called' }
            } catch (e) {
              window.__evalResult = { frame: `threw: ${String(e).slice(0, 60)}` }
            }
          })
        await sleep(300)
        const r = await page.evaluate(() => ({ ...(window.__evalResult ?? {}), ran: localStorage.getItem('ran:feval') === '1' }))
        await page.evaluate(() => localStorage.clear())
        out[`${cabinet === '/cabjs' ? 'cabinet without script-src' : "cabinet script-src 'self'"} | ${label} | ${caller}`] = r.ran ? 'RAN' : `blocked${r.frame ? ` (${r.frame.slice(0, 50)})` : ''}`
        await page.close()
      }
    }
  }
  return out
}

/** Firefox: is the frame's CSP applied to strings the cabinet compiles there, by who starts the call? */
async function groupFeval3(ctx, eng) {
  const out = {}
  for (const frame of ['route (script-src none)', 'srcdoc + sandbox + meta (script-src none)', 'srcdoc + sandbox, no meta']) {
    for (const caller of ['click on the cabinet', 'evaluate → cabinet function', 'evaluate inline']) {
      const page = await ctx.newPage()
      await page.goto(`${srv.CAB}/cab3`)
      const id = tok(`${eng}_f3_`)
      if (frame.startsWith('route')) {
        srv.put(id, wrap('<p>правка</p>'), proposedHeaders(srv.PAGES))
        await mount(page, { kind: 'src', sandbox: 'allow-same-origin', src: `${srv.CAB}/f/${id}` })
      } else if (frame.startsWith('srcdoc + sandbox + meta')) await mount(page, V.srcdocMeta(id, wrap('<p>правка</p>')))
      else await mount(page, { kind: 'srcdoc', sandbox: 'allow-same-origin', srcdoc: wrap('<p>правка</p>') })
      let calls
      if (caller === 'click on the cabinet') {
        await page.click('#outside')
        calls = await page.evaluate(() => window.__clickResult)
      } else if (caller === 'evaluate → cabinet function') calls = await page.evaluate(() => window.__doAll('ev-'))
      else
        calls = await page.evaluate(() => {
          const w = document.querySelector('#host iframe').contentWindow
          const code = (n) => `try{localStorage.setItem('ran:in-${n}','1')}catch(e){}`
          const res = {}
          try { w.eval(code('eval')); res.eval = 'called' } catch (e) { res.eval = `threw ${e.name}` }
          try { new w.Function(code('function'))(); res.function = 'called' } catch (e) { res.function = `threw ${e.name}` }
          try { w.setTimeout(code('timeout'), 0); res.timeout = 'called' } catch (e) { res.timeout = `threw ${e.name}` }
          return res
        })
      await sleep(400)
      const ran = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ran:')).map((k) => k.replace(/^ran:(click-|ev-|in-)/, '')))
      await page.evaluate(() => localStorage.clear())
      out[`${frame} | ${caller}`] = { eval: ran.includes('eval') ? 'RAN' : calls?.eval, function: ran.includes('function') ? 'RAN' : calls?.function, timeout: ran.includes('timeout') ? 'RAN' : calls?.timeout === 'called' ? 'not run' : calls?.timeout }
      await page.close()
    }
  }
  return out
}

/** The reading page in srcdoc with the product's attribute: is it still shown after the click? (pixels) */
async function groupAnchor2(ctx, eng) {
  const page = await openCabinet(ctx)
  const out = {}
  for (const href of ['#doc-razdel', 'about:srcdoc#doc-razdel', '/uslugi/remont']) {
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title><style>html,body{margin:0;background:rgb(0,170,255)}#toc{display:block;width:300px;height:40px;background:#eee}h2{background:rgb(255,0,128);height:300px;margin:0}</style></head><body><main><article><a id="toc" href="${href}">К разделу</a><div style="height:2500px"></div><h2 id="doc-razdel">Раздел</h2><div style="height:2500px"></div></article></main></body></html>`
    await page.evaluate((html) => {
      const host = document.getElementById('host')
      host.textContent = ''
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
      f.width = '600'
      f.height = '400'
      f.srcdoc = html
      host.appendChild(f)
      return new Promise((ok) => f.addEventListener('load', ok, { once: true }))
    }, html)
    const box = await page.evaluate(() => {
      const f = document.querySelector('#host iframe')
      const r = f.getBoundingClientRect()
      return { x: r.left + f.clientLeft, y: r.top + f.clientTop }
    })
    const before = pixelAt(await page.screenshot(), box.x + 300, box.y + 200)
    await page.mouse.click(box.x + 20, box.y + 20)
    await sleep(1500)
    const shot = await page.screenshot()
    if (process.env.VSHOTS) (await import('node:fs')).writeFileSync(`out/shot-${eng}-${href.replace(/[^a-z]/gi, '_')}.png`, shot)
    const after = pixelAt(shot, box.x + 300, box.y + 200)
    const name = (c) => (c[2] > 200 && c[0] < 60 ? 'page (blue)' : c[0] > 200 && c[2] > 90 && c[1] < 60 ? 'heading (pink)' : `other rgb(${c.join(',')})`)
    out[href] = { before: name(before), after: name(after) }
  }
  await page.close()
  return out
}

const results = { node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, startedAt: new Date().toISOString(), uptimeAtStart: uptime(), engines: {} }
for (const name of ENGINES) {
  const bt = { chromium, webkit, firefox }[name]
  let browser = await bt.launch({ timeout: 60_000 })
  const er = { version: browser.version(), groups: {} }
  results.engines[name] = er
  for (const g of GROUPS) {
    const t0 = Date.now()
    let ctx = null
    try {
      ctx = await Promise.race([browser.newContext({ viewport: { width: 1000, height: 800 } }), sleep(30_000).then(() => null)])
      if (!ctx) throw new Error('newContext did not answer in 30 s')
      const fn = { safety: groupSafety, net: groupNet, listeners: groupListeners, cancel: groupCancel, overlay: groupOverlay, delivery: groupDelivery, toggle: groupToggle, anchor: groupAnchor, editcopy: groupEditcopy, feval: groupFeval, typing: groupTyping, clobber: groupClobber, coep: groupCoep, slip: groupSlipRefresh, feval2: groupFeval2, feval3: groupFeval3, anchor2: groupAnchor2 }[g]
      const res = await Promise.race([fn(ctx, name), sleep(300_000).then(() => 'TIMEOUT')])
      er.groups[g] = res === 'TIMEOUT' ? { error: 'timeout 300 s' } : res
    } catch (e) {
      er.groups[g] = { error: String(e.stack ?? e).split('\n').slice(0, 3).join(' | ') }
    }
    if (ctx) await Promise.race([ctx.close().catch(() => {}), sleep(10_000)])
    if (er.groups[g]?.error || !browser.isConnected()) {
      // A dead or stuck engine must not take the remaining groups with it.
      await Promise.race([browser.close().catch(() => {}), sleep(10_000)])
      browser = await bt.launch({ timeout: 60_000 })
    }
    console.log(`${name} ${g} ${((Date.now() - t0) / 1000).toFixed(1)} s${er.groups[g]?.error ? ` ERROR ${er.groups[g].error.slice(0, 120)}` : ''}`)
  }
  await Promise.race([browser.close().catch(() => {}), sleep(10_000)])
}
results.finishedAt = new Date().toISOString()
results.uptimeAtEnd = uptime()
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(results, null, 1))
await srv.close()
console.log(`wrote ${OUT}`)
