import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import { createPrismaClient } from '@repo/db'

import { databaseUrl } from '../../fixtures/billing-stand.ts'

import {
  acceptProjectUploads,
  addAnsweredChat,
  addProject,
  hideDevIndicator,
  priceDialogClass,
  standInProjectFileStore,
} from './site.ts'

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

/** The rows of the context of the user's projects, by name: what the database says. */
async function contextRows(userId: string) {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    return await prisma.projectFile.findMany({
      where: { uploadedById: userId },
      select: { name: true, kind: true, status: true, projectId: true, expiresAt: true },
      orderBy: { name: 'asc' },
    })
  } finally {
    await prisma.$disconnect()
  }
}

const pdf = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n'),
})

test('«Контекст» of a new project: files uploaded before it are taken with it at its creation', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  await acceptProjectUploads(page)
  await standInProjectFileStore(page, signedInUser.id)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/projects')
  await page.getByRole('button', { name: 'Новый проект' }).first().click()
  const window_ = page.getByRole('dialog', { name: 'Создание проекта' })
  const context = window_.getByRole('group', { name: 'Контекст' })

  await test.step('«Добавить контекст» → «Загрузить с устройства» → «Файлы…»', async () => {
    await context.getByRole('button', { name: 'Добавить контекст' }).click()
    const menu = page.getByRole('menu', { name: 'Добавить в контекст' })
    await expect(menu.getByRole('menuitem', { name: /Подключить GitLab/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(menu).toContainText('Файлы до 20 МБ, всего до 100 МБ на проект')
    await menu.getByRole('menuitem', { name: 'Загрузить с устройства' }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: 'Файлы…' }).click()
    await (await chooser).setFiles(pdf('Брендбук.pdf'))
    await expect(context.getByText(/^PDF · \d+ байт$/)).toBeVisible()
  })

  await test.step('«Добавить текстовое содержимое»', async () => {
    await context.getByRole('button', { name: 'Добавить контекст' }).click()
    await page.getByRole('menuitem', { name: 'Добавить текстовое содержимое' }).click()
    const text = page.getByRole('dialog', { name: 'Добавить текстовое содержимое' })
    await text.getByRole('textbox', { name: /Название/ }).fill('Тексты о нас')
    await text
      .getByRole('textbox', { name: /Текст/ })
      .fill('Пекарня «Колос» печёт хлеб с 1998 года.')
    await expect(text).toContainText('39 из 100 000')
    await text.getByRole('button', { name: 'Добавить' }).click()
    await expect(text).toBeHidden()
    await expect(context.getByText('Тексты о нас')).toBeVisible()
  })

  // Nothing is the project's yet: the two files wait for it, each for a day.
  const before = await contextRows(signedInUser.id)
  expect(before.map((row) => [row.name, row.status, row.projectId])).toEqual([
    ['Брендбук.pdf', 'ready', null],
    ['Тексты о нас.md', 'ready', null],
  ])

  await window_.getByRole('textbox', { name: /Над чем вы работаете/ }).fill('Сайт пекарни')
  await window_.getByRole('button', { name: 'Создать проект' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!

  // One transaction: the project and its two files, without their day any more.
  const after = await contextRows(signedInUser.id)
  expect(after.map((row) => [row.name, row.projectId, row.expiresAt])).toEqual([
    ['Брендбук.pdf', projectId, null],
    ['Тексты о нас.md', projectId, null],
  ])
  const row = page.getByRole('region', { name: 'Контекст' })
  await expect(row).toContainText('Брендбук.pdf')
  await expect(row).toContainText('Тексты о нас')
  await expect(row).toContainText('Занято 1 % места')
})

test('«Контекст» of a project: a file and a text, the window, «Убрать», and «@» in the field', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  await hideDevIndicator(page)
  await acceptProjectUploads(page)
  await standInProjectFileStore(page, signedInUser.id)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${projectId}`)
  const row = page.getByRole('region', { name: 'Контекст' })
  await expect(row).toContainText('Файлы и тексты, которые агент читает в каждом чате проекта')

  await test.step("a file is the project's as soon as it is in", async () => {
    await row.getByRole('button', { name: 'Добавить в контекст проекта' }).click()
    await page.getByRole('menuitem', { name: 'Загрузить с устройства' }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: 'Файлы…' }).click()
    await (await chooser).setFiles(pdf('Прайс.pdf'))
    // The chip of the file on its way goes once the project took it, and the row names it.
    await expect(row.locator('[data-context-upload]')).toHaveCount(0)
    await expect(row.getByText('Прайс.pdf')).toBeVisible()
    expect((await contextRows(signedInUser.id)).map((r) => [r.name, r.projectId])).toEqual([
      ['Прайс.pdf', projectId],
    ])
  })

  await test.step('a text goes to the project at once', async () => {
    await row.getByRole('button', { name: 'Добавить в контекст проекта' }).click()
    await page.getByRole('menuitem', { name: 'Добавить текстовое содержимое' }).click()
    const text = page.getByRole('dialog', { name: 'Добавить текстовое содержимое' })
    await text.getByRole('textbox', { name: /Название/ }).fill('Ответы на отзывы')
    await text.getByRole('textbox', { name: /Текст/ }).fill('Отвечаем в течение суток.')
    await text.getByRole('button', { name: 'Добавить' }).click()
    await expect(text).toBeHidden()
    await expect(row.getByText('Ответы на отзывы')).toBeVisible()
  })

  await test.step('«@» in the field names the files where the agent finds them', async () => {
    const field = page.getByRole('textbox', { name: 'Сообщение' })
    await field.fill('Сверь цены с @Пра')
    const list = page.getByRole('listbox', { name: 'Файлы контекста проекта' })
    await expect(list.getByRole('option', { name: 'Прайс.pdf' })).toBeVisible()
    await field.press('Enter')
    await expect(field).toHaveValue('Сверь цены с @/workspace/project/Прайс.pdf ')
  })

  await test.step('the window lists them, downloads one, and «Убрать» takes one out', async () => {
    await row.getByRole('button', { name: 'Открыть контекст проекта' }).click()
    const window_ = page.getByRole('dialog', { name: 'Контекст' })
    await expect(window_).toContainText('Картинки он не видит')
    await expect(window_.getByRole('heading', { name: /Файлы и тексты/ })).toContainText('2')
    const download = window_.getByRole('link', { name: 'Скачать «Прайс.pdf»' })
    await expect(download).toHaveAttribute('href', /^\/api\/project-files\/[0-9a-f-]{36}$/)
    await window_.getByRole('button', { name: 'Убрать «Ответы на отзывы»' }).click()
    await expect(window_.getByText('Ответы на отзывы')).toBeHidden()
    await window_.getByRole('button', { name: 'Готово' }).click()
    await expect(row.getByText('Ответы на отзывы')).toBeHidden()
    expect((await contextRows(signedInUser.id)).map((r) => r.name)).toEqual(['Прайс.pdf'])
  })
})

test('«Контекст» on a phone: the window over the whole screen, «Добавить» from the bottom', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Колос' })
  await hideDevIndicator(page)
  await acceptProjectUploads(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${projectId}`)
  const row = page.getByRole('region', { name: 'Контекст' })
  await row.getByRole('button', { name: 'Добавить в контекст проекта' }).click()
  const sheet = page.getByRole('dialog', { name: 'Добавить в контекст' })
  await expect(sheet).toContainText('Документы, таблицы, фото и код')
  const chooser = page.waitForEvent('filechooser')
  await sheet.getByRole('menuitem', { name: /Загрузить с устройства/ }).click()
  await (await chooser).setFiles(pdf('Брендбук.pdf'))
  await expect(row.locator('[data-context-upload]')).toHaveCount(0)
  await expect(row.getByText('Брендбук.pdf')).toBeVisible()
  await row.getByRole('button', { name: 'Открыть контекст проекта' }).click()
  const window_ = page.getByRole('dialog', { name: 'Контекст' })
  const box = await window_.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(389)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})
