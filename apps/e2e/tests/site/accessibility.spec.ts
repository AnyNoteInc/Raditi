import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

import { baseURL } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

import { addSite, closedSites, hideDevIndicator } from './site.ts'

// What every slice of the site page owes (docs/plan/38-site-page-plan.md, assumption «л»): the
// rules of axe, the dark scheme and a pressing area of 44px. The sections that read data today
// are «Обзор» and «Настройки»; a slice that fills another section adds it to `pages`. «Чат» is
// here with both of its addresses: the root — the list, and from 900px a new dialog beside it —
// and the new dialog itself, which keeps the bottom bar of a phone.

// No motion: axe reads the colours, and a sheet that is still sliding in has not its own yet.
test.use({ reducedMotion: 'reduce' })

interface SitePage {
  /** The address under the site. */
  path: string
  heading: string
  /** The section the navigation marks as the current page. */
  current: string
  /** The section opens from «Ещё» on a phone. */
  inMore: boolean
  /** The content is checked for the pressing area too, not the navigation alone. */
  ownTargets?: true
}

const pages: readonly SitePage[] = [
  { path: 'overview', heading: 'Обзор', current: 'Обзор', inMore: false },
  { path: 'settings', heading: 'Настройки', current: 'Настройки', inMore: true },
  { path: 'chat', heading: 'Чат', current: 'Чат', inMore: false, ownTargets: true },
  {
    path: 'chat/new',
    heading: 'Новый диалог',
    current: 'Чат',
    inMore: false,
    ownTargets: true,
  },
]

const violations = async (page: Page) => {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return report.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  )
}

/** The relative luminance of the page's background, 0 for black and 1 for white. */
const backgroundLuminance = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2d context')
    // The canvas resolves whatever notation the theme's variable holds.
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  })

/** The items of the navigation a site keeps closed: they hold their place and their size. */
const CLOSED = '[aria-disabled="true"]'

/** Heights of the visible links and buttons inside `scope` that are lower than 44px. */
async function lowTargets(scope: Locator, selector = 'a, button'): Promise<string[]> {
  const low: string[] = []
  const targets = scope.locator(selector)
  // The bottom bar keeps «Ещё» as a button; the rail has links only.
  // Not the first in the markup: a «list — content» section keeps the hidden half in it.
  await expect(targets.filter({ visible: true }).first()).toBeVisible()
  for (const target of await targets.all()) {
    if (!(await target.isVisible())) continue
    const box = await target.boundingBox()
    // A button of one icon has no text, only a name.
    const label =
      (await target.innerText()).trim() || ((await target.getAttribute('aria-label')) ?? '')
    if (!box) low.push(`${label}: no box`)
    else if (box.height < 44) low.push(`${label}: ${box.height}px`)
  }
  return low
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    test(`the ${scheme} scheme at ${width}px: axe, the current section and the pressing area`, async ({
      page,
      context,
      signedInUser,
    }) => {
      const siteId = await addSite(signedInUser.id)
      // The `theme` cookie is the only source of the colour mode (packages/ui/src/theme):
      // the server reads it in the root layout and renders a single-scheme theme.
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await hideDevIndicator(page)
      await page.setViewportSize({ width, height })
      const phone = width < 600

      for (const { path, heading, current: section, inMore, ownTargets } of pages) {
        await test.step(`«${heading}»`, async () => {
          await page.goto(`/projects/${siteId}/${path}`)
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

          const luminance = await backgroundLuminance(page)
          if (scheme === 'dark') expect(luminance).toBeLessThan(0.2)
          else expect(luminance).toBeGreaterThan(0.8)

          expect(await violations(page)).toEqual([])

          const navigation = page.getByRole('navigation', { name: 'Разделы сайта' })
          // The rail or the bottom bar, never both and never neither: a new dialog keeps the bar.
          await expect(navigation).toHaveCount(1)
          if (phone && inMore) {
            // The section lives in the sheet: the bar marks nothing as the current page.
            await expect(navigation.locator('[aria-current]')).toHaveCount(0)
          } else {
            const current = navigation.locator('[aria-current="page"]')
            await expect(current).toHaveCount(1)
            await expect(current).toHaveText(section)
          }

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          expect(overflow).toBeLessThanOrEqual(0)

          expect(await lowTargets(navigation)).toEqual([])
          if (ownTargets) expect(await lowTargets(page.getByRole('main'))).toEqual([])
          const projects = page
            .getByRole('navigation', { name: 'Хлебные крошки' })
            .getByRole('link', { name: 'Проекты' })
          await expect(projects).toBeVisible()
          expect((await projects.boundingBox())?.height).toBeGreaterThanOrEqual(44)

          if (!phone) return
          await page.getByRole('button', { name: 'Ещё' }).click()
          const more = page.getByRole('navigation', { name: 'Ещё разделы' })
          await expect(more.getByRole('link', { name: 'Настройки' })).toBeVisible()
          const currentInMore = more.locator('[aria-current="page"]')
          if (inMore) await expect(currentInMore).toHaveText(section)
          else await expect(currentInMore).toHaveCount(0)
          expect(await lowTargets(more)).toEqual([])
          expect(await violations(page)).toEqual([])
        })
      }
    })
  }
}

// A site that keeps «Обзор» alone (paused, disconnected, archived): the closed items of the
// navigation are not links, so the rules of axe and the pressing area are checked for them too.
for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1280, 900],
  ] as const) {
    test(`the ${scheme} scheme at ${width}px: a site with closed sections`, async ({
      page,
      context,
      signedInUser,
    }) => {
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await hideDevIndicator(page)
      await page.setViewportSize({ width, height })
      const phone = width < 600

      for (const [status, , note] of closedSites) {
        await test.step(`a ${status} site`, async () => {
          const siteId = await addSite(signedInUser.id, status)
          await page.goto(`/projects/${siteId}/overview`)
          await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
          await expect(page.getByRole('main').getByText(note, { exact: true })).toBeVisible()

          const luminance = await backgroundLuminance(page)
          if (scheme === 'dark') expect(luminance).toBeLessThan(0.2)
          else expect(luminance).toBeGreaterThan(0.8)

          expect(await violations(page)).toEqual([])

          const navigation = page.getByRole('navigation', { name: 'Разделы сайта' })
          await expect(navigation).toHaveCount(1)
          const current = navigation.locator('[aria-current="page"]')
          await expect(current).toHaveCount(1)
          await expect(current).toHaveText('Обзор')
          await expect(navigation.locator(CLOSED)).toHaveCount(phone ? 3 : 5)

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          expect(overflow).toBeLessThanOrEqual(0)

          expect(await lowTargets(navigation)).toEqual([])
          expect(await lowTargets(navigation, CLOSED)).toEqual([])

          if (!phone) return
          await page.getByRole('button', { name: 'Ещё' }).click()
          const more = page.getByRole('navigation', { name: 'Ещё разделы' })
          await expect(more.getByRole('link', { name: 'К проектам' })).toBeVisible()
          await expect(more.locator(CLOSED)).toHaveCount(2)
          await expect(more.locator('[aria-current]')).toHaveCount(0)
          expect(await lowTargets(more)).toEqual([])
          expect(await lowTargets(more, CLOSED)).toEqual([])
          expect(await violations(page)).toEqual([])
        })
      }
    })
  }
}
