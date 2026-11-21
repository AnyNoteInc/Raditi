// Which sort is the slowest, and is it the first call or the comparison itself: sorts by price and
// by name in turn, the first one cold, and records the time of computeView (lastViewMs) and of
// input → paint. The grid on the laptop, the cards on a phone with the CPU 4× slower.
//
//   node probe-sort.mjs [--rows=5000,20000] [--iterations=3]   (after node build.mjs)
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { serve } from './serve.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const rowsList = (flag('rows') ?? '5000,20000').split(',').map(Number)
const iterations = Number(flag('iterations') ?? 3)
const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim()
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b)
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const r1 = (x) => Math.round(x * 10) / 10

const PROFILES = {
  desktop: { context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ru-RU' }, throttle: 1 },
  phone: {
    context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ru-RU' },
    throttle: 4,
  },
}
// Laptop: a header click cycles ascending → descending → off.
const GRID_STEPS = ['price', 'name', 'price', 'name']
// Phone: the «Сортировка» menu.
const CARD_STEPS = ['Цена: сначала дешёвые', 'Название: А → Я', 'Цена: сначала дорогие', 'Название: Я → А', 'Цена: сначала дешёвые']

async function once(origin, name, rows) {
  const profile = PROFILES[name]
  const browser = await chromium.launch({ channel: 'chromium' })
  const context = await browser.newContext(profile.context)
  const page = await context.newPage()
  if (profile.throttle > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle })
  }
  await page.goto(`${origin}/?rows=${rows}&seed=1`)
  await page.waitForFunction(() => window.__spike?.ready === true, null, { timeout: 120_000 })
  await page.waitForTimeout(500)
  const out = []
  const sorts = () => page.evaluate(() => window.__spike.interactions.filter((i) => i.name === 'sort').length)
  let seen = 0
  const read = async (label) => {
    await page.waitForFunction((n) => window.__spike.interactions.filter((i) => i.name === 'sort').length > n, seen)
    const r = await page.evaluate(() => ({
      view: window.__spike.lastViewMs,
      paint: window.__spike.interactions.filter((i) => i.name === 'sort').at(-1)?.ms,
    }))
    out.push({ label, ...r })
  }
  const settle = async () => {
    await page.waitForTimeout(150)
    seen = await sorts()
  }
  if (name === 'desktop') {
    const header = (id) => page.locator(`[role=columnheader][data-col="${id}"]`)
    for (const [k, id] of GRID_STEPS.entries()) {
      await settle()
      await header(id).click()
      await read(`${id}${k >= 2 ? ' (again)' : ''}`)
      await header(id).click()
      await header(id).click()
    }
  } else {
    for (const [k, label] of CARD_STEPS.entries()) {
      await settle()
      await page.locator('[data-tool=sort]').tap()
      await page.locator(`[data-sort="${label}"]`).tap()
      await read(`${label}${k >= 2 ? ` (#${k + 1})` : ''}`)
    }
  }
  await browser.close()
  return out
}

const server = await serve()
console.log(uptime())
try {
  for (const name of Object.keys(PROFILES)) {
    for (const rows of rowsList) {
      const all = []
      for (let i = 0; i < iterations; i++) all.push(await once(server.origin, name, rows))
      console.log(`\n${name} ${rows} (${iterations} runs, median: count of computeView / input → paint, ms)`)
      for (const [k, step] of all[0].entries()) {
        const views = all.map((o) => o[k].view)
        const paints = all.map((o) => o[k].paint)
        console.log(`  ${step.label.padEnd(30)} ${String(r1(median(views))).padStart(7)} / ${String(r1(median(paints))).padStart(7)}   [${views.map(r1).join(', ')}]`)
      }
    }
  }
} finally {
  await server.close()
}
console.log(`\n${uptime()}`)
