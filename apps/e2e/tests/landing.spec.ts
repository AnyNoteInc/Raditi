import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

// DOM and geometry assertions, not pixel snapshots: they hold on any OS and font rendering.
// Needs the web server and a database with seeds (the pricing slider renders from the plans).

const INK = 'rgb(36, 23, 16)'
const PAPER = 'rgb(255, 248, 236)'
const PAPER_2 = 'rgb(243, 231, 213)'
const ACCENT = 'rgb(255, 107, 36)'
const ACCENT_TEXT = 'rgb(166, 61, 18)'
const MARKER = 'rgb(255, 197, 71)'
const HEADING = 'Напишите в чат. Сайт поправим.'

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

/** Whether the highlighted word of the hero heading is really painted: not clipped, not covered. */
function highlightedWordIsHit(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const word = document.querySelector('#hero-title em')
    if (!word) return false
    const box = word.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return hit !== null && (hit === word || word.contains(hit))
  })
}

/** Waits until React has taken the element over: a key pressed or a value set before that is not heard. */
function hydrated(element: Locator): Promise<void> {
  return element.evaluate(
    (node) =>
      new Promise<void>((done) => {
        // React keeps its props on a hydrated node.
        const check = () =>
          Object.keys(node).some((key) => key.startsWith('__reactProps'))
            ? done()
            : requestAnimationFrame(check)
        check()
      }),
  )
}

/** Waits until no animation or transition is running: a reveal moves a section from under the
 *  pointer, and a colour read on the way belongs to neither state. */
function settled(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
    // Frames are counted and the `finished` promises are not awaited: the answer of a closed
    // question has an animation that is never painted and never ends.
    for (let quiet = 0; quiet < 2;) {
      await frame()
      await frame()
      const running = document
        .getAnimations()
        .some((animation) => animation.pending || animation.playState === 'running')
      quiet = running ? 0 : quiet + 1
    }
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

test.describe('hero heading', () => {
  // 541–800px is where the second line used to be clipped away after the entrance.
  for (const width of [320, 390, 541, 640, 768, 800, 1024, 1440]) {
    test(`shows every word at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')

      await expect.poll(() => highlightedWordIsHit(page), { timeout: 10_000 }).toBe(true)
      const heading = await page.evaluate(() => {
        const lines = [...document.querySelectorAll('#hero-title > span')]
        const title = document.querySelector('#hero-title')
        return {
          text: (title?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          displays: lines.map((line) => getComputedStyle(line).display),
          lastLine: (() => {
            const last = lines.at(-1)
            if (!last) throw new Error('The heading has no lines')
            const style = getComputedStyle(last)
            const range = document.createRange()
            range.selectNodeContents(last)
            return {
              tracking: parseFloat(style.letterSpacing) / parseFloat(style.fontSize),
              lines: range.getClientRects().length,
            }
          })(),
          // Text extent, not the box: a block is as wide as its column even when its text overflows.
          right: Math.max(
            ...lines.map((line) => {
              const range = document.createRange()
              range.selectNodeContents(line)
              return range.getBoundingClientRect().right
            }),
          ),
        }
      })
      expect(heading.text).toBe(HEADING)
      expect(heading.displays).toEqual(['block', 'block', 'block'])
      expect(heading.right).toBeLessThanOrEqual(width)
      // The third line is tracked from its own size, as the two large ones are, and stays whole.
      expect(heading.lastLine.tracking).toBeCloseTo(-0.04, 3)
      expect(heading.lastLine.lines).toBe(1)
      // The entrance must not leave a clip on the lines once it has played.
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.querySelectorAll('#hero-title > span')].map(
              (line) => getComputedStyle(line).clipPath,
            ),
          ),
        )
        .toEqual(['none', 'none', 'none'])
    })
  }
})

test.describe('first screen in a low window', () => {
  const action = 'section[aria-labelledby="hero-title"] a[href="/sign-up"]'
  const headingSizes = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('#hero-title > span')].map((line) =>
        parseFloat(getComputedStyle(line).fontSize),
      ),
    )

  // A laptop of 1366x768 or 1280x720 leaves the page about this much under the browser chrome.
  for (const [width, height] of [
    [1366, 640],
    [1280, 600],
    [1024, 640],
  ] as const) {
    test(`keeps the main action above the fold at ${width}x${height}px`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.goto('/')
      await page.evaluate(() => document.fonts.ready)
      const box = await page.locator(action).boundingBox()
      if (!box) throw new Error('The first screen has no main action')
      expect(box.y + box.height).toBeLessThanOrEqual(height)
      // The heading gives way to the height, but not below the smallest size of the wide layout.
      const [first, , last] = await headingSizes(page)
      expect(first).toBeGreaterThanOrEqual(52)
      expect(last).toBeGreaterThanOrEqual(30)
      // Under the action the first line of the state of the service is above the fold too: it
      // starts with «Сервис готовится к запуску». The lead above it keeps to three lines for that.
      const status = page
        .locator('section[aria-labelledby="hero-title"] p')
        .filter({ hasText: 'Сервис готовится к запуску' })
      const firstLine = await status.evaluate((paragraph) => {
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        return range.getClientRects()[0]?.bottom ?? Infinity
      })
      expect(firstLine).toBeLessThanOrEqual(height)
    })
  }

  test('does not change the type where the low window begins', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 761 })
    await page.goto('/')
    const tall = await headingSizes(page)
    await page.setViewportSize({ width: 1440, height: 760 })
    expect(await headingSizes(page)).toEqual(tall)
    expect(tall).toEqual([90, 90, 49])
  })
})

test.describe('hero lead', () => {
  // Two columns from 358px: the lead must not end with a line of one word, and above 1100px,
  // where its type is larger, it must not grow a fourth line.
  for (const width of [801, 900, 1024, 1100, 1101, 1440]) {
    test(`ends with more than one word at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await page.evaluate(() => document.fonts.ready)
      const lead = await page.locator('#hero-title + p').evaluate((paragraph) => {
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
      expect(lead.onLastLine).toBeGreaterThan(1)
      // From 900px the column is wide enough for the lead in three lines.
      expect(lead.lines).toBe(width >= 900 ? 3 : 4)
    })
  }
})

test.describe('lead of the steps', () => {
  // Two sentences, the second of which starts with two short words. Left at the end of a line,
  // «Вот» or «Вот как» hangs there apart from what it introduces. The widths are a phone at its
  // narrowest, the phones where the first sentence does not fit a line and where it does, both
  // sides of the two breakpoints, a tablet and a desktop.
  test('keeps the first words of its second sentence on the line of that sentence', async ({
    page,
  }) => {
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)
    for (const width of [320, 360, 375, 390, 412, 430, 540, 541, 768, 800, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const words = await page.locator('#how h2 + div > p').evaluate((paragraph) => {
        const text = paragraph.firstChild
        if (!(text instanceof Text)) throw new Error('The lead is not one run of text')
        const range = document.createRange()
        // What a line can break between: a non-breaking space keeps two words in one piece.
        return [...text.data.matchAll(/[^ ]+/g)].map((match) => {
          range.setStart(text, match.index)
          range.setEnd(text, match.index + match[0].length)
          return { word: match[0], top: Math.round(range.getBoundingClientRect().top) }
        })
      })
      const start = words.findIndex(({ word }) => word === 'Вот')
      const [first, second, third] = words.slice(start)
      if (start < 1 || !first || !second || !third) throw new Error('The lead has no «Вот как …»')
      expect(second.word).toBe('как')
      expect(second.top, `«Вот» ends a line at ${width}px`).toBe(first.top)
      expect(third.top, `«Вот как» ends a line at ${width}px`).toBe(first.top)
    }
  })
})

test.describe('description for search', () => {
  test('names the assistant and the state of the service within 160 characters', async ({
    page,
  }) => {
    await page.goto('/')
    const description = await page.locator('meta[name="description"]').getAttribute('content')
    expect(description).toBe(
      'Радити — ИИ-помощник для сайта малого бизнеса. Сервис готовится к запуску: посмотрите на примере, как менять цены, тексты и акции одним сообщением.',
    )
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
  // The registration button comes at 1100px; below it the four links must still keep one row.
  for (const width of [801, 900, 1024, 1099, 1100, 1440]) {
    test(`keeps one row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const header = page.locator('#top > header')
      const navigation = header.getByRole('navigation', { name: 'Основная навигация' })
      await expect(navigation.getByRole('link')).toHaveText([
        'Как это работает',
        'Возможности',
        'Тарифы',
        'Вопросы',
      ])
      await expect(navigation.getByRole('link', { name: 'Вопросы' })).toHaveAttribute(
        'href',
        '#faq',
      )

      const signUp = header.locator('a[href="/sign-up"]').first()
      if (width >= 1100) {
        await expect(signUp).toBeVisible()
        await expect(signUp).toHaveText('Зарегистрироваться')
        await expect(signUp).toHaveCSS('color', INK)
        expect((await signUp.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      } else {
        await expect(signUp).toBeHidden()
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
      expect(row.lines.length).toBeGreaterThanOrEqual(6)
      expect(new Set(row.lines)).toEqual(new Set([1]))
      for (const gap of row.gaps) expect(gap).toBeGreaterThanOrEqual(16)
      expect(row.overflow).toBeLessThanOrEqual(0.5)
    })
  }
})

test.describe('layout', () => {
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })
  }

  test('keeps dark text on every orange action', async ({ page }) => {
    await page.goto('/')
    const actions = [
      page.locator('#top > header').getByRole('link', { name: 'Зарегистрироваться' }),
      page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]'),
      page.locator('#site-demo').getByRole('button', { name: 'Применить правку' }),
      page.locator('#pricing a[href="/sign-up"]'),
      page.locator('section[aria-labelledby="start-title"] a[href="/sign-up"]'),
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

    test('shows the hover of an orange action, except on the amber field', async ({ page }) => {
      await page.goto('/')
      const hero = page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]')
      const final = page.locator('section[aria-labelledby="start-title"] a[href="/sign-up"]')
      const orange = [
        hero,
        page.locator('#top > header').getByRole('link', { name: 'Зарегистрироваться' }),
        page.locator('#site-demo').getByRole('button', { name: 'Применить правку' }),
        page.locator('#pricing a[href="/sign-up"]'),
      ]
      for (const action of orange) {
        expect(await fillOf(action)).toBe(ACCENT)
        await action.hover()
        const fill = await fillOf(action)
        // Seen as another fill, not as the same orange.
        expect(contrast(fill, ACCENT)).toBeGreaterThanOrEqual(1.2)
        expect(contrast(INK, fill)).toBeGreaterThanOrEqual(4.5)
      }
      // The fill of the hover would dissolve the button in the amber field around it.
      await final.hover()
      expect(await fillOf(final)).toBe(ACCENT)
      await whilePressed(page, final, async () => expect(await fillOf(final)).toBe(ACCENT))
    })

    test('answers a press with the look of the hover and without a move', async ({ page }) => {
      await page.goto('/')
      const demo = page.locator('#site-demo')
      const apply = demo.getByRole('button', { name: 'Применить правку' })
      await hydrated(apply)

      const filled = [
        page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]'),
        page.locator('#top > header').getByRole('link', { name: 'Зарегистрироваться' }),
        page.locator('#pricing a[href="/sign-up"]'),
        apply,
      ]
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

      // Outlined actions that stay on the page: a darker surface and an ink outline.
      const request = demo.getByRole('button', { name: 'График' })
      const undo = page.locator('#safety').getByRole('button', { name: 'Отменить правку' })
      for (const action of [request, undo]) {
        await whilePressed(page, action, async () => {
          expect(await fillOf(action)).toBe(PAPER_2)
          await expect(action).toHaveCSS('border-top-color', INK)
          await expect(action).toHaveCSS('color', INK)
        })
      }
      await undo.hover()
      // The outline of the undo thickens inwards: the border keeps its pixel, the label its place.
      await expect(undo).toHaveCSS('border-top-width', '1px')
      await expect(undo).toHaveCSS('box-shadow', `${INK} 0px 0px 0px 1px inset`)
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

      const demoLink = page.getByRole('link', { name: 'Попробовать демо' })
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
      const hero = page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]')
      const final = page.locator('section[aria-labelledby="start-title"] a[href="/sign-up"]')
      // One role: the final action differs from the first one in size only.
      for (const property of ['font-weight', 'border-top-left-radius', 'border-top-color']) {
        const value = await hero.evaluate(
          (node, name) => getComputedStyle(node).getPropertyValue(name),
          property,
        )
        await expect(final).toHaveCSS(property, value)
      }
      await expect(final).toHaveCSS('font-weight', '500')
      for (const action of [hero, final]) {
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
      await apply.hover()
      await expect(apply.locator('svg')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 4, 0)')
      const pressed = [
        apply,
        demo.getByRole('button', { name: 'График' }),
        page.locator('#top > header a[href="/sign-in"]'),
        page.locator('#pricing a[href="/sign-up"]'),
        page.locator('#safety').getByRole('button', { name: 'Отменить правку' }),
      ]
      for (const action of pressed) {
        await whilePressed(page, action, () => expect(action).toHaveCSS('transform', PRESSED))
      }
      // The chosen request does nothing on a press and does not pretend to.
      const chosen = demo.getByRole('button', { name: 'Цена' })
      await whilePressed(page, chosen, () => expect(chosen).toHaveCSS('transform', 'none'))
    })
  })

  test('keeps the weight and the size of the final action on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const hero = page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]')
    const final = page.locator('section[aria-labelledby="start-title"] a[href="/sign-up"]')
    // The narrow rules of the main button reach the final one too: it keeps its own room.
    await expect(hero).toHaveCSS('font-weight', '500')
    await expect(final).toHaveCSS('font-weight', '500')
    await expect(final).toHaveCSS('min-height', '54px')
    await expect(final).toHaveCSS('padding-left', '26px')
    await expect(final).toHaveCSS('column-gap', '36px')
    await expect(final).toHaveCSS('color', INK)
  })

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('keeps no hover look after a tap', async ({ page }) => {
      await page.goto('/')
      expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false)
      const safety = page.locator('#safety')
      const undo = safety.getByRole('button', { name: 'Отменить правку' })
      await hydrated(undo)
      await undo.tap()
      // The same button with another label: it must not stay in the look of a hover.
      const again = safety.getByRole('button', { name: 'Применить снова' })
      await expect(again).toBeVisible()
      await expect(again).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(again).toHaveCSS('box-shadow', 'none')

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
      // A decoration, or words for a screen reader that are clipped away on purpose.
      if (parent.closest('[aria-hidden="true"]')) continue
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
  for (const width of [320, 640, 768]) {
    test(`keeps every line of text inside the window at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await expect(page.getByRole('slider')).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      expect(await textOutsideTheWindow(page)).toEqual([])

      await page.addStyleTag({ content: TEXT_SPACING })
      expect(await textOutsideTheWindow(page)).toEqual([])
    })
  }
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
  for (const width of [320, 390, 480, 481, 540, 768, 1024, 1440]) {
    test(`keeps every text at ${TYPE_FLOOR}px or more at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await expect(page.getByRole('slider')).toBeVisible()
      expect(await textBelowTheFloor(page, width)).toEqual([])

      // The states bring their own texts: the changed banner, the labels of the window, the
      // status of the card of the saved copy.
      const demo = page.locator('#site-demo')
      await demo.getByRole('button', { name: 'Акция' }).click()
      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
      await page.locator('#safety').getByRole('button', { name: 'Отменить правку' }).click()
      await page.locator('#faq summary').first().click()
      expect(await textBelowTheFloor(page, width)).toEqual([])
    })
  }
})

test.describe('section headings', () => {
  // 5vw between 32 and 40px in one column; the final block is a step larger; 28px on a phone,
  // where the answer of the dark band alone follows the width.
  const expected = (width: number) => {
    const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value))
    if (width <= 540) {
      return {
        sections: 28,
        answer: clamp(23, width * 0.064, 28),
        final: clamp(28, width * 0.072, 38),
      }
    }
    const sections = clamp(32, width * 0.05, 40)
    return { sections, answer: sections, final: clamp(32, width * 0.056, 44) }
  }

  for (const width of [390, 540, 541, 640, 768, 800]) {
    test(`are of one size in a single column at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const sizes = await page.evaluate(() => {
        const size = (selector: string) => {
          const heading = document.querySelector(selector)
          if (!heading) throw new Error(`No heading ${selector}`)
          return parseFloat(getComputedStyle(heading).fontSize)
        }
        return {
          sections: [
            '#how-title',
            '#can-title',
            '#safety-title',
            '#pricing-title',
            '#faq-title',
          ].map(size),
          answer: size('section[aria-label="Поддержка сайта одним сообщением"] h2'),
          final: size('#start-title'),
        }
      })
      const { sections, answer, final } = expected(width)
      for (const size of sizes.sections) expect(size).toBeCloseTo(sections, 1)
      expect(sizes.answer).toBeCloseTo(answer, 1)
      expect(sizes.final).toBeCloseTo(final, 1)
    })
  }

  test('keeps each half of the first heading on its line at 541px', async ({ page }) => {
    await page.setViewportSize({ width: 541, height: 900 })
    await page.goto('/')
    const lines = await page.locator('#how-title').evaluate((heading) => {
      const range = document.createRange()
      range.selectNodeContents(heading)
      const tops = [...range.getClientRects()].map((box) => Math.round(box.top))
      return { count: new Set(tops).size, right: range.getBoundingClientRect().right }
    })
    // «От «надо поправить»» and «до «уже готово».»: the break of the markup and no other.
    expect(lines.count).toBe(2)
    expect(lines.right).toBeLessThanOrEqual(541 - 24)
  })
})

test.describe('highlights of the headings', () => {
  const TRANSPARENT = 'rgba(0, 0, 0, 0)'

  test('are one to a heading: an amber plate on a light field, an amber text on the dark one', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await settled(page)
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('#top h1, #top h2')].map((heading) => {
        const marks = [...heading.querySelectorAll('em')].map((mark) => {
          const style = getComputedStyle(mark)
          const plate = getComputedStyle(mark, '::before')
          return {
            color: style.color,
            background: style.backgroundColor,
            // The plate of the first heading is drawn by a pseudo-element, which is turned.
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
    expect(headings).toHaveLength(8)
    for (const heading of headings) {
      expect(heading.marks.length, heading.text).toBeLessThanOrEqual(1)
      expect(heading.coloured, heading.text).toBe(0)
    }
    const mark = (id: string) => headings.find((heading) => heading.id === id)?.marks[0]
    // The turned plate belongs to the first heading alone.
    expect(mark('hero-title')).toEqual({
      color: INK,
      background: TRANSPARENT,
      plate: MARKER,
      turned: true,
    })
    // On the paper and on the orange field: ink on a level amber plate.
    for (const id of ['can-title', 'safety-title']) {
      expect(mark(id), id).toEqual({ color: INK, background: MARKER, plate: null, turned: false })
    }
    // On the chocolate field: an amber text.
    const dark = headings.find((heading) => heading.text.includes('просто написать'))?.marks[0]
    expect(dark).toEqual({ color: MARKER, background: TRANSPARENT, plate: null, turned: false })
    // The name in the last heading is not coloured any more.
    expect(headings.find((heading) => heading.id === 'start-title')?.marks).toEqual([])
  })

  for (const width of [390, 1440]) {
    test(`keeps a plate in one piece at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      for (const id of ['can-title', 'safety-title']) {
        const pieces = await page
          .locator(`#${id} em`)
          .evaluate((mark) => mark.getClientRects().length)
        expect(pieces, id).toBe(1)
      }
    })
  }
})

test.describe('dark strip', () => {
  const STRIP = 'section[aria-label="Поддержка сайта одним сообщением"]'
  const DRAWN = ['none', 'matrix(1, 0, 0, 1, 0, 0)']

  /** The chores of the strip: the lines of their text and their strikes. */
  const chores = (page: Page) =>
    page.locator(`${STRIP} p > span`).evaluateAll((lines) =>
      lines.map((line) => {
        const text = document.createRange()
        text.selectNodeContents(line)
        const strike = getComputedStyle(line, '::after')
        return {
          text: line.textContent,
          lines: text.getClientRects().length,
          right: line.getBoundingClientRect().right,
          strike: {
            line: `${strike.borderTopWidth} ${strike.borderTopStyle} ${strike.borderTopColor}`,
            transform: strike.transform,
            // A CSS module adds a hash to the name written in the source.
            animation: strike.animationName.split('__').pop()?.replace(/_.*$/, '') ?? '',
            duration: strike.animationDuration,
            delay: strike.animationDelay,
            fill: strike.animationFillMode,
          },
        }
      }),
    )

  test.describe('at rest', () => {
    // Under reduced motion the strip is what CSS draws: no scene is prepared.
    test.use({ reducedMotion: 'reduce' })

    for (const width of [320, 390, 1440]) {
      test(`crosses out four chores, each in one line, at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto('/')
        const lines = await chores(page)
        expect(lines.map((line) => line.text)).toEqual([
          'Надо найти разработчика.',
          'Объяснить.',
          'Напомнить.',
          'Подождать.',
        ])
        await expect(page.locator(`${STRIP} p`).first()).not.toHaveAttribute('data-scene')
        for (const line of lines) {
          expect(line.lines, line.text ?? '').toBe(1)
          expect(line.right, line.text ?? '').toBeLessThanOrEqual(width - 20)
          expect(line.strike.line).toBe(`2px solid ${MARKER}`)
          expect(DRAWN).toContain(line.strike.transform)
          expect(line.strike.animation).toBe('none')
        }
      })
    }

    // The answer is the main thought of the page: not smaller than a heading of a section.
    for (const [width, size] of [
      [801, null],
      [1101, null],
      [1440, null],
      [1920, 56],
    ] as const) {
      test(`sets the answer not smaller than a section heading, in two lines, at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto('/')
        const read = await page.evaluate((strip) => {
          const answer = document.querySelector(`${strip} h2`)
          const mark = answer?.querySelector('em')
          const heading = document.querySelector('#how-title')
          if (!answer || !mark || !heading) throw new Error('No answer or no heading')
          return {
            answer: parseFloat(getComputedStyle(answer).fontSize),
            heading: parseFloat(getComputedStyle(heading).fontSize),
            pieces: mark.getClientRects().length,
          }
        }, STRIP)
        expect(read.answer).toBeGreaterThanOrEqual(read.heading)
        expect(read.answer).toBeLessThanOrEqual(56)
        if (size) expect(read.answer).toBe(size)
        // «просто написать.» stays one line beside the chores.
        expect(read.pieces).toBe(1)
      })
    }
  })

  test('draws the strikes one after another, once, when the strip comes into the window', async ({
    page,
  }) => {
    // A window that ends above the strip.
    await page.setViewportSize({ width: 1440, height: 700 })
    await page.goto('/')
    const list = page.locator(`${STRIP} p`).first()
    await expect(list).toHaveAttribute('data-scene', 'waiting')
    // Below the window the first frame is held: no strike yet, the words in full contrast.
    for (const line of await chores(page)) {
      expect(line.strike.transform, line.text ?? '').toBe('matrix(0, 0, 0, 1, 0, 0)')
    }
    await expect(list).toHaveCSS('opacity', '1')

    await list.scrollIntoViewIfNeeded()
    await expect(list).toHaveAttribute('data-scene', 'playing')
    const beats = await chores(page)
    // 360ms a line, a step of 240ms, held at the first frame until its beat.
    expect(beats.map((line) => line.strike.animation)).toEqual(Array(4).fill('strikeDraw'))
    expect(beats.map((line) => line.strike.duration)).toEqual(Array(4).fill('0.36s'))
    expect(beats.map((line) => line.strike.delay)).toEqual(['0s', '0.24s', '0.48s', '0.72s'])
    expect(beats.map((line) => line.strike.fill)).toEqual(Array(4).fill('backwards'))

    await settled(page)
    for (const line of await chores(page)) expect(DRAWN).toContain(line.strike.transform)
    // Once: the way back and forth starts nothing.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await list.scrollIntoViewIfNeeded()
    expect(await list.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
    for (const line of await chores(page)) expect(DRAWN).toContain(line.strike.transform)
  })

  test.describe('without scripts', () => {
    test.use({ javaScriptEnabled: false })

    test('is crossed out from the start', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 700 })
      await page.goto('/')
      await expect(page.locator(`${STRIP} p`).first()).not.toHaveAttribute('data-scene')
      const lines = await chores(page)
      expect(lines).toHaveLength(4)
      for (const line of lines) {
        expect(DRAWN).toContain(line.strike.transform)
        expect(line.strike.animation).toBe('none')
      }
    })
  })
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

  test('are six rows of a request and its result, under the caveat about the launch', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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
    // The caveat stands in the section, before the table.
    const caveat = section.getByText(/Эти задачи Радити будет выполнять после запуска\./)
    await expect(caveat).toBeVisible()
    const caveatBottom = await caveat.evaluate((node) => node.getBoundingClientRect().bottom)
    expect(caveatBottom).toBeLessThanOrEqual(table[0]?.row.top ?? 0)
  })

  for (const width of [390, 541, 768, 800, 1440]) {
    test(`shows the heads of the columns once, over the cells of the first row, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const [first, ...others] = await rows(page)
      if (!first) throw new Error('The table has no rows')
      const [requestHead, resultHead] = first.heads
      if (!requestHead || !resultHead) throw new Error('The first row has no heads')
      for (const [head, cell] of [
        [requestHead, first.request],
        [resultHead, first.result],
      ] as const) {
        expect(head.width).toBeGreaterThan(100)
        expect(head.left).toBeCloseTo(cell.left, 0)
        expect(head.bottom).toBeLessThanOrEqual(cell.top)
      }
      // A head names the cell right under it: «Например, вы пишете» over a category would read
      // as the head of the categories. In one or two columns the category is the first line of
      // a row, and the head of the requests stands between it and the request.
      if (width <= 800) {
        expect(first.heading.bottom).toBeLessThanOrEqual(requestHead.top)
        expect(first.request.top - requestHead.bottom).toBeLessThanOrEqual(8)
      }
      for (const row of others) {
        for (const head of row.heads) {
          expect(head.width).toBeLessThanOrEqual(1)
          expect(head.height).toBeLessThanOrEqual(1)
        }
      }
    })
  }

  // Between the phone and the desktop a row is two columns under its category. The heads of
  // the columns are seen in the first row only, and the other rows keep no place for them.
  for (const width of [541, 640, 768, 800]) {
    test(`sets a row in two columns, as far from the line above as from the line below, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const table = await rows(page)
      expect(table).toHaveLength(6)
      for (const row of table) {
        expect(row.heading.bottom, row.request.text ?? '').toBeLessThanOrEqual(row.request.top)
        expect(row.request.right, row.request.text ?? '').toBeLessThanOrEqual(row.result.left)
        const above = row.heading.top - row.row.top
        // The line under a row is its border of 1px.
        const below = row.row.bottom - 1 - Math.max(row.request.bottom, row.result.bottom)
        expect(Math.abs(above - below), row.request.text ?? '').toBeLessThanOrEqual(1)
      }
    })
  }

  test('sets a row in three columns on a desktop and in one on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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
  for (const width of [320, 390, 541, 768, 1024, 1101, 1440, 1920]) {
    test(`ends with the whole sign of the brand at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const word = page.locator('#top > footer > div[aria-hidden="true"]').last()
      await expect(word).toHaveText('радити')
      const sign = word.locator('svg')
      await expect(sign.locator('circle')).toHaveCount(1)
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
      expect(boxes.sign.width).toBe(Math.round(boxes.sign.width))
      expect(boxes.sign.height).toBe(boxes.sign.width)
      // As tall as the lowercase letters: 0.55 of the size of the word, to the nearest pixel.
      expect(Math.abs(boxes.sign.width - 0.55 * boxes.fontSize)).toBeLessThanOrEqual(0.5)
      expect(boxes.sign.right).toBeLessThanOrEqual(boxes.row.right + 0.5)
      // The circle of the sign ends on the axis: it has no side bearing to hang over it.
      expect(Math.abs(boxes.sign.right - boxes.axis)).toBeLessThanOrEqual(0.5)
      expect(boxes.sign.left).toBeGreaterThan(boxes.textRight)
      expect(boxes.sign.top).toBeGreaterThanOrEqual(boxes.row.top)
    })
  }
})

test.describe('how it works', () => {
  const FRAMES = [
    'Пример: сайт кофейни, Капучино, 250 мл — 250 ₽',
    'Пример сообщения в чате: Поменяй цену капучино на 290 ₽',
    'Пример: Капучино, 250 мл — было 250 ₽, стало 290 ₽',
  ]
  /** The name of an animation as the source writes it: a CSS module adds a hash to it. */
  const plainName = (name: string) => name.split('__').pop()?.replace(/_.*$/, '') ?? ''

  /** What the scene of the frames moves: the message, the new value and its plate. */
  const scene = (page: Page) =>
    page.locator('#how').evaluate((section) => {
      const [, message, difference] = section.querySelectorAll('[role="img"]')
      const bubble = message?.querySelector('span:last-child')
      const value = difference?.querySelector('strong')
      if (!message || !difference || !bubble || !value) throw new Error('A frame lacks a part')
      const motion = (style: CSSStyleDeclaration) => ({
        transform: style.transform,
        clip: style.clipPath,
        opacity: style.opacity,
        animation: style.animationName,
        duration: style.animationDuration,
        delay: style.animationDelay,
        fill: style.animationFillMode,
      })
      return {
        marks: [message, difference].map((frame) => frame.getAttribute('data-scene')),
        message: motion(getComputedStyle(bubble)),
        value: motion(getComputedStyle(value)),
        plate: motion(getComputedStyle(value, '::before')),
      }
    })

  test('tells one change in three frames marked as examples, with nothing to press', async ({
    page,
  }) => {
    await page.goto('/')
    const how = page.locator('#how')
    const frames = how.getByRole('img')
    await expect(frames).toHaveCount(3)
    for (const [index, name] of FRAMES.entries()) {
      await expect(frames.nth(index)).toHaveAccessibleName(name)
    }
    await expect(how.getByText('Пример', { exact: true })).toHaveCount(3)
    await expect(how.getByText('После запуска')).toBeVisible()
    // The steps describe the service after its launch: the lead keeps the future tense.
    await expect(how.getByText(/Вот как будет устроена работа с.Радити\./)).toBeVisible()

    // A frame is a picture: nothing to press, no status of success, no promise of one click.
    await expect(how.getByRole('button')).toHaveCount(0)
    await expect(how.getByRole('link')).toHaveCount(0)
    const text = (await how.innerText()).replaceAll('\u00a0', ' ')
    for (const gone of ['Готово', 'Правка готова', 'Применить', 'Применено', 'один клик']) {
      expect(text).not.toContain(gone)
    }

    // The difference is told in words and in form: the old value crossed out with an ink line,
    // the new one ink on an amber plate.
    const difference = frames.nth(2)
    await expect(difference.getByText('Было', { exact: true })).toBeVisible()
    await expect(difference.getByText('Стало', { exact: true })).toBeVisible()
    const old = difference.locator('s')
    await expect(old).toHaveText(/250.₽/)
    await expect(old).toHaveCSS('text-decoration-line', 'line-through')
    await expect(old).toHaveCSS('text-decoration-color', INK)
    const fresh = difference.locator('strong')
    await expect(fresh).toHaveText(/290.₽/)
    await expect(fresh).toHaveCSS('color', INK)
    expect(await fresh.evaluate((node) => getComputedStyle(node, '::before').backgroundColor)).toBe(
      MARKER,
    )
    // The message has the dark bubble of the chat.
    const bubble = frames.nth(1).locator('span').last()
    await expect(bubble).toHaveText(/Поменяй цену капучино на.290.₽/)
    await expect(bubble).toHaveCSS('color', PAPER)
    expect(
      contrast(PAPER, await bubble.evaluate((node) => getComputedStyle(node).backgroundColor)),
    ).toBeGreaterThanOrEqual(7)
  })

  for (const width of [390, 768, 1440]) {
    test(`keeps the frames flat, of one height and readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const frames = await page.locator('#how [role="img"] > div').evaluateAll((cards) =>
        cards.map((card) => {
          const style = getComputedStyle(card)
          const box = card.getBoundingClientRect()
          const sizes: number[] = []
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent?.trim() && node.parentElement) {
              sizes.push(parseFloat(getComputedStyle(node.parentElement).fontSize))
            }
          }
          return {
            transform: style.transform,
            shadow: style.boxShadow,
            top: box.top,
            height: box.height,
            right: box.right,
            smallest: Math.min(...sizes),
          }
        }),
      )
      expect(frames).toHaveLength(3)
      for (const frame of frames) {
        expect(frame.transform).toBe('none')
        expect(frame.shadow).toBe('none')
        expect(frame.smallest).toBeGreaterThanOrEqual(12)
        expect(frame.right).toBeLessThanOrEqual(width)
        expect(frame.height).toBeCloseTo(frames[0]?.height ?? 0, 0)
      }
      // In a row the three frames stand on one line.
      if (width > 800) {
        expect(new Set(frames.map((frame) => Math.round(frame.top))).size).toBe(1)
      }
    })
  }

  for (const [width, delays] of [
    [1440, { value: '0.24s', plate: '0.48s' }],
    [390, { value: '0s', plate: '0.24s' }],
  ] as const) {
    test(`plays the frames once on the way into the window: the message, the difference, its plate, at ${width}px`, async ({
      page,
    }) => {
      // A window that ends above the frames.
      await page.setViewportSize({ width, height: 700 })
      await page.goto('/')
      await expect(page.locator('#how [data-scene]')).toHaveCount(2)
      const waiting = await scene(page)
      expect(waiting.marks).toEqual(['waiting', 'waiting'])
      // Held at the first frame, a step below the place, and never dimmed.
      expect(waiting.message.transform).toBe('matrix(1, 0, 0, 1, 0, 6)')
      expect(waiting.value.transform).toBe('matrix(1, 0, 0, 1, 0, 6)')
      expect(waiting.plate.clip).toBe('inset(0px 100% 0px 0px)')
      expect([waiting.message.opacity, waiting.value.opacity]).toEqual(['1', '1'])

      const frames = page.locator('#how [role="img"]')
      await frames.nth(1).scrollIntoViewIfNeeded()
      await expect(frames.nth(1)).toHaveAttribute('data-scene', 'playing')
      await frames.nth(2).scrollIntoViewIfNeeded()
      await expect(frames.nth(2)).toHaveAttribute('data-scene', 'playing')
      const playing = await scene(page)
      // The times of the scale; in a row the difference waits a beat for the message.
      expect({ ...playing.message, animation: plainName(playing.message.animation) }).toMatchObject(
        { animation: 'valueRise', duration: '0.36s', delay: '0s', fill: 'backwards' },
      )
      expect({ ...playing.value, animation: plainName(playing.value.animation) }).toMatchObject({
        animation: 'valueRise',
        duration: '0.36s',
        delay: delays.value,
        fill: 'backwards',
      })
      expect({ ...playing.plate, animation: plainName(playing.plate.animation) }).toMatchObject({
        animation: 'markerEntrance',
        duration: '0.56s',
        delay: delays.plate,
        fill: 'backwards',
      })

      await settled(page)
      const played = await scene(page)
      expect(played.message.transform).toBe('none')
      expect(played.value.transform).toBe('none')
      expect(played.plate.clip).toBe('none')
    })
  }

  test.describe('under reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('shows the frames complete and prepares no scene', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 700 })
      await page.goto('/')
      await expect(page.getByRole('slider')).toBeVisible()
      const still = await scene(page)
      expect(still.marks).toEqual([null, null])
      for (const part of [still.message, still.value, still.plate]) {
        expect(part.transform).toBe('none')
        expect(part.animation).toBe('none')
      }
      expect(still.plate.clip).toBe('none')
    })
  })

  test.describe('without scripts', () => {
    test.use({ javaScriptEnabled: false })

    test('shows the frames complete', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 700 })
      await page.goto('/')
      const still = await scene(page)
      expect(still.marks).toEqual([null, null])
      expect(still.message.transform).toBe('none')
      expect(still.value.transform).toBe('none')
      expect(still.plate.clip).toBe('none')
      await expect(page.locator('#how').getByRole('img')).toHaveCount(3)
    })
  })
})

test.describe('demo', () => {
  for (const width of [320, 390, 801, 1440]) {
    test(`keeps the three requests in one row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const choice = page.getByRole('group', { name: 'Выберите, что попросить:' })
      await expect(choice.getByRole('button')).toHaveCount(3)
      // The place in the layout, not the painted box: the entrance of the demo turns it a little.
      const tops = await choice
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).offsetTop))
      expect(new Set(tops).size).toBe(1)
      // The author of the message is named in the chat, not smaller than a caption.
      const author = page.locator('#site-demo').getByText('Вы', { exact: true })
      await expect(author).toBeVisible()
      expect(
        await author.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(12)
    })
  }

  // The banner request has the longest new value: on the narrowest phone it does not fit the
  // line of the old one, and the arrow must go to the next line with it.
  test('keeps the arrow of a change on one line with the new value at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto('/')
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
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
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
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
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

      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
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
      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
      const row = await marked()
      expect(row).toEqual({ background: MARKER, color: INK })

      await demo.getByRole('button', { name: 'Акция' }).click()
      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
      expect(await marked()).toEqual(row)
    })
  })

  // The banner comes in from the left under a clip, which stays after the entrance: the outline
  // of the changed field stands outside its box and must be inside the clip.
  test('does not cut the outline of the changed banner', async ({ page }) => {
    await page.goto('/')
    const demo = page.locator('#site-demo')
    await demo.getByRole('button', { name: 'Акция' }).click()
    await demo.getByRole('button', { name: 'Применить правку' }).click()
    await expect(demo.getByText('Изменено')).toBeVisible()
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const slider = page.getByRole('slider')
    await slider.scrollIntoViewIfNeeded()
    const middle = (rows: number[]) => ((rows[0] ?? NaN) + (rows.at(-1) ?? NaN) + 1) / 2
    // The line beyond the thumb: 30 edits of 10 to 300 leave the thumb near the left end.
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const toggle = page.getByRole('button', { name: 'Открыть меню' })
    expect(contrast(await outline(toggle), PAPER)).toBeGreaterThanOrEqual(3)
  })
})

test.describe('safety', () => {
  for (const width of [390, 1440]) {
    test(`keeps the text on the orange field dark, and medium when small, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const texts = await page.locator('#safety').evaluate((section) => {
        const field = getComputedStyle(section).backgroundColor
        const found: { text: string; color: string; size: number; weight: number }[] = []
        const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement
          const text = node.textContent?.trim()
          if (!parent || !text || parent.getClientRects().length === 0) continue
          // The surface right under the text: the card and the highlight have their own.
          let surface = 'rgba(0, 0, 0, 0)'
          for (let element: Element | null = parent; element; element = element.parentElement) {
            surface = getComputedStyle(element).backgroundColor
            if (surface !== 'rgba(0, 0, 0, 0)') break
          }
          if (surface !== field) continue
          const style = getComputedStyle(parent)
          found.push({
            text,
            color: style.color,
            size: parseFloat(style.fontSize),
            weight: Number(style.fontWeight),
          })
        }
        return found
      })

      // The lead, three points of two lines each, the caption of the card and the note.
      expect(texts.length).toBeGreaterThanOrEqual(9)
      expect(texts.filter(({ color }) => color !== INK)).toEqual([])
      expect(texts.filter(({ size }) => size < 14)).toEqual([])
      expect(texts.filter(({ size, weight }) => size < 16 && weight < 500)).toEqual([])
    })
  }

  test('marks the price of the card while the change is in force', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    const safety = page.locator('#safety')
    const price = safety.locator('strong').filter({ hasText: '₽' })
    const undo = safety.getByRole('button', { name: 'Отменить правку' })
    await hydrated(undo)
    // The changed value, as in the demo: ink on an amber band, the ruble sign with it.
    await expect(price).toHaveText('290₽')
    await expect(price).toHaveCSS('color', INK)
    await expect(price.locator('small')).toHaveCSS('color', INK)
    expect(await price.evaluate((node) => getComputedStyle(node).backgroundImage)).toContain(MARKER)
    await expect(safety.getByRole('status')).toHaveText(/^Новая цена/)

    await undo.click()
    // The saved price again: no mark.
    await expect(price).toHaveText('250₽')
    await expect(price).toHaveCSS('color', ACCENT_TEXT)
    await expect(price).toHaveCSS('background-image', 'none')
    await expect(safety.getByRole('status')).toHaveText('Прежняя цена возвращена')
  })

  test('keeps the price of the card as wide when the change is undone', async ({ page }) => {
    await page.goto('/')
    const card = page.locator('#safety')
    // The width of the layout, not of the painted box: the card is turned.
    const price = () =>
      card.locator('strong').evaluate((element) => ({
        text: element.textContent,
        width: parseFloat(getComputedStyle(element).width),
      }))
    const changed = await price()
    await card.getByRole('button', { name: 'Отменить правку' }).click()
    await expect(card.getByText('Прежняя цена возвращена')).toBeVisible()
    const returned = await price()
    expect([changed.text, returned.text]).toEqual(['290₽', '250₽'])
    expect(returned.width).toBeCloseTo(changed.width, 1)
  })

  // The note invites to press «Отменить правку». After the press the button reads «Применить
  // снова»: the invitation goes, the first sentence stays in the same place, and the sign of
  // the button turns onward.
  for (const width of [390, 1440]) {
    test(`takes the invitation to undo back after the undo and moves nothing, at ${width}px`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const safety = page.locator('#safety')
      const note = safety.locator('p').filter({ hasText: 'Так будет устроена защита сайта.' })
      const [inviting, plain] = [note.locator('span').first(), note.locator('span').last()]
      const button = safety.getByRole('button')
      /** The note and the first line of the version of it that is shown, within the block. */
      const places = () =>
        safety.evaluate((section) => {
          const paragraph = [...section.querySelectorAll('p')].find((p) =>
            p.textContent.startsWith('Так будет устроена'),
          )
          const shown = [...(paragraph?.children ?? [])].find(
            (version) => getComputedStyle(version).visibility === 'visible',
          )
          if (!paragraph || !shown) throw new Error('The safety block has no note')
          const text = document.createRange()
          text.selectNodeContents(shown)
          const [line] = text.getClientRects()
          if (!line) throw new Error('The note has no text')
          const [block, box] = [section.getBoundingClientRect(), paragraph.getBoundingClientRect()]
          return {
            section: block.height,
            note: { left: box.left - block.left, top: box.top - block.top, height: box.height },
            line: { top: line.top - box.top, middle: (line.left + line.right) / 2 - block.left },
            width: block.width,
          }
        })
      const sign = () =>
        button
          .locator('svg path')
          .evaluateAll((paths) => paths.map((path) => path.getAttribute('d')))
      await hydrated(button)
      await button.scrollIntoViewIfNeeded()

      await expect(button).toHaveText('Отменить правку')
      await expect(inviting).toHaveText(
        'Так будет устроена защита сайта. Попробуйте: нажмите «Отменить правку» на карточке.',
      )
      await expect(inviting).toBeVisible()
      await expect(plain).toBeHidden()
      const before = await places()
      const turnBack = await sign()

      await button.click()
      await expect(button).toHaveText('Применить снова')
      await expect(inviting).toBeHidden()
      await expect(plain).toBeVisible()
      await expect(plain).toHaveText('Так будет устроена защита сайта.')
      // The sentence that stays starts on the same line, and the block is as tall as it was.
      const after = await places()
      expect(after.section).toBe(before.section)
      expect(after.note).toEqual(before.note)
      expect(after.line.top).toBeCloseTo(before.line.top, 0)
      // In one column the note is centred, and so is what is left of it.
      if (width <= 800) expect(Math.abs(after.line.middle - after.width / 2)).toBeLessThanOrEqual(1)
      // An arrow onward, as on the same action of the demo, and not the turn back of the undo.
      expect(await sign()).toEqual(['M4 12h15m-6-6 6 6-6 6'])
      expect(await sign()).not.toEqual(turnBack)

      await button.click()
      await expect(button).toHaveText('Отменить правку')
      await expect(inviting).toBeVisible()
      await expect(plain).toBeHidden()
      expect(await sign()).toEqual(turnBack)
      expect((await places()).note).toEqual(before.note)
    })
  }

  test('keeps the note under the list on a desktop and under the card on a phone', async ({
    page,
  }) => {
    const places = () =>
      page.locator('#safety').evaluate((section) => {
        const box = (selector: string) => {
          const element = section.querySelector(selector)
          if (!element) throw new Error(`The safety block has no ${selector}`)
          return element.getBoundingClientRect()
        }
        const paragraphs = [...section.querySelectorAll('p')]
        const note = paragraphs.find((p) => p.textContent.startsWith('Так будет устроена'))
        const caption = [...section.querySelectorAll('span')].find((span) =>
          span.textContent.startsWith('Можно передумать'),
        )
        if (!note || !caption) throw new Error('The safety block has no note or no caption')
        const [list, button] = [box('ul'), box('button')]
        const [noteBox, captionBox] = [
          note.getBoundingClientRect(),
          caption.getBoundingClientRect(),
        ]
        return {
          note: { left: noteBox.left, top: noteBox.top, right: noteBox.right },
          caption: { top: captionBox.top, bottom: captionBox.bottom },
          list: { left: list.left, bottom: list.bottom },
          button: { left: button.left, bottom: button.bottom },
        }
      })

    // The copy of the block rises into the window: its place is measured when it has arrived.
    const arrived = async () => {
      await page
        .locator('#safety')
        .evaluate((section) => section.scrollIntoView({ behavior: 'instant' }))
      await settled(page)
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await arrived()
    const desktop = await places()
    expect(desktop.note.left).toBe(desktop.list.left)
    expect(desktop.note.top - desktop.list.bottom).toBe(20)
    // The card is in the other column.
    expect(desktop.note.right).toBeLessThan(desktop.button.left)

    await page.setViewportSize({ width: 390, height: 844 })
    const phone = await places()
    expect(phone.caption.top).toBeGreaterThan(phone.button.bottom)
    // One block under the card: the caption, then the note right after it.
    expect(phone.note.top - phone.caption.bottom).toBeGreaterThanOrEqual(0)
    expect(phone.note.top - phone.caption.bottom).toBeLessThanOrEqual(8)
  })
})

test.describe('pricing', () => {
  test('offers one registration under the plans and marks the plan without a button', async ({
    page,
  }) => {
    await page.goto('/')
    const pricing = page.locator('#pricing')
    const plans = pricing.locator('article')
    await expect(plans).toHaveCount(3)
    await expect(plans.getByRole('link')).toHaveCount(0)
    await expect(pricing.getByRole('link')).toHaveCount(1)
    await expect(pricing.getByRole('link', { name: 'Зарегистрироваться' })).toHaveAttribute(
      'href',
      '/sign-up',
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
  for (const width of [700, 768, 900]) {
    test(`keeps the prices of the plans on one line at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const plans = page.locator('#pricing article')
      await expect(plans).toHaveCount(3)
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
      if (width <= 768) expect(new Set(rows.map((row) => row.lines)).size).toBeGreaterThan(1)
      expect(new Set(rows.map((row) => row.price)).size).toBe(1)
      expect(new Set(rows.map((row) => row.list)).size).toBe(1)
    })
  }

  // A price is set as the expressive numbers of the page: in the face of the headings, with
  // digits of one width, the ruble sign small beside it. «39 900 ₽» is the widest of the three.
  for (const width of [320, 768, 1440]) {
    test(`sets the prices in the face of the headings, whole inside their columns, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const pricing = page.locator('#pricing')
      await expect(pricing.locator('article')).toHaveCount(3)
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
      expect(read.plans.map((plan) => plan.text?.replaceAll('\u00a0', ' '))).toContain('39 900 ₽')
      for (const price of [read.total, ...read.plans]) {
        expect(price.family, price.text ?? '').toBe(read.heading)
        expect(price.weight).toBe('500')
        expect(price.numeric).toBe('tabular-nums')
        expect(price.signFamily).toBe(read.body)
        expect(price.signSize).toBeLessThan(price.size / 2)
        expect(price.lines, price.text ?? '').toBe(1)
        expect(price.signBeside, price.text ?? '').toBe(true)
        expect(price.right, price.text ?? '').toBeLessThanOrEqual(price.columnRight + 0.5)
      }
      // The sum of the calculator stays its main number: the count of edits is a step smaller.
      expect(read.count).toBeLessThan(read.total.size)
    })
  }

  // The rows under the plans repeat the inset of a plan: what they say starts on the vertical
  // where the text of a plan starts. In one column they go back to the edge of the page text.
  for (const width of [390, 768, 1024, 1440]) {
    test(`starts the rows under the plans where the text of a plan starts at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const pricing = page.locator('#pricing')
      await expect(pricing.locator('article')).toHaveCount(3)
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
        const action = section.querySelector('a[href="/sign-up"]')?.getBoundingClientRect()
        const lastRule = section.querySelector('article:last-of-type ul')?.getBoundingClientRect()
        if (!action || !lastRule) throw new Error('The pricing has no action or no plan')
        return {
          heading: text(section.querySelector('h2')).left,
          plans: [...section.querySelectorAll('article h3')].map((name) => text(name).left),
          included: text(paragraph('В каждый тариф')).left,
          packs: text(paragraph('Правок не хватит')).left,
          vat: text(paragraph('Цены в')).left,
          action: { left: action.left, right: action.right },
          lastPlanRight: lastRule.right,
        }
      })
      const [first = NaN, second = NaN, third = NaN] = edges.plans
      if (width <= 680) {
        for (const left of [edges.included, edges.packs, edges.vat, edges.action.left]) {
          expect(left).toBeCloseTo(edges.heading, 1)
        }
        return
      }
      expect(edges.included).toBeCloseTo(first, 1)
      expect(edges.packs).toBeCloseTo(first, 1)
      expect(edges.vat).toBeCloseTo(second, 1)
      // The action ends where the text of the third plan ends, and starts with it where the
      // column is wide enough for the label.
      expect(edges.action.right).toBeCloseTo(edges.lastPlanRight, 1)
      if (width >= 1024) expect(edges.action.left).toBeCloseTo(third, 1)
      else expect(edges.action.right - edges.action.left).toBeCloseTo(240, 1)
    })
  }

  // The longest result line: a plan, its packs in words and the sum below.
  for (const width of [320, 390]) {
    test(`keeps the result in words inside its column at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const slider = page.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
      await hydrated(slider)
      await slider.fill('120')
      // The sentence of the result; the name of the plan is an element of its own inside it.
      const result = page.locator('#pricing p').filter({ hasText: /^Тариф «Бизнес»/ })
      await expect(result).toContainText('и 4 дополнительных пакета по 10 правок')
      await expect(page.locator('#pricing').getByText(/12.900.₽ \+ 4 × 1.990.₽/)).toBeVisible()
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
    const slider = page.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
    await expect(slider).toHaveAttribute('aria-valuetext', '30 правок в месяц')
    await slider.focus()
    await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveAttribute('aria-valuetext', '35 правок в месяц')
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
    await expect(announcement).toHaveText(
      /^Тариф «Старт» и 2 дополнительных пакета по 10 правок, 8.880 ₽ в месяц, около 197 ₽ за правку$/,
    )
    // Heard, not seen: the region takes no room on the page.
    const box = await announcement.boundingBox()
    expect(box?.width).toBeLessThanOrEqual(1)
    expect(box?.height).toBeLessThanOrEqual(1)
  })
})

test.describe('navigation and questions', () => {
  test('opens the mobile menu and closes it on Escape', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const toggle = page.locator('#top > header button[aria-controls]')
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
    const section = page.locator('#how')
    await page.setViewportSize({ width: 320, height: 844 })
    await page.goto('/')
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

  for (const width of [320, 390, 1440]) {
    test(`sets the questions a step above their answers at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const first = page.locator('#faq details').first()
      await first.locator('summary').click()
      await expect(first.locator('p')).toBeVisible()

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

      expect(questions.length).toBeGreaterThanOrEqual(6)
      for (const question of questions) {
        expect(question.size).toBe(width <= 540 ? 17 : 18)
        expect(question.weight).toBe(500)
        expect(question.leading).toBeCloseTo(1.35, 2)
        expect(question.height).toBeGreaterThanOrEqual(44)
        expect(question.lines).toBeLessThanOrEqual(2)
        expect(Math.abs(question.signOffset)).toBeLessThanOrEqual(1)
      }
      expect(answer).toBe(15)
    })
  }

  test('opens the first question', async ({ page }) => {
    await page.goto('/')
    const question = page.locator('#faq details').first()
    await question.locator('summary').click()
    await expect(question).toHaveAttribute('open', '')
    await expect(question.locator('p')).toBeVisible()
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

  test('reads the examples of requests as a list', async ({ page }) => {
    await page.goto('/')
    const list = page.getByRole('list', { name: 'Примеры задач' })
    await expect(list.getByRole('listitem')).toHaveText([
      'Обнови цены',
      'Замени фото',
      'Добавь акцию',
      'Поменяй часы работы',
    ])
    await expect(list).toHaveCSS('list-style-type', 'none')
    await expect(list).toHaveCSS('padding-left', '0px')
  })

  for (const width of [390, 1440]) {
    test(`hold in every state of the page at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await expect(page.getByRole('slider')).toBeVisible()
      expect(await violations(page)).toEqual([])

      // The change applied, the card of the copy turned back, a question open.
      const demo = page.locator('#site-demo')
      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
      await page.locator('#safety').getByRole('button', { name: 'Отменить правку' }).click()
      await page.locator('#faq summary').first().click()
      await expect(page.locator('#faq details').first().locator('p')).toBeVisible()
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
      '#how-title',
      '#safety h2',
      '#pricing h3',
      '#start-title',
      '#site-demo > p',
      '#site-demo [role="group"] button',
    ]) {
      expect(await selection(selector), selector).toEqual(onLight)
    }
    // On the dark surfaces the pair is turned over.
    const onDark = { color: INK, background: MARKER }
    for (const selector of [
      'section[aria-label="Поддержка сайта одним сообщением"] h2',
      '#site-demo [aria-label="Демонстрационный чат"] strong',
      '#site-demo [aria-live]',
      '#top > footer nav a',
      // The dark bubble of a request on the paper.
      '#possibilities article p',
    ]) {
      expect(await selection(selector), selector).toEqual(onDark)
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
    // The page itself is smooth: that is what the attribute sets aside on the way.
    await expect(root).toHaveCSS('scroll-behavior', 'smooth')
    await expect(root).toHaveAttribute('data-scroll-behavior', 'smooth')
  })

  test('opens the landing at its top at once after a scrolled legal page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/terms/user-agreement')
    const home = page.getByRole('link', { name: 'Радити — на главную' }).first()
    await hydrated(home)
    await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }))
    const start = await page.evaluate(() => Math.round(window.scrollY))
    expect(start).toBeGreaterThan(500)
    await record(page)
    // Not a click of the pointer: the header of a legal page is not sticky, and the browser
    // would scroll the page up to the link before the press.
    await home.dispatchEvent('click')
    await expect(page.locator('#hero-title')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await settled(page)
    // A client transition: the record of the first page is still there. A jump is one position;
    // a smooth scroll would pass dozens on its way.
    const passed = await recorded(page)
    expect(passed).not.toBeNull()
    expect([...new Set(passed)]).toEqual([0])
  })

  test('jumps on the way from a scrolled landing to the registration and back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    // The plans are in: the page is as tall as it will be.
    await expect(page.getByRole('slider')).toBeVisible()
    const signUp = page.getByRole('banner').getByRole('link', { name: 'Зарегистрироваться' })
    await hydrated(signUp)
    await page.evaluate(() => window.scrollTo({ top: 2400, behavior: 'instant' }))
    const start = await page.evaluate(() => Math.round(window.scrollY))
    expect(start).toBe(2400)
    await record(page)
    // The header is sticky: its button is in the window, and the press scrolls nothing.
    await signUp.click()
    await page.waitForURL('**/sign-up')
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
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(start)
  })
})

test.describe('shapes and shadows', () => {
  test('gives every pill one radius and the open menu the soft shadow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const pills = [
      page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]'),
      page.locator('section[aria-labelledby="start-title"] a[href="/sign-up"]'),
      page.locator('#safety').getByRole('button', { name: 'Отменить правку' }),
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
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await expect(page.locator('#top > header > div').first()).toHaveCSS('height', `${height}px`)
      for (const id of ['how', 'pricing', 'faq']) {
        await page.evaluate((hash) => {
          location.hash = hash
        }, id)
        await expect.poll(() => miss(page, `#${id}`, height + 16)).toBeLessThanOrEqual(0.5)
      }
    })
  }

  // The demo stands 4px lower than a section: 108px from the top of a desktop window.
  for (const [width, anchor] of [
    [1440, 108],
    [768, 92],
    [390, 88],
  ] as const) {
    test(`keeps the anchor of the demo ${anchor}px from the top at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await page.locator('a[href="#site-demo"]').click()
      await expect.poll(() => miss(page, '#site-demo', anchor)).toBeLessThanOrEqual(0.5)
    })
  }

  // The room for the header is a margin of the targets. As a padding of the root it made the
  // browser «reveal» a focused link of the sticky header itself: every Tab onto the header
  // pulled a scrolled page up by half a window, down to its very top.
  for (const width of [390, 1440]) {
    test(`leaves a scrolled page in place when the focus comes to the header at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
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
      await page.setViewportSize({ width, height })
      await page.goto('/')
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
      await page.setViewportSize({ width, height: 700 })
      await page.goto('/')
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
  // The plans come from the database after the page, into a place under the anchors of the
  // navigation that stand above them and over the questions. Their placeholder keeps about
  // their height, and the page nudges the target into its place when they are in.

  /** How far the element stopped from its place under the header, and what the page did. */
  const arrival = (page: Page, selector: string) =>
    page.evaluate((selector) => {
      const target = document.querySelector(selector)
      if (!target) throw new Error(`No ${selector} on the page`)
      const place = parseFloat(getComputedStyle(target).scrollMarginTop)
      return {
        miss: Math.abs(target.getBoundingClientRect().top - place),
        place,
        nudges: (window as unknown as { nudges: string[] }).nudges,
      }
    }, selector)
  /** Counts the nudges of the page: it makes them with `scrollIntoView`, and nothing else does. */
  const countNudges = (page: Page) =>
    page.addInitScript(() => {
      const nudges: string[] = []
      Object.assign(window, { nudges })
      const scroll = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (...options) {
        nudges.push(this.id)
        scroll.apply(this, options)
      }
    })
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

  // The header is 68 and 88px high; an anchor stops 16px below it.
  for (const [width, room] of [
    [390, 84],
    [1440, 104],
  ] as const) {
    test(`stops the questions a step below the header when the page opens at them, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await countNudges(page)
      await page.goto('/#faq')
      await page.getByRole('slider').waitFor()
      await expect.poll(async () => (await arrival(page, '#faq')).miss).toBeLessThanOrEqual(1)
      await stopped(page)
      const { miss, place, nudges } = await arrival(page, '#faq')
      expect(place).toBe(room)
      expect(miss).toBeLessThanOrEqual(1)
      // One nudge at most; none when the plans came before the browser chose where to stop.
      expect(nudges.length).toBeLessThanOrEqual(1)
      expect(nudges.every((id) => id === 'faq')).toBe(true)
    })

    test(`leaves the page to the browser when it opens at a section above the plans, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await countNudges(page)
      await page.goto('/#how')
      await page.getByRole('slider').waitFor()
      await expect.poll(async () => (await arrival(page, '#how')).miss).toBeLessThanOrEqual(0.5)
      await stopped(page)
      const { miss, place, nudges } = await arrival(page, '#how')
      expect(place).toBe(room)
      expect(miss).toBeLessThanOrEqual(0.5)
      expect(nudges).toEqual([])
    })
  }

  test.describe('under reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('puts the questions into their place at once', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      await countNudges(page)
      await page.goto('/#faq')
      await page.getByRole('slider').waitFor()
      // The nudge follows the page, and the page does not scroll smoothly here.
      await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
      await expect.poll(async () => (await arrival(page, '#faq')).miss).toBeLessThanOrEqual(1)
      expect((await arrival(page, '#faq')).nudges.length).toBeLessThanOrEqual(1)
    })
  })

  // The nudge is for a document that the visitor opened by a link. After a reload the browser
  // puts the window where the visitor left it; a target a little off its place stands there by
  // their will, and a nudge would take them back to the anchor.
  test.describe('for a visitor who scrolled a little past the anchor', () => {
    const PAST = 60

    /**
     * Makes the browser lay the page out before its document ends. Chromium chooses at the end
     * of the document: it has laid the page out and restored the place of the visitor by then,
     * or it goes to the anchor of the address by itself, whatever the page does. Which of the
     * two happens is a matter of timing that the page does not decide; left alone, the browser
     * goes to the anchor more often than not. This takes the first case, the one where a nudge
     * of the page would show.
     */
    const restoresThePlace = (page: Page) =>
      page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => void window.scrollY)
      })
    /** The plans are in and React has taken the page over; then the frames in which the page
     *  would find the window still and nudge it. */
    const timeForNudge = async (page: Page) => {
      await hydrated(page.getByRole('slider'))
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            let frames = 0
            const next = () => {
              frames += 1
              if (frames < 30) requestAnimationFrame(next)
              else done()
            }
            requestAnimationFrame(next)
          }),
      )
    }

    for (const width of [390, 1440]) {
      test(`keeps the place after a reload at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await countNudges(page)
        await restoresThePlace(page)
        // The page opens at the questions, and the visitor scrolls on, as a reader of the first
        // answers would.
        await page.goto('/#faq')
        await page.getByRole('slider').waitFor()
        await expect.poll(async () => (await arrival(page, '#faq')).miss).toBeLessThanOrEqual(1)
        await stopped(page)
        const start = await page.evaluate(() => window.scrollY)
        await page.evaluate((top) => window.scrollBy({ top, behavior: 'instant' }), PAST)
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(start + PAST)

        await page.reload()
        expect(
          await page.evaluate(
            () =>
              (performance.getEntriesByType('navigation') as PerformanceNavigationTiming[])[0]
                ?.type,
          ),
        ).toBe('reload')
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(start + PAST)
        await timeForNudge(page)
        await stopped(page)
        // The record of the nudges is of the new document: it starts empty.
        const { miss, nudges } = await arrival(page, '#faq')
        expect(nudges).toEqual([])
        expect(await page.evaluate(() => window.scrollY)).toBe(start + PAST)
        expect(Math.abs(miss - PAST)).toBeLessThanOrEqual(1)
      })
    }
  })

  // The nudge is only for a small move, so the placeholder must keep about the height of the
  // plans: a little less rather than more, or the target would go up under the header.
  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`keeps about the height of the plans for them while they load, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await page.getByRole('slider').waitFor()
      const heights = await page.locator('#pricing').evaluate((section) => {
        const plans = section.lastElementChild
        // The class of the placeholder as the stylesheet names it: the plans have taken its
        // place by now, so a copy stands in for it.
        const name = [...document.styleSheets]
          .flatMap((sheet) => [...sheet.cssRules])
          .flatMap((rule) => (rule instanceof CSSMediaRule ? [...rule.cssRules] : [rule]))
          .map((rule) => (rule instanceof CSSStyleRule ? rule.selectorText : ''))
          .find((selector) => /^\.[\w-]*__fallback$/.test(selector))
        if (!plans || !name) throw new Error('No plans or no rule for their placeholder')
        const copy = document.createElement('p')
        copy.className = name.slice(1)
        section.append(copy)
        const kept = copy.getBoundingClientRect().height
        copy.remove()
        return { plans: plans.getBoundingClientRect().height, kept }
      })
      expect(heights.plans - heights.kept).toBeGreaterThanOrEqual(0)
      expect(heights.plans - heights.kept).toBeLessThanOrEqual(80)
    })
  }

  test.describe('without scripts', () => {
    test.use({ javaScriptEnabled: false })

    // The plans never take the place of the placeholder there: it must not hold a field open.
    test('keeps no room for the plans', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      await page.goto('/')
      const placeholder = page.locator('#pricing [data-pending]')
      await expect(placeholder).toHaveText('Загружаем тарифы…')
      expect((await placeholder.boundingBox())?.height).toBeLessThan(60)
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
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
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/')
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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
      expect(target.animations, target.name).toEqual([])
      expect(target.transform, target.name).toBe('none')
    }
  })

  test('changes every state of the page at once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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

    // The card of the safety block.
    const safety = page.locator('#safety')
    await bringIntoWindow(page, safety)
    await safety.getByRole('button', { name: 'Отменить правку' }).click()
    await expect(safety.getByRole('status')).toHaveText('Прежняя цена возвращена')
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const toggle = page.locator('#top > header button[aria-controls]')
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await hydrated(page.locator('#top > header button[aria-controls]'))
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
// plays its own beats.
const RISING = '[data-reveal]:not([data-reveal="scene"])'
const SCENES = '[data-reveal="scene"]'

/** The elements that rise into the window, in the order of the page, as a script sees them. */
function revealTargets(page: Page) {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return {
          name: element.id || (element.closest('section')?.id ?? ''),
          top: box.top,
          inWindow: box.bottom > 0 && box.top < window.innerHeight,
          opacity: style.opacity,
          transform: style.transform,
          animations: element.getAnimations().map((animation) => {
            const effect = animation.effect as KeyframeEffect
            const { duration, easing, fill, delay } = effect.getTiming()
            return {
              css: animation instanceof CSSAnimation || animation instanceof CSSTransition,
              state: animation.playState,
              duration,
              delay,
              easing,
              fill,
              // What the keyframes change, besides the fields every keyframe has.
              properties: [
                ...new Set(
                  effect
                    .getKeyframes()
                    .flatMap((keyframe) =>
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
}

/** Waits until the helper of the reveal has put down the targets below the window. */
function revealPrepared(page: Page): Promise<unknown> {
  return page.waitForFunction(() => document.getElementById('start-title')?.getAnimations().length)
}

const PUT_DOWN = 'matrix(1, 0, 0, 1, 0, 24)'

test.describe('headings on the way into the window', () => {
  test('are the heading groups of six sections, not the sections', async ({ page }) => {
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
    // A scene is not moved: it only learns when it comes into the window.
    expect(await named(SCENES)).toEqual([
      'Поддержка сайта одним сообщением:p',
      'how:div',
      'how:div',
    ])
    expect(await named(RISING)).toEqual([
      'how:div',
      'possibilities:div',
      'safety:div',
      'pricing:div',
      'faq:div',
      'start-title:h2',
    ])
    // The server marks them: nothing waits for a script to become a target, and no section is one.
    expect(await page.locator('section[data-reveal], main[data-reveal]').count()).toBe(0)
  })

  for (const width of [390, 1440]) {
    test(`are put down only below the window, with a shift alone, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await revealPrepared(page)
      const targets = await revealTargets(page)

      expect(targets).toHaveLength(6)
      for (const target of targets) {
        // Never dimmed: the text keeps its contrast even if the observer never reports.
        expect(target.opacity, target.name).toBe('1')
        expect(target.inWindow, target.name).toBe(false)
        expect(target.transform, target.name).toBe(PUT_DOWN)
        expect(target.animations, target.name).toEqual([
          {
            css: false,
            state: 'paused',
            duration: 560,
            delay: 0,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            fill: 'backwards',
            properties: ['transform'],
          },
        ])
      }
      // The first screen is as the server drew it: no script animation on anything in it.
      const touched = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => !(animation instanceof CSSAnimation))
            .map((animation) => (animation.effect as KeyframeEffect).target)
            .filter((element) => {
              const box = element?.getBoundingClientRect()
              return box && box.bottom > 0 && box.top < window.innerHeight
            }).length,
      )
      expect(touched).toBe(0)
      // The orange field of the safety block stands still: only its copy is a target.
      const field = await page.locator('#safety').evaluate((section) => ({
        transform: getComputedStyle(section).transform,
        animations: section.getAnimations().length,
      }))
      expect(field).toEqual({ transform: 'none', animations: 0 })
    })
  }

  test('rise once, in 560ms, and leave nothing on the element', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await revealPrepared(page)
    const heading = page.locator(`#how ${RISING}`)
    const state = () =>
      heading.evaluate((element) => ({
        states: element.getAnimations().map((animation) => animation.playState),
        transform: getComputedStyle(element).transform,
        opacity: getComputedStyle(element).opacity,
      }))
    expect(await state()).toEqual({ states: ['paused'], transform: PUT_DOWN, opacity: '1' })

    await page.evaluate(() => {
      const top = document.querySelector('#how')?.getBoundingClientRect().top ?? 0
      window.scrollTo({ top: top - 200, behavior: 'instant' })
    })
    await expect.poll(async () => (await state()).states).toEqual(['running'])
    expect((await state()).opacity).toBe('1')
    await expect.poll(async () => (await state()).states).toEqual([])
    expect(await state()).toEqual({ states: [], transform: 'none', opacity: '1' })

    // Once: the way back and forth starts nothing.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }))
    await settled(page)
    expect(await state()).toEqual({ states: [], transform: 'none', opacity: '1' })
  })

  test('take their places without a move when a jump carries the page past them', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.getByRole('slider').waitFor()
    await revealPrepared(page)
    await page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
    )
    await settled(page)
    for (const target of await revealTargets(page)) {
      expect(target.animations, target.name).toEqual([])
      expect(target.transform, target.name).toBe('none')
      expect(target.opacity, target.name).toBe('1')
    }
  })

  test('are not touched when the window shows them from the start', async ({ page }) => {
    // A window tall enough to hold the first section heading below the first screen.
    await page.setViewportSize({ width: 1440, height: 2400 })
    await page.goto('/')
    await revealPrepared(page)
    const [first, ...rest] = await revealTargets(page)
    expect(first).toMatchObject({ name: 'how', inWindow: true, opacity: '1', transform: 'none' })
    expect(first?.animations).toEqual([])
    expect(rest.filter((target) => !target.inWindow).length).toBeGreaterThan(0)
    for (const target of rest.filter((target) => !target.inWindow)) {
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
      await revealPrepared(page)
      // The browser scrolls to the anchor smoothly, past the headings on the way.
      let last = -1
      await expect
        .poll(async () => {
          const now = await page.evaluate(() => window.scrollY)
          const still = now === last && now > 0
          last = now
          return still
        })
        .toBe(true)
      await settled(page)
      // The line of the observer: 8% above the bottom of the window.
      const line = 900 * 0.92
      for (const target of await revealTargets(page)) {
        // Whether passed, on the screen or still below: never dimmed.
        expect(target.opacity, target.name).toBe('1')
        if (target.top < line - 1) {
          expect(target.transform, target.name).toBe('none')
          expect(target.animations, target.name).toEqual([])
        }
      }
    })
  }

  test.describe('without scripts', () => {
    test.use({ javaScriptEnabled: false })

    test('stand in their places with their text', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/')
      const targets = page.locator(RISING)
      await expect(targets).toHaveCount(6)
      for (const target of await targets.all()) {
        await expect(target).toHaveCSS('transform', 'none')
        await expect(target).toHaveCSS('opacity', '1')
        await expect(target).not.toBeEmpty()
      }
      await expect(page.locator('#faq-title')).toHaveText('Хороший вопрос.')
    })
  })
})

/** The animations and transitions of an element and of its pseudo-elements, as a script sees them. */
function motionOf(element: Locator) {
  return element.evaluate((node) =>
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
              ? // A CSS module adds a hash to the name written in the source.
                (animation.animationName.split('__').pop()?.replace(/_.*$/, '') ?? '')
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
}

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'

test.describe('demo in motion', () => {
  /** The demo with its buttons wired and the entrance of the first screen over. */
  async function openDemo(page: Page, width: number): Promise<Locator> {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
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

      await demo.getByRole('button', { name: 'Применить правку' }).click()
      await expect(demo.getByText('Изменено')).toBeVisible()
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

test.describe('safety card in motion', () => {
  // The saved version is turned by six degrees to the left in both states.
  const SAVED_TURN = /^matrix\(0\.9945\d*, -0\.1045\d*, 0\.1045\d*, 0\.9945\d*, 0, (-?\d+)\)$/

  /** The card in front, the saved version behind it and what moves of them. */
  const look = (card: Locator) =>
    card.evaluate((node) => {
      const saved = node.parentElement?.querySelector('[aria-hidden="true"]')
      if (!saved) throw new Error('No saved version behind the card')
      const style = getComputedStyle(saved)
      return {
        turn: getComputedStyle(node).transform,
        transition: getComputedStyle(node).transitionDuration,
        shadow: getComputedStyle(node).boxShadow,
        cardMoving: node.getAnimations().length,
        saved: style.transform,
        savedShadow: style.boxShadow,
        savedTransition: `${style.transitionProperty} ${style.transitionDuration}`,
        savedMoving: saved.getAnimations().map((animation) => {
          const effect = animation.effect as KeyframeEffect
          return {
            property: animation instanceof CSSTransition ? animation.transitionProperty : 'other',
            duration: effect.getTiming().duration,
          }
        }),
        state: node.parentElement?.getAttribute('data-reverted'),
      }
    })

  /** Whether the price that the saved version keeps is seen: not covered by the card in front. */
  const savedPriceIsSeen = (page: Page) =>
    page.locator('#safety').evaluate((section) => {
      const price = section.querySelector<HTMLElement>('[aria-hidden="true"] > span:last-child')
      const saved = price?.parentElement
      if (!price || !saved) throw new Error('The saved version has no price')
      const seen = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y)
        return hit === price || hit === saved
      }
      const text = document.createRange()
      text.selectNodeContents(price)
      // The ends of the text and its middle: the card in front is turned the other way.
      const boxes = [...text.getClientRects()]
      const { left, right, top, bottom } = text.getBoundingClientRect()
      const middle = (top + bottom) / 2
      const points = [left + 2, (left + right) / 2, right - 2].map((x) => [x, middle] as const)

      // The foot of the first letter is the lowest point of the price: the turn lowers the left
      // end of the line. Its place before the turn comes from the layout and the metrics of
      // the face; the transform of the saved version takes it to the window.
      const style = getComputedStyle(price)
      const pen = document.createElement('canvas').getContext('2d')
      if (!pen) throw new Error('No canvas to measure the text')
      pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = pen.measureText(
        price.textContent,
      )
      const baseline = price.offsetTop + (price.offsetHeight - ascent - descent) / 2 + ascent
      const scene = saved.offsetParent?.getBoundingClientRect()
      if (!scene) throw new Error('The saved version is not placed in its scene')
      const centre = new DOMPoint(saved.offsetWidth / 2, saved.offsetHeight / 2)
      const turned = new DOMMatrix(getComputedStyle(saved).transform).transformPoint(
        new DOMPoint(price.offsetLeft - centre.x, baseline - centre.y),
      )
      const foot = {
        x: scene.left + saved.offsetLeft + centre.x + turned.x,
        y: scene.top + saved.offsetTop + centre.y + turned.y,
      }
      // Clear of the card in front, not touching it: a few pixels of the saved version under it.
      const CLEAR = 4
      return (
        boxes.length > 0 &&
        points.every(([x, y]) => seen(x, y)) &&
        seen(foot.x + 1, foot.y - 1) &&
        seen(foot.x + 1, foot.y + CLEAR)
      )
    })

  // 801px: two columns at their narrowest, the narrowest card after the one of a phone.
  for (const [width, out] of [
    [1440, 28],
    [1024, 28],
    [801, 28],
    [390, 20],
    [320, 20],
  ] as const) {
    test(`shows the saved price and brings the saved version out on an undo at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const safety = page.locator('#safety')
      const undo = safety.getByRole('button', { name: 'Отменить правку' })
      await hydrated(undo)
      const card = safety.getByRole('status').locator('xpath=..')
      const savedText = safety.locator('[aria-hidden="true"]').first()
      // The saved version under the header, the button of the card in the window.
      await bringIntoWindow(page, savedText)
      await expect(savedText).toHaveText(/Копия сохранена\s*Капучино.· 250.₽/)

      const atRest = await look(card)
      expect(SAVED_TURN.exec(atRest.saved)?.[1]).toBe('0')
      expect(atRest).toMatchObject({
        savedShadow: 'none',
        savedTransition: 'transform 0.56s',
        savedMoving: [],
        state: 'false',
      })
      // What the saved version keeps is read while the change is in force.
      expect(await savedPriceIsSeen(page)).toBe(true)

      await undo.click()
      await expect(safety.getByRole('status')).toHaveText('Прежняя цена возвращена')
      // Only its transform moves, by a transition of the «move» step; no shadow comes with it.
      expect((await look(card)).savedMoving).toEqual([{ property: 'transform', duration: 560 }])
      await settled(page)
      const undone = await look(card)
      // Out from under the card by the room kept for it, with the same turn.
      expect(SAVED_TURN.exec(undone.saved)?.[1]).toBe(String(-out))
      expect(undone).toMatchObject({ savedShadow: 'none', savedMoving: [], state: 'true' })
      // The card in front is as it was: its turn, its shadow, nothing moving.
      expect(undone).toMatchObject({
        turn: atRest.turn,
        shadow: atRest.shadow,
        transition: atRest.transition,
        cardMoving: 0,
      })
      expect(await savedPriceIsSeen(page)).toBe(true)

      await safety.getByRole('button', { name: 'Применить снова' }).click()
      await expect(safety.getByRole('status')).toHaveText(/^Новая цена/)
      await settled(page)
      expect(await look(card)).toEqual(atRest)
    })
  }

  test('answers a press in the middle of the way', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    const safety = page.locator('#safety')
    const undo = safety.getByRole('button', { name: 'Отменить правку' })
    await hydrated(undo)
    await bringIntoWindow(page, safety.locator('[aria-hidden="true"]').first())
    await undo.click()
    // Before the saved version has come out, the change is applied again.
    await safety.getByRole('button', { name: 'Применить снова' }).click()
    await expect(safety.getByRole('status')).toHaveText(/^Новая цена/)
    await settled(page)
    const card = safety.getByRole('status').locator('xpath=..')
    expect(SAVED_TURN.exec((await look(card)).saved)?.[1]).toBe('0')
  })

  test('keeps its turn and tells an undo with the direction of the price', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    const safety = page.locator('#safety')
    const undo = safety.getByRole('button', { name: 'Отменить правку' })
    await hydrated(undo)
    await bringIntoWindow(page, safety)
    const card = safety.getByRole('status').locator('xpath=..')
    const price = safety.locator('strong').filter({ hasText: '₽' })
    const front = async () => {
      const { turn, transition, shadow, cardMoving, state } = await look(card)
      return { turn, transition, shadow, cardMoving, state }
    }
    const atRest = await front()
    // Turned by two degrees: a level card would say «applied», which is the word of the demo.
    expect(atRest.turn).toMatch(/^matrix\(0\.999\d*, 0\.0348\d*, -0\.0348\d*, 0\.999\d*, 0, 0\)$/)
    expect(atRest).toMatchObject({ transition: '0s', cardMoving: 0, state: 'false' })

    const gesture = {
      pseudo: null,
      duration: 360,
      delay: 0,
      easing: EASE_OUT,
      fill: 'backwards',
      properties: ['transform'],
    }
    await undo.click()
    await expect(safety.getByRole('status')).toHaveText('Прежняя цена возвращена')
    // From above: returned. The card itself does not move, and no shadow is added.
    expect(await motionOf(price)).toEqual([
      { ...gesture, name: 'valueReturn', from: { transform: 'translateY(-6px)' } },
    ])
    expect(await front()).toEqual({ ...atRest, state: 'true' })
    await settled(page)
    await expect(price).toHaveCSS('transform', 'none')
    await expect(price).toHaveCSS('opacity', '1')

    await safety.getByRole('button', { name: 'Применить снова' }).click()
    await expect(safety.getByRole('status')).toHaveText(/^Новая цена/)
    // From below: changed.
    expect(await motionOf(price)).toEqual([
      { ...gesture, name: 'valueRise', from: { transform: 'translateY(6px)' } },
    ])
    expect(await front()).toEqual(atRest)
  })

  test.describe('under reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('brings the saved version out at once', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/')
      const safety = page.locator('#safety')
      const undo = safety.getByRole('button', { name: 'Отменить правку' })
      await hydrated(undo)
      const card = safety.getByRole('status').locator('xpath=..')
      await undo.click()
      await expect(safety.getByRole('status')).toHaveText('Прежняя цена возвращена')
      const undone = await look(card)
      expect(SAVED_TURN.exec(undone.saved)?.[1]).toBe('-28')
      expect(undone.savedMoving).toEqual([])
    })
  })
})

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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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
      details.querySelector('summary')?.click()
      await frame()
      await frame()
      const paragraph = details.querySelector('p')
      return {
        open: details.open,
        moved: (next?.getBoundingClientRect().top ?? 0) - before,
        opacity: paragraph ? getComputedStyle(paragraph).opacity : '',
        answerMoves: paragraph?.getAnimations().length,
        // Of the box that holds the answer, two frames into the opening.
        height: parseFloat(getComputedStyle(details, '::details-content').blockSize),
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
      details.querySelector('summary')?.click()
      await frame()
      await frame()
      const style = getComputedStyle(details, '::details-content')
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const toggle = page.locator('#top > header button[aria-controls]')
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
        return {
          display: style.display,
          pointer: style.pointerEvents,
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
    expect(opening).toMatchObject({ display: 'flex', hidden: false, inert: false, reachable: true })
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
    // Still shown while it fades out, where it stood, and already out of reach.
    expect(closing).toMatchObject({
      display: 'flex',
      pointer: 'none',
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
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

    // One pack more with the same plan: words change, nothing moves.
    await slider.fill('40')
    await expect(pricing.getByText(/дополнительный пакет/)).toBeVisible()
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
    // The sums, the number of edits and the slider change at once.
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
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await hydrated(page.locator('#top > header button[aria-controls]'))
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const toggle = page.locator('#top > header button[aria-controls]')
    await hydrated(toggle)
    await page.getByRole('slider').waitFor()
    await bringIntoWindow(page, page.locator('#how'))
    await expect.poll(() => marked(page)).toContain('Мобильная навигация: Как это работает')
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
    expect(links[0]).toEqual({
      label: 'Как это работает',
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
