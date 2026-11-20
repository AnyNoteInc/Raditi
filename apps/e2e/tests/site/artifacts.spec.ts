import { expect, test } from '../../fixtures/signed-in.ts'

import { addDocument, agentWrites, attachToChat } from './artifacts.ts'
import { addAnsweredChat, hideDevIndicator } from './site.ts'

// «Артефакты» in a real browser (docs/plan/88-artifacts.md, stage Э4: 88.9–88.11б): the gallery
// before the first one and «Создать» from a template, a section edited in Tiptap and kept, a
// section an agent writes taken back, the history with «Вернуть эту версию», «Опубликовать как
// страницу», the tab of an artifact beside the chat and `@` that names it. No core runs: what an
// agent writes is written into the database as core would leave it.

test('the gallery before the first artifact, and a document from a template', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/artifacts')
  await expect(page.getByRole('link', { name: 'Артефакты', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('heading', { name: 'Здесь будут ваши артефакты' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Показать' })).toHaveCount(0)

  await page.getByRole('button', { name: /Правила возврата/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый артефакт' })
  await expect(dialog.getByRole('radio', { name: /Схема/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(dialog.getByRole('textbox', { name: 'Название' })).toHaveValue('Правила возврата')
  await dialog.getByRole('button', { name: 'Создать' }).click()

  await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Правила возврата' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Сроки' })).toBeVisible()

  await page.getByRole('link', { name: 'Артефакты', exact: true }).first().click()
  await expect(page.getByRole('link', { name: 'Открыть «Правила возврата»' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Поиск по артефактам' }).fill('течение')
  await expect(page.getByRole('link', { name: 'Открыть «Правила возврата»' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Поиск по артефактам' }).fill('нет такого слова')
  await expect(page.getByText('Ничего не нашлось.')).toBeVisible()
})

test('a section edited in place, a section the agent writes taken back, and the history', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const { id } = await addDocument(signedInUser.id, {
    title: 'Тексты для лендинга',
    sections: [
      { key: 'onas', heading: 'О нас', text: 'Печём с 1998 года.' },
      { key: 'dostavka', heading: 'Доставка', text: 'Привозим с 9 до 21.' },
    ],
  })
  await page.goto(`/artifacts/${id}`)
  await expect(page.getByRole('heading', { name: 'О нас' })).toBeVisible()

  await test.step('the editor of a section keeps what the person typed', async () => {
    await page.getByRole('button', { name: 'Править раздел «О нас»' }).click()
    const text = page.getByRole('textbox', { name: 'Текст раздела «О нас»' })
    await expect(text).toBeVisible()
    await text.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Муку берём у одной мельницы.')
    await page.getByRole('button', { name: 'Готово' }).click()
    await expect(page.getByText('Печём с 1998 года. Муку берём у одной мельницы.')).toBeVisible()
    await page.reload()
    await expect(page.getByText('Печём с 1998 года. Муку берём у одной мельницы.')).toBeVisible()
  })

  await test.step('a section an agent writes waits for the person, who takes it back', async () => {
    const { taskId } = await addAnsweredChat(signedInUser.id, {
      words: 'Допишите доставку',
      answer: 'Пишу раздел «Доставка».',
      thought: 'Раздел доставки.',
    })
    await attachToChat(id, taskId)
    await agentWrites(id, taskId, { block: 'dostavka', text: 'Привозим с 8 до 22.' })
    await page.reload()
    await expect(page.getByText('текст появится, как только мы его проверим')).toHaveCount(0)
    await expect(page.getByText(/Пишет агент/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Править раздел «Доставка»' }).click()
    await expect(page.getByText('Агент пишет — вы ждёте')).toBeVisible()
    await page.getByRole('button', { name: 'Забрать правку' }).click()
    await expect(page.getByText('Агент пишет — вы ждёте')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Текст раздела «Доставка»' })).toBeVisible()
    await page.getByRole('button', { name: 'Готово' }).click()
  })

  await test.step('the history keeps a named version and returns it', async () => {
    await page.getByRole('button', { name: 'История версий' }).click()
    const history = page.getByRole('region', { name: 'История версий' })
    await history.getByRole('button', { name: 'Сохранить текущую как версию…' }).click()
    await history.getByRole('textbox', { name: 'Название версии' }).fill('Показала маме')
    await history.getByRole('button', { name: 'Сохранить' }).click()
    await expect(history.getByText('«Показала маме»')).toBeVisible()
    await page.getByRole('button', { name: 'Закрыть историю' }).click()

    await page.getByRole('button', { name: 'Править раздел «О нас»' }).click()
    await page.getByRole('textbox', { name: 'Текст раздела «О нас»' }).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Совсем другой текст.')
    await page.getByRole('button', { name: 'Готово' }).click()
    await expect(page.getByText('Совсем другой текст.')).toBeVisible()

    await page.getByRole('button', { name: 'История версий' }).click()
    // The edit since made a version of its own: the named one is no longer the current one.
    await expect(history.locator('li', { hasText: '«Показала маме»' })).not.toContainText('сейчас')
    await history.getByText('«Показала маме»').click()
    await history.getByRole('button', { name: 'Вернуть эту версию' }).click()
    const confirm = page.getByRole('dialog', { name: /Вернуть версию \d+\?/ })
    await expect(confirm.getByText(/Изменится разделов: 1\./)).toBeVisible()
    await confirm.getByRole('button', { name: 'Вернуть' }).click()
    await expect(history.getByText(/Готово: сохранено как версия/)).toBeVisible()
    await page.getByRole('button', { name: 'Закрыть историю' }).click()
    await expect(page.getByText('Печём с 1998 года. Муку берём у одной мельницы.')).toBeVisible()
  })

  await test.step('«Опубликовать как страницу» gives the address of the page', async () => {
    await page.getByRole('button', { name: 'Опубликовать как страницу' }).click()
    const dialog = page.getByRole('dialog', { name: 'Опубликовать как страницу' })
    await dialog.getByRole('button', { name: 'Опубликовать' }).click()
    await expect(dialog.getByText('Готово: страница опубликована.')).toBeVisible()
    await expect(dialog.getByRole('link', { name: /pages\.localhost/ })).toBeVisible()
    await dialog.getByRole('button', { name: 'Закрыть' }).click()
    await expect(page.getByRole('button', { name: 'Обновить страницу' })).toBeVisible()
  })
})

test('the tab of an artifact beside the chat, and «@» that names an artifact', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const { id } = await addDocument(signedInUser.id, {
    title: 'План продвижения',
    sections: [{ key: 'cel', heading: 'Цель месяца', text: 'Двадцать заявок с сайта.' }],
  })
  const { taskId } = await addAnsweredChat(signedInUser.id, {
    words: 'Сделайте план продвижения',
    answer: 'План готов.',
    thought: 'План.',
  })
  await attachToChat(id, taskId)
  await page.goto(`/chats/${taskId}`)

  await test.step('«+» names the artifact among those made here, and opens its tab', async () => {
    await page.getByRole('button', { name: /^Инструменты/ }).click()
    const menu = page.getByRole('menu', { name: 'Инструменты' })
    await expect(
      menu.getByRole('separator', { name: 'Артефакты чата · Сделаны здесь' }),
    ).toBeVisible()
    await menu.getByRole('menuitem', { name: /План продвижения/ }).click()
    const tab = page.locator(`#dialog-pane-tab-artifact-${id}`)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    const panel = page.locator(`#dialog-pane-panel-artifact-${id}`)
    await expect(panel.getByText('Двадцать заявок с сайта.')).toBeVisible()
    await expect(panel.getByRole('link', { name: 'Во весь экран' })).toHaveAttribute(
      'href',
      `/artifacts/${id}`,
    )
  })

  await test.step('«@» in the field names the artifact as `@artifact:<id>`', async () => {
    const field = page.getByRole('textbox', { name: 'Сообщение' })
    await field.click()
    await field.fill('Дополни @План')
    const option = page.getByRole('option', { name: 'Артефакт «План продвижения»' })
    await expect(option).toBeVisible()
    await option.click()
    await expect(field).toHaveValue(`Дополни @artifact:${id} `)
  })
})

// «Таблица» (docs/plan/88-artifacts.md, §7.7; slice 88.14): a price list of the template, a cell
// typed from the keyboard, a block pasted from Excel adding a row, sorting by request, CSV in the
// browser, and the cards of the phone with the sheet of a row.
test('a price list: a cell typed, a paste from Excel, sorting, CSV and the cards of a phone', async ({
  page,
  signedInUser,
}) => {
  void signedInUser
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/artifacts')
  await page.getByRole('button', { name: /Прайс-лист/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый артефакт' })
  await dialog.getByRole('button', { name: 'Создать' }).click()
  await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}$/)
  const grid = page.getByRole('grid', { name: 'Таблица «Прайс-лист»' })
  await expect(grid.getByRole('columnheader', { name: 'Цена, ₽' })).toBeVisible()
  const cell = (text: string | RegExp) =>
    grid.getByRole('gridcell').filter({ hasText: text }).first()
  await expect(cell('[Товар]')).toBeVisible()
  // The totals are the server's: 990 + 1 500 + 300.
  await expect(grid.getByRole('row').filter({ hasText: 'Итого' })).toContainText(/2\s790/)

  await test.step('a cell typed from the keyboard is kept', async () => {
    await cell('[Товар]').click()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight')
    await page.keyboard.type('1250')
    await page.keyboard.press('Enter')
    await expect(cell(/1\s250/)).toBeVisible()
    await page.reload()
    await expect(cell(/1\s250/)).toBeVisible()
  })

  await test.step('a block from Excel goes right and down and adds a row past the end', async () => {
    await cell('[Доставка по городу]').click()
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Курьер\tДоставка\r\nПирог\tТовары\tшт\t450\r\n')
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    })
    await expect(page.getByText(/добавлено строк: 1/)).toBeVisible()
    await expect(cell('Пирог')).toBeVisible()
    await expect(cell('Курьер')).toBeVisible()
  })

  await test.step('sorting by request, and CSV for Excel', async () => {
    await page.getByRole('combobox', { name: 'Сортировать' }).click()
    await page.getByRole('option', { name: 'Цена, ₽: по убыванию' }).click()
    const rows = grid.getByRole('row')
    // The head, then the most expensive row.
    await expect(rows.nth(1)).toContainText('[Услуга]')
    await page.getByRole('button', { name: 'Скачать' }).click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV для Excel' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('Прайс-лист.csv')
    const text = await (await download.createReadStream()).toArray()
    const csv = Buffer.concat(text as Buffer[]).toString('utf8')
    expect(csv.startsWith('﻿Название;Категория;Ед.;Цена, ₽;В наличии;Примечание')).toBe(true)
    expect(csv).toContain('[Товар];Товары;шт;1250;да;')
  })

  await test.step('on a phone: a card a row, and the sheet of a row', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    const list = page.getByRole('list', { name: 'Строки таблицы «Прайс-лист»' })
    await expect(list).toBeVisible()
    await list.getByRole('button', { name: /^\[Услуга\], 1\s500 ₽\. Изменить$/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Строка «[Услуга]»' })
    await expect(sheet.getByRole('textbox', { name: 'Цена, ₽' })).toHaveAttribute(
      'inputmode',
      'decimal',
    )
    await sheet.getByRole('textbox', { name: 'Цена, ₽' }).fill('1 600')
    await sheet.getByRole('button', { name: 'Сохранить' }).click()
    await expect(
      list.getByRole('button', { name: /^\[Услуга\], 1\s600 ₽\. Изменить$/ }),
    ).toBeVisible()
  })
})
