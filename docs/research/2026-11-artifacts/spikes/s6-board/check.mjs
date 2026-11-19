// Functional checks of spike s6 (no timing claims except the busy-frame stall, which is 150 ms):
//  E — pointer and wheel over live frames on the board, per engine × board × pattern;
//  T — touch pan and pinch in Chromium phone emulation, and the phone list;
//  P — process model of sandboxed frames in Chromium;
//  B — does a busy frame stall the cabinet's frames (separate process vs the cabinet's process);
//  A — the adaptive policy (live only when zoomed in) swaps thumbnails and live frames;
//  S — the frames really are sandboxed (opaque origin, no network).
// node check.mjs [--only E,T,P,B,A,S]   →  out/check.json and a Markdown table
import fs from 'node:fs'
import { startServers } from './server.mjs'
import { launchChromium, webkit, firefox, LAPTOP, PHONE, boardUrl, openBoard, processes, identify, mouseDrag, wheel, touchPan, touchPinch, sleep, frameStats, uptimeLine } from './lib.mjs'
import { makeThumbs } from './thumbs.mjs'

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const want = (k) => !only.length || only.includes(k)
const results = []
const rec = (group, name, cond, value, ok, note = '') => { results.push({ group, name, cond, value, ok, note }); console.log(`${ok === null ? '·' : ok ? '✓' : '✗'} ${group} ${name} [${cond}] ${typeof value === 'object' ? JSON.stringify(value) : value}${note ? ' — ' + note : ''}`) }

await makeThumbs()
if (!fs.existsSync('dist/index.html')) throw new Error('run "pnpm build" first')
const s = await startServers()
console.log(uptimeLine())

// put the live desktop frame of screen 1 in the middle at zoom 0.35
async function focusFrame(page, id = 'm1-a@1440', zoom = 0.35) {
  return page.evaluate(({ id, zoom }) => {
    const b = window.__board, f = b.frames.find((x) => x.id === id), r = b.rect()
    b.setViewport({ zoom, x: r.w / 2 - (f.x + f.w / 2) * zoom, y: r.h / 2 - (f.y + 700) * zoom })
    return { rect: r, frame: f }
  }, { id, zoom })
}
async function frameCenter(page, id = 'm1-a@1440') {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-frame="${id}"]`).getBoundingClientRect()
    const r = window.__board.rect()
    // the visible middle of the frame inside the board
    const l = Math.max(el.left, r.x), t = Math.max(el.top, r.y), rr = Math.min(el.right, r.x + r.w), bb = Math.min(el.bottom, r.y + r.h)
    return { x: (l + rr) / 2, y: (t + bb) / 2, left: el.left, right: el.right, top: el.top }
  }, id)
}
const vp = (page) => page.evaluate(() => window.__board.getViewport())
const moved = (a, b) => ({ dx: Math.round(b.x - a.x), dy: Math.round(b.y - a.y), dz: Math.round((b.zoom / a.zoom - 1) * 1000) / 10 })

// --- E: events over live frames ------------------------------------------------------------------
async function eventChecks(engine, launch, ctxOpts, origins, pes = ['none', 'shield', 'drag', 'auto']) {
  for (const impl of ['a', 'b']) {
    for (const pe of pes) {
      const browser = await launch()
      const page = await (await browser.newContext(ctxOpts)).newPage()
      const cond = `${engine} ${impl === 'a' ? 'CSS' : 'xyflow'} pe=${pe}`
      try {
        await openBoard(page, boardUrl(origins.cabinet, { impl, live: 2, pe, frames: origins.frames }))
        await focusFrame(page); await sleep(400)
        let c = await frameCenter(page)
        // W0: the control — wheel over the empty board, left of the frame
        let a0 = await vp(page); await wheel(page, { x: c.left - 40, y: c.y }, { dy: 60, n: 6 }); await sleep(350); let b0 = await vp(page)
        rec('E', 'колёсико над пустым холстом двигает холст (контроль)', cond, moved(a0, b0), Math.abs(moved(a0, b0).dy) > 40)
        await focusFrame(page); await sleep(350); c = await frameCenter(page)
        // W1: ctrl+wheel over the frame zooms the board
        let a = await vp(page); await wheel(page, c, { dy: -10, n: 6, ctrl: true }); await sleep(350); let b = await vp(page)
        let m = moved(a, b); rec('E', 'ctrl+wheel над кадром масштабирует холст', cond, m, Math.abs(m.dz) > 2)
        await focusFrame(page); await sleep(350); c = await frameCenter(page)
        // W2: wheel over the frame pans the board
        a = await vp(page); await wheel(page, c, { dy: 60, n: 6 }); await sleep(350); b = await vp(page)
        m = moved(a, b); rec('E', 'колёсико над кадром двигает холст', cond, m, Math.abs(m.dy) > 40)
        await focusFrame(page); await sleep(350); c = await frameCenter(page)
        // D1: a drag that starts on the frame pans
        a = await vp(page); await mouseDrag(page, c, { x: c.x + 200, y: c.y }, { steps: 20, gap: 8 }); await sleep(350); b = await vp(page)
        m = moved(a, b); rec('E', 'перетаскивание с кадра двигает холст', cond, m, Math.abs(m.dx - 200) < 30)
        await focusFrame(page); await sleep(350); c = await frameCenter(page)
        // D2: a drag from the background across the frame keeps panning all the way
        const start = { x: c.left - 60, y: c.y }
        a = await vp(page); await mouseDrag(page, start, { x: start.x + 360, y: start.y }, { steps: 36, gap: 8 }); await sleep(350); b = await vp(page)
        m = moved(a, b); rec('E', 'перетаскивание с фона через кадр', cond, m, Math.abs(m.dx - 360) < 30, Math.abs(m.dx - 360) >= 30 ? `потеряно ${360 - m.dx} px` : '')
        await focusFrame(page); await sleep(350); c = await frameCenter(page)
        // O1: double click on the frame opens it («Открыть»)
        await page.mouse.dblclick(c.x, c.y); await sleep(400)
        const opened = await page.evaluate(() => window.__board.focused())
        rec('E', 'двойной щелчок по кадру открывает его', cond, opened ?? 'нет', !!opened)
        if (!opened) await page.evaluate(() => window.__board.open('m1-a@1440'))
        await page.waitForSelector('iframe[data-id="overlay"]')
        const ov = page.frameLocator('iframe[data-id="overlay"]')
        await ov.locator('#order').waitFor({ timeout: 15000 })
        // O2: the opened frame is interactive
        await ov.locator('#order').click()
        const cnt = await ov.locator('#cnt').textContent()
        rec('E', 'в открытом кадре работают кнопки', cond, cnt, cnt === '1')
        // O3: wheel inside the opened frame scrolls the frame, not the board
        const box = await page.locator('iframe[data-id="overlay"]').boundingBox()
        a = await vp(page)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 200); await sleep(30) }
        await sleep(500)
        b = await vp(page)
        let sy = null
        for (const f of page.frames()) { try { if (f.url().endsWith('/v/m1-a')) { const y = await f.evaluate(() => scrollY); if (y > 0) sy = y } } catch {} }
        rec('E', 'колёсико в открытом кадре листает кадр', cond, { frameScrollY: sy, board: moved(a, b) }, sy > 0 && Math.abs(moved(a, b).dz) < 0.5)
        // O4: Escape after a click inside the frame — the cabinet does not hear it
        await page.keyboard.press('Escape'); await sleep(200)
        const still = await page.evaluate(() => window.__board.focused())
        rec('E', 'Esc после щелчка в кадре закрывает окно', cond, still ? 'окно открыто' : 'закрыто', null, 'клавиши уходят в кадр')
        await page.locator('[data-close]').click(); await sleep(200)
        rec('E', '«Закрыть» закрывает окно', cond, await page.evaluate(() => window.__board.focused()) ?? 'закрыто', !(await page.evaluate(() => window.__board.focused())))
      } catch (e) {
        rec('E', 'ошибка прогона', cond, String(e.message).slice(0, 200), false)
      }
      await browser.close()
    }
  }
}

const engines = (process.argv.find((a) => a.startsWith('--engines=')) ?? '--engines=chromium,webkit,firefox').slice(10).split(',')
if (want('E')) {
  const chromeOrigins = { cabinet: s.origins.cabinet, frames: s.origins.sameSite }
  const localOrigins = { cabinet: s.origins.cabinetLocal, frames: s.origins.framesLoopback }
  const plain = { viewport: LAPTOP.viewport, deviceScaleFactor: 2 }
  if (engines.includes('chromium')) await eventChecks('chromium', () => launchChromium(), LAPTOP, chromeOrigins)
  if (engines.includes('webkit')) await eventChecks(`webkit ${process.platform}`, () => webkit.launch(), plain, localOrigins)
  // Firefox 155 of Playwright 1.63 does not start on this macOS ("Could not find profile folder");
  // `node check.mjs --only=E --engines=firefox` runs in the Linux container (see README)
  if (engines.includes('firefox')) await eventChecks(`firefox ${process.platform}`, () => firefox.launch(), plain, localOrigins)
}

// --- T: touch -------------------------------------------------------------------------------------
if (want('T')) {
  for (const impl of ['a', 'b']) {
    for (const pe of ['none', 'auto']) {
      const browser = await launchChromium()
      const context = await browser.newContext(PHONE)
      const page = await context.newPage()
      const cond = `chromium Pixel 7 ${impl === 'a' ? 'CSS' : 'xyflow'} pe=${pe}`
      try {
        await openBoard(page, boardUrl(s.origins.cabinet, { impl, live: 2, pe, frames: s.origins.sameSite }))
        const cdp = await context.newCDPSession(page)
        await focusFrame(page, 'm1-a@1440', 0.2); await sleep(400)
        let c = await frameCenter(page)
        let a = await vp(page); await touchPan(cdp, c, { x: c.x + 120, y: c.y + 80 }, { steps: 20 }); await sleep(400); let b = await vp(page)
        let m = moved(a, b); rec('T', 'палец с кадра двигает холст', cond, m, Math.abs(m.dx - 120) < 25 && Math.abs(m.dy - 80) < 25)
        await focusFrame(page, 'm1-a@1440', 0.2); await sleep(400); c = await frameCenter(page)
        a = await vp(page); await touchPinch(cdp, c, { from: 80, to: 240, steps: 24 }); await sleep(400); b = await vp(page)
        const scale = await page.evaluate(() => visualViewport.scale)
        m = moved(a, b); rec('T', 'щипок над кадром масштабирует холст', cond, { ...m, pageScale: scale }, m.dz > 100 && scale === 1, 'ожидаем ×3')
      } catch (e) { rec('T', 'ошибка прогона', cond, String(e.message).slice(0, 200), false) }
      await browser.close()
    }
  }
  // the phone list (Ар49)
  const browser = await launchChromium()
  const context = await browser.newContext(PHONE)
  const page = await context.newPage()
  try {
    await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'list', frames: s.origins.sameSite }))
    const cdp = await context.newCDPSession(page)
    const y0 = await page.evaluate(() => document.querySelector('.phone-list').scrollTop)
    await touchPan(cdp, { x: 200, y: 700 }, { x: 200, y: 200 }, { steps: 20 }); await sleep(600)
    const y1 = await page.evaluate(() => document.querySelector('.phone-list').scrollTop)
    rec('T', 'список миниатюр листается пальцем', 'chromium Pixel 7 list', { from: y0, to: Math.round(y1) }, y1 - y0 > 300)
    const card = await page.locator('.phone-list .MuiCardActionArea-root').nth(1).boundingBox()
    await page.touchscreen.tap(card.x + card.width / 2, card.y + 40); await sleep(400)
    const opened = await page.evaluate(() => window.__board.focused())
    rec('T', 'касание карточки открывает живой кадр', 'chromium Pixel 7 list', opened ?? 'нет', !!opened)
    if (opened) {
      const ov = page.frameLocator('iframe[data-id="overlay"]')
      await ov.locator('body').waitFor({ timeout: 15000 })
      const w = await ov.locator('html').evaluate(() => innerWidth)
      rec('T', 'открытый кадр — телефонный вид', 'chromium Pixel 7 list', `${w} px`, w <= 412)
    }
  } catch (e) { rec('T', 'ошибка прогона', 'list', String(e.message).slice(0, 200), false) }
  await browser.close()
}

// --- P: process model ------------------------------------------------------------------------------
async function processModel(label, opts, frames, live = 6) {
  const browser = await launchChromium(opts)
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'a', live, frames }))
  const bs = await browser.newBrowserCDPSession()
  const id = await identify(page, bs)
  const renderers = (await processes(bs)).filter((p) => p.type === 'renderer').length
  rec('P', 'где живут кадры', label, { frames: page.frames().length - 1, oopif: id.oopif, frameProcesses: id.frames.length || 0, inCabinetProcess: id.oopif === 0 || id.frames.includes(id.cabinet), renderers }, null)
  await browser.close()
  return id
}
if (want('P')) {
  await processModel('Chromium 153, тот же сайт (pages.* рядом с кабинетом), sandbox', {}, s.origins.sameSite)
  await processModel('то же, --disable-features=IsolateSandboxedIframes', { disable: ['IsolateSandboxedIframes'] }, s.origins.sameSite)
  await processModel('отдельный сайт (frames.example.net)', {}, s.origins.crossSite)
  await processModel('без изоляции сайтов (как Android без входа), тот же сайт', { args: ['--disable-site-isolation-trials'] }, s.origins.sameSite)
  await processModel('Chromium 153, 20 живых кадров', {}, s.origins.sameSite, 20)
}

// --- B: busy frame ---------------------------------------------------------------------------------
async function busy(label, opts) {
  const browser = await launchChromium(opts)
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'a', live: 2, busy: 1, frames: s.origins.sameSite }))
  await focusFrame(page); await sleep(500)
  const c = await frameCenter(page)
  await page.evaluate(() => window.__perf.start())
  await wheel(page, c, { dy: 20, n: 80, gap: 16 })
  const st = frameStats(await page.evaluate(() => window.__perf.stop()))
  rec('B', 'кадр с тяжёлым скриптом (150 мс из 300)', label, { maxFrameMs: st.max, over50: st.over50, longTasks: st.longTasks, fps: st.fps }, null, 'предварительно: машина нагружена')
  await browser.close()
  return st
}
if (want('B')) {
  const sep = await busy('кадры в своём процессе (по умолчанию)', {})
  const inproc = await busy('кадры в процессе кабинета (IsolateSandboxedIframes выключен)', { disable: ['IsolateSandboxedIframes'] })
  // the robust signal is the cabinet's long tasks: the frame's 150 ms tasks land on the cabinet's main
  // thread only when they share a process; frame times also depend on the machine's load
  rec('B', 'тяжёлый кадр занимает главный поток кабинета только в общем процессе', 'сравнение', { separateLongTasks: sep.longTasks, sharedLongTasks: inproc.longTasks, separateMaxMs: sep.max, sharedMaxMs: inproc.max }, sep.longTasks === 0 && inproc.longTasks >= 5)
}

// --- A: adaptive live policy ---------------------------------------------------------------------
if (want('A')) {
  for (const impl of ['a', 'b']) {
    const browser = await launchChromium()
    const page = await (await browser.newContext(LAPTOP)).newPage()
    const cond = `${impl === 'a' ? 'CSS' : 'xyflow'} live=auto4, zlive=0.3`
    try {
      await openBoard(page, boardUrl(s.origins.cabinet, { impl, live: 'auto4', frames: s.origins.sameSite }))
      const l0 = await page.evaluate(() => window.__board.liveIds())
      rec('A', 'общий вид — только миниатюры', cond, l0.length, l0.length === 0)
      await focusFrame(page, 'm2-a@1440', 0.45); await sleep(400)
      await page.evaluate(() => window.__board.idle())
      const l1 = await page.evaluate(() => window.__board.liveIds())
      rec('A', 'приблизили экран — видимые кадры ожили (не больше 4)', cond, l1, l1.includes('m2-a@1440') && l1.length <= 4)
      const thumbs = await page.evaluate(() => [...document.querySelectorAll('[data-frame="m2-a@1440"] img')].length)
      rec('A', 'миниатюра снята после загрузки живого кадра', cond, thumbs, thumbs === 0)
      await page.evaluate(() => window.__board.fitAll()); await sleep(400)
      const l2 = await page.evaluate(() => window.__board.liveIds())
      rec('A', 'отдалили — кадры снова миниатюры', cond, l2.length, l2.length === 0)
    } catch (e) { rec('A', 'ошибка прогона', cond, String(e.message).slice(0, 200), false) }
    await browser.close()
  }
}

// --- S: sandbox --------------------------------------------------------------------------------------
if (want('S')) {
  const browser = await launchChromium()
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'a', live: 2, frames: s.origins.sameSite }))
  const fr = page.frames().find((f) => f.url().endsWith('/v/m1-a'))
  const r = await fr.evaluate(async () => {
    let net = 'открыта'
    try { await fetch('/_files/coffee-g1.jpg'); } catch { net = 'закрыта' }
    let cookie = 'доступны'
    try { void document.cookie } catch { cookie = 'закрыты' }
    const img = [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length
    return { origin: self.origin, net, cookie, imagesLoaded: img }
  })
  const h = await page.evaluate(() => [...window.__heights])
  rec('S', 'кадр в песочнице: непрозрачный источник, без сети, фото грузятся', 'chromium', r, r.origin === 'null' && r.net === 'закрыта' && r.imagesLoaded > 0)
  rec('S', 'высота от моста кадра совпадает с высотой миниатюры', 'chromium', h, h.length === 2 && h.every(([id, v]) => Math.abs(v - (id.endsWith('1440') ? 4166 : 6657)) <= 2))
  await browser.close()
}

await s.close()
fs.mkdirSync('out', { recursive: true })
const outFile = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=out/check.json').slice(6)
const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { results: [] }
// a partial run (--only) replaces only its own groups and conditions
const keep = prev.results.filter((r) => !results.some((x) => x.group === r.group && x.cond === r.cond))
fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), uptime: uptimeLine(), platform: process.platform, results: [...keep, ...results] }, null, 2))
console.log('\n| Группа | Проверка | Условие | Значение | Итог |\n| --- | --- | --- | --- | --- |')
for (const r of results) console.log(`| ${r.group} | ${r.name} | ${r.cond} | ${typeof r.value === 'object' ? JSON.stringify(r.value).replaceAll('|', '/') : r.value} | ${r.ok === null ? '—' : r.ok ? 'да' : 'нет'} |`)
const bad = results.filter((r) => r.ok === false && r.cond.includes('pe=none'))
console.log(`\npattern (pe=none) failures: ${bad.length}`)
