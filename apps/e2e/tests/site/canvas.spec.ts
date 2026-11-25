import { expect, test } from '../../fixtures/signed-in.ts'

import { addFromTemplate } from './artifacts.ts'
import { addProject, hideDevIndicator } from './site.ts'

// «Холст» in the cabinet (docs/plan/88-artifacts.md, Ар8, Ар49, §7.7; slice 88.15; spike 6), in
// Chromium and WebKit (the project `webkit` of playwright.site.config.ts runs this file too): the
// overview holds no frame, a nearer look holds at most four live ones under their covers, the wheel
// over a frame moves the board, a screen opens whole in the colours of the canvas's own style
// (docs/plan/93-artifacts-trim.md, АТ5); on a phone the board is a list. No core runs here:
// thumbnails stay «Рисуем».

test('a canvas: no frame on the overview, at most four near, the wheel moves the board', async ({
  page,
  signedInUser,
}) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Пекарня' })
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

  // A screen chosen from the keyboard opens whole, in the colours of the canvas's common style.
  await board.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('toolbar', { name: 'Выбранный экран' })).toContainText('Главная')
  await page.getByRole('button', { name: 'Открыть', exact: true }).click()
  // The screen stands in place of the board (АТ6), «Все экраны» brings the board back.
  const viewTitle = 'Экран «Холст для нового сайта»'
  const opened = page.locator(`iframe[title="${viewTitle}"]`)
  await expect(opened).toHaveAttribute('sandbox', 'allow-scripts')
  // The heading takes --primary of the template's own style (#2f5d50).
  await expect(page.frameLocator(`iframe[title="${viewTitle}"]`).locator('h1')).toHaveCSS(
    'color',
    'rgb(47, 93, 80)',
  )
  await page.getByRole('button', { name: 'Все экраны' }).click()
  await expect(page.getByTestId('canvas-board')).toBeVisible()
})

test('a canvas on a phone is a list of screens', async ({ page, signedInUser }) => {
  const { projectId } = await addProject(signedInUser.id, { name: 'Кафе' })
  const { id } = await addFromTemplate(signedInUser.id, 'new-site', projectId)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/artifacts/${id}`)
  await hideDevIndicator(page)
  const list = page.getByRole('list', { name: 'Экраны холста' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(page.getByTestId('canvas-board')).toHaveCount(0)
})
