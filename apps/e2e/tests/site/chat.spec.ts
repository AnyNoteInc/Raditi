import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import { addForeignSite, hideDevIndicator } from './site.ts'

// «Чаты» in a real browser (docs/plan/61-chats-first.md, §5.11): the «list — content» frame and the
// screen a chat starts from. Which of the list and the content a width leaves on the screen is
// decided by styles, so only a browser sees it. A chat itself is in dialog.spec.ts, the ways through
// the section — the project, the files, the folders — in chats.spec.ts.

const viewports = [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1280, 900],
] as const

const EMPTY_LIST = 'Чатов пока нет. Напишите, что нужно сделать, — чат появится здесь.'

const chats = (page: Page) => page.getByRole('navigation', { name: 'Чаты' })
const rail = (page: Page) => page.getByRole('complementary', { name: 'Боковая панель' })
const back = (page: Page) => page.getByRole('link', { name: 'К чатам' })
const newChat = (page: Page) => chats(page).getByRole('link', { name: 'Новый чат' })
const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const send = (page: Page) => page.getByRole('button', { name: 'Отправить' })
const newChatHeading = (page: Page) => page.getByRole('heading', { name: 'Новый чат' })
const pill = (page: Page) => page.getByRole('button', { name: /^Проект для этого чата/ })

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

/** «Чаты» is the current page of the rail. */
async function expectChatsCurrent(page: Page) {
  const current = page
    .getByRole('navigation', { name: 'Основная навигация' })
    .locator('[aria-current="page"]')
  await expect(current).toHaveCount(1)
  await expect(current).toHaveAccessibleName('Чаты')
}

for (const [name, width, height] of viewports) {
  test(`the root of «Чаты» on a ${name}`, async ({ page, signedInUser }) => {
    void signedInUser
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto('/chats')

    await expect(page).toHaveTitle(/Чаты/)
    await expect(chats(page)).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чаты')
    await expect(chats(page).getByText(EMPTY_LIST)).toBeVisible()
    await expect(newChat(page)).toHaveAttribute('href', '/chats/new')
    await expect(newChat(page)).not.toHaveAttribute('aria-current')
    await expect(back(page)).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toHaveCount(0)
    await expectNoSidewaysScroll(page)

    await test.step('the rail stands on every width at the root, «Чаты» first', async () => {
      await expect(rail(page)).toBeVisible()
      expect((await box(rail(page))).width).toBe(width < 600 ? 56 : 72)
      await expectChatsCurrent(page)
      const links = page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link')
      await expect(links.nth(0)).toHaveAccessibleName('Чаты')
      await expect(links.nth(1)).toHaveAccessibleName('Проекты')
    })

    if (width >= 900) {
      await test.step('a new chat is ready beside the list', async () => {
        await expect(message(page)).toBeVisible()
        await expect(send(page)).toBeDisabled()
        // The heading of the page is the list's: the screen beside it takes the level below.
        await expect(newChatHeading(page)).toHaveCount(1)
        await expect(page.getByRole('heading', { level: 2, name: 'Новый чат' })).toBeVisible()
      })

      await test.step('the list runs the height of the window between the rail and the content', async () => {
        const railBox = await box(rail(page))
        const listBox = await box(chats(page))
        const listEnd = listBox.x + listBox.width
        expect(listBox.x).toBe(railBox.x + railBox.width)
        expect(listBox.y).toBe(0)
        expect(listBox.y + listBox.height).toBe(height)
        for (const part of [newChatHeading(page), message(page), send(page)]) {
          const partBox = await box(part)
          expect(partBox.x).toBeGreaterThanOrEqual(listEnd)
          expect(partBox.x + partBox.width).toBeLessThanOrEqual(width)
          expect(partBox.y + partBox.height).toBeLessThanOrEqual(height)
        }
      })
      return
    }

    await test.step('below the wide layout the root is the list alone', async () => {
      await expect(message(page)).toBeHidden()
      await expect(send(page)).toBeHidden()
      await expect(newChatHeading(page)).toHaveCount(0)
    })
  })

  test(`a new chat on a ${name}`, async ({ page, signedInUser }) => {
    void signedInUser
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto('/chats/new')

    await expect(page).toHaveTitle(/Новый чат/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый чат')
    await expectNoSidewaysScroll(page)

    await test.step('nothing but words is needed: no modes, no project', async () => {
      await expect(page.getByRole('radiogroup')).toHaveCount(0)
      await expect(pill(page)).toHaveAccessibleName('Проект для этого чата: Без проекта')
      await expect(message(page)).toHaveAttribute('placeholder', 'Что нужно сделать?')
      await expect(send(page)).toBeDisabled()
      await message(page).fill('Предложите пять названий')
      await expect(send(page)).toBeEnabled()
      await message(page).fill('')
      expect(Math.min(...Object.values(await box(send(page))).slice(2))).toBeGreaterThanOrEqual(44)
    })

    if (width >= 900) {
      await test.step('the list stays beside the new chat', async () => {
        await expect(chats(page)).toBeVisible()
        await expect(chats(page).getByRole('heading', { level: 2, name: 'Чаты' })).toBeVisible()
        await expect(newChat(page)).toHaveAttribute('aria-current', 'page')
        await expect(back(page)).toBeHidden()
        const listBox = await box(chats(page))
        const fieldBox = await box(message(page))
        expect(fieldBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width)
      })
      return
    }

    await test.step('the content stands alone with a way back', async () => {
      await expect(chats(page)).toBeHidden()
      await expect(back(page)).toBeVisible()
      await expect(back(page)).toHaveAttribute('href', '/chats')
      expect((await box(back(page))).height).toBeGreaterThanOrEqual(44)
    })

    if (width >= 600) await expect(rail(page)).toBeVisible()
    else {
      await test.step('a phone gives the rail up, and the field stands by the thumb', async () => {
        await expect(rail(page)).toBeHidden()
        const fieldBox = await box(message(page))
        expect(fieldBox.y).toBeGreaterThan(height / 2)
        expect((await box(pill(page))).y).toBeGreaterThan(fieldBox.y)
        // The pill takes a row of its own over the buttons.
        expect((await box(pill(page))).y).toBeLessThan((await box(send(page))).y)
      })
    }

    await test.step('the way back leads to the list', async () => {
      await back(page).click()
      await expect(page).toHaveURL('/chats')
      await expect(chats(page)).toBeVisible()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чаты')
      await expect(back(page)).toHaveCount(0)
      await expect(message(page)).toBeHidden()
      await expect(rail(page)).toBeVisible()
    })

    await test.step('«Новый чат» of the list opens the screen again', async () => {
      await newChat(page).click()
      await expect(page).toHaveURL('/chats/new')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый чат')
      await expect(chats(page)).toBeHidden()
      await expect(message(page)).toBeVisible()
    })
  })
}

test('«Новый чат» stays within reach under a long list on a phone', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  const [, width, height] = viewports[0]
  await hideDevIndicator(page)
  await page.setViewportSize({ width, height })
  await page.goto('/chats')
  await expect(chats(page).getByText(EMPTY_LIST)).toBeVisible()

  // The run has no chats: the list is made long here, inside its own body.
  await chats(page).evaluate((list) => {
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
      await expect(newChat(page)).toBeInViewport({ ratio: 1 })
      const actionBox = await box(newChat(page))
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(height)
    })
  }
})

for (const [name, width, height] of viewports.filter(([, wide]) => wide < 900)) {
  test(`the focus follows the keyboard between the list and a chat on a ${name}`, async ({
    page,
    signedInUser,
  }) => {
    void signedInUser
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto('/chats')

    // The link that had the focus is hidden by the move: the focus goes to the content, never
    // back to the top of the document.
    const focus = () =>
      page.evaluate(() => {
        const active = document.activeElement
        const content = document.getElementById('chats-content')
        return {
          lost: active === null || active === document.body,
          inContent: content !== null && active !== null && content.contains(active),
          shown: active !== null && active.getClientRects().length > 0,
        }
      })
    const kept = { lost: false, inContent: true, shown: true }

    await newChat(page).focus()
    await expect(newChat(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/chats/new')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый чат')
    await expect.poll(focus).toEqual(kept)

    await back(page).focus()
    await expect(back(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/chats')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чаты')
    await expect.poll(focus).toEqual(kept)
  })
}

test('the old address of the chat of someone else’s project answers «not found»', async ({
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
        await expect(chats(page)).toHaveCount(0)
        await expect(message(page)).toHaveCount(0)
      })
    }
  } finally {
    await foreign.remove()
  }
})
