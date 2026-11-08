import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

import { baseURL } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

import {
  acceptUploads,
  addBrowserTask,
  addLongChat,
  addSite,
  closedSites,
  hideDevIndicator,
} from './site.ts'

// What every slice of the site page owes (docs/plan/38-site-page-plan.md, assumption «л»): the
// rules of axe, the dark scheme and a pressing area of 44px. The sections that read data today
// are «Обзор» and «Настройки»; a slice that fills another section adds it to `pages`. Below 900px
// the sections are the drawer the bar opens (docs/plan/64-cabinet-navigation.md, Н7).

// No motion: axe reads the colours, and a sheet that is still sliding in has not its own yet.
test.use({ reducedMotion: 'reduce' })

interface SitePage {
  /** The address under the site. */
  path: string
  heading: string
  /** The section the navigation marks as the current page. */
  current: string
  /** The content is checked for the pressing area too, not the navigation alone. */
  ownTargets?: true
}

const pages: readonly SitePage[] = [
  { path: 'overview', heading: 'Обзор', current: 'Обзор' },
  { path: 'settings', heading: 'Настройки', current: 'Настройки' },
  { path: 'changes', heading: 'Изменения', current: 'Изменения' },
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

/** A menu that came up: while it grows in, axe reads the colours through its opacity. */
const menuSettled = (menu: Locator) =>
  expect
    .poll(() => menu.evaluate((list) => getComputedStyle(list.parentElement!).opacity))
    .toBe('1')

/** A menu that closed: it leaves the roles at once and the page only after it faded out. */
const menuGone = (page: Page) =>
  expect(page.locator('.MuiPopover-root, .MuiDrawer-root')).toHaveCount(0)

/**
 * The sections on the screen (docs/plan/64-cabinet-navigation.md, Н7): the panel from `md`, below
 * it the drawer that the button of the bar opens.
 */
async function sectionsOnScreen(page: Page, phone: boolean): Promise<Locator> {
  if (!phone) {
    return page
      .getByRole('complementary', { name: 'Разделы сайта' })
      .getByRole('navigation', { name: 'Разделы сайта' })
  }
  await page.getByRole('button', { name: /^Разделы сайта: / }).click()
  const drawer = page.getByRole('dialog', { name: 'Разделы сайта' })
  await expect(drawer).toBeVisible()
  return drawer.getByRole('navigation', { name: 'Разделы сайта' })
}

/** The items of the navigation a site keeps closed: they hold their place and their size. */
const CLOSED = '[aria-disabled="true"]'

/** Heights of the visible links and buttons inside `scope` that are lower than 44px. */
async function lowTargets(scope: Locator, selector = 'a, button'): Promise<string[]> {
  const low: string[] = []
  const targets = scope.locator(selector)
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

      for (const { path, heading, current: section, ownTargets } of pages) {
        await test.step(`«${heading}»`, async () => {
          await page.goto(`/projects/${siteId}/${path}`)
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

          const luminance = await backgroundLuminance(page)
          if (scheme === 'dark') expect(luminance).toBeLessThan(0.2)
          else expect(luminance).toBeGreaterThan(0.8)

          expect(await violations(page)).toEqual([])

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          expect(overflow).toBeLessThanOrEqual(0)
          if (ownTargets) expect(await lowTargets(page.getByRole('main'))).toEqual([])

          if (!phone) {
            const projects = page
              .getByRole('navigation', { name: 'Хлебные крошки' })
              .getByRole('link', { name: 'Проекты' })
            await expect(projects).toBeVisible()
            expect((await projects.boundingBox())?.height).toBeGreaterThanOrEqual(44)
          }

          const navigation = await sectionsOnScreen(page, phone)
          const current = navigation.locator('[aria-current="page"]')
          await expect(current).toHaveCount(1)
          await expect(current).toHaveText(section)
          expect(await lowTargets(navigation)).toEqual([])
          if (!phone) return
          expect(await violations(page)).toEqual([])
          await page.keyboard.press('Escape')
          await menuGone(page)
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
      const narrow = width < 900

      for (const [status, label, note] of closedSites) {
        await test.step(`a ${status} site`, async () => {
          const siteId = await addSite(signedInUser.id, status)
          await page.goto(`/projects/${siteId}/overview`)
          await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
          // By the keyboard: axe scrolls the page, and that would take the button from under a
          // pointer and fade the tooltip out while its contrast is read.
          await page.keyboard.press('Tab')
          const connection = page
            .getByRole('main')
            .getByRole('button', { name: `Подключение: ${label}` })
          await connection.focus()
          await expect(page.getByRole('tooltip').getByText(note, { exact: true })).toBeVisible()
          await expect(page.locator('.MuiTooltip-tooltip')).toHaveCSS('opacity', '1')

          const luminance = await backgroundLuminance(page)
          if (scheme === 'dark') expect(luminance).toBeLessThan(0.2)
          else expect(luminance).toBeGreaterThan(0.8)

          expect(await violations(page)).toEqual([])
          await connection.blur()
          await expect(page.getByRole('tooltip')).toHaveCount(0)

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          expect(overflow).toBeLessThanOrEqual(0)

          const navigation = await sectionsOnScreen(page, narrow)
          const current = navigation.locator('[aria-current="page"]')
          await expect(current).toHaveCount(1)
          await expect(current).toHaveText('Обзор')
          // Every section but «Обзор»: «Переменные» is one of them since 26.10.2026.
          await expect(navigation.locator(CLOSED)).toHaveCount(5)
          expect(await lowTargets(navigation)).toEqual([])
          expect(await lowTargets(navigation, CLOSED)).toEqual([])
          if (!narrow) return
          expect(await violations(page)).toEqual([])
          await page.keyboard.press('Escape')
          await menuGone(page)
        })
      }
    })
  }
}

// «Чаты»: the rail of the cabinet, the list and a new chat, in a browser on both schemes.
for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    test(`the ${scheme} scheme at ${width}px: «Чаты»`, async ({ page, context, signedInUser }) => {
      void signedInUser
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await hideDevIndicator(page)
      await page.setViewportSize({ width, height })
      for (const [path, heading] of [
        ['/chats', 'Чаты'],
        ['/chats/new', 'Новый чат'],
      ] as const) {
        await test.step(heading, async () => {
          await page.goto(path)
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
          const luminance = await backgroundLuminance(page)
          if (scheme === 'dark') expect(luminance).toBeLessThan(0.2)
          else expect(luminance).toBeGreaterThan(0.8)
          expect(await violations(page)).toEqual([])
          expect(await lowTargets(page.getByRole('main'))).toEqual([])
        })
      }
    })
  }
}

// The same rules on what a user with chats sees: rows with their project, folders open and closed,
// the menu of the way the list is shown, the choice of a project and its locked pill.
for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    test(`the ${scheme} scheme at ${width}px: the chats of a user`, async ({
      page,
      context,
      signedInUser,
    }) => {
      test.slow()
      // A chat of a project that waits for the client, and one without a project.
      const asked = await addBrowserTask(signedInUser.id)
      await addLongChat(signedInUser.id, 1)
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await hideDevIndicator(page)
      await acceptUploads(page)
      await page.setViewportSize({ width, height })
      const list = page.getByRole('navigation', { name: 'Чаты' })
      const expectClean = async () => {
        expect(await violations(page)).toEqual([])
        expect(await lowTargets(list)).toEqual([])
      }

      await test.step('one list, the rows with their project', async () => {
        await page.goto('/chats')
        await expect(list.getByRole('link', { name: new RegExp(asked.title) })).toContainText(
          '· Кофейня «Крошка»',
        )
        await expectClean()
      })

      await test.step('the menu of the way the list is shown', async () => {
        await page.getByRole('button', { name: 'Группировка чатов' }).click()
        const menu = page.getByRole('menu', { name: 'Показывать чаты' })
        await expect(menu).toBeVisible()
        await menuSettled(menu)
        expect(await violations(page)).toEqual([])
        await menu.getByRole('menuitemradio', { name: 'По проектам' }).click()
        await menuGone(page)
      })

      await test.step('the folders: a closed one that says a chat waits, then an open one', async () => {
        const closed = list.getByRole('button', { name: /Есть чаты, которые ждут вас/ })
        await expect(closed).toHaveAttribute('aria-expanded', 'false')
        await expectClean()
        await closed.click()
        await expect(list.getByRole('link', { name: new RegExp(asked.title) })).toBeVisible()
        await expectClean()
      })

      await test.step('the choice of a project, a menu or a sheet', async () => {
        await page.goto('/chats/new')
        const pill = page.getByRole('button', { name: /^Проект для этого чата/ })
        await pill.click()
        const add = page.getByRole('menuitem', { name: 'Добавить проект' })
        await expect(add).toBeVisible()
        await menuSettled(add.locator('xpath=ancestor::ul[1]'))
        expect(await violations(page)).toEqual([])
        await page.keyboard.press('Escape')
        await menuGone(page)
      })

      await test.step('the pill locked by a file', async () => {
        await page.getByTestId('composer-files').setInputFiles({
          name: 'Меню.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 меню'),
        })
        await expect(page.getByRole('list', { name: 'Файлы к сообщению' })).toContainText(
          'Меню.pdf',
        )
        await expect(
          page.getByRole('button', { name: 'Без проекта', exact: true }),
        ).toHaveAttribute('aria-disabled', 'true')
        expect(await violations(page)).toEqual([])
      })
    })
  }
}
