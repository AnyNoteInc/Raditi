// Measurements of the spike. Builds dist/, then for each profile and row count opens a fresh
// browser and measures: first render, frames during a scripted scroll (with and without edits
// by someone else), long tasks, JS heap (Chromium, CDP Performance.getMetrics after a GC), DOM size,
// input → paint of edits, moves, sort, filter, paste of 300 rows, totals in decimal.js, Excel.
// Writes results.json and prints Markdown tables.
//
//   node measure.mjs                    full run: 5 iterations, 300, 5 000 and 20 000 rows, three profiles
//   node measure.mjs --smoke            one iteration of everything, to see that it works
//   node measure.mjs --iterations=3 --rows=300,5000,20000 --profiles=desktop,phone,iphone
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { chromium, devices, webkit } from 'playwright-core'
import { buildSpike } from './build.mjs'
import { sheetsRows } from './fixtures/paste.mjs'
import { serve } from './serve.mjs'

const root = import.meta.dirname
const argv = process.argv.slice(2)
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const smoke = argv.includes('--smoke')
const iterations = Number(flag('iterations') ?? (smoke ? 1 : 5))
const rowsList = (flag('rows') ?? (smoke ? '300,5000' : '300,5000,20000')).split(',').map(Number)
const profileNames = (flag('profiles') ?? 'desktop,phone,iphone').split(',')
const out = flag('out') ?? (smoke ? 'results-smoke.json' : 'results.json')

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36'

const PROFILES = {
  desktop: {
    label: 'Ноутбук, Chromium 1440×900',
    type: chromium,
    launch: { channel: 'chromium' },
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ru-RU', acceptDownloads: true },
    throttle: 1,
    touch: false,
  },
  phone: {
    label: 'Телефон, Chromium 390×844, касание, ЦП ×4 медленнее',
    type: chromium,
    launch: { channel: 'chromium' },
    context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA, locale: 'ru-RU', acceptDownloads: true },
    throttle: 4,
    touch: true,
  },
  iphone: {
    label: 'iPhone 13, WebKit, окно 390×664 (экран 390×844), без замедления',
    type: webkit,
    launch: {},
    context: { ...devices['iPhone 13'], locale: 'ru-RU', acceptDownloads: true },
    throttle: 1,
    touch: true,
  },
}

const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim()
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const pct = (xs, p) => {
  const v = [...xs].sort((a, b) => a - b)
  if (v.length === 0) return null
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]
}
const round = (x, d = 1) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d)

function frameStats(report) {
  const iv = report.intervals.filter((x) => x > 0)
  const dropped = iv.filter((x) => x > 25).length
  return {
    frames: iv.length,
    p50: round(pct(iv, 50)),
    p95: round(pct(iv, 95)),
    p99: round(pct(iv, 99)),
    max: round(Math.max(0, ...iv)),
    droppedPct: iv.length ? round((100 * dropped) / iv.length) : null,
    longTasks: report.longTasks.length,
    longTaskMs: round(report.longTasks.reduce((s, t) => s + t.duration, 0)),
    loafs: report.loafs.length,
    loafBlockingMs: round(report.loafs.reduce((s, t) => s + t.blocking, 0)),
  }
}

async function metrics(cdp) {
  if (!cdp) return null
  await cdp.send('HeapProfiler.collectGarbage')
  await new Promise((r) => setTimeout(r, 300))
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  const m = Object.fromEntries(list.map((x) => [x.name, x.value]))
  return {
    heapUsedMB: round(m.JSHeapUsedSize / 1048576, 2),
    heapTotalMB: round(m.JSHeapTotalSize / 1048576, 2),
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    layoutCount: m.LayoutCount,
    recalcStyleCount: m.RecalcStyleCount,
    scriptDurationS: round(m.ScriptDuration, 3),
  }
}

/** Scrolls the table: a steady pass, a fast pass back and a long pass, the same on every profile. */
async function scroll(page, cdp, profile, segments) {
  const box = await page.locator('[data-grid], [data-cards]').first().boundingBox()
  const x = Math.round(box.x + box.width / 2)
  const y = Math.round(box.y + box.height * (profile.touch ? 0.75 : 0.5))
  for (const [distance, speed] of segments) {
    if (cdp) {
      await cdp.send('Input.synthesizeScrollGesture', {
        x,
        y,
        yDistance: -distance,
        speed,
        gestureSourceType: profile.touch ? 'touch' : 'mouse',
        preventFling: true,
        // repeatCount is the number of repeats after the first pass: 0 means one gesture.
      })
    } else {
      // WebKit has no CDP: move scrollTop each frame at the same speed.
      await page.evaluate(
        ([d, v]) =>
          new Promise((resolve) => {
            const el = document.querySelector('[data-grid], [data-cards]')
            const start = performance.now()
            const from = el.scrollTop
            const step = (t) => {
              const done = Math.min(1, ((t - start) / 1000) * (v / Math.abs(d)))
              el.scrollTop = from + d * done
              if (done < 1) requestAnimationFrame(step)
              else resolve()
            }
            requestAnimationFrame(step)
          }),
        [distance, speed],
      )
    }
  }
}

const SCROLL = smoke ? [[2000, 2000], [-2000, 6000]] : [[3000, 1500], [-3000, 6000], [6000, 3000]]

async function framesDuring(page, fn) {
  const before = await page.evaluate(() => {
    window.__spike.frames.start()
    const el = document.querySelector('[data-grid], [data-cards]')
    return { top: el.scrollTop, commits: window.__spike.commits }
  })
  let travelled = 0
  const watch = await page.evaluate(() => {
    const el = document.querySelector('[data-grid], [data-cards]')
    window.__travel = 0
    let last = el.scrollTop
    window.__onScroll = () => {
      window.__travel += Math.abs(el.scrollTop - last)
      last = el.scrollTop
    }
    el.addEventListener('scroll', window.__onScroll, { passive: true })
    return true
  })
  await fn()
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-grid], [data-cards]')
    el.removeEventListener('scroll', window.__onScroll)
    return { top: el.scrollTop, commits: window.__spike.commits, travel: window.__travel, report: window.__spike.frames.stop() }
  })
  travelled = after.travel
  return { ...frameStats(after.report), travelledPx: Math.round(travelled), commits: after.commits - before.commits, watch }
}

/** Jumps to ten places, as when the scrollbar is dragged: the frame that mounts a screen of new rows. */
async function jumps(page) {
  await page.evaluate(() => window.__spike.frames.start())
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const el = document.querySelector('[data-grid], [data-cards]')
        let k = 0
        const next = () => {
          if (k++ >= 10) return resolve()
          el.scrollTop = ((k * 0.37) % 1) * (el.scrollHeight - el.clientHeight)
          setTimeout(next, 150)
        }
        next()
      }),
  )
  return frameStats(await page.evaluate(() => window.__spike.frames.stop()))
}

const interactions = (page, name) => page.evaluate((n) => window.__spike.interactions.filter((i) => i.name === n).map((i) => i.ms), name)

async function gridScenarios(page) {
  const r = {}
  // Edits of a price: Enter opens, a value, Enter commits.
  for (let k = 0; k < 5; k++) {
    await page.evaluate((i) => window.__spike.grid.focus(i, 'price'), 3 + k * 2)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__spike.grid.editing() !== null)
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(`${120 + k},50`)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__spike.grid.editing() === null)
    await page.waitForTimeout(60)
  }
  r.editStart = median(await interactions(page, 'editStart'))
  r.editCommit = median(await interactions(page, 'editCommit'))
  // Arrow moves.
  for (let k = 0; k < 15; k++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(20)
  }
  r.move = median(await interactions(page, 'move'))
  // Sort by price, then by name (Intl.Collator), then off.
  const header = (id) => page.locator(`[role=columnheader][data-col="${id}"]`)
  await header('price').click()
  await page.waitForTimeout(80)
  r.sortPriceViewMs = await page.evaluate(() => window.__spike.lastViewMs)
  await header('price').click()
  await header('price').click()
  await header('name').click()
  await page.waitForTimeout(80)
  r.sortNameViewMs = await page.evaluate(() => window.__spike.lastViewMs)
  await header('name').click()
  await header('name').click()
  await page.waitForTimeout(80)
  r.sort = median(await interactions(page, 'sort'))
  // Search.
  await page.locator('[data-search]').fill('пирог')
  await page.waitForTimeout(80)
  r.filterViewMs = await page.evaluate(() => window.__spike.lastViewMs)
  await page.locator('[data-search]').fill('')
  await page.waitForTimeout(80)
  r.filter = median(await interactions(page, 'filter'))
  // Paste of 300 rows × 6 columns at the top.
  const { text } = sheetsRows(300)
  await page.evaluate(() => window.__spike.grid.focus(0, 'name'))
  await page.evaluate((t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
  await page.waitForTimeout(150)
  r.paste300 = median(await interactions(page, 'paste'))
  r.pasteBatches = await page.evaluate(() => window.__spike.lastPaste?.sent?.length ?? null)
  return r
}

async function cardScenarios(page) {
  const r = {}
  for (let k = 0; k < 3; k++) {
    await page.locator('[role=listitem] .main').nth(k).tap()
    await page.locator('[data-sheet]').waitFor()
    await page.locator('[data-field=price]').fill(`${200 + k}`)
    await page.getByRole('button', { name: 'Сохранить' }).tap()
    await page.locator('[data-sheet]').waitFor({ state: 'detached' })
  }
  r.sheetOpen = median(await interactions(page, 'sheetOpen'))
  r.sheetSave = median(await interactions(page, 'sheetSave'))
  for (let k = 0; k < 5; k++) {
    await page.locator('[role=listitem] .stock').nth(k % 3).tap()
    await page.waitForTimeout(60)
  }
  r.toggle = median(await interactions(page, 'toggle'))
  await page.locator('[data-search]').fill('торт')
  await page.waitForTimeout(80)
  r.filterViewMs = await page.evaluate(() => window.__spike.lastViewMs)
  await page.locator('[data-search]').fill('')
  await page.waitForTimeout(80)
  r.filter = median(await interactions(page, 'filter'))
  await page.locator('[data-tool=sort]').tap()
  await page.locator('[data-sort="Название: А → Я"]').tap()
  await page.waitForTimeout(80)
  r.sortNameViewMs = await page.evaluate(() => window.__spike.lastViewMs)
  r.sort = median(await interactions(page, 'sort'))
  return r
}

async function runOnce(origin, name, profile, rows) {
  const browser = await profile.type.launch(profile.launch)
  const context = await browser.newContext(profile.context)
  const page = await context.newPage()
  const cdp = profile.type === chromium ? await context.newCDPSession(page) : null
  if (cdp) {
    await cdp.send('Performance.enable')
    if (profile.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle })
  }
  const result = { profile: name, rows, browser: `${profile.type.name()} ${browser.version()}` }
  try {
    await page.goto(`${origin}/?rows=${rows}&seed=1`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__spike?.ready === true, null, { timeout: 120_000 })
    Object.assign(
      result,
      await page.evaluate(() => {
        const m = window.__spike.marks
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null
        return {
          dataMs: m['data:end'] - m['data:start'],
          renderToCommitMs: m['table:committed'] - m['render:start'],
          renderToPaintMs: m['table:painted'] - m['render:start'],
          pageToTableMs: m['table:painted'],
          fcpMs: fcp,
          domElements: document.getElementsByTagName('*').length,
          renderedRows: window.__spike.rendered,
        }
      }),
    )
    await page.waitForTimeout(500)
    result.idle = await metrics(cdp)
    if (rows === 0) return result
    result.scroll = await framesDuring(page, () => scroll(page, cdp, profile, SCROLL))
    // The same scroll while someone else changes 10 cells a second among the rows on screen.
    await page.evaluate(() => {
      window.__remote = setInterval(() => window.__spike.remoteEdit(1), 100)
    })
    result.scrollRemote = await framesDuring(page, () => scroll(page, cdp, profile, [[3000, 1500]]))
    await page.evaluate(() => clearInterval(window.__remote))
    result.jumps = await jumps(page)
    await page.evaluate(() => {
      const el = document.querySelector('[data-grid], [data-cards]')
      el.scrollTop = 0
    })
    await page.waitForTimeout(200)
    result.interactions = (await page.locator('[data-grid]').count()) > 0 ? await gridScenarios(page) : await cardScenarios(page)
    result.totalsMs = median(
      await page.evaluate(() => Array.from({ length: 5 }, () => window.__spike.computeTotals().computedMs)),
    )
    if (name === 'desktop') {
      await page.locator('[data-tool=download]').click()
      await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.locator('[data-download=xlsx]').click()])
      result.xlsxMs = await page.evaluate(() => window.__spike.lastXlsxMs)
    }
    const events = await page.evaluate(() => window.__spike.events)
    result.eventTiming = events.length
      ? {
          count: events.length,
          maxMs: Math.max(...events.map((e) => e.duration)),
          p75Ms: pct(events.map((e) => e.duration), 75),
          top: [...events].sort((a, b) => b.duration - a.duration).slice(0, 5),
        }
      : null
    result.afterInteractions = await metrics(cdp)
  } catch (error) {
    result.error = String(error?.message ?? error).split('\n')[0]
  } finally {
    await browser.close()
  }
  return result
}

function versionOf(pkg) {
  // Direct dependencies are linked at the top; pnpm keeps the others under .pnpm/node_modules.
  for (const dir of [join(root, 'node_modules'), join(root, 'node_modules', '.pnpm', 'node_modules')]) {
    try {
      return JSON.parse(readFileSync(join(dir, pkg, 'package.json'), 'utf8')).version
    } catch {}
  }
  return null
}

const meta = {
  startedAt: new Date().toISOString(),
  smoke,
  iterations,
  rows: rowsList,
  profiles: profileNames.map((p) => `${p}: ${PROFILES[p].label}`),
  machine: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
  node: process.version,
  uptimeBefore: uptime(),
  packages: Object.fromEntries(
    ['react', 'react-dom', '@mui/material', '@mui/system', '@emotion/react', '@emotion/styled', '@tanstack/react-table', '@tanstack/table-core', '@tanstack/react-store', '@tanstack/react-virtual', '@tanstack/virtual-core', 'decimal.js', 'write-excel-file', 'fflate', 'vite', 'rolldown', 'playwright-core'].map((p) => [p, versionOf(p)]),
  ),
}

console.log(`Building… (${meta.uptimeBefore})`)
const bundle = await buildSpike({ quiet: true })
const server = await serve()
const runs = []
try {
  for (const name of profileNames) {
    const profile = PROFILES[name]
    for (let i = 0; i < Math.max(1, Math.ceil(iterations / 2)); i++) {
      const r = await runOnce(server.origin, name, profile, 0)
      r.iteration = i
      runs.push(r)
      console.log(`${name} baseline #${i + 1}: heap ${r.idle?.heapUsedMB ?? '—'} MB${r.error ? ` ERROR ${r.error}` : ''}`)
    }
    for (const rows of rowsList) {
      for (let i = 0; i < iterations; i++) {
        const r = await runOnce(server.origin, name, profile, rows)
        r.iteration = i
        runs.push(r)
        console.log(
          `${name} ${rows} #${i + 1}: render ${round(r.renderToPaintMs)} ms, scroll p95 ${r.scroll?.p95} ms, dropped ${r.scroll?.droppedPct}%, heap ${r.idle?.heapUsedMB ?? '—'} MB${r.error ? ` ERROR ${r.error}` : ''}`,
        )
      }
    }
  }
} finally {
  await server.close()
}
meta.uptimeAfter = uptime()
meta.finishedAt = new Date().toISOString()

const summary = []
for (const name of profileNames) {
  const base = runs.filter((r) => r.profile === name && r.rows === 0 && !r.error)
  const baseHeap = median(base.map((r) => r.idle?.heapUsedMB))
  for (const rows of rowsList) {
    const rs = runs.filter((r) => r.profile === name && r.rows === rows && !r.error)
    const m = (f) => round(median(rs.map(f)))
    summary.push({
      profile: name,
      rows,
      runs: rs.length,
      renderToPaintMs: m((r) => r.renderToPaintMs),
      pageToTableMs: m((r) => r.pageToTableMs),
      scrollP95: m((r) => r.scroll?.p95),
      scrollMax: m((r) => r.scroll?.max),
      droppedPct: m((r) => r.scroll?.droppedPct),
      longTaskMs: m((r) => r.scroll?.longTaskMs),
      travelledPx: m((r) => r.scroll?.travelledPx),
      jumpP95: m((r) => r.jumps?.p95),
      jumpMax: m((r) => r.jumps?.max),
      remoteP95: m((r) => r.scrollRemote?.p95),
      remoteDroppedPct: m((r) => r.scrollRemote?.droppedPct),
      heapMB: m((r) => r.idle?.heapUsedMB),
      heapOverBaseMB: baseHeap === null ? null : round(median(rs.map((r) => r.idle?.heapUsedMB)) - baseHeap, 2),
      heapAfterMB: m((r) => r.afterInteractions?.heapUsedMB),
      domElements: m((r) => r.domElements),
      editStart: m((r) => r.interactions?.editStart ?? r.interactions?.sheetOpen),
      editCommit: m((r) => r.interactions?.editCommit ?? r.interactions?.sheetSave),
      move: m((r) => r.interactions?.move ?? r.interactions?.toggle),
      sort: m((r) => r.interactions?.sort),
      sortNameViewMs: m((r) => r.interactions?.sortNameViewMs),
      filter: m((r) => r.interactions?.filter),
      paste300: m((r) => r.interactions?.paste300),
      totalsMs: m((r) => r.totalsMs),
      xlsxMs: m((r) => r.xlsxMs),
      eventMaxMs: m((r) => r.eventTiming?.maxMs),
    })
  }
}

writeFileSync(join(root, out), `${JSON.stringify({ meta, bundle, summary, runs }, null, 2)}\n`)

const v = (x) => (x === null || x === undefined ? '—' : String(x).replace('.', ','))
console.log(`\n${smoke ? 'ПРЕДВАРИТЕЛЬНО (smoke, одна итерация). ' : ''}Медианы по ${iterations} итерациям. ${meta.uptimeBefore} → ${meta.uptimeAfter}\n`)
console.log('| Профиль | Строк | Рендер → кадр, мс | Страница → таблица, мс | Прокрутка: кадр p95 / max, мс (пройдено, px) | Пропущено кадров, % | Долгие задачи, мс | Прыжки: кадр p95 / max, мс | Кадр p95 при чужих правках, мс | JS-куча, МБ (над пустой) | Элементов DOM |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const s of summary) {
  console.log(`| ${s.profile} | ${s.rows} | ${v(s.renderToPaintMs)} | ${v(s.pageToTableMs)} | ${v(s.scrollP95)} / ${v(s.scrollMax)} (${v(s.travelledPx)}) | ${v(s.droppedPct)} | ${v(s.longTaskMs)} | ${v(s.jumpP95)} / ${v(s.jumpMax)} | ${v(s.remoteP95)} | ${v(s.heapMB)} (${v(s.heapOverBaseMB)}) | ${v(s.domElements)} |`)
}
console.log('\n| Профиль | Строк | Открыть правку → кадр, мс | Сохранить → кадр, мс | Стрелка или переключатель → кадр, мс | Сортировка → кадр, мс (расчёт по названию) | Поиск → кадр, мс | Вставка 300×6 → кадр, мс | Итоги decimal.js, мс | Excel, мс | Event Timing max, мс |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const s of summary) {
  console.log(`| ${s.profile} | ${s.rows} | ${v(s.editStart)} | ${v(s.editCommit)} | ${v(s.move)} | ${v(s.sort)} (${v(s.sortNameViewMs)}) | ${v(s.filter)} | ${v(s.paste300)} | ${v(s.totalsMs)} | ${v(s.xlsxMs)} | ${v(s.eventMaxMs)} |`)
}
console.log('\n| Часть сборки | gzip, КиБ | brotli, КиБ |\n| --- | ---: | ---: |')
for (const [g, size] of Object.entries(bundle.groups)) {
  if (size.gzip > 0) console.log(`| ${g} | ${v(round(size.gzip / 1024))} | ${v(round(size.brotli / 1024))} |`)
}
console.log(`| новое для кабинета (tanstack + table) | ${v(round(bundle.newToCabinet.gzip / 1024))} | ${v(round(bundle.newToCabinet.brotli / 1024))} |`)
console.log(`\nresults → ${out}`)
