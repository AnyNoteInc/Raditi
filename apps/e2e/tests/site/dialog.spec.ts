import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

import { baseURL } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

import { addConnectedSite, hideDevIndicator } from './site.ts'

// A dialog in a real browser (docs/plan/53-chat-preview-release.md, R9): the first words start
// it on a connected site, the screen moves to it, and it waits in the queue — no core works on
// it in this run. The list, the panel of its changes beside it from 1200px and behind a switch
// below, the window of commands with the server's verdicts, and `/cancel` that closes it. The
// run blanks PREVIEW_BASE_DOMAIN (playwright.site.config.ts): the dialog has no preview, and the
// panel says so.

test.use({ reducedMotion: 'reduce' })

const FIRST_WORDS = 'Поменяйте цену капучино на 290 ₽'
const QUEUED = 'Приняли, начинаем'
const QUEUED_TEXT =
  'Агент скоро возьмётся за работу. Страницу можно закрыть — результат появится в этом диалоге.'
const FIELD_OFF = 'Написать можно будет, когда агент закончит или задаст вопрос.'
const NO_PREVIEW = 'У этого диалога пока нет предпросмотра.'

const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const send = (page: Page) => page.getByRole('button', { name: 'Отправить' })
const feed = (page: Page) => page.getByRole('list', { name: 'Сообщения диалога' })
const pane = (page: Page) => page.getByRole('complementary', { name: 'Изменения диалога' })
const dialogs = (page: Page) => page.getByRole('navigation', { name: 'Диалоги' })
const back = (page: Page) => page.getByRole('link', { name: 'Назад к диалогам' })
const commands = (page: Page) => page.getByRole('listbox', { name: 'Команды' })

async function box(target: Locator) {
  const found = await target.boundingBox()
  if (!found) throw new Error('The element has no box: it is not on the screen')
  return found
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

const violations = async (page: Page) => {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return report.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  )
}

/** Heights of the visible links and buttons inside `scope` that are lower than 44px. */
async function lowTargets(scope: Locator): Promise<string[]> {
  const low: string[] = []
  for (const target of await scope.locator('a, button, [role="tab"]').all()) {
    if (!(await target.isVisible())) continue
    const found = await target.boundingBox()
    const label =
      (await target.innerText()).trim() || ((await target.getAttribute('aria-label')) ?? '')
    if (!found) low.push(`${label}: no box`)
    else if (found.height < 44) low.push(`${label}: ${found.height}px`)
  }
  return low
}

/** Writes the first words of a dialog and sends them; returns the id the browser gave it. */
async function startDialog(page: Page, siteId: string): Promise<string> {
  await page.goto(`/projects/${siteId}/chat/new`)
  await message(page).fill(FIRST_WORDS)
  await send(page).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${siteId}/chat/[0-9a-f-]{36}$`))
  const taskId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  // The browser invents the id: a version 7 UUID, the idempotency key of `task.create`.
  expect(taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  return taskId
}

test('a dialog starts from the first words and waits in the queue, on a desktop', async ({
  page,
  context,
  signedInUser,
}) => {
  const siteId = await addConnectedSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const taskId = await startDialog(page, siteId)

  await test.step('the head, the words of the client and the queue', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIRST_WORDS)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page).toHaveTitle(new RegExp(FIRST_WORDS))
    await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
    // The status in the head, in the live block and in the live region that reads it out; the
    // list beside them is folded away.
    await expect(page.getByRole('heading', { level: 2, name: QUEUED })).toBeVisible()
    await expect(page.getByText(QUEUED).filter({ visible: true })).toHaveCount(3)
    await expect(page.getByText(QUEUED_TEXT)).toBeVisible()
    // The agent is at work: the field says why it is closed, on the field itself.
    await expect(message(page)).toBeDisabled()
    await expect(message(page)).toHaveAccessibleDescription(FIELD_OFF)
  })

  await test.step('from 1200px the list gives way to the panel of the changes', async () => {
    await expect(dialogs(page)).toBeHidden()
    await expect(back(page)).toBeVisible()
    await expect(pane(page)).toBeVisible()
    await expect(pane(page).getByRole('tab', { name: 'Предпросмотр' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(pane(page).getByText(NO_PREVIEW)).toBeVisible()
    const paneBox = await box(pane(page))
    const fieldBox = await box(message(page))
    expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(1280)
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(paneBox.x)
    await expectNoSidewaysScroll(page)
    expect(await lowTargets(page.getByRole('main'))).toEqual([])
  })

  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`the rules of axe in the ${scheme} scheme`, async () => {
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await page.reload()
      await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
      expect(await violations(page)).toEqual([])
    })
  }

  await test.step('the window of commands tells what can be done now', async () => {
    await page.getByRole('button', { name: 'Команды' }).click()
    await expect(commands(page)).toBeFocused()
    await expect(commands(page).getByRole('option')).toHaveCount(5)
    const release = commands(page).getByRole('option', { name: /Выпустить новую версию/ })
    await expect(release).toHaveAttribute('aria-disabled', 'true')
    await expect(release).toContainText('Подождите: агент ещё работает.')
    const cancel = commands(page).getByRole('option', { name: /Отменить диалог/ })
    await expect(cancel).not.toHaveAttribute('aria-disabled', 'true')
    expect(await violations(page)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(commands(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Команды' })).toBeFocused()
  })

  await test.step('the dialog stands in the list of the site', async () => {
    await back(page).click()
    await expect(page).toHaveURL(`/projects/${siteId}/chat`)
    const today = dialogs(page).getByRole('list', { name: 'Сегодня' })
    const link = today.getByRole('link', { name: new RegExp(FIRST_WORDS) })
    await expect(link).toHaveAttribute('href', `/projects/${siteId}/chat/${taskId}`)
    await expect(link).toContainText(QUEUED)
    // The credits of the gift stand under the list: one dialog has set some aside.
    await expect(dialogs(page).getByRole('heading', { name: 'Кредиты' })).toBeVisible()
    await link.click()
    await expect(page).toHaveURL(`/projects/${siteId}/chat/${taskId}`)
    await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
  })

  await test.step('`/cancel` asks first, then closes the dialog', async () => {
    await page.getByRole('button', { name: 'Команды' }).click()
    await commands(page)
      .getByRole('option', { name: /Отменить диалог/ })
      .click()
    const confirm = page.getByRole('dialog', { name: 'Отменить диалог?' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Отменить диалог' }).click()
    await expect(confirm).toBeHidden()
    await expect(feed(page).getByRole('heading', { name: 'Отменено' })).toBeVisible()
    await expect(
      page.getByText('Диалог завершён. Чтобы попросить что-то ещё, начните новый.'),
    ).toBeVisible()
    await expect(message(page)).toHaveCount(0)
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Новый диалог' }),
    ).toHaveAttribute('href', `/projects/${siteId}/chat/new`)
    // The words of a command never become a message of the client.
    await expect(feed(page).getByText('/cancel')).toHaveCount(0)
  })
})

test('a dialog on a phone: the switch of the dialog and its changes', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addConnectedSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await startDialog(page, siteId)

  const views = page.getByRole('tablist', { name: 'Что показать' })
  await expect(views.getByRole('tab')).toHaveCount(2)
  await expect(views.getByRole('tab', { name: 'Диалог' })).toHaveAttribute('aria-selected', 'true')
  await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
  await expect(pane(page)).toBeHidden()
  await expectNoSidewaysScroll(page)
  expect(await violations(page)).toEqual([])
  expect(await lowTargets(page.getByRole('main'))).toEqual([])

  await views.getByRole('tab', { name: 'Предпросмотр' }).click()
  await expect(pane(page)).toBeVisible()
  await expect(pane(page).getByText(NO_PREVIEW)).toBeVisible()
  await expect(feed(page)).toBeHidden()
  await expectNoSidewaysScroll(page)
  expect(await violations(page)).toEqual([])
  expect(await lowTargets(pane(page))).toEqual([])
})
