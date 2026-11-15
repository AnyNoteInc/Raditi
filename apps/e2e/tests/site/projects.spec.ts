import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import { addAnsweredChat, addProject, hideDevIndicator, priceDialogClass } from './site.ts'

// «Проекты» in the cabinet (docs/plan/84-projects.md, 84.6): the empty list, a new project, the
// list with its tabs and the trash, a chat moved into a project and out of it, the page of a
// project on a phone. No core works in this run: a chat started here waits in the queue.

let restorePrices: (() => Promise<void>) | undefined
test.beforeAll(async () => {
  restorePrices = await priceDialogClass()
})
test.afterAll(async () => {
  await restorePrices?.()
})

const cards = (page: Page, tab: string) =>
  page.getByRole('list', { name: tab }).getByRole('article')

test('«Проекты» of the rail leads to the page; before the first project it asks to create one', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats')
  await page
    .getByRole('navigation', { name: 'Основная навигация' })
    .getByRole('link', { name: 'Проекты' })
    .click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Проекты' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Хотите создать проект?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Новый проект' })).toHaveCount(1)

  await test.step('an example fills the window, «Создать проект» opens the project', async () => {
    await page.getByRole('button', { name: 'Сайт и его обновления' }).click()
    const window_ = page.getByRole('dialog', { name: 'Создание проекта' })
    await expect(window_.getByRole('textbox', { name: /Над чем вы работаете/ })).toHaveValue(
      'Сайт и его обновления',
    )
    await window_.getByRole('textbox', { name: /Над чем вы работаете/ }).fill('Сайт пекарни')
    await window_.getByRole('button', { name: 'Создать проект' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сайт пекарни')
    await expect(page.getByText('Здесь появятся чаты этого проекта.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Сообщение' })).toHaveAttribute(
      'placeholder',
      'Новый чат в проекте «Сайт пекарни»',
    )
  })

  await test.step('the rail marks «Проекты» on the page of a project too', async () => {
    await expect(
      page
        .getByRole('navigation', { name: 'Основная навигация' })
        .getByRole('link', { name: 'Проекты' }),
    ).toHaveAttribute('aria-current', 'page')
  })
})

test('a chat started on the page of a project is in it: the crumb of its head and its list', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('textbox', { name: 'Сообщение' }).fill('Сверь цены с прайсом')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)
  const crumb = page.getByRole('link', { name: 'Проект «Колос»' })
  await expect(crumb).toBeVisible()
  await crumb.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  await expect(page.getByRole('list', { name: /Чаты проекта/ })).toContainText(
    'Сверь цены с прайсом',
  )
})

test('the list: cards, «Избранное», «Архив», «Корзина» and «Вернуть»', async ({
  page,
  signedInUser,
}) => {
  await addProject(signedInUser.id, { name: 'Рассылка для клиентов' })
  await addProject(signedInUser.id, {
    name: 'Сайт пекарни «Колос»',
    goal: 'Обновить сайт к зиме',
  })
  await addProject(signedInUser.id, { name: 'Старый проект', archived: true })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/projects')
  await expect(cards(page, 'Все')).toHaveCount(2)
  await expect(cards(page, 'Все').first()).toContainText('Обновить сайт к зиме')
  await expect(cards(page, 'Все').first()).toContainText('0 чатов')
  // Fewer than 7 projects: no search.
  await expect(page.getByRole('textbox', { name: 'Поиск по проектам' })).toHaveCount(0)

  await test.step('a star puts a project into «Избранное»', async () => {
    await page.getByRole('button', { name: 'Проект «Сайт пекарни «Колос»» в избранное' }).click()
    await page
      .getByRole('group', { name: 'Показать проекты' })
      .getByRole('button', { name: /Избранное/ })
      .click()
    await expect(cards(page, 'Избранное')).toHaveCount(1)
    await expect(cards(page, 'Избранное')).toContainText('Колос')
  })

  await test.step('«В архив» takes it to «Архив»', async () => {
    await page
      .getByRole('group', { name: 'Показать проекты' })
      .getByRole('button', { name: /Все/ })
      .click()
    await page.getByRole('button', { name: 'Действия с проектом «Рассылка для клиентов»' }).click()
    await page.getByRole('menuitem', { name: 'В архив' }).click()
    await expect(cards(page, 'Все')).toHaveCount(1)
    await page
      .getByRole('group', { name: 'Показать проекты' })
      .getByRole('button', { name: /Архив/ })
      .click()
    await expect(cards(page, 'Архив')).toHaveCount(2)
  })

  await test.step('«Удалить» asks, puts it into «Корзина», and «Вернуть» brings it back', async () => {
    await page
      .getByRole('group', { name: 'Показать проекты' })
      .getByRole('button', { name: /Все/ })
      .click()
    await page.getByRole('button', { name: 'Действия с проектом «Сайт пекарни «Колос»»' }).click()
    await page.getByRole('menuitem', { name: /Удалить/ }).click()
    const question = page.getByRole('dialog', { name: 'Удалить проект «Сайт пекарни «Колос»»?' })
    await question.getByRole('button', { name: 'В корзину' }).click()
    await expect(page.getByText('Проект «Сайт пекарни «Колос»» в корзине.')).toBeVisible()
    await page.getByRole('button', { name: /Корзина/ }).click()
    const trash = cards(page, 'Корзина')
    await expect(trash).toHaveCount(1)
    await expect(trash).toContainText('Удалится навсегда')
    await trash.getByRole('button', { name: /Вернуть/ }).click()
    await expect(page.getByText('Проект «Сайт пекарни «Колос»» возвращён.')).toBeVisible()
    await expect(cards(page, 'Все')).toHaveCount(1)
  })
})

test('«Перенести в проект…» and «Убрать из проекта» of a chat', async ({ page, signedInUser }) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  const { taskId } = await addAnsweredChat(signedInUser.id, {
    words: 'Сколько записей на сайте?',
    answer: 'Сейчас на сайте семь записей.',
    thought: 'Count them.',
  })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(page.getByRole('link', { name: /^Проект «/ })).toHaveCount(0)

  const head = page.locator('header', { has: page.getByRole('heading', { level: 1 }) })
  await head.getByRole('button', { name: /Действия с чатом/ }).click()
  await page.getByRole('menuitem', { name: 'Перенести в проект…' }).click()
  await page
    .getByRole('dialog', { name: 'Перенести в проект' })
    .getByRole('button', { name: 'Колос' })
    .click()
  await expect(page.getByRole('link', { name: 'Проект «Колос»' })).toBeVisible()

  await test.step('the list of chats names the project', async () => {
    await expect(
      page.getByRole('link', { name: /Сколько записей на сайте/ }).first(),
    ).toContainText('Колос')
  })

  await test.step('the page of the project lists the chat', async () => {
    await page.goto(`/projects/${projectId}`)
    await expect(page.getByRole('list', { name: /Чаты проекта/ })).toContainText(
      'Сколько записей на сайте?',
    )
  })

  await test.step('«Убрать из проекта» takes it out', async () => {
    await page.goto(`/chats/${taskId}`)
    await head.getByRole('button', { name: /Действия с чатом/ }).click()
    await page.getByRole('menuitem', { name: 'Убрать из проекта' }).click()
    await expect(page.getByRole('link', { name: 'Проект «Колос»' })).toHaveCount(0)
  })
})

test('the page of a project on a phone: the column under the field, no sideways scroll', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, {
    name: 'Сайт пекарни «Колос»',
    goal: 'Обновить сайт к зиме: новое меню и онлайн-заказ тортов.',
  })
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${projectId}`)
  const field = page.getByRole('textbox', { name: 'Сообщение' })
  const column = page.getByRole('complementary', { name: 'Проекты' })
  await expect(column).toBeVisible()
  const [fieldBox, columnBox] = [await field.boundingBox(), await column.boundingBox()]
  expect(columnBox!.y).toBeGreaterThan(fieldBox!.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )

  await test.step('«Добавить» of the instructions opens a window over the whole screen', async () => {
    await column.getByRole('button', { name: 'Добавить: Инструкции' }).click()
    const window_ = page.getByRole('dialog', { name: 'Инструкции проекта' })
    await window_.getByRole('textbox', { name: 'Инструкции проекта' }).fill('Пишем на «вы».')
    await window_.getByRole('button', { name: 'Сохранить' }).click()
    await expect(window_).toBeHidden()
    await expect(column).toContainText('Пишем на «вы».')
    await expect(column.getByRole('button', { name: 'Изменить: Инструкции' })).toBeVisible()
  })
})

test('an address of no project of the user is «not found»', async ({ page, signedInUser }) => {
  void signedInUser
  for (const path of ['/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17', '/projects/not-an-id']) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Такого проекта нет')
  }
})
