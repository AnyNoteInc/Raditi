import { expect, test } from '../../fixtures/signed-in.ts'

import { addFromTemplate } from './artifacts.ts'
import { addProject, hideDevIndicator } from './site.ts'

// «Холст» and «Фирменный стиль» in the cabinet (docs/plan/88-artifacts.md, Ар8, Ар49, §7.7; slices
// 88.15, 88.15а; spike 6), in Chromium and WebKit (the project `webkit` of playwright.site.config.ts
// runs this file too): the overview holds no frame, a nearer look holds at most four live ones under
// their covers, the wheel over a frame moves the board, a screen opens whole and stands in the brand
// of its project; on a phone the board is a list. No core runs here: thumbnails stay «Рисуем».

test('a canvas: no frame on the overview, at most four near, the wheel moves the board', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Пекарня' })
  await addFromTemplate(signedInUser.id, 'brand', projectId)
  const { id } = await addFromTemplate(signedInUser.id, 'new-site', projectId)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(`/artifacts/${id}`)
  await hideDevIndicator(page)
  const board = page.getByTestId('canvas-board')
  await expect(page.getByTestId('canvas-screen')).toHaveCount(3)
  // The overview: the whole canvas, every view a thumbnail (or its place while it is drawn).
  await expect(board.locator('iframe')).toHaveCount(0)

  // Nearer: the frames in view become live, four at most, each under its cover.
  await board.focus()
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('+')
  await expect
    .poll(async () => board.locator('iframe').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect(await board.locator('iframe').count()).toBeLessThanOrEqual(4)
  for (const frame of await board.locator('iframe').all()) {
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    await expect(frame).toHaveCSS('pointer-events', 'none')
  }

  // The wheel over a frame moves the board, not the frame (WebKit on macOS too: the cover).
  const surface = page.getByTestId('canvas-surface')
  const before = await surface.evaluate((node) => (node as HTMLElement).style.transform)
  const frame = board.locator('iframe').first()
  const box = (await frame.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200))
  await page.mouse.wheel(0, 400)
  await expect
    .poll(async () => surface.evaluate((node) => (node as HTMLElement).style.transform))
    .not.toBe(before)

  // A screen chosen from the keyboard opens whole, in the brand of its project.
  await board.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('toolbar', { name: 'Выбранный экран' })).toContainText('Главная')
  await page.getByRole('button', { name: 'Открыть', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const viewTitle = 'Макет «Холст для нового сайта»'
  const opened = dialog.locator(`iframe[title="${viewTitle}"]`)
  await expect(opened).toHaveAttribute('sandbox', 'allow-scripts')
  // The heading takes --brand-primary of the brand (#2f5d50).
  await expect(dialog.frameLocator(`iframe[title="${viewTitle}"]`).locator('h1')).toHaveCSS(
    'color',
    'rgb(47, 93, 80)',
  )
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
})

test('a canvas on a phone is a list of screens, a brand is its tokens and a sample', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Кафе' })
  const brand = await addFromTemplate(signedInUser.id, 'brand', projectId)
  const { id } = await addFromTemplate(signedInUser.id, 'new-site', projectId)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/artifacts/${id}`)
  await hideDevIndicator(page)
  const list = page.getByRole('list', { name: 'Экраны холста' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(page.getByTestId('canvas-board')).toHaveCount(0)

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/artifacts/${brand.id}`)
  await hideDevIndicator(page)
  await expect(page.getByRole('textbox', { name: 'Основной цвет' })).toHaveValue('#2f5d50')
  await expect(page.getByTestId('brand-sample')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Тон текстов' }).first()).toContainText('на «вы»')
})
