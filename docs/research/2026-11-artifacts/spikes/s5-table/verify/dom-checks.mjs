// The skeptic's own checks of the s5 table, by another code path than the spike's check.mjs:
// no window.__spike hooks — only mouse, keyboard, touch and the real clipboard in, and the DOM,
// the clipboard and the downloaded files out. Run from this directory after a build of the spike
// (its dist/ is passed as the first argument):
//   node dom-checks.mjs <dist dir> [--only=chromium-desktop,chromium-phone,webkit-iphone,webkit-desktop]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium, devices, firefox, webkit } from 'playwright-core'
import { serve } from './server.mjs'

const dist = process.argv[2]
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const NBSP = ' '
const results = []
let current = ''

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ profile: current, name, ok: true, detail: detail ?? '' })
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    results.push({ profile: current, name, ok: false, detail: String(e?.message ?? e).split('\n')[0] })
    console.log(`  FAIL ${name} — ${String(e?.message ?? e).split('\n')[0]}`)
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}

const cell = (r, col) => `[data-grid] [role=row][aria-rowindex="${r}"] [data-col="${col}"]`
const text = (page, sel) => page.locator(sel).evaluate((el) => el.textContent)

async function open(page, origin, query) {
  await page.goto(`${origin}/?${query}`)
  await page.locator('[data-grid] [role=row][aria-rowindex="2"], [data-cards] [role=listitem]').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(150)
}

/** The active cell by aria-activedescendant: row index and column, from the DOM only. */
const active = (page) =>
  page.evaluate(() => {
    const g = document.querySelector('[data-grid]')
    const el = g && document.getElementById(g.getAttribute('aria-activedescendant') ?? '')
    return el ? `${el.closest('[role=row]').getAttribute('aria-rowindex')}:${el.dataset.col}` : null
  })

/** Rows on screen in order: name and price text. */
const firstRows = (page, n) =>
  page.evaluate((count) => {
    const rows = [...document.querySelectorAll('[data-grid] [role=row][aria-rowindex]')]
      .map((el) => ({ i: Number(el.getAttribute('aria-rowindex')), el }))
      .filter((x) => x.i > 1)
      .sort((a, b) => a.i - b.i)
      .slice(0, count)
    return rows.map(({ i, el }) => ({
      i,
      name: el.querySelector('[data-col=name]')?.textContent ?? '',
      price: el.querySelector('[data-col=price]')?.textContent ?? '',
    }))
  }, n)

const priceNumber = (t) => (t === '' ? Infinity : Number(t.replaceAll(NBSP, '').replaceAll(' ', '').replace(',', '.')))

function parseCsv(textIn) {
  const rows = []
  let row = []
  let field = ''
  let q = false
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i]
    if (q) {
      if (ch === '"' && textIn[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') q = false
      else field += ch
    } else if (ch === '"' && field === '') q = true
    else if (ch === ';') {
      row.push(field)
      field = ''
    } else if (ch === '\r' && textIn[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function typeInto(page, sel, first, rest) {
  await page.locator(sel).click()
  await page.keyboard.press(first)
  if (rest) await page.keyboard.type(rest)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(60)
}

async function desktop(page, origin, isChromium, realClipboard = isChromium) {
  await open(page, origin, 'rows=300')
  const grid = page.locator('[data-grid]')

  await check('click a cell: the grid keeps the focus, aria-activedescendant names the cell', async () => {
    await page.locator(cell(2, 'name')).click()
    const a = await active(page)
    const focusOnGrid = await page.evaluate(() => document.activeElement?.hasAttribute('data-grid'))
    assert(a === '2:name' && focusOnGrid, `active ${a}, grid focused ${focusOnGrid}`)
    return a
  })

  await check('keys move the active cell (read from aria-activedescendant)', async () => {
    const trail = []
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight']) await page.keyboard.press(k)
    trail.push(await active(page))
    for (const k of ['Tab', 'Shift+Tab', 'End', 'Home', 'Control+End']) {
      await page.keyboard.press(k)
      await page.waitForTimeout(30)
      trail.push(await active(page))
    }
    await page.keyboard.press('Control+Home')
    await page.waitForTimeout(30)
    trail.push(await active(page))
    const want = ['5:category', '5:unit', '5:category', '5:note', '5:name', '301:name', '2:name']
    assert(JSON.stringify(trail) === JSON.stringify(want), `got ${trail.join(' ')}`)
    return trail.join(' → ')
  })

  let original = ''
  await check('typed price: «1234,5» Enter → «1 234,50» with a no-break space', async () => {
    original = await text(page, `${cell(4, 'price')} .txt`)
    await page.locator(cell(4, 'price')).click()
    await page.keyboard.press('1')
    await page.keyboard.type('234,5')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(60)
    const shown = await text(page, `${cell(4, 'price')} .txt`)
    const a = await active(page)
    assert(shown === `1${NBSP}234,50`, `shown ${JSON.stringify(shown)} codes ${[...shown].map((c) => c.charCodeAt(0).toString(16)).join(',')}`)
    assert(a === '5:price', `active after Enter ${a}`)
    return `«${original}» → ${JSON.stringify(shown)}, then ${a}`
  })

  await check('Ctrl+Z on the grid brings the old price back', async () => {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(60)
    const shown = await text(page, `${cell(4, 'price')} .txt`)
    const message = await text(page, '[data-message]')
    assert(shown === original, `shown ${JSON.stringify(shown)}, want ${JSON.stringify(original)}`)
    return `«${message}»`
  })

  await check('F2, typing, Esc: nothing changes', async () => {
    const before = await text(page, `${cell(6, 'name')} .txt`)
    await page.locator(cell(6, 'name')).click()
    await page.keyboard.press('F2')
    await page.keyboard.type(' ИЗМЕНЕНО')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    const after = await text(page, `${cell(6, 'name')} .txt`)
    assert(after === before, `${before} → ${after}`)
  })

  await check('Delete empties a note; Space flips «В наличии»; a click on a box keeps the grid focused', async () => {
    await page.locator(cell(7, 'note')).click()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(50)
    const note = await text(page, cell(7, 'note'))
    const box = (r) => page.locator(`${cell(r, 'inStock')} input`).evaluate((el) => el.checked)
    const b0 = await box(8)
    await page.locator(cell(8, 'inStock')).click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('Space')
    await page.waitForTimeout(50)
    const b1 = await box(8)
    const c0 = await box(9)
    await page.locator(`${cell(9, 'inStock')} input`).click()
    await page.waitForTimeout(50)
    const c1 = await box(9)
    const focus = await page.evaluate(() => document.activeElement?.hasAttribute('data-grid'))
    assert(note === '', `note «${note}»`)
    assert(b1 === !b0 && c1 === !c0 && focus, `space ${b0}→${b1}, click ${c0}→${c1}, focus ${focus}`)
  })

  await check('header click sorts by price (DOM order), again — descending', async () => {
    const header = page.locator('[role=columnheader][data-col="price"]')
    await header.click()
    await page.waitForTimeout(80)
    const asc = (await firstRows(page, 12)).map((r) => priceNumber(r.price))
    const aria1 = await header.getAttribute('aria-sort')
    await header.click()
    await page.waitForTimeout(80)
    const desc = (await firstRows(page, 12)).map((r) => priceNumber(r.price))
    const aria2 = await header.getAttribute('aria-sort')
    await header.click()
    await page.waitForTimeout(80)
    const up = asc.every((p, i) => i === 0 || asc[i - 1] <= p)
    const down = desc.filter(Number.isFinite).every((p, i, a) => i === 0 || a[i - 1] >= p)
    assert(up && down && aria1 === 'ascending' && aria2 === 'descending', `asc ${asc} desc ${desc} ${aria1} ${aria2}`)
    return `first prices asc ${asc.slice(0, 3).join(', ')}; desc ${desc.slice(0, 3).join(', ')}`
  })

  await check('an edit in a sorted view leaves the row in place until «Порядок не обновлён — обновить»', async () => {
    await page.locator('[role=columnheader][data-col="price"]').click()
    await page.waitForTimeout(80)
    const [first] = await firstRows(page, 1)
    await page.locator(cell(2, 'price')).click()
    await page.keyboard.press('9')
    await page.keyboard.type('9999')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(80)
    const [still] = await firstRows(page, 1)
    const chip = page.getByText('Порядок не обновлён — обновить')
    const visible = await chip.isVisible()
    await chip.click()
    await page.waitForTimeout(80)
    const [after] = await firstRows(page, 1)
    const at = await page.evaluate((name) => {
      const hit = [...document.querySelectorAll('[data-grid] [role=row]')].find((r) => r.querySelector('[data-col=name]')?.textContent === name)
      return hit ? Number(hit.getAttribute('aria-rowindex')) : null
    }, first.name)
    await page.locator('[role=columnheader][data-col="price"]').click()
    await page.locator('[role=columnheader][data-col="price"]').click()
    await page.waitForTimeout(80)
    assert(still.name === first.name && still.price === `99${NBSP}999`, `after edit row 2 is ${JSON.stringify(still)}`)
    assert(visible, 'no chip')
    assert(after.name !== first.name && at === null, `after refresh row 2 ${after.name}, edited row at ${at}`)
    return `«${first.name}» stayed at the top with 99 999 ₽; after the chip it left the screen`
  })

  // 22, not the 21 of the report: corpus-counts.mjs counts 22 notes with «Ёлочная» in makeRows(300, 1);
  // the spike's check got 21 because its «Delete» check had emptied one of them before the search.
  await check('search: counter text says 37 of 300 for «пирог» and 22 for «ёлочная» (and «ЕЛОЧНАЯ»)', async () => {
    const search = page.locator('[data-search]')
    await search.fill('пирог')
    await page.waitForTimeout(60)
    const a = await text(page, '[data-counter]')
    await search.fill('ёлочная')
    await page.waitForTimeout(60)
    const b = await text(page, '[data-counter]')
    await search.fill('ЕЛОЧНАЯ')
    await page.waitForTimeout(60)
    const c = await text(page, '[data-counter]')
    await search.fill('')
    await page.waitForTimeout(60)
    assert(a.startsWith('37 ') && b.startsWith('22 ') && c === b, `${a} | ${b} | ${c}`)
    return `${a}; ${b}; «ЕЛОЧНАЯ» — ${c}`
  })

  if (realClipboard) {
    await check('real clipboard paste of my own text: «1 000 р.», «2.345,67», en-US «1,234» refused', async () => {
      if (isChromium) await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
      const tsv = `1${NBSP}000 р.\tTRUE\r\n2.345,67\tнет\r\n1,234\tда\r\n`
      const before = await text(page, `${cell(13, 'price')} .txt`)
      await page.evaluate((t) => navigator.clipboard.writeText(t), tsv)
      await page.locator(cell(11, 'price')).click()
      await page.keyboard.press('ControlOrMeta+V')
      await page.waitForTimeout(120)
      const got = []
      for (const r of [11, 12, 13]) {
        got.push([await text(page, `${cell(r, 'price')} .txt`), await page.locator(`${cell(r, 'inStock')} input`).evaluate((el) => el.checked)])
      }
      const message = await text(page, '[data-message]')
      assert(got[0][0] === `1${NBSP}000` && got[0][1] === true, `row 1 ${got[0]}`)
      assert(got[1][0] === `2${NBSP}345,67` && got[1][1] === false, `row 2 ${got[1]}`)
      assert(got[2][0] === before && got[2][1] === true, `row 3 ${got[2]}`)
      return `«${message}»`
    })

    await check('mouse-drag a range, Ctrl+C: the clipboard holds plain TSV of what the DOM shows', async () => {
      const a = page.locator(cell(11, 'unit'))
      const b = page.locator(cell(12, 'price'))
      const ba = await a.boundingBox()
      const bb = await b.boundingBox()
      await page.mouse.move(ba.x + ba.width / 2, ba.y + ba.height / 2)
      await page.mouse.down()
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.press('ControlOrMeta+C')
      const clip = await page.evaluate(() => navigator.clipboard.readText())
      const want = [11, 12]
        .map((r) => r)
        .map(async (r) => `${await text(page, cell(r, 'unit'))}\t${(await text(page, `${cell(r, 'price')} .txt`)).replaceAll(NBSP, '')}`)
      const lines = await Promise.all(want)
      assert(clip === lines.join('\r\n'), `clipboard ${JSON.stringify(clip)}, DOM ${JSON.stringify(lines)}`)
      return JSON.stringify(clip)
    })
  }

  await check('CSV: BOM, «;», CRLF, 6 fields everywhere; «+», «@», «-» notes get an apostrophe', async () => {
    await typeInto(page, cell(2, 'note'), '+', '7 999 000-00-00')
    await typeInto(page, cell(3, 'note'), '@', 'user')
    await typeInto(page, cell(4, 'note'), '-', '5% по пятницам')
    await typeInto(page, cell(5, 'note'), '=', 'HYPERLINK("http://example.test";"x")')
    await page.locator('[data-tool=download]').click()
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-download=csv]').click()])
    const raw = readFileSync(await dl.path(), 'utf8')
    const rows = parseCsv(raw.slice(1))
    const header = rows[0]
    const widths = new Set(rows.map((r) => r.length))
    const prices = rows.slice(1).map((r) => r[3])
    const notes = rows.slice(1, 5).map((r) => r[5])
    assert(raw.charCodeAt(0) === 0xfeff, 'no BOM')
    assert(!/[^\r]\n/.test(raw), 'a bare LF between lines')
    assert(header.join('|') === 'Название|Категория|Ед.|Цена, ₽|В наличии|Примечание', `header ${header}`)
    assert(widths.size === 1 && widths.has(6), `field counts ${[...widths]}`)
    assert(prices.every((p) => p === '' || /^\d+(,\d{2})?$/.test(p)), `bad price ${prices.find((p) => !/^\d+(,\d{2})?$/.test(p))}`)
    assert(
      notes[0] === "'+7 999 000-00-00" && notes[1] === "'@user" && notes[2] === "'-5% по пятницам" && notes[3] === `'=HYPERLINK("http://example.test";"x")`,
      `notes ${JSON.stringify(notes)}`,
    )
    return `${rows.length - 1} rows; notes ${notes.slice(0, 3).join(' | ')}`
  })

  await check('XLSX by unzip: no <f> formula element, prices are numbers, the =HYPERLINK note is a string', async () => {
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    } catch {
      return 'NOTE: no unzip on this machine, not checked'
    }
    await page.locator('[data-tool=download]').click()
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-download=xlsx]').click()])
    const file = await dl.path()
    const list = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
    const sheetName = list.find((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n))
    const sheet = execFileSync('unzip', ['-p', file, sheetName], { encoding: 'utf8', maxBuffer: 1 << 26 })
    const shared = list.includes('xl/sharedStrings.xml') ? execFileSync('unzip', ['-p', file, 'xl/sharedStrings.xml'], { encoding: 'utf8', maxBuffer: 1 << 26 }) : ''
    const formulas = (sheet.match(/<f[\s>]/g) ?? []).length
    const d2 = sheet.match(/<c r="D2"[^>]*>(.*?)<\/c>/)?.[0] ?? ''
    const hyperlinkText = sheet.includes('HYPERLINK') || shared.includes('HYPERLINK')
    const f5 = sheet.match(/<c r="F6"[^>]*>(.*?)<\/c>/)?.[0] ?? ''
    assert(formulas === 0, `${formulas} <f> elements`)
    assert(/<v>[\d.]+<\/v>/.test(d2) && !/t="s"|t="inlineStr"/.test(d2), `price cell D2 ${d2}`)
    assert(hyperlinkText && /t="(s|inlineStr|str)"/.test(f5), `note cell F6 ${f5}`)
    return `files ${list.length}; D2 ${d2.slice(0, 60)}; F6 ${f5.slice(0, 60)}`
  })

  await check('the view follows its own box, not the window: #root 560 px → cards, 662 px → grid', async () => {
    const style = await page.addStyleTag({ content: '#root{width:560px !important}' })
    await page.locator('[data-cards]').waitFor({ timeout: 5000 })
    const cards = await page.locator('[data-cards]').count()
    await style.evaluate((el) => {
      el.textContent = '#root{width:662px !important}'
    })
    await page.locator('[data-grid]').waitFor({ timeout: 5000 })
    await page.waitForTimeout(150)
    const r = await page.evaluate(() => {
      const g = document.querySelector('[data-grid]').getBoundingClientRect()
      const cols = [...document.querySelectorAll('[role=columnheader]')].map((h) => {
        const b = h.getBoundingClientRect()
        return { col: h.dataset.col, seen: Math.max(0, Math.min(b.right, g.right) - Math.max(b.left, g.left)) / b.width }
      })
      const price = document.querySelector('[data-grid] [role=row][aria-rowindex="2"] [data-col=price] .txt').getBoundingClientRect()
      return { width: g.width, cols, priceTextSeen: Math.max(0, Math.min(price.right, g.right) - price.left) / price.width }
    })
    await style.evaluate((el) => el.remove())
    await page.locator('[data-grid]').waitFor()
    assert(cards === 1, 'no cards at 560 px')
    const full = r.cols.filter((c) => c.seen >= 0.99).map((c) => c.col)
    return `grid ${Math.round(r.width)} px: whole columns ${full.join(', ')}; price column seen ${Math.round(100 * r.cols.find((c) => c.col === 'price').seen)} %, price text seen ${Math.round(100 * r.priceTextSeen)} %`
  })

  await check('Tab from the last cell leaves the grid (Ctrl+End, End, Tab)', async () => {
    await page.locator(cell(2, 'name')).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('End')
    await page.waitForTimeout(50)
    const a = await active(page)
    await page.keyboard.press('Tab')
    const inGrid = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-grid]')))
    assert(a === '301:note' && !inGrid, `active ${a}, still in grid ${inGrid}`)
  })

  await check('aria-rowcount and DOM size at 5 000 rows', async () => {
    await open(page, origin, 'rows=5000')
    const rc = await grid.getAttribute('aria-rowcount')
    const rows = await page.locator('[data-grid] [role=row]').count()
    assert(rc === '5001' && rows < 60, `aria-rowcount ${rc}, rows ${rows}`)
    return `aria-rowcount ${rc}, ${rows - 1} body rows in the DOM`
  })
}

async function phone(page, origin, cdpCapable) {
  await open(page, origin, 'rows=300')
  await check('cards fully on screen (above the fixed bar) and in the DOM', async () => {
    const r = await page.evaluate(() => {
      const s = document.querySelector('[data-cards]').getBoundingClientRect()
      const bar = document.querySelector('[data-add-row]').closest('div').getBoundingClientRect()
      const bottom = Math.min(s.bottom, bar.top)
      const items = [...document.querySelectorAll('[data-cards] [role=listitem]')]
      const full = items.filter((el) => {
        const b = el.getBoundingClientRect()
        return b.top >= s.top - 0.5 && b.bottom <= bottom + 0.5
      })
      return { full: full.length, dom: items.length, h: items[0]?.getBoundingClientRect().height, scrollW: document.scrollingElement.scrollWidth, w: innerWidth }
    })
    assert(r.scrollW <= r.w, `page scrolls sideways ${r.scrollW} > ${r.w}`)
    return `${r.full} whole cards on screen, ${r.dom} in the DOM, card ${r.h} px`
  })

  await check('tap near the corner of «В наличии» (not the centre) flips the switch', async () => {
    const label = page.locator('[role=listitem] .stock').nth(1)
    const input = label.locator('input')
    const before = await input.evaluate((el) => el.checked)
    const b = await label.boundingBox()
    await page.touchscreen.tap(b.x + 6, b.y + 6)
    await page.waitForTimeout(80)
    const after = await input.evaluate((el) => el.checked)
    const sheet = await page.locator('[data-sheet]').count()
    assert(after === !before && sheet === 0, `${before} → ${after}, sheet ${sheet}`)
    return `label ${Math.round(b.width)}×${Math.round(b.height)}`
  })

  await check('tap a card: the sheet opens with the price field focused and inputmode=decimal', async () => {
    await page.locator('[role=listitem] .main').first().tap()
    await page.locator('[data-sheet]').waitFor()
    await page.waitForTimeout(250)
    const f = await page.evaluate(() => ({ field: document.activeElement?.getAttribute('data-field'), mode: document.activeElement?.getAttribute('inputmode') }))
    await page.getByRole('button', { name: 'Отмена' }).tap()
    await page.locator('[data-sheet]').waitFor({ state: 'detached' })
    assert(f.field === 'price' && f.mode === 'decimal', JSON.stringify(f))
  })

  await check('the grid at this width (?mode=grid): whole columns and whole rows on screen', async () => {
    await open(page, origin, 'rows=300&mode=grid')
    const r = await page.evaluate(() => {
      const g = document.querySelector('[data-grid]')
      const gb = g.getBoundingClientRect()
      const head = g.querySelector('.header').getBoundingClientRect()
      const cols = [...g.querySelectorAll('[role=columnheader]')].map((h) => {
        const b = h.getBoundingClientRect()
        return { col: h.dataset.col ?? h.textContent, seen: Math.max(0, Math.min(b.right, gb.right) - Math.max(b.left, gb.left)) / b.width }
      })
      const rows = [...g.querySelectorAll('[role=row][aria-rowindex]')].filter((el) => {
        if (el.classList.contains('header')) return false
        const b = el.getBoundingClientRect()
        return b.top >= head.bottom - 0.5 && b.bottom <= gb.bottom + 0.5
      })
      return { width: g.scrollWidth, client: g.clientWidth, cols, rows: rows.length }
    })
    const whole = r.cols.filter((c) => c.seen >= 0.99).map((c) => c.col)
    const part = r.cols.filter((c) => c.seen > 0 && c.seen < 0.99).map((c) => `${c.col} ${Math.round(100 * c.seen)} %`)
    return `${r.width} px in ${r.client} px; whole: ${whole.join(', ')}; partly: ${part.join(', ') || '—'}; ${r.rows} whole rows`
  })
}

const PROFILES = {
  'chromium-desktop': { type: chromium, ctx: { viewport: { width: 1440, height: 900 }, locale: 'ru-RU', acceptDownloads: true }, phone: false },
  'webkit-desktop': { type: webkit, ctx: { viewport: { width: 1440, height: 900 }, locale: 'ru-RU', acceptDownloads: true }, phone: false },
  'chromium-phone': {
    type: chromium,
    ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ru-RU' },
    phone: true,
  },
  'webkit-iphone': { type: webkit, ctx: { ...devices['iPhone 13'], locale: 'ru-RU' }, phone: true },
  // Run in the Playwright image (Linux): node dom-checks.mjs <dist> --only=firefox-desktop
  'firefox-desktop': { type: firefox, ctx: { viewport: { width: 1440, height: 900 }, locale: 'ru-RU', acceptDownloads: true }, phone: false, clipboard: true },
}

const server = await serve(dist)
try {
  for (const [name, p] of Object.entries(PROFILES)) {
    if (only && !only.includes(name)) continue
    current = name
    const browser = await p.type.launch()
    console.log(`\n${name} (${p.type.name()} ${browser.version()})`)
    const context = await browser.newContext(p.ctx)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    if (p.phone) await phone(page, server.origin, p.type === chromium)
    else await desktop(page, server.origin, p.type === chromium, p.type === chromium || p.clipboard === true)
    await check('no uncaught page errors', async () => assert(errors.length === 0, errors.join(' | ')))
    await browser.close()
  }
} finally {
  await server.close()
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} passed`)
process.exitCode = passed === results.length ? 0 : 1
