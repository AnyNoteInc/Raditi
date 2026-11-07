import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import {
  addConnectedSite,
  addForeignSite,
  addImportedSite,
  addSite,
  CLOSED_NOTE_ID,
  CLOSED_SUFFIX,
  closedSites,
  hideDevIndicator,
} from './site.ts'

// The shell of the site page in a real browser (docs/plan/64-cabinet-navigation.md): from `md` the
// sections are the panel beside the rail, below it they open from a button of the bar. Unit tests
// see the markup of both, only a browser shows which of them the width leaves on the screen.

// «Переменные» is a section of its own since 26.10.2026 (the variables and the accesses); «База»
// is named so since 07.11.2026.
const sections = ['Обзор', 'Изменения', 'Запуски', 'База', 'Переменные', 'Настройки']

/** The panel beside the rail is drawn from this width (`md`). */
const PANEL_FROM = 900

/** The sections on the screen: the panel from `md`, below it the drawer the bar opens. */
async function sectionsOnScreen(page: Page, width: number): Promise<Locator> {
  if (width >= PANEL_FROM) {
    await expect(page.getByRole('button', { name: /^Разделы сайта: / })).toBeHidden()
    return page
      .getByRole('complementary', { name: 'Разделы сайта' })
      .getByRole('navigation', { name: 'Разделы сайта' })
  }
  await expect(page.getByRole('complementary', { name: 'Разделы сайта' })).toBeHidden()
  await page.getByRole('button', { name: /^Разделы сайта: / }).click()
  return page
    .getByRole('dialog', { name: 'Разделы сайта' })
    .getByRole('navigation', { name: 'Разделы сайта' })
}

for (const [name, width, height] of [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1280, 900],
] as const) {
  test(`the shell of a site on a ${name}`, async ({ page, signedInUser }) => {
    const siteId = await addSite(signedInUser.id)
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto(`/projects/${siteId}`)

    await test.step('a site that is not connected opens on the overview', async () => {
      await expect(page).toHaveURL(`/projects/${siteId}/overview`)
      await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
      const connection = page.getByRole('button', { name: 'Подключение: Ожидает подключения' })
      await expect(connection).toBeVisible()
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      // The keyboard reaches the tooltip as a pointer does.
      await page.keyboard.press('Tab')
      await connection.focus()
      await expect(page.getByRole('tooltip')).toContainText('Ожидает подключения')
      await connection.blur()
    })

    await test.step('one navigation of sections is on the screen', async () => {
      const navigation = await sectionsOnScreen(page, width)
      await expect(navigation).toHaveCount(1)
      expect(await navigation.getByRole('link').allTextContents()).toEqual(sections)
      await expect(navigation.getByRole('link', { name: 'Обзор' })).toHaveAttribute(
        'href',
        `/projects/${siteId}/overview`,
      )
      await expect(navigation.getByRole('link', { name: 'Обзор' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      if (width < PANEL_FROM) await page.keyboard.press('Escape')
    })

    await test.step('nothing scrolls sideways', async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })

    await test.step('the settings show the site; «Переменные → Доступы», no accesses yet', async () => {
      const navigation = await sectionsOnScreen(page, width)
      await navigation.getByRole('link', { name: 'Настройки' }).click()
      await expect(page).toHaveURL(`/projects/${siteId}/settings`)
      await expect(page.getByRole('heading', { level: 1, name: 'Настройки' })).toBeVisible()
      // The third layer is the tabs of the section (Н5): the first is open at its root.
      const tabs = page.getByRole('navigation', { name: 'Настройки', exact: true })
      await expect(tabs.getByRole('link', { name: 'Сайт' })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('main').getByText('Кофейня «Крошка»').first()).toBeVisible()
      // The accesses are a tab of «Переменные» since 26.10.2026, not of the settings.
      await page.goto(`/projects/${siteId}/vault/accesses`)
      await expect(page.getByRole('heading', { level: 1, name: 'Переменные' })).toBeVisible()
      await expect(
        page.getByRole('navigation', { name: 'Переменные' }).getByRole('link', { name: 'Доступы' }),
      ).toHaveAttribute('aria-current', 'page')
      await expect(page.getByText(/^Доступов пока нет\. Они появятся/)).toBeVisible()
    })

    await test.step('the way back leads to the projects', async () => {
      if (width >= PANEL_FROM) {
        await page
          .getByRole('navigation', { name: 'Хлебные крошки' })
          .getByRole('link', { name: 'Проекты' })
          .click()
      } else {
        await page.getByRole('button', { name: /^Разделы сайта: / }).click()
        await page
          .getByRole('dialog', { name: 'Разделы сайта' })
          .getByRole('link', { name: 'Все проекты' })
          .click()
      }
      await expect(page).toHaveURL('/projects')
      await expect(
        page.getByRole('link', { name: 'Кофейня «Крошка»', exact: true }),
      ).toHaveAttribute('href', `/projects/${siteId}`)
    })
  })
}

test('the address of a connected site opens its overview: a project has no chat', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addSite(signedInUser.id, 'active')
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${siteId}`)

  await expect(page).toHaveURL(`/projects/${siteId}/overview`)
  await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
  const navigation = await sectionsOnScreen(page, 1280)
  await expect(navigation.locator('[aria-current="page"]')).toHaveText('Обзор')
  await expect(navigation.getByRole('link', { name: /^Чат/ })).toHaveCount(0)
})

// «Новый чат» under the heading follows the chat the server takes of the project (`project.get`),
// not a second rule of the page. This stand has no browser of the platform.
test('the overview offers a new chat of the project only when the server takes one', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const main = page.getByRole('main')

  await test.step('a connected site: a new chat of this project', async () => {
    const siteId = await addConnectedSite(signedInUser.id)
    await page.goto(`/projects/${siteId}/overview`)
    await expect(main.getByRole('link', { name: 'Новый чат' })).toHaveAttribute(
      'href',
      `/chats/new?project=${siteId}`,
    )
  })

  await test.step('an imported site without the browser: no chat, the files wait', async () => {
    const siteId = await addImportedSite(signedInUser.id)
    await page.goto(`/projects/${siteId}/overview`)
    await expect(main.getByText('Первоначальная версия сайта сохранена')).toBeVisible()
    await expect(main.getByRole('link', { name: 'Новый чат' })).toHaveCount(0)
    await main.getByRole('button', { name: 'Подключение: Ожидает подключения' }).hover()
    await expect(page.getByRole('tooltip')).toContainText(
      'Файлы сайта сохранены, но агент пока не может менять сайт',
    )
    await expect(page.getByRole('tooltip')).not.toContainText(/админк|сразу|без выпуска/)
  })
})

// Every address under a site besides the overview.
const otherAddresses = ['changes', 'runs', 'database', 'vault', 'settings']

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('a tap on the dot of the connection opens its tooltip', async ({ page, signedInUser }) => {
    const siteId = await addSite(signedInUser.id, 'paused')
    await hideDevIndicator(page)
    await page.goto(`/projects/${siteId}/overview`)
    await page.getByRole('button', { name: 'Подключение: На паузе' }).tap()
    await expect(page.getByRole('tooltip')).toContainText('остальные разделы сайта недоступны')
  })
})

// A paused, a disconnected and an archived site keep «Обзор» alone: the address of the site and
// every other section lead to it, and the navigation shows the other sections closed.
for (const [status, label, note] of closedSites) {
  for (const [name, width, height] of [
    ['phone', 390, 844],
    ['tablet', 768, 1024],
    ['desktop', 1280, 900],
  ] as const) {
    test(`a ${status} site keeps only the overview on a ${name}`, async ({
      page,
      signedInUser,
    }) => {
      const siteId = await addSite(signedInUser.id, status)
      const overview = `/projects/${siteId}/overview`
      const narrow = width < PANEL_FROM
      await hideDevIndicator(page)
      await page.setViewportSize({ width, height })

      await test.step('the address of the site opens the overview with the reason', async () => {
        await page.goto(`/projects/${siteId}`)
        await expect(page).toHaveURL(overview)
        const main = page.getByRole('main')
        await expect(main.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
        await main.getByRole('button', { name: `Подключение: ${label}` }).hover()
        await expect(page.getByRole('tooltip').getByText(note, { exact: true })).toBeVisible()
      })

      for (const address of otherAddresses) {
        await test.step(`the address «${address}» leads to the overview`, async () => {
          await page.goto(`/projects/${siteId}/${address}`)
          await expect(page).toHaveURL(overview)
          await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
        })
      }

      await test.step('the navigation keeps one link and shows the rest closed', async () => {
        const navigation = await sectionsOnScreen(page, width)
        await expect(navigation).toHaveCount(1)
        const link = navigation.locator('a')
        await expect(link).toHaveCount(1)
        await expect(link).toHaveText('Обзор')
        await expect(link).toHaveAttribute('href', overview)
        await expect(link).toHaveAttribute('aria-current', 'page')

        const closed = navigation.locator('[aria-disabled="true"]')
        // The state is part of the text of an item: a span without a role announces no other.
        expect(await closed.allTextContents()).toEqual(
          sections.filter((name) => name !== 'Обзор').map((name) => name + CLOSED_SUFFIX),
        )
        for (const item of await closed.all()) {
          await expect(item).toBeVisible()
          await expect(item).not.toHaveAttribute('href')
          await expect(item).not.toHaveAttribute('tabindex')
          await expect(item).toHaveAttribute('aria-describedby', CLOSED_NOTE_ID)
          // The lock beside the icon of the section: the colour alone says nothing.
          await expect(item.locator('svg')).toHaveCount(2)
          expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44)
        }
        await expect(page.locator(`#${CLOSED_NOTE_ID}`)).toHaveText(note)
        await expect(page.locator(`#${CLOSED_NOTE_ID}`)).toBeHidden()
      })

      await test.step('a closed section cannot be followed', async () => {
        const navigation = narrow
          ? page.getByRole('dialog', { name: 'Разделы сайта' }).getByRole('navigation')
          : page
              .getByRole('complementary', { name: 'Разделы сайта' })
              .getByRole('navigation', { name: 'Разделы сайта' })
        // Forced: Playwright waits for an item marked `aria-disabled` to become enabled.
        await navigation
          .locator('[aria-disabled="true"]')
          .filter({ hasText: 'Изменения' })
          .click({ force: true })
        await expect(page).toHaveURL(overview)
        // The keyboard reaches the one link of the sections and nothing else in them.
        const focusable = await navigation.evaluate((node) =>
          Array.from(node.querySelectorAll<HTMLElement>('*'))
            .filter((element) => element.tabIndex >= 0)
            .map((element) => element.textContent),
        )
        expect(focusable).toEqual(['Обзор'])
        if (narrow) await page.keyboard.press('Escape')
      })

      await test.step('nothing scrolls sideways', async () => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow).toBeLessThanOrEqual(0)
      })

      if (!narrow) return
      await test.step('the drawer keeps the way back to the projects', async () => {
        await page.getByRole('button', { name: /^Разделы сайта: / }).click()
        await page
          .getByRole('dialog', { name: 'Разделы сайта' })
          .getByRole('link', { name: 'Все проекты' })
          .click()
        await expect(page).toHaveURL('/projects')
      })
    })
  }
}

test('every section of a site that is not connected yet still opens', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  for (const address of ['overview', ...otherAddresses]) {
    await page.goto(`/projects/${siteId}/${address}`)
    await expect(page).toHaveURL(`/projects/${siteId}/${address}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }
  const navigation = await sectionsOnScreen(page, 1280)
  await expect(navigation.getByRole('link')).toHaveCount(sections.length)
  await expect(navigation.locator('[aria-disabled="true"]')).toHaveCount(0)
  await expect(page.locator(`#${CLOSED_NOTE_ID}`)).toHaveCount(0)
})

test('a site of someone else and a made-up address answer «not found» alike', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  const foreign = await addForeignSite()
  try {
    for (const path of [
      `/projects/${foreign.siteId}`,
      `/projects/${foreign.siteId}/settings`,
      '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/changes',
      '/projects/not-an-id/settings',
    ]) {
      await page.goto(path)
      await expect(
        page.getByRole('heading', { level: 1, name: 'Такого проекта нет' }),
      ).toBeVisible()
      await expect(page.getByText('Кофейня «Крошка»')).toHaveCount(0)
    }
  } finally {
    await foreign.remove()
  }
})

// The panel beside the rail hides and comes back with its button and with «]» (Н3), and the
// choice holds on the next page; a «]» typed into a field stays in the field.
test('the panel of a site hides with its button and with «]», and its edge is dragged', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addSite(signedInUser.id, 'active')
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${siteId}/overview`)
  const panel = page.getByRole('complementary', { name: 'Разделы сайта' })
  await expect(panel).toBeVisible()

  await panel.getByRole('button', { name: 'Скрыть панель' }).click()
  await expect(panel).toBeHidden()
  const show = page.getByRole('button', { name: 'Показать панель' })
  await expect(show).toHaveAttribute('aria-keyshortcuts', ']')
  await page.goto(`/projects/${siteId}/settings`)
  await expect(panel).toBeHidden()

  await page.keyboard.press(']')
  await expect(panel).toBeVisible()
  await page.keyboard.press(']')
  await expect(panel).toBeHidden()
  await show.click()
  await expect(panel).toBeVisible()

  // Its right edge is dragged (owner's answer of 07.11.2026): the width holds after a reload.
  const before = (await panel.boundingBox())!
  expect(before.width).toBe(284)
  const edge = panel.getByRole('separator', { name: 'Ширина левой панели' })
  const grip = (await edge.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + 360, grip.y + grip.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(360)
  await page.reload()
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(360)
  // The content starts past the wider panel.
  const main = (await page.getByRole('main').boundingBox())!
  expect(main.x).toBeGreaterThanOrEqual(before.x + 360)

  // The rail of the cabinet stays whatever the panel does.
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible()
})

test('«Изменения» are the versions of a site, with no tab «Файлы»', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  for (const address of ['terminal', 'changes/versions']) {
    await page.goto(`/projects/${siteId}/${address}`)
    await expect(page).toHaveURL(`/projects/${siteId}/changes`)
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Изменения' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Изменения' })).toHaveCount(0)
  await expect(page.getByText('Версий пока нет.', { exact: false })).toBeVisible()
})
