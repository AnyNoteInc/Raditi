import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import { hideDevIndicator, priceDialogClass } from './site.ts'

// «Запланированные задачи» in a real browser (docs/plan/82-scheduled-tasks.md, Зп1–Зп10): the
// stopwatch of the rail between «Чаты» and «Страницы», the list before the first task, a task set
// up by hand, a template, the switch, «Запустить сейчас» and «Удалить», the page of a task, and the
// window on a phone. No core works in this run: «Запустить сейчас» makes its chat in web, and the
// chat waits in the queue; no run comes by the schedule.

// The words of a schedule are said on the clock of the task's zone, which the browser gives.
test.use({ timezoneId: 'Europe/Moscow' })

let restorePrices: (() => Promise<void>) | undefined
test.beforeAll(async () => {
  restorePrices = await priceDialogClass()
})
test.afterAll(async () => {
  await restorePrices?.()
})

const rail = (page: Page) => page.getByRole('navigation', { name: 'Основная навигация' })
const newTask = (page: Page) => page.getByRole('button', { name: 'Новая задача' })
const windowOf = (page: Page, name = 'Новая запланированная задача') =>
  page.getByRole('dialog', { name })
const list = (page: Page) => page.getByRole('list', { name: 'Ваши запланированные задачи' })

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

/** Opens the window of a new task by hand from «Новая задача ▾». */
async function openByHand(page: Page) {
  await newTask(page).click()
  await page
    .getByRole('menu', { name: 'Как настроить новую задачу' })
    .getByRole('menuitem', { name: 'Настроить вручную' })
    .click()
  await expect(windowOf(page)).toBeVisible()
}

test('the stopwatch of the rail stands after «Чаты» and before «Страницы» (Зп1)', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/chats')
  const links = rail(page).getByRole('link')
  // The three sections of the rail (Зп60).
  await expect(links).toHaveCount(3)
  await expect(links.nth(0)).toHaveAccessibleName('Чаты')
  await expect(links.nth(1)).toHaveAccessibleName('Запланированные задачи')
  await expect(links.nth(1)).toHaveAttribute('href', '/scheduled')
  await expect(links.nth(2)).toHaveAccessibleName('Страницы')

  await links.nth(1).click()
  await expect(page).toHaveURL(/\/scheduled$/)
  await expect(page).toHaveTitle(/Запланированные задачи/)
  await expect(rail(page).locator('[aria-current="page"]')).toHaveAccessibleName(
    'Запланированные задачи',
  )

  await test.step('a phone on its side: the rail without labels, the account menu in reach', async () => {
    await page.setViewportSize({ width: 812, height: 375 })
    await expect(
      page.getByRole('button', { name: 'Меню пользователя в боковой панели' }),
    ).toBeInViewport()
    await expect(rail(page).getByText('Чаты', { exact: true })).toBeHidden()
  })
})

for (const [name, width, height] of [
  ['phone', 375, 812],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
] as const) {
  test(`«Запланированные задачи» before the first task on a ${name} (Зп4)`, async ({
    page,
    signedInUser,
  }) => {
    void signedInUser
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto('/scheduled')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Запланированные задачи')
    await expect(page.getByText('Запланированных задач пока нет.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Настроить вручную' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Настроить в чате' })).toBeVisible()
    await expect(page.getByText('Или начните с шаблона')).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Шаблоны задач' }).getByRole('listitem'),
    ).toHaveCount(6)
    // Nothing to find, filter or order yet.
    await expect(page.getByRole('button', { name: 'Фильтр задач' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Порядок задач' })).toHaveCount(0)
    await expectNoSidewaysScroll(page)
    if (width < 600) {
      // On a phone the empty list's own «Настроить вручную» takes the whole width, and stands
      // for «Новая задача»: no second orange button of the whole width for the same (Зп4).
      await expect(newTask(page)).toBeHidden()
      const button = await page.getByRole('button', { name: 'Настроить вручную' }).boundingBox()
      const main = await page.locator('#application-content').boundingBox()
      expect(button && main && button.width).toBeGreaterThan((main?.width ?? 0) - 48)
    } else {
      await expect(newTask(page)).toBeVisible()
    }

    await test.step('the heading says what the section is', async () => {
      await page.getByRole('heading', { level: 1 }).getByText('Запланированные задачи').hover()
      await expect(page.getByRole('tooltip')).toContainText('Агент выполняет их сам по расписанию')
    })
  })
}

test('a task by hand: every day at a time, paused and resumed, run now, its page, deleted', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/scheduled')

  await test.step('the window: a name, the instructions, every day at 10:30', async () => {
    await openByHand(page)
    const dialog = windowOf(page)
    await dialog.getByRole('textbox', { name: 'Название' }).fill('Сводка дня')
    await dialog
      .getByRole('textbox', { name: 'Что сделать агенту' })
      .fill('Пришли курс доллара, евро и юаня по ЦБ на сегодня.')
    // A regular expression meets the text as it is: the warning keeps «без» to its word.
    await expect(dialog.getByText(/Задача выполняется без\sвас/)).toBeVisible()
    const block = dialog.getByRole('group', { name: 'Время запуска 1' })
    await expect(block.getByRole('combobox', { name: 'Как часто' })).toHaveText('Ежедневно')
    await block.getByLabel('Время').fill('10:30')
    await expect(
      dialog.getByText(/^Следующий запуск: (сегодня|завтра), \d+ \S+, в 10:30$/),
    ).toBeVisible()
    await expect(dialog.getByText(/Каждый запуск тратит кредиты, как обычный чат/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(dialog).toBeHidden()
    // The focus comes back to what opened the window.
    await expect(newTask(page)).toBeFocused()
  })

  const row = list(page).getByRole('listitem').filter({ hasText: 'Сводка дня' })
  await test.step('the row: the schedule, the next run, the switch, «Без проекта» (ПР19)', async () => {
    await expect(row).toContainText('Ежедневно в 10:30')
    // A task of no project says so (docs/plan/84-projects.md, ПР19; Зп57 before projects came back).
    await expect(row).toContainText('Без проекта')
    await expect(row).toContainText(/Следующий запуск: (сегодня|завтра) в 10:30/)
    await expect(row).toContainText('Ещё не запускалась')
  })

  await test.step('paused and resumed with the switch', async () => {
    const toggle = row.getByRole('switch', { name: 'Включить задачу «Сводка дня»' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(row).toContainText('На паузе')
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(row).toContainText(/Следующий запуск:/)
    await expect(toggle).toBeChecked()
  })

  await test.step('«Запустить сейчас» opens the chat of the run', async () => {
    await row.getByRole('button', { name: 'Действия с задачей «Сводка дня»' }).click()
    await page.getByRole('menuitem', { name: 'Запустить сейчас' }).click()
    await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)
    // The chat takes the name of the task (Зп17).
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка дня')
  })

  await test.step('the page of the task names its run by hand and leads to its chat', async () => {
    await page.goto('/scheduled')
    await row.getByRole('link', { name: 'Сводка дня' }).click()
    // The first visit of a task's page in the run: `next dev` compiles the route before it
    // answers the navigation, which takes longer than an expectation waits on a busy machine.
    await expect(page).toHaveURL(/\/scheduled\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка дня')
    await expect(page.getByText('Пришли курс доллара, евро и юаня по ЦБ на сегодня.')).toBeVisible()
    const runs = page.getByRole('list', { name: 'Запуски' }).getByRole('listitem')
    await expect(runs).toHaveCount(1)
    await expect(runs.first()).toContainText('вручную')
    await expect(runs.first().getByRole('link', { name: /^Открыть чат запуска/ })).toHaveAttribute(
      'href',
      /\/chats\/[0-9a-f-]{36}$/,
    )
  })

  await test.step('deleted after the question; its chat stays', async () => {
    await page.getByRole('button', { name: 'Ещё действия' }).click()
    await page.getByRole('menuitem', { name: 'Удалить' }).click()
    const confirm = page.getByRole('dialog', { name: 'Удалить задачу «Сводка дня»?' })
    await expect(confirm).toContainText('Чаты прошлых запусков останутся.')
    await confirm.getByRole('button', { name: 'Удалить' }).click()
    await expect(page).toHaveURL(/\/scheduled$/)
    // The page of the task is gone: «Ваши» says what became of it.
    await expect(page.getByText('Задача удалена')).toBeVisible()
    await expect(page.getByText('Запланированных задач пока нет.')).toBeVisible()
    await page.goto('/chats')
    await expect(
      page.getByRole('navigation', { name: 'Чаты' }).getByRole('link', { name: /Сводка дня/ }),
    ).toBeVisible()
  })
})

test('a template opens the window on its place to fill in, and makes a task once it is written over (Зп9, Зп59)', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/scheduled/templates')
  await expect(
    page.getByRole('navigation', { name: 'Запланированные задачи' }).getByRole('link', {
      name: 'Шаблоны',
    }),
  ).toHaveAttribute('aria-current', 'page')
  // None of the six needs a project (Зп58).
  await expect(page.getByText('Нужен проект')).toHaveCount(0)

  const dialog = windowOf(page)
  const instructions = dialog.getByRole('textbox', { name: 'Что сделать агенту' })
  await test.step('the place is chosen and said quietly; «Создать» sends nothing while it is left', async () => {
    await page.getByRole('button', { name: 'Проверка сайта' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Название' })).toHaveValue('Проверка сайта')
    await expect(instructions).toBeFocused()
    expect(
      await instructions.evaluate((field: HTMLTextAreaElement) =>
        field.value.slice(field.selectionStart, field.selectionEnd),
      ),
    ).toBe('[впишите адрес сайта]')
    await expect(dialog.getByText('Замените текст в квадратных скобках своим')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Размышление: Низкое' })).toBeVisible()
    // The pill of a project beside it, «Без проекта» by default (ПР19, ПР30).
    await expect(dialog.getByRole('button', { name: 'Без проекта' })).toBeVisible()
    const create = dialog.getByRole('button', { name: 'Создать' })
    await expect(create).toBeEnabled()
    await create.click()
    await expect(dialog).toBeVisible()
    await expect(instructions).toHaveAttribute('aria-invalid', 'true')
    await expect(instructions).toBeFocused()
  })

  await test.step('what is typed writes the place over, and the task is made', async () => {
    await page.keyboard.type('kofe.example')
    await expect(instructions).toHaveValue(/^Открой сайт kofe\.example и пройди главную/)
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Проверка сайта' })).toHaveAccessibleDescription(
      /Уже настроен/,
    )
    await page
      .getByRole('navigation', { name: 'Запланированные задачи' })
      .getByRole('link', { name: 'Ваши' })
      .click()
    const row = list(page).getByRole('listitem').filter({ hasText: 'Проверка сайта' })
    await expect(row).toContainText('По будням в 9:00')
  })
})

test('the window on a phone takes the whole screen, its buttons at the bottom (Зп7)', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/scheduled')
  // The list is empty: on a phone its own «Настроить вручную» opens the window (Зп4).
  await page.getByRole('button', { name: 'Настроить вручную' }).click()
  const dialog = windowOf(page)
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box?.width).toBe(375)
  expect(box?.height).toBe(812)
  const create = await dialog.getByRole('button', { name: 'Создать' }).boundingBox()
  expect((create?.y ?? 0) + (create?.height ?? 0)).toBeGreaterThan(812 - 80)
  // Seven days in a row and no sideways scroll inside the window.
  await dialog.getByRole('combobox', { name: 'Как часто' }).click()
  await page.getByRole('option', { name: 'Еженедельно' }).click()
  const days = dialog.getByRole('group', { name: 'Дни недели' }).getByRole('button')
  await expect(days).toHaveCount(7)
  const first = await days.first().boundingBox()
  const last = await days.last().boundingBox()
  expect(first?.y).toBe(last?.y)
  await expectNoSidewaysScroll(page)
  await dialog.getByRole('button', { name: 'Отмена' }).click()
  await expect(dialog).toBeHidden()
})

test('«Настроить в чате» opens a new chat with the words in the field, unsent (Зп10)', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/scheduled')
  await page.getByRole('button', { name: 'Настроить в чате' }).click()
  await expect(page).toHaveURL(/\/chats\/new$/)
  await expect(page.getByRole('textbox', { name: 'Сообщение' })).toHaveValue(
    'Помогите настроить запланированную задачу',
  )
})
