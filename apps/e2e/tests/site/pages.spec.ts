import { expect, test } from '../../fixtures/signed-in.ts'

import { hideDevIndicator } from './site.ts'

// «Страницы» before the first page in a real browser (docs/plan/73-pages-sites.md, Дер6, Дер7):
// no filters and no search, the first-visit screen fits the width, a request goes into the draft
// of a new chat, and the heading says what the section is under the pointer.

for (const [name, width, height] of [
  ['phone', 375, 812],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
] as const) {
  test(`«Страницы» before the first page on a ${name}`, async ({ page, signedInUser }) => {
    void signedInUser
    await hideDevIndicator(page)
    await page.setViewportSize({ width, height })
    await page.goto('/pages')

    const title = page.getByRole('heading', { name: 'Здесь появятся ваши страницы и сайты' })
    await expect(title).toBeVisible()
    await expect(page.getByRole('group', { name: 'Показать' })).toHaveCount(0)
    await expect(page.getByLabel('Найти по названию')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Начать чат' })).toBeVisible()
    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(scroll.width).toBeLessThanOrEqual(scroll.viewport)

    await test.step('the heading says what the section is under the pointer', async () => {
      await page.getByRole('heading', { level: 1 }).getByText('Страницы').hover()
      await expect(page.getByRole('tooltip')).toContainText(
        'Страницы и сайты, которые агент сделал для вашего рабочего пространства',
      )
    })

    await test.step('a request goes into the draft of a new chat, unsent', async () => {
      await page.mouse.move(0, 0)
      await page.getByRole('button', { name: /Собери прайс-лист/ }).click()
      await expect(page).toHaveURL(/\/chats\/new$/)
      await expect(page.getByRole('textbox').first()).toHaveValue(
        'Собери прайс-лист страницей и опубликуй по ссылке',
      )
    })
  })
}
