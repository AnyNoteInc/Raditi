import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import {
  addAnsweredChat,
  addBrowserTask,
  addLongDialog,
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

// The card of the browser's request: on an open project the same fixture shows «Взять
// управление» (dialog.spec.ts). The panel is not checked here: this run has no stream, so the panel
// shows its error and no control on any project; `browser-pane.test.tsx` holds it (`readOnly`).

test('the commands of a chat: both groups on a project with files, none of the site without', async ({
  page,
  signedInUser,
}) => {
  const withFiles = await addLongDialog(signedInUser.id, 2)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${withFiles.taskId}`)
  await page.getByRole('button', { name: 'Команды' }).click()
  await expect(commands(page).getByRole('group')).toHaveCount(3)
  await expect(commands(page).getByText('Сайт', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // A project without files: its chat has the browser alone, and no command of the code.
  const noFiles = await addBrowserTask(signedInUser.id)
  await page.goto(`/chats/${noFiles.taskId}`)
  await page.getByRole('button', { name: 'Команды' }).click()
  await expect(commands(page)).toBeVisible()
  await expect(commands(page).getByRole('group').first()).toBeVisible()
  await expect(commands(page).getByText('Сайт', { exact: true })).toHaveCount(0)
})

test('one list and the folders of projects, kept for the next visit', async ({
  page,
  signedInUser,
}) => {
  const asked = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats/new')

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
