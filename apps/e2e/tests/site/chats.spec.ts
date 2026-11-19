import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import {
  acceptUploads,
  addAnsweredChat,
  addLongDialog,
  addProject,
  hideDevIndicator,
  priceDialogClass,
} from './site.ts'

// The ways through «Чаты» (docs/plan/61-chats-first.md, 61.12; no projects since plan 83): `/undo`,
// `/thinking`, the commands of a chat and the addresses of no chat. No core works in this run: a
// chat waits in the queue, and that is as far as these go.

let restorePrices: (() => Promise<void>) | undefined
test.beforeAll(async () => {
  restorePrices = await priceDialogClass()
})
test.afterAll(async () => {
  await restorePrices?.()
})

const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const send = (page: Page) => page.getByRole('button', { name: 'Отправить' })
const feed = (page: Page) => page.getByRole('list', { name: 'Сообщения чата' })
const commands = (page: Page) => page.getByRole('listbox', { name: 'Команды' })

// docs/plan/61-chats-first.md, §5.14. No core works here: `/undo` of a chat without the repository
// is `task.undoTurn` in web, and it took a real browser to see what `/thinking` does to a chat.
const ANSWERED = {
  words: 'Сколько записей на сайте?',
  answer: 'Сейчас на сайте семь записей.',
  thought: 'Count the posts of the list first.',
}
const UNDONE = 'Последний запрос отменён.'

test('`/undo` puts the words back into an empty field and says the request is undone', async ({
  page,
  signedInUser,
}) => {
  const { taskId } = await addAnsweredChat(signedInUser.id, ANSWERED)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(feed(page)).toContainText(ANSWERED.answer)

  await message(page).fill('/undo')
  await commands(page).waitFor()
  await page.keyboard.press('Enter')

  await expect(feed(page).getByText(UNDONE)).toBeVisible()
  await expect(message(page)).toHaveValue(ANSWERED.words)
  // The rows of the undone step stay, and the chat keeps waiting for the words.
  await expect(feed(page)).toContainText(ANSWERED.answer)
  await expect(send(page)).toBeEnabled()

  await page.getByRole('button', { name: 'Команды' }).click()
  const again = commands(page).getByRole('option', { name: /Отменить последний запрос/ })
  await expect(again).toHaveAttribute('aria-disabled', 'true')
  await expect(again).toContainText('Отменять пока нечего.')
  await page.keyboard.press('Escape')
})

test('`/undo` leaves a draft of the client where it is', async ({ page, signedInUser }) => {
  const { taskId } = await addAnsweredChat(signedInUser.id, ANSWERED)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(feed(page)).toContainText(ANSWERED.answer)

  await message(page).fill('Свой черновик')
  await page.getByRole('button', { name: 'Команды' }).click()
  await commands(page)
    .getByRole('option', { name: /Отменить последний запрос/ })
    .click()

  await expect(feed(page).getByText(UNDONE)).toBeVisible()
  await expect(message(page)).toHaveValue('Свой черновик')
})

test('`/redo` brings the request back and takes its words out of the field', async ({
  page,
  signedInUser,
}) => {
  const { taskId } = await addAnsweredChat(signedInUser.id, ANSWERED)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(feed(page)).toContainText(ANSWERED.answer)
  await message(page).fill('/undo')
  await commands(page).waitFor()
  await page.keyboard.press('Enter')
  await expect(message(page)).toHaveValue(ANSWERED.words)
  await expect(feed(page).getByText(UNDONE)).toBeVisible()

  await page.getByRole('button', { name: 'Команды' }).click()
  await commands(page)
    .getByRole('option', { name: /Вернуть отменённый запрос/ })
    .click()

  await expect(feed(page).getByText('Отменённый запрос возвращён.')).toBeVisible()
  await expect(message(page)).toHaveValue('')
  await page.getByRole('button', { name: 'Команды' }).click()
  const again = commands(page).getByRole('option', { name: /Вернуть отменённый запрос/ })
  await expect(again).toHaveAttribute('aria-disabled', 'true')
  await expect(again).toContainText('Возвращать нечего.')
  await page.keyboard.press('Escape')
})

test('`/thinking` shows what the model thought, and hides it again', async ({
  page,
  signedInUser,
}) => {
  const { taskId } = await addAnsweredChat(signedInUser.id, ANSWERED)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(feed(page)).toContainText(ANSWERED.answer)
  const thought = feed(page).getByText(ANSWERED.thought)
  const run = async () => {
    await message(page).fill('/thinking')
    await commands(page).waitFor()
    await page.keyboard.press('Enter')
  }

  await test.step('hidden by default, shown on the command', async () => {
    await expect(thought).toBeHidden()
    await run()
    await expect(thought).toBeVisible()
    await expect(feed(page).getByText('Размышления агента')).toBeVisible()
    // The answer stands where it stood, and the field is free.
    await expect(feed(page)).toContainText(ANSWERED.answer)
    await expect(message(page)).toHaveValue('')
  })

  await test.step('the choice is the viewer’s, and stays for the next visit', async () => {
    await page.reload()
    await expect(thought).toBeVisible()
  })

  await test.step('the second time it hides them, and that stays for the next visit too', async () => {
    await run()
    await expect(thought).toBeHidden()
    await page.reload()
    await expect(feed(page)).toContainText(ANSWERED.answer)
    await expect(thought).toBeHidden()
    // The thoughts come after the answer, so hidden above may only mean not here yet. The command
    // flips what is stored: it shows them only if the page left hidden on the last visit.
    await run()
    await expect(thought).toBeVisible()
  })
})

// No projects since plan 83 (docs/plan/83-remove-projects.md, БП7): a chat has the groups
// «Агент» and «Чат», never «Сайт».

test('the commands of a chat: no group of a site', async ({ page, signedInUser }) => {
  const chat = await addLongDialog(signedInUser.id, 2)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${chat.taskId}`)
  await page.getByRole('button', { name: 'Команды' }).click()
  await expect(commands(page).getByRole('group')).toHaveCount(2)
  await expect(commands(page).getByText('Сайт', { exact: true })).toHaveCount(0)
})

// The addresses a chat had under its project are gone, not moved: the site is not in production
// yet (owner's answer of 06.11.2026, docs/plan/61-chats-first.md, 61.27).

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

// The project a chat starts in (docs/plan/84-projects.md, ПР30): the pill in the field of
// «Новый чат», its search, «Новый проект», the words and files kept, and `?project=<id>`.

const pill = (page: Page, name: string) => page.getByRole('button', { name })

test('the pill of the field picks the project of a new chat, keeping the words and the files', async ({
  page,
  signedInUser,
}) => {
  await addProject(signedInUser.id, { name: 'Интернет-магазин чая' })
  const { projectId } = await addProject(signedInUser.id, {
    name: 'Сайт пекарни «Колос»',
    goal: 'Обновить сайт к зиме',
    starred: true,
  })
  await hideDevIndicator(page)
  await acceptUploads(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats/new')
  await message(page).fill('Сверь цены в прайсе с сайтом')
  await page.getByTestId('composer-files').setInputFiles({
    name: 'Прайс.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 прайс'),
  })
  await expect(page.getByRole('list', { name: 'Файлы к сообщению' })).toContainText('Прайс.pdf')

  await pill(page, 'Без проекта').click()
  const menu = page.getByRole('menu', { name: 'Проект для чата' })
  const items = menu.getByRole('menuitemradio')
  // «Без проекта», then the starred project first.
  await expect(items).toHaveCount(3)
  await expect(items.nth(1)).toContainText('Колос')
  await page.getByRole('textbox', { name: 'Найти проект' }).fill('чая')
  await expect(items).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Найти проект' }).fill('')
  await items.nth(1).click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Новый чат в проекте «Сайт пекарни «Колос»»',
  )
  await expect(page.getByText('Агент учитывает цель, контекст и память проекта')).toBeVisible()
  await expect(message(page)).toHaveValue('Сверь цены в прайсе с сайтом')
  await expect(page.getByRole('list', { name: 'Файлы к сообщению' })).toContainText('Прайс.pdf')

  await send(page).click()
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('link', { name: 'Проект «Сайт пекарни «Колос»»' })).toHaveAttribute(
    'href',
    `/projects/${projectId}`,
  )
})

test('«Новый проект» in the menu of the pill comes back with the new project chosen', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats/new')
  await message(page).fill('Черновик до проекта')
  await pill(page, 'Без проекта').click()
  await page
    .getByRole('menu', { name: 'Проект для чата' })
    .getByRole('menuitem', { name: 'Новый проект' })
    .click()
  const window_ = page.getByRole('dialog', { name: 'Создание проекта' })
  await window_.getByRole('textbox', { name: /Над чем вы работаете/ }).fill('Отчёты')
  await window_.getByRole('button', { name: 'Создать проект' }).click()
  await expect(pill(page, 'Проект: Отчёты')).toBeVisible()
  // The screen stays; its address names the project chosen (owner's request of 19.11.2026).
  await expect(page).toHaveURL(/\/chats\/new\?project=[0-9a-f-]{36}$/)
  await expect(message(page)).toHaveValue('Черновик до проекта')
})

test('`/chats/new?project=<id>` chooses the project, one of someone else does not', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/new?project=${projectId}`)
  await expect(pill(page, 'Проект: Колос')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый чат в проекте «Колос»')

  await page.goto('/chats/new?project=0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17')
  await expect(pill(page, 'Без проекта')).toBeVisible()
})

test('the project chosen by the pill stays after a reload, on «Новый чат» and beside the list', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const choose = async (name: RegExp) => {
    await page.getByRole('button', { name: /^(Без проекта|Проект: )/ }).click()
    await page
      .getByRole('menu', { name: 'Проект для чата' })
      .getByRole('menuitemradio', { name })
      .click()
  }
  for (const root of ['/chats/new', '/chats']) {
    await test.step(root, async () => {
      await page.goto(root)
      await choose(/Колос/)
      await expect(page).toHaveURL(new RegExp(`${root}\\?project=${projectId}$`))
      await page.reload()
      await expect(pill(page, 'Проект: Колос')).toBeVisible()
      // «Без проекта» takes it out of the address too.
      await choose(/Без проекта/)
      await expect(page).toHaveURL(new RegExp(`${root}$`))
      await page.reload()
      await expect(pill(page, 'Без проекта')).toBeVisible()
    })
  }

  await test.step('«Создать» leads to a new chat without the project the pill chose', async () => {
    await page.goto('/chats/new')
    await choose(/Колос/)
    await expect(page).toHaveURL(new RegExp(`/chats/new\\?project=${projectId}$`))
    await page
      .getByRole('navigation', { name: 'Чаты' })
      .getByRole('link', { name: 'Создать чат' })
      .click()
    await expect(page).toHaveURL(/\/chats\/new$/)
    await expect(pill(page, 'Без проекта')).toBeVisible()
  })
})

test('on a phone the projects of the pill come in a sheet from the bottom', async ({
  page,
  signedInUser,
}) => {
  await addProject(signedInUser.id, { name: 'Колос' })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chats/new')
  await pill(page, 'Без проекта').click()
  const sheet = page.getByRole('dialog', { name: 'Проект для чата' })
  await expect(sheet).toBeVisible()
  // Once it has slid in, it stands on the bottom edge of the screen.
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox()
      return box === null ? null : Math.round(box.y + box.height)
    })
    .toBe(844)
  await sheet.getByRole('menuitemradio', { name: /Колос/ }).click()
  await expect(pill(page, 'Проект: Колос')).toBeVisible()
})

// «Показывать чаты» of the list (owner's request of 19.11.2026): one list or folders of projects.

test('the list by projects: a folder per project, «Без проекта» last, the choice kept', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  await addAnsweredChat(signedInUser.id, { ...ANSWERED, words: 'Цены пекарни', projectId })
  await addAnsweredChat(signedInUser.id, { ...ANSWERED, words: 'Письмо поставщику' })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats')
  const list = page.getByRole('navigation', { name: 'Чаты' })
  await expect(list.getByRole('link', { name: /Цены пекарни/ })).toBeVisible()

  await list.getByRole('button', { name: 'Группировка чатов' }).click()
  await page
    .getByRole('menu', { name: 'Показывать чаты' })
    .getByRole('menuitemradio', { name: 'По проектам' })
    .click()
  const folders = list.locator('[data-chat-folder]')
  await expect(folders).toHaveCount(2)
  await expect(folders.nth(0)).toContainText('Колос')
  await expect(folders.nth(1)).toContainText('Без проекта')
  // Two folders, none of them the open chat's: both closed.
  await expect(list.getByRole('link', { name: /Цены пекарни/ })).toHaveCount(0)
  await folders.nth(0).click()
  await list.getByRole('link', { name: /Цены пекарни/ }).click()
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)

  // The choice stays for the next visit, and the folder of the open chat opens by itself.
  await page.reload()
  await expect(folders).toHaveCount(2)
  await expect(folders.nth(0)).toHaveAttribute('aria-expanded', 'true')
  await expect(list.getByRole('link', { name: /Цены пекарни/ })).toBeVisible()
  await expect(folders.nth(1)).toHaveAttribute('aria-expanded', 'false')
})

test('a long message of the client stands at ten lines until «Показать полностью»', async ({
  page,
  signedInUser,
}) => {
  const words = Array.from({ length: 16 }, (_, index) => `Строка задания ${index + 1}`).join('\n')
  const { taskId } = await addAnsweredChat(signedInUser.id, {
    ...ANSWERED,
    words,
    title: 'Длинное задание',
  })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  const text = feed(page).locator('[data-message-words]')
  await expect(text).toContainText('Строка задания 16')
  const lineHeight = await text.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  )
  const folded = (await text.boundingBox())!.height
  expect(Math.round(folded / lineHeight)).toBe(10)
  await feed(page).getByRole('button', { name: 'Показать полностью' }).click()
  await expect
    .poll(async () => Math.round((await text.boundingBox())!.height / lineHeight))
    .toBe(16)
  await feed(page).getByRole('button', { name: 'Свернуть' }).click()
  await expect
    .poll(async () => Math.round((await text.boundingBox())!.height / lineHeight))
    .toBe(10)
})
