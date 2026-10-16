import { expect, test } from '../../fixtures/signed-in.ts'

import {
  addForeignSite,
  addSite,
  CLOSED_NOTE_ID,
  CLOSED_SUFFIX,
  closedSites,
  hideDevIndicator,
} from './site.ts'

// The shell of the site page in a real browser: unit tests see the markup of both navigations,
// only a browser shows which of them the width leaves on the screen.

const sections = ['Чат', 'Обзор', 'Изменения', 'Запуски', 'База и бэкап', 'Настройки']

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
      await expect(page.getByText('Ожидает подключения')).toBeVisible()
    })

    await test.step('exactly one navigation of sections is on the screen', async () => {
      const navigations = page.getByRole('navigation', { name: 'Разделы сайта' })
      await expect(navigations).toHaveCount(1)
      const labels = await navigations.getByRole('link').allTextContents()
      expect(labels).toEqual(width < 600 ? sections.slice(0, 4) : sections)
      // «Чат» starts from a new dialog; the other sections open on themselves.
      await expect(navigations.getByRole('link', { name: 'Чат', exact: true })).toHaveAttribute(
        'href',
        `/projects/${siteId}/chat/new`,
      )
      await expect(navigations.getByRole('link', { name: 'Обзор' })).toHaveAttribute(
        'href',
        `/projects/${siteId}/overview`,
      )
      await expect(navigations.getByRole('link', { name: 'Обзор' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })

    await test.step('nothing scrolls sideways', async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })

    await test.step('the settings show the site and no accesses yet', async () => {
      if (width < 600) {
        await page.getByRole('button', { name: 'Ещё' }).click()
        await page
          .getByRole('navigation', { name: 'Ещё разделы' })
          .getByRole('link', { name: 'Настройки' })
          .click()
      } else {
        await page
          .getByRole('navigation', { name: 'Разделы сайта' })
          .getByRole('link', { name: 'Настройки' })
          .click()
      }
      await expect(page).toHaveURL(`/projects/${siteId}/settings`)
      await expect(page.getByText('Кофейня «Крошка»').first()).toBeVisible()
      await expect(page.getByText(/Доступов пока нет/)).toBeVisible()
    })

    await test.step('breadcrumbs lead back to the projects', async () => {
      await page
        .getByRole('navigation', { name: 'Хлебные крошки' })
        .getByRole('link', { name: 'Проекты' })
        .click()
      await expect(page).toHaveURL('/projects')
      await expect(
        page.getByRole('link', { name: 'Кофейня «Крошка»', exact: true }),
      ).toHaveAttribute('href', `/projects/${siteId}`)
    })
  })
}

test('the address of a connected site opens a new dialog of its chat', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addSite(signedInUser.id, 'active')
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${siteId}`)

  await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый диалог')
  await expect(page.getByRole('textbox', { name: 'Сообщение' })).toBeVisible()
  const current = page
    .getByRole('navigation', { name: 'Разделы сайта' })
    .locator('[aria-current="page"]')
  await expect(current).toHaveText('Чат')
  await expect(current).toHaveAttribute('href', `/projects/${siteId}/chat/new`)
})

// Every address under a site besides the overview: «Чат» has two of them.
const otherAddresses = ['chat', 'chat/new', 'changes', 'runs', 'database', 'settings']

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
      const phone = width < 600
      await hideDevIndicator(page)
      await page.setViewportSize({ width, height })

      await test.step('the address of the site opens the overview with the reason', async () => {
        await page.goto(`/projects/${siteId}`)
        await expect(page).toHaveURL(overview)
        const main = page.getByRole('main')
        await expect(main.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
        await expect(main.getByText(label, { exact: true })).toBeVisible()
        await expect(main.getByText(note, { exact: true })).toBeVisible()
      })

      for (const address of otherAddresses) {
        await test.step(`the address «${address}» leads to the overview`, async () => {
          await page.goto(`/projects/${siteId}/${address}`)
          await expect(page).toHaveURL(overview)
          await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()
        })
      }

      await test.step('the navigation keeps one link and shows the rest closed', async () => {
        const navigation = page.getByRole('navigation', { name: 'Разделы сайта' })
        await expect(navigation).toHaveCount(1)
        const link = navigation.locator('a')
        await expect(link).toHaveCount(1)
        await expect(link).toHaveText('Обзор')
        await expect(link).toHaveAttribute('href', overview)
        await expect(link).toHaveAttribute('aria-current', 'page')

        const closed = navigation.locator('[aria-disabled="true"]')
        const shown = phone ? sections.slice(0, 4) : sections
        // The state is part of the text of an item: a span without a role announces no other.
        expect(await closed.allTextContents()).toEqual(
          shown.filter((name) => name !== 'Обзор').map((name) => name + CLOSED_SUFFIX),
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
        const navigation = page.getByRole('navigation', { name: 'Разделы сайта' })
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
        expect(focusable).toEqual(phone ? ['Обзор', 'Ещё'] : ['Обзор'])
      })

      await test.step('nothing scrolls sideways', async () => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow).toBeLessThanOrEqual(0)
      })

      if (!phone) return
      await test.step('«Ещё» still opens: its sections are closed, the way back is not', async () => {
        await page.getByRole('button', { name: 'Ещё' }).click()
        const more = page.getByRole('navigation', { name: 'Ещё разделы' })
        await expect(more.locator('a')).toHaveCount(1)
        const closed = more.locator('[aria-disabled="true"]')
        expect(await closed.allTextContents()).toEqual(
          sections.slice(4).map((name) => name + CLOSED_SUFFIX),
        )
        for (const item of await closed.all()) {
          await expect(item).toBeVisible()
          await expect(item).not.toHaveAttribute('href')
          await expect(item).toHaveAttribute('aria-describedby', CLOSED_NOTE_ID)
          await expect(item.locator('svg')).toHaveCount(2)
          expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44)
        }
        await closed.filter({ hasText: 'Настройки' }).click({ force: true })
        await expect(page).toHaveURL(overview)
        await more.getByRole('link', { name: 'К проектам' }).click()
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
  const navigation = page.getByRole('navigation', { name: 'Разделы сайта' })
  await expect(navigation.getByRole('link')).toHaveCount(6)
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
      '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/chat',
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
