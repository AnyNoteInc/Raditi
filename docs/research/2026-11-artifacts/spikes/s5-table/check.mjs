// Functional checks of the spike: Chromium on a laptop, Chromium as a phone with touch, WebKit
// as an iPhone. Writes check-results.json and prints a table. Run after `node build.mjs`.
//   node check.mjs [--only chromium-desktop,chromium-phone,webkit-iphone] [--shots]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { chromium, devices, firefox, webkit } from 'playwright-core'
import { readSheet } from 'read-excel-file/node'
import { badRow, excelRu3x3, excelRu3x3Expected, sheetsEn2x6, sheetsEn2x6Expected, sheetsRows } from './fixtures/paste.mjs'
import { serve } from './serve.mjs'

const root = import.meta.dirname
const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const shots = args.includes('--shots')
const outFile = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'check-results.json'
const shotDir = join(root, 'shots')
if (shots) mkdirSync(shotDir, { recursive: true })

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36'

export const PROFILES = {
  'chromium-desktop': {
    type: chromium,
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ru-RU', acceptDownloads: true },
    phone: false,
  },
  'chromium-phone': {
    type: chromium,
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: PHONE_UA,
      locale: 'ru-RU',
      acceptDownloads: true,
    },
    phone: true,
  },
  'webkit-iphone': {
    type: webkit,
    context: { ...devices['iPhone 13'], locale: 'ru-RU', acceptDownloads: true },
    phone: true,
  },
  // Not asked for by the brief: Safari and Firefox on a laptop, the same desktop checks.
  'webkit-desktop': {
    type: webkit,
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ru-RU', acceptDownloads: true },
    phone: false,
  },
  'firefox-desktop': {
    type: firefox,
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ru-RU', acceptDownloads: true },
    phone: false,
  },
}

const results = []
let current = ''

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ profile: current, name, ok: true, detail: detail ?? '', ms: Date.now() - t0 })
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ profile: current, name, ok: false, detail: String(error?.message ?? error).split('\n')[0], ms: Date.now() - t0 })
    console.log(`  FAIL ${name} — ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function open(page, origin, query = 'rows=300') {
  await page.goto(`${origin}/?${query}`)
  await page.waitForFunction(() => window.__spike?.ready === true, null, { timeout: 30_000 })
}

const until = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, arg, { timeout, polling: 'raf' })

const view = (page) => page.evaluate(() => window.__spike.view)
const rowAt = (page, index) => page.evaluate((i) => window.__spike.store.get(window.__spike.view[i]), index)
const focused = (page) => page.evaluate(() => window.__spike.grid.focused())
const focusCell = (page, index, col) => page.evaluate(([i, c]) => window.__spike.grid.focus(i, c), [index, col])
const select = (page, r0, c0, r1, c1) => page.evaluate(([a, b, c, d]) => window.__spike.grid.select(a, b, c, d), [r0, c0, r1, c1])

/**
 * A paste: a synthetic ClipboardEvent with the text, or, in Firefox (it drops `clipboardData` of
 * an untrusted event), the real clipboard and Ctrl+V.
 */
async function pasteText(page, text) {
  if (page.context().browser()?.browserType().name() === 'firefox') {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text)
    await page.keyboard.press('ControlOrMeta+V')
    return
  }
  await page.evaluate((t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

/** A key of a Russian layout, as a trusted event (Chromium only). */
async function russianKey(cdp, key, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, unmodifiedText: key.toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}

async function cellText(page, index, col) {
  return page.locator(`[data-grid] [role=row][aria-rowindex="${index + 2}"] [data-col="${col}"]`).innerText()
}

async function desktop(page, origin, profile) {
  const cdp = profile.type === chromium ? await page.context().newCDPSession(page) : null
  await open(page, origin)
  const grid = page.locator('[data-grid]')

  await check('grid roles and counts', async () => {
    assert((await grid.getAttribute('role')) === 'grid', 'no role=grid')
    assert((await grid.getAttribute('aria-rowcount')) === '301', `aria-rowcount ${await grid.getAttribute('aria-rowcount')}`)
    assert((await grid.getAttribute('aria-colcount')) === '7', 'aria-colcount')
    const rendered = await page.locator('[data-grid] [role=row]').count()
    assert(rendered < 60, `${rendered} rows in the DOM`)
    const headers = await page.locator('[role=columnheader]').allInnerTexts()
    return `${rendered - 1} rows in the DOM of 300; headers: ${headers.join(' | ')}`
  })

  await check('sticky header and aria-rowindex after scroll', async () => {
    await page.evaluate(() => {
      window.__spike.grid.scroller().scrollTop = 4000
    })
    await page.waitForTimeout(150)
    const r = await page.evaluate(() => {
      const scroller = window.__spike.grid.scroller()
      const header = scroller.querySelector('.header').getBoundingClientRect()
      const rows = [...scroller.querySelectorAll('[role=row][aria-rowindex]')].map((el) => Number(el.getAttribute('aria-rowindex'))).filter((i) => i > 1)
      return { top: header.top - scroller.getBoundingClientRect().top, min: Math.min(...rows), max: Math.max(...rows) }
    })
    assert(Math.abs(r.top) <= 1, `header moved by ${r.top}px`)
    assert(r.min >= 90 && r.min <= 102, `first rendered aria-rowindex ${r.min}`)
    await page.evaluate(() => {
      window.__spike.grid.scroller().scrollTop = 0
    })
    return `rendered aria-rowindex ${r.min}…${r.max} at scrollTop 4000`
  })

  await check('click selects a cell, aria-activedescendant follows', async () => {
    await page.locator('[data-grid] [role=row][aria-rowindex="2"] [data-col="name"]').click()
    const f = await focused(page)
    const active = await grid.getAttribute('aria-activedescendant')
    assert(f?.index === 0 && f.colId === 'name', `focused ${JSON.stringify(f)}`)
    assert(active === `c-${f.rowId}-name`, `activedescendant ${active}`)
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-grid')), 'grid is not focused')
  })

  await check('arrows, Tab, Home, End, Ctrl+Home, Ctrl+End, PageDown', async () => {
    const trail = []
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight']) await page.keyboard.press(k)
    trail.push(await focused(page))
    await page.keyboard.press('Tab')
    trail.push(await focused(page))
    await page.keyboard.press('Shift+Tab')
    trail.push(await focused(page))
    await page.keyboard.press('End')
    trail.push(await focused(page))
    await page.keyboard.press('Home')
    trail.push(await focused(page))
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(100)
    trail.push(await focused(page))
    const lastRendered = await page.locator('[data-grid] [role=row][aria-rowindex="301"]').count()
    await page.keyboard.press('Control+Home')
    trail.push(await focused(page))
    await page.keyboard.press('PageDown')
    trail.push(await focused(page))
    const got = trail.map((f) => `${f.index}:${f.colId}`)
    const want = ['3:category', '3:unit', '3:category', '3:note', '3:name', '299:name', '0:name']
    assert(eq(got.slice(0, 7), want), `got ${got.join(' ')}`)
    assert(lastRendered === 1, 'row 300 not rendered after Ctrl+End')
    assert(trail[7].index >= 15 && trail[7].index <= 25, `PageDown to ${trail[7].index}`)
    return got.join(' → ')
  })

  await check('Enter edits a price, Enter commits and moves down; no-break thousands', async () => {
    await focusCell(page, 1, 'price')
    await page.keyboard.press('Enter')
    await until(page, () => document.activeElement?.tagName === 'INPUT')
    const initial = await page.evaluate(() => document.activeElement.value)
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('1 234,5')
    await page.keyboard.press('Enter')
    await until(page, () => window.__spike.grid.editing() === null)
    const row = await rowAt(page, 1)
    const text = await cellText(page, 1, 'price')
    const f = await focused(page)
    assert(row.price === '1234.50', `price ${row.price}`)
    assert(text === '1 234,50', `shown ${JSON.stringify(text)}`)
    assert(f.index === 2 && f.colId === 'price', `focus ${f.index}:${f.colId}`)
    return `editor opened with «${initial}», stored ${row.price}, shown ${JSON.stringify(text)}`
  })

  await check('F2 then Esc cancels, focus back on the grid', async () => {
    const before = (await rowAt(page, 2)).name
    await focusCell(page, 2, 'name')
    await page.keyboard.press('F2')
    await until(page, () => document.activeElement?.tagName === 'INPUT')
    await page.keyboard.type('XYZ')
    await page.keyboard.press('Escape')
    await until(page, () => window.__spike.grid.editing() === null)
    assert((await rowAt(page, 2)).name === before, 'value changed')
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-grid')), 'focus not on grid')
  })

  await check('typing starts editing (Latin key)', async () => {
    await focusCell(page, 3, 'unit')
    await page.keyboard.press('g')
    await page.keyboard.type(' 250')
    await page.keyboard.press('Tab')
    await until(page, () => window.__spike.grid.editing() === null)
    const row = await rowAt(page, 3)
    const f = await focused(page)
    assert(row.unit === 'g 250', `unit ${row.unit}`)
    assert(f.colId === 'price', `focus ${f.colId}`)
  })

  if (cdp) {
    await check('typing starts editing (Russian layout, trusted keydown)', async () => {
      await focusCell(page, 4, 'name')
      await russianKey(cdp, 'П', 'KeyG', 71)
      await page.keyboard.type('ирожок')
      await page.keyboard.press('Tab')
      await until(page, () => window.__spike.grid.editing() === null)
      const row = await rowAt(page, 4)
      assert(row.name === 'Пирожок', `name ${row.name}`)
    })
  }

  await check('double click edits', async () => {
    await page.locator('[data-grid] [role=row][aria-rowindex="7"] [data-col="unit"]').dblclick()
    await until(page, () => document.activeElement?.tagName === 'INPUT')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('упак.')
    await page.keyboard.press('Enter')
    await until(page, () => window.__spike.grid.editing() === null)
    assert((await rowAt(page, 5)).unit === 'упак.', 'unit not saved')
  })

  await check('typed value: arrows commit and move (Excel «enter» mode)', async () => {
    await focusCell(page, 6, 'price')
    await page.keyboard.press('5')
    await page.keyboard.type('00')
    await page.keyboard.press('ArrowDown')
    await until(page, () => window.__spike.grid.editing() === null)
    const f = await focused(page)
    assert((await rowAt(page, 6)).price === '500.00', 'price not 500.00')
    assert(f.index === 7 && f.colId === 'price', `focus ${f.index}`)
  })

  await check('a word in a price is refused with a reason, Esc keeps the old value', async () => {
    const before = (await rowAt(page, 8)).price
    await focusCell(page, 8, 'price')
    await page.keyboard.press('a')
    await page.keyboard.type('bc')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(80)
    const alert = await page.locator('[data-grid] [role=alert]').innerText()
    assert(await page.evaluate(() => window.__spike.grid.editing() !== null), 'editor closed')
    await page.keyboard.press('Escape')
    await until(page, () => window.__spike.grid.editing() === null)
    assert((await rowAt(page, 8)).price === before, 'price changed')
    return `«${alert}»`
  })

  await check('select column: Enter opens the list, arrow and Enter choose', async () => {
    const target = await page.evaluate(() => window.__spike.view.findIndex((id, i) => i > 8 && window.__spike.store.get(id).category !== 'Салаты'))
    const before = (await rowAt(page, target)).category
    await focusCell(page, target, 'category')
    await page.keyboard.press('Enter')
    const t0 = Date.now()
    await until(page, () => document.activeElement?.getAttribute('role') === 'option')
    const opened = Date.now() - t0
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await until(page, () => window.__spike.grid.editing() === null)
    const after = (await rowAt(page, target)).category
    const options = ['', 'Хлеб', 'Пироги', 'Торты', 'Выпечка', 'Десерты', 'Напитки', 'Сэндвичи', 'Салаты']
    const want = options[Math.min(options.length - 1, options.indexOf(before) + 1)]
    assert(after === want, `${before} → ${after}, expected ${want}`)
    await page.waitForTimeout(50)
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-grid')), 'focus not back on the grid')
    return `${before} → ${after}; the list took the focus ${opened} ms after Enter`
  })

  if (cdp) {
    await check('select column: a typed Russian letter picks the option', async () => {
      await focusCell(page, 10, 'category')
      await russianKey(cdp, 'Т', 'KeyN', 78)
      await until(page, () => document.activeElement?.getAttribute('role') === 'option')
      await page.keyboard.press('Enter')
      await until(page, () => window.__spike.grid.editing() === null)
      const after = (await rowAt(page, 10)).category
      assert(after === 'Торты', `got ${after}`)
    })
  }

  await check('checkbox: Space and click toggle', async () => {
    const before = (await rowAt(page, 11)).inStock
    await focusCell(page, 11, 'inStock')
    await page.keyboard.press('Space')
    await page.waitForTimeout(50)
    const mid = (await rowAt(page, 11)).inStock
    await page.locator('[data-grid] [role=row][aria-rowindex="13"] [data-col="inStock"] input').click()
    await page.waitForTimeout(50)
    const after = (await rowAt(page, 11)).inStock
    assert(mid === !before && after === before, `${before} → ${mid} → ${after}`)
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-grid')), 'click took the focus from the grid')
  })

  await check('Delete clears a range in one batch', async () => {
    await select(page, 12, 'note', 14, 'note')
    const sentBefore = await page.evaluate(() => window.__spike.store.sent.length)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(50)
    const notes = await page.evaluate(() => [12, 13, 14].map((i) => window.__spike.store.get(window.__spike.view[i]).note))
    const sent = await page.evaluate((n) => window.__spike.store.sent.slice(n), sentBefore)
    assert(notes.every((n) => n === ''), `notes ${JSON.stringify(notes)}`)
    assert(sent.length <= 1, `${sent.length} batches`)
    return sent.length === 0 ? 'nothing to clear' : `${sent[0].ops} operations`
  })

  await check('sort by price: ascending, descending, off (aria-sort)', async () => {
    const header = page.locator('[role=columnheader][data-col="price"]')
    const original = await view(page)
    await header.click()
    const asc = await page.evaluate(() => window.__spike.view.map((id) => window.__spike.store.get(id).price))
    const ariaAsc = await header.getAttribute('aria-sort')
    await header.click()
    const desc = await page.evaluate(() => window.__spike.view.map((id) => window.__spike.store.get(id).price))
    const ariaDesc = await header.getAttribute('aria-sort')
    await header.click()
    const back = await view(page)
    const num = (p) => (p === '' ? Infinity : Number(p))
    const priced = (list) => list.filter((p) => p !== '')
    assert(ariaAsc === 'ascending' && ariaDesc === 'descending', `aria ${ariaAsc} ${ariaDesc}`)
    assert(priced(asc).every((p, i, a) => i === 0 || num(a[i - 1]) <= num(p)), 'ascending broken')
    assert(priced(desc).every((p, i, a) => i === 0 || num(a[i - 1]) >= num(p)), 'descending broken')
    assert(eq(back, original), 'third click did not restore the order')
  })

  await check('sort by name: Russian collation, numbers inside names', async () => {
    const header = page.locator('[role=columnheader][data-col="name"]')
    await header.click()
    const bad = await page.evaluate(() => {
      const c = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })
      const names = window.__spike.view.map((id) => window.__spike.store.get(id).name)
      return names.findIndex((n, i) => i > 0 && c.compare(names[i - 1], n) > 0)
    })
    const sample = await page.evaluate(() => window.__spike.view.slice(0, 4).map((id) => window.__spike.store.get(id).name))
    await header.click()
    await header.click()
    assert(bad === -1, `out of order at ${bad}`)
    return sample.join(', ')
  })

  await check('edits do not move rows of a sorted view; «Обновить» re-sorts', async () => {
    await page.locator('[role=columnheader][data-col="price"]').click()
    const firstId = (await view(page))[0]
    await focusCell(page, 0, 'price')
    await page.keyboard.press('9')
    await page.keyboard.type('9999')
    await page.keyboard.press('Enter')
    await until(page, () => window.__spike.grid.editing() === null)
    const stay = (await view(page))[0] === firstId
    const chip = await page.locator('[data-stale]').isVisible()
    await page.locator('[data-stale]').click()
    const moved = await page.evaluate((id) => window.__spike.view.indexOf(id), firstId)
    await page.locator('[role=columnheader][data-col="price"]').click()
    await page.locator('[role=columnheader][data-col="price"]').click()
    assert(stay, 'row moved right after the edit')
    assert(chip, 'no «Порядок не обновлён» chip')
    assert(moved > 250, `after «Обновить» the row is at ${moved}`)
    return `row stayed at 0, after «Обновить» it went to ${moved}`
  })

  await check('search filters by name, category and note (ё = е)', async () => {
    const search = page.locator('[data-search]')
    await search.fill('пирог')
    await page.waitForTimeout(50)
    const r = await page.evaluate(() => {
      const fold = (t) => t.toLowerCase().replaceAll('ё', 'е')
      const rows = window.__spike.view.map((id) => window.__spike.store.get(id))
      return { n: rows.length, ok: rows.every((x) => fold(`${x.name} ${x.category} ${x.unit} ${x.note}`).includes('пирог')) }
    })
    const rowcount = await grid.getAttribute('aria-rowcount')
    await search.fill('ёлочная')
    const yo = await page.evaluate(() => window.__spike.view.length)
    await search.fill('')
    await page.waitForTimeout(50)
    const all = await page.evaluate(() => window.__spike.view.length)
    assert(r.ok && r.n > 0, `rows ${r.n}`)
    assert(rowcount === String(r.n + 1), `aria-rowcount ${rowcount}`)
    assert(all === 300, `after clearing ${all}`)
    return `«пирог»: ${r.n} rows; «ёлочная»: ${yo}`
  })

  await check('filter menu: category and stock', async () => {
    await page.locator('[data-tool=filter]').click()
    await page.locator('[data-category="Торты"]').click()
    const cats = await page.evaluate(() => [...new Set(window.__spike.view.map((id) => window.__spike.store.get(id).category))])
    await page.locator('[data-stock=no]').click()
    const stock = await page.evaluate(() => window.__spike.view.every((id) => !window.__spike.store.get(id).inStock))
    const n = await page.evaluate(() => window.__spike.view.length)
    await page.getByText('Сбросить фильтр').click()
    // The menu gives the focus back to «Фильтр» a moment after it closes.
    await page.locator('[role=menu]').waitFor({ state: 'detached' })
    await page.waitForTimeout(100)
    assert(eq(cats, ['Торты']), `categories ${cats}`)
    assert(stock, 'stock filter')
    return `«Торты» without stock: ${n} rows`
  })

  await check('paste from Excel (ru): CRLF, no-break thousands, ₽, ИСТИНА/ЛОЖЬ', async () => {
    await focusCell(page, 20, 'unit')
    const sentBefore = await page.evaluate(() => window.__spike.store.sent.length)
    await pasteText(page, excelRu3x3)
    await page.waitForTimeout(80)
    const got = await page.evaluate(() => [20, 21, 22].map((i) => {
      const r = window.__spike.store.get(window.__spike.view[i])
      return { unit: r.unit, price: r.price, inStock: r.inStock }
    }))
    const sent = await page.evaluate((n) => window.__spike.store.sent.slice(n), sentBefore)
    const cols = await page.evaluate(() => window.__spike.grid.selectedColumns())
    assert(eq(got, excelRu3x3Expected), `got ${JSON.stringify(got)}`)
    assert(sent.length === 1 && sent[0].ops === 3, `batches ${JSON.stringify(sent)}`)
    assert(eq(cols, ['unit', 'price', 'inStock']), `selected ${cols}`)
    return `1 batch, 3 operations, ${sent[0].bytes} bytes; pasted range selected`
  })

  await check('paste from Google Sheets (en): LF, quoted line break, «₽95.50», lower-case category', async () => {
    await focusCell(page, 25, 'name')
    await pasteText(page, sheetsEn2x6)
    await page.waitForTimeout(80)
    const got = await page.evaluate(() => [25, 26].map((i) => {
      const { id, ...rest } = window.__spike.store.get(window.__spike.view[i])
      return rest
    }))
    assert(eq(got, sheetsEn2x6Expected), `got ${JSON.stringify(got)}`)
  })

  await check('paste of values that do not fit: cells kept, reason shown', async () => {
    const before = await rowAt(page, 30)
    await focusCell(page, 30, 'price')
    await pasteText(page, badRow)
    await page.waitForTimeout(80)
    const after = await rowAt(page, 30)
    const message = await page.locator('[data-message]').innerText()
    assert(after.price === before.price && after.inStock === before.inStock, 'refused cells changed')
    assert(after.note === 'может быть', `note ${after.note}`)
    assert(message.includes('не подошли 2'), `message «${message}»`)
    return `«${message}»`
  })

  await check('one value pasted into a range fills it', async () => {
    await select(page, 40, 'price', 44, 'price')
    await pasteText(page, '99')
    await page.waitForTimeout(80)
    const prices = await page.evaluate(() => [40, 41, 42, 43, 44].map((i) => window.__spike.store.get(window.__spike.view[i]).price))
    assert(prices.every((p) => p === '99.00'), `prices ${prices}`)
  })

  await check('paste of 300 rows × 6 columns from Google Sheets', async () => {
    const { text, rows } = sheetsRows(300)
    await focusCell(page, 0, 'name')
    const sentBefore = await page.evaluate(() => window.__spike.store.sent.length)
    const t0 = Date.now()
    await pasteText(page, text)
    await page.waitForTimeout(100)
    const ms = await page.evaluate(() => window.__spike.interactions.filter((i) => i.name === 'paste').at(-1)?.ms)
    const got = await page.evaluate(() => window.__spike.view.slice(0, 300).map((id) => window.__spike.store.get(id)))
    const sent = await page.evaluate((n) => window.__spike.store.sent.slice(n), sentBefore)
    const mismatch = got.findIndex((g, i) => {
      const w = rows[i]
      const note = i % 50 === 0 ? `${w.note}\nвторая строка` : w.note
      return g.name !== w.name || g.category !== w.category || g.unit !== w.unit || g.price !== w.price || g.inStock !== w.inStock || g.note !== note
    })
    assert(mismatch === -1, `row ${mismatch} differs: ${JSON.stringify(got[mismatch])}`)
    assert(sent.every((b) => b.ops <= 50 && b.bytes <= 90 * 1024), 'a batch over the limits')
    const maxBytes = Math.max(...sent.map((b) => b.bytes))
    return `${sent.length} batches (${sent.map((b) => b.ops).join('+')} operations, largest ${maxBytes} bytes), paste → paint ${ms?.toFixed(1)} ms, wall ${Date.now() - t0} ms`
  })

  await check('paste past the end adds rows; Ctrl+Z undoes it', async () => {
    const { text } = sheetsRows(10, 11)
    const before = await page.evaluate(() => window.__spike.view.slice(295).map((id) => ({ ...window.__spike.store.get(id) })))
    await focusCell(page, 295, 'name')
    const sentBefore = await page.evaluate(() => window.__spike.store.sent.length)
    await pasteText(page, text)
    await page.waitForTimeout(100)
    const count = await page.evaluate(() => window.__spike.view.length)
    const rowcount = await grid.getAttribute('aria-rowcount')
    const sent = await page.evaluate((n) => window.__spike.store.sent.slice(n), sentBefore)
    await page.keyboard.press('ControlOrMeta+Z')
    await page.waitForTimeout(100)
    const back = await page.evaluate(() => window.__spike.view.length)
    const restored = await page.evaluate(() => window.__spike.view.slice(295).map((id) => ({ ...window.__spike.store.get(id) })))
    assert(count === 305 && rowcount === '306', `rows ${count}, aria ${rowcount}`)
    assert(sent[0]?.kinds.insert === 5 && sent[0]?.kinds.cells === 5, `kinds ${JSON.stringify(sent[0]?.kinds)}`)
    assert(back === 300 && eq(restored, before), `after undo ${back} rows`)
    return `5 changed + 5 new rows in one batch; undo: back to 300`
  })

  if (profile.type !== webkit) {
    await check('real clipboard: Ctrl+V on a selected cell (not in an editor)', async () => {
      if (profile.type === chromium) await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
      await page.evaluate((t) => navigator.clipboard.writeText(t), excelRu3x3)
      await focusCell(page, 50, 'unit')
      await page.keyboard.press('ControlOrMeta+V')
      await page.waitForTimeout(100)
      const got = await page.evaluate(() => [50, 51, 52].map((i) => {
        const r = window.__spike.store.get(window.__spike.view[i])
        return { unit: r.unit, price: r.price, inStock: r.inStock }
      }))
      assert(eq(got, excelRu3x3Expected), `got ${JSON.stringify(got)}`)
    })

    await check('real clipboard: Ctrl+C of a range gives TSV', async () => {
      await select(page, 50, 'unit', 51, 'price')
      await page.keyboard.press('ControlOrMeta+C')
      const text = await page.evaluate(() => navigator.clipboard.readText())
      assert(text === 'шт\t1234,56\r\n100 г\t89,90', `clipboard ${JSON.stringify(text)}`)
      return JSON.stringify(text)
    })
  }

  await check('«Строка» adds a row after the selected one and opens its name', async () => {
    await focusCell(page, 60, 'price')
    await page.locator('[data-add-row]').click()
    await until(page, () => window.__spike.grid.editing()?.colId === 'name')
    await page.keyboard.type('Новая позиция')
    await page.keyboard.press('Enter')
    await until(page, () => window.__spike.grid.editing() === null)
    const r = await rowAt(page, 61)
    assert(r.name === 'Новая позиция', `row 61 ${JSON.stringify(r)}`)
    // keep 300 rows for what follows
    await page.keyboard.press('ControlOrMeta+Z')
    await page.keyboard.press('ControlOrMeta+Z')
    await page.waitForTimeout(80)
    const n = await page.evaluate(() => window.__spike.view.length)
    return `row inserted at 61; after two undos ${n} rows`
  })

  await check('CSV: BOM, «;», prices «1234,50», formulas neutralised', async () => {
    await focusCell(page, 70, 'note')
    await page.keyboard.press('=')
    await page.keyboard.type('HYPERLINK("http://example.test";"x")')
    await page.keyboard.press('Enter')
    await until(page, () => window.__spike.grid.editing() === null)
    await page.locator('[data-tool=download]').click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-download=csv]').click()])
    const path = await download.path()
    const csv = readFileSync(path, 'utf8')
    const lines = csv.split('\r\n')
    assert(csv.startsWith('﻿'), 'no BOM')
    assert(lines[0] === '﻿Название;Категория;Ед.;Цена, ₽;В наличии;Примечание', `header ${lines[0]}`)
    assert(csv.includes(`"'=HYPERLINK(""http://example.test"";""x"")"`), 'formula not neutralised')
    assert(/;\d+,\d{2};|;\d+;/.test(lines[1] ?? ''), `line 1 ${lines[1]}`)
    return `${lines.length - 2} rows, ${csv.length} chars, file «${download.suggestedFilename()}»`
  })

  await check('Excel: 301 rows, numbers stay numbers, a formula-like note stays text; code loads on demand', async () => {
    const before = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/xlsx-')).length)
    await page.locator('[data-tool=download]').click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-download=xlsx]').click()])
    const path = await download.path()
    const rows = await readSheet(path)
    const after = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/xlsx-')).length)
    const ms = await page.evaluate(() => window.__spike.lastXlsxMs)
    const formulaRow = rows.find((r) => String(r[5] ?? '').startsWith('=HYPERLINK'))
    assert(rows.length === 301, `${rows.length} rows`)
    assert(typeof rows[1][3] === 'number', `price cell ${typeof rows[1][3]}`)
    assert(formulaRow && typeof formulaRow[5] === 'string', 'formula note not a string')
    assert(before === 0 && after === 1, `xlsx chunk loaded ${before} → ${after}`)
    return `${rows.length} rows, ${ms?.toFixed(0)} ms to build, file «${download.suggestedFilename()}»`
  })

  await check('Tab on the last cell leaves the grid', async () => {
    await focusCell(page, 299, 'note')
    await page.keyboard.press('Tab')
    const inGrid = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-grid]')))
    assert(!inGrid, 'focus stayed in the grid')
  })

  await check('axe-core on the grid', async () => {
    const result = await new AxeBuilder({ page }).include('[data-grid]').analyze()
    const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    const all = result.violations.map((v) => `${v.id}(${v.impact}, ${v.nodes.length})`)
    assert(serious.length === 0, all.join(', '))
    return all.length ? `minor: ${all.join(', ')}` : 'no violations'
  })

  await check('5 000 rows: counts, Ctrl+End, DOM stays small', async () => {
    await open(page, origin, 'rows=5000')
    const rowcount = await grid.getAttribute('aria-rowcount')
    await page.locator('[data-grid] [role=row][aria-rowindex="2"] [data-col="name"]').click()
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(150)
    const last = await page.locator('[data-grid] [role=row][aria-rowindex="5001"]').count()
    const rendered = await page.locator('[data-grid] [role=row]').count()
    const height = await page.evaluate(() => window.__spike.grid.scroller().scrollHeight)
    assert(rowcount === '5001', `aria-rowcount ${rowcount}`)
    assert(last === 1, 'last row not rendered')
    assert(rendered < 60, `${rendered} rows in the DOM`)
    return `${rendered - 1} rows in the DOM, scrollHeight ${height}`
  })

  await check('the table turns into cards when its box is narrower than 600 px', async () => {
    await page.setViewportSize({ width: 560, height: 900 })
    await page.waitForTimeout(150)
    const cards = await page.locator('[data-cards]').count()
    await page.setViewportSize(profile.context.viewport)
    await page.waitForTimeout(150)
    const gridBack = await page.locator('[data-grid]').count()
    assert(cards === 1 && gridBack === 1, `cards ${cards}, grid ${gridBack}`)
  })

  if (profile.type === chromium) {
    await check('Excel under a strict cabinet CSP (no blob: workers): 300 and 5 000 rows', async () => {
      const out = []
      for (const n of [300, 5000]) {
        const errors = []
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
        await open(page, origin, `rows=${n}&csp=strict`)
        await page.locator('[data-tool=download]').click()
        const started = Date.now()
        const done = page.waitForEvent('download', { timeout: 20_000 }).then(() => `downloaded in ${Date.now() - started} ms`, () => 'no download in 20 s, no message')
        await page.locator('[data-download=xlsx]').click()
        const result = await done
        const error = await page.evaluate(() => window.__spike.lastXlsxError ?? null)
        out.push(`${n}: ${result}${error ? ` (${error.slice(0, 80)})` : ''}${errors.length ? `, console: ${errors[0].slice(0, 90)}` : ''}`)
        page.removeAllListeners('console')
      }
      return out.join('; ')
    })
  }

  if (shots) {
    await open(page, origin, 'rows=300')
    await select(page, 3, 'category', 6, 'price')
    await page.screenshot({ path: join(shotDir, `${current}.png`) })
  }
}

async function phone(page, origin, profile) {
  const cdp = profile.type === chromium ? await page.context().newCDPSession(page) : null
  await open(page, origin)

  await check('cards at 390 px, no horizontal scroll, list semantics', async () => {
    const r = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-cards] [role=listitem]').length,
      grid: document.querySelectorAll('[data-grid]').length,
      scrollWidth: document.scrollingElement.scrollWidth,
      width: window.innerWidth,
      setsize: document.querySelector('[role=listitem]')?.getAttribute('aria-setsize'),
    }))
    assert(r.grid === 0, 'grid shown')
    assert(r.scrollWidth <= r.width, `page scrolls sideways: ${r.scrollWidth} > ${r.width}`)
    assert(r.cards > 0 && r.cards < 30, `${r.cards} cards in the DOM`)
    assert(r.setsize === '300', `aria-setsize ${r.setsize}`)
    return `${r.cards} cards in the DOM of 300`
  })

  await check('touch targets: card, «В наличии», toolbar ≥ 44 px', async () => {
    const r = await page.evaluate(() => {
      const box = (el) => el?.getBoundingClientRect()
      const card = box(document.querySelector('[role=listitem] .main'))
      const stock = box(document.querySelector('[role=listitem] .stock'))
      const tools = [...document.querySelectorAll('[data-tool]')].map((el) => box(el))
      const add = box(document.querySelector('[data-add-row]'))
      return { card: [card.width, card.height], stock: [stock.width, stock.height], tools: tools.map((t) => [t.width, t.height]), add: [add.width, add.height] }
    })
    const small = [r.card, r.stock, r.add, ...r.tools].filter(([w, h]) => w < 44 || h < 44)
    assert(small.length === 0, `small: ${JSON.stringify(small)}`)
    return `card ${r.card.map(Math.round).join('×')}, switch area ${r.stock.map(Math.round).join('×')}, tools ${r.tools.map((t) => t.map(Math.round).join('×')).join(', ')}`
  })

  await check('tap a card → sheet; price with a decimal keyboard; save', async () => {
    const first = (await view(page))[0]
    await page.locator('[role=listitem] .main').first().tap()
    await page.locator('[data-sheet]').waitFor()
    const input = page.locator('[data-field=price]')
    const mode = await input.getAttribute('inputmode')
    const focusedField = await page.evaluate(() => document.activeElement?.getAttribute('data-field'))
    await input.fill('1 990')
    await page.getByRole('button', { name: 'Сохранить' }).tap()
    await page.locator('[data-sheet]').waitFor({ state: 'detached' })
    const row = await page.evaluate((id) => window.__spike.store.get(id), first)
    const shown = await page.locator('[role=listitem] .price').first().innerText()
    assert(row.price === '1990.00', `price ${row.price}`)
    assert(shown === '1 990 ₽', `shown ${JSON.stringify(shown)}`)
    assert(mode === 'decimal', `inputmode ${mode}`)
    return `inputmode=${mode}, focused field: ${focusedField ?? 'none'}`
  })

  await check('sheet refuses a word in a price and stays open', async () => {
    await page.locator('[role=listitem] .main').nth(1).tap()
    await page.locator('[data-sheet]').waitFor()
    await page.locator('[data-field=price]').fill('около сотни')
    await page.getByRole('button', { name: 'Сохранить' }).tap()
    await page.waitForTimeout(100)
    const open = await page.locator('[data-sheet]').count()
    const helper = await page.locator('[data-sheet] .Mui-error').count()
    await page.getByRole('button', { name: 'Отмена' }).tap()
    await page.locator('[data-sheet]').waitFor({ state: 'detached' })
    assert(open === 1 && helper > 0, `open ${open}, errors ${helper}`)
  })

  await check('«В наличии» switches on the card without opening the sheet', async () => {
    const id = (await view(page))[2]
    const before = await page.evaluate((x) => window.__spike.store.get(x).inStock, id)
    await page.locator('[role=listitem] .stock').nth(2).tap()
    await page.waitForTimeout(100)
    const after = await page.evaluate((x) => window.__spike.store.get(x).inStock, id)
    const sheet = await page.locator('[data-sheet]').count()
    assert(after === !before && sheet === 0, `${before} → ${after}, sheet ${sheet}`)
  })

  await check('search on the phone', async () => {
    await page.locator('[data-search]').fill('торт')
    await page.waitForTimeout(80)
    const r = await page.evaluate(() => {
      const fold = (t) => t.toLowerCase().replaceAll('ё', 'е')
      const rows = window.__spike.view.map((id) => window.__spike.store.get(id))
      return { n: rows.length, ok: rows.every((x) => fold(`${x.name} ${x.category} ${x.unit} ${x.note}`).includes('торт')) }
    })
    await page.locator('[data-search]').fill('')
    assert(r.ok && r.n > 0, `rows ${r.n}`)
    return `${r.n} rows`
  })

  await check('sort menu: price ascending', async () => {
    await page.locator('[data-tool=sort]').tap()
    await page.locator('[data-sort="Цена: сначала дешёвые"]').tap()
    await page.waitForTimeout(80)
    const prices = await page.evaluate(() => window.__spike.view.map((id) => window.__spike.store.get(id).price).filter((p) => p !== '').map(Number))
    const ok = prices.every((p, i) => i === 0 || prices[i - 1] <= p)
    await page.locator('[data-tool=sort]').tap()
    await page.locator('[data-sort="Без сортировки"]').tap()
    assert(ok, 'not sorted')
  })

  await check('filter menu: category', async () => {
    await page.locator('[data-tool=filter]').tap()
    await page.locator('[data-category="Хлеб"]').tap()
    const cats = await page.evaluate(() => [...new Set(window.__spike.view.map((id) => window.__spike.store.get(id).category))])
    await page.locator('[data-category="Хлеб"]').tap()
    await page.keyboard.press('Escape')
    assert(eq(cats, ['Хлеб']), `categories ${cats}`)
  })

  await check(cdp ? 'touch scroll (synthetic gesture) renders the cards under it' : 'scroll (programmatic) renders the cards under it', async () => {
    const box = await page.locator('[data-cards]').boundingBox()
    if (cdp) {
      await cdp.send('Input.synthesizeScrollGesture', {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height * 0.7),
        yDistance: -3000,
        speed: 3000,
        gestureSourceType: 'touch',
        preventFling: true,
      })
    } else {
      await page.evaluate(() => {
        document.querySelector('[data-cards]').scrollTop = 3000
      })
    }
    await page.waitForTimeout(200)
    const r = await page.evaluate(() => {
      const scroller = document.querySelector('[data-cards]')
      const items = [...scroller.querySelectorAll('[role=listitem]')]
      const top = scroller.getBoundingClientRect().top
      const visible = items.filter((el) => {
        const b = el.getBoundingClientRect()
        return b.bottom > top && b.top < top + scroller.clientHeight
      })
      return { scrollTop: scroller.scrollTop, first: Math.min(...visible.map((el) => Number(el.getAttribute('aria-posinset')))), visible: visible.length }
    })
    const expected = Math.floor(r.scrollTop / 84)
    assert(r.scrollTop > 2000, `scrollTop ${r.scrollTop}`)
    assert(Math.abs(r.first - 1 - expected) <= 1, `first visible ${r.first}, expected about ${expected + 1}`)
    return `scrollTop ${Math.round(r.scrollTop)}, ${r.visible} cards on screen`
  })

  await check('«Строка» on the phone opens the sheet of the new row', async () => {
    await page.locator('[data-add-row]').tap()
    await page.locator('[data-sheet]').waitFor()
    const n = await page.evaluate(() => window.__spike.view.length)
    await page.getByRole('button', { name: 'Отмена' }).tap()
    assert(n === 301, `${n} rows`)
  })

  await check('the grid at 390 px, for comparison (mode=grid)', async () => {
    await open(page, origin, 'rows=300&mode=grid')
    const r = await page.evaluate(() => {
      const s = window.__spike.grid.scroller()
      const headers = [...s.querySelectorAll('[role=columnheader]')]
      const right = s.getBoundingClientRect().right
      const visible = headers.filter((h) => h.getBoundingClientRect().left < right - 20).map((h) => h.innerText)
      return { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth, rowsOnScreen: Math.floor((s.clientHeight - 40) / 40), visible }
    })
    await open(page, origin, 'rows=300')
    const cardsOnScreen = await page.evaluate(() => Math.floor((document.querySelector('[data-cards]').clientHeight - 88) / 84))
    return `grid: ${r.scrollWidth} px wide in ${r.clientWidth} px, ${r.rowsOnScreen} rows on screen, columns seen: ${r.visible.join(', ')}; cards: ${cardsOnScreen} on screen`
  })

  if (shots) {
    await open(page, origin, 'rows=300')
    await page.screenshot({ path: join(shotDir, `${current}.png`) })
    await page.locator('[role=listitem] .main').first().tap()
    await page.locator('[data-sheet]').waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shotDir, `${current}-sheet.png`) })
  }
}

const server = await serve()
const versions = {}
try {
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (only && !only.includes(name)) continue
    current = name
    const browser = await profile.type.launch()
    versions[name] = `${profile.type.name()} ${browser.version()}`
    console.log(`\n${name} (${versions[name]})`)
    const context = await browser.newContext(profile.context)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    if (profile.phone) await phone(page, server.origin, profile)
    else await desktop(page, server.origin, profile)
    await check('no uncaught errors on the page', async () => {
      assert(errors.length === 0, errors.slice(0, 2).join(' | '))
    })
    await browser.close()
  }
} finally {
  await server.close()
}

const passed = results.filter((r) => r.ok).length
writeFileSync(join(root, outFile), `${JSON.stringify({ at: new Date().toISOString(), versions, passed, total: results.length, results }, null, 2)}\n`)
console.log(`\n${passed} of ${results.length} checks passed`)
process.exitCode = passed === results.length ? 0 : 1
