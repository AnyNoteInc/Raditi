// Runs every check of spike 1 in the given engines and writes one JSON of results.
// node run.mjs --engines=chromium,webkit,firefox --platform=linux --out=results/linux.json [--only=vectors,events]
import { chromium, webkit, firefox } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execSync } from 'node:child_process'
import os from 'node:os'

import { startServers } from './server.mjs'
import * as corpus from './corpus.mjs'
import { stamp, duplicateIds, misplacedTexts } from './stamp.mjs'
import { decodePng, near } from './png.mjs'

const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const ENGINES = (argv.engines ?? 'chromium,webkit').split(',')
const ALL = ['delivery', 'vectors', 'parent', 'click', 'nav', 'toplevel', 'events', 'editing', 'geometry', 'overlay', 'roundtrip', 'clobber', 'touch', 'coep', 'react']
const GROUPS = argv.only ? argv.only.split(',') : ALL
const PLATFORM = argv.platform ?? process.platform
const OUT = argv.out ?? `results/${PLATFORM}.json`
const uptime = () => {
  try {
    return execSync('uptime').toString().trim()
  } catch {
    return os.loadavg().map((x) => x.toFixed(2)).join(' ')
  }
}

const D = {
  control: { kind: 'src', sandbox: null, h: 'none' },
  'srcdoc-no-sandbox': { kind: 'srcdoc', sandbox: null, meta: false },
  'srcdoc+sandbox': { kind: 'srcdoc', sandbox: 'allow-same-origin', meta: false },
  'srcdoc+sandbox+meta': { kind: 'srcdoc', sandbox: 'allow-same-origin', meta: true },
  'route+sandbox': { kind: 'src', sandbox: 'allow-same-origin', h: 'good' },
  'route-csp-sandbox-only': { kind: 'src', sandbox: null, h: 'good' },
  'route-no-xfo': { kind: 'src', sandbox: 'allow-same-origin', h: 'good-no-xfo' },
  'route-cabinet-headers': { kind: 'src', sandbox: 'allow-same-origin', h: 'cabinet' },
  'route-two-csp': { kind: 'src', sandbox: 'allow-same-origin', h: 'cabinet-and-good' },
  'route-xfo-deny': { kind: 'src', sandbox: 'allow-same-origin', h: 'good-xfo-deny' },
  'alt-scripts+csp': { kind: 'src', sandbox: 'allow-same-origin allow-scripts', h: 'scripts-csp-none' },
  'alt-csp-only': { kind: 'src', sandbox: null, h: 'csp-only' },
}

const srv = await startServers()
const EXT = srv.extOrigin
let seq = 0
const token = (...parts) => `${parts.join('-').replace(/[^a-z0-9-]/gi, '')}-${++seq}`
const hitsOf = (t) => srv.hits.filter((h) => h.t === t)
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const mod = PLATFORM === 'darwin' || PLATFORM === 'mac' ? 'Meta' : 'Control'

const results = { platform: PLATFORM, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, startedAt: new Date().toISOString(), uptimeAtStart: uptime(), engines: {} }

async function cabinet(ctx, path = '/cabinet') {
  const page = await ctx.newPage()
  page.consoleLines = []
  page.on('console', (m) => page.consoleLines.push(m.text().slice(0, 240)))
  page.on('dialog', (d) => d.dismiss().catch(() => {}))
  await page.goto(`${srv.cabOrigin}${path}`)
  return page
}
const mount = (page, label, doc, t, extra = {}) => page.evaluate((o) => H.mount(o), { ...D[label], doc, t, ...extra })
const blockedConsole = (page) => page.consoleLines.filter((l) => /Blocked script execution|sandbox/i.test(l)).length

/** The status of each vector after a frame ran it. */
function vectorStatus(t, ran) {
  const hits = hitsOf(t)
  const hitV = new Set(hits.filter((h) => h.kind === 'hit').map((h) => h.v))
  const loadV = new Set(hits.filter((h) => h.kind === 'load' || h.kind === 'probe').map((h) => h.v))
  const ranSet = new Set(ran)
  const out = {}
  for (const [n] of corpus.autoVectors(EXT, t)) {
    if (n === 'noscript-img') {
      out[n] = loadV.has(n) ? 'loaded' : 'blocked'
      continue
    }
    const r = ranSet.has(n) || hitV.has(n) || ranSet.has(`${n}-ran`) || hitV.has(`${n}-ran`)
    const loaded = loadV.has(n)
    out[n] = r ? 'RAN' : loaded ? 'loaded, did not run' : 'blocked'
  }
  for (const [n] of corpus.networkVectors(EXT, t)) {
    const rec = hits.find((h) => (h.kind === 'load' || h.kind === 'probe') && h.v === n)
    out[n] = rec ? (rec.origin === 'cab' ? `loaded${rec.cookie ? ' with cookie' : ''}` : 'loaded') : 'blocked'
  }
  return out
}

async function groupDelivery(ctx, engine) {
  const page = await cabinet(ctx)
  const out = {}
  for (const label of Object.keys(D)) {
    const t = token(engine, 'dlv', label)
    const st = await mount(page, label, 'landing', t, { stamp: true })
    const route = hitsOf(t).find((h) => h.kind === 'route')
    let listeners = null
    if (st.access && st.artifact) listeners = await page.evaluate(() => H.probeListeners())
    out[label] = { ...st, url: st.url ? st.url.replace(srv.cabOrigin, '<cabinet>') : null, origin: st.origin === srv.cabOrigin ? '<cabinet>' : st.origin, routeCookie: route ? route.cookie : null, routeDest: route?.dest ?? null, listeners }
  }
  out.console = page.consoleLines.filter((l) => /frame|ancestor|X-Frame|Refused|sandbox/i.test(l)).slice(0, 12)
  await page.close()
  return out
}

async function groupVectors(ctx, engine) {
  const page = await cabinet(ctx)
  const out = {}
  for (const label of ['control', 'srcdoc-no-sandbox', 'srcdoc+sandbox', 'srcdoc+sandbox+meta', 'route+sandbox', 'route-csp-sandbox-only', 'alt-scripts+csp', 'alt-csp-only']) {
    const t = token(engine, 'vec', label)
    if (process.env.SPIKE_DEBUG) console.log(`  vectors ${label}`)
    await page.evaluate(() => H.resetRan())
    page.consoleLines.length = 0
    const st = await mount(page, label, 'vectors', t, { timeout: 6000 })
    await sleep(2500)
    const ran = await page.evaluate(() => H.ranAll())
    const status = vectorStatus(t, ran)
    const blockedMessages = blockedConsole(page)
    // <base> in a document of its own.
    const tb = token(engine, 'vecb', label)
    await mount(page, label, 'base', tb)
    await sleep(800)
    status['base-href'] = hitsOf(tb).some((h) => h.kind === 'load' && h.v === 'base-href.gif') ? 'loaded' : 'blocked'
    out[label] = { state: { access: st.access, artifact: st.artifact }, status, blockedMessages }
  }
  await page.close()
  return out
}

async function groupParent(ctx, engine) {
  const page = await cabinet(ctx)
  const out = {}
  const names = ['parent-created-script', 'parent-created-script-src', 'parent-innerhtml-onerror', 'parent-setattribute-onclick', 'parent-eval', 'parent-function', 'parent-settimeout-string']
  for (const label of ['control', 'srcdoc+sandbox', 'srcdoc+sandbox+meta', 'route+sandbox', 'route-csp-sandbox-only', 'alt-scripts+csp']) {
    const t = token(engine, 'par', label)
    await page.evaluate(() => H.resetRan())
    await mount(page, label, 'blank', t)
    const snips = Object.fromEntries(names.map((n) => [n, corpus.mark(n, EXT, t)]))
    const calls = await page.evaluate(({ snips, ext, t }) => H.parentVectors(snips, ext, t), { snips, ext: EXT, t })
    await sleep(800)
    const ran = new Set(await page.evaluate(() => H.ranAll()))
    const hitV = new Set(hitsOf(t).filter((h) => h.kind === 'hit').map((h) => h.v))
    const status = {}
    for (const n of names) status[n] = ran.has(n) || hitV.has(n) ? 'RAN' : calls[n] === 'called' ? 'blocked' : `blocked (${calls[n]})`
    // document.write and javascript: navigation of the frame, each in a fresh frame.
    for (const [n, fn] of [['parent-document-write', 'documentWrite'], ['parent-location-javascript', 'locationJavascript']]) {
      const t2 = token(engine, 'par2', label, n)
      await page.evaluate(() => H.resetRan())
      await mount(page, label, 'blank', t2)
      const call = await page.evaluate(({ fn, snip }) => H[fn](snip), { fn, snip: corpus.mark(n, EXT, t2) })
      await sleep(800)
      const ran2 = new Set(await page.evaluate(() => H.ranAll()))
      const hit2 = hitsOf(t2).some((h) => h.kind === 'hit' && h.v === n)
      status[n] = ran2.has(n) || hit2 ? 'RAN' : call === 'called' ? 'blocked' : `blocked (${call})`
    }
    // The cabinet's own callbacks through the frame's APIs (not the artifact's code).
    await page.evaluate(() => H.resetRan())
    await mount(page, label, 'blank', token(engine, 'api', label))
    const apis = await page.evaluate(() => H.frameApis())
    await sleep(600)
    const ranApis = new Set(await page.evaluate(() => H.ranAll()))
    const cabinetCallbacks = {}
    for (const k of Object.keys(apis)) cabinetCallbacks[k] = ranApis.has(k) ? 'runs' : apis[k] === 'called' ? 'does not run' : apis[k]
    out[label] = { status, cabinetCallbacks }
  }
  await page.close()
  return out
}

async function groupClick(ctx, engine) {
  const out = {}
  const popups = []
  ctx.on('page', (p) => popups.push(p))
  const page = await cabinet(ctx)
  const downloads = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))
  const topUrl = page.url()
  const variants = [
    { key: 'control', label: 'control' },
    { key: 'srcdoc+sandbox+meta', label: 'srcdoc+sandbox+meta' },
    { key: 'srcdoc+sandbox+meta + preventDefault', label: 'srcdoc+sandbox+meta', prevent: true },
    { key: 'route+sandbox', label: 'route+sandbox' },
    { key: 'route+sandbox + preventDefault', label: 'route+sandbox', prevent: true },
    { key: 'route+sandbox, links rewritten by the server', label: 'route+sandbox', clean: true },
    { key: 'srcdoc+sandbox+meta, links rewritten by the server', label: 'srcdoc+sandbox+meta', clean: true },
    { key: 'route+sandbox, overlay mode', label: 'route+sandbox', overlay: true },
    { key: 'alt-scripts+csp', label: 'alt-scripts+csp' },
    { key: 'alt-scripts+csp + preventDefault', label: 'alt-scripts+csp', prevent: true },
  ]
  for (const { key, label, prevent, clean, overlay } of variants) {
    {
      out[key] = {}
      for (const [n] of corpus.clickVectors(EXT, 'x')) {
        if (page.url() !== topUrl) await page.goto(topUrl)
        const t = token(engine, 'clk', label, prevent ? 'p' : 'n', clean ? 'c' : '', overlay ? 'o' : '', n)
        await page.evaluate(() => H.resetRan())
        const before = popups.length
        const dl = downloads.length
        const st = await mount(page, label, `click-${n}`, t, { clean: !!clean })
        if (!st.access && label !== 'control') {
          out[key][n] = 'frame not accessible'
          continue
        }
        await page.evaluate(() => H.attach())
        if (prevent) await page.evaluate(() => H.blockLinks({ aux: true }))
        if (overlay) await page.evaluate(() => H.overlayMode('rgb(255,0,128)'))
        const r = await page.evaluate((id) => H.pageRect(id), n === 'area-link' ? 'cimg' : 'c')
        await page.mouse.click(r.x + Math.min(10, r.w / 2), r.y + r.h / 2)
        await sleep(1200)
        const ran = new Set(await page.evaluate(() => H.ranAll()).catch(() => []))
        const hits = hitsOf(t).filter((h) => h.kind === 'hit' || h.kind === 'probe').map((h) => h.v)
        const navigatedTop = page.url() !== topUrl
        let frame = null
        if (!navigatedTop) frame = await page.evaluate(() => H.state()).catch(() => null)
        const opened = popups.length - before
        for (const p of popups.slice(before)) await p.close().catch(() => {})
        const verdict = []
        if (ran.has(n)) verdict.push('SCRIPT RAN')
        if (navigatedTop) verdict.push('TOP NAVIGATED')
        if (opened) verdict.push(`POPUP ${opened}`)
        if (downloads.length > dl) verdict.push('DOWNLOAD')
        if (frame && !frame.artifact) verdict.push(`frame navigated (${frame.access ? 'same origin' : 'other origin'})`)
        if (hits.length) verdict.push(`request: ${[...new Set(hits)].join(', ')}`)
        out[key][n] = verdict.length ? verdict.join('; ') : 'nothing happened'
      }
    }
  }
  // Other ways to follow a link, with the capture listener on click and auxclick.
  const extra = {}
  for (const label of ['srcdoc+sandbox+meta', 'route+sandbox']) {
    for (const [n, how] of [
      ['link-self', 'keyboard Enter'],
      ['link-self', 'middle click'],
      ['link-self', `${mod}+click`],
      ['link-blank', 'middle click'],
      ['link-blank', `${mod}+click`],
      ['link-self', 'middle click, listener on click only'],
    ]) {
      if (page.url() !== topUrl) await page.goto(topUrl)
      const t = token(engine, 'clkx', label, n, how)
      const before = popups.length
      await mount(page, label, `click-${n}`, t)
      await page.evaluate(() => H.attach())
      await page.evaluate((aux) => H.blockLinks({ aux }), !how.includes('click only'))
      const r = await page.evaluate(() => H.pageRect('c'))
      if (how === 'keyboard Enter') {
        await page.evaluate(() => H.focusIn('c'))
        await page.keyboard.press('Enter')
      } else if (how.startsWith('middle')) await page.mouse.click(r.x + 5, r.y + r.h / 2, { button: 'middle' })
      else await page.mouse.click(r.x + 5, r.y + r.h / 2, { modifiers: [mod] })
      await sleep(900)
      const hits = hitsOf(t).filter((h) => h.kind === 'hit').map((h) => h.v)
      const opened = popups.length - before
      for (const p of popups.slice(before)) await p.close().catch(() => {})
      const frame = page.url() === topUrl ? await page.evaluate(() => H.state()).catch(() => null) : null
      const blocked = await page.evaluate(() => H.blocked ?? []).catch(() => [])
      const v = []
      if (page.url() !== topUrl) v.push('TOP NAVIGATED')
      if (opened) v.push(`POPUP ${opened}`)
      if (frame && !frame.artifact) v.push('frame navigated')
      if (hits.length) v.push(`request: ${hits.join(', ')}`)
      extra[`${label} | ${n} | ${how}`] = { result: v.length ? v.join('; ') : 'nothing happened', prevented: blocked.map((b) => b.type) }
    }
  }
  out.otherWays = extra
  await page.close()
  return out
}

async function groupNav(ctx, engine) {
  const page = await cabinet(ctx)
  const topUrl = page.url()
  const out = {}
  for (const label of ['control', 'srcdoc+sandbox', 'srcdoc+sandbox+meta', 'route+sandbox', 'alt-scripts+csp']) {
    out[label] = {}
    for (const [n] of corpus.navVectors(EXT, 'x')) {
      if (page.url() !== topUrl) await page.goto(topUrl)
      const t = token(engine, 'nav', label, n)
      await page.evaluate(() => H.resetRan())
      await mount(page, label, `nav-${n}`, t)
      await sleep(2000)
      const ran = new Set(await page.evaluate(() => H.ranAll()).catch(() => []))
      const hits = hitsOf(t).filter((h) => h.kind === 'hit').map((h) => h.v)
      const frame = await page.evaluate(() => H.state()).catch(() => null)
      const v = []
      if (ran.has(n) || hits.includes(n) && n.includes('javascript')) v.push('SCRIPT RAN')
      if (frame && !frame.artifact) v.push(`frame navigated (${frame.access ? 'same origin' : 'other origin'})`)
      if (hits.length) v.push(`request: ${hits.join(', ')}`)
      out[label][n] = v.length ? v.join('; ') : 'nothing happened'
    }
  }
  await page.close()
  return out
}

async function groupToplevel(ctx, engine) {
  const out = {}
  for (const [label, h] of [['route good, opened as a tab', 'good'], ['route without policy (control)', 'none']]) {
    const page = await ctx.newPage()
    const t = token(engine, 'top', h)
    await page.goto(`${srv.cabOrigin}/api/artifacts/vectors/edit-frame?t=${t}&h=${h}`)
    await sleep(2500)
    const ran = [...new Set(hitsOf(t).filter((x) => x.kind === 'hit').map((x) => x.v))]
    const loads = [...new Set(hitsOf(t).filter((x) => x.kind === 'load').map((x) => x.v))]
    out[label] = { scriptsThatRan: ran.length, examples: ran.slice(0, 6), externalLoads: loads.length }
    await page.close()
  }
  return out
}

/** Real input over the landing; which listeners of the cabinet fired, by phase. */
async function groupEvents(ctx, engine, browserName) {
  const out = {}
  for (const label of ['srcdoc+sandbox+meta', 'route+sandbox', 'alt-scripts+csp']) {
    const page = await cabinet(ctx)
    const t = token(engine, 'evt', label)
    await mount(page, label, 'landing', t, { stamp: true })
    await page.evaluate(() => H.attach())
    const hero = await page.evaluate(() => H.pageRect('hero'))
    const lead = await page.evaluate(() => H.pageRect('lead'))
    await page.mouse.move(5, 5)
    await page.mouse.move(hero.x + 30, hero.y + 10, { steps: 4 })
    await page.mouse.move(lead.x + 30, lead.y + 8, { steps: 4 })
    await page.mouse.click(hero.x + 40, hero.y + 12)
    await page.mouse.dblclick(hero.x + 60, hero.y + 12)
    await page.mouse.click(hero.x + 40, hero.y + 12, { button: 'right' })
    await page.keyboard.press('Escape')
    await page.mouse.click(hero.x + 40, hero.y + 12, { button: 'middle' })
    await page.evaluate(() => H.setEditable('lead', 'plaintext-only'))
    await page.mouse.click(lead.x + 20, lead.y + 8)
    await page.keyboard.type('Аб')
    await page.keyboard.press('KeyZ')
    await page.keyboard.press('Backspace')
    await page.evaluate(() => H.prepareCopy('<b>Жирный</b> текст', 'Жирный текст'))
    await page.keyboard.press(`${mod}+KeyC`)
    await page.mouse.click(lead.x + 20, lead.y + 8)
    await page.keyboard.press(`${mod}+KeyV`)
    await page.mouse.dblclick(lead.x + 60, lead.y + 8)
    await page.keyboard.press(`${mod}+KeyC`)
    await page.keyboard.press(`${mod}+KeyX`)
    if (browserName === 'chromium') {
      const cdp = await ctx.newCDPSession(page)
      await page.mouse.click(lead.x + 20, lead.y + 8)
      await cdp.send('Input.imeSetComposition', { text: 'пр', selectionStart: 2, selectionEnd: 2 })
      await cdp.send('Input.imeSetComposition', { text: 'привет', selectionStart: 6, selectionEnd: 6 })
      await cdp.send('Input.insertText', { text: 'привет' })
      await cdp.detach()
    }
    await page.mouse.click(hero.x + 40, hero.y + 12) // focus leaves #lead
    await page.mouse.move(hero.x + 40, hero.y + 100)
    await page.mouse.wheel(0, 300)
    await sleep(300)
    const sc = await page.evaluate(() => H.pageRect('scroller'))
    if (sc.y > 0 && sc.y < 600) {
      await page.mouse.move(sc.x + 20, sc.y + 20)
      await page.mouse.wheel(0, 40)
    }
    await sleep(200)
    await page.evaluate(() => H.resize(700))
    await sleep(300)
    out[label] = { summary: await page.evaluate(() => H.summary()), probe: await page.evaluate(() => H.probeListeners()) }
    await page.close()
  }
  return out
}

async function placeCaret(page, id) {
  const r = await page.evaluate((i) => H.pageRect(i), id)
  return r
}

async function groupEditing(ctx, engine, browserName) {
  const out = {}
  for (const label of ['srcdoc+sandbox+meta', 'route+sandbox']) {
    for (const mode of ['plaintext-only', 'true']) {
      const key = `${label} | ${mode}`
      const res = {}
      const page = await cabinet(ctx)
      const fresh = async () => {
        await mount(page, label, 'landing', token(engine, 'edt'), { stamp: true })
        await page.evaluate(() => H.attach())
      }
      const step = async (name, fn) => {
        try {
          res[name] = await fn()
        } catch (e) {
          res[name] = { error: String(e.message).split('\n')[0].slice(0, 200) }
        }
      }
      // Caret: where does one click put it, by strategy.
      for (const strategy of ['preset', 'pointerdown', 'click+caretFromPoint', 'programmatic']) {
        await step(`caret: ${strategy}`, async () => {
          await fresh()
          const r = await page.evaluate(() => H.pageRect('lead'))
          const x = r.x + Math.round(r.w * 0.4)
          const y = r.y + r.h / 2
          const fp = await page.evaluate(({ x, y }) => {
            const p = H.framePoint(x, y)
            return H.caretFromPoint(p.x, p.y)
          }, { x, y })
          if (strategy === 'preset') await page.evaluate((m) => H.setEditable('lead', m), mode)
          if (strategy === 'pointerdown') await page.evaluate((m) => H.editOnPointerDown(m), mode)
          if (strategy === 'click+caretFromPoint') await page.evaluate((m) => H.editOnClick(m), mode)
          if (strategy === 'programmatic') {
            await page.evaluate(({ m, x, y }) => {
              H.setEditable('lead', m)
              H.ov = { point: H.framePoint(x, y) }
              return H.overlayEdit('lead', m)
            }, { m: mode, x, y })
          } else await page.mouse.click(x, y)
          await sleep(150)
          const s = await page.evaluate(() => H.selection())
          await page.keyboard.type('Ж')
          const after = await page.evaluate(() => H.text('lead'))
          const want = fp ? fp.offset : null
          return { expected: want, anchor: s.anchor, offset: s.offset, active: s.active, typedAt: after.textContent.indexOf('Ж'), ok: s.anchor === 'lead' && after.textContent.includes('Ж') && want !== null && Math.abs(after.textContent.indexOf('Ж') - want) <= 2 }
        })
      }
      // Typing, Enter, Backspace, undo, the frame's execCommand from the cabinet.
      await step('type Cyrillic (keyboard.type)', async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('hero', m), mode)
        await page.evaluate(() => H.caretToEnd('hero'))
        await H_clear(page)
        await page.keyboard.type(' — с 6:00 «каждый» день')
        const t = await page.evaluate(() => H.text('hero'))
        const ev = await page.evaluate(() => H.summary())
        return { ok: t.textContent.endsWith(' — с 6:00 «каждый» день') || t.textContent.endsWith(' — с 6:00 «каждый» день'), tail: t.textContent.slice(-26), nbsp: t.nbsp, keydown: ev.keydown?.capture ?? 0, beforeinput: ev.beforeinput?.inputTypes ?? [] }
      })
      await step('insertText (keyboard.insertText)', async () => {
        await page.keyboard.insertText(' ёж')
        const t = await page.evaluate(() => H.text('hero'))
        return { ok: t.textContent.endsWith(' ёж'), tail: t.textContent.slice(-6) }
      })
      await step('Enter', async () => {
        const before = await page.evaluate(() => H.text('hero'))
        await page.keyboard.press('Enter')
        await page.keyboard.type('Х')
        const after = await page.evaluate(() => H.text('hero'))
        return { inserted: after.html.slice(before.html.length - 3).slice(0, 60), hasBr: /<br>/.test(after.html), hasDiv: /<div/.test(after.html), newline: after.textContent.includes('\n') }
      })
      await step('Backspace', async () => {
        const before = await page.evaluate(() => H.text('hero'))
        await page.keyboard.press('Backspace')
        const after = await page.evaluate(() => H.text('hero'))
        return { ok: after.textContent.length === before.textContent.length - 1 || after.html.length < before.html.length }
      })
      await step('undo (keyboard)', async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('lead', m), mode)
        await page.evaluate(() => H.caretToEnd('lead'))
        const before = (await page.evaluate(() => H.text('lead'))).textContent
        // Real key presses (Latin: Playwright has no Cyrillic layout) and one insertText.
        await page.keyboard.type('zz')
        await page.keyboard.press(`${mod}+KeyZ`)
        await sleep(100)
        const afterKeys = (await page.evaluate(() => H.text('lead'))).textContent
        await page.keyboard.insertText('ЮЮ')
        await page.keyboard.press(`${mod}+KeyZ`)
        await sleep(100)
        const afterInsert = (await page.evaluate(() => H.text('lead'))).textContent
        return { ok: afterKeys === before && afterInsert === before, keysRemoved: before.length + 2 - afterKeys.length, insertRemoved: !afterInsert.includes('ЮЮ') }
      })
      await step('undo (execCommand from the cabinet)', async () => {
        await page.keyboard.insertText('ЯЯ')
        const r = await page.evaluate(() => H.exec('undo'))
        const after = (await page.evaluate(() => H.text('lead'))).textContent
        return { ...r, removed: !after.includes('ЯЯ') }
      })
      await step('execCommand insertText from the cabinet', async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('lead', m), mode)
        await page.evaluate(() => H.caretToEnd('lead'))
        const r = await page.evaluate(() => H.exec('insertText', ' — вставка'))
        const after = (await page.evaluate(() => H.text('lead'))).textContent
        return { ...r, ok: after.endsWith(' — вставка') }
      })
      for (const how of ['native', 'plain']) {
        await step(`paste rich HTML (${how})`, async () => {
          await fresh()
          await page.evaluate((m) => H.setEditable('lead', m), mode)
          await page.evaluate((h) => H.onPaste(h), how)
          await page.evaluate(() => H.prepareCopy('<b>Жирный</b> и <a href="https://example.test">ссылка</a><img src="data:,">', 'Жирный и ссылка'))
          await page.keyboard.press(`${mod}+KeyC`)
          const copied = await page.evaluate(() => H.copied)
          await page.evaluate(() => H.caretToEnd('lead'))
          await page.keyboard.press(`${mod}+KeyV`)
          await sleep(150)
          const t = await page.evaluate(() => H.text('lead'))
          const pastes = await page.evaluate(() => H.pastes)
          return { copied, pasteEvent: pastes.length ? { trusted: pastes[0].trusted, types: pastes[0].types, plain: pastes[0].plain, htmlSeen: !!pastes[0].html } : null, inserted: t.textContent.includes('Жирный'), elementsInserted: /<(b|a|img|strong|span)\b/.test(t.html), tail: t.html.slice(-90) }
        })
      }
      await step('paste (synthetic event, listener path only)', async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('lead', m), mode)
        await page.evaluate(() => H.onPaste('plain'))
        await page.evaluate(() => H.caretToEnd('lead'))
        const r = await page.evaluate(() => H.syntheticPaste('lead', '<b>Жир</b>', 'Жир'))
        const t = await page.evaluate(() => H.text('lead'))
        const pastes = await page.evaluate(() => H.pastes)
        return { ...r, listenerSaw: pastes.length ? pastes[0].types : null, inserted: t.textContent.endsWith('Жир') }
      })
      await step(`bold shortcut (${mod}+B)`, async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('lead', m), mode)
        const r = await page.evaluate(() => H.pageRect('lead'))
        await page.mouse.dblclick(r.x + 30, r.y + r.h / 2)
        await page.keyboard.press(`${mod}+KeyB`)
        const t = await page.evaluate(() => H.text('lead'))
        return { boldInserted: /<(b|strong)\b|font-weight/.test(t.html) }
      })
      await step('bold shortcut, beforeinput cancelled', async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('lead', m), mode)
        await page.evaluate(() => H.cancelInputs(['formatBold', 'formatItalic', 'formatUnderline', 'insertParagraph', 'insertLineBreak']))
        const r = await page.evaluate(() => H.pageRect('lead'))
        await page.mouse.dblclick(r.x + 30, r.y + r.h / 2)
        await page.keyboard.press(`${mod}+KeyB`)
        await page.evaluate(() => H.caretToEnd('lead'))
        await page.keyboard.press('Enter')
        const t = await page.evaluate(() => H.text('lead'))
        const c = await page.evaluate(() => H.cancelled)
        return { boldInserted: /<(b|strong)\b|font-weight/.test(t.html), enterInserted: /<br>|<div|\n/.test(t.html), cancelled: c.map((x) => `${x.inputType}${x.cancelable ? '' : ' (not cancelable)'}`) }
      })
      for (const ws of ['normal', 'pre-wrap']) {
        await step(`spaces typed, white-space: ${ws}`, async () => {
          await fresh()
          if (ws === 'pre-wrap') await page.evaluate(() => H.injectStyle('[contenteditable]{white-space:pre-wrap}'))
          await page.evaluate((m) => H.setEditable('hero', m), mode)
          await page.evaluate(() => H.caretToEnd('hero'))
          const before = (await page.evaluate(() => H.text('hero'))).nbsp
          await page.keyboard.type(' а  б ')
          const t = await page.evaluate(() => H.text('hero'))
          return { nbspAdded: t.nbsp - before, tail: JSON.stringify(t.textContent.slice(-7)) }
        })
      }
      if (browserName === 'chromium') {
        await step('composition (CDP Input.imeSetComposition)', async () => {
          await fresh()
          await page.evaluate((m) => H.setEditable('lead', m), mode)
          await page.evaluate(() => H.caretToEnd('lead'))
          await page.evaluate(() => H.clearEvents())
          const cdp = await ctx.newCDPSession(page)
          await cdp.send('Input.imeSetComposition', { text: 'при', selectionStart: 3, selectionEnd: 3 })
          await cdp.send('Input.imeSetComposition', { text: 'привет', selectionStart: 6, selectionEnd: 6 })
          await cdp.send('Input.insertText', { text: 'привет' })
          await cdp.detach()
          const t = await page.evaluate(() => H.text('lead'))
          const ev = await page.evaluate(() => H.summary())
          return { ok: t.textContent.endsWith('привет'), start: ev.compositionstart?.capture ?? 0, update: ev.compositionupdate?.capture ?? 0, end: ev.compositionend?.capture ?? 0, beforeinput: ev.beforeinput?.inputTypes ?? [] }
        })
      }
      await step('read back', async () => {
        await fresh()
        await page.evaluate((m) => H.setEditable('mixed', m), mode)
        const t = await page.evaluate(() => H.text('mixed'))
        return { textContent: t.textContent, innerText: t.innerText }
      })
      out[key] = res
      await page.close()
    }
  }
  return out
}
const H_clear = (page) => page.evaluate(() => H.clearEvents())

async function groupGeometry(ctx, engine) {
  const out = {}
  for (const label of ['srcdoc+sandbox+meta', 'route+sandbox']) {
    const page = await cabinet(ctx)
    await page.setViewportSize({ width: 1000, height: 800 })
    await mount(page, label, 'landing', token(engine, 'geo'), { stamp: true })
    await page.evaluate(() => H.attach())
    const res = {}
    const shot = async () => decodePng(await page.screenshot())
    const r = await page.evaluate(() => H.pageRect('swatch'))
    let img = await shot()
    res.rect = { rect: r, centerColour: img.at(r.x + r.w / 2, r.y + r.h / 2), colourMatches: near(img.at(r.x + r.w / 2, r.y + r.h / 2), [0, 170, 255]) }
    res.playwrightBox = await page.frames()[1]?.locator('#swatch').boundingBox({ timeout: 2000 }).then((b) => ({ ok: !!b, dx: b ? Math.abs(b.x - r.x) : null, dy: b ? Math.abs(b.y - r.y) : null })).catch((e) => ({ error: String(e.message).split('\n')[0].slice(0, 120) }))
    res.elementFromPoint = await page.evaluate(({ x, y }) => H.hit(x, y), { x: r.fx + 10, y: r.fy + 10 })
    res.rangeRects = await page.evaluate(() => {
      const rects = H.textRects('lead')
      const el = H.pageRect('lead')
      return { count: rects.length, inside: rects.every((q) => q.x >= el.fx - 1 && q.y >= el.fy - 1 && q.x + q.w <= el.fx + el.w + 1 && q.y + q.h <= el.fy + el.h + 1) }
    })
    res.caretApis = await page.evaluate(() => H.caretApis())
    res.caretFromPoint = await page.evaluate(() => {
      const r = H.pageRect('lead')
      return H.caretFromPoint(r.fx + 30, r.fy + r.h / 2)
    })
    // Scrolling by the cabinet and by the wheel.
    const before = await page.evaluate(() => H.pageRect('s2'))
    const sc = await page.evaluate(() => H.scrollFrame(500))
    const after = await page.evaluate(() => H.pageRect('s2'))
    await sleep(150)
    const scrollEvents = await page.evaluate(() => H.summary().scroll ?? null)
    res.scrollByCabinet = { ...sc, shift: Math.round(before.y - after.y), scrollEventSeen: !!scrollEvents }
    await page.evaluate(() => H.scrollFrame(0))
    const f = await page.evaluate(() => H.pageRect('hero'))
    await page.mouse.move(f.x + 50, f.y + 150)
    await page.mouse.wheel(0, 250)
    await sleep(400)
    res.wheel = await page.evaluate(() => ({ scrollY: H.frame.contentWindow.scrollY }))
    res.innerScroll = await page.evaluate(() => H.scrollInner('scroller', 40))
    await page.evaluate(() => H.scrollFrame(0))
    // Resize: media queries and the window of the frame.
    await page.evaluate(() => H.clearEvents())
    await page.evaluate(() => H.resize(390))
    await sleep(300)
    res.resize390 = { ...(await page.evaluate(() => H.media())), resizeEvent: await page.evaluate(() => !!H.summary()['window-resize']) }
    await page.evaluate(() => H.resize(800))
    await sleep(200)
    // Outline drawn by the cabinet over the frame.
    const o = await page.evaluate(() => H.overlay('swatch', 'rgb(255,0,128)'))
    img = await shot()
    res.overlayOutside = { borderColour: img.at(o.x - 2, o.y + o.h / 2), ok: near(img.at(o.x - 2, o.y + o.h / 2), [255, 0, 128]) }
    await page.evaluate(() => H.removeOverlay())
    // Outline by a style element the cabinet puts inside the frame.
    await page.evaluate(() => H.injectStyle('[data-raditi-hover]{outline:3px solid rgb(255,0,128)!important;outline-offset:1px}'))
    await page.evaluate(() => H.setAttr('swatch', 'data-raditi-hover', ''))
    await sleep(100)
    img = await shot()
    const s2 = await page.evaluate(() => H.pageRect('swatch'))
    res.injectedStyle = { computed: await page.evaluate(() => H.computed('swatch', 'outline-style')), borderColour: img.at(s2.x - 2.5, s2.y + s2.h / 2), ok: near(img.at(s2.x - 2.5, s2.y + s2.h / 2), [255, 0, 128]) }
    res.adoptedStyleSheet = await page.evaluate(() => {
      const r = H.adoptStyle('#lead{outline:2px solid rgb(0,128,0)}')
      return { ...r, computed: H.computed('lead', 'outline-style') }
    })
    res.cssomStyle = await page.evaluate(() => H.styleProp('hero', 'outline', '2px dashed rgb(0,0,255)'))
    out[label] = res
    await page.close()
  }
  return out
}

/** «Выбрать элемент» and «Править текст» with no listener inside the frame. */
async function groupOverlay(ctx, engine) {
  const out = {}
  for (const label of ['route+sandbox', 'srcdoc+sandbox+meta']) {
    const page = await cabinet(ctx)
    await page.setViewportSize({ width: 1000, height: 800 })
    const res = {}
    const key = token(engine, 'ovk', label)
    await page.evaluate(({ key, t }) => H.store(key, 'landing', t), { key, t: key })
    await mount(page, label, `stored-${key}`, key)
    await page.evaluate(() => H.overlayMode('rgb(255,0,128)'))
    const hero = await page.evaluate(() => H.pageRect('hero'))
    const lead = await page.evaluate(() => H.pageRect('lead'))
    await page.mouse.move(5, 5)
    await page.mouse.move(hero.x + 30, hero.y + 12, { steps: 3 })
    const hov1 = await page.evaluate(() => H.ov.hovered)
    const img = decodePng(await page.screenshot())
    const o = await page.evaluate(() => H.pageRect('hero'))
    res.hover = { hovered: hov1, outline: near(img.at(o.x - 2, o.y + o.h / 2), [255, 0, 128]) }
    await page.mouse.move(lead.x + 30, lead.y + 8, { steps: 3 })
    res.hoverMoves = await page.evaluate(() => H.ov.hovered)
    await page.mouse.click(hero.x + Math.round(hero.w * 0.3), hero.y + hero.h / 2)
    res.selected = await page.evaluate(() => H.ov.selected)
    await page.mouse.move(lead.x + 30, lead.y + 100)
    await page.mouse.wheel(0, 200)
    await sleep(300)
    res.wheelForwarded = await page.evaluate(() => ({ wheel: H.ov.wheel, scrollY: H.frame.contentWindow.scrollY }))
    await page.evaluate(() => H.scrollFrame(0))
    // In place: the caret from the click point, native typing, the cabinet's MutationObserver.
    const fp = await page.evaluate(() => H.caretFromPoint(H.ov.point.x, H.ov.point.y))
    res.edit = await page.evaluate(() => H.overlayEdit('hero', 'plaintext-only'))
    await page.keyboard.type('Наш ')
    await sleep(100)
    const t = await page.evaluate(() => H.text('hero'))
    res.typed = { expectedOffset: fp?.offset ?? null, at: t.textContent.indexOf('Наш '), mutations: await page.evaluate(() => H.mutations.length) }
    await page.keyboard.press('Enter')
    await page.keyboard.type('Ш')
    res.enterNative = await page.evaluate(() => {
      const x = H.text('hero')
      return { br: /<br>/.test(x.html), div: /<div/.test(x.html), newline: x.textContent.includes('\n') }
    })
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    // Commit: the cabinet sees the end of editing on its own nodes.
    await page.mouse.click(8, 790)
    await sleep(100)
    res.endSeen = await page.evaluate(() => H.ended)
    res.commit = await page.evaluate((k) => H.commit(k), key)
    await mount(page, label, `stored-${key}`, key)
    res.afterReload = await page.evaluate(() => H.text('hero').textContent)
    // The cabinet's own field over the element.
    await page.evaluate(() => H.snapshot('lead'))
    res.field = await page.evaluate(() => H.fieldOver('lead'))
    await page.keyboard.type('Печём с семи утра')
    await page.keyboard.press('Escape')
    res.fieldKeys = await page.evaluate(() => H.fieldKeys.slice(-2))
    res.fieldCommit = await page.evaluate((k) => H.fieldCommit(k), key)
    await mount(page, label, `stored-${key}`, key)
    res.fieldAfterReload = await page.evaluate(() => H.text('lead').textContent)
    out[label] = res
    await page.close()
  }
  return out
}

async function groupRoundtrip(ctx, engine) {
  const out = {}
  for (const label of ['route+sandbox', 'srcdoc+sandbox+meta']) {
    const page = await cabinet(ctx)
    const res = {}
    const key = token(engine, 'rt', label)
    await page.evaluate(({ key, t }) => H.store(key, 'landing', t), { key, t: key })
    await mount(page, label, `stored-${key}`, key)
    await page.evaluate(() => H.attach())
    res.rids = await page.evaluate(() => H.ridsInFrame())
    // Whole text of the heading, typed by keyboard.
    await page.evaluate(() => H.snapshot('hero'))
    await page.evaluate(() => H.setEditable('hero', 'plaintext-only'))
    const r = await page.evaluate(() => H.pageRect('hero'))
    await page.mouse.click(r.x + 10, r.y + r.h / 2)
    await page.keyboard.press(`${mod}+KeyA`)
    await page.keyboard.type('Пекарня «Колос» & кофе <на вынос>')
    res.hero = await page.evaluate((k) => H.commit(k), key)
    // One text slot of a mixed paragraph: before the link.
    await page.evaluate(() => H.snapshot('mixed'))
    await page.evaluate(() => {
      H.setEditable('mixed', 'plaintext-only')
      const el = H.frame.contentDocument.getElementById('mixed')
      el.focus()
      const rg = H.frame.contentDocument.createRange()
      rg.setStart(el.firstChild, 0)
      rg.collapse(true)
      const s = H.frame.contentDocument.getSelection()
      s.removeAllRanges()
      s.addRange(rg)
    })
    await page.keyboard.type('Ещё: ')
    res.mixed = await page.evaluate((k) => H.commit(k), key)
    // An empty element.
    await page.evaluate(() => H.snapshot('empty'))
    await page.evaluate(() => {
      H.setEditable('empty', 'plaintext-only')
      H.caretToEnd('empty')
    })
    await page.keyboard.type('Новый абзац')
    res.empty = await page.evaluate((k) => H.commit(k), key)
    // The clone of the adoption agency shares its id with the original.
    await page.evaluate(() => {
      const d = H.frame.contentDocument
      const clone = d.querySelectorAll('#misnest')[1]
      clone.setAttribute('id', 'misnest-clone')
    })
    await page.evaluate(() => H.snapshot('misnest-clone'))
    await page.evaluate(() => {
      H.setEditable('misnest-clone', 'plaintext-only')
      H.caretToEnd('misnest-clone')
    })
    await page.keyboard.type('!')
    res.adoptionClone = await page.evaluate((k) => H.commit(k), key)
    await mount(page, label, `stored-${key}`, key)
    res.afterReload = await page.evaluate(() => ({ hero: H.text('hero').textContent, mixed: H.text('mixed').textContent, empty: H.text('empty').textContent, phone: H.text('phone').textContent }))
    out[label] = res
    await page.close()
  }
  return out
}

async function groupClobber(ctx, engine) {
  const out = {}
  for (const label of ['route+sandbox', 'srcdoc+sandbox+meta']) {
    const page = await cabinet(ctx)
    await mount(page, label, 'clobber', token(engine, 'clb'))
    out[label] = await page.evaluate(() => H.clobber())
    await page.close()
  }
  return out
}

async function groupTouch(browser, engine, browserName) {
  const opts = { hasTouch: true, viewport: { width: 390, height: 844 } }
  if (browserName !== 'firefox') opts.isMobile = browserName === 'chromium'
  let ctx
  try {
    ctx = await browser.newContext(opts)
  } catch (e) {
    return { error: String(e.message).split('\n')[0] }
  }
  const out = {}
  for (const label of ['route+sandbox']) {
    const page = await cabinet(ctx)
    await mount(page, label, 'landing', token(engine, 'tch'), { stamp: true, width: 360, height: 700 })
    await page.evaluate(() => H.attach())
    const hero = await page.evaluate(() => H.pageRect('hero'))
    await page.touchscreen.tap(hero.x + 30, hero.y + 10)
    await sleep(300)
    const sum = await page.evaluate(() => H.summary())
    out.tapEvents = Object.fromEntries(['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click'].map((k) => [k, sum[k] ? sum[k].capture : 0]))
    await page.evaluate(() => H.setEditable('lead', 'plaintext-only'))
    const lead = await page.evaluate(() => H.pageRect('lead'))
    await page.touchscreen.tap(lead.x + 40, lead.y + lead.h / 2)
    await sleep(300)
    out.caretAfterTap = await page.evaluate(() => H.selection())
    await page.keyboard.insertText('Тап')
    out.typed = (await page.evaluate(() => H.text('lead'))).textContent.includes('Тап')
    // Overlay mode on a phone: tap selects through the cabinet's own node.
    await mount(page, label, 'landing', token(engine, 'tch2'), { stamp: true, width: 360, height: 700 })
    await page.evaluate(() => H.overlayMode('rgb(255,0,128)'))
    const h2 = await page.evaluate(() => H.pageRect('lead'))
    await page.touchscreen.tap(h2.x + 30, h2.y + 8)
    await sleep(200)
    out.overlayTapSelected = await page.evaluate(() => H.ov.selected)
    await page.close()
  }
  await ctx.close()
  return out
}

async function groupCoep(ctx, engine) {
  const page = await cabinet(ctx, '/cabinet?coep=1')
  const out = {}
  for (const [label, extra] of [['srcdoc+sandbox+meta', {}], ['route+sandbox', {}], ['route+sandbox', { h: 'good-coep' }]]) {
    const st = await mount(page, label, 'landing', token(engine, 'coep'), extra)
    out[`${label}${extra.h ? ' (route sends COEP)' : ''}`] = { access: st.access, artifact: st.artifact }
  }
  await page.close()
  return out
}

async function groupReact(ctx, engine) {
  const page = await cabinet(ctx, '/react-cabinet')
  page.on('pageerror', (e) => page.consoleLines.push(`pageerror: ${e.message}`))
  const ready = await page.waitForFunction(() => window.R && window.R.ready, null, { timeout: 8000 }).then(() => true).catch(() => false)
  if (!ready) return { error: 'React page did not start', console: page.consoleLines.slice(0, 5) }
  const out = await page.evaluate(async (ext) => window.R.selfTest(ext), EXT)
  // Real clicks for the listener counts.
  const click = async (id) => {
    const r = await page.evaluate((i) => window.R.pageRect(i), id)
    if (!r) return false
    await page.mouse.click(r.x + 5, r.y + r.h / 2)
    await sleep(150)
    return true
  }
  const steps = {}
  steps.first = await click('hero')
  steps.afterFirst = await page.evaluate(() => window.R.counts())
  await page.evaluate(() => window.R.setDoc(2))
  await page.waitForFunction(() => window.R.loads() >= 2, null, { timeout: 4000 }).catch(() => {})
  await click('hero')
  steps.afterReload = await page.evaluate(() => window.R.counts())
  await page.evaluate(() => window.R.showPortal(true))
  await sleep(300)
  await click('portal-button')
  steps.portal = await page.evaluate(() => window.R.counts())
  await page.evaluate(() => window.R.unmount())
  await sleep(200)
  steps.afterUnmount = await page.evaluate(() => window.R.counts())
  out.clicks = steps
  out.toggle = await page.evaluate(async (ext) => window.R.toggleTest(ext), EXT)
  out.console = page.consoleLines.filter((l) => /error/i.test(l)).slice(0, 5)
  await page.close()
  return out
}

for (const name of ENGINES) {
  const bt = { chromium, webkit, firefox }[name]
  let browser = await bt.launch()
  const engine = `${name}-${PLATFORM}`
  const er = { version: browser.version(), uptime: uptime(), groups: {} }
  results.engines[name] = er
  for (const g of GROUPS) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } })
    const started = Date.now()
    // A group that hangs the engine (a busy web process) must not take the rest of the run with it.
    const limit = g === 'click' ? 600_000 : 240_000
    const work = (async () => {
      const fn = { delivery: groupDelivery, vectors: groupVectors, parent: groupParent, click: groupClick, nav: groupNav, toplevel: groupToplevel, events: groupEvents, editing: groupEditing, geometry: groupGeometry, overlay: groupOverlay, roundtrip: groupRoundtrip, clobber: groupClobber, coep: groupCoep, react: groupReact }[g]
      return g === 'touch' ? groupTouch(browser, engine, name) : fn(ctx, engine, name)
    })()
    try {
      const res = await Promise.race([work, sleep(limit).then(() => 'TIMEOUT')])
      if (res === 'TIMEOUT') {
        er.groups[g] = { error: `group did not finish in ${limit / 1000} s` }
        await browser.close().catch(() => {})
        browser = await bt.launch()
      } else er.groups[g] = res
    } catch (e) {
      er.groups[g] = { error: String(e.stack ?? e).split('\n').slice(0, 4).join(' | ') }
    }
    await ctx.close().catch(() => {})
    console.log(`${name} ${g} ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  await browser.close()
}

// Server side checks (engine independent).
const landing = corpus.landingDoc(EXT, 'srv')
results.server = {
  stampedElements: stamp(landing).stamped,
  duplicateIdsAfterStamp: duplicateIds(stamp(landing).html),
  misplacedTexts: misplacedTexts(stamp(landing).html),
  noscriptStamped: { scriptingFalse: /<noscript[^>]*><p data-rid="e\d+" id="ns">/.test(stamp(landing, { scriptingEnabled: false }).html), scriptingTrue: /<noscript[^>]*><p data-rid="e\d+" id="ns">/.test(stamp(landing, { scriptingEnabled: true }).html) },
}
results.finishedAt = new Date().toISOString()
results.uptimeAtEnd = uptime()
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(results, null, 1))
await srv.close()
console.log(`wrote ${OUT}`)
