/* eslint-disable turbo/no-undeclared-env-vars -- Switches of a local tool, outside Turbo tasks. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import {
  applyChange,
  headerAction,
  heroAction,
  hydrated,
  openAt,
  platformsAction,
  RUNNING_LINE,
  settled,
} from './landing-page.ts'

// A local tool for reworking the landing CSS, not a gate: it records what the browser computed
// for every element of the page and tells whether a change left the page as it was.
//   LANDING_STYLE_SNAPSHOT=record   writes the snapshot to LANDING_STYLE_SNAPSHOT_FILE
//   LANDING_STYLE_SNAPSHOT=compare  fails with the list of differences from that file
//   LANDING_STYLE_SNAPSHOT=shots    writes PNGs for the eye to LANDING_STYLE_SNAPSHOT_DIR
// It runs only through playwright.style-snapshot.config.ts. The values depend on the browser
// build and the fonts of the machine, so a snapshot is compared where it was recorded.
// The page is read after everything that plays once on entering the window has played: a heading
// still waiting below the window stands lower than its place. The running line of the systems
// never rests, so it is stopped at its first frame: a snapshot and a shot find it in one place.
// A snapshot describes the page it was recorded from: after a redesign of the page (the last one
// is of 13.11.2026) the snapshots of the page before it are of no use, and the first step of a
// CSS rework is a new record.
//
// The shots mode compares nothing: a number tells that a line moved, not that it reads badly.
// At 390, 768 and 1440px (LANDING_STYLE_SNAPSHOT_WIDTHS=320,1024 names other widths) it writes
//   <width>-01-hero.png … <width>-09-footer.png  every section in its first state, the header
//                                                with the hero: the first screen, the example,
//                                                the systems, the capabilities, the safety block,
//                                                the plans, the lead, the questions, the footer
//   <width>-demo-applied.png, -demo-undone.png   the demo after a change and after its undo
//   <width>-demo-promotion.png, -demo-promotion-applied.png
//                                                the same for the request that changes the
//                                                banner of the cafe, the longest line of its site
//   <width>-lead-errors.png                      the form of a lead with the messages under its
//                                                empty fields
//   <width>-faq-open.png                         the questions with the first one open
//   <width>-menu-open.png                        the window with the mobile menu open, at the
//                                                widths that show its button
// Sections are cut from one capture of the whole page at twice the density, taken from the top
// of the document: there the sticky header covers no section. What plays once on entering the
// window has played before the capture.
// A width with a height (LANDING_STYLE_SNAPSHOT_WIDTHS=1366x640,1024x640) asks for the first
// screen alone: <width>x<height>-window.png shows what a window of that size holds above the fold.
// LANDING_STYLE_SNAPSHOT_FORCED_COLORS=active takes the shots in a forced colours mode.

const MODE = process.env.LANDING_STYLE_SNAPSHOT
const FILE = process.env.LANDING_STYLE_SNAPSHOT_FILE
const DIR = process.env.LANDING_STYLE_SNAPSHOT_DIR

// Every breakpoint of the three CSS modules from both sides, plus the widths of the review.
const WIDTHS = [320, 390, 540, 541, 768, 800, 801, 1024, 1100, 1101, 1440, 1920]
const HEIGHT = 900
const STATE_WIDTH = 1440
const TAB_STOPS = 12

/** A width alone asks for the sections; with a height, for the window of that size. */
const SHOT_SIZES = (process.env.LANDING_STYLE_SNAPSHOT_WIDTHS ?? '390,768,1440')
  .split(',')
  .map((size) => {
    const [width, height] = size.trim().split('x').map(Number)
    return { width: width ?? NaN, height }
  })
const FORCED_COLORS = process.env.LANDING_STYLE_SNAPSHOT_FORCED_COLORS === 'active'
// In the order of the page. A section without an id is found from a heading that has one.
const SHOT_SECTIONS: [string, string][] = [
  ['hero', '#top > header, section:has(#hero-title)'],
  ['demo', '#demo'],
  ['platforms', '#platforms'],
  ['capabilities', '#possibilities'],
  ['safety', '#safety'],
  ['pricing', '#pricing'],
  ['lead', '#lead'],
  ['faq', '#faq'],
  ['footer', '#top > footer'],
]
// Room around the demo: its window and chat are turned and reach past the box of the figure.
const DEMO_MARGIN = 24

const PROPERTIES = [
  'display',
  'position',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-radius',
  'margin',
  'padding',
  'opacity',
  'transform',
  'text-decoration-line',
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
  'box-shadow',
  'white-space',
  'gap',
  // Beyond the box and its paint: a base rule, an alias or an icon can change these unnoticed.
  'background-image',
  'font-style',
  'text-wrap',
  'cursor',
  'text-underline-offset',
  '-webkit-tap-highlight-color',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-fill-mode',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'd',
]
// A pseudo-element has no box to measure, so its computed box stands in for the rectangle.
const PSEUDO_PROPERTIES = [
  'content',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  ...PROPERTIES,
]
const RECT = ['x', 'y', 'width', 'height']

/** A hint for the reader first, then the values in the order of the lists above. */
type Entry = (string | number)[]
type Section = Record<string, Entry>
type Snapshot = {
  properties: string[]
  pseudoProperties: string[]
  sections: Record<string, Section>
}

type ReadOptions = {
  properties: string[]
  pseudoProperties: string[]
  /** The whole subtree or the element alone. */
  deep: boolean
  /** Rectangles from the top of the document, or from the element when the page may be scrolled. */
  origin: 'document' | 'element'
  prefix: string
}

/** Runs in the page. An element is named by its path from the landing root: tags and indices. */
function readElements(root: Element, options: ReadOptions): Section {
  const { properties, pseudoProperties, deep, origin, prefix } = options
  const half = (value: number) => Math.round(value * 2) / 2
  const rootBox = root.getBoundingClientRect()
  const left = origin === 'element' ? rootBox.x : -window.scrollX
  const top = origin === 'element' ? rootBox.y : -window.scrollY

  const steps: string[] = []
  for (let node = root; node.id !== 'top';) {
    const parent = node.parentElement
    if (!parent) throw new Error('The element is outside the landing root #top')
    steps.unshift(`${node.localName}[${Array.prototype.indexOf.call(parent.children, node)}]`)
    node = parent
  }

  const hintOf = (element: Element) => {
    const classes = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    // A CSS module class ends with the name written in the source.
    const names = classes.map((name) => `.${name.split('__').pop()}`)
    return `${element.localName}${element.id ? `#${element.id}` : ''}${names.join('')}`
  }

  const section: Section = {}
  const visit = (element: Element, path: string) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    const hint = hintOf(element)
    section[`${prefix}${path}`] = [
      hint,
      half(box.x - left),
      half(box.y - top),
      half(box.width),
      half(box.height),
      ...properties.map((property) => style.getPropertyValue(property)),
    ]
    for (const pseudo of ['::before', '::after']) {
      const pseudoStyle = getComputedStyle(element, pseudo)
      if (pseudoStyle.getPropertyValue('content') === 'none') continue
      section[`${prefix}${path}${pseudo}`] = [
        `${hint}${pseudo}`,
        ...pseudoProperties.map((property) => pseudoStyle.getPropertyValue(property)),
      ]
    }
    if (!deep) return
    Array.from(element.children).forEach((child, index) =>
      visit(child, `${path}/${child.localName}[${index}]`),
    )
  }
  visit(root, ['#top', ...steps].join('/'))
  return section
}

function read(target: Locator, options: Pick<ReadOptions, 'deep' | 'origin' | 'prefix'>) {
  return target.evaluate(readElements, {
    properties: PROPERTIES,
    pseudoProperties: PSEUDO_PROPERTIES,
    ...options,
  })
}

async function openLanding(page: Page, width: number, height = HEIGHT): Promise<void> {
  await openAt(page, width, height)
  // Before the hydration a click or an observer is not wired.
  for (const selector of ['#pricing input[type="range"]', '#site-demo button', 'header button']) {
    await hydrated(page.locator(selector).first())
  }
  // The running line is stopped where it starts: it would be read and shot in a new place
  // every time, and a comparison would report its transform as a difference.
  await page.evaluate((runningLine) => {
    for (const animation of document.getAnimations()) {
      if (!(animation instanceof CSSAnimation && animation.animationName.includes(runningLine))) {
        continue
      }
      animation.pause()
      animation.currentTime = 0
    }
  }, RUNNING_LINE)
  await settled(page)
}

function fieldsOf(key: string, snapshot: Snapshot): string[] {
  return /::(before|after)$/.test(key)
    ? snapshot.pseudoProperties
    : [...RECT, ...snapshot.properties]
}

function differences(snapshot: Snapshot, recorded: Section, current: Section): string[] {
  const lines: string[] = []
  for (const key of new Set([...Object.keys(recorded), ...Object.keys(current)])) {
    const was = recorded[key]
    const now = current[key]
    if (!was || !now) {
      const hint = (now ?? was)?.[0]
      lines.push(`${key} (${hint}): ${now ? 'new on the page' : 'gone from the page'}`)
      continue
    }
    fieldsOf(key, snapshot).forEach((field, index) => {
      if (was[index + 1] !== now[index + 1]) {
        lines.push(`${key} (${now[0]}) ${field}: ${was[index + 1]} -> ${now[index + 1]}`)
      }
    })
  }
  return lines
}

function sameList(left: unknown, right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function loadSnapshot(file: string): Snapshot | undefined {
  if (!existsSync(file)) return undefined
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
  const current =
    sameList(snapshot.properties, PROPERTIES) &&
    sameList(snapshot.pseudoProperties, PSEUDO_PROPERTIES)
  return current ? snapshot : undefined
}

/** Records the section or compares it with the recorded one, depending on the mode. */
async function recordOrCompare(name: string, section: Section): Promise<void> {
  if (!FILE) throw new Error('LANDING_STYLE_SNAPSHOT_FILE is not set')
  const file = resolve(FILE)
  const snapshot = loadSnapshot(file)
  if (MODE === 'record') {
    // Section by section, so a rerun of one test replaces only its own part.
    const next: Snapshot = snapshot ?? {
      properties: PROPERTIES,
      pseudoProperties: PSEUDO_PROPERTIES,
      sections: {},
    }
    next.sections[name] = section
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next))
    return
  }
  if (!snapshot) {
    throw new Error(`No snapshot with the current list of properties at ${file}: record it first`)
  }
  const recorded = snapshot.sections[name]
  if (!recorded) throw new Error(`The snapshot has no section "${name}": record it first`)
  const lines = differences(snapshot, recorded, section)
  if (lines.length === 0) return
  await test.info().attach('differences.txt', { body: lines.join('\n'), contentType: 'text/plain' })
  const shown = lines.slice(0, 200)
  const rest = lines.length > shown.length ? `\n… and ${lines.length - shown.length} more` : ''
  throw new Error(`${lines.length} differences in "${name}":\n${shown.join('\n')}${rest}`)
}

/**
 * Lets every sign of the brand finish its entrance. A script draws it frame by frame while the
 * sign is in the window, so no animation of the document tells of it: a sign caught on its way
 * would be read with the rays of that frame, different in every run.
 */
async function brandSignsAtRest(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
    for (const sign of document.querySelectorAll<SVGElement>('svg[data-brand-motion-state]')) {
      if (sign.dataset.brandMotionState === 'complete') continue
      // The entrance goes on only while the sign is in the window.
      sign.scrollIntoView({ behavior: 'instant', block: 'center' })
      const start = performance.now()
      while (sign.dataset.brandMotionState !== 'complete') {
        if (performance.now() - start > 15_000) {
          throw new Error('A sign of the brand did not finish its entrance in 15 seconds')
        }
        await frame()
      }
    }
  })
}

/**
 * Scrolls through the page, so that everything that plays once on entering the window has
 * played, and comes back to the top: the sticky header follows the scroll.
 */
async function playReveals(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
    for (let top = 0; top < document.documentElement.scrollHeight; top += window.innerHeight / 2) {
      // Instant: the landing scrolls smoothly, and a smooth scroll would not arrive in two frames.
      window.scrollTo({ top, behavior: 'instant' })
      await frame()
      await frame()
    }
  })
  await settled(page)
  await brandSignsAtRest(page)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await settled(page)
}

/** Writes the part of the page that the elements take, as wide as the page. */
async function shoot(page: Page, name: string, selector: string, margin = 0): Promise<void> {
  if (!DIR) throw new Error('LANDING_STYLE_SNAPSHOT_DIR is not set')
  // Out of the way of hover styles, and back to the top: the sticky header follows the scroll.
  await page.mouse.move(1, 1)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await settled(page)
  const clip = await page.evaluate(
    ([selector, margin]) => {
      const boxes = [...document.querySelectorAll(selector)].map((element) =>
        element.getBoundingClientRect(),
      )
      if (boxes.length === 0) throw new Error(`Nothing on the page matches ${selector}`)
      const top = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.top)) - margin))
      const bottom = Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + margin)
      const width = document.documentElement.clientWidth
      return { x: 0, y: top + window.scrollY, width, height: bottom - top }
    },
    [selector, margin] as const,
  )
  await page.screenshot({ path: resolve(DIR, `${name}.png`), fullPage: true, clip })
}

test.beforeAll(() => {
  if (MODE !== 'record' && MODE !== 'compare' && MODE !== 'shots') {
    throw new Error('Set LANDING_STYLE_SNAPSHOT to record, compare or shots')
  }
  if (MODE === 'shots') {
    if (!DIR) throw new Error('Set LANDING_STYLE_SNAPSHOT_DIR to the directory for the shots')
    const valid = ({ width, height }: (typeof SHOT_SIZES)[number]) =>
      width >= 320 && (height === undefined || height >= 200)
    if (SHOT_SIZES.length === 0 || !SHOT_SIZES.every(valid)) {
      throw new Error(
        'LANDING_STYLE_SNAPSHOT_WIDTHS is a list of widths from 320px, a window as 1366x640',
      )
    }
    mkdirSync(resolve(DIR), { recursive: true })
  } else if (!FILE) {
    throw new Error('Set LANDING_STYLE_SNAPSHOT_FILE to the path of the snapshot')
  }
})

if (MODE === 'shots') {
  test.describe('shots', () => {
    // Twice the density, as on a phone or a laptop of today: small text stays readable in the PNG.
    test.use({ deviceScaleFactor: 2, forcedColors: FORCED_COLORS ? 'active' : 'none' })

    for (const { width, height } of SHOT_SIZES) {
      if (height !== undefined) {
        test(`the window of ${width}x${height}px`, async ({ page }) => {
          await openLanding(page, width, height)
          await page.addStyleTag({ content: 'nextjs-portal { display: none }' })
          await page.screenshot({ path: resolve(DIR ?? '', `${width}x${height}-window.png`) })
        })
        continue
      }
      test(`at ${width}px`, async ({ page }) => {
        await openLanding(page, width)
        // The badge of the Next dev server is fixed to the window and would lie over a section.
        await page.addStyleTag({ content: 'nextjs-portal { display: none }' })
        await playReveals(page)
        for (const [index, [name, selector]] of SHOT_SECTIONS.entries()) {
          await shoot(page, `${width}-${String(index + 1).padStart(2, '0')}-${name}`, selector)
        }

        const demo = page.locator('#site-demo')
        await applyChange(demo)
        await shoot(page, `${width}-demo-applied`, '#site-demo', DEMO_MARGIN)
        await demo.getByRole('button', { name: 'Отменить правку' }).click()
        await expect(demo.getByText('Возвращено')).toBeVisible()
        await shoot(page, `${width}-demo-undone`, '#site-demo', DEMO_MARGIN)
        await demo.getByRole('button', { name: 'Акция' }).click()
        const apply = demo.getByRole('button', { name: 'Применить правку' })
        await expect(apply).toBeVisible()
        await shoot(page, `${width}-demo-promotion`, '#site-demo', DEMO_MARGIN)
        await apply.click()
        await expect(demo.getByText('Изменено')).toBeVisible()
        await shoot(page, `${width}-demo-promotion-applied`, '#site-demo', DEMO_MARGIN)

        const lead = page.locator('#lead')
        await lead.getByRole('button', { name: 'Отправить заявку' }).click()
        await expect(lead.locator('[aria-invalid="true"]')).toHaveCount(3)
        // The first field took the focus; its ring is not a part of the picture.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await shoot(page, `${width}-lead-errors`, '#lead')

        const question = page.locator('#faq details').first()
        await question.locator('summary').click()
        await expect(question).toHaveAttribute('open', '')
        await shoot(page, `${width}-faq-open`, '#faq')

        // Last: the open menu lies over the top of the page.
        const toggle = page.getByRole('button', { name: 'Открыть меню' })
        if (await toggle.isVisible()) {
          await toggle.click()
          await expect(page.getByRole('navigation', { name: 'Мобильная навигация' })).toBeVisible()
          await page.mouse.move(1, 1)
          await settled(page)
          await page.screenshot({ path: resolve(DIR ?? '', `${width}-menu-open.png`) })
        }
      })
    }
  })
} else {
  test.describe('computed styles and geometry', () => {
    for (const width of WIDTHS) {
      test(`at ${width}px`, async ({ page }) => {
        await openLanding(page, width)
        await playReveals(page)
        const section = await read(page.locator('#top'), {
          deep: true,
          origin: 'document',
          prefix: '',
        })
        await recordOrCompare(`width ${width}`, section)
      })
    }
  })

  test.describe(`states at ${STATE_WIDTH}px`, () => {
    test('focus rings', async ({ page }) => {
      await openLanding(page, STATE_WIDTH)
      const section: Section = {}
      const readFocused = async (prefix: string) => {
        await settled(page)
        const focused = page.locator(':focus')
        expect(await focused.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
        Object.assign(section, await read(focused, { deep: false, origin: 'element', prefix }))
      }

      for (let stop = 1; stop <= TAB_STOPS; stop++) {
        await page.keyboard.press('Tab')
        await readFocused(`tab ${String(stop).padStart(2, '0')} `)
      }

      const pricing = page.locator('#pricing')
      const targets: [string, Locator][] = [
        ['slider ', pricing.getByRole('slider')],
        ['pricing action ', pricing.getByRole('link')],
      ]
      for (const [prefix, target] of targets) {
        // Away and back by keyboard: a focus set from a script may not count as keyboard focus.
        await target.focus()
        await page.keyboard.press('Shift+Tab')
        await page.keyboard.press('Tab')
        await expect(target).toBeFocused()
        await readFocused(prefix)
      }
      await recordOrCompare('focus', section)
    })

    test('hover', async ({ page }) => {
      await openLanding(page, STATE_WIDTH)
      const targets: [string, Locator][] = [
        ['primary button ', heroAction(page)],
        ['sign in ', page.locator('header a[href="/sign-in"]')],
        ['header action ', headerAction(page)],
        ['platforms action ', platformsAction(page)],
        ['pricing action ', page.locator('#pricing').getByRole('link')],
      ]
      const section: Section = {}
      for (const [prefix, target] of targets) {
        // Brought into the window first: the page scrolls smoothly, and a pointer sent to a
        // target on its way would come to rest beside it.
        await target.evaluate((element) =>
          element.scrollIntoView({ behavior: 'instant', block: 'center' }),
        )
        await settled(page)
        await target.hover()
        await settled(page)
        expect(await target.evaluate((element) => element.matches(':hover'))).toBe(true)
        Object.assign(section, await read(target, { deep: true, origin: 'element', prefix }))
      }
      await recordOrCompare('hover', section)
    })

    test('demo after applying and after undoing a change', async ({ page }) => {
      await openLanding(page, STATE_WIDTH)
      await playReveals(page)
      const demo = page.locator('#site-demo')
      const section: Section = {}
      const readDemo = async (prefix: string) => {
        // The pointer leaves the button, so its hover colours stay out of the record.
        await page.mouse.move(1, 1)
        await settled(page)
        Object.assign(section, await read(demo, { deep: true, origin: 'element', prefix }))
      }

      await applyChange(demo)
      await readDemo('applied ')
      await demo.getByRole('button', { name: 'Отменить правку' }).click()
      await expect(demo.getByText('Возвращено')).toBeVisible()
      await readDemo('undone ')
      await recordOrCompare('demo', section)
    })
  })

  // Not a part of the snapshot: headless Chromium hides scrollbars, so the widths above never see
  // one. A styled scrollbar takes its width from the page, as the classic one does on Windows.
  test.describe('with a classic scrollbar', () => {
    for (const width of [1440, 1920]) {
      test(`the fields from edge to edge and the footer keep the grid of the sections at ${width}px`, async ({
        playwright,
        baseURL,
      }) => {
        // A browser of its own: launch options cannot differ between the tests of one worker.
        const browser = await playwright.chromium.launch({
          ignoreDefaultArgs: ['--hide-scrollbars'],
        })
        try {
          const page = await browser.newPage({ baseURL })
          await openLanding(page, width)
          await page.addStyleTag({ content: '::-webkit-scrollbar { width: 15px }' })
          const edges = await page.evaluate(() => {
            const left = (selector: string) =>
              document.querySelector(selector)?.getBoundingClientRect().left
            return {
              scrollbar: window.innerWidth - document.documentElement.clientWidth,
              section: left('#can-title'),
              // The orange, the chocolate and the lead fields run from edge to edge, and so
              // does the footer: their content starts on the vertical of a plain section.
              platforms: left('#platforms-title'),
              safety: left('#safety-title'),
              footer: left('footer a'),
            }
          })
          expect(edges.scrollbar).toBe(15)
          expect(edges.section).toBeDefined()
          expect({
            platforms: edges.platforms,
            safety: edges.safety,
            footer: edges.footer,
          }).toEqual({
            platforms: edges.section,
            safety: edges.section,
            footer: edges.section,
          })
        } finally {
          await browser.close()
        }
      })
    }
  })
}
