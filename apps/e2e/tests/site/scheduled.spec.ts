import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

import { addConnectedSite, hideDevIndicator, priceDialogClass } from './site.ts'

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
  await expect(links).toHaveCount(4)
  await expect(links.nth(0)).toHaveAccessibleName('Чаты')
  await expect(links.nth(1)).toHaveAccessibleName('Запланированные задачи')
  await expect(links.nth(1)).toHaveAttribute('href', '/scheduled')
  await expect(links.nth(2)).toHaveAccessibleName('Страницы')
  await expect(links.nth(3)).toHaveAccessibleName('Проекты')

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
      // «Новая задача» the whole width under the tabs on a phone (Зп2).
      const button = await newTask(page).boundingBox()
      const main = await page.locator('#application-content').boundingBox()
      expect(button && main && button.width).toBeGreaterThan((main?.width ?? 0) - 48)
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
      .fill('Посмотрите, что нового появилось на сайте, и коротко перечислите.')
    await expect(dialog.getByText(/Задача выполняется без вас/)).toBeVisible()
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
  await test.step('the row: the schedule, no project, the next run, the switch', async () => {
    await expect(row).toContainText('Ежедневно в 10:30')
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
    await expect(page).toHaveURL(/\/scheduled\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка дня')
    await expect(page.getByText('Посмотрите, что нового появилось на сайте')).toBeVisible()
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
    await expect(page.getByText('Запланированных задач пока нет.')).toBeVisible()
    await page.goto('/chats')
    await expect(
      page.getByRole('navigation', { name: 'Чаты' }).getByRole('link', { name: /Сводка дня/ }),
    ).toBeVisible()
  })
})

test('a template opens the window filled in, and a template about a site wants a project (Зп9)', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/scheduled/templates')
  await expect(
    page.getByRole('navigation', { name: 'Запланированные задачи' }).getByRole('link', {
      name: 'Шаблоны',
    }),
  ).toHaveAttribute('aria-current', 'page')

  await test.step('without a project: «Добавьте проект», no «Создать»', async () => {
    await page.getByRole('button', { name: 'Проверка сайта' }).click()
    const dialog = windowOf(page)
    await expect(dialog.getByRole('textbox', { name: 'Название' })).toHaveValue('Проверка сайта')
    await expect(dialog.getByRole('textbox', { name: 'Что сделать агенту' })).toHaveValue(
      /Откройте сайт и пройдите главную/,
    )
    await expect(dialog.getByRole('button', { name: 'Размышление: Низкое' })).toBeVisible()
    await expect(dialog.getByRole('link', { name: 'Добавьте проект' })).toHaveAttribute(
      'href',
      '/projects/new',
    )
    await expect(dialog.getByRole('button', { name: 'Создать' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).toBeHidden()
  })

  await test.step('with the only project: it is chosen, and the task is made from the template', async () => {
    await addConnectedSite(signedInUser.id)
    await page.reload()
    await page.getByRole('button', { name: 'Проверка сайта' }).click()
    const dialog = windowOf(page)
    await expect(
      dialog.getByRole('button', { name: 'Проект для этого чата: Кофейня «Крошка»' }),
    ).toBeVisible()
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
    await expect(row).toContainText('Кофейня «Крошка»')
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
  await openByHand(page)
  const dialog = windowOf(page)
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
