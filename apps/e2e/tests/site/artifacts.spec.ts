import { expect, test } from '../../fixtures/signed-in.ts'

import { addDocument, agentWrites, attachToChat, expireArtifactReaderSession } from './artifacts.ts'
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
    await expect(page.getByRole('textbox', { name: 'Текст раздела «О нас»' })).toHaveCount(0)
    await expect(page.locator('#section-onas p')).toHaveText('Совсем другой текст.')

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

test('a private quote note survives reload and a removed section', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  const { id } = await addDocument(signedInUser.id, {
    title: 'Тексты для пекарни',
    sections: [
      { key: 'onas', heading: 'О нас', text: 'Печём **хлеб** &amp; булочки.' },
      { key: 'dostavka', heading: 'Доставка', text: 'Утром.' },
    ],
  })
  await page.goto(`/artifacts/${id}`)
  const first = page.locator('#section-onas p')
  const last = page.locator('#section-dostavka p')
  await expect(first).toHaveText('Печём хлеб & булочки.')
  await expect(last).toBeVisible()
  const add = page.getByRole('button', { name: 'Добавить заметку к цитате' })
  await first.evaluate((paragraph) => {
    const range = document.createRange()
    range.setStartBefore(paragraph)
    range.setEndAfter(document.querySelector('#section-dostavka p')!)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await expect(add).toHaveCount(0)
  await first.evaluate((paragraph) => {
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await add.click()
  const dialog = page.getByRole('dialog', { name: 'Заметка к цитате' })
  await expect(dialog.getByText('Печём хлеб & булочки.')).toBeVisible()
  const body = 'Уточнить ассортимент на завтра.'
  await dialog.getByRole('textbox', { name: 'Заметка' }).fill(body)
  await dialog.getByRole('button', { name: 'Сохранить заметку' }).click()

  const notes = page.getByRole('region', { name: 'Заметки к документу' })
  await expect(notes.getByText(body)).toBeVisible()
  await page.reload()
  await expect(notes.getByText(body)).toBeVisible()
  await notes.getByRole('button', { name: 'Отметить решённой' }).click()
  await expect(notes.getByText(body)).toHaveCount(0)
  await notes.getByRole('button', { name: 'Решённые', exact: true }).click()
  await expect(notes.getByText(body)).toBeVisible()
  await notes.getByRole('button', { name: 'Открыть заново' }).click()
  await notes.getByRole('button', { name: 'Нерешённые', exact: true }).click()
  await expect(notes.getByText(body)).toBeVisible()

  await page.getByRole('button', { name: 'Действия с разделом «О нас»' }).click()
  await page.getByRole('menuitem', { name: 'Удалить раздел' }).click()
  await expect(first).toHaveCount(0)
  await expect(notes.getByText('Место изменилось')).toBeVisible()
  await expect(notes.getByText(body)).toBeVisible()

  await last.evaluate((paragraph) => {
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await add.click()
  await dialog.getByRole('textbox', { name: 'Заметка' }).fill('Незаконченная заметка.')
  const otherTab = await page.context().newPage()
  try {
    await otherTab.goto(`/artifacts/${id}`)
    await otherTab.getByRole('button', { name: 'В корзину', exact: true }).click()
    await expect(otherTab).toHaveURL(/\/artifacts$/)
  } finally {
    await otherTab.close()
  }
  await page.bringToFront()
  await expect(page.getByText('Артефакт не найден, или к нему нет доступа.')).toBeVisible({
    timeout: 15_000,
  })
  await expect(notes).toHaveCount(0)
  await expect(dialog).toHaveCount(0)
  await expect(last).toHaveCount(0)
})

test('private note replies on the document and in its chat tab survive a lost response', async ({
  page,
  signedInUser,
}) => {
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const title = 'Условия доставки'
  const { id } = await addDocument(signedInUser.id, {
    title,
    sections: [{ key: 'delivery', heading: 'Доставка', text: 'Доставляем утром.' }],
  })
  const { taskId } = await addAnsweredChat(signedInUser.id, {
    words: 'Напишите про доставку',
    answer: 'Готово.',
    thought: 'Доставка.',
  })
  await attachToChat(id, taskId)

  const notes = page.getByRole('region', { name: 'Заметки к документу' })
  const replyDialog = page.getByRole('dialog', { name: 'Ответ на заметку' })
  const reply = replyDialog.getByRole('textbox', { name: 'Ответ', exact: true })
  const saveReply = replyDialog.getByRole('button', { name: 'Сохранить ответ', exact: true })
  const noteBody = 'Уточнить время доставки.'
  const pageReply = 'Курьер выезжает в девять.'
  const tabReply = 'По субботам курьер выезжает в десять.'

  await test.step('save a reply on the document page', async () => {
    await page.goto(`/artifacts/${id}`)
    const paragraph = page.locator('#section-delivery p')
    await expect(paragraph).toHaveText('Доставляем утром.')
    await paragraph.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await page.getByRole('button', { name: 'Добавить заметку к цитате' }).click()
    const dialog = page.getByRole('dialog', { name: 'Заметка к цитате' })
    await dialog.getByRole('textbox', { name: 'Заметка' }).fill(noteBody)
    await dialog.getByRole('button', { name: 'Сохранить заметку' }).click()
    await expect(notes.getByText(noteBody, { exact: true })).toBeVisible()
    await notes.getByRole('button', { name: 'Ответить', exact: true }).click()
    await reply.fill(pageReply)
    await saveReply.click()
    await expect(reply).toHaveCount(0)
    await expect(notes.getByText(pageReply, { exact: true })).toBeVisible()
  })

  await test.step('retry from the chat tab after the server saved the first attempt', async () => {
    await page.goto(`/chats/${taskId}`)
    await page.getByRole('button', { name: /^Инструменты/ }).click()
    await page.getByRole('menuitem', { name: title }).click()
    await expect(notes.getByText(pageReply, { exact: true })).toBeVisible()
    await notes.getByRole('button', { name: 'Ответить', exact: true }).click()
    await reply.fill(tabReply)

    const origin = new URL(page.url()).origin
    const writesReply = (url: URL) =>
      url.origin === origin && url.pathname === '/api/trpc/artifact.addCommentReply'
    const idFrom = (json: unknown) =>
      (json as { result?: { data?: { json?: { id?: string } } } }).result?.data?.json?.id

    await page.context().setOffline(true)
    try {
      await saveReply.click()
      await expect(replyDialog.getByRole('alert')).toContainText('Не удалось сохранить ответ.')
      await expect(reply).toHaveValue(tabReply)
    } finally {
      await page.context().setOffline(false)
    }
    await expect(saveReply).toBeEnabled()
    let savedId: string | undefined
    await page.route(
      writesReply,
      async (route) => {
        // Do not fake the write: only lose the response to the browser, after the real server answers.
        try {
          const response = await route.fetch({ maxRedirects: 0 })
          if (response.ok()) savedId = idFrom(await response.json())
        } finally {
          await route.abort()
        }
      },
      { times: 1 },
    )
    await Promise.all([
      page.waitForEvent('requestfailed', (request) => writesReply(new URL(request.url()))),
      saveReply.click(),
    ])
    expect(savedId).toEqual(expect.any(String))
    await expect(saveReply).toBeEnabled()
    await expect(reply).toHaveValue(tabReply)

    const [response] = await Promise.all([
      page.waitForResponse((candidate) => writesReply(new URL(candidate.url()))),
      saveReply.click(),
    ])
    expect(response.ok()).toBe(true)
    expect(idFrom(await response.json())).toBe(savedId)
    await expect(reply).toHaveCount(0)
    await expect(notes.getByText(tabReply, { exact: true })).toBeVisible()
  })

  await page.goto(`/artifacts/${id}`)
  await expect(notes.getByText(noteBody, { exact: true })).toBeVisible()
  await expect(notes.getByText(pageReply, { exact: true })).toBeVisible()
  const savedReply = notes.getByText(tabReply, { exact: true })
  await expect(savedReply).toBeVisible()
  await expect(savedReply).toHaveCount(1)
})

for (const { surface, reason } of [
  { surface: 'page', reason: 'session expiry' },
  { surface: 'tab', reason: 'session expiry' },
  { surface: 'page', reason: 'note refused while document read fails' },
  { surface: 'tab', reason: 'note refused while document read fails' },
  { surface: 'page', reason: 'account switch' },
] as const) {
  test(`${reason} hides the document and private notes on its ${surface}`, async ({
    page,
    signedInUser,
    accounts,
    context,
  }) => {
    await hideDevIndicator(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    const { id } = await addDocument(signedInUser.id, {
      title: 'Тексты для подписчиков',
      sections: [{ key: 'onas', heading: 'О нас', text: 'Работаем до десяти.' }],
    })
    if (surface === 'tab') {
      const { taskId } = await addAnsweredChat(signedInUser.id, {
        words: 'Напишите про график',
        answer: 'Готово.',
        thought: 'График.',
      })
      await attachToChat(id, taskId)
      await page.goto(`/chats/${taskId}`)
      await page.getByRole('button', { name: /^Инструменты/ }).click()
      await page.getByRole('menuitem', { name: /Тексты для подписчиков/ }).click()
    } else {
      await page.goto(`/artifacts/${id}`)
    }

    const paragraph = page.locator('#section-onas p')
    const notes = page.getByRole('region', { name: 'Заметки к документу' })
    const dialog = page.getByRole('dialog', { name: 'Заметка к цитате' })
    await expect(paragraph).toHaveText('Работаем до десяти.')
    await expect(notes).toBeVisible()
    const openNote = async () => {
      await paragraph.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
      await page.getByRole('button', { name: 'Добавить заметку к цитате' }).click()
    }
    await openNote()
    const body = 'Проверить график на выходных.'
    await dialog.getByRole('textbox', { name: 'Заметка' }).fill(body)
    await dialog.getByRole('button', { name: 'Сохранить заметку' }).click()
    await expect(notes.getByText(body)).toBeVisible()
    await openNote()
    await dialog.getByRole('textbox', { name: 'Заметка' }).fill('Несохранённая заметка.')
    const url = page.url()

    const assertHidden = async () => {
      await expect(paragraph).toHaveCount(0)
      await expect(notes).toHaveCount(0)
      await expect(dialog).toHaveCount(0)
    }
    if (reason === 'account switch') {
      // The old tab cannot refresh its data; the new cabinet still signals it locally.
      await page.route('**/api/trpc/**', (route) => route.abort())
      const next = await accounts.create()
      try {
        await context.addCookies(next.cookies)
        const other = await context.newPage()
        await other.goto('/chats')
        await expect(page.getByText('Вход изменился. Откройте кабинет заново.')).toBeVisible()
        await expect(page).toHaveURL(url)
        await assertHidden()
        await other.close()
      } finally {
        await accounts.remove(next.user.id)
      }
    } else {
      if (reason === 'note refused while document read fails') {
        const readsDocument = (url: string) =>
          new URL(url).pathname.split('/').at(-1)?.split(',').includes('artifact.read') ?? false
        await page.route(
          (url) => readsDocument(url.href),
          (route) => route.abort(),
        )
        await expireArtifactReaderSession(signedInUser.id)
        const failedRead = page.waitForEvent('requestfailed', (request) =>
          readsDocument(request.url()),
        )
        // The mutation gets a real refusal; the document cannot learn it from its own read.
        await dialog.getByRole('button', { name: 'Сохранить заметку' }).click()
        await failedRead
        await expect(page.getByText('Артефакт не найден, или к нему нет доступа.')).toBeVisible()
        await expect(page).toHaveURL(url)
      } else {
        await expireArtifactReaderSession(signedInUser.id)
        // The cabinet can notice the expired session before the document's own poll.
        await expect(
          page
            .getByText('Артефакт не найден, или к нему нет доступа.')
            .or(page.getByRole('heading', { name: 'Вход в кабинет' })),
        ).toBeVisible({ timeout: 15_000 })
      }
      await assertHidden()
    }
  })
}

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
