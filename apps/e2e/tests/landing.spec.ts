import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Expect, type Locator, type Page } from '@playwright/test'

import {
  applyChange,
  firstScreen,
  headerAction,
  heroAction,
  hydrated,
  menuToggle,
  openAt,
  plainName,
  platformsAction,
  pricingAction,
  RUNNING_LINE,
  settled,
  slogan,
} from './landing-page.ts'

// DOM and geometry assertions, not pixel snapshots: they hold on any OS and font rendering.
// Needs the web server and a database with seeds (the pricing slider renders from the plans).

const INK = 'rgb(36, 23, 16)'
const PAPER = 'rgb(255, 248, 236)'
const PAPER_2 = 'rgb(243, 231, 213)'
const ACCENT = 'rgb(255, 107, 36)'
const ACCENT_TEXT = 'rgb(166, 61, 18)'
const MARKER = 'rgb(255, 197, 71)'
// The heading of the page, in the words people search by, and the slogan under it.
const KEYWORD = 'ИИ-помощник для сайта на WordPress, Joomla, OpenCart, MODX и 1С-Битрикс'
const SLOGAN = 'Напишите в чат. Сайт поправим.'
// The terms under the main action, as a guest reads them.
const TERMS = [
  '50 кредитов в подарок — около 10 небольших правок',
  'Подключение бесплатно',
  'Подключаем сами',
]
// The systems the page names, in the owner's order.
const SYSTEMS = ['WordPress', 'Joomla', 'OpenCart', 'MODX', '1С-Битрикс']
const QUESTIONS = [
  'Нужно разбираться в сайтах?',
  'Мой сайт подойдёт?',
  'Сколько стоит одна правка?',
  'А если результат не понравится?',
  'Где будут храниться данные?',
]
// The phone of the service, as the header, the mobile menu and the lead section show it.
const PHONE = { text: '+7 919 048-36-83', href: 'tel:+79190483683' }

/** The channels of a computed colour from 0 to 1. A colour mixed in CSS is computed as color(srgb …). */
function channels(color: string): number[] {
  const numbers = (color.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number).slice(0, 3)
  if (numbers.length < 3) throw new Error(`Not a colour: ${color}`)
  if (color.startsWith('rgb')) return numbers.map((value) => value / 255)
  if (color.startsWith('color(srgb')) return numbers
  throw new Error(`A colour in an unexpected notation: ${color}`)
}

/** The WCAG 2 contrast of two computed colours. */
function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const [red = 0, green = 0, blue = 0] = channels(color).map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const [lighter = 0, darker = 0] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

/** A probe every 100ms: the default steps of a poll grow to a second, and a scroll that has ended
 *  would wait for the next one. */
const OFTEN = { intervals: [100] }

/**
 * Checks the page at rest in each window in turn, on a page that is already open: a new size
 * needs no new load where nothing plays once per load. Each window is a step of the report, and
 * `soft` goes on after a failure, so one window does not hide the others.
 */
async function atSizes(
  page: Page,
  sizes: readonly (readonly [width: number, height: number])[],
  check: (width: number, height: number, soft: Expect) => Promise<void>,
): Promise<void> {
  for (const [width, height] of sizes) {
    const size = `at ${width}x${height}px`
    await test.step(size, async () => {
      await page.setViewportSize({ width, height })
      // A section that the new size brought into the window starts its entrance: wait it out.
      await settled(page)
      await check(width, height, expect.configure({ soft: true, message: size }))
    })
  }
}

/** The same at each width of a window 900px high. */
function atWidths(
  page: Page,
  widths: readonly number[],
  check: (width: number, soft: Expect) => Promise<void>,
): Promise<void> {
  const sizes = widths.map((width) => [width, 900] as const)
  return atSizes(page, sizes, (width, _, soft) => check(width, soft))
}

/** Whether the highlighted line of the slogan is really painted: not clipped, not covered. */
function highlightedWordIsHit(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const word = document.querySelector('#hero-title + p em')
    if (!word) return false
    const box = word.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return hit !== null && (hit === word || word.contains(hit))
  })
}

/**
 * The rows that an element paints in one column of its screenshot: every pixel of the column that
 * differs from the first pixel of the screenshot, the surface around the element. For the parts
 * of a native control, which a script cannot measure: the track and the thumb of a slider.
 */
async function paintedRows(page: Page, element: Locator, column: (width: number) => number) {
  const shot = (await element.screenshot()).toString('base64')
  const { width, height, columns } = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
    if (!context) throw new Error('No canvas to read the screenshot with')
    context.drawImage(bitmap, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    const pixel = (x: number, y: number) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)
    const surface = pixel(0, 0)
    const columns = Array.from({ length: width }, (_, x) =>
      Array.from({ length: height }, (_, y) => y).filter((y) =>
        pixel(x, y).some((channel, index) => Math.abs(channel - (surface[index] ?? 0)) > 8),
      ),
    )
    return { width, height, columns }
  }, shot)
  return { height, rows: columns[Math.round(column(width))] ?? [] }
}

/** The form of a lead: its two fields and the consent, filled as a visitor would. */
async function fillLead(
  page: Page,
  { site, contact, consent = true }: { site: string; contact: string; consent?: boolean },
): Promise<void> {
  const form = page.locator('#lead form')
  const first = form.getByLabel('Адрес сайта')
  await hydrated(first)
  await first.fill(site)
  await form.getByLabel('Телефон или Telegram').fill(contact)
  await form.getByRole('checkbox').setChecked(consent)
}

test.describe('first screen', () => {
  // 541–800px is where the second line of the slogan used to be clipped away after the entrance.
  for (const width of [320, 390, 541, 640, 768, 800, 1024, 1440]) {
    test(`shows the heading and every word of the slogan at ${width}px`, async ({ page }) => {
      await openAt(page, width)

      // The entrance has played: the word is revealed, and the checks below read the page at rest.
      await settled(page)
      // The heading of the page says what the service is, in the words people search by; the
      // slogan under it is a paragraph, so the page has one first-level heading.
      await expect(page.locator('h1')).toHaveCount(1)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(KEYWORD)
      expect(await highlightedWordIsHit(page)).toBe(true)
      const read = await page.evaluate(() => {
        const title = document.querySelector('#hero-title')
        const slogan = title?.nextElementSibling
        const mark = slogan?.querySelector('em')
        if (!title || !slogan || !mark) throw new Error('The first screen has no heading or slogan')
        // Text extent, not the box: a block is as wide as its column even when its text overflows.
        const extent = (node: Node) => {
          const range = document.createRange()
          range.selectNodeContents(node)
          return range
        }
        const lines = [...slogan.children]
        const boxes = lines.map((line) => extent(line).getBoundingClientRect())
        const heading = extent(title).getBoundingClientRect()
        const style = getComputedStyle(slogan)
        return {
          heading: {
            left: heading.left,
            right: heading.right,
            bottom: heading.bottom,
            size: parseFloat(getComputedStyle(title).fontSize),
          },
          text: (slogan.textContent ?? '').replace(/\s+/g, ' ').trim(),
          displays: lines.map((line) => getComputedStyle(line).display),
          // The entrance must not leave a clip on the lines once it has played.
          clips: lines.map((line) => getComputedStyle(line).clipPath),
          size: parseFloat(style.fontSize),
          tracking: parseFloat(style.letterSpacing) / parseFloat(style.fontSize),
          // The words of the highlighted line: one box per line of them.
          secondLine: new Set(
            [...extent(mark.firstChild ?? mark).getClientRects()].map((box) => Math.round(box.top)),
          ).size,
          left: Math.min(...boxes.map((box) => box.left)),
          right: Math.max(...boxes.map((box) => box.right)),
          top: Math.min(...boxes.map((box) => box.top)),
        }
      })
      expect(read.text).toBe(SLOGAN)
      expect(read.displays).toEqual(['block', 'block'])
      expect(read.clips).toEqual(['none', 'none'])
      // «Сайт поправим.» stays in one piece and inside the page down to the narrowest phone.
      expect(read.secondLine).toBe(1)
      expect(read.left).toBeGreaterThanOrEqual(0)
      expect(read.right).toBeLessThanOrEqual(width)
      expect(read.tracking).toBeCloseTo(-0.04, 3)
      // The heading is the small line over the slogan, and the slogan is the large one.
      expect(read.heading.left).toBeGreaterThanOrEqual(0)
      expect(read.heading.right).toBeLessThanOrEqual(width)
      expect(read.heading.bottom).toBeLessThanOrEqual(read.top)
      expect(read.size).toBeGreaterThan(read.heading.size)
    })
  }

  test('offers one way in and a look at the example, with nothing else beside the heading', async ({
    page,
  }) => {
    await page.goto('/')
    const screen = firstScreen(page)
    await expect(screen.getByRole('link')).toHaveText([
      'Подключить сайт бесплатно',
      'Посмотреть пример',
    ])
    await expect(heroAction(page)).toHaveText('Подключить сайт бесплатно')
    await expect(screen.getByRole('link', { name: 'Посмотреть пример' })).toHaveAttribute(
      'href',
      '#demo',
    )
    // The demo has a section of its own, and the first screen says nothing of a launch to come.
    await expect(screen.locator('#site-demo')).toHaveCount(0)
    await expect(screen.getByRole('button')).toHaveCount(0)
    await expect(screen).not.toContainText('готовится к запуску')
    await expect(screen).not.toContainText('Посмотреть возможности')
  })

  // The terms under the action: the gift of the sign-up for a guest, then two short facts.
  test('lists the terms under the action, each inside the page', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 768, 1440], async (width, soft) => {
      const list = firstScreen(page).getByRole('list')
      await soft(list.getByRole('listitem')).toHaveText(TERMS)
      const places = await list.evaluate((node) => {
        const action = node.previousElementSibling?.getBoundingClientRect()
        if (!action) throw new Error('The terms have no actions above them')
        return {
          actions: action.bottom,
          items: [...node.children].map((item) => {
            const box = item.getBoundingClientRect()
            const sign = item.querySelector('svg')
            const text = document.createRange()
            text.selectNodeContents(item.lastChild ?? item)
            return {
              // How far the words start from their check: the gap of the item is 8px.
              apart: text.getBoundingClientRect().left - (sign?.getBoundingClientRect().right ?? 0),
              left: box.left,
              right: box.right,
              top: box.top,
              // The check is for the eye: the text of the term says everything.
              sign: sign?.getAttribute('aria-hidden'),
            }
          }),
        }
      })
      for (const item of places.items) {
        soft(item.left).toBeGreaterThanOrEqual(0)
        soft(item.right).toBeLessThanOrEqual(width)
        soft(item.top).toBeGreaterThanOrEqual(places.actions)
        soft(item.sign).toBe('true')
        // The check stands by its words, also where a term takes two lines.
        soft(item.apart).toBeGreaterThanOrEqual(0)
        soft(item.apart).toBeLessThanOrEqual(12)
      }
    })
  })
})

test.describe('first screen in a low window', () => {
  const sloganSize = (page: Page) =>
    slogan(page).evaluate((line) => parseFloat(getComputedStyle(line).fontSize))

  // A laptop of 1366x768 or 1280x720 leaves the page about this much under the browser chrome.
  test('keeps the main action and the terms above the fold', async ({ page }) => {
    const sizes = [
      [1366, 640],
      [1280, 600],
      [1024, 640],
    ] as const
    await openAt(page, ...sizes[0])
    await atSizes(page, sizes, async (_, height, soft) => {
      const box = await heroAction(page).boundingBox()
      if (!box) throw new Error('The first screen has no main action')
      soft(box.y + box.height).toBeLessThanOrEqual(height)
      // The slogan gives way to the height and stays the largest line of the page: a section
      // heading is 49px at most.
      soft(await sloganSize(page)).toBeGreaterThan(49)
      // Under the action the terms are above the fold too: they are a part of the offer.
      const terms = await firstScreen(page).getByRole('list').boundingBox()
      if (!terms) throw new Error('The first screen has no terms')
      soft(terms.y + terms.height).toBeLessThanOrEqual(height)
    })
  })

  // The limit of the slogan is 12% of the height of the window: it bites only below 750px, and
  // never on a phone, where the width sets the size.
  test('lowers the slogan only in a low window', async ({ page }) => {
    await openAt(page, 1440, 900)
    expect(await sloganSize(page)).toBe(90)
    await page.setViewportSize({ width: 1440, height: 760 })
    expect(await sloganSize(page)).toBe(90)
    await page.setViewportSize({ width: 1440, height: 600 })
    expect(await sloganSize(page)).toBe(72)
    for (const [width, height] of [
      [320, 480],
      [390, 664],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      const tall = await sloganSize(page)
      await page.setViewportSize({ width, height })
      expect(await sloganSize(page), `at ${width}x${height}px`).toBe(tall)
    }
  })
})

test.describe('hero lead', () => {
  // One centred column of 56 characters at most: the lead must not end with a line of one word,
  // and where the column has its full measure it keeps to two lines.
  test('ends with more than one word', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 541, 768, 801, 1024, 1440], async (width, soft) => {
      const lead = await page.locator('#hero-title + p + p').evaluate((paragraph) => {
        const text = paragraph.firstChild
        if (!text?.textContent) throw new Error('The lead has no text')
        const range = document.createRange()
        range.selectNodeContents(text)
        const lines = [...range.getClientRects()]
        const lastTop = Math.round(lines.at(-1)?.top ?? 0)
        // The words of the last line: the offsets of the text whose box stands on that line.
        const words = text.textContent.split(/[ \u00a0]/)
        let offset = 0
        let onLastLine = 0
        for (const word of words) {
          range.setStart(text, offset)
          range.setEnd(text, offset + word.length)
          if (Math.round(range.getBoundingClientRect().top) === lastTop) onLastLine += 1
          offset += word.length + 1
        }
        return { lines: new Set(lines.map((line) => Math.round(line.top))).size, onLastLine }
      })
      soft(lead.onLastLine).toBeGreaterThan(1)
      soft(lead.lines).toBeLessThanOrEqual(width >= 768 ? 2 : 4)
    })
  })
})

test.describe('description for search', () => {
  test('names what the service does, the five systems and the free connection', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Радити меняет сайт по сообщению в чате: цены, тексты, фото, акции. WordPress, Joomla, OpenCart, MODX, 1С-Битрикс. Подключим бесплатно, 50 кредитов в подарок.',
    )
    await expect(page).toHaveTitle('Радити — ИИ-помощник для сайта: напишите в чат, сайт поправим')
  })

  // A search engine cuts a longer description in its snippet.
  test('fits 160 characters', async ({ page }) => {
    await page.goto('/')
    const description = await page.locator('meta[name="description"]').getAttribute('content')
    expect(description?.length).toBeLessThanOrEqual(160)
  })

  test('promises neither Telegram nor a working agent on a page without its own description', async ({
    page,
  }) => {
    // The sign-in page sets a title only, so it shows the description of the root layout.
    await page.goto('/sign-in')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Радити — поддержка сайтов для малого бизнеса: напишите в чат, что поменять на сайте. Сервис готовится к запуску.',
    )
  })
})

test.describe('header', () => {
  // The short main action comes at 1100px and the phone number at 1240px; below them the four
  // links must still keep one row.
  test('keeps one row', async ({ page }) => {
    await openAt(page, 801)
    await atWidths(page, [801, 900, 1024, 1099, 1100, 1239, 1240, 1440], async (width, soft) => {
      const header = page.locator('#top > header')
      const navigation = header.getByRole('navigation', { name: 'Основная навигация' })
      await soft(navigation.getByRole('link')).toHaveText([
        'Пример',
        'Возможности',
        'Тарифы',
        'Вопросы',
      ])
      await soft(navigation.getByRole('link', { name: 'Пример' })).toHaveAttribute('href', '#demo')
      await soft(navigation.getByRole('link', { name: 'Вопросы' })).toHaveAttribute('href', '#faq')
      // Nothing of the header leads to the registration: the way in is the form of a lead.
      await soft(header.locator('a[href="/sign-up"]')).toHaveCount(0)

      const action = headerAction(page)
      if (width >= 1100) {
        await soft(action).toBeVisible()
        await soft(action).toHaveText('Подключить сайт')
        await soft(action).toHaveCSS('color', INK)
        soft((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      } else {
        await soft(action).toBeHidden()
      }
      const phone = header.locator('> div:first-child a[href^="tel:"]')
      if (width >= 1240) {
        await soft(phone).toBeVisible()
        await soft(phone).toHaveText(PHONE.text)
        await soft(phone).toHaveAttribute('href', PHONE.href)
        soft((await phone.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      } else {
        await soft(phone).toBeHidden()
      }

      const row = await header.evaluate((element) => {
        const inner = element.firstElementChild
        if (!inner) throw new Error('The header has no row')
        const shown = (node: Element) => node.getClientRects().length > 0
        const lines: number[] = []
        for (const link of inner.querySelectorAll('a')) {
          if (!shown(link)) continue
          for (const node of link.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            // One box per line of the label: a wrapped label has two.
            lines.push(range.getClientRects().length)
          }
        }
        const parts = [...inner.children].filter(shown).map((part) => part.getBoundingClientRect())
        const content = inner.getBoundingClientRect()
        const padding = parseFloat(getComputedStyle(inner).paddingRight)
        return {
          lines,
          gaps: parts.slice(1).map((part, index) => part.left - (parts[index]?.right ?? 0)),
          overflow: (parts.at(-1)?.right ?? 0) - (content.right - padding),
        }
      })
      soft(row.lines.length).toBeGreaterThanOrEqual(6)
      soft(new Set(row.lines)).toEqual(new Set([1]))
      for (const gap of row.gaps) soft(gap).toBeGreaterThanOrEqual(16)
      soft(row.overflow).toBeLessThanOrEqual(0.5)
    })
  })
})

test.describe('layout', () => {
  test('does not scroll sideways', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 768, 1024, 1440, 1920], async (_, soft) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      soft(overflow).toBeLessThanOrEqual(0)
    })
  })

  test('keeps dark text on every orange action', async ({ page }) => {
    await page.goto('/')
    const actions = [
      headerAction(page),
      heroAction(page),
      page.locator('#site-demo').getByRole('button', { name: 'Применить правку' }),
      pricingAction(page),
    ]
    for (const action of actions) await expect(action).toHaveCSS('color', INK)
    // Hover is where a neutral rule could turn the text light, and where the fill changes.
    for (const action of actions) {
      await action.hover()
      await settled(page)
      await expect(action).toHaveCSS('color', INK)
      const fill = await action.evaluate((node) => getComputedStyle(node).backgroundColor)
      expect(contrast(INK, fill)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// The states of the actions. Colours are read without motion: at once, not in the middle of a
// transition; what moves has its own tests below.
test.describe('hover and press', () => {
  const fillOf = (element: Locator) =>
    element.evaluate((node) => getComputedStyle(node).backgroundColor)
  const LIFTED = 'matrix(1, 0, 0, 1, 0, -2)'
  const PRESSED = 'matrix(0.98, 0, 0, 0.98, 0, 0)'

  /** Holds the button of the mouse down on the element, reads, then lets go beside it: no click. */
  async function whilePressed(page: Page, element: Locator, read: () => Promise<void>) {
    // A section comes in with a move when it enters the window: the pointer waits it out.
    await element.scrollIntoViewIfNeeded()
    await settled(page)
    await element.hover()
    await page.mouse.down()
    try {
      expect(
        await element.evaluate((node) => node.matches(':active')),
        `«${(await element.textContent())?.trim()}» is held down`,
      ).toBe(true)
      await read()
    } finally {
      await page.mouse.move(1, 1)
      await page.mouse.up()
    }
  }

  test.describe('colours', () => {
    test.use({ reducedMotion: 'reduce' })

    test('shows the hover of an orange action, and of the ink one on the orange field', async ({
      page,
    }) => {
      await page.goto('/')
      const orange = [
        heroAction(page),
        headerAction(page),
        page.locator('#site-demo').getByRole('button', { name: 'Применить правку' }),
        pricingAction(page),
      ]
      for (const action of orange) {
        expect(await fillOf(action)).toBe(ACCENT)
        await action.hover()
        const fill = await fillOf(action)
        // Seen as another fill, not as the same orange.
        expect(contrast(fill, ACCENT)).toBeGreaterThanOrEqual(1.2)
        expect(contrast(INK, fill)).toBeGreaterThanOrEqual(4.5)
      }
      // On the orange field the accent would dissolve in the field: the action there is ink with
      // the light text of the page, and its hover is a step lighter, still readable.
      const onOrange = platformsAction(page)
      await page.mouse.move(1, 1)
      expect(await fillOf(onOrange)).toBe(INK)
      await expect(onOrange).toHaveCSS('color', PAPER)
      expect(
        await page.locator('#platforms').evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe(ACCENT)
      const hovered = async () => {
        const fill = await fillOf(onOrange)
        expect(fill).not.toBe(INK)
        expect(fill).not.toBe(ACCENT)
        expect(contrast(PAPER, fill)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(fill, ACCENT)).toBeGreaterThanOrEqual(3)
      }
      await onOrange.hover()
      await hovered()
      await whilePressed(page, onOrange, hovered)
    })

    test('answers a press with the look of the hover and without a move', async ({ page }) => {
      await page.goto('/')
      const demo = page.locator('#site-demo')
      const apply = demo.getByRole('button', { name: 'Применить правку' })
      await hydrated(apply)

      const filled = [heroAction(page), headerAction(page), pricingAction(page), apply]
      for (const action of filled) {
        await whilePressed(page, action, async () => {
          expect(contrast(await fillOf(action), ACCENT)).toBeGreaterThanOrEqual(1.2)
          await expect(action).toHaveCSS('color', INK)
          // Reduced motion: the fill changes, nothing shrinks.
          await expect(action).toHaveCSS('transform', 'none')
        })
      }

      // An outlined action that leads away turns over.
      const signIn = page.locator('#top > header a[href="/sign-in"]')
      await whilePressed(page, signIn, async () => {
        expect(await fillOf(signIn)).toBe(INK)
        await expect(signIn).toHaveCSS('color', PAPER)
      })

      // An outlined action that stays on the page: a darker surface and an ink outline.
      const request = demo.getByRole('button', { name: 'График' })
      await whilePressed(page, request, async () => {
        expect(await fillOf(request)).toBe(PAPER_2)
        await expect(request).toHaveCSS('border-top-color', INK)
        await expect(request).toHaveCSS('color', INK)
      })
    })

    test('underlines a link under the keyboard focus as under the pointer', async ({ page }) => {
      await page.goto('/')
      const first = page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link')
      const lineOf = (link: Locator) =>
        link.evaluate((node) => getComputedStyle(node, '::after').transform)
      expect(await lineOf(first.first())).toBe('matrix(0, 0, 0, 1, 0, 0)')
      // The skip link, the logo, then the first section link.
      for (let stop = 0; stop < 3; stop++) await page.keyboard.press('Tab')
      await expect(first.first()).toBeFocused()
      expect(await lineOf(first.first())).toBe('matrix(1, 0, 0, 1, 0, 0)')
      expect(await lineOf(first.nth(1))).toBe('matrix(0, 0, 0, 1, 0, 0)')
      await first.nth(1).hover()
      expect(await lineOf(first.nth(1))).toBe('matrix(1, 0, 0, 1, 0, 0)')

      const demoLink = firstScreen(page).getByRole('link', { name: 'Посмотреть пример' })
      await expect(demoLink).toHaveCSS('text-decoration-line', 'none')
      while (!(await demoLink.evaluate((node) => node === document.activeElement))) {
        await page.keyboard.press('Tab')
      }
      await expect(demoLink).toHaveCSS('text-decoration-line', 'underline')
    })
  })

  test.describe('motion', () => {
    test('lifts both main actions alike and presses them in', async ({ page }) => {
      await page.goto('/')
      const hero = heroAction(page)
      const onOrange = platformsAction(page)
      // One role: the action on the orange field differs from the first one in colour only.
      for (const property of ['font-weight', 'font-size', 'min-height', 'border-top-left-radius']) {
        const value = await hero.evaluate(
          (node, name) => getComputedStyle(node).getPropertyValue(name),
          property,
        )
        await expect(onOrange).toHaveCSS(property, value)
      }
      await expect(onOrange).toHaveCSS('font-weight', '500')
      for (const action of [hero, onOrange]) {
        // A section comes in with a move when it enters the window: the pointer waits it out.
        await action.scrollIntoViewIfNeeded()
        await settled(page)
        await action.hover()
        await expect(action).toHaveCSS('transform', LIFTED)
        await whilePressed(page, action, () => expect(action).toHaveCSS('transform', PRESSED))
        await expect(action).toHaveCSS('transform', 'none')
      }
    })

    test('presses in the other buttons and moves the arrow of the demo action', async ({
      page,
    }) => {
      await page.goto('/')
      const demo = page.locator('#site-demo')
      const apply = demo.getByRole('button', { name: 'Применить правку' })
      await hydrated(apply)
      // `hover()` scrolls smoothly and points where the button will be: the pointer comes to rest
      // before it does, `:hover` stays false and the arrow goes back.
      await bringIntoWindow(page, apply)
      await apply.hover()
      await expect(apply.locator('svg')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 4, 0)')
      const pressed = [
        apply,
        demo.getByRole('button', { name: 'График' }),
        page.locator('#top > header a[href="/sign-in"]'),
        pricingAction(page),
      ]
      for (const action of pressed) {
        await whilePressed(page, action, () => expect(action).toHaveCSS('transform', PRESSED))
      }
      // The chosen request does nothing on a press and does not pretend to.
      const chosen = demo.getByRole('button', { name: 'Цена' })
      await whilePressed(page, chosen, () => expect(chosen).toHaveCSS('transform', 'none'))
    })
  })

  test('keeps the weight and the room of the main action on a phone', async ({ page }) => {
    await openAt(page, 390, 844)
    // The narrow rules of the main button: a tighter room, the same weight and the dark label.
    for (const action of [heroAction(page), platformsAction(page)]) {
      await expect(action).toHaveCSS('font-weight', '500')
      await expect(action).toHaveCSS('min-height', '52px')
      await expect(action).toHaveCSS('padding-left', '20px')
      await expect(action).toHaveCSS('column-gap', '18px')
    }
    await expect(heroAction(page)).toHaveCSS('color', INK)
  })

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('keeps no hover look after a tap', async ({ page }) => {
      await page.goto('/')
      expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false)
      // A filled action keeps its fill after a tap: the hover of a pointer is not for a finger.
      const hero = heroAction(page)
      await hydrated(page.locator('#site-demo').getByRole('button', { name: 'График' }))
      await hero.tap()
      await expect(page).toHaveURL(/#lead$/)
      await expect(hero).toHaveCSS('background-color', ACCENT)

      const request = page.locator('#site-demo').getByRole('button', { name: 'Цена' })
      const other = page.locator('#site-demo').getByRole('button', { name: 'График' })
      await other.tap()
      await expect(other).toHaveAttribute('aria-pressed', 'true')
      await expect(request).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    })
  })
})

// The spacing a visitor may set for reading (WCAG 1.4.12): no text may be lost with it.
const TEXT_SPACING = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`

/**
 * Every line of text that reaches past the window, as «class left–right text». The page clips
 * what overflows it, so its scroll width tells nothing: the boxes of the text itself are read.
 */
function textOutsideTheWindow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('#top')
    if (!root) throw new Error('No landing on the page')
    const width = document.documentElement.clientWidth
    const found: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      const text = node.textContent?.trim()
      if (!parent || !text || parent.getClientRects().length === 0) continue
      // A decoration, or words for a screen reader that are clipped away on purpose: by a clip
      // of their own or inside a block that the page marks as heard and not seen.
      if (parent.closest('[aria-hidden="true"], [data-sr-only]')) continue
      if (getComputedStyle(parent).clipPath !== 'none') continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const line of range.getClientRects()) {
        if (line.left >= -0.5 && line.right <= width + 0.5) continue
        const name = (parent.getAttribute('class') ?? parent.tagName).split('__').pop()
        found.push(`${name} ${Math.round(line.left)}–${Math.round(line.right)} «${text}»`)
        break
      }
    }
    return found
  })
}

test.describe('text overflow', () => {
  // No motion: a line that is still coming in is clipped and moved by its entrance.
  test.use({ reducedMotion: 'reduce' })

  // The narrowest phone and both single-column tablets, where the type is the largest for the width.
  test('keeps every line of text inside the window', async ({ page }) => {
    await openAt(page, 320)
    await expect(page.getByRole('slider')).toBeVisible()
    await atWidths(page, [320, 640, 768], async (_, soft) => {
      soft(await textOutsideTheWindow(page)).toEqual([])

      const spacing = await page.addStyleTag({ content: TEXT_SPACING })
      soft(await textOutsideTheWindow(page), 'with a wide spacing').toEqual([])
      // The next width starts from the spacing of the page.
      await spacing.evaluate((style) => (style as HTMLStyleElement).remove())
    })
  })
})

// The floor of the type size and its named exceptions (apps/web/DESIGN.md, Typography): the
// address in the demo window, the signboard and the tagline of the fictional cafe at any width,
// its banner on a phone; the signboard is a pixel smaller on a phone. An exception is a list of
// steps, and a width takes the step of the narrowest range that holds it. The keys are class
// names of site-demo.module.css.
const TYPE_FLOOR = 12
const SMALLER_BY_DESIGN: Record<string, { floor: number; upTo?: number }[]> = {
  address: [{ floor: 10 }],
  cafeTopline: [{ floor: 10 }, { floor: 9, upTo: 480 }],
  cafeTagline: [{ floor: 11 }],
  promotion: [{ floor: 11, upTo: 480 }],
}

/** Every rendered text below its floor, as «class size text»; an empty list is the goal. */
function textBelowTheFloor(page: Page, width: number): Promise<string[]> {
  return page.evaluate(
    ({ floor, exceptions, width }) => {
      const root = document.querySelector('#top')
      if (!root) throw new Error('No landing on the page')
      // A CSS module class ends with the name written in the source.
      const namesOf = (element: Element) =>
        (element.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((name) => name.split('__').pop() ?? name)
      const found: string[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        const text = node.textContent?.trim()
        // Not rendered: the closed menu, the answer of a closed question.
        if (!parent || !text || parent.getClientRects().length === 0) continue
        const size = parseFloat(getComputedStyle(parent).fontSize)
        let allowed = floor
        for (let element: Element | null = parent; element && element !== root;) {
          for (const name of namesOf(element)) {
            const [step] = (exceptions[name] ?? [])
              .filter(({ upTo = Infinity }) => width <= upTo)
              .sort((first, second) => (first.upTo ?? Infinity) - (second.upTo ?? Infinity))
            if (step) allowed = step.floor
          }
          element = element.parentElement
        }
        if (size < allowed) found.push(`${namesOf(parent).join('.')} ${size}px «${text}»`)
      }
      return found
    },
    { floor: TYPE_FLOOR, exceptions: SMALLER_BY_DESIGN, width },
  )
}

test.describe('type size', () => {
  // Both sides of the breakpoints that used to make captions smaller: 480, 540, 800 and 1100px.
  const WIDTHS = [320, 390, 480, 481, 540, 768, 1024, 1440]

  test(`keeps every text at ${TYPE_FLOOR}px or more`, async ({ page }) => {
    await openAt(page, 320)
    await expect(page.getByRole('slider')).toBeVisible()
    await atWidths(page, WIDTHS, async (width, soft) => {
      soft(await textBelowTheFloor(page, width)).toEqual([])
    })

    // The states bring their own texts: the changed banner, the labels of the window, an open
    // answer, the messages of the form.
    const demo = page.locator('#site-demo')
    await demo.getByRole('button', { name: 'Акция' }).click()
    await applyChange(demo)
    await page.locator('#faq summary').first().click()
    // The form of a lead with its messages under the fields and the consent.
    await page.locator('#lead').getByRole('button', { name: 'Отправить заявку' }).click()
    await expect(page.locator('#lead').getByText('Например, kofeinya.ru')).toBeVisible()
    await atWidths(page, WIDTHS, async (width, soft) => {
      soft(await textBelowTheFloor(page, width), 'in the changed states').toEqual([])
    })
  })
})

test.describe('section headings', () => {
  // 5vw between 32 and 40px in one column, 28px on a phone.
  const expected = (width: number) => (width <= 540 ? 28 : Math.min(40, Math.max(32, width * 0.05)))

  test('are of one size in a single column', async ({ page }) => {
    await openAt(page, 390)
    await atWidths(page, [390, 540, 541, 640, 768, 800], async (width, soft) => {
      const sizes = await page
        .locator('#top h2')
        .evaluateAll((headings) =>
          headings.map((heading) => parseFloat(getComputedStyle(heading).fontSize)),
        )
      // Every section of the page, the systems and the lead among them.
      soft(sizes).toHaveLength(7)
      for (const size of sizes) soft(size).toBeCloseTo(expected(width), 1)
    })
  })

  // «На чём сделан ваш сайт?» and «Скорее всего, подойдёт.»: the break of the markup and no other,
  // from the width where a half fits a line.
  test('keeps each half of the heading of the systems on its line from 541px', async ({ page }) => {
    await openAt(page, 541)
    await atWidths(page, [541, 768, 1024, 1440], async (width, soft) => {
      const lines = await page.locator('#platforms-title').evaluate((heading) => {
        const range = document.createRange()
        range.selectNodeContents(heading)
        const tops = [...range.getClientRects()].map((box) => Math.round(box.top))
        return { count: new Set(tops).size, right: range.getBoundingClientRect().right }
      })
      soft(lines.count).toBe(2)
      soft(lines.right).toBeLessThanOrEqual(width - 24)
    })
  })

  // What a section is about stands under its heading, never beside it.
  test('stand over their subheadings', async ({ page }) => {
    await openAt(page, 390)
    await atWidths(page, [390, 768, 1024, 1440], async (_, soft) => {
      const groups = await page.evaluate(() =>
        ['demo-title', 'platforms-title', 'can-title', 'safety-title', 'pricing-title'].map(
          (id) => {
            const heading = document.getElementById(id)
            const lead = heading?.nextElementSibling
            if (!heading || lead?.localName !== 'p') throw new Error(`#${id} has no subheading`)
            const [over, under] = [heading.getBoundingClientRect(), lead.getBoundingClientRect()]
            return {
              id,
              gap: under.top - over.bottom,
              centred: getComputedStyle(heading).textAlign === 'center',
              lefts: [over.left, under.left],
              middles: [(over.left + over.right) / 2, (under.left + under.right) / 2],
              sizes: [
                parseFloat(getComputedStyle(heading).fontSize),
                parseFloat(getComputedStyle(lead).fontSize),
              ],
            }
          },
        ),
      )
      for (const group of groups) {
        soft(group.gap, group.id).toBeGreaterThanOrEqual(8)
        soft(group.gap, group.id).toBeLessThanOrEqual(24)
        const [heading = NaN, lead = NaN] = group.centred ? group.middles : group.lefts
        soft(Math.abs(heading - lead), group.id).toBeLessThanOrEqual(0.5)
        const [large = NaN, small = NaN] = group.sizes
        soft(small, group.id).toBeLessThan(large)
      }
    })
  })

  test('name the sections in the order of the page', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#top h2')).toHaveText(
      [
        'Попробуйте сами',
        'На чём сделан ваш сайт? Скорее всего, подойдёт.',
        'Что можно поручить',
        'Без вашего «да» сайт не меняется',
        'Тарифы',
        '50 кредитов в подарок за заявку.',
        'Вопросы',
      ],
      // The rendered text: a break of the markup is a break between words.
      { useInnerText: true },
    )
    // Gone with the redesign: the three steps and the final call have no place to come back to.
    for (const id of ['how', 'how-title', 'start-title']) {
      await expect(page.locator(`#${id}`)).toHaveCount(0)
    }
  })
})

test.describe('highlights of the headings', () => {
  const TRANSPARENT = 'rgba(0, 0, 0, 0)'

  test('are one to a heading: a turned plate under the slogan, a level one in a section', async ({
    page,
  }) => {
    await openAt(page, 1440)
    await settled(page)
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('#top h1, #top h2, #hero-title + p')].map((heading) => {
        const marks = [...heading.querySelectorAll('em')].map((mark) => {
          const style = getComputedStyle(mark)
          const plate = getComputedStyle(mark, '::before')
          return {
            color: style.color,
            background: style.backgroundColor,
            // The plate of the slogan is drawn by a pseudo-element, which is turned.
            plate: plate.content === 'none' ? null : plate.backgroundColor,
            turned: plate.content !== 'none' && plate.transform !== 'none',
          }
        })
        // Any other element of a heading in a colour of its own would be a second highlight.
        const coloured = [...heading.querySelectorAll('*')].filter(
          (part) =>
            part.tagName !== 'EM' &&
            getComputedStyle(part).color !== getComputedStyle(heading).color,
        ).length
        return { id: heading.id, text: heading.textContent.trim(), marks, coloured }
      }),
    )
    // The heading of the page, the slogan and the seven sections.
    expect(headings).toHaveLength(9)
    for (const heading of headings) {
      expect(heading.marks.length, heading.text).toBeLessThanOrEqual(1)
      expect(heading.coloured, heading.text).toBe(0)
    }
    // The turned plate belongs to the slogan alone; the heading over it has no highlight.
    expect(headings.find((heading) => heading.id === 'hero-title')?.marks).toEqual([])
    expect(headings.find((heading) => heading.text.includes('Сайт поправим.'))?.marks).toEqual([
      { color: INK, background: TRANSPARENT, plate: MARKER, turned: true },
    ])
    // On the orange field: ink on a level amber plate.
    expect(headings.find((heading) => heading.id === 'platforms-title')?.marks).toEqual([
      { color: INK, background: MARKER, plate: null, turned: false },
    ])
    // The other sections have none.
    const marked = headings.filter((heading) => heading.marks.length > 0)
    expect(marked).toHaveLength(2)
  })

  // The plate is cloned to every line of its words: one piece where they fit a line.
  for (const width of [541, 1440]) {
    test(`keeps a plate in one piece at ${width}px`, async ({ page }) => {
      await openAt(page, width)
      const pieces = await page
        .locator('#platforms-title em')
        .evaluate((mark) => mark.getClientRects().length)
      expect(pieces).toBe(1)
    })
  }
})

test.describe('capabilities', () => {
  const REQUEST = 'Например, вы пишете'
  const RESULT = 'Что изменится на сайте'

  /** The boxes of every row: the category, the two heads of the columns, the request, the result. */
  const rows = (page: Page) =>
    page.locator('#possibilities article').evaluateAll((articles) =>
      articles.map((article) => {
        const [first, second] = article.querySelectorAll('span')
        const [request, result] = article.querySelectorAll('p')
        const heading = article.querySelector('h3')
        if (!first || !second || !request || !result || !heading) {
          throw new Error('A row lacks a part')
        }
        const box = (element: Element) => {
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
          return { left, right, top, bottom, width, height }
        }
        const style = getComputedStyle(request)
        return {
          row: box(article),
          heading: box(heading),
          heads: [first, second].map((head) => ({
            text: head.textContent.replaceAll('\u00a0', ' '),
            ...box(head),
          })),
          request: { ...box(request), text: request.textContent },
          result: { ...box(result), text: result.textContent },
          bubble: { color: style.color, background: style.backgroundColor },
        }
      }),
    )

  test('are six rows of a request and its result', async ({ page }) => {
    await openAt(page, 1440)
    const section = page.locator('#possibilities')
    const table = await rows(page)
    expect(table).toHaveLength(6)
    for (const row of table) {
      // Every row names its cells, so a screen reader hears what each of them is.
      expect(row.heads.map((head) => head.text)).toEqual([REQUEST, RESULT])
      expect(row.request.text?.trim()).not.toBe('')
      expect(row.result.text?.trim()).not.toBe('')
      // The request is a message of the chat: the light text of the page on a dark bubble.
      expect(row.bubble.color).toBe(PAPER)
      expect(contrast(row.bubble.color, row.bubble.background)).toBeGreaterThanOrEqual(7)
      expect(contrast(row.bubble.background, PAPER)).toBeGreaterThanOrEqual(3)
    }
    await expect(section.getByRole('heading', { level: 3 })).toHaveCount(6)
    // The section speaks of what the service does: the caveat about a launch to come is gone.
    await expect(section).not.toContainText('после запуска')
    // What the section is about stands before the table.
    const lead = section.locator('#can-title + p')
    await expect(lead).toBeVisible()
    const leadBottom = await lead.evaluate((node) => node.getBoundingClientRect().bottom)
    expect(leadBottom).toBeLessThanOrEqual(table[0]?.row.top ?? 0)
  })

  test('shows the heads of the columns once, over the cells of the first row', async ({ page }) => {
    await openAt(page, 390)
    await atWidths(page, [390, 541, 768, 800, 1440], async (width, soft) => {
      const [first, ...others] = await rows(page)
      if (!first) throw new Error('The table has no rows')
      const [requestHead, resultHead] = first.heads
      if (!requestHead || !resultHead) throw new Error('The first row has no heads')
      for (const [head, cell] of [
        [requestHead, first.request],
        [resultHead, first.result],
      ] as const) {
        soft(head.width).toBeGreaterThan(100)
        soft(head.left).toBeCloseTo(cell.left, 0)
        soft(head.bottom).toBeLessThanOrEqual(cell.top)
      }
      // A head names the cell right under it: «Например, вы пишете» over a category would read
      // as the head of the categories. In one or two columns the category is the first line of
      // a row, and the head of the requests stands between it and the request.
      if (width <= 800) {
        soft(first.heading.bottom).toBeLessThanOrEqual(requestHead.top)
        soft(first.request.top - requestHead.bottom).toBeLessThanOrEqual(8)
      }
      for (const row of others) {
        for (const head of row.heads) {
          soft(head.width).toBeLessThanOrEqual(1)
          soft(head.height).toBeLessThanOrEqual(1)
        }
      }
    })
  })

  // Between the phone and the desktop a row is two columns under its category. The heads of
  // the columns are seen in the first row only, and the other rows keep no place for them.
  test('sets a row in two columns, as far from the line above as from the line below', async ({
    page,
  }) => {
    await openAt(page, 541)
    await atWidths(page, [541, 640, 768, 800], async (_, soft) => {
      const table = await rows(page)
      soft(table).toHaveLength(6)
      for (const row of table) {
        soft(row.heading.bottom, row.request.text ?? '').toBeLessThanOrEqual(row.request.top)
        soft(row.request.right, row.request.text ?? '').toBeLessThanOrEqual(row.result.left)
        const above = row.heading.top - row.row.top
        // The line under a row is its border of 1px.
        const below = row.row.bottom - 1 - Math.max(row.request.bottom, row.result.bottom)
        soft(Math.abs(above - below), row.request.text ?? '').toBeLessThanOrEqual(1)
      }
    })
  })

  test('sets a row in three columns on a desktop and in one on a phone', async ({ page }) => {
    await openAt(page, 1440)
    for (const row of await rows(page)) {
      expect(row.heading.right).toBeLessThanOrEqual(row.request.left)
      expect(row.request.right).toBeLessThanOrEqual(row.result.left)
      // The longest request stays in one line: a bubble is 48px high.
      expect(row.request.height, row.request.text ?? '').toBeLessThan(60)
      const middle = (box: { top: number; bottom: number }) => (box.top + box.bottom) / 2
      expect(middle(row.heading)).toBeCloseTo(middle(row.request), 0)
      expect(middle(row.result)).toBeCloseTo(middle(row.request), 0)
    }

    await page.setViewportSize({ width: 390, height: 900 })
    for (const row of await rows(page)) {
      expect(row.heading.bottom).toBeLessThanOrEqual(row.request.top)
      expect(row.request.bottom).toBeLessThanOrEqual(row.result.top)
      expect(row.request.left).toBeCloseTo(row.row.left, 0)
      expect(row.request.right).toBeLessThanOrEqual(row.row.right + 0.5)
      expect(row.result.right).toBeLessThanOrEqual(row.row.right + 0.5)
    }
  })
})

test.describe('word in the footer', () => {
  // The sign of the brand closes the word; the row clips what does not fit it. At 541px the
  // word is at its smallest size above the phone, and the row is at its tightest.
  test('ends with the whole sign of the brand', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 541, 768, 1024, 1101, 1440, 1920], async (width, soft) => {
      const word = page.locator('#top > footer > div[aria-hidden="true"]').last()
      await soft(word).toHaveText('радити')
      const sign = word.locator('svg')
      await soft(sign.locator('circle')).toHaveCount(1)
      const boxes = await word.evaluate((row) => {
        const svg = row.querySelector('svg')
        if (!svg) throw new Error('The word has no sign')
        const text = document.createRange()
        text.selectNodeContents(row.firstChild!)
        const footer = row.parentElement
        if (!footer) throw new Error('The word stands outside the footer')
        return {
          row: row.getBoundingClientRect().toJSON(),
          sign: svg.getBoundingClientRect().toJSON(),
          textRight: text.getBoundingClientRect().right,
          fontSize: parseFloat(getComputedStyle(row).fontSize),
          // The right axis of the page: where the lines and the links of the footer end.
          axis:
            footer.getBoundingClientRect().right -
            parseFloat(getComputedStyle(footer).paddingRight),
        }
      })
      // A circle in a square of whole pixels. The size follows the word and is a fraction of a
      // pixel at most widths; in such a box the browser draws the circle cut by its last row.
      soft(boxes.sign.width).toBe(Math.round(boxes.sign.width))
      soft(boxes.sign.height).toBe(boxes.sign.width)
      // As tall as the lowercase letters: 0.55 of the size of the word, to the nearest pixel.
      soft(Math.abs(boxes.sign.width - 0.55 * boxes.fontSize)).toBeLessThanOrEqual(0.5)
      soft(boxes.sign.right).toBeLessThanOrEqual(boxes.row.right + 0.5)
      // The circle of the sign ends on the axis: it has no side bearing to hang over it.
      soft(Math.abs(boxes.sign.right - boxes.axis)).toBeLessThanOrEqual(0.5)
      soft(boxes.sign.left).toBeGreaterThan(boxes.textRight)
      soft(boxes.sign.top).toBeGreaterThanOrEqual(boxes.row.top)
    })
  })
})

test.describe('links of the footer', () => {
  test('lead to the documents and to the map of the site, which is there', async ({
    page,
    request,
  }) => {
    await page.goto('/')
    const links = page.getByRole('navigation', { name: 'Документы' }).getByRole('link')
    const map = links.last()
    await expect(map).toHaveText('Карта сайта')
    await expect(map).toHaveAttribute('href', '/sitemap.xml')
    // A target of 44px, as the documents beside it.
    expect((await map.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect(await links.count()).toBeGreaterThan(1)
    for (const link of await links.all()) {
      const href = await link.getAttribute('href')
      expect((await request.get(href ?? '')).status(), href ?? '').toBe(200)
    }
  })
})

test.describe('demo', () => {
  test('keeps the three requests in one row', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 801, 1440], async (_, soft) => {
      const choice = page.getByRole('group', { name: 'Выберите, что попросить:' })
      await soft(choice.getByRole('button')).toHaveCount(3)
      // The place in the layout, not the painted box: the entrance of the demo turns it a little.
      const tops = await choice
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).offsetTop))
      soft(new Set(tops).size).toBe(1)
      // The author of the message is named in the chat, not smaller than a caption.
      const author = page.locator('#site-demo').getByText('Вы', { exact: true })
      await soft(author).toBeVisible()
      soft(
        await author.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(12)
    })
  })

  // The banner request has the longest new value: on the narrowest phone it does not fit the
  // line of the old one, and the arrow must go to the next line with it.
  test('keeps the arrow of a change on one line with the new value at 320px', async ({ page }) => {
    await openAt(page, 320, 800)
    const demo = page.locator('#site-demo')
    const choice = demo.getByRole('group', { name: 'Выберите, что попросить:' })
    await hydrated(choice.getByRole('button').first())
    for (const request of ['Цена', 'График', 'Акция']) {
      const button = choice.getByRole('button', { name: request })
      if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
      await expect(demo.getByRole('button', { name: 'Применить правку' })).toHaveAttribute(
        'aria-disabled',
        'false',
      )
      const boxes = await demo.getByText('Станет:').evaluate((label) => {
        const value = label.parentElement
        const pair = value?.parentElement
        const arrow = pair?.querySelector('svg')
        const values = pair?.parentElement
        if (!value || !pair || !arrow || !values) throw new Error('The change has no arrow')
        const box = (element: Element) => element.getBoundingClientRect().toJSON()
        return { value: box(value), arrow: box(arrow), values: box(values) }
      })
      const middle = boxes.arrow.top + boxes.arrow.height / 2
      expect(middle, request).toBeGreaterThan(boxes.value.top)
      expect(middle, request).toBeLessThan(boxes.value.bottom)
      expect(boxes.arrow.right, request).toBeLessThanOrEqual(boxes.value.left)
      // The pair does not wrap inside, so it must fit the chat.
      expect(boxes.value.right, request).toBeLessThanOrEqual(boxes.values.right + 0.5)
    }
  })

  // The chosen request is a state, not an action: it must not look like the orange buttons, and
  // it must be told by more than its colour.
  for (const width of [320, 1440]) {
    test(`marks the chosen request with a check on a soft surface at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width)
      const buttons = page
        .getByRole('group', { name: 'Выберите, что попросить:' })
        .getByRole('button')
      await hydrated(buttons.first())

      const read = () =>
        buttons.evaluateAll((elements) =>
          elements.map((element) => {
            const button = element as HTMLElement
            const style = getComputedStyle(button)
            const mark = button.querySelector('svg')
            return {
              pressed: button.getAttribute('aria-pressed'),
              // The place in the layout: the entrance of the demo turns it a little.
              left: button.offsetLeft,
              width: button.offsetWidth,
              weight: style.fontWeight,
              color: style.color,
              background: style.backgroundColor,
              border: style.borderTopColor,
              mark: mark ? getComputedStyle(mark).opacity : 'no mark',
              markHidden: mark?.getAttribute('aria-hidden'),
            }
          }),
        )

      const check = (pills: Awaited<ReturnType<typeof read>>, chosen: number) => {
        expect(pills.map((pill) => pill.pressed)).toEqual(
          pills.map((_, index) => String(index === chosen)),
        )
        // The mark is in every button and seen in the chosen one.
        expect(pills.map((pill) => pill.mark)).toEqual(
          pills.map((_, index) => (index === chosen ? '1' : '0')),
        )
        expect(new Set(pills.map((pill) => pill.markHidden))).toEqual(new Set(['true']))
        // The weight is the same: a bolder label would move the row.
        expect(new Set(pills.map((pill) => pill.weight)).size).toBe(1)
        for (const [index, pill] of pills.entries()) {
          expect(pill.color).toBe(INK)
          expect(pill.background).not.toBe(ACCENT)
          if (index === chosen) {
            expect(pill.border).toBe(ACCENT_TEXT)
            expect(contrast(pill.color, pill.background)).toBeGreaterThanOrEqual(4.5)
            expect(contrast(pill.border, pill.background)).toBeGreaterThanOrEqual(3)
          } else {
            // An outline that bounds the button: 3:1 against the page.
            expect(contrast(pill.border, PAPER)).toBeGreaterThanOrEqual(3)
          }
        }
      }

      const before = await read()
      check(before, 0)
      await buttons.nth(2).click()
      await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true')
      // The mark and the surface come in with a transition.
      await expect(buttons.nth(2).locator('svg')).toHaveCSS('opacity', '1')
      await expect(buttons.nth(0).locator('svg')).toHaveCSS('opacity', '0')
      await page.mouse.move(1, 1)
      await expect(buttons.nth(0)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const after = await read()
      check(after, 2)
      // The room for the mark is kept in every button: the choice moves nothing.
      expect(after.map(({ left, width }) => ({ left, width }))).toEqual(
        before.map(({ left, width }) => ({ left, width })),
      )
    })
  }

  // The changed banner is the longest line of the cafe site: it must take the room of the first
  // one, or the window grows and pushes the chat down.
  for (const width of [320, 390, 801]) {
    test(`keeps the site window as tall when the banner changes at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width)
      const demo = page.locator('#site-demo')
      await demo.getByRole('button', { name: 'Акция' }).click()
      const apply = demo.getByRole('button', { name: 'Применить правку' })
      await expect(apply).toBeVisible()

      const measure = () =>
        demo.evaluate((element) => {
          const banner = element.querySelector<HTMLElement>('[data-phase] [data-selected="true"]')
          const site = banner?.closest<HTMLElement>('[data-phase] > div')
          if (!banner || !site) throw new Error('The demo has no banner in its window')
          const range = document.createRange()
          range.selectNodeContents(banner)
          return {
            text: banner.textContent,
            // The place in the layout: the window of the demo is turned a little.
            window: site.offsetHeight,
            banner: banner.offsetHeight,
            size: parseFloat(getComputedStyle(banner).fontSize),
            // One box per line of the text.
            lines: range.getClientRects().length,
            // The unturned width of the text against the room inside the banner.
            overflow: banner.scrollWidth - banner.clientWidth,
          }
        })

      const before = await measure()
      await apply.click()
      await expect(demo.getByText('Изменено')).toBeVisible()
      const after = await measure()

      expect(before.text).toBe('ХОРОШИЙ ДЕНЬ. ХОРОШИЙ КОФЕ.')
      expect(after.text?.replaceAll('\u00a0', ' ')).toBe('ВТОРОЙ КОФЕ −50% · БЕРИТЕ ДРУГА')
      expect(after.size).toBe(before.size)
      expect(after.size).toBe(width <= 480 ? 11 : 12)
      expect({ ...after, text: '' }).toEqual({ ...before, text: '' })
      expect(after.lines).toBe(1)
      expect(after.overflow).toBeLessThanOrEqual(0)
    })
  }

  test.describe('colours of a change', () => {
    // No motion: the colours are read at once, not in the middle of a transition.
    test.use({ reducedMotion: 'reduce' })

    test('keeps the address readable on the amber bar of a changed site', async ({ page }) => {
      await page.goto('/')
      const demo = page.locator('#site-demo')
      const address = demo.getByText('kroshka.example')
      const bar = address.locator('xpath=..')
      const pair = async () =>
        contrast(
          await address.evaluate((node) => getComputedStyle(node).color),
          await bar.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
      expect(await pair()).toBeGreaterThanOrEqual(4.5)
      const atRest = await address.evaluate((node) => getComputedStyle(node).color)

      await applyChange(demo)
      await expect(bar).toHaveCSS('background-color', MARKER)
      await expect(address).toHaveCSS('color', INK)
      // The lock is drawn with the colour of the text.
      await expect(address.locator('svg')).toHaveCSS('stroke', INK)
      expect(await pair()).toBeGreaterThanOrEqual(4.5)

      await demo.getByRole('button', { name: 'Отменить правку' }).click()
      await expect(demo.getByText('Возвращено')).toBeVisible()
      await expect(address).toHaveCSS('color', atRest)
      expect(await pair()).toBeGreaterThanOrEqual(4.5)
    })

    test('marks the changed banner with amber, as the changed rows', async ({ page }) => {
      await page.goto('/')
      const demo = page.locator('#site-demo')
      // A row is highlighted by a layer of its own, the banner by its own background.
      const marked = () =>
        demo.locator('[data-changed="true"]').evaluate((node) => {
          const layer = getComputedStyle(node, '::before')
          const surface = layer.content === 'none' ? getComputedStyle(node) : layer
          return { background: surface.backgroundColor, color: getComputedStyle(node).color }
        })
      await applyChange(demo)
      const row = await marked()
      expect(row).toEqual({ background: MARKER, color: INK })

      await demo.getByRole('button', { name: 'Акция' }).click()
      await applyChange(demo)
      expect(await marked()).toEqual(row)
    })
  })

  // The banner comes in from the left under a clip, which stays after the entrance: the outline
  // of the changed field stands outside its box and must be inside the clip.
  test('does not cut the outline of the changed banner', async ({ page }) => {
    await page.goto('/')
    const demo = page.locator('#site-demo')
    await demo.getByRole('button', { name: 'Акция' }).click()
    await applyChange(demo)
    await settled(page)
    const banner = await demo.locator('[data-changed="true"]').evaluate((node) => {
      const style = getComputedStyle(node)
      return {
        outline: `${style.outlineStyle} ${style.outlineWidth}`,
        reach: parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth),
        clip: style.clipPath,
      }
    })
    expect(banner.outline).toBe('solid 1px')
    // How far outside the box each side of the clip stands. A side that came from a percentage
    // is computed as calc(0% - 4px).
    const room = (banner.clip.match(/calc\([^)]*\)|-?[\d.]+(?:px|%)/g) ?? []).map((side) =>
      side.startsWith('calc(0% - ')
        ? parseFloat(side.slice('calc(0% - '.length))
        : -parseFloat(side),
    )
    expect(banner.clip.startsWith('inset('), banner.clip).toBe(true)
    expect(room.length, banner.clip).toBeGreaterThan(0)
    for (const side of room) expect(side, banner.clip).toBeGreaterThanOrEqual(banner.reach)
  })

  test('keeps the focus on the action while the change is being applied', async ({ page }) => {
    await page.goto('/')
    const demo = page.locator('#site-demo')
    const action = demo.locator('button[data-undo]')
    await hydrated(action)
    await action.focus()
    await page.keyboard.press('Enter')
    // Busy, not disabled: the button stays the stop of the keyboard and says what it is doing.
    await expect(action).toHaveText('Применяю…')
    await expect(action).toHaveAttribute('aria-disabled', 'true')
    await expect(action).toHaveJSProperty('disabled', false)
    await expect(action).toHaveCSS('cursor', 'wait')
    await expect(action).toBeFocused()
    // A key pressed during the pause neither finishes nor undoes the change.
    await page.keyboard.press('Enter')
    await expect(demo.getByText('Изменено')).toBeVisible()
    await expect(action).toHaveText('Отменить правку')
    await expect(action).toHaveAttribute('aria-disabled', 'false')
    await expect(action).toBeFocused()
    // The next key goes to the same button without looking for it again.
    await page.keyboard.press('Enter')
    await expect(demo.getByText('Возвращено')).toBeVisible()
    await expect(action).toBeFocused()
  })

  test('applies and undoes a change three times in a row', async ({ page }) => {
    await page.goto('/')
    const demo = page.locator('#site-demo')
    await expect(demo.getByText('До правки')).toBeVisible()

    for (let round = 0; round < 3; round++) {
      await demo.getByRole('button', { name: /^Применить (правку|снова)$/ }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
      await demo.getByRole('button', { name: 'Отменить правку' }).click()
      await expect(demo.getByText('Возвращено')).toBeVisible()
    }
    await expect(demo.getByRole('button', { name: 'Применить снова' })).toBeEnabled()
  })
})

test.describe('outlines of controls', () => {
  // No motion: the colours are read at once, not in the middle of a transition.
  test.use({ reducedMotion: 'reduce' })

  const outline = (element: Locator) =>
    element.evaluate((node) => getComputedStyle(node).borderTopColor)

  test('bound the slider and the undo of the chat at 3:1', async ({ page }) => {
    await page.goto('/')
    // The empty part of the track is a line of its own under the filled one.
    const track = await page
      .getByRole('slider')
      .evaluate((node) => getComputedStyle(node).backgroundImage)
    const layers = track.match(/linear-gradient\(/g) ?? []
    expect(layers).toHaveLength(2)
    const line = track.slice(track.lastIndexOf('linear-gradient('))
    const lineColor = /(color\(srgb [^)]+\)|rgb\([^)]+\))/.exec(line)?.[1] ?? ''
    expect(contrast(lineColor, PAPER)).toBeGreaterThanOrEqual(3)
    // The filled part keeps the colour of the accent text.
    expect(track.slice(0, track.lastIndexOf('linear-gradient('))).toContain(ACCENT_TEXT)

    const demo = page.locator('#site-demo')
    await demo.getByRole('button', { name: 'Применить правку' }).click()
    const undo = demo.getByRole('button', { name: 'Отменить правку' })
    await expect(undo).toBeVisible()
    await page.mouse.move(1, 1)
    expect(contrast(await outline(undo), INK)).toBeGreaterThanOrEqual(3)
    // With the pointer on it the outline is the lightest colour of the dark panel.
    await undo.hover()
    expect(await outline(undo)).toBe(PAPER)
    await expect(undo).toHaveCSS('color', PAPER)
    expect(
      contrast(PAPER, await undo.evaluate((node) => getComputedStyle(node).backgroundColor)),
    ).toBeGreaterThanOrEqual(4.5)
  })

  // The track of the slider is a border under the box of the thumb, which a margin lifts onto
  // the line: a wrong margin would hang the thumb above or below it.
  test('centre the thumb of the slider on the line of its track', async ({ page }) => {
    await openAt(page, 390, 844)
    const slider = page.getByRole('slider')
    await slider.scrollIntoViewIfNeeded()
    const middle = (rows: number[]) => ((rows[0] ?? NaN) + (rows.at(-1) ?? NaN) + 1) / 2
    // The line beyond the thumb: 30 tasks of 10 to 300 leave the thumb near the left end.
    const line = await paintedRows(page, slider, (width) => width * 0.75)
    expect(line.rows.length).toBeGreaterThanOrEqual(1)
    expect(line.rows.length).toBeLessThanOrEqual(2)
    expect(Math.abs(middle(line.rows) - line.height / 2)).toBeLessThanOrEqual(1)
    // The thumb is 24px wide and travels the width without its own: its centre is here.
    const thumb = await paintedRows(page, slider, (width) => 12 + (width - 24) * (20 / 290))
    expect(thumb.rows.length).toBeGreaterThanOrEqual(22)
    expect(thumb.rows.length).toBeLessThanOrEqual(26)
    expect(Math.abs(middle(thumb.rows) - middle(line.rows))).toBeLessThanOrEqual(1)
  })

  test('bound the button of the mobile menu at 3:1', async ({ page }) => {
    await openAt(page, 390, 844)
    const toggle = page.getByRole('button', { name: 'Открыть меню' })
    expect(contrast(await outline(toggle), PAPER)).toBeGreaterThanOrEqual(3)
  })
})

test.describe('safety', () => {
  test('tells three facts, numbered for the eye alone, with nothing to press', async ({ page }) => {
    await page.goto('/')
    const safety = page.locator('#safety')
    const facts = safety.getByRole('listitem')
    await expect(facts).toHaveCount(3)
    await expect(safety.getByRole('heading', { level: 3 })).toHaveText([
      'Сначала черновик',
      'Отмена за 7 дней',
      'Опасное — только с подтверждением',
    ])
    for (const [index, number] of ['01', '02', '03'].entries()) {
      const figure = facts.nth(index).locator('span').first()
      await expect(figure).toHaveText(number)
      await expect(figure).toHaveAttribute('aria-hidden', 'true')
      await expect(figure).toHaveCSS('color', MARKER)
      await expect(facts.nth(index).locator('p')).not.toBeEmpty()
    }
    // The card with the undo button is gone: the section is read, not played.
    await expect(safety.getByRole('button')).toHaveCount(0)
    await expect(safety.getByRole('link')).toHaveCount(0)
    await expect(safety.getByRole('status')).toHaveCount(0)
  })

  for (const width of [390, 1440]) {
    test(`keeps every text on the dark field readable at ${width}px`, async ({ page }) => {
      await openAt(page, width)
      const { field, texts } = await page.locator('#safety').evaluate((section) => {
        const field = getComputedStyle(section).backgroundColor
        const found: { text: string; color: string; size: number }[] = []
        const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement
          const text = node.textContent?.trim()
          if (!parent || !text || parent.getClientRects().length === 0) continue
          // The surface right under the text: every text of the section stands on its field.
          let surface = 'rgba(0, 0, 0, 0)'
          for (let element: Element | null = parent; element; element = element.parentElement) {
            surface = getComputedStyle(element).backgroundColor
            if (surface !== 'rgba(0, 0, 0, 0)') break
          }
          if (surface !== field) throw new Error(`«${text}» stands on a surface of its own`)
          const style = getComputedStyle(parent)
          found.push({ text, color: style.color, size: parseFloat(style.fontSize) })
        }
        return { field, texts: found }
      })

      expect(field).toBe(INK)
      // The heading and its lead, then a number, a name and a text for each of the three facts.
      expect(texts.length).toBeGreaterThanOrEqual(11)
      expect(texts.filter(({ color }) => contrast(color, field) < 4.5)).toEqual([])
      expect(texts.filter(({ size }) => size < 14)).toEqual([])
    })
  }

  test('sets the facts in a row on a desktop and in a column from a tablet down', async ({
    page,
  }) => {
    await openAt(page, 1440)
    await atWidths(page, [1440, 1024, 801, 800, 390], async (width, soft) => {
      const facts = await page.locator('#safety li').evaluateAll((items) =>
        items.map((item) => {
          const { left, right, top, bottom, width } = item.getBoundingClientRect()
          return { left, right, top, bottom, width }
        }),
      )
      const [first, second, third] = facts
      if (!first || !second || !third) throw new Error('The safety block has no three facts')
      for (const fact of facts) {
        soft(fact.width).toBeCloseTo(first.width, 0)
        soft(fact.right).toBeLessThanOrEqual(width)
      }
      if (width > 800) {
        soft(new Set(facts.map((fact) => Math.round(fact.top))).size).toBe(1)
        soft(second.left).toBeGreaterThan(first.right)
        soft(third.left).toBeGreaterThan(second.right)
      } else {
        soft(new Set(facts.map((fact) => Math.round(fact.left))).size).toBe(1)
        soft(second.top).toBeGreaterThanOrEqual(first.bottom)
        soft(third.top).toBeGreaterThanOrEqual(second.bottom)
      }
    })
  })
})

test.describe('pricing', () => {
  test('offers one action under the plans and marks the plan without a button', async ({
    page,
  }) => {
    await page.goto('/')
    const pricing = page.locator('#pricing')
    const plans = pricing.locator('article')
    await expect(plans).toHaveCount(3)
    await expect(plans.getByRole('link')).toHaveCount(0)
    await expect(pricing.getByRole('link')).toHaveCount(1)
    // The action of the page, by its whole name: it leads a guest to the form of a lead.
    await expect(pricing.getByRole('link', { name: 'Подключить сайт бесплатно' })).toHaveAttribute(
      'href',
      '#lead',
    )

    // The recommended plan is told apart by its label and its surface, not by a button of its own.
    const recommended = plans.filter({ hasText: 'Ваш вариант' })
    await expect(recommended).toHaveCount(1)
    const background = (plan: typeof plans) =>
      plan.evaluate((element) => getComputedStyle(element).backgroundColor)
    const others = plans.filter({ hasNotText: 'Ваш вариант' })
    expect(await background(recommended)).not.toBe(await background(others.first()))
    expect(await background(others.first())).toBe(await background(others.last()))
  })

  // Three columns of 211 to 300px: the description of one plan wraps, of another does not.
  test('keeps the prices of the plans on one line', async ({ page }) => {
    await openAt(page, 700)
    await atWidths(page, [700, 768, 900], async (width, soft) => {
      const plans = page.locator('#pricing article')
      await soft(plans).toHaveCount(3)
      const rows = await plans.evaluateAll((articles) =>
        articles.map((article) => {
          const [description, price] = article.querySelectorAll('p')
          const list = article.querySelector('ul')
          if (!description || !price || !list) throw new Error('A plan has no price or list')
          const range = document.createRange()
          range.selectNodeContents(description)
          return {
            lines: new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size,
            price: price.getBoundingClientRect().top,
            list: list.getBoundingClientRect().top,
          }
        }),
      )
      // Up to 768px the descriptions take a different number of lines; without that the check
      // would hold by itself.
      if (width <= 768) soft(new Set(rows.map((row) => row.lines)).size).toBeGreaterThan(1)
      soft(new Set(rows.map((row) => row.price)).size).toBe(1)
      soft(new Set(rows.map((row) => row.list)).size).toBe(1)
    })
  })

  // A price is set as the expressive numbers of the page: in the face of the headings, with
  // digits of one width, the ruble sign small beside it. «19 990 ₽» is the widest of the three.
  test('sets the prices in the face of the headings, whole inside their columns', async ({
    page,
  }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 768, 1440], async (_, soft) => {
      const pricing = page.locator('#pricing')
      await soft(pricing.locator('article')).toHaveCount(3)
      const read = await pricing.evaluate((section) => {
        const heading = section.querySelector('h2')
        const count = section.querySelector('output')
        if (!heading || !count) throw new Error('The pricing has no heading or no count')
        const price = (strong: Element | null | undefined, column: Element | null | undefined) => {
          const sign = strong?.querySelector('small')
          if (!strong || !sign || !column) throw new Error('A price has no number, sign or column')
          const style = getComputedStyle(strong)
          const range = document.createRange()
          range.selectNodeContents(strong)
          // The digits alone: the small sign has a line box of its own height beside them.
          const digits = document.createRange()
          digits.selectNode(strong.firstChild!)
          const number = digits.getBoundingClientRect()
          const signBox = sign.getBoundingClientRect()
          const inner = getComputedStyle(column)
          return {
            text: strong.textContent,
            family: style.fontFamily,
            weight: style.fontWeight,
            numeric: style.fontVariantNumeric,
            size: parseFloat(style.fontSize),
            signFamily: getComputedStyle(sign).fontFamily,
            signSize: parseFloat(getComputedStyle(sign).fontSize),
            lines: digits.getClientRects().length,
            signBeside:
              signBox.left >= number.right - 1 &&
              signBox.bottom > number.top &&
              signBox.top < number.bottom,
            right: range.getBoundingClientRect().right,
            columnRight: column.getBoundingClientRect().right - parseFloat(inner.paddingRight),
          }
        }
        const total = [...section.querySelectorAll('p > strong')].find(
          (strong) => !strong.closest('article'),
        )
        return {
          heading: getComputedStyle(heading).fontFamily,
          body: getComputedStyle(section).fontFamily,
          count: parseFloat(getComputedStyle(count).fontSize),
          total: price(total, total?.parentElement?.parentElement),
          plans: [...section.querySelectorAll('article')].map((plan) =>
            price(plan.querySelector('p > strong'), plan),
          ),
        }
      })
      soft(read.plans.map((plan) => plan.text?.replaceAll('\u00a0', ' '))).toContain('19 990 ₽')
      for (const price of [read.total, ...read.plans]) {
        soft(price.family, price.text ?? '').toBe(read.heading)
        soft(price.weight).toBe('500')
        soft(price.numeric).toBe('tabular-nums')
        soft(price.signFamily).toBe(read.body)
        soft(price.signSize).toBeLessThan(price.size / 2)
        soft(price.lines, price.text ?? '').toBe(1)
        soft(price.signBeside, price.text ?? '').toBe(true)
        soft(price.right, price.text ?? '').toBeLessThanOrEqual(price.columnRight + 0.5)
      }
      // The sum of the calculator stays its main number: the count of tasks is a step smaller.
      soft(read.count).toBeLessThan(read.total.size)
    })
  })

  // The rows under the plans repeat the inset of a plan: what they say starts on the vertical
  // where the text of a plan starts. In one column they go back to the edge of the page text.
  test('starts the rows under the plans where the text of a plan starts', async ({ page }) => {
    await openAt(page, 390)
    await atWidths(page, [390, 768, 1024, 1440], async (width, soft) => {
      const pricing = page.locator('#pricing')
      await soft(pricing.locator('article')).toHaveCount(3)
      const edges = await pricing.evaluate((section) => {
        const text = (element: Element | null | undefined) => {
          if (!element) throw new Error('The pricing has no such text')
          const range = document.createRange()
          range.selectNodeContents(element)
          const box = range.getBoundingClientRect()
          return { left: box.left, right: box.right }
        }
        // The page sets non-breaking spaces; the beginnings are typed with plain ones.
        const paragraph = (start: string) =>
          [...section.querySelectorAll('p')].find((p) =>
            p.textContent.replaceAll('\u00a0', ' ').startsWith(start),
          )
        const action = section.querySelector('a[href="#lead"]')?.getBoundingClientRect()
        const lastRule = section.querySelector('article:last-of-type ul')?.getBoundingClientRect()
        if (!action || !lastRule) throw new Error('The pricing has no action or no plan')
        return {
          heading: text(section.querySelector('h2')).left,
          plans: [...section.querySelectorAll('article h3')].map((name) => text(name).left),
          included: text(paragraph('В каждый тариф')).left,
          charged: text(paragraph('Списываем только за выполненную работу')).left,
          packs: text(paragraph('Кредитов не хватит')).left,
          vat: text(paragraph('Цены в')).left,
          action: { left: action.left, right: action.right },
          lastPlanRight: lastRule.right,
        }
      })
      const [first = NaN, second = NaN, third = NaN] = edges.plans
      if (width <= 680) {
        for (const left of [
          edges.included,
          edges.charged,
          edges.packs,
          edges.vat,
          edges.action.left,
        ]) {
          soft(left).toBeCloseTo(edges.heading, 1)
        }
        return
      }
      soft(edges.included).toBeCloseTo(first, 1)
      // The rule of the charge, the pack and the currency: one row under the three plans.
      soft(edges.charged).toBeCloseTo(first, 1)
      soft(edges.packs).toBeCloseTo(second, 1)
      soft(edges.vat).toBeCloseTo(third, 1)
      // The action ends where the text of the third plan ends, and starts with it where the
      // column is wide enough for the label.
      soft(edges.action.right).toBeCloseTo(edges.lastPlanRight, 1)
      if (width >= 1024) soft(edges.action.left).toBeCloseTo(third, 1)
      else soft(edges.action.right - edges.action.left).toBeCloseTo(240, 1)
    })
  })

  // The line by the action tells what the registration gives before a tariff is chosen: the
  // gift. It is several lines long, as wide as the action and under it.
  test('tells of the gift of the registration by the action under the plans', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 768, 1024, 1440], async (width, soft) => {
      await soft(page.locator('#pricing article')).toHaveCount(3)
      const note = pricingAction(page).locator('xpath=following-sibling::p')
      await soft(note).toHaveText(
        'При регистрации — 50 кредитов в подарок: хватит на несколько небольших правок. Тариф выберете позже.',
      )
      const edges = await note.evaluate((paragraph) => {
        const action = paragraph.previousElementSibling?.getBoundingClientRect()
        if (!action) throw new Error('The note has no action above it')
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        const text = range.getBoundingClientRect()
        return {
          left: text.left,
          right: text.right,
          top: text.top,
          action: { left: action.left, right: action.right, bottom: action.bottom },
          page: document.documentElement.scrollWidth,
        }
      })
      soft(edges.left).toBeGreaterThanOrEqual(edges.action.left - 0.5)
      soft(edges.right).toBeLessThanOrEqual(edges.action.right + 0.5)
      soft(edges.top).toBeGreaterThanOrEqual(edges.action.bottom)
      soft(edges.page).toBeLessThanOrEqual(width)
    })
  })

  // The slider counts tasks: the line under its question says what a task is and how many
  // credits the calculator takes for one, and the slider is described by that line.
  test('says under the slider how many credits a task is counted at', async ({ page }) => {
    await page.goto('/')
    const pricing = page.locator('#pricing')
    await expect(
      pricing.getByText('Подвиньте ползунок — подберём тариф под число ваших задач.'),
    ).toBeVisible()
    const slider = pricing.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
    const hint = pricing.locator(`[id="${await slider.getAttribute('aria-describedby')}"]`)
    await expect(hint).toHaveText(
      'Задача — одна ваша просьба. В расчёте берём 11 кредитов на задачу — это среднее: поменять цену или фото стоит обычно 5 кредитов, добавить блок или страницу — 15–25.',
    )
    await expect(hint).toBeVisible()
  })

  // The longest result line: a plan, its packs in words and the sum below.
  for (const width of [320, 390]) {
    test(`keeps the result in words inside its column at ${width}px`, async ({ page }) => {
      await openAt(page, width)
      const slider = page.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
      await hydrated(slider)
      await slider.fill('120')
      // The sentence of the result; the name of the plan is an element of its own inside it.
      const result = page.locator('#pricing p').filter({ hasText: /^Тариф «Бизнес»/ })
      // 120 tasks at eleven credits each: the 600 of «Бизнес» and eight packs of a hundred.
      await expect(result).toContainText('и 8 дополнительных пакетов по 100 кредитов')
      await expect(page.locator('#pricing').getByText(/6.990.₽ \+ 8 × 1.490.₽/)).toBeVisible()
      const edges = await result.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const text = range.getBoundingClientRect()
        const column = element.parentElement!.getBoundingClientRect()
        return {
          text: text.right,
          column: column.right,
          page: document.documentElement.scrollWidth,
        }
      })
      expect(edges.text).toBeLessThanOrEqual(edges.column + 0.5)
      expect(edges.page).toBeLessThanOrEqual(width)
    })
  }

  test('moves the slider from the keyboard and names the value', async ({ page }) => {
    await page.goto('/')
    const slider = page.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
    await expect(slider).toHaveAttribute('aria-valuetext', '30 задач в месяц')
    await slider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveAttribute('aria-valuetext', '35 задач в месяц')
  })

  test('announces the result of the slider once it rests, from one live region', async ({
    page,
  }) => {
    await page.goto('/')
    const pricing = page.locator('#pricing')
    const slider = pricing.getByRole('slider')
    const announcement = pricing.locator('[aria-live]')
    await expect(announcement).toHaveCount(1)
    await expect(announcement).toHaveText('')
    // The count above the slider is for the eye: the slider names its value itself.
    await expect(pricing.locator('output')).toHaveText('30')
    await expect(pricing.getByRole('status')).toHaveCount(0)

    await hydrated(slider)
    await slider.focus()
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
    await expect(pricing.locator('output')).toHaveText('45')
    // 45 tasks are 495 credits: «Бизнес» alone is cheaper than «Старт» with four packs.
    await expect(announcement).toHaveText(
      /^Тариф «Бизнес», 6.990 ₽ в месяц, в среднем около 155 ₽ за задачу\. Небольшая правка — около 58 ₽$/,
    )
    // Heard, not seen: the region takes no room on the page.
    const box = await announcement.boundingBox()
    expect(box?.width).toBeLessThanOrEqual(1)
    expect(box?.height).toBeLessThanOrEqual(1)
  })
})

test.describe('navigation and questions', () => {
  test('opens the mobile menu and closes it on Escape', async ({ page }) => {
    await openAt(page, 390, 844)
    await page.getByRole('button', { name: 'Открыть меню' }).click()
    const menu = page.getByRole('navigation', { name: 'Мобильная навигация' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(page.getByRole('button', { name: 'Открыть меню' })).toBeFocused()
  })

  test('closes the mobile menu on a press outside the header and when the focus goes on', async ({
    page,
  }) => {
    await openAt(page, 390, 844)
    const toggle = menuToggle(page)
    const menu = page.getByRole('navigation', { name: 'Мобильная навигация' })
    await toggle.click()
    await expect(menu).toBeVisible()
    // The gutter of the page below the menu: a press there starts nothing else.
    await page.mouse.click(5, 700)
    await expect(menu).toBeHidden()

    await toggle.click()
    await expect(menu).toBeVisible()
    await menu.getByRole('link').last().focus()
    await page.keyboard.press('Shift+Tab')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(menu).toBeHidden()
    // The focus went on to the page; the menu did not pull it back.
    await expect(toggle).not.toBeFocused()
  })

  test('lets the open menu scroll with the page in a window lower than the menu', async ({
    page,
  }) => {
    const header = page.locator('#top > header')
    // The room that an anchor keeps for a sticky header.
    const section = page.locator('#demo')
    await openAt(page, 320, 844)
    await expect(header).toHaveCSS('position', 'sticky')
    await expect(section).toHaveCSS('scroll-margin-top', '84px')

    // A window of 1280x1024 at a zoom of 400%: the menu under a sticky header would not fit,
    // and the links below the window could not be reached.
    await page.setViewportSize({ width: 320, height: 256 })
    await expect(header).toHaveCSS('position', 'relative')
    await expect(section).toHaveCSS('scroll-margin-top', '0px')
    await header.getByRole('button', { name: 'Открыть меню' }).click()
    const menu = page.getByRole('navigation', { name: 'Мобильная навигация' })
    await expect(menu).toBeVisible()
    const last = menu.getByRole('link').last()
    const bottom = async () => {
      const box = await last.boundingBox()
      if (!box) throw new Error('The menu has no last link')
      return box.y + box.height
    }
    expect(await bottom()).toBeGreaterThan(256)
    await page.evaluate(() => window.scrollTo({ top: 200, behavior: 'instant' }))
    await expect(menu).toBeVisible()
    expect(await bottom()).toBeLessThanOrEqual(256)
  })

  test('sets the questions a step above their answers', async ({ page }) => {
    await openAt(page, 320)
    const first = page.locator('#faq details').first()
    await first.locator('summary').click()
    await expect(first.locator('p')).toBeVisible()
    await atWidths(page, [320, 390, 1440], async (width, soft) => {
      const questions = await page.locator('#faq summary').evaluateAll((summaries) =>
        summaries.map((summary) => {
          const style = getComputedStyle(summary)
          const text = summary.firstChild
          const sign = summary.querySelector('span')
          if (!text || !sign) throw new Error('A question has no text or no sign')
          const range = document.createRange()
          range.selectNodeContents(text)
          const box = summary.getBoundingClientRect()
          const signBox = sign.getBoundingClientRect()
          return {
            size: parseFloat(style.fontSize),
            weight: Number(style.fontWeight),
            leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
            height: box.height,
            lines: new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size,
            // The sign stands at the middle of the question, however many lines it takes.
            signOffset: signBox.top + signBox.height / 2 - (box.top + box.height / 2),
          }
        }),
      )
      const answer = await first
        .locator('p')
        .evaluate((paragraph) => parseFloat(getComputedStyle(paragraph).fontSize))

      soft(questions).toHaveLength(5)
      for (const question of questions) {
        soft(question.size).toBe(width <= 540 ? 17 : 18)
        soft(question.weight).toBe(500)
        soft(question.leading).toBeCloseTo(1.35, 2)
        soft(question.height).toBeGreaterThanOrEqual(44)
        soft(question.lines).toBeLessThanOrEqual(2)
        soft(Math.abs(question.signOffset)).toBeLessThanOrEqual(1)
      }
      soft(answer).toBe(15)
    })
  })

  test('opens the first question', async ({ page }) => {
    await page.goto('/')
    const question = page.locator('#faq details').first()
    await question.locator('summary').click()
    await expect(question).toHaveAttribute('open', '')
    await expect(question.locator('p')).toBeVisible()
  })

  // Five questions in the order of a visitor's doubts. The unit of the tariffs is explained by
  // what a request usually costs; the question «Что такое кредит?» of its own is gone.
  test('asks five questions and answers what one change costs', async ({ page }) => {
    await page.goto('/')
    const questions = page.locator('#faq details')
    await expect(questions.locator('summary')).toHaveText(QUESTIONS)
    const question = questions.filter({
      has: page.locator('summary', { hasText: 'Сколько стоит одна правка?' }),
    })
    await expect(question).toHaveCount(1)
    await hydrated(question.locator('summary'))
    await question.locator('summary').click()
    await expect(question).toHaveAttribute('open', '')
    await expect(question.locator('p')).toBeVisible()
    await expect(question.locator('p')).toHaveText(
      'Работу мы считаем в кредитах. Поменять цену, текст или фото — обычно 5 кредитов, добавить блок или страницу — 15–25. Сколько это в рублях, написано в карточке каждого тарифа. Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит.',
    )
    // The lead of the section with its «?» is gone: the heading alone stands over the questions.
    await expect(page.locator('#faq-title')).toHaveText('Вопросы')
    await expect(page.locator('#faq-title + p')).toHaveCount(0)
  })
})

test.describe('accessibility rules', () => {
  // No motion: axe reads the colours, and a text that is still coming in has not its own yet.
  test.use({ reducedMotion: 'reduce' })

  const violations = async (page: Page) => {
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    return report.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    )
  }

  test('reads the terms of the first screen as a list', async ({ page }) => {
    await page.goto('/')
    const list = firstScreen(page).getByRole('list')
    await expect(list.getByRole('listitem')).toHaveText(TERMS)
    await expect(list).toHaveCSS('list-style-type', 'none')
    await expect(list).toHaveCSS('padding-left', '0px')
  })

  for (const width of [390, 1440]) {
    test(`hold in every state of the page at ${width}px`, async ({ page }) => {
      await openAt(page, width)
      await expect(page.getByRole('slider')).toBeVisible()
      expect(await violations(page)).toEqual([])

      // The change applied, a question open, the form of a lead with its messages.
      const demo = page.locator('#site-demo')
      await applyChange(demo)
      await page.locator('#faq summary').first().click()
      await expect(page.locator('#faq details').first().locator('p')).toBeVisible()
      const lead = page.locator('#lead')
      await lead.getByRole('button', { name: 'Отправить заявку' }).click()
      await expect(lead.getByText('Например, kofeinya.ru')).toBeVisible()
      expect(await violations(page)).toEqual([])

      // The lead sent: the card of the answer in the place of the form.
      await page.route('**/api/leads', (route) => route.fulfill({ json: { ok: true } }))
      await fillLead(page, { site: 'kofeinya.ru', contact: '+7 900 000-00-00' })
      await lead.getByRole('button', { name: 'Отправить заявку' }).click()
      await expect(lead.getByRole('status')).toBeVisible()
      expect(await violations(page)).toEqual([])

      if (width <= 800) {
        await page.getByRole('button', { name: 'Открыть меню' }).click()
        await expect(page.getByRole('navigation', { name: 'Мобильная навигация' })).toBeVisible()
        expect(await violations(page)).toEqual([])
      }
    })
  }
})

test.describe('selection', () => {
  test('is seen on every field of the page', async ({ page }) => {
    await page.goto('/')
    const selection = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => {
          const style = getComputedStyle(node, '::selection')
          return { color: style.color, background: style.backgroundColor }
        })
    // Ink with amber letters shows on the paper, on the amber and on the accent alike.
    const onLight = { color: MARKER, background: INK }
    for (const selector of [
      '#hero-title',
      '#hero-title + p',
      '#demo-title',
      // The orange field.
      '#platforms h2',
      '#pricing h3',
      '#site-demo > p',
      '#site-demo [role="group"] button',
    ]) {
      expect(await selection(selector), selector).toEqual(onLight)
    }
    // On the dark surfaces the pair is turned over: ink on ink would be no selection at all.
    // Every one of them is read, so a failure names all the surfaces that lost their rule.
    const onDark = { color: INK, background: MARKER }
    for (const selector of [
      // The chocolate field of the safety block.
      '#safety h2',
      '#safety li p',
      // The ink bubble of the answer under the running line, and the ink plate over the lead.
      '#platforms p:text("Подойдёт. Подключим")',
      '#lead [data-reveal] > span',
      '#site-demo [aria-label="Демонстрационный чат"] strong',
      '#site-demo [aria-live]',
      '#top > footer nav a',
      // The dark bubble of a request on the paper.
      '#possibilities article p',
    ]) {
      const surface = await page
        .locator(selector)
        .first()
        .evaluate((node) => {
          let colour = 'rgba(0, 0, 0, 0)'
          for (let element: Element | null = node; element; element = element.parentElement) {
            colour = getComputedStyle(element).backgroundColor
            if (colour !== 'rgba(0, 0, 0, 0)') break
          }
          return colour
        })
      // The check is of a dark surface indeed.
      expect.soft(contrast(surface, PAPER), selector).toBeGreaterThanOrEqual(7)
      expect.soft(await selection(selector), selector).toEqual(onDark)
    }
  })
})

test.describe('system dark theme', () => {
  test.use({ colorScheme: 'dark' })

  const documentColours = (page: Page) =>
    page.evaluate(() => ({
      scheme: getComputedStyle(document.documentElement).colorScheme,
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    }))
  // The landing is light, and so is the document around it and the chrome of the browser.
  const LIGHT = { scheme: 'light', html: PAPER, body: PAPER, themeColor: '#FFF8EC' }

  test('keeps the document around the landing light', async ({ page }) => {
    await page.goto('/')
    expect(await documentColours(page)).toEqual(LIGHT)
    await expect(page.locator('#top')).toHaveCSS('background-color', PAPER)
  })

  test('keeps it light when the theme cookie asks for the dark theme', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: 'theme', value: 'dark', url: baseURL ?? '' }])
    await page.goto('/')
    expect(await documentColours(page)).toEqual(LIGHT)
  })

  for (const path of ['/sign-in', '/terms/user-agreement']) {
    test(`leaves ${path} in the theme of the visitor`, async ({ page }) => {
      await page.goto(path)
      const colours = await documentColours(page)
      expect(colours.body).toBe(INK)
      expect(colours.scheme).not.toBe('light')
      expect(colours.themeColor).toBeUndefined()
    })
  }

  test('gives the theme back on the way from the landing to the sign-in', async ({ page }) => {
    await page.goto('/')
    const signIn = page.locator('#top > header a[href="/sign-in"]')
    await hydrated(page.getByRole('button', { name: 'Применить правку' }))
    await signIn.click()
    await page.waitForURL('**/sign-in')
    // A client transition: the stylesheet of the landing stays, its page is gone.
    await expect(page.locator('body')).toHaveCSS('background-color', INK)
    expect((await documentColours(page)).themeColor).toBeUndefined()
  })
})

test.describe('scroll on the way between pages', () => {
  // The landing scrolls its anchors smoothly. A change of the route must still jump: Next 16
  // leaves the scroll behaviour of the page alone unless the root element opts out, and without
  // that a visitor would watch the new page travel to its top.

  /** Records every position that the window passes from now on. */
  const record = (page: Page) =>
    page.evaluate(() => {
      const positions: number[] = []
      Object.assign(window, { scrollPositions: positions })
      window.addEventListener('scroll', () => positions.push(Math.round(window.scrollY)))
    })
  /** The recorded positions; `null` when the document was loaded anew and the record is gone. */
  const recorded = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { scrollPositions?: number[] }).scrollPositions ?? null,
    )

  test('opts the root element out of the smooth scroll for a change of the route', async ({
    page,
  }) => {
    await page.goto('/')
    const root = page.locator('html')
    // The page itself is smooth once its fonts are in: that is what the attribute sets aside on
    // the way.
    await expect(root).toHaveAttribute('data-fonts', 'ready')
    await expect(root).toHaveCSS('scroll-behavior', 'smooth')
    await expect(root).toHaveAttribute('data-scroll-behavior', 'smooth')
  })

  test('opens the landing at its top at once after a scrolled legal page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/terms/user-agreement')
    const home = page.getByRole('link', { name: 'Радити — на главную' }).first()
    await hydrated(home)
    // The browser reports a scroll with the next frame: the record starts after this one is told.
    await page.evaluate(async () => {
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
      window.scrollTo({ top: 700, behavior: 'instant' })
      await frame()
      await frame()
    })
    const start = await page.evaluate(() => Math.round(window.scrollY))
    expect(start).toBeGreaterThan(500)
    await record(page)
    // Not a click of the pointer: the header of a legal page is not sticky, and the browser
    // would scroll the page up to the link before the press.
    await home.dispatchEvent('click')
    await expect(page.locator('#hero-title')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY), OFTEN).toBe(0)
    await settled(page)
    // A client transition: the record of the first page is still there. A jump is one position;
    // a smooth scroll would pass dozens on its way.
    const passed = await recorded(page)
    expect([...new Set(passed)]).toEqual([0])
  })

  test('jumps on the way from a scrolled landing to the sign-in and back', async ({ page }) => {
    await openAt(page, 1440)
    // The plans are in: the page is as tall as it will be.
    await expect(page.getByRole('slider')).toBeVisible()
    const signIn = page.getByRole('banner').getByRole('link', { name: 'Войти' })
    await hydrated(signIn)
    await page.evaluate(() => window.scrollTo({ top: 2400, behavior: 'instant' }))
    const start = await page.evaluate(() => Math.round(window.scrollY))
    expect(start).toBe(2400)
    await record(page)
    // The header is sticky: its button is in the window, and the press scrolls nothing.
    await signIn.click()
    await page.waitForURL('**/sign-in')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await settled(page)
    const passed = await recorded(page)
    expect(passed).not.toBeNull()
    // The form is shorter than the landing, so the window is held at the end of the new page;
    // Next leaves it there when the top of the page is in the window. Never a travel.
    expect(new Set(passed).size).toBeLessThanOrEqual(2)
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(100)

    // And back: the landing returns to the place where the visitor left it. How it gets there
    // is not checked: the browser restores the place itself, and it follows the smooth scroll
    // of the landing, which the attribute of the root does not set aside for a step back.
    await page.goBack()
    await page.waitForURL(/\/$/)
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), OFTEN).toBe(start)
  })
})

test.describe('shapes and shadows', () => {
  test('gives every pill one radius and the open menu the soft shadow', async ({ page }) => {
    await openAt(page, 390, 844)
    const pills = [
      heroAction(page),
      platformsAction(page),
      page.locator('#site-demo').getByRole('button', { name: 'Цена' }),
    ]
    for (const pill of pills) await expect(pill).toHaveCSS('border-top-left-radius', '999px')

    const toggle = page.getByRole('button', { name: 'Открыть меню' })
    await hydrated(toggle)
    await toggle.click()
    const menu = page.getByRole('navigation', { name: 'Мобильная навигация' })
    await expect(menu).toBeVisible()
    await expect(menu).toHaveCSS('box-shadow', 'rgba(36, 23, 16, 0.24) 0px 20px 30px -24px')
  })
})

test.describe('sticky header', () => {
  // The page scrolls at once, so a check reads the place where it stopped.
  test.use({ reducedMotion: 'reduce' })

  const top = (page: Page, selector: string) =>
    page.locator(selector).evaluate((element) => element.getBoundingClientRect().top)
  /** How far the element stopped from its place. A section may start at half a pixel of the
   *  document, and the page scrolls by whole ones: half a pixel is the rounding, not a miss. */
  const miss = async (page: Page, selector: string, place: number) =>
    Math.abs((await top(page, selector)) - place)

  // The header is 88, 72 and 68px high; an anchor stops 16px below it.
  for (const [width, height] of [
    [1440, 88],
    [768, 72],
    [390, 68],
  ] as const) {
    test(`stops a section a step below the header at ${width}px`, async ({ page }) => {
      await openAt(page, width)
      await expect(page.locator('#top > header > div').first()).toHaveCSS('height', `${height}px`)
      for (const id of ['demo', 'possibilities', 'pricing', 'lead', 'faq']) {
        await page.evaluate((hash) => {
          location.hash = hash
        }, id)
        await expect.poll(() => miss(page, `#${id}`, height + 16)).toBeLessThanOrEqual(0.5)
      }
    })
  }

  // Every way to the form of a lead and to the example: the links of the page stop their
  // sections a step below the header, as the anchors of the address do.
  for (const [width, height] of [
    [1440, 88],
    [390, 68],
  ] as const) {
    test(`brings the example and the form under the header from the first screen at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width)
      await hydrated(page.locator('#site-demo').getByRole('button', { name: 'График' }))
      await firstScreen(page).getByRole('link', { name: 'Посмотреть пример' }).click()
      await expect(page).toHaveURL(/#demo$/)
      await expect.poll(() => miss(page, '#demo', height + 16)).toBeLessThanOrEqual(0.5)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await heroAction(page).click()
      await expect(page).toHaveURL(/#lead$/)
      await expect.poll(() => miss(page, '#lead', height + 16)).toBeLessThanOrEqual(0.5)
      // The other ways in lead to the same place.
      for (const action of [platformsAction(page), pricingAction(page)]) {
        await page.evaluate(() => {
          history.replaceState(null, '', location.pathname)
        })
        await action.click()
        await expect(page).toHaveURL(/#lead$/)
        await expect.poll(() => miss(page, '#lead', height + 16)).toBeLessThanOrEqual(0.5)
      }
    })
  }

  // The room for the header is a margin of the targets. As a padding of the root it made the
  // browser «reveal» a focused link of the sticky header itself: every Tab onto the header
  // pulled a scrolled page up by half a window, down to its very top.
  for (const width of [390, 1440]) {
    test(`leaves a scrolled page in place when the focus comes to the header at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width)
      // The plans are in: the page below is as tall as it will be.
      await expect(page.getByRole('slider')).toBeVisible()
      await page.evaluate(() => window.scrollTo({ top: 2400, behavior: 'instant' }))
      const scrolled = await page.evaluate(() => window.scrollY)
      expect(scrolled).toBeGreaterThan(2000)
      // Nothing has the focus, so Tab starts from the top of the document: the skip link,
      // then the stops of the header one by one.
      let inHeader = 0
      for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press('Tab')
        const stop = await page.evaluate(() => {
          const active = document.activeElement
          const header = document.querySelector('#top > header')
          if (!active || !header) throw new Error('No focus or no header')
          return {
            name: `${active.tagName} «${(active.textContent ?? '').trim().slice(0, 40)}»`,
            inHeader: header.contains(active),
            isSkip: active.getAttribute('href') === '#main-content',
            scrollY: window.scrollY,
          }
        })
        if (!stop.inHeader && !stop.isSkip) break
        expect(stop.scrollY, stop.name).toBe(scrolled)
        if (stop.inHeader) inHeader += 1
      }
      // The logo, the sign-in and the menu button on a phone; the links of the sections too
      // on a desktop.
      expect(inHeader).toBeGreaterThanOrEqual(3)
    })
  }

  // The skip link leads to the content, which starts right under the header. The content has
  // the room of an anchor, so the page stays where it is; without it the browser would put the
  // start of the content at the top of the window, and the heading behind the header.
  for (const [width, height] of [
    [390, 844],
    [1366, 640],
  ] as const) {
    test(`keeps the heading clear of the header after the skip link at ${width}x${height}px`, async ({
      page,
    }) => {
      await openAt(page, width, height)
      await page.keyboard.press('Tab')
      await expect(page.getByRole('link', { name: 'Перейти к содержанию' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/#main-content$/)
      const places = () =>
        page.evaluate(() => {
          const heading = document.querySelector('#hero-title')
          const header = document.querySelector('#top > header')
          if (!heading || !header) throw new Error('No heading or no header')
          return {
            scrollY: window.scrollY,
            heading: heading.getBoundingClientRect().top,
            header: header.getBoundingClientRect().bottom,
          }
        })
      // The page scrolls at once here; two frames are enough for a jump to show.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
      const { scrollY, heading, header } = await places()
      expect(scrollY).toBe(0)
      expect(heading).toBeGreaterThanOrEqual(header)
    })
  }

  for (const width of [390, 1440]) {
    test(`keeps the focused element clear of the header on the way back at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width, 700)
      await expect(page.getByRole('slider')).toBeVisible()
      // From the last stop of the page upwards, until the focus comes to the header itself.
      await page.locator('#top > footer a[href="#top"]').focus()
      let stops = 0
      let reachedHeader = false
      while (!reachedHeader && stops < 80) {
        await page.keyboard.press('Shift+Tab')
        const stop = await page.evaluate(() => {
          const active = document.activeElement
          const header = document.querySelector('#top > header')
          if (!active || !header) throw new Error('No focus or no header')
          return {
            name: `${active.tagName} «${(active.textContent ?? '').trim().slice(0, 40)}»`,
            inHeader: header.contains(active),
            top: active.getBoundingClientRect().top,
            headerBottom: header.getBoundingClientRect().bottom,
          }
        })
        reachedHeader = stop.inHeader
        if (!reachedHeader) {
          stops += 1
          expect(stop.top, stop.name).toBeGreaterThanOrEqual(stop.headerBottom)
        }
      }
      expect(reachedHeader).toBe(true)
      expect(stops).toBeGreaterThanOrEqual(20)
    })
  }
})

test.describe('anchor of the address on a first load', () => {
  // The plans come with the page, so nothing above an anchor grows after the browser has gone to
  // it. The page does nothing about the anchor of the address: the browser puts the target a
  // step below the header by the margin of the target, and keeps the place over a reload. Every
  // test here is a first visit: a new browser context has no fonts in its cache. The fonts
  // rewrap the lines above the target, so until they are in the way to an anchor is a jump, and
  // the browser keeps the target in its place.

  /** How far the element stopped from its place under the header. */
  const arrival = (page: Page, selector: string) =>
    page.evaluate((selector) => {
      const target = document.querySelector(selector)
      if (!target) throw new Error(`No ${selector} on the page`)
      const place = parseFloat(getComputedStyle(target).scrollMarginTop)
      return { miss: Math.abs(target.getBoundingClientRect().top - place), place }
    }, selector)
  /** Waits until the window stops: the way to an anchor is smooth here. */
  const stopped = async (page: Page) => {
    let last = -1
    await expect
      .poll(async () => {
        const now = await page.evaluate(() => window.scrollY)
        const still = now === last
        last = now
        return still
      })
      .toBe(true)
  }
  /** The page is as it will be: the plans are taken over, the fonts are in, nothing moves. */
  const arrived = async (page: Page) => {
    await hydrated(page.getByRole('slider'))
    await settled(page)
    await stopped(page)
  }

  // The header is 68 and 88px high; an anchor stops 16px below it.
  for (const [width, room] of [
    [390, 84],
    [1440, 104],
  ] as const) {
    // A section above the plans, the plans themselves and the questions below them.
    for (const id of ['demo', 'pricing', 'lead', 'faq']) {
      test(`stops #${id} a step below the header when the page opens at it, at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/#${id}`)
        await expect
          .poll(async () => (await arrival(page, `#${id}`)).miss, OFTEN)
          .toBeLessThanOrEqual(0.5)
        await arrived(page)
        const { miss, place } = await arrival(page, `#${id}`)
        expect(place).toBe(room)
        expect(miss).toBeLessThanOrEqual(0.5)
      })
    }

    test(`jumps to the questions while the fonts are on their way, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      // The fonts are held back: the page stands in the system ones, as on a slow first visit.
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let asked = 0
      await page.route('**/*.woff2', async (route) => {
        asked++
        await held
        await route.continue()
      })
      const root = page.locator('html')
      // The load of the document waits for the fonts, so the test goes on without it.
      await page.goto('/#faq', { waitUntil: 'domcontentloaded' })
      await hydrated(page.getByRole('slider'))
      await expect.poll(() => asked).toBeGreaterThan(0)
      await expect(root).not.toHaveAttribute('data-fonts')
      await expect(root).toHaveCSS('scroll-behavior', 'auto')
      await expect
        .poll(async () => (await arrival(page, '#faq')).miss, OFTEN)
        .toBeLessThanOrEqual(0.5)

      // The fonts come and rewrap the lines above: the questions stay where they are, and
      // from now on the way to an anchor is smooth.
      release()
      await expect(root).toHaveAttribute('data-fonts', 'ready')
      await expect(root).toHaveCSS('scroll-behavior', 'smooth')
      await arrived(page)
      expect((await arrival(page, '#faq')).miss).toBeLessThanOrEqual(0.5)
    })

    test(`keeps the questions in their place after a reload at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/#faq')
      await expect
        .poll(async () => (await arrival(page, '#faq')).miss, OFTEN)
        .toBeLessThanOrEqual(0.5)
      await arrived(page)

      await page.reload()
      await expect
        .poll(async () => (await arrival(page, '#faq')).miss, OFTEN)
        .toBeLessThanOrEqual(0.5)
      await arrived(page)
      expect((await arrival(page, '#faq')).miss).toBeLessThanOrEqual(0.5)
    })

    // After a reload Chromium either puts the window where the visitor left it or goes back to
    // the anchor of the address: a matter of its own timing, which the page does not decide.
    // Wherever it stops, it stops exactly there, and the page does not move it afterwards.
    test(`leaves a reload to the browser for a visitor who scrolled past the anchor, at ${width}px`, async ({
      page,
    }) => {
      const PAST = 60
      await page.setViewportSize({ width, height: 900 })
      // The page opens at the questions, and the visitor scrolls on, as a reader of the first
      // answers would.
      await page.goto('/#faq')
      await expect
        .poll(async () => (await arrival(page, '#faq')).miss, OFTEN)
        .toBeLessThanOrEqual(0.5)
      await arrived(page)
      const start = await page.evaluate(() => window.scrollY)
      await page.evaluate((top) => window.scrollBy({ top, behavior: 'instant' }), PAST)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(start + PAST)

      await page.reload()
      const places = [start, start + PAST]
      await expect
        .poll(() => page.evaluate(() => window.scrollY), OFTEN)
        .toBeGreaterThanOrEqual(start)
      await arrived(page)
      const place = await page.evaluate(() => window.scrollY)
      expect(places).toContain(place)
      expect((await arrival(page, '#faq')).miss).toBeCloseTo(place - start, 0)
    })
  }

  test.describe('under reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('puts the questions into their place at once', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      await page.goto('/#faq')
      await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
      await expect.poll(async () => (await arrival(page, '#faq')).miss).toBeLessThanOrEqual(0.5)
    })
  })

  test.describe('without scripts', () => {
    test.use({ javaScriptEnabled: false })

    test('shows the plans', async ({ page }) => {
      await openAt(page, 390)
      const pricing = page.locator('#pricing')
      await expect(pricing.locator('article')).toHaveCount(3)
      await expect(pricing.getByRole('slider')).toBeVisible()
      await expect(pricing.getByRole('link', { name: 'Подключить сайт бесплатно' })).toBeVisible()
      await expect(pricing.getByRole('status')).toHaveCount(0)
      await expect(pricing).not.toContainText('Загружаем')
    })
  })
})

test.describe('forced colours', () => {
  test.use({ forcedColors: 'active' })

  // A forced palette paints no author background, so a line drawn with one disappears; a border
  // stays and takes a colour of the palette.
  test('draws the lines of the menu button and of the question sign with borders', async ({
    page,
  }) => {
    await openAt(page, 390, 844)
    const lines = await page.evaluate(() => {
      const line = (element: Element | null, pseudo?: string) => {
        if (!element) throw new Error('No sign on the page')
        const style = getComputedStyle(element, pseudo)
        return {
          width: style.borderTopWidth,
          style: style.borderTopStyle,
          length: pseudo ? parseFloat(style.width) : element.getBoundingClientRect().width,
        }
      }
      const sign = document.querySelector('#faq summary > span')
      return {
        menu: [...document.querySelectorAll('#top > header button[aria-controls] > span')].map(
          (element) => line(element),
        ),
        question: [line(sign, '::before'), line(sign, '::after')],
      }
    })
    expect(lines.menu).toHaveLength(2)
    for (const line of [...lines.menu, ...lines.question]) {
      expect(line.width).toBe('1px')
      expect(line.style).toBe('solid')
      expect(line.length).toBeGreaterThanOrEqual(16)
    }
  })

  // The two parts of the slider track are backgrounds of the control, which a forced palette
  // does not paint: without a border of the track only the thumb would be left.
  test('draws the line of the slider track with a border', async ({ page }) => {
    await openAt(page, 390, 844)
    const slider = page.getByRole('slider')
    await slider.scrollIntoViewIfNeeded()
    // The palette has taken both layers of the background away.
    expect(await slider.evaluate((node) => getComputedStyle(node).backgroundImage)).not.toContain(
      'gradient',
    )
    // Both ways from the thumb, which stands near the left end.
    for (const part of [0.01, 0.5, 0.99]) {
      const { height, rows } = await paintedRows(page, slider, (width) => (width - 1) * part)
      expect(rows.length, `at ${part}`).toBeGreaterThanOrEqual(1)
      expect(rows.length, `at ${part}`).toBeLessThanOrEqual(2)
      for (const row of rows) expect(Math.abs(row + 0.5 - height / 2)).toBeLessThanOrEqual(1)
    }
  })
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('runs no animation and still shows the heading and the demo pause', async ({ page }) => {
    await openAt(page, 768)
    expect(await highlightedWordIsHit(page)).toBe(true)
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)

    // The busy phase is a pause to read the status, so it stays; a double click cannot apply
    // and undo the change at once.
    const demo = page.locator('#site-demo')
    await demo.getByRole('button', { name: 'Применить правку' }).dblclick()
    await expect(demo.getByText('Изменено')).toBeVisible()
    await expect(demo.getByRole('button', { name: 'Отменить правку' })).toBeVisible()
  })

  /** How many animations and transitions the document runs or holds ready. */
  const moving = (page: Page) => page.evaluate(() => document.getAnimations().length)

  test('declares no transition and no animation on any element or its parts', async ({ page }) => {
    await openAt(page, 1440)
    await hydrated(page.getByRole('slider'))
    const declared = await page.evaluate(() => {
      const found: string[] = []
      for (const element of document.querySelectorAll('#top, #top *')) {
        for (const part of ['', '::before', '::after']) {
          const style = getComputedStyle(element, part)
          if (part && style.content === 'none') continue
          // The root of the page has no rule of motion at all: its property is the initial
          // `all` with a duration of zero, which moves nothing.
          const transition =
            style.transitionProperty !== 'none' &&
            style.transitionDuration.split(', ').some((duration) => parseFloat(duration) > 0)
          if (transition || style.animationName !== 'none') {
            found.push(`${element.localName}.${element.getAttribute('class') ?? ''}${part}`)
          }
        }
      }
      // What the universal selector does not reach has rules of its own.
      const answer = document.querySelector('#faq details')
      const content = answer ? getComputedStyle(answer, '::details-content') : null
      return { found, answer: content?.transitionProperty }
    })
    expect(declared.found).toEqual([])
    expect(declared.answer).toBe('none')
    // The headings below the window are in their places: the helper of the reveal did not start.
    for (const target of await revealTargets(page)) {
      expect(target.mark, target.name).toBeNull()
      expect(target.animations, target.name).toEqual([])
      expect(target.transform, target.name).toBe('none')
    }
  })

  test('changes every state of the page at once', async ({ page }) => {
    await openAt(page, 1440)
    const slider = page.getByRole('slider')
    await hydrated(slider)
    expect(await moving(page)).toBe(0)

    // The way through the page: nothing rises into the window.
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    for (let top = 0; top < height; top += 600) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), top)
      expect(await moving(page)).toBe(0)
    }

    // The demo: every phase, and the pauses of the busy ones stay.
    const demo = page.locator('#site-demo')
    const stage = demo.locator('[data-phase]')
    await bringIntoWindow(page, demo)
    await demo.getByRole('button', { name: 'График' }).click()
    await expect(stage).toHaveAttribute('data-phase', 'preparing')
    expect(await moving(page)).toBe(0)
    await expect(stage).toHaveAttribute('data-phase', 'review')
    await demo.getByRole('button', { name: 'Применить правку' }).click()
    await expect(stage).toHaveAttribute('data-phase', 'applying')
    expect(await moving(page)).toBe(0)
    await expect(stage).toHaveAttribute('data-phase', 'applied')
    expect(await moving(page)).toBe(0)
    // The window of the site is level at once, the highlight has its colour at once.
    await expect(stage.getByRole('group', { name: 'Пример сайта кофейни' })).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, 0, 0)',
    )
    await demo.getByRole('button', { name: 'Отменить правку' }).click()
    await expect(stage).toHaveAttribute('data-phase', 'undone')
    expect(await moving(page)).toBe(0)
    await expect(stage.locator('[data-selected="true"] strong')).toHaveCSS('transform', 'none')

    // The running line of the systems stands still.
    await bringIntoWindow(page, page.locator('#platforms'))
    expect(await moving(page)).toBe(0)

    // The calculator: another plan.
    await bringIntoWindow(page, slider)
    await slider.fill('300')
    expect(await moving(page)).toBe(0)

    // The thumb of the slider: a grip does not enlarge it, so nothing can be on its way.
    const box = await slider.boundingBox()
    if (!box) throw new Error('The calculator has no slider')
    const clip = { x: box.x - 4, y: box.y, width: box.width + 8, height: box.height }
    await page.mouse.move(1, 1)
    const atRest = await page.screenshot({ clip })
    // The thumb stands at the end of the track: the press does not move it.
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2)
    await page.mouse.down()
    const gripped = await page.screenshot({ clip })
    await page.mouse.up()
    expect(gripped.equals(atRest)).toBe(true)
    expect(await moving(page)).toBe(0)

    // A question: open to its full height in the frame of the click.
    const question = page.locator('#faq details').first()
    await bringIntoWindow(page, question)
    const opened = await question.evaluate(async (node) => {
      const details = node as HTMLDetailsElement
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
      const height = () => parseFloat(getComputedStyle(details, '::details-content').blockSize)
      details.querySelector('summary')?.click()
      await frame()
      const first = height()
      await frame()
      await frame()
      return { first, later: height(), moving: document.getAnimations().length }
    })
    expect(opened.first).toBeGreaterThan(40)
    expect(opened).toEqual({ first: opened.first, later: opened.first, moving: 0 })
  })

  test('opens and closes the mobile menu at once and marks the section without a transition', async ({
    page,
  }) => {
    await openAt(page, 390, 844)
    const toggle = menuToggle(page)
    await hydrated(toggle)
    const step = () =>
      toggle.evaluate(async (node) => {
        const panel = document.getElementById('landing-navigation')
        if (!panel) throw new Error('No mobile menu')
        ;(node as HTMLElement).click()
        await new Promise<void>((done) => requestAnimationFrame(() => done()))
        const style = getComputedStyle(panel)
        return {
          display: style.display,
          opacity: style.opacity,
          transform: style.transform,
          moving: document.getAnimations().length,
        }
      })
    expect(await step()).toEqual({ display: 'flex', opacity: '1', transform: 'none', moving: 0 })
    expect((await step()).display).toBe('none')
    expect(await moving(page)).toBe(0)
  })

  test('draws the line of the current section without a transition', async ({ page }) => {
    await openAt(page, 1440)
    await hydrated(menuToggle(page))
    await page.getByRole('slider').waitFor()
    await bringIntoWindow(page, page.locator('#pricing'))
    const link = page.locator('#top > header nav a[aria-current="true"]').first()
    await expect(link).toHaveText('Тарифы')
    expect(
      await link.evaluate((node) => {
        const line = getComputedStyle(node, '::after')
        return { transform: line.transform, transition: line.transitionProperty }
      }),
    ).toEqual({ transform: 'matrix(1, 0, 0, 1, 0, 0)', transition: 'none' })
    expect(await moving(page)).toBe(0)
  })
})

// A target of the observer either rises into the window or is a scene, which is not moved and
// plays its own beats. The observer marks both alike; what plays is the business of CSS. The
// page has no scene now: every target is the heading group of a section.
const RISING = '[data-reveal]:not([data-reveal="scene"])'
const SCENES = '[data-reveal="scene"]'

/** The elements that rise into the window, in the order of the page, as a script sees them. */
async function revealTargets(page: Page) {
  const targets = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return {
          name: element.id || (element.closest('section')?.id ?? ''),
          top: box.top,
          inWindow: box.bottom > 0 && box.top < window.innerHeight,
          // Where the observer says the target is: `waiting`, `playing` or no mark at all.
          mark: element.getAttribute('data-scene'),
          opacity: style.opacity,
          transform: style.transform,
          animations: element.getAnimations().map((animation) => {
            const effect = animation.effect as KeyframeEffect
            const { duration, fill, delay } = effect.getTiming()
            const keyframes = effect.getKeyframes()
            return {
              name:
                animation instanceof CSSAnimation ? animation.animationName : 'not a CSS animation',
              state: animation.playState,
              duration,
              delay,
              // CSS puts the curve of an animation on its keyframes.
              easing: keyframes[0]?.easing,
              fill,
              // What the keyframes change, besides the fields every keyframe has.
              properties: [
                ...new Set(
                  keyframes.flatMap((keyframe) =>
                    Object.keys(keyframe).filter(
                      (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
                    ),
                  ),
                ),
              ],
            }
          }),
        }
      }),
    RISING,
  )
  return targets.map((target) => ({
    ...target,
    animations: target.animations.map((animation) => ({
      ...animation,
      name: plainName(animation.name),
    })),
  }))
}

/** Waits until the helper of the reveal has marked the targets below the window. */
function revealPrepared(page: Page): Promise<unknown> {
  return page.waitForFunction(
    () => document.querySelector<HTMLElement>('#faq [data-reveal]')?.dataset.scene,
  )
}

const PUT_DOWN = 'matrix(1, 0, 0, 1, 0, 24)'

test.describe('headings on the way into the window', () => {
  test('are the heading groups of seven sections, not the sections', async ({ page }) => {
    await page.goto('/')
    const named = (selector: string) =>
      page.evaluate(
        (targets) =>
          [...document.querySelectorAll(targets)].map((element) => {
            const section = element.closest('section')
            const name =
              section?.id ||
              section?.getAttribute('aria-labelledby') ||
              section?.getAttribute('aria-label')
            return `${name}:${element.localName}`
          }),
        selector,
      )
    // The scenes went with the dark strip and the three steps.
    expect(await named(SCENES)).toEqual([])
    expect(await named(RISING)).toEqual([
      'demo:div',
      'platforms:div',
      'possibilities:div',
      'safety:div',
      'pricing:div',
      'lead:div',
      'faq:div',
    ])
    // The server marks them: nothing waits for a script to become a target, and no section is one.
    expect(await page.locator('section[data-reveal], main[data-reveal]').count()).toBe(0)
  })

  // 900px high: the heading of the example is in the window from the start. 640px: it is below.
  for (const [width, height, shown] of [
    [390, 900, 1],
    [1440, 900, 1],
    [1366, 640, 0],
  ] as const) {
    test(`are put down only below the window, with a shift alone, at ${width}x${height}px`, async ({
      page,
    }) => {
      await openAt(page, width, height)
      await revealPrepared(page)
      const targets = await revealTargets(page)

      expect(targets).toHaveLength(7)
      expect(targets.filter((target) => target.inWindow).map((target) => target.name)).toEqual(
        ['demo'].slice(0, shown),
      )
      for (const target of targets) {
        // Never dimmed: the text keeps its contrast even if the observer never reports.
        expect(target.opacity, target.name).toBe('1')
        expect(target.animations, target.name).toEqual([])
        if (target.inWindow) {
          // On the screen at the start: as the server drew it.
          expect(target.mark, target.name).toBeNull()
          expect(target.transform, target.name).toBe('none')
        } else {
          // Held by a style of the mark, not by an animation: nothing runs while it waits.
          expect(target.mark, target.name).toBe('waiting')
          expect(target.transform, target.name).toBe(PUT_DOWN)
        }
      }
      // The first screen is as the server drew it: nothing in it is marked, and no script
      // animates anything on the page.
      const touched = await page.evaluate(() => ({
        marked: [...document.querySelectorAll('[data-scene]')].filter((element) => {
          const box = element.getBoundingClientRect()
          return box.bottom > 0 && box.top < window.innerHeight
        }).length,
        scripted: document
          .getAnimations()
          .filter(
            (animation) =>
              !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition),
          ).length,
      }))
      expect(touched).toEqual({ marked: 0, scripted: 0 })
      // The fields of the systems and of the safety block stand still: only their copy is a target.
      for (const id of ['platforms', 'safety', 'lead']) {
        const field = await page.locator(`#${id}`).evaluate((section) => ({
          transform: getComputedStyle(section).transform,
          animations: section.getAnimations().length,
        }))
        expect(field, id).toEqual({ transform: 'none', animations: 0 })
      }
    })
  }

  test('rise once, in 560ms, and leave nothing on the element', async ({ page }) => {
    await openAt(page, 1440)
    await revealPrepared(page)
    const heading = page.locator(`#possibilities ${RISING}`)
    const state = () =>
      heading.evaluate((element) => ({
        mark: element.getAttribute('data-scene'),
        states: element.getAnimations().map((animation) => animation.playState),
        transform: getComputedStyle(element).transform,
        opacity: getComputedStyle(element).opacity,
      }))
    const risen = async () =>
      (await revealTargets(page)).find((target) => target.name === 'possibilities')
    expect(await state()).toEqual({
      mark: 'waiting',
      states: [],
      transform: PUT_DOWN,
      opacity: '1',
    })

    await page.evaluate(() => {
      const top = document.querySelector('#possibilities')?.getBoundingClientRect().top ?? 0
      window.scrollTo({ top: top - 200, behavior: 'instant' })
    })
    // The rise is stopped on its first frame to be read: a running one would not wait for the
    // test. It starts where the heading waited, moved and not dimmed.
    const start = await heading.evaluate(async (element) => {
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
      for (let frames = 0; frames < 120 && element.getAnimations().length === 0; frames++) {
        await frame()
      }
      const [animation] = element.getAnimations()
      if (!animation) throw new Error('The heading did not start to rise')
      const running = animation.playState
      animation.pause()
      animation.currentTime = 0
      const style = getComputedStyle(element)
      return { running, transform: style.transform, opacity: style.opacity }
    })
    expect(start).toEqual({ running: 'running', transform: PUT_DOWN, opacity: '1' })
    expect((await risen())?.animations).toEqual([
      {
        name: 'headingRise',
        state: 'paused',
        duration: 560,
        delay: 0,
        easing: EASE_OUT,
        fill: 'backwards',
        properties: ['transform'],
      },
    ])
    expect((await state()).mark).toBe('playing')
    await heading.evaluate((element) => element.getAnimations().forEach((rise) => rise.play()))
    await settled(page)
    const atRest = { mark: 'playing', states: [], transform: 'none', opacity: '1' }
    expect(await state()).toEqual(atRest)

    // Once: the way back and forth starts nothing.
    const place = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    expect(await state()).toEqual(atRest)
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), place)
    await settled(page)
    expect(await state()).toEqual(atRest)
  })

  test('take their places without a move when a jump carries the page past them', async ({
    page,
  }) => {
    await openAt(page, 1440)
    await page.getByRole('slider').waitFor()
    await revealPrepared(page)
    await page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
    )
    await settled(page)
    const targets = await revealTargets(page)
    for (const target of targets) {
      expect(target.mark, target.name).not.toBe('waiting')
      expect(target.animations, target.name).toEqual([])
      expect(target.transform, target.name).toBe('none')
      expect(target.opacity, target.name).toBe('1')
    }
    // What the jump carried above the window has no mark: it never played.
    const passed = targets.filter((target) => !target.inWindow)
    expect(passed.length).toBeGreaterThan(0)
    for (const target of passed) expect(target.mark, target.name).toBeNull()
  })

  test('are not touched when the window shows them from the start', async ({ page }) => {
    // A window tall enough to hold the heading of the systems below the example.
    await openAt(page, 1440, 2400)
    await revealPrepared(page)
    const [first, second, ...rest] = await revealTargets(page)
    for (const [target, name] of [
      [first, 'demo'],
      [second, 'platforms'],
    ] as const) {
      expect(target, name).toMatchObject({
        name,
        inWindow: true,
        mark: null,
        opacity: '1',
        transform: 'none',
      })
      expect(target?.animations, name).toEqual([])
    }
    expect(rest.filter((target) => !target.inWindow).length).toBeGreaterThan(0)
    for (const target of rest.filter((target) => !target.inWindow)) {
      expect(target.mark, target.name).toBe('waiting')
      expect(target.transform, target.name).toBe(PUT_DOWN)
    }
  })

  for (const width of [390, 1440]) {
    test(`leave nothing waiting above the line when the page opens at an anchor, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/#faq')
      await page.getByRole('slider').waitFor()
      // The browser jumps to the anchor before the fonts are in, so the helper of the reveal
      // may find the headings already passed and the last one on the screen: it marks only what
      // is still below. Its mark of the fonts tells that it has looked.
      await expect(page.locator('html')).toHaveAttribute('data-fonts', 'ready')
      let last = -1
      await expect
        .poll(
          async () => {
            const now = await page.evaluate(() => window.scrollY)
            const still = now === last && now > 0
            last = now
            return still
          },
          // Still is the same place a quarter of a second later; the steps do not grow.
          { intervals: [250] },
        )
        .toBe(true)
      await settled(page)
      // The line of the observer: 8% above the bottom of the window.
      const line = 900 * 0.92
      for (const target of await revealTargets(page)) {
        // Whether passed, on the screen or still below: never dimmed.
        expect(target.opacity, target.name).toBe('1')
        if (target.top < line - 1) {
          expect(target.mark, target.name).not.toBe('waiting')
          expect(target.transform, target.name).toBe('none')
          expect(target.animations, target.name).toEqual([])
        }
      }
    })
  }

  test.describe('without scripts', () => {
    test.use({ javaScriptEnabled: false })

    test('stand in their places with their text', async ({ page }) => {
      await openAt(page, 1440)
      const targets = page.locator(RISING)
      await expect(targets).toHaveCount(7)
      for (const target of await targets.all()) {
        await expect(target).toHaveCSS('transform', 'none')
        await expect(target).toHaveCSS('opacity', '1')
        await expect(target).not.toBeEmpty()
      }
      await expect(page.locator('#faq-title')).toHaveText('Вопросы')
    })
  })
})

/** The animations and transitions of an element and of its pseudo-elements, as a script sees them. */
async function motionOf(element: Locator) {
  const motions = await element.evaluate((node) =>
    node.getAnimations({ subtree: true }).flatMap((animation) => {
      const effect = animation.effect as KeyframeEffect
      // Of the element itself, not of its children.
      if (effect.target !== node) return []
      const { duration, delay, easing, fill } = effect.getTiming()
      const keyframes = effect.getKeyframes()
      const meta = ['offset', 'computedOffset', 'easing', 'composite']
      // CSS puts the curve of an animation on its keyframes; a transition and a script have it
      // on the timing.
      const curve = animation instanceof CSSAnimation
      return [
        {
          name:
            animation instanceof CSSAnimation
              ? animation.animationName
              : animation instanceof CSSTransition
                ? `transition of ${animation.transitionProperty}`
                : 'script',
          pseudo: effect.pseudoElement,
          duration,
          delay,
          easing: curve ? (keyframes[0]?.easing ?? easing) : easing,
          fill,
          properties: [
            ...new Set(
              keyframes.flatMap((keyframe) =>
                Object.keys(keyframe).filter((key) => !meta.includes(key)),
              ),
            ),
          ].sort(),
          from: Object.fromEntries(
            Object.entries(keyframes[0] ?? {}).filter(([key]) => !meta.includes(key)),
          ) as Record<string, string>,
        },
      ]
    }),
  )
  return motions.map((motion) => ({ ...motion, name: plainName(motion.name) }))
}

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'

test.describe('demo in motion', () => {
  /** The demo with its buttons wired and the entrance of the first screen over. */
  async function openDemo(page: Page, width: number): Promise<Locator> {
    await openAt(page, width)
    const demo = page.locator('#site-demo')
    await hydrated(demo.getByRole('button', { name: 'Применить правку' }))
    await settled(page)
    return demo
  }

  for (const width of [320, 390, 1440]) {
    test(`keeps the text of a field in place when it is changed and returned at ${width}px`, async ({
      page,
    }) => {
      const demo = await openDemo(page, width)
      const row = demo.locator('[data-selected="true"]')
      const read = () =>
        row.evaluate((node) => {
          const layer = getComputedStyle(node, '::before')
          const window = node.closest('[role="group"]')?.getBoundingClientRect()
          const box = node.getBoundingClientRect()
          const reach =
            Math.abs(parseFloat(layer.left)) +
            parseFloat(layer.outlineOffset) +
            parseFloat(layer.outlineWidth)
          const value = node.querySelector('strong')
          return {
            // In the box of the row, where the turn of the window does not count.
            label: node.querySelector('span')?.offsetLeft,
            value: value ? value.offsetLeft + value.offsetWidth : undefined,
            padding: getComputedStyle(node).paddingInline,
            layer: {
              left: layer.left,
              right: layer.right,
              background: layer.backgroundColor,
              outline: `${layer.outlineWidth} ${layer.outlineStyle} ${layer.outlineColor}`,
              offset: layer.outlineOffset,
            },
            // How much of the window is left beside the outline; the window is turned a little,
            // so the room is measured in its own box, before the turn.
            room: window ? box.left - window.left - reach : -1,
          }
        })
      const before = await read()
      expect(before.padding).toBe('0px')
      // The highlight and the outline reach 8px and 3px beyond the row, inside the window.
      expect(before.layer).toMatchObject({ left: '-8px', right: '-8px', offset: '3px' })
      expect(before.layer.outline).toBe(`1px dashed ${ACCENT_TEXT}`)
      expect(before.layer.background).toBe('rgba(0, 0, 0, 0)')
      expect(before.room).toBeGreaterThanOrEqual(0)

      await applyChange(demo)
      await settled(page)
      const applied = await read()
      expect(applied.layer.background).toBe(MARKER)
      expect(applied.layer.outline).toBe(`1px solid ${ACCENT_TEXT}`)
      // The old highlight moved the text by its 8px of padding; a pixel is the rounding of the
      // offsets when the new value is a fraction wider or narrower.
      expect(applied.padding).toBe('0px')
      expect(applied.label).toBe(before.label)
      expect(Math.abs(Number(applied.value) - Number(before.value))).toBeLessThanOrEqual(1)

      await demo.getByRole('button', { name: 'Отменить правку' }).click()
      await expect(demo.getByText('Возвращено')).toBeVisible()
      await settled(page)
      const returned = await read()
      expect(returned).toEqual(before)
    })
  }

  for (const [width, from] of [
    [390, '7px'],
    [1024, '11px'],
    [1440, '12px'],
  ] as const) {
    test(`finds the place of a picked request with its outline, and not on load, at ${width}px`, async ({
      page,
    }) => {
      const demo = await openDemo(page, width)
      const stage = demo.locator('[data-phase]')
      const field = stage.locator('[data-selected="true"]')
      // The first phase is the review: the outline of the first field stands still.
      await expect(stage).toHaveAttribute('data-phase', 'review')
      expect(await motionOf(field)).toEqual([])

      // A row: the outline belongs to its highlight layer.
      await demo.getByRole('button', { name: 'График' }).click()
      await expect(stage).toHaveAttribute('data-phase', 'preparing')
      const located = {
        name: 'locate',
        duration: 560,
        delay: 0,
        easing: EASE_OUT,
        fill: 'backwards',
        properties: ['outlineOffset'],
        from: { outlineOffset: from },
      }
      expect(await motionOf(field)).toEqual([{ ...located, pseudo: '::before' }])
      // Seen from the first frame: only the distance moves, the line has its colour and width.
      const outline = await field.evaluate((node) => {
        const layer = getComputedStyle(node, '::before')
        const window = node.closest('[role="group"]')?.getBoundingClientRect()
        const box = node.getBoundingClientRect()
        return {
          line: `${layer.outlineWidth} ${layer.outlineStyle} ${layer.outlineColor}`,
          opacity: layer.opacity,
          room: window ? box.left - window.left - 8 - 1 : -1,
        }
      })
      expect(outline.line).toBe(`1px dashed ${ACCENT_TEXT}`)
      expect(outline.opacity).toBe('1')
      // The widest outline is inside the window, which would cut it.
      expect(parseFloat(from)).toBeLessThanOrEqual(outline.room)
      // The move is over before the phase is: the outline is at rest when the change is offered.
      await expect(stage).toHaveAttribute('data-phase', 'review')
      expect(await motionOf(field)).toEqual([])

      // The banner has its outline on itself.
      await demo.getByRole('button', { name: 'Акция' }).click()
      await expect(stage).toHaveAttribute('data-phase', 'preparing')
      expect(await motionOf(field)).toEqual([{ ...located, pseudo: null }])
    })
  }

  test('changes a value with a gesture from below and returns it with one from above', async ({
    page,
  }) => {
    const demo = await openDemo(page, 1440)
    const stage = demo.locator('[data-phase]')
    const value = stage.locator('[data-selected="true"] strong')
    expect(await motionOf(value)).toEqual([])

    await demo.getByRole('button', { name: 'Применить правку' }).click()
    await expect(stage).toHaveAttribute('data-phase', 'applied')
    const [changed] = await motionOf(value)
    expect(changed).toMatchObject({ name: 'changeValue', duration: 600, easing: EASE_OUT })
    expect(changed?.from.transform).toBe('translateY(5px)')
    await settled(page)

    // The undo has no phase of waiting: the label of the window is there at once, and the value
    // comes back the other way, without a blur or a fade.
    await demo.getByRole('button', { name: 'Отменить правку' }).click()
    await expect(stage).toHaveAttribute('data-phase', 'undone')
    expect(await motionOf(value)).toEqual([
      {
        name: 'valueReturn',
        pseudo: null,
        duration: 360,
        delay: 0,
        easing: EASE_OUT,
        fill: 'backwards',
        properties: ['transform'],
        from: { transform: 'translateY(-6px)' },
      },
    ])
    await expect(value).toHaveText('250 ₽')
    await settled(page)
    expect(await motionOf(value)).toEqual([])
    await expect(value).toHaveCSS('transform', 'none')
    // The status has the sign of a turn back, for the eye only.
    const status = demo.getByText('Вернул как было. Всё под контролем.')
    await expect(status.locator('svg')).toHaveAttribute('aria-hidden', 'true')
    await expect(status.locator('svg')).toHaveCSS('color', MARKER)
  })

  for (const width of [320, 390, 1440]) {
    test(`sends the dots from the chat to the window, the last one by the end of the phase, at ${width}px`, async ({
      page,
    }) => {
      const demo = await openDemo(page, width)
      const stage = demo.locator('[data-phase]')
      const dots = stage.locator('[aria-hidden="true"]:has(> span:empty:nth-child(3)) > span')
      await expect(dots).toHaveCount(3)
      // On a phone the demo is below the first screen, and a point outside the window hits nothing.
      await dots.first().scrollIntoViewIfNeeded()
      const place = await stage.evaluate((node) => {
        const box = (element: Element | null | undefined) => element?.getBoundingClientRect()
        const [site, chat] = [...node.querySelectorAll('[role="group"]')]
        const dots = [...(node.querySelectorAll('[aria-hidden="true"] > span:empty') ?? [])]
          .filter((dot) => dot.parentElement?.childElementCount === 3)
          .map((dot) => {
            const rect = dot.getBoundingClientRect()
            const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2]
            return { x, y, seen: document.elementFromPoint(x, y) === dot }
          })
        const fields = [...node.querySelectorAll('[data-selected]')].map((field) => box(field))
        return {
          dots,
          chatTop: box(chat)?.top ?? 0,
          chatLeft: box(chat)?.left ?? 0,
          lastField: Math.max(...fields.map((field) => field?.bottom ?? 0)),
          siteBottom: box(site)?.bottom ?? 0,
        }
      })
      for (const dot of place.dots) {
        // Not under the chat and not on a field that changes: in the joint of the two objects.
        expect(dot.seen).toBe(true)
        expect(dot.x).toBeLessThan(place.chatLeft)
        expect(dot.y).toBeGreaterThan(place.lastField)
        expect(dot.y).toBeGreaterThan(place.chatTop)
        expect(dot.y).toBeLessThan(place.siteBottom + 60)
      }

      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(stage).toHaveAttribute('data-phase', 'applying')
      const phase = await stage.evaluate((node) =>
        parseFloat((node as HTMLElement).style.getPropertyValue('--demo-phase')),
      )
      expect(phase).toBeGreaterThan(0)
      const transfers = await Promise.all((await dots.all()).map((dot) => motionOf(dot)))
      expect(transfers.map(([transfer]) => transfer?.name)).toEqual([
        'transfer',
        'transfer',
        'transfer',
      ])
      for (const [transfer] of transfers) {
        expect(transfer).toMatchObject({ duration: 360, easing: EASE_IN_OUT })
        expect(transfer?.properties).toEqual(['opacity', 'transform'])
      }
      // One after another, and the last one arrives when the timer ends the phase.
      const ends = transfers.map(
        ([transfer]) => Number(transfer?.delay) + Number(transfer?.duration),
      )
      for (const [index, end] of ends.entries()) {
        expect(end).toBeCloseTo(phase - 80 * (2 - index), 5)
      }
      // The pulse of the status lasts the phase too.
      const [pulse] = await motionOf(demo.locator('[aria-live] > span[aria-hidden="true"]'))
      expect(pulse).toMatchObject({ name: 'activity', duration: phase, easing: EASE_IN_OUT })
      expect(pulse?.properties).toEqual(['opacity'])
    })
  }
})

const EASE_IN = 'cubic-bezier(0.5, 0, 0.75, 0)'

/** Brings an element under the header at once: the page scrolls smoothly, a test cannot wait for it. */
async function bringIntoWindow(page: Page, target: Locator): Promise<void> {
  await target.evaluate((element) => {
    const top = element.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: top - 140, behavior: 'instant' })
  })
  await settled(page)
}

test.describe('questions in motion', () => {
  /** What the browser computed for the box that holds the answer of a question. */
  const content = (question: Locator) =>
    question.evaluate((details) => {
      const style = getComputedStyle(details, '::details-content')
      return {
        property: style.transitionProperty,
        duration: style.transitionDuration,
        curve: style.transitionTimingFunction,
        behavior: style.transitionBehavior,
        height: parseFloat(style.blockSize),
      }
    })

  /** Waits until the height of the answer stops changing: a script is not told of this transition. */
  const atRest = (question: Locator) =>
    question.evaluate(async (details) => {
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
      const height = () => getComputedStyle(details, '::details-content').blockSize
      for (let still = 0, last = height(); still < 4;) {
        await frame()
        const now = height()
        still = now === last ? still + 1 : 0
        last = now
      }
    })

  test('opens an answer by its height without dimming it, and closes it faster', async ({
    page,
  }) => {
    await openAt(page, 1440)
    const first = page.locator('#faq details').first()
    const answer = first.locator('p')
    await bringIntoWindow(page, first)
    expect(await content(first)).toEqual({
      property: 'block-size, content-visibility',
      duration: '0.24s, 0.24s',
      // The second one is of `content-visibility`, which switches and has no curve to follow.
      curve: `${EASE_OUT}, ease`,
      behavior: 'normal, allow-discrete',
      height: 0,
    })

    // The first frames of the opening, read in the page: a round trip of the test is too slow.
    const opening = await first.evaluate(async (node) => {
      const details = node as HTMLDetailsElement
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
      const next = details.nextElementSibling
      const before = next?.getBoundingClientRect().top ?? 0
      const style = getComputedStyle(details, '::details-content')
      details.querySelector('summary')?.click()
      await frame()
      await frame()
      const paragraph = details.querySelector('p')
      const opacity = paragraph ? getComputedStyle(paragraph).opacity : ''
      const answerMoves = paragraph?.getAnimations().length
      // The transition can take its start time a few frames later, as on the way back below.
      for (let frames = 0; frames < 10 && parseFloat(style.blockSize) === 0; frames++) await frame()
      return {
        open: details.open,
        moved: (next?.getBoundingClientRect().top ?? 0) - before,
        opacity,
        answerMoves,
        // Of the box that holds the answer, on its way open.
        height: parseFloat(style.blockSize),
      }
    })
    expect(opening.open).toBe(true)
    // The text is read from the first frame, and the height alone brings it in.
    expect(opening.opacity).toBe('1')
    expect(opening.answerMoves).toBe(0)
    await atRest(first)
    await expect(answer).toBeVisible()
    const open = await content(first)
    expect(open.height).toBeGreaterThan(40)
    expect(open).toMatchObject({ duration: '0.36s', curve: `${EASE_OUT}, ease` })
    // On its way: the box was neither closed nor fully open, and the questions below went down
    // with it, not ahead of it.
    expect(opening.height).toBeGreaterThan(0)
    expect(opening.height).toBeLessThan(open.height)
    expect(opening.moved).toBeGreaterThan(0)
    expect(opening.moved).toBeLessThan(open.height)

    const closing = await first.evaluate(async (node) => {
      const details = node as HTMLDetailsElement
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
      const style = getComputedStyle(details, '::details-content')
      const full = style.blockSize
      details.querySelector('summary')?.click()
      await frame()
      await frame()
      // A busy machine may give the transition its start time a few frames later.
      for (let frames = 0; frames < 10 && style.blockSize === full; frames++) await frame()
      return {
        open: details.open,
        height: parseFloat(style.blockSize),
        duration: style.transitionDuration,
        visible: details.querySelector('p')?.checkVisibility({ contentVisibilityAuto: true }),
      }
    })
    // Closed for a script at once; for the eye the answer leaves in the shorter time.
    expect(closing.open).toBe(false)
    expect(closing.duration).toBe('0.24s, 0.24s')
    expect(closing.height).toBeGreaterThan(0)
    expect(closing.height).toBeLessThan(open.height)
    await atRest(first)
    expect((await content(first)).height).toBe(0)
    await expect(answer).toBeHidden()
  })

  test('opens the question in which a search of the browser finds its words', async ({ page }) => {
    await openAt(page, 1440)
    const third = page.locator('#faq details').nth(2)
    const words = ((await third.locator('p').textContent()) ?? '').split(/\s+/).slice(0, 4)
    expect(words).toHaveLength(4)
    // A link to a text on the page opens a closed answer as the search of the browser does.
    await page.goto('about:blank')
    // The browser opens the answer before React takes the page over, and the server drew it
    // closed. In development React reports such a difference to the console; a production
    // build says nothing, so there this check holds by itself.
    const complaints: string[] = []
    page.on('console', (message) => {
      if (/hydrat/i.test(message.text())) complaints.push(message.text())
    })
    await page.goto(`/#:~:text=${encodeURIComponent(words.join(' '))}`)
    await expect(third).toHaveAttribute('open', '')
    await expect(third.locator('p')).toBeVisible()
    await hydrated(third.locator('summary'))
    expect(complaints).toEqual([])
    expect(
      await page
        .locator('#faq details')
        .evaluateAll((all) => all.filter((details) => (details as HTMLDetailsElement).open).length),
    ).toBe(1)
  })
})

test.describe('mobile menu in motion', () => {
  test('comes down with a fade, leaves faster and takes no focus on its way out', async ({
    page,
  }) => {
    await openAt(page, 390, 844)
    const toggle = menuToggle(page)
    const menu = page.locator('#landing-navigation')
    await hydrated(toggle)
    await settled(page)
    await expect(menu).toBeHidden()
    // The place of the panel is its own in both states: closing does not drop it into the header.
    const placed = () =>
      menu.evaluate((node) => {
        const style = getComputedStyle(node)
        return { position: style.position, left: style.left, shadow: style.boxShadow }
      })
    const place = await placed()
    expect(place.position).toBe('absolute')
    expect(place.shadow).not.toBe('none')

    const stepOf = (button: Locator) =>
      button.evaluate(async (node) => {
        const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
        const panel = document.getElementById('landing-navigation')
        if (!panel) throw new Error('No mobile menu')
        ;(node as HTMLElement).click()
        await frame()
        await frame()
        const style = getComputedStyle(panel)
        const links = [...panel.querySelectorAll('a')]
        const middle = links[1]?.getBoundingClientRect()
        if (!middle) throw new Error('The mobile menu has no links')
        return {
          display: style.display,
          // Whether a press on a link of the panel reaches the panel now.
          pressable: panel.contains(
            document.elementFromPoint(
              middle.left + middle.width / 2,
              middle.top + middle.height / 2,
            ),
          ),
          hidden: panel.hidden,
          inert: panel.inert,
          // Whether a link of the panel can take the focus now.
          reachable: links.some((link) => {
            link.focus()
            return document.activeElement === link
          }),
          transitions: panel
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .map((animation) => {
              const effect = animation.effect as KeyframeEffect
              const [from] = effect.getKeyframes()
              const { duration, easing } = effect.getTiming()
              return {
                property: animation.transitionProperty,
                duration,
                easing,
                from: String(from?.[animation.transitionProperty] ?? ''),
              }
            })
            .sort((a, b) => a.property.localeCompare(b.property)),
        }
      })

    const opening = await stepOf(toggle)
    expect(opening).toMatchObject({
      display: 'flex',
      pressable: true,
      hidden: false,
      inert: false,
      reachable: true,
    })
    expect(opening.transitions).toEqual([
      { property: 'opacity', duration: 240, easing: EASE_OUT, from: '0' },
      { property: 'transform', duration: 240, easing: EASE_OUT, from: 'translateY(-8px)' },
    ])
    await settled(page)
    await expect(menu).toHaveCSS('opacity', '1')
    await expect(menu).toHaveCSS('transform', 'none')
    expect(await placed()).toEqual(place)
    // The cross of the button is drawn from the state it tells.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(
      await toggle.evaluate((node) =>
        [...node.querySelectorAll('span')].map((line) => getComputedStyle(line).transform),
      ),
    ).not.toContain('none')

    await toggle.focus()
    const closing = await stepOf(toggle)
    // Still shown while it fades out, where it stood, and already out of reach: `inert` takes
    // away the focus and the presses alike.
    expect(closing).toMatchObject({
      display: 'flex',
      pressable: false,
      hidden: true,
      inert: true,
      reachable: false,
    })
    expect(
      closing.transitions.map(({ property, duration, easing }) => [property, duration, easing]),
    ).toEqual([
      // `display` switches at the end of the leaving and follows no curve.
      ['display', 160, 'ease'],
      ['opacity', 160, EASE_IN],
      ['transform', 160, EASE_IN],
    ])
    expect(await placed()).toEqual(place)
    // The next stop of the keyboard is on the page, not in the leaving panel.
    await toggle.focus()
    await page.keyboard.press('Tab')
    expect(await menu.evaluate((node) => node.contains(document.activeElement))).toBe(false)
    await expect(menu).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('pricing in motion', () => {
  test('tells another plan with a rise of its name and never animates a sum', async ({ page }) => {
    await openAt(page, 1440)
    const pricing = page.locator('#pricing')
    const slider = pricing.getByRole('slider')
    await hydrated(slider)
    await bringIntoWindow(page, slider)
    const name = () => pricing.getByText(/^Тариф «/)
    const first = await name().textContent()
    /** Animations and transitions of anything that shows a number of the calculator or a price. */
    const numbersInMotion = () =>
      pricing.evaluate((node) =>
        node
          .getAnimations({ subtree: true })
          .map((animation) => (animation.effect as KeyframeEffect).target)
          .filter((target) => target?.matches('strong, output, input, p:not(:has(> span))'))
          .map((target) => target?.localName),
      )
    expect(await motionOf(name())).toEqual([])

    // One pack more with the same plan — thirty tasks take two, forty take three: words change,
    // nothing moves. The page binds a number to its word with a non-breaking space.
    await expect(pricing.getByText(/2.дополнительных пакета/)).toBeVisible()
    await slider.fill('40')
    await expect(pricing.getByText(/3.дополнительных пакета/)).toBeVisible()
    await expect(name()).toHaveText(first ?? '')
    expect(await motionOf(name())).toEqual([])
    expect(await numbersInMotion()).toEqual([])

    await slider.fill('300')
    await expect(name()).not.toHaveText(first ?? '')
    expect(await motionOf(name())).toEqual([
      {
        name: 'valueRise',
        pseudo: null,
        duration: 360,
        delay: 0,
        easing: EASE_OUT,
        fill: 'backwards',
        properties: ['transform'],
        from: { transform: 'translateY(6px)' },
      },
    ])
    // The sums, the number of tasks and the slider change at once.
    expect(await numbersInMotion()).toEqual([])
    await settled(page)
    await expect(name()).toHaveCSS('transform', 'none')
    // Seen, not heard: the name is outside the region that announces the result.
    expect(await name().evaluate((node) => node.closest('[aria-live]'))).toBeNull()
  })
})

test.describe('current section of the navigation', () => {
  const marked = (page: Page) =>
    page
      .locator('#top > header a[aria-current]')
      .evaluateAll((links) =>
        links.map(
          (link) => `${link.closest('nav')?.getAttribute('aria-label')}: ${link.textContent}`,
        ),
      )

  test('draws the line under the section being read and under none between them', async ({
    page,
  }) => {
    await openAt(page, 1440)
    await hydrated(menuToggle(page))
    await page.getByRole('slider').waitFor()
    expect(await marked(page)).toEqual([])

    const line = (label: string) =>
      page
        .getByRole('navigation', { name: 'Основная навигация' })
        .getByRole('link', { name: label })
        .evaluate((link) => {
          const style = getComputedStyle(link, '::after')
          return {
            transform: style.transform,
            transition: `${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`,
          }
        })
    await bringIntoWindow(page, page.locator('#pricing'))
    await expect
      .poll(() => marked(page))
      .toEqual(['Основная навигация: Тарифы', 'Мобильная навигация: Тарифы'])
    await settled(page)
    expect(await line('Тарифы')).toEqual({
      transform: 'matrix(1, 0, 0, 1, 0, 0)',
      transition: `transform 0.24s ${EASE_OUT}`,
    })
    expect((await line('Вопросы')).transform).toBe('matrix(0, 0, 0, 1, 0, 0)')

    // The safety block is not a section of the navigation: no link is marked there.
    await bringIntoWindow(page, page.locator('#safety'))
    await expect.poll(() => marked(page)).toEqual([])
    await settled(page)
    expect((await line('Тарифы')).transform).toBe('matrix(0, 0, 0, 1, 0, 0)')

    await bringIntoWindow(page, page.locator('#faq'))
    await expect
      .poll(() => marked(page))
      .toEqual(['Основная навигация: Вопросы', 'Мобильная навигация: Вопросы'])
  })

  test('marks it in the mobile menu with a line and the colour of an accent text', async ({
    page,
  }) => {
    await openAt(page, 390, 844)
    const toggle = menuToggle(page)
    await hydrated(toggle)
    await page.getByRole('slider').waitFor()
    await bringIntoWindow(page, page.locator('#demo'))
    await expect.poll(() => marked(page)).toContain('Мобильная навигация: Пример')
    // A press of the pointer, not `click()` of the runner: that one first scrolls its target
    // «into view», and for a control of the sticky header the browser scrolls the page.
    const button = await toggle.boundingBox()
    if (!button) throw new Error('The header has no menu button')
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2)
    const menu = page.getByRole('navigation', { name: 'Мобильная навигация' })
    await expect(menu).toBeVisible()
    await settled(page)
    const links = await menu.getByRole('link').evaluateAll((all) =>
      all.map((link) => {
        const mark = getComputedStyle(link, '::before')
        return {
          label: link.textContent,
          color: getComputedStyle(link).color,
          mark:
            mark.content === 'none'
              ? null
              : `${mark.borderLeftWidth} ${mark.borderLeftStyle} ${mark.borderLeftColor} ${mark.height}`,
        }
      }),
    )
    // Not the colour alone: the current link has a line at its left.
    // The four sections, the main action in its short form and the phone of the service.
    expect(links.map((link) => link.label)).toEqual([
      'Пример',
      'Возможности',
      'Тарифы',
      'Вопросы',
      'Подключить сайт',
      PHONE.text,
    ])
    expect(links[0]).toEqual({
      label: 'Пример',
      color: ACCENT_TEXT,
      mark: `2px solid ${ACCENT_TEXT} 20px`,
    })
    for (const link of links.slice(1)) {
      expect(link.color, link.label ?? '').toBe(INK)
      expect(link.mark, link.label ?? '').toBeNull()
    }
    expect(contrast(ACCENT_TEXT, PAPER)).toBeGreaterThanOrEqual(4.5)
  })
})

test.describe('example under the first screen', () => {
  // The demo stood beside the heading; now it has a section of its own, in the middle of the page.
  test('follows the first screen in a section of its own, centred', async ({ page }) => {
    await openAt(page, 320)
    await expect(page.locator('section:has(#hero-title) + section')).toHaveAttribute('id', 'demo')
    await expect(page.locator('#demo #site-demo')).toHaveCount(1)
    await expect(page.locator('#demo-title + p')).toHaveText(
      'Сайт кофейни для примера. Выберите просьбу — и посмотрите, что изменится.',
    )
    await atWidths(page, [320, 390, 768, 1024, 1440, 1920], async (width, soft) => {
      const places = await page.evaluate(() => {
        const box = (selector: string) => {
          const element = document.querySelector(selector)
          if (!element) throw new Error(`No ${selector} on the page`)
          const { left, right, top, bottom } = element.getBoundingClientRect()
          return { left, right, top, bottom, middle: (left + right) / 2 }
        }
        return {
          hero: box('section:has(#hero-title)'),
          section: box('#demo'),
          title: box('#demo-title'),
          lead: box('#demo-title + p'),
          demo: box('#site-demo'),
          page: document.documentElement.clientWidth,
        }
      })
      soft(places.section.top).toBeGreaterThanOrEqual(places.hero.bottom - 0.5)
      soft(places.title.bottom).toBeLessThanOrEqual(places.lead.top)
      soft(places.lead.bottom).toBeLessThanOrEqual(places.demo.top)
      for (const part of [places.title, places.lead, places.demo]) {
        soft(Math.abs(part.middle - places.page / 2)).toBeLessThanOrEqual(1)
        soft(part.left).toBeGreaterThanOrEqual(0)
        soft(part.right).toBeLessThanOrEqual(width)
      }
    })
  })
})

test.describe('running line of the systems', () => {
  const LINES = '#platforms > div[aria-hidden="true"] > div'

  /** The two lines: their names, where they are and what moves them. */
  const lines = (page: Page) =>
    page.locator(LINES).evaluateAll((all) =>
      all.map((line) => {
        const [animation] = line.getAnimations()
        const effect = animation?.effect as KeyframeEffect | null | undefined
        const timing = effect?.getComputedTiming()
        return {
          names: [...line.children].map((item) => item.firstElementChild?.textContent ?? ''),
          animation: animation instanceof CSSAnimation ? animation.animationName : null,
          moving: line.getAnimations().length,
          state: animation?.playState ?? null,
          iterations: timing?.iterations ?? null,
          duration: timing?.duration ?? null,
          direction: timing?.direction ?? null,
          // CSS puts the curve of an animation on its keyframes.
          easing: effect?.getKeyframes()[0]?.easing ?? null,
          transform: getComputedStyle(line).transform,
          // How far the line has run, in its own row: the rows are turned a little.
          x: new DOMMatrix(getComputedStyle(line).transform).m41,
          width: (line as HTMLElement).offsetWidth,
          row: (line.parentElement as HTMLElement).offsetWidth,
        }
      }),
    )

  test('runs two lines towards each other for ever where motion is welcome', async ({ page }) => {
    await openAt(page, 1440)
    await bringIntoWindow(page, page.locator('#platforms'))
    const first = await lines(page)
    expect(first).toHaveLength(2)
    expect(first.map((line) => plainName(line.animation ?? ''))).toEqual([
      RUNNING_LINE,
      RUNNING_LINE,
    ])
    for (const line of first) {
      expect(line.state).toBe('running')
      expect(line.iterations).toBe(Infinity)
      // An even pace: the line neither starts nor stops.
      expect(line.easing).toBe('linear')
      expect(line.moving).toBe(1)
    }
    expect(first.map((line) => line.duration)).toEqual([38_000, 46_000])
    expect(first.map((line) => line.direction)).toEqual(['normal', 'reverse'])

    // A third of a second later the upper line has gone to the left and the lower to the right.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const start = performance.now()
          const wait = () =>
            performance.now() - start < 320 ? requestAnimationFrame(wait) : done()
          wait()
        }),
    )
    const [upper, lower] = await lines(page)
    expect(upper?.x).toBeLessThan(first[0]?.x ?? NaN)
    expect(lower?.x).toBeGreaterThan(first[1]?.x ?? NaN)
  })

  // A line holds its names twice and runs by half of itself. The half must be as wide as the row
  // at least, or the end of the line would show before the run starts again.
  test('names the five systems, each line twice over and wider than its row', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 768, 1440, 1920], async (width, soft) => {
      const both = await lines(page)
      soft(both).toHaveLength(2)
      for (const line of both) {
        const half = line.names.length / 2
        soft(line.names.slice(half)).toEqual(line.names.slice(0, half))
        soft(line.row).toBeGreaterThan(width)
        soft(line.width / 2).toBeGreaterThanOrEqual(line.row)
      }
      soft(new Set(both.flatMap((line) => line.names))).toEqual(new Set(SYSTEMS))
    })
  })

  // The rule of the page: what moves, moves once and rests. The running line is the one
  // exception, the owner's choice (13.11.2026); nothing else may run for ever.
  test('is the only thing on the page that never rests', async ({ page }) => {
    await openAt(page, 1440)
    const demo = page.locator('#site-demo')
    await hydrated(demo.getByRole('button', { name: 'Применить правку' }))
    const endless = () =>
      page.evaluate(
        (runningLine) =>
          document
            .getAnimations()
            .filter((animation) => {
              const timing = animation.effect?.getComputedTiming()
              return timing?.iterations === Infinity || timing?.duration === Infinity
            })
            .filter(
              (animation) =>
                !(
                  animation instanceof CSSAnimation && animation.animationName.includes(runningLine)
                ),
            )
            .map((animation) => {
              const target = (animation.effect as KeyframeEffect).target
              const name = animation instanceof CSSAnimation ? animation.animationName : 'not CSS'
              return `${target?.localName}.${target?.getAttribute('class') ?? ''} ${name}`
            }),
        RUNNING_LINE,
      )
    expect(await endless()).toEqual([])
    // The states of the demo, the busy ones among them.
    await demo.getByRole('button', { name: 'Применить правку' }).click()
    expect(await endless()).toEqual([])
    await expect(demo.getByText('Изменено')).toBeVisible()
    expect(await endless()).toEqual([])
    // The way through the page: whatever comes into the window plays and rests.
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    for (let top = 0; top < height; top += 600) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), top)
      expect(await endless(), `at ${top}px`).toEqual([])
    }
    // And the line is the two rows of the systems, nothing more.
    const running = await page.evaluate(
      (runningLine) =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation instanceof CSSAnimation && animation.animationName.includes(runningLine),
          ).length,
      RUNNING_LINE,
    )
    expect(running).toBe(2)
  })

  test('causes no scroll sideways, though it is wider than the window', async ({ page }) => {
    await openAt(page, 320)
    await atWidths(page, [320, 390, 768, 1024, 1440, 1920], async (width, soft) => {
      const read = await page.evaluate(async () => {
        const section = document.querySelector('#platforms')
        if (!section) throw new Error('No section of the systems')
        window.scrollTo({ left: 400, behavior: 'instant' })
        await new Promise<void>((done) => requestAnimationFrame(() => done()))
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          body: document.body.scrollWidth - window.innerWidth,
          scrolled: window.scrollX,
          section: section.getBoundingClientRect().width,
          clip: getComputedStyle(section).overflowX,
          page: document.documentElement.clientWidth,
        }
      })
      soft(read.overflow).toBeLessThanOrEqual(0)
      soft(read.body).toBeLessThanOrEqual(0)
      soft(read.scrolled).toBe(0)
      soft(read.section).toBe(read.page)
      // Clipped, not hidden: a hidden overflow would make the section a scroll container.
      soft(read.clip).toBe('clip')
      soft((await lines(page)).every((line) => line.width > width)).toBe(true)
    })
  })

  test('is hidden from a screen reader, which reads the five systems as a list', async ({
    page,
  }) => {
    await page.goto('/')
    const section = page.locator('#platforms')
    const line = section.locator('> div[aria-hidden="true"]')
    await expect(line).toHaveCount(1)
    // Nothing in the ornament takes the focus.
    await expect(line.locator('a, button, input, [tabindex]')).toHaveCount(0)
    const list = section.getByRole('list', { name: 'Поддерживаемые системы' })
    await expect(list.getByRole('listitem')).toHaveText(SYSTEMS)
    // Heard, not seen: the list takes no room on the page.
    const box = await list.boundingBox()
    expect(box?.width).toBeLessThanOrEqual(1)
    expect(box?.height).toBeLessThanOrEqual(1)
    // The systems are also named in the text under the heading, for every reader.
    await expect(section.locator('#platforms-title + p')).toHaveText(
      'WordPress, Joomla, OpenCart, MODX и 1С-Битрикс — Радити работает с каждой из этих систем.',
    )
    // What a screen reader is given: each system in the text and in the list, and not once more
    // for every pass of the line.
    const heard = await section.ariaSnapshot()
    for (const system of SYSTEMS) {
      const times = heard.split(system).length - 1
      // «OpenCart» is also the example of the dialogue under the line.
      expect(times, system).toBe(system === 'OpenCart' ? 3 : 2)
    }
  })

  test('asks its question in the heading and leads to the form of a lead', async ({ page }) => {
    await page.goto('/')
    const section = page.locator('#platforms')
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(
      'На чём сделан ваш сайт? Скорее всего, подойдёт.',
      { useInnerText: true },
    )
    await expect(section.getByText('У меня магазин на OpenCart. Это подойдёт?')).toBeVisible()
    await expect(section.getByText('Подойдёт. Подключим и настроим бесплатно.')).toBeVisible()
    await expect(section.getByRole('link')).toHaveCount(1)
    await expect(section.getByRole('link', { name: 'Подключить сайт' })).toHaveAttribute(
      'href',
      '#lead',
    )
    // The talk is light on the orange field and dark with a light text: both read at 4.5:1.
    for (const bubble of await section.locator('a[href="#lead"]').locator('xpath=../div/p').all()) {
      const { color, background } = await bubble.evaluate((node) => ({
        color: getComputedStyle(node).color,
        background: getComputedStyle(node).backgroundColor,
      }))
      expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test.describe('under reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('stands still with its names in the window', async ({ page }) => {
      await openAt(page, 1440)
      await hydrated(page.locator('#site-demo').getByRole('button', { name: 'График' }))
      await bringIntoWindow(page, page.locator('#platforms'))
      const both = await lines(page)
      expect(both).toHaveLength(2)
      for (const line of both) {
        expect(line.animation).toBeNull()
        expect(line.moving).toBe(0)
        expect(line.transform).toBe('none')
      }
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
      // A second later the lines are where they were.
      const places = () =>
        page
          .locator(`${LINES} > span:first-child`)
          .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().left))
      const before = await places()
      await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 1000)))
      expect(await places()).toEqual(before)
      // The first name of each line is on the screen: the still line is still a line of names.
      for (const left of before) {
        expect(left).toBeGreaterThanOrEqual(-60)
        expect(left).toBeLessThan(1440)
      }
    })
  })
})

test.describe('form of a lead', () => {
  const ERRORS = {
    site: 'Например, kofeinya.ru',
    contact: 'Нужен номер телефона или ник в Telegram',
    consent: 'Без согласия мы не сможем ответить',
  }

  type Sent = { method: string; type: string | undefined; body: unknown }

  /** Answers the request of the form instead of the server and keeps what the form sent. */
  async function answerLeads(
    page: Page,
    answer: { status?: number; json?: unknown; body?: string } = {},
  ): Promise<Sent[]> {
    const sent: Sent[] = []
    await page.unroute('**/api/leads')
    await page.route('**/api/leads', async (route) => {
      const request = route.request()
      sent.push({
        method: request.method(),
        type: request.headers()['content-type'],
        body: request.postDataJSON() as unknown,
      })
      await (answer.body === undefined
        ? route.fulfill({ status: answer.status ?? 200, json: answer.json ?? { ok: true } })
        : route.fulfill({ status: answer.status ?? 200, body: answer.body }))
    })
    return sent
  }

  test('asks for two fields and a consent, and offers to call instead', async ({ page }) => {
    await page.goto('/')
    const lead = page.locator('#lead')
    const form = lead.locator('form')
    await hydrated(form.getByLabel('Адрес сайта'))
    // Two fields (the owner, 13.11.2026): the name, the mail and the task are asked later.
    const fields = form.getByRole('textbox')
    await expect(fields).toHaveCount(2)
    await expect(form.getByLabel('Адрес сайта')).toHaveAttribute('name', 'site')
    await expect(form.getByLabel('Телефон или Telegram')).toHaveAttribute('name', 'phone')
    for (const field of await fields.all()) {
      await expect(field).toHaveAttribute('required', '')
      await expect(field).toHaveValue('')
    }
    await expect(
      form.locator('[name="name"], [name="email"], [name="task"], textarea'),
    ).toHaveCount(0)
    await expect(form.getByText('Оба поля обязательны')).toBeVisible()
    await expect(form.getByRole('checkbox')).not.toBeChecked()
    await expect(form.getByRole('link', { name: 'обработку персональных данных' })).toHaveAttribute(
      'href',
      '/terms/consent',
    )

    // The trap for robots: hidden from people, from a screen reader and from the keyboard.
    const trap = form.locator('input[name="raditi_check"]')
    await expect(trap).toHaveCount(1)
    await expect(trap).toHaveAttribute('tabindex', '-1')
    expect(await trap.evaluate((node) => node.closest('[aria-hidden="true"]') !== null)).toBe(true)
    await form.getByLabel('Адрес сайта').focus()
    const stops: string[] = []
    for (let press = 0; press < 5; press++) {
      await page.keyboard.press('Tab')
      stops.push(
        await page.evaluate(() => {
          const active = document.activeElement
          const text = active?.getAttribute('name') ?? active?.textContent ?? ''
          // The page binds short words with non-breaking spaces.
          return text.replaceAll('\u00a0', ' ').trim()
        }),
      )
    }
    expect(stops).toEqual([
      'phone',
      'consent',
      'обработку персональных данных',
      'Отправить заявку',
      // The form is over: the next stop is the first question.
      QUESTIONS[0],
    ])

    // Beside the form: the phone of the service for whoever would rather call.
    const call = lead.getByRole('link', { name: PHONE.text })
    await expect(call).toHaveAttribute('href', PHONE.href)
    await expect(lead.getByText(`Или позвоните: ${PHONE.text}`)).toBeVisible()
  })

  test('says under each field what is wrong and sends nothing', async ({ page }) => {
    await page.goto('/')
    const sent = await answerLeads(page)
    const form = page.locator('#lead form')
    const site = form.getByLabel('Адрес сайта')
    const contact = form.getByLabel('Телефон или Telegram')
    const consent = form.getByRole('checkbox')
    const send = form.getByRole('button', { name: 'Отправить заявку' })
    await hydrated(site)
    await send.click()

    for (const text of Object.values(ERRORS)) await expect(form.getByText(text)).toBeVisible()
    // Each message is tied to its field, and the focus goes to the first field to correct.
    for (const [field, text] of [
      [site, ERRORS.site],
      [contact, ERRORS.contact],
      [consent, ERRORS.consent],
    ] as const) {
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await expect(field).toHaveAccessibleDescription(text)
    }
    await expect(site).toBeFocused()

    // After the first try a field says at once when it is right again.
    await site.fill('kofeinya.ru')
    await expect(form.getByText(ERRORS.site)).toHaveCount(0)
    await expect(site).not.toHaveAttribute('aria-invalid')
    // A phone number or a Telegram name with its sign: a bare word is neither.
    for (const wrong of ['12345', 'kofeinya_owner', 'mail@kofeinya.ru']) {
      await contact.fill(wrong)
      await expect(form.getByText(ERRORS.contact), wrong).toBeVisible()
    }
    await send.click()
    await expect(contact).toBeFocused()
    for (const right of ['8 (900) 000-00-00', '@kofeinya_owner', 'https://t.me/kofeinya_owner']) {
      await contact.fill(right)
      await expect(form.getByText(ERRORS.contact), right).toHaveCount(0)
    }
    await send.click()
    await expect(form.getByText(ERRORS.consent)).toBeVisible()
    await expect(consent).toBeFocused()
    expect(sent).toEqual([])
  })

  for (const [kind, contact] of [
    ['a phone number', '+7 900 000-00-00'],
    ['a Telegram name', '@kofeinya_owner'],
    ['a Telegram link', 't.me/kofeinya_owner'],
  ] as const) {
    test(`sends the site with ${kind} and says the lead is in`, async ({ page }) => {
      await page.goto('/')
      const sent = await answerLeads(page)
      const lead = page.locator('#lead')
      await fillLead(page, { site: 'kofeinya.ru', contact })
      await lead.getByRole('button', { name: 'Отправить заявку' }).click()

      const done = lead.getByRole('status')
      await expect(done).toBeVisible()
      // One request, as the visitor typed it; the trap went empty.
      expect(sent).toEqual([
        {
          method: 'POST',
          type: 'application/json',
          body: { site: 'kofeinya.ru', phone: contact, consent: true, check: '' },
        },
      ])
      // The card speaks of the site: the form asks no name to greet by.
      const heading = done.getByRole('heading', { level: 3 })
      await expect(heading).toHaveText('Заявка у нас.')
      await expect(heading).toBeFocused()
      await expect(done).toContainText('Свяжемся с вами и подключим kofeinya.ru.')
      await expect(done).toContainText('50 кредитов придут, как только вы зарегистрируетесь.')
      await expect(lead.locator('form')).toHaveCount(0)

      // Another lead starts from an empty form.
      await done.getByRole('button', { name: 'Отправить ещё одну' }).click()
      const form = lead.locator('form')
      await expect(form.getByLabel('Адрес сайта')).toHaveValue('')
      await expect(form.getByLabel('Телефон или Telegram')).toHaveValue('')
      await expect(form.getByRole('checkbox')).not.toBeChecked()
      await expect(form.locator('[aria-invalid]')).toHaveCount(0)
      expect(sent).toHaveLength(1)
    })
  }

  test('shows the refusal of the server and keeps what was typed', async ({ page }) => {
    await page.goto('/')
    const lead = page.locator('#lead')
    const form = lead.locator('form')
    const send = form.getByRole('button', { name: 'Отправить заявку' })
    const typed = async () => {
      await expect(form.getByLabel('Адрес сайта')).toHaveValue('kofeinya.ru')
      await expect(form.getByLabel('Телефон или Telegram')).toHaveValue('+7 900 000-00-00')
      await expect(form.getByRole('checkbox')).toBeChecked()
      await expect(send).toBeEnabled()
      await expect(lead.getByRole('status')).toHaveCount(0)
    }
    await fillLead(page, { site: 'kofeinya.ru', contact: '+7 900 000-00-00' })

    // The words of the server, when it has them.
    let sent = await answerLeads(page, {
      status: 429,
      json: { message: 'Слишком много заявок. Попробуйте через час.' },
    })
    await send.click()
    await expect(form.getByRole('alert')).toHaveText('Слишком много заявок. Попробуйте через час.')
    expect(sent).toHaveLength(1)
    await typed()

    // A field the server did not take: its message stands under the field.
    sent = await answerLeads(page, {
      status: 400,
      json: { message: 'Проверьте поля формы.', fields: { phone: ERRORS.contact } },
    })
    await send.click()
    await expect(form.getByRole('alert')).toHaveText('Проверьте поля формы.')
    await expect(form.getByLabel('Телефон или Telegram')).toHaveAccessibleDescription(
      ERRORS.contact,
    )
    expect(sent).toHaveLength(1)

    // No words from the server: the form says its own.
    sent = await answerLeads(page, { status: 500, body: 'Internal Server Error' })
    await send.click()
    await expect(form.getByRole('alert')).toHaveText(
      'Не удалось отправить заявку. Попробуйте ещё раз.',
    )
    expect(sent).toHaveLength(1)
    await typed()

    // No connection at all.
    await page.unroute('**/api/leads')
    await page.route('**/api/leads', (route) => route.abort('internetdisconnected'))
    await send.click()
    await expect(form.getByRole('alert')).toHaveText(
      'Не удалось отправить заявку: нет связи. Проверьте интернет и попробуйте ещё раз.',
    )
    await typed()

    // And the next try goes through.
    sent = await answerLeads(page)
    await send.click()
    await expect(lead.getByRole('status')).toBeVisible()
    expect(sent).toHaveLength(1)
  })

  test('keeps the fields and the action inside the page, large enough for a finger', async ({
    page,
  }) => {
    await openAt(page, 320)
    await hydrated(page.locator('#lead form').getByLabel('Адрес сайта'))
    // With the messages shown: the tallest state of the form.
    await page.locator('#lead form').getByRole('button', { name: 'Отправить заявку' }).click()
    await atWidths(page, [320, 390, 768, 1024, 1440], async (width, soft) => {
      const parts = await page.locator('#lead').evaluate((section) => {
        const controls = [
          ...section.querySelectorAll('form input:not([name="raditi_check"]), form button'),
        ]
        return controls.map((control) => {
          const { left, right, height } = control.getBoundingClientRect()
          return {
            name: control.getAttribute('name') ?? control.textContent?.trim() ?? '',
            checkbox: control.getAttribute('type') === 'checkbox',
            left,
            right,
            height,
          }
        })
      })
      soft(parts).toHaveLength(4)
      for (const part of parts) {
        soft(part.left, part.name).toBeGreaterThanOrEqual(0)
        soft(part.right, part.name).toBeLessThanOrEqual(width)
        if (!part.checkbox) soft(part.height, part.name).toBeGreaterThanOrEqual(44)
      }
      soft(await textOutsideTheWindow(page)).toEqual([])
    })
  })
})

test.describe('phone of the service', () => {
  test('stands in the mobile menu with the main action, each a way out of the menu', async ({
    page,
  }) => {
    await openAt(page, 390, 844)
    const toggle = menuToggle(page)
    await hydrated(toggle)
    // In the row of a phone there is no room for the number: it is in the menu.
    await expect(page.locator('#top > header > div:first-child a[href^="tel:"]')).toBeHidden()
    await toggle.click()
    const menu = page.getByRole('navigation', { name: 'Мобильная навигация' })
    await expect(menu).toBeVisible()
    await settled(page)
    const phone = menu.getByRole('link', { name: PHONE.text })
    await expect(phone).toHaveAttribute('href', PHONE.href)
    const action = menu.getByRole('link', { name: 'Подключить сайт' })
    await expect(action).toHaveAttribute('href', '#lead')
    for (const link of [phone, action]) {
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    // The number is the last line of the menu.
    await expect(menu.getByRole('link').last()).toHaveText(PHONE.text)

    await action.click()
    await expect(menu).toBeHidden()
    await expect(page).toHaveURL(/#lead$/)
  })
})

test.describe('for the search engines', () => {
  test('names the address of the page and describes it for a shared link', async ({
    page,
    baseURL,
  }) => {
    await page.goto('/')
    const home = new URL('/', baseURL).href
    const canonical = page.locator('link[rel="canonical"]')
    await expect(canonical).toHaveCount(1)
    expect(new URL((await canonical.getAttribute('href')) ?? '').href).toBe(home)
    const og = async (property: string) => {
      const tag = page.locator(`meta[property="og:${property}"]`)
      await expect(tag, property).toHaveCount(1)
      return tag.getAttribute('content')
    }
    expect(await og('title')).toBe(await page.title())
    expect(await og('description')).toBe(
      await page.locator('meta[name="description"]').getAttribute('content'),
    )
    expect(new URL((await og('url')) ?? '').href).toBe(home)
    expect(await og('type')).toBe('website')
    expect(await og('locale')).toBe('ru_RU')
    expect(await og('site_name')).toBe('Радити')
  })

  test('tells the service, its plans and its five questions in the words of schema.org', async ({
    page,
    baseURL,
  }) => {
    await page.goto('/')
    const scripts = page.locator('script[type="application/ld+json"]')
    await expect(scripts).toHaveCount(1)
    type Node = Record<string, unknown> & { '@type'?: string }
    const schema = JSON.parse((await scripts.textContent()) ?? '') as {
      '@context'?: string
      '@graph'?: Node[]
    }
    expect(schema['@context']).toBe('https://schema.org')
    const graph = schema['@graph'] ?? []
    expect(graph.map((node) => node['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
      'FAQPage',
    ])
    const node = (type: string) => graph.find((item) => item['@type'] === type) ?? {}
    const home = new URL('/', baseURL).href

    expect(node('Organization')).toMatchObject({
      name: 'Радити',
      url: home,
      telephone: '+79190483683',
    })
    expect(node('WebSite')).toMatchObject({ name: 'Радити', url: home, inLanguage: 'ru' })
    // The plans of the page, by their names and prices in rubles.
    const plans = await page.locator('#pricing article').evaluateAll((articles) =>
      articles.map((article) => ({
        name: article.querySelector('h3')?.textContent ?? '',
        price: (article.querySelector('p > strong')?.textContent ?? '').replace(/\D/g, ''),
      })),
    )
    expect(plans).toHaveLength(3)
    const service = node('SoftwareApplication')
    expect(service).toMatchObject({
      name: 'Радити',
      url: home,
      description: await page.locator('meta[name="description"]').getAttribute('content'),
    })
    const offers = service.offers as { name: string; price: unknown; priceCurrency: string }[]
    expect(
      offers.map((offer) => ({
        name: offer.name,
        price: String(Number(offer.price)),
        currency: offer.priceCurrency,
      })),
    ).toEqual(
      plans.map((plan) => ({ name: `Тариф «${plan.name}»`, price: plan.price, currency: 'RUB' })),
    )

    // The questions of the page with their answers, word for word.
    const shown = await page.locator('#faq details').evaluateAll((all) =>
      all.map((details) => ({
        '@type': 'Question',
        // The page binds short words with non-breaking spaces; the markup has plain ones.
        name: (details.querySelector('summary')?.textContent ?? '').replaceAll('\u00a0', ' '),
        acceptedAnswer: {
          '@type': 'Answer',
          text: (details.querySelector('p')?.textContent ?? '').replaceAll('\u00a0', ' '),
        },
      })),
    )
    expect(shown.map((question) => question.name)).toEqual(QUESTIONS)
    expect(node('FAQPage').mainEntity).toEqual(shown)
  })

  test('opens the landing and the documents to a robot and closes the cabinet', async ({
    request,
    baseURL,
  }) => {
    const answer = await request.get('/robots.txt')
    expect(answer.status()).toBe(200)
    expect(answer.headers()['content-type']).toContain('text/plain')
    const rules = (await answer.text()).split('\n').map((line) => line.trim())
    expect(rules).toContain('User-Agent: *')
    expect(rules).toContain('Allow: /')
    for (const closed of ['/api/', '/chats', '/projects', '/settings', '/sign-in', '/sign-up']) {
      expect(rules, closed).toContain(`Disallow: ${closed}`)
    }
    // Neither the landing nor a document is closed.
    for (const rule of rules.filter((line) => line.startsWith('Disallow:'))) {
      expect(rule).not.toBe('Disallow: /')
      expect(rule).not.toContain('/terms')
    }
    expect(rules).toContain(`Sitemap: ${new URL('/sitemap.xml', baseURL).href}`)
  })

  test('lists the landing and every document of the footer in the map of the site', async ({
    page,
    request,
    baseURL,
  }) => {
    const answer = await request.get('/sitemap.xml')
    expect(answer.status()).toBe(200)
    expect(answer.headers()['content-type']).toContain('xml')
    const map = await answer.text()
    const listed = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(listed[0]).toBe(new URL('/', baseURL).href)

    await page.goto('/')
    const documents = await page
      .getByRole('navigation', { name: 'Документы' })
      .locator('a[href^="/terms/"]')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
    expect(documents.length).toBeGreaterThanOrEqual(5)
    expect(listed.slice(1).sort()).toEqual([...documents].sort())
    // Nothing of the cabinet or of the sign-in is offered to a search.
    for (const address of listed) expect(address).not.toMatch(/sign-|chats|projects|settings|api/)
  })
})
