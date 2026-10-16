import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import { addForeignSite, addSite, hideDevIndicator } from './site.ts'

// «Чат» in a real browser (docs/plan/38-site-page-plan.md, M12.5): the «list — content» frame
// and the screen a dialog starts from. Which of the list and the content a width leaves on the
// screen is decided by styles, so only a browser sees it. The site of the run is not connected:
// the pages are opened by address, as a saved link would open them, or by the link «Чат» of the
// sections, which leads to a new dialog.

const viewports = [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1280, 900],
] as const

const EMPTY_LIST =
  'Диалогов пока нет — они появятся здесь, когда мы начнём принимать задания из кабинета.'
const SEND_OFF = 'Задания из кабинета мы пока не принимаем — этот раздел ещё в работе.'
const CHAT_OFF = 'Режим «Чат» появится позже.'

const dialogs = (page: Page) => page.getByRole('navigation', { name: 'Диалоги' })
const sections = (page: Page) => page.getByRole('navigation', { name: 'Разделы сайта' })
const rail = (page: Page) => page.getByRole('complementary', { name: 'Боковая панель сайта' })
const back = (page: Page) => page.getByRole('link', { name: 'Назад к диалогам' })
const newDialog = (page: Page) => dialogs(page).getByRole('link', { name: 'Новый диалог' })
const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const send = (page: Page) => page.getByRole('button', { name: 'Отправить' })
const newDialogHeading = (page: Page) => page.getByRole('heading', { name: 'Новый диалог' })

async function box(target: Locator) {
  const found = await target.boundingBox()
  if (!found) throw new Error('The element has no box: it is not on the screen')
  return found
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

/** One navigation of sections is on the screen, and its «Чат» — the link to a new dialog — is the current page. */
async function expectChatCurrent(page: Page, siteId: string) {
  await expect(sections(page)).toHaveCount(1)
  const current = sections(page).locator('[aria-current="page"]')
  await expect(current).toHaveCount(1)
  await expect(current).toHaveText('Чат')
  await expect(current).toHaveAttribute('href', `/projects/${siteId}/chat/new`)
}

/** Two boxes share no point of the screen. */
function apart(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return (
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  )
}

/** The phone keeps the bottom bar under a new dialog, and the whole screen of it stands above the bar. */
async function expectDialogAboveBar(page: Page, siteId: string, height: number) {
  await expectChatCurrent(page, siteId)
  await expect(page.getByRole('button', { name: 'Ещё' })).toBeVisible()
  const barBox = await box(sections(page))
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(height)
  for (const part of [
    newDialogHeading(page),
    message(page),
    page.getByRole('radiogroup', { name: 'Режим диалога' }),
    send(page),
    page.getByText(SEND_OFF),
    page.getByText('ИИ может допускать ошибки. Проверяйте важное.'),
  ]) {
    const partBox = await box(part)
    expect(apart(partBox, barBox)).toBe(true)
    expect(partBox.y).toBeGreaterThanOrEqual(0)
    expect(partBox.y + partBox.height).toBeLessThanOrEqual(barBox.y)
  }
}

for (const [name, width, height] of viewports) {
  test(`the root of «Чат» on a ${name}`, async ({ page, signedInUser }) => {
    const siteId = await addSite(signedInUser.id)
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto(`/projects/${siteId}/chat`)

    await expect(page).toHaveURL(`/projects/${siteId}/chat`)
    await expect(page).toHaveTitle(/Чат/)
    await expect(dialogs(page)).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чат')
    await expect(dialogs(page).getByText(EMPTY_LIST)).toBeVisible()
    await expect(newDialog(page)).toHaveAttribute('href', `/projects/${siteId}/chat/new`)
    await expect(newDialog(page)).not.toHaveAttribute('aria-current')
    await expect(back(page)).toHaveCount(0)
    await expectChatCurrent(page, siteId)
    await expectNoSidewaysScroll(page)

    if (width >= 900) {
      await test.step('a new dialog is ready beside the list', async () => {
        await expect(message(page)).toBeVisible()
        await expect(send(page)).toBeVisible()
        await expect(send(page)).toBeDisabled()
        await expect(page.getByText(SEND_OFF)).toBeVisible()
        // The heading of the page is the list's: the screen beside it takes the level below.
        await expect(newDialogHeading(page)).toHaveCount(1)
        await expect(page.getByRole('heading', { level: 2, name: 'Новый диалог' })).toBeVisible()
      })

      await test.step('the list stands between the rail and the content', async () => {
        const railBox = await box(rail(page))
        const listBox = await box(dialogs(page))
        const toolbarBox = await box(page.getByRole('banner', { name: 'Панель сайта' }))
        const railEnd = railBox.x + railBox.width
        const listEnd = listBox.x + listBox.width
        expect(listBox.x).toBeGreaterThanOrEqual(railEnd)
        expect(toolbarBox.x).toBeGreaterThanOrEqual(listEnd)
        for (const part of [newDialogHeading(page), message(page), send(page)]) {
          const partBox = await box(part)
          expect(partBox.x).toBeGreaterThanOrEqual(listEnd)
          expect(partBox.x + partBox.width).toBeLessThanOrEqual(width)
          expect(partBox.y + partBox.height).toBeLessThanOrEqual(height)
        }
        // The column runs the full height of the window beside the rail.
        expect(listBox.y).toBe(0)
        expect(listBox.height).toBe(height)
      })
      return
    }

    await test.step('below the wide layout the root is the list alone', async () => {
      // The new dialog is in the markup and off the screen: nothing of it is shown or read out.
      await expect(message(page)).toBeHidden()
      await expect(send(page)).toBeHidden()
      await expect(newDialogHeading(page)).toHaveCount(0)
      await expect(page.getByText(SEND_OFF)).toBeHidden()
      // The list is the page: it starts under the toolbar, not beside it.
      const toolbarBox = await box(page.getByRole('banner', { name: 'Панель сайта' }))
      const listBox = await box(dialogs(page))
      expect(listBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height)
    })

    if (width >= 600) {
      await test.step('the rail is the navigation of sections', async () => {
        await expect(rail(page)).toBeVisible()
        await expect(rail(page).getByRole('navigation', { name: 'Разделы сайта' })).toBeVisible()
      })
      return
    }

    await test.step('«Новый диалог» stays above the bottom bar', async () => {
      await expect(rail(page)).toBeHidden()
      const actionBox = await box(newDialog(page))
      const barBox = await box(sections(page))
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(barBox.y)
      expect(actionBox.y).toBeGreaterThanOrEqual(0)
      expect(actionBox.height).toBeGreaterThanOrEqual(44)
    })
  })

  test(`a new dialog on a ${name}`, async ({ page, signedInUser }) => {
    const siteId = await addSite(signedInUser.id)
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto(`/projects/${siteId}/chat/new`)

    await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
    await expect(page).toHaveTitle(/Новый диалог/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый диалог')
    await expectNoSidewaysScroll(page)

    if (width < 600) {
      // Before anything is typed: the screen as the bar opens it.
      await test.step('the phone keeps the bottom bar under the new dialog', async () => {
        await expect(rail(page)).toBeHidden()
        await expectDialogAboveBar(page, siteId, height)
      })
    }

    await test.step('the screen sends nothing and says why', async () => {
      await expect(message(page)).toBeVisible()
      await expect(send(page)).toBeVisible()
      await expect(send(page)).toBeDisabled()
      await message(page).fill('Поменяйте телефон в шапке сайта')
      await expect(message(page)).toHaveValue('Поменяйте телефон в шапке сайта')
      await expect(send(page)).toBeDisabled()
      // Enter in the field is a new line, never a request.
      await message(page).press('Enter')
      await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
      await expect(send(page)).toBeDisabled()
      await expect(send(page)).toHaveAccessibleDescription(SEND_OFF)
      // The field says it too: a screen reader lands on it first.
      await expect(message(page)).toHaveAccessibleDescription(SEND_OFF)

      const modes = page.getByRole('radiogroup', { name: 'Режим диалога' })
      await expect(modes.getByRole('radio')).toHaveCount(2)
      await expect(modes.getByRole('radio', { name: 'Работа' })).toBeChecked()
      await expect(modes.getByRole('radio', { name: 'Работа' })).toBeEnabled()
      await expect(modes.getByRole('radio', { name: 'Чат' })).toBeDisabled()
      await expect(modes.getByRole('radio', { name: 'Чат' })).not.toBeChecked()
      await expect(modes.getByRole('radio', { name: 'Чат' })).toHaveAccessibleDescription(CHAT_OFF)
      // The words of the switch are what a finger presses.
      for (const word of await modes.locator('label').all())
        expect((await box(word)).height).toBeGreaterThanOrEqual(44)
      const sendBox = await box(send(page))
      expect(Math.min(sendBox.width, sendBox.height)).toBeGreaterThanOrEqual(44)

      await expect(page.getByText(SEND_OFF)).toBeVisible()
      await expect(page.getByText(CHAT_OFF)).toBeVisible()
      await expect(page.getByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeVisible()
    })

    if (width >= 900) {
      await test.step('the list stays beside the new dialog', async () => {
        await expect(dialogs(page)).toBeVisible()
        await expect(dialogs(page).getByRole('heading', { level: 2, name: 'Чат' })).toBeVisible()
        await expect(newDialog(page)).toHaveAttribute('aria-current', 'page')
        await expect(back(page)).toBeHidden()
        await expectChatCurrent(page, siteId)
        const listBox = await box(dialogs(page))
        const fieldBox = await box(message(page))
        expect(fieldBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width)
      })
      return
    }

    await test.step('the content stands alone with a way back', async () => {
      await expect(dialogs(page)).toBeHidden()
      await expect(back(page)).toBeVisible()
      await expect(back(page)).toHaveAttribute('href', `/projects/${siteId}/chat`)
      expect((await box(back(page))).height).toBeGreaterThanOrEqual(44)
    })

    if (width >= 600) {
      await expect(rail(page)).toBeVisible()
      await expectChatCurrent(page, siteId)
    } else {
      // With the field filled in: the bar is still there and still under the screen.
      await test.step('the bottom bar stays under the dialog that is being written', async () => {
        await expectDialogAboveBar(page, siteId, height)
      })
    }

    await test.step('the way back leads to the list', async () => {
      await back(page).click()
      await expect(page).toHaveURL(`/projects/${siteId}/chat`)
      await expect(dialogs(page)).toBeVisible()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чат')
      await expect(back(page)).toHaveCount(0)
      await expect(message(page)).toBeHidden()
      await expectChatCurrent(page, siteId)
      if (width < 600) await expect(page.getByRole('button', { name: 'Ещё' })).toBeVisible()
    })

    await test.step('«Новый диалог» of the list opens the screen again', async () => {
      await newDialog(page).click()
      await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый диалог')
      await expect(dialogs(page)).toBeHidden()
      await expect(message(page)).toBeVisible()
      await expectChatCurrent(page, siteId)
    })
  })

  test(`«Чат» of the sections opens a new dialog on a ${name}`, async ({ page, signedInUser }) => {
    const siteId = await addSite(signedInUser.id)
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto(`/projects/${siteId}/overview`)
    await expect(page.getByRole('heading', { level: 1, name: 'Обзор' })).toBeVisible()

    // The bottom bar on a phone, the rail from 600px: one of them is on the screen.
    await expect(sections(page)).toHaveCount(1)
    const chat = sections(page).getByRole('link', { name: 'Чат', exact: true })
    await expect(chat).toHaveAttribute('href', `/projects/${siteId}/chat/new`)
    await expect(chat).not.toHaveAttribute('aria-current')
    await chat.click()

    await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
    await expect(page).toHaveTitle(/Новый диалог/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый диалог')
    await expect(message(page)).toBeVisible()
    await expect(message(page)).toBeInViewport({ ratio: 1 })
    await expect(send(page)).toBeVisible()
    await expect(send(page)).toBeDisabled()
    await expectChatCurrent(page, siteId)
    await expectNoSidewaysScroll(page)

    if (width >= 900) await expect(dialogs(page)).toBeVisible()
    else await expect(back(page)).toBeVisible()
    if (width < 600) await expectDialogAboveBar(page, siteId, height)

    await test.step('«Чат» pressed again stays on the new dialog', async () => {
      await sections(page).getByRole('link', { name: 'Чат', exact: true }).click()
      await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
      await expect(message(page)).toBeVisible()
      await expectChatCurrent(page, siteId)
    })
  })
}

test('«Новый диалог» stays above the bottom bar under a long list on a phone', async ({
  page,
  signedInUser,
}) => {
  const [, width, height] = viewports[0]
  const siteId = await addSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width, height })
  await page.goto(`/projects/${siteId}/chat`)
  await expect(dialogs(page).getByText(EMPTY_LIST)).toBeVisible()

  // The run has no dialogs: the list is made long here, inside its own body.
  await dialogs(page).evaluate((list) => {
    const filler = document.createElement('div')
    filler.style.height = '3000px'
    list.lastElementChild?.append(filler)
  })
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  )
  expect(scrollable).toBeGreaterThan(2000)

  for (const [position, top] of [
    ['the top', 0],
    ['the middle', Math.round(scrollable / 2)],
  ] as const) {
    await test.step(`with the page scrolled to ${position}`, async () => {
      await page.evaluate((y) => window.scrollTo(0, y), top)
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(top)
      await expect(newDialog(page)).toBeInViewport({ ratio: 1 })
      const actionBox = await box(newDialog(page))
      const barBox = await box(sections(page))
      expect(actionBox.y).toBeGreaterThanOrEqual(0)
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(barBox.y)
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(height)
    })
  }
})

for (const [name, width, height] of viewports.filter(([, wide]) => wide < 900)) {
  test(`the focus follows the keyboard between the list and a dialog on a ${name}`, async ({
    page,
    signedInUser,
  }) => {
    const siteId = await addSite(signedInUser.id)
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto(`/projects/${siteId}/chat`)

    // The link that had the focus is hidden by the move: the focus goes to the content, never
    // back to the top of the document.
    const focus = () =>
      page.evaluate(() => {
        const active = document.activeElement
        const content = document.getElementById('site-content')
        return {
          lost: active === null || active === document.body,
          inContent: content !== null && active !== null && content.contains(active),
          shown: active !== null && active.getClientRects().length > 0,
        }
      })
    const kept = { lost: false, inContent: true, shown: true }

    await newDialog(page).focus()
    await expect(newDialog(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(`/projects/${siteId}/chat/new`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый диалог')
    await expect.poll(focus).toEqual(kept)

    await back(page).focus()
    await expect(back(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(`/projects/${siteId}/chat`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чат')
    await expect.poll(focus).toEqual(kept)
  })
}

test('«Чат» of someone else’s site answers «not found» like a made-up address', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  const foreign = await addForeignSite()
  try {
    for (const path of [
      `/projects/${foreign.siteId}/chat`,
      `/projects/${foreign.siteId}/chat/new`,
      '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/chat',
      '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/chat/new',
      '/projects/not-an-id/chat/new',
    ]) {
      await test.step(path, async () => {
        const response = await page.goto(path)
        expect(response?.status()).toBe(404)
        await expect(
          page.getByRole('heading', { level: 1, name: 'Такого проекта нет' }),
        ).toBeVisible()
        await expect(page.getByText('Кофейня «Крошка»')).toHaveCount(0)
        // Nothing of the section is given away: neither the list nor the screen of a dialog.
        await expect(dialogs(page)).toHaveCount(0)
        await expect(message(page)).toHaveCount(0)
        await expect(page.getByText('Новый диалог')).toHaveCount(0)
        await expect(page.getByText(SEND_OFF)).toHaveCount(0)
      })
    }
  } finally {
    await foreign.remove()
  }
})
