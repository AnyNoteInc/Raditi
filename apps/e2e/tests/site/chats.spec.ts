import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import {
  acceptUploads,
  addBrowserTask,
  addConnectedSite,
  addLongDialog,
  addSite,
  addSites,
  hideDevIndicator,
  priceDialogClass,
} from './site.ts'

// The ways through «Чаты» (docs/plan/61-chats-first.md, 61.12): a first run without a project, a
// file before the first words, the choice of a project, the files that hold it, one list and the
// folders, the phone, and the old addresses of the chat of a project. No core works in this run:
// a chat waits in the queue, and that is as far as these go.

let restorePrices: (() => Promise<void>) | undefined
test.beforeAll(async () => {
  restorePrices = await priceDialogClass()
})
test.afterAll(async () => {
  await restorePrices?.()
})

const KROSHKA = 'Кофейня «Крошка»'

const chats = (page: Page) => page.getByRole('navigation', { name: 'Чаты' })
const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const send = (page: Page) => page.getByRole('button', { name: 'Отправить' })
const pill = (page: Page, name: string | RegExp = /.*/) =>
  typeof name === 'string'
    ? page.getByRole('button', { name: `Проект для этого чата: ${name}` })
    : page.getByRole('button', { name: /^Проект для этого чата/ })
const picker = (page: Page) => page.getByRole('menu', { name: 'Проект для этого чата' })
const files = (page: Page) => page.getByTestId('composer-files')
const file = { name: 'Меню.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 меню') }

/** Writes the first words and waits for the chat they started; returns its id. */
async function start(page: Page, words: string): Promise<string> {
  await message(page).fill(words)
  await send(page).click()
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)
  return new URL(page.url()).pathname.split('/').at(-1) ?? ''
}

test('the first run: a chat without a project, a file before the first words', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await acceptUploads(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats')

  await test.step('the list is empty, nothing to group, «Без проекта» chosen', async () => {
    await expect(chats(page).getByText(/^Чатов пока нет/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Группировка чатов' })).toHaveCount(0)
    await expect(pill(page, 'Без проекта')).toBeVisible()
  })

  await test.step('with no projects the choice is «Без проекта» or «Добавить проект»', async () => {
    await pill(page).click()
    const items = picker(page).getByRole('menuitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveAccessibleName('Без проекта')
    await expect(items.nth(1)).toHaveAccessibleName('Добавить проект')
    await expect(items.nth(1)).toHaveAttribute('href', '/projects/new?from=chats')
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
  })

  await test.step('a file goes before there is a chat or a workspace', async () => {
    await files(page).setInputFiles(file)
    await expect(page.getByRole('list', { name: 'Файлы к сообщению' })).toContainText('Меню.pdf')
    await expect(pill(page)).toHaveCount(0)
    const locked = page.getByRole('button', { name: 'Без проекта' })
    await expect(locked).toHaveAttribute('aria-disabled', 'true')
    await expect(locked).toHaveAccessibleDescription(
      'Чтобы сменить проект, уберите прикреплённые файлы.',
    )
  })

  const taskId = await test.step('the first words start the chat with the file', async () => {
    await message(page).fill('Перескажите файл')
    await expect(send(page)).toBeEnabled()
    return start(page, 'Перескажите файл')
  })

  await test.step('the chat stands in the list, with no project, and its address is its own', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Перескажите файл')
    await expect(page.getByRole('link', { name: /^Открыть проект/ })).toHaveCount(0)
    // The server bound the file to the chat: the first words show it.
    await expect(page.getByRole('list', { name: 'Сообщения чата' })).toContainText('Меню.pdf')
    const link = chats(page).getByRole('link', { name: /Перескажите файл/ })
    await expect(link).toHaveAttribute('href', `/chats/${taskId}`)
    await expect(link).not.toContainText('·')
    await page.goto('/chats')
    await expect(chats(page).getByRole('link', { name: /Перескажите файл/ })).toBeVisible()
  })
})

test('a project chosen at the field, and the files that hold it', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addConnectedSite(signedInUser.id)
  await hideDevIndicator(page)
  await acceptUploads(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats/new')

  await test.step('«Без проекта», the project and «Добавить проект», in this order', async () => {
    await expect(pill(page, 'Без проекта')).toBeVisible()
    await pill(page).click()
    const items = picker(page).getByRole('menuitem')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toHaveAccessibleName('Без проекта')
    await expect(items.nth(1)).toContainText(KROSHKA)
    await expect(items.nth(2)).toHaveAccessibleName('Добавить проект')
    await items.nth(1).click()
    await expect(pill(page, KROSHKA)).toBeVisible()
  })

  await test.step('a file holds the project; taken out, it lets it go', async () => {
    await files(page).setInputFiles(file)
    await expect(page.getByRole('list', { name: 'Файлы к сообщению' })).toContainText('Меню.pdf')
    await expect(pill(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(KROSHKA) })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await page.getByRole('button', { name: 'Убрать Меню.pdf' }).click()
    await expect(pill(page, KROSHKA)).toBeVisible()
  })

  await test.step('the chat starts on the project and leads to it', async () => {
    const taskId = await start(page, 'Поменяйте телефон в шапке')
    await expect(page.getByRole('link', { name: `Открыть проект «${KROSHKA}»` })).toHaveAttribute(
      'href',
      `/projects/${siteId}`,
    )
    await expect(chats(page).getByRole('link', { name: /Поменяйте телефон/ })).toContainText(
      `· ${KROSHKA}`,
    )
    expect(taskId).not.toBe('')
  })
})

test('a closed project cannot be chosen and says why', async ({ page, signedInUser }) => {
  const siteId = await addSite(signedInUser.id, 'paused')
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/new?project=${siteId}`)
  // The address asked for it, and the screen stays «Без проекта».
  await expect(pill(page, 'Без проекта')).toBeVisible()
  await pill(page).click()
  const item = picker(page).getByRole('menuitem', { name: new RegExp(KROSHKA) })
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toContainText('Сайт на паузе или отключён.')
})

test('one list and the folders of projects, kept for the next visit', async ({
  page,
  signedInUser,
}) => {
  const asked = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats/new')
  const noProject = await start(page, 'Идеи для названия пекарни')

  await test.step('one list by default, the project on the row', async () => {
    await page.goto('/chats')
    await expect(chats(page).getByRole('list', { name: 'Ждёт вашего решения' })).toContainText(
      asked.title,
    )
    await expect(chats(page).getByRole('link', { name: new RegExp(asked.title) })).toContainText(
      `· ${KROSHKA}`,
    )
  })

  const folder = (name: string | RegExp, expanded?: boolean) =>
    chats(page).getByRole('button', {
      name,
      ...(expanded === undefined ? {} : { expanded }),
    })

  await test.step('«По проектам»: the folders, «Без проекта» the last', async () => {
    await page.getByRole('button', { name: 'Группировка чатов' }).click()
    const menu = page.getByRole('menu', { name: 'Показывать чаты' })
    await expect(menu.getByRole('menuitemradio', { name: 'Одним списком' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await menu.getByRole('menuitemradio', { name: 'По проектам' }).click()
    await expect(folder(new RegExp(KROSHKA))).toBeVisible()
    const names = chats(page).locator('[aria-expanded]:not([aria-haspopup])')
    await expect(names).toHaveCount(2)
    await expect(names.nth(0)).toContainText(KROSHKA)
    await expect(names.nth(1)).toContainText('Без проекта')
  })

  await test.step('a closed folder says that a chat in it waits', async () => {
    await expect(folder(/Есть чаты, которые ждут вас/, false)).toContainText(KROSHKA)
    await folder(new RegExp(KROSHKA), false).click()
    await expect(chats(page).getByRole('link', { name: new RegExp(asked.title) })).toBeVisible()
    await expect(chats(page).getByText('Есть чаты, которые ждут вас')).toHaveCount(0)
    // In a folder the row does not repeat its name.
    await expect(
      chats(page).getByRole('link', { name: new RegExp(asked.title) }),
    ).not.toContainText('·')
  })

  await test.step('the choice stays for the next visit, the folder of the open chat open', async () => {
    await page.goto(`/chats/${noProject}`)
    await expect(folder('Без проекта', true)).toBeVisible()
    await expect(folder(new RegExp(KROSHKA), false)).toBeVisible()
    await expect(
      chats(page).getByRole('link', { name: /Идеи для названия пекарни/ }),
    ).toHaveAttribute('aria-current', 'page')
  })
})

test('a chat on a phone: the list, a new chat and a sheet of projects', async ({
  page,
  signedInUser,
}) => {
  await addConnectedSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chats')

  await test.step('the list with the rail of 56, «Новый чат» at the bottom', async () => {
    await expect(page.getByRole('complementary', { name: 'Боковая панель' })).toBeVisible()
    await chats(page).getByRole('link', { name: 'Новый чат' }).click()
    await expect(page).toHaveURL('/chats/new')
  })

  await test.step('no rail on a new chat, the way back on top', async () => {
    await expect(page.getByRole('complementary', { name: 'Боковая панель' })).toBeHidden()
    await expect(page.getByRole('link', { name: 'К чатам' })).toBeVisible()
  })

  await test.step('the project is chosen on a sheet from the bottom', async () => {
    await expect(pill(page, 'Без проекта')).toBeVisible()
    await pill(page).click()
    const sheet = page.getByRole('dialog', { name: 'Проект для этого чата' })
    await expect(sheet.getByText('Проект для этого чата', { exact: true })).toBeVisible()
    await expect(sheet.getByRole('menuitem', { name: 'Добавить проект' })).toBeVisible()
    // Once it has come up it stands on the bottom of the window.
    await expect
      .poll(async () => {
        const found = await sheet.boundingBox()
        return Math.round((found?.y ?? 0) + (found?.height ?? 0))
      })
      .toBe(844)
    await sheet.getByRole('menuitem', { name: new RegExp(KROSHKA) }).click()
    await expect(pill(page, KROSHKA)).toBeVisible()
  })

  await test.step('the chat takes the screen too', async () => {
    await start(page, 'Поменяйте телефон в шапке')
    await expect(page.getByRole('complementary', { name: 'Боковая панель' })).toBeHidden()
    await expect(page.getByRole('link', { name: 'К чатам' })).toBeVisible()
    await expect(page.getByRole('link', { name: `Открыть проект «${KROSHKA}»` })).toBeVisible()
  })
})

test('the old addresses of a chat lead to «Чаты»', async ({ page, signedInUser }) => {
  const { siteId, taskId, title } = await addLongDialog(signedInUser.id, 2)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.goto(`/projects/${siteId}/chat`)
  await expect(page).toHaveURL('/chats')
  await page.goto(`/projects/${siteId}/chat/new`)
  await expect(page).toHaveURL(`/chats/new?project=${siteId}`)
  await expect(pill(page, KROSHKA)).toBeVisible()
  await page.goto(`/projects/${siteId}/chat/${taskId}`)
  await expect(page).toHaveURL(`/chats/${taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  const response = await page.goto(`/projects/${siteId}/chat/nothing`)
  expect(response?.status()).toBe(404)
})

test('an address of no chat of the user is «not found»', async ({ page, signedInUser }) => {
  void signedInUser
  for (const path of [
    '/chats/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17',
    // An id by its form that the server does not take for one.
    '/chats/11111111-1111-1111-1111-111111111111',
    '/chats/not-an-id',
  ]) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Такого чата нет')
  }
})

test('the list of projects is searched only above six', async ({ page, signedInUser }) => {
  const search = page.getByRole('textbox', { name: 'Поиск проектов' })
  const projects = page.getByRole('list', { name: 'Сайты' }).getByRole('listitem')

  await addSites(signedInUser.id, 6)
  await page.goto('/projects')
  await expect(projects).toHaveCount(6)
  await expect(search).toHaveCount(0)

  await addSites(signedInUser.id, 1)
  await page.reload()
  await expect(projects).toHaveCount(7)
  await search.fill('нет такого проекта')
  await expect(page.getByRole('heading', { name: 'Проекты не найдены' })).toBeVisible()
  await page.getByRole('button', { name: 'Сбросить поиск' }).click()
  await expect(projects).toHaveCount(7)
})

test('a project of the wizard: «Добавить проект» keeps the words of the chat', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats/new')
  await expect(pill(page, 'Без проекта')).toBeVisible()
  await message(page).fill('Опубликуйте новость')
  await pill(page).click()
  await picker(page).getByRole('menuitem', { name: 'Добавить проект' }).click()
  await expect(page).toHaveURL('/projects/new?from=chats')
  await page.getByRole('link', { name: 'Отмена' }).click()
  await expect(page).toHaveURL('/chats/new')
  await expect(message(page)).toHaveValue('Опубликуйте новость')
})
