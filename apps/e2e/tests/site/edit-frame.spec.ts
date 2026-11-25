import { expect, test } from '../../fixtures/signed-in.ts'

import { addFromTemplate } from './artifacts.ts'
import { hideDevIndicator } from './site.ts'

// A screen of «Холст» in the cabinet (docs/plan/88-artifacts.md, §7.7, Ар9, Ар28; slice 88.13; the
// mockup became a canvas with one screen, docs/plan/93-artifacts-trim.md, АТ6), in Chromium and
// WebKit (the project `webkit` of playwright.site.config.ts runs this file; Firefox does not start
// on macOS — its frames are checked by `pnpm verify:artifacts` in Docker): the calculator of the
// template opens straight on its one screen and runs in the frame of the root of the pages, the
// devices change its width, its code is read only, its «Настройки» change its numbers, and «Править текст» edits a heading in the edit
// frame where no script runs — the pointer on the cabinet's layer, the text by native
// contenteditable.

test('a screen of a canvas: the frame, the devices, the code, the settings and «Править текст»', async ({
  page,
  signedInUser,
}) => {
  const { id } = await addFromTemplate(signedInUser.id, 'cost-calculator')
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(`/artifacts/${id}`)
  await hideDevIndicator(page)
  // A canvas of one screen opens straight on that screen, no board (АТ6).
  await expect(page.getByTestId('canvas-board')).toHaveCount(0)
  const toolbar = page.getByRole('toolbar', { name: 'Действия с экраном' })

  const viewTitle = 'Экран «Калькулятор стоимости»'
  const view = page.frameLocator(`iframe[title="${viewTitle}"]`)
  await expect(page.locator(`iframe[title="${viewTitle}"]`)).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  )
  // The script of the screen ran there and read its settings.
  await expect(view.locator('#total')).toContainText('Итого')
  await expect(view.locator('#note')).toHaveText(
    'Точную цену назовём после замера — это бесплатно.',
  )

  await page.getByRole('button', { name: 'Телефон, 390' }).click()
  await expect(page.locator(`iframe[title="${viewTitle}"]`)).toHaveCSS('width', '390px')

  // «Показать код» is in «⋯» (АТ7).
  await toolbar.getByRole('button', { name: 'Ещё', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Показать код' }).click()
  await expect(page.getByRole('region', { name: 'HTML' })).toContainText('Рассчитайте стоимость')
  await page.getByRole('button', { name: 'Вернуться к экрану' }).click()

  // «Настройки», open beside the screen: a number of the JSON, saved; the frame shows the new price.
  await page.getByRole('textbox', { name: 'pricePerSquareMeter' }).fill('10000')
  await page.getByRole('button', { name: 'Сохранить настройки' }).click()
  await expect(page.getByText('Настройки сохранены.')).toBeVisible()
  // 1,2 × 1,4 m × 10 000 ₽ = 16 800 ₽.
  await expect(view.locator('#total')).toHaveText(/Итого: 16\s800\s₽/)

  // «Править текст»: the edit frame, without scripts.
  await toolbar.getByRole('button', { name: 'Править текст' }).click()
  const editTitle = 'Экран «Калькулятор стоимости» для правки текста'
  const editFrame = page.locator(`iframe[title="${editTitle}"]`)
  await expect(editFrame).toHaveAttribute('sandbox', 'allow-same-origin')
  await expect(page.getByText(/кнопки и расчёты на экране не работают/)).toBeVisible()
  const edit = page.frameLocator(`iframe[title="${editTitle}"]`)
  // No script of the screen ran: the total is not computed, the note is empty.
  await expect(edit.locator('#total')).toHaveText('—')
  const heading = edit.locator('h1')
  await expect(heading).toHaveText('Рассчитайте стоимость')
  const box = (await heading.boundingBox())!
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2)
  await expect(page.getByRole('button', { name: 'Готово' })).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.type(' окон')
  await expect(heading).toHaveText('Рассчитайте стоимость окон')
  await page.getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Текст сохранён.')).toBeVisible()

  await toolbar.getByRole('button', { name: 'Править текст' }).click()
  await expect(view.locator('h1')).toHaveText('Рассчитайте стоимость окон')
  // The script still runs in the view: the edit changed only the text.
  await expect(view.locator('#total')).toHaveText(/Итого: 16\s800\s₽/)
})
