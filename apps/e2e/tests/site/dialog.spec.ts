import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

import { baseURL } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

import {
  addBrowserTask,
  addConnectedSite,
  addLongDialog,
  hideDevIndicator,
  priceDialogClass,
} from './site.ts'

// A dialog in a real browser (docs/plan/53-chat-preview-release.md, R9): the first words start
// it on a connected site, the screen moves to it, and it waits in the queue — no core works on
// it in this run. The list beside it, the window of commands with the server's verdicts, its
// menu — «Переименовать», «Удалить» — and `/cancel` that closes it. Its tools open only when the
// client asks (owner's request of 29.10.2026, docs/plan/59-dialog-tools-panel.md): every dialog
// starts with the chat alone, «+» in the corner of its head lists what the task has, and a tool
// chosen there opens as a tab of the panel on the right — below `lg` in place of the dialog, with
// «К диалогу» leading back. The run blanks PREVIEW_BASE_DOMAIN and BROWSER_STREAM_PUBLIC_URL
// (playwright.site.config.ts): «+» offers no preview, and a browser cannot be shown here. What is
// not read before a tool opens — tickets, frames, the changes — is proven by the tests of
// `DialogView` and by the stands, which have previews, candidates and a stream.

test.use({ reducedMotion: 'reduce' })

// A dialog is taken only in a class whose profile has a price (26.10.2026): the class a dialog
// starts in is priced while these tests run.
let restorePrices: (() => Promise<void>) | undefined
test.beforeAll(async () => {
  restorePrices = await priceDialogClass()
})
test.afterAll(async () => {
  await restorePrices?.()
})

const FIRST_WORDS = 'Поменяйте цену капучино на 290 ₽'
const QUEUED = 'Приняли, начинаем'
const QUEUED_TEXT =
  'Агент скоро возьмётся за работу. Страницу можно закрыть — результат появится в этом диалоге.'
const FIELD_OFF = 'Написать можно будет, когда агент закончит или задаст вопрос.'
const DRAFT = 'Черновик: проверьте ещё цены в разделе «Десерты»'

const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const send = (page: Page) => page.getByRole('button', { name: 'Отправить' })
const feed = (page: Page) => page.getByRole('list', { name: 'Сообщения диалога' })
const dialogs = (page: Page) => page.getByRole('navigation', { name: 'Диалоги' })
const back = (page: Page) => page.getByRole('link', { name: 'Назад к диалогам' })
const commands = (page: Page) => page.getByRole('listbox', { name: 'Команды' })

// The tools of a dialog (docs/plan/59, И4–И8, И14, И20).
/** «+»: one on the screen — in the head while the panel is closed, by the tabs while it is open. */
const plus = (page: Page) => page.getByRole('button', { name: /^Инструменты/ })
const toolsMenu = (page: Page) => page.getByRole('menu', { name: 'Инструменты' })
const pane = (page: Page) => page.getByRole('complementary', { name: 'Инструменты диалога' })
const openTabs = (page: Page) => page.getByRole('tablist', { name: 'Открытые инструменты' })
const tab = (page: Page, name: string) => openTabs(page).getByRole('tab', { name, exact: true })
const panelOf = (page: Page, tool: string) => page.locator(`#dialog-pane-panel-${tool}`)
const separator = (page: Page) => page.getByRole('separator', { name: 'Ширина панели' })
const hide = (page: Page) => page.getByRole('button', { name: 'Скрыть панель' })
const toDialog = (page: Page) => page.getByRole('button', { name: 'К диалогу' })
/** The cross of a tab: the pointer's way, hidden from a screen reader (Delete is the keyboard's). */
const cross = (page: Page, name: string) =>
  page.getByTitle(`Закрыть вкладку «${name}»`, { exact: true })

/**
 * The name of a tile of «+»: the tool, then what it holds, «Файлы и изменения, 4». Chrome may put
 * a space before the comma, which is hidden on the screen: a screen reader reads both alike.
 */
const tile = (name: string, mark: string) => new RegExp(`^${name}\\s*,\\s*${mark}$`)

/** Read aloud, not shown: the box of the words is the 1px of `offScreen`. */
async function expectOffScreen(target: Locator) {
  const found = await target.boundingBox()
  expect(found === null || (found.width <= 1 && found.height <= 1)).toBe(true)
}

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

const labelOf = async (target: Locator) =>
  (await target.innerText()).replace(/\s+/g, ' ').trim() ||
  ((await target.getAttribute('aria-label')) ?? '')

/** Heights of the visible links and buttons inside `scope` that are lower than 44px. */
async function lowTargets(scope: Locator): Promise<string[]> {
  const low: string[] = []
  for (const target of await scope.locator('a, button, [role="tab"]').all()) {
    if (!(await target.isVisible())) continue
    const found = await target.boundingBox()
    const label = await labelOf(target)
    if (!found) low.push(`${label}: no box`)
    else if (found.height < 44) low.push(`${label}: ${found.height}px`)
  }
  return low
}

/**
 * The targets lower or narrower than `least` px (DESIGN.md: 44 for a finger; the cross of a tab —
 * WCAG 2.5.8 — at least 24). Every target must be on the screen, and there must be one.
 */
async function smallTargets(targets: readonly Locator[], least = 44): Promise<string[]> {
  expect(targets.length).toBeGreaterThan(0)
  const small: string[] = []
  for (const target of targets) {
    await expect(target).toBeVisible()
    const found = await box(target)
    if (found.height < least || found.width < least)
      small.push(`${await labelOf(target)}: ${found.width}×${found.height}px`)
  }
  return small
}

/**
 * The open menu «+» has come to its place: MUI grows the card and slides the sheet in, whatever
 * the motion setting, and a box measured or a colour read on the way is not its own yet.
 */
async function menuSettled(page: Page) {
  const paper = page.locator('.MuiPopover-paper, .MuiDrawer-paper').filter({ has: toolsMenu(page) })
  await expect(paper).toBeVisible()
  await expect(paper).toHaveCSS('transform', 'none')
  await expect(paper).toHaveCSS('opacity', '1')
}

/** The open menu «+» itself, rendered in a portal outside `main`: its tiles, one at least. */
async function smallTiles(page: Page): Promise<string[]> {
  await menuSettled(page)
  const tiles = toolsMenu(page).getByRole('menuitem')
  await expect(tiles.first()).toBeVisible()
  return smallTargets(await tiles.all())
}

/** The strip of the panel: the tabs, «Скрыть панель» or «К диалогу», «+»; the crosses at 24px. */
async function smallStrip(page: Page): Promise<string[]> {
  const tabs = await openTabs(page).getByRole('tab').all()
  const around = [plus(page), ...(await hide(page).all()), ...(await toDialog(page).all())]
  const crosses = await pane(page).locator('[role="tab"] [title^="Закрыть вкладку"]').all()
  expect(crosses).toHaveLength(tabs.length)
  return [...(await smallTargets([...tabs, ...around])), ...(await smallTargets(crosses, 24))]
}

/**
 * Nothing of the tools is on the screen (И1): no panel, no edge, no tabs, no frame or picture of
 * a tool, no switch «Диалог | …» — only «+», once.
 */
async function expectChatAlone(page: Page) {
  await expect(pane(page)).toHaveCount(0)
  await expect(page.locator('[data-site-pane]')).toHaveCount(0)
  await expect(separator(page)).toHaveCount(0)
  await expect(openTabs(page)).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: 'Что показать' })).toHaveCount(0)
  await expect(page.getByRole('main').locator('iframe, canvas')).toHaveCount(0)
  await expect(page.locator('#dialog-tools')).toHaveCount(1)
  await expect(plus(page)).toBeVisible()
}

/** Chooses a tool in the menu of «+»; the menu closes. */
async function chooseTool(page: Page, name: RegExp) {
  await plus(page).click()
  await expect(toolsMenu(page)).toBeVisible()
  await toolsMenu(page).getByRole('menuitem', { name }).click()
  await expect(toolsMenu(page)).toHaveCount(0)
}

/**
 * The procedures of tRPC the page calls, as their names stand in the address of each request: a
 * batch names several, separated by commas.
 */
function recordCalls(page: Page): string[] {
  const calls: string[] = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.startsWith('/api/trpc/'))
      calls.push(...decodeURIComponent(pathname.slice('/api/trpc/'.length)).split(','))
  })
  return calls
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
    // The status in the line under the title of the dialog (26.10.2026), in the live block and in
    // the live region that reads it out; the list of dialogs, which stays beside an open dialog
    // (owner's request of 26.10.2026), shows it on the row of the dialog as well.
    await expect(page.getByRole('heading', { level: 2, name: QUEUED })).toBeVisible()
    await expect(page.getByRole('main').getByText(QUEUED).filter({ visible: true })).toHaveCount(3)
    await expect(
      page.getByRole('navigation', { name: 'Диалоги' }).getByText(QUEUED).filter({ visible: true }),
    ).toHaveCount(1)
    await expect(page.getByText(QUEUED_TEXT)).toBeVisible()
    // The agent is at work: the field says why it is closed, read with the field, and nothing
    // stands under it; «Остановить» stands in place of «Отправить».
    await expect(message(page)).toBeDisabled()
    await expect(message(page)).toHaveAccessibleDescription(new RegExp(FIELD_OFF))
    await expectOffScreen(page.getByText(FIELD_OFF))
    await expect(page.getByText('ИИ может допускать ошибки. Проверяйте важное.')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Остановить' })).toBeEnabled()
    await expect(send(page)).toHaveCount(0)
    // The mode it started in over the dialog (29.10.2026), the level of thinking by the field.
    await expect(
      page.getByRole('navigation', { name: 'Режим диалога' }).locator('[aria-current="true"]'),
    ).toHaveText('Работа')
    // The level is changed while the dialog waits: core plans a running turn with the one it read.
    await expect(page.getByRole('button', { name: 'Размышление: Высокое' })).toBeDisabled()
  })

  await test.step('a new dialog is the chat alone, the list beside it, «+» in its corner', async () => {
    await expectChatAlone(page)
    // Nothing is new behind «+»: no changes yet, no browser.
    await expect(plus(page)).toHaveAccessibleName('Инструменты')
    await expect(dialogs(page)).toBeVisible()
    await expect(back(page)).toBeHidden()
    await expectNoSidewaysScroll(page)
    expect(await lowTargets(page.getByRole('main'))).toEqual([])
  })

  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`the rules of axe in the ${scheme} scheme`, async () => {
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await page.reload()
      await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
      // A dialog opened again is the chat alone too.
      await expectChatAlone(page)
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
    await page.goto(`/projects/${siteId}/chat`)
    const today = dialogs(page).getByRole('list', { name: 'Сегодня' })
    const link = today.getByRole('link', { name: new RegExp(FIRST_WORDS) })
    await expect(link).toHaveAttribute('href', `/projects/${siteId}/chat/${taskId}`)
    await expect(link).toContainText(QUEUED)
    // The credits are no longer under the list: they stand over the account menu (29.10.2026).
    await expect(dialogs(page).getByRole('heading', { name: 'Кредиты' })).toHaveCount(0)
    await expect(
      page
        .getByRole('complementary', { name: 'Боковая панель сайта' })
        .getByRole('button', { name: /^(Кредиты по тарифу|Подарочные кредиты): / }),
    ).toBeVisible()
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
    await expect(message(page)).toBeDisabled()
    await expect(message(page)).toHaveAttribute('placeholder', 'Диалог завершён')
    // Under the closed dialog, and above the list of dialogs that stays beside it (26.10.2026).
    const newDialogs = page.getByRole('main').getByRole('link', { name: 'Новый диалог' })
    await expect(newDialogs).toHaveCount(2)
    for (const link of await newDialogs.all())
      await expect(link).toHaveAttribute('href', `/projects/${siteId}/chat/new`)
    // The words of a command never become a message of the client.
    await expect(feed(page).getByText('/cancel')).toHaveCount(0)
  })

  await test.step('a closed dialog keeps its tools: «нет» instead of «пока нет»', async () => {
    await plus(page).click()
    const items = toolsMenu(page).getByRole('menuitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveAccessibleName(tile('Файлы и изменения', 'нет'))
    await expect(items.nth(1)).toHaveAccessibleName(tile('Проверки', 'нет'))
    await items.nth(0).click()
    await expect(panelOf(page, 'files')).toContainText(
      'Диалог закрыт: изменений для показа здесь нет.',
    )
    await expect(panelOf(page, 'files')).toContainText('Выпущенные версии — в разделе «Изменения».')
    await chooseTool(page, /^Проверки/)
    await expect(panelOf(page, 'checks')).toContainText('Диалог закрыт: проверок нет.')
    await hide(page).click()
    await expectChatAlone(page)
    await expect(plus(page)).toBeFocused()
  })

  await test.step('the menu of the dialog renames it in place and deletes it after asking', async () => {
    // The menu by the title of the dialog; its row in the list beside it has one too.
    const menu = page
      .getByRole('main')
      .getByRole('button', { name: /^Действия с диалогом/ })
      .and(page.locator(':not(nav[aria-label="Диалоги"] *)'))
    await menu.click()
    await page.getByRole('menuitem', { name: 'Переименовать' }).click()
    const name = page.getByRole('textbox', { name: 'Название диалога' })
    await name.fill('Цена капучино')
    await name.press('Enter')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Цена капучино')
    await expect(dialogs(page).getByRole('link', { name: /Цена капучино/ })).toBeVisible()

    await menu.click()
    await page.getByRole('menuitem', { name: 'Удалить' }).click()
    const ask = page.getByRole('dialog', { name: 'Удалить диалог?' })
    await ask.getByRole('button', { name: 'Удалить' }).click()
    await expect(page).toHaveURL(`/projects/${siteId}/chat`)
    await expect(dialogs(page).getByRole('link', { name: /Цена капучино/ })).toHaveCount(0)
    await page.goto(`/projects/${siteId}/chat/${taskId}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Такого диалога нет')
  })
})

// «Работа» before the changes (docs/plan/59, И5–И8): the task has its files and its checks —
// nothing in them yet —, and no preview or database in this run, which builds no previews.
test('a dialog of «Работа» without changes: its tools beside it on a desktop', async ({
  page,
  context,
  signedInUser,
}) => {
  test.slow()
  const siteId = await addConnectedSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await startDialog(page, siteId)
  await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
  const items = toolsMenu(page).getByRole('menuitem')
  let closedCorner = { x: 0, y: 0 }

  await test.step('the dialog starts with the chat alone, «+» in the top right corner', async () => {
    await expectChatAlone(page)
    const found = await box(plus(page))
    closedCorner = { x: found.x, y: found.y }
    expect(found.x + found.width).toBeGreaterThanOrEqual(1280 - 24)
    expect(found.y).toBeLessThan(120)
  })

  await test.step('«+» lists the files and the checks — not yet —, nothing the run has no means for', async () => {
    await plus(page).click()
    await expect(toolsMenu(page)).toBeVisible()
    // From `lg` the menu is a card beside «+».
    await expect(page.locator('.MuiPopover-paper')).toBeVisible()
    await expect(page.locator('.MuiDrawer-paper')).toHaveCount(0)
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveAccessibleName(tile('Файлы и изменения', 'пока нет'))
    await expect(items.nth(1)).toHaveAccessibleName(tile('Проверки', 'пока нет'))
    for (const missing of [/^Предпросмотр/, /^База данных/, /^Браузер/])
      await expect(toolsMenu(page).getByRole('menuitem', { name: missing })).toHaveCount(0)
    expect(await smallTiles(page)).toEqual([])
  })

  await test.step('the keyboard goes through the tiles, Esc gives the focus back to «+»', async () => {
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(toolsMenu(page)).toHaveCount(0)
    await expect(plus(page)).toBeFocused()
    // Opened from the keyboard, the menu starts at its first tile; Enter chooses it.
    await page.keyboard.press('Enter')
    await expect(items.nth(0)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(toolsMenu(page)).toHaveCount(0)
  })

  await test.step('«Файлы и изменения» opens the tab «Файлы» at once, with what it says before the changes', async () => {
    await expect(pane(page)).toBeVisible()
    await expect(openTabs(page).getByRole('tab')).toHaveCount(1)
    await expect(tab(page, 'Файлы')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'Файлы')).toBeFocused()
    await expect(panelOf(page, 'files')).toContainText('Изменений пока нет.')
    await expect(panelOf(page, 'files')).toContainText(
      'Они появятся здесь, когда агент закончит работу.',
    )
    // The edge between the dialog and the panel; the list of dialogs gives the panel its room.
    await expect(separator(page)).toBeVisible()
    await expect(dialogs(page)).toBeHidden()
    await expect(back(page)).toBeVisible()
    const paneBox = await box(pane(page))
    const fieldBox = await box(message(page))
    expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(1280)
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(paneBox.x)
    // «+» keeps its corner: it stands at the end of the tabs now, one on the screen.
    await expect(pane(page).locator('#dialog-tools')).toBeVisible()
    await expect(page.locator('#dialog-tools')).toHaveCount(1)
    const openCorner = await box(plus(page))
    expect(Math.abs(openCorner.x - closedCorner.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(openCorner.y - closedCorner.y)).toBeLessThanOrEqual(2)
    await expectNoSidewaysScroll(page)
  })

  await test.step('a second tool is a second tab; choosing an open one shows it, never twice', async () => {
    await chooseTool(page, /^Проверки/)
    await expect(openTabs(page).getByRole('tab')).toHaveCount(2)
    await expect(tab(page, 'Проверки')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'Проверки')).toBeFocused()
    await expect(panelOf(page, 'checks')).toContainText('Проверок пока нет.')
    await plus(page).click()
    await expect(items.nth(0)).toHaveAccessibleName(tile('Файлы и изменения', 'Открыто'))
    await expect(items.nth(1)).toHaveAccessibleName(tile('Проверки', 'Открыто'))
    await items.nth(0).click()
    await expect(openTabs(page).getByRole('tab')).toHaveCount(2)
    await expect(tab(page, 'Файлы')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'Проверки')).toHaveAttribute('aria-selected', 'false')
    // A tab of the strip shows its tool too.
    await tab(page, 'Проверки').click()
    await expect(panelOf(page, 'checks')).toBeVisible()
    await expect(panelOf(page, 'files')).toBeHidden()
  })

  await test.step('the strip and the main area keep a pressing area of 44px', async () => {
    expect(await smallStrip(page)).toEqual([])
    expect(await lowTargets(page.getByRole('main'))).toEqual([])
  })

  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`the rules of axe in the ${scheme} scheme: the menu open, then two tabs`, async () => {
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await page.reload()
      await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
      // A reload starts with the chat alone again.
      await expectChatAlone(page)
      await plus(page).click()
      await menuSettled(page)
      expect(await violations(page)).toEqual([])
      await items.nth(0).click()
      await chooseTool(page, /^Проверки/)
      await expect(openTabs(page).getByRole('tab')).toHaveCount(2)
      await expect(panelOf(page, 'checks')).toContainText('Проверок пока нет.')
      expect(await violations(page)).toEqual([])
    })
  }

  await test.step('the cross and Delete close one tab each; the last takes the panel away', async () => {
    await cross(page, 'Проверки').click()
    await expect(openTabs(page).getByRole('tab')).toHaveCount(1)
    await expect(tab(page, 'Файлы')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'Файлы')).toBeFocused()
    await expect(tab(page, 'Файлы')).toHaveAttribute('aria-keyshortcuts', 'Delete')
    await page.keyboard.press('Delete')
    await expectChatAlone(page)
    await expect(plus(page)).toBeFocused()
    // The dialog takes the width back, and the list returns beside it.
    await expect(dialogs(page)).toBeVisible()
    await expect(back(page)).toBeHidden()
    await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
  })

  await test.step('the cross of the last tab takes the panel and its edge away too', async () => {
    await chooseTool(page, /^Файлы и изменения/)
    await expect(separator(page)).toBeVisible()
    await cross(page, 'Файлы').click()
    await expectChatAlone(page)
    await expect(plus(page)).toBeFocused()
  })
})

test('a dialog on a phone: the chat alone, its tools in place of it behind «+»', async ({
  page,
  signedInUser,
}) => {
  const siteId = await addConnectedSite(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await startDialog(page, siteId)

  await test.step('no switch «Диалог | …»: the dialog is all, «+» in its head', async () => {
    await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
    await expectChatAlone(page)
    await expect(plus(page)).toBeInViewport()
    expect(await smallTargets([plus(page)])).toEqual([])
    await expectNoSidewaysScroll(page)
    expect(await violations(page)).toEqual([])
    expect(await lowTargets(page.getByRole('main'))).toEqual([])
  })

  await test.step('the menu comes up from the bottom as a sheet', async () => {
    await plus(page).click()
    const sheet = page.locator('.MuiDrawer-paper')
    await menuSettled(page)
    await expect(page.locator('.MuiPopover-paper')).toHaveCount(0)
    const sheetBox = await box(sheet)
    expect(Math.round(sheetBox.y + sheetBox.height)).toBe(844)
    await expect(toolsMenu(page).getByRole('menuitem')).toHaveCount(2)
    await expect(toolsMenu(page).getByRole('menuitem').nth(0)).toHaveAccessibleName(
      tile('Файлы и изменения', 'пока нет'),
    )
    expect(await smallTiles(page)).toEqual([])
    const closeMenu = sheet.getByRole('button', { name: 'Закрыть меню' })
    expect(await smallTargets([closeMenu])).toEqual([])
    await expectNoSidewaysScroll(page)
    expect(await violations(page)).toEqual([])
    await closeMenu.click()
    await expect(toolsMenu(page)).toHaveCount(0)
    await expect(plus(page)).toBeFocused()
  })

  await test.step('a tool takes the place of the dialog; «К диалогу» leads back', async () => {
    await chooseTool(page, /^Файлы и изменения/)
    await expect(pane(page)).toBeVisible()
    await expect(toDialog(page)).toBeVisible()
    await expect(tab(page, 'Файлы')).toBeFocused()
    await expect(panelOf(page, 'files')).toContainText('Изменений пока нет.')
    await expect(feed(page)).toBeHidden()
    await expect(message(page)).toBeHidden()
    // Below `lg` the area has no edge and no «Скрыть панель»: «К диалогу» is the way back.
    await expect(separator(page)).toHaveCount(0)
    await expect(hide(page)).toHaveCount(0)
    await expect(page.locator('#dialog-tools')).toHaveCount(1)
    await expectNoSidewaysScroll(page)
    expect(await smallStrip(page)).toEqual([])
    expect(await lowTargets(pane(page))).toEqual([])
    expect(await violations(page)).toEqual([])
    await toDialog(page).click()
    await expectChatAlone(page)
    await expect(feed(page).getByText(FIRST_WORDS)).toBeVisible()
    await expect(plus(page)).toBeFocused()
    await expectNoSidewaysScroll(page)
  })
})

// The place in the feed and the draft (docs/plan/59, И19): the feed and the field stay mounted
// while the tools open, switch and close. From `lg` the feed scrolls in its own area, which the
// panel narrows; below it the page scrolls, and a tool hides the dialog until «К диалогу».

/** How far the scrolling area of the feed stands from its end, in px (from `lg`). */
const gapToEnd = (page: Page) =>
  feed(page).evaluate((list) => {
    let area = list.parentElement
    while (area !== null && getComputedStyle(area).overflowY !== 'auto') area = area.parentElement
    if (area === null) throw new Error('The feed has no area of its own')
    return Math.round(area.scrollHeight - area.scrollTop - area.clientHeight)
  })

/** Scrolls the area of the feed so that the row `index` stands 12px under its top (from `lg`). */
const scrollFeedToRow = (page: Page, index: number) =>
  feed(page).evaluate((list, row) => {
    let area = list.parentElement
    while (area !== null && getComputedStyle(area).overflowY !== 'auto') area = area.parentElement
    if (area === null) throw new Error('The feed has no area of its own')
    const target = list.querySelectorAll('[data-feed-row]')[row]
    if (target === undefined) throw new Error(`The feed has no row ${row}`)
    area.scrollTop += target.getBoundingClientRect().top - area.getBoundingClientRect().top - 12
  }, index)

/**
 * Where the client reads (from `lg`): the first row that reaches below the top of the area of the
 * feed, and how far under that top it stands — as the dialog itself reads it (`useFeedFollow`).
 */
const readPlace = (page: Page) =>
  feed(page).evaluate((list) => {
    let area = list.parentElement
    while (area !== null && getComputedStyle(area).overflowY !== 'auto') area = area.parentElement
    if (area === null) throw new Error('The feed has no area of its own')
    const top = area.getBoundingClientRect().top
    const rows = [...list.querySelectorAll('[data-feed-row]')]
    const index = rows.findIndex((row) => row.getBoundingClientRect().bottom > top)
    return { row: index, offset: Math.round(rows[index]!.getBoundingClientRect().top - top) }
  })

test('a long dialog keeps its place and the draft as its tools open and close, on a desktop', async ({
  page,
  signedInUser,
}) => {
  const { siteId, taskId, title } = await addLongDialog(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/projects/${siteId}/chat/${taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  await expect(feed(page).getByRole('listitem')).toHaveCount(30)
  await expectChatAlone(page)
  // The agent answered and asked nothing: the field takes words.
  await message(page).fill(DRAFT)

  await test.step('at the end: the feed stays at its end as the tools open, switch and close', async () => {
    await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1)
    // The panel takes its width from the dialog: the lines of the feed wrap anew.
    const wide = (await box(feed(page))).width
    await chooseTool(page, /^Файлы и изменения/)
    await expect(pane(page)).toBeVisible()
    expect((await box(feed(page))).width).toBeLessThan(wide - 100)
    await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1)
    await chooseTool(page, /^Проверки/)
    await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1)
    await tab(page, 'Файлы').click()
    await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1)
    await hide(page).click()
    await expectChatAlone(page)
    await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1)
    await expect(message(page)).toHaveValue(DRAFT)
  })

  await test.step('above the end: the row at the top stays where it was, «+» in sight', async () => {
    // Chrome keeps the row in place by itself (scroll anchoring); Safari has no such thing, and
    // the dialog keeps it by its own rule (`useFeedFollow`): that rule is what is checked here.
    await page.addStyleTag({ content: '* { overflow-anchor: none !important; }' })
    await scrollFeedToRow(page, 10)
    // The row read, and whether it stands where it stood: 12px under the top, give or take the
    // rounding of a pixel.
    const place = async () => {
      const { row, offset } = await readPlace(page)
      return { row, kept: Math.abs(offset - 12) <= 1 }
    }
    await expect.poll(place).toEqual({ row: 10, kept: true })
    await expect.poll(() => gapToEnd(page)).toBeGreaterThan(100)
    for (const [what, act] of [
      ['opened', () => chooseTool(page, /^Файлы и изменения/)],
      ['a second tab', () => chooseTool(page, /^Проверки/)],
      ['switched', () => tab(page, 'Файлы').click()],
      ['one tab closed', () => cross(page, 'Проверки').click()],
      ['the panel hidden', () => hide(page).click()],
    ] as const) {
      await act()
      // Every step changes the width of the feed or the height of its area.
      await expect
        .poll(place, { message: `the place in the feed, ${what}` })
        .toEqual({ row: 10, kept: true })
      await expect(plus(page)).toBeInViewport()
      await expect(message(page)).toHaveValue(DRAFT)
    }
    await expectChatAlone(page)
  })
})

test('a long dialog on a phone: «К диалогу» brings back the place and the draft', async ({
  page,
  signedInUser,
}) => {
  const { siteId, taskId, title } = await addLongDialog(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${siteId}/chat/${taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  await expect(feed(page).getByRole('listitem')).toHaveCount(30)
  await expectChatAlone(page)
  await message(page).fill(DRAFT)

  // The page scrolls the feed on a phone: away from the end, to the middle of it.
  const middle = await page.evaluate(() =>
    Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2),
  )
  expect(middle).toBeGreaterThan(1000)
  /** How far the page stands from where the client left it, in px. */
  const offPlace = () => page.evaluate((top) => Math.abs(Math.round(window.scrollY) - top), middle)
  await page.evaluate((top) => window.scrollTo(0, top), middle)
  await expect.poll(offPlace).toBeLessThanOrEqual(1)

  for (const tool of [/^Файлы и изменения/, /^Проверки/]) {
    await test.step(`${tool.source.slice(1)} in place of the dialog, then «К диалогу»`, async () => {
      await chooseTool(page, tool)
      await expect(pane(page)).toBeVisible()
      await expect(feed(page)).toBeHidden()
      await expect(message(page)).toBeHidden()
      await expectNoSidewaysScroll(page)
      await expect(plus(page)).toBeVisible()
      await toDialog(page).click()
      await expectChatAlone(page)
      await expect.poll(offPlace).toBeLessThanOrEqual(1)
      await expect(plus(page)).toBeFocused()
      // The head keeps to the top of the window, «+» within reach.
      await expect(plus(page)).toBeInViewport()
      await expect(message(page)).toHaveValue(DRAFT)
      await expectNoSidewaysScroll(page)
    })
  }
})

// A task in the browser (docs/plan/57-browser-tasks.md, Б29; docs/plan/59, И1, И11, И12, И14,
// И17): the browser is a tool of the dialog like the others — behind «+», «Открыть браузер» and
// «Взять управление» of the card —, never open by itself at a load. It shows the real state of
// the session: no worker runs in this stand, and the cabinet has no stream to open, so the panel
// says it cannot show the browser — the stream itself is proven by `pnpm verify:browser-task`.

const browserBar = (page: Page) => page.getByRole('toolbar', { name: 'Управление браузером' })
const loginCard = (page: Page) =>
  feed(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Нужно войти на сайт' }) })

/** The tab «Браузер» open and shown, with the state of the session the run has. */
async function expectBrowserShown(page: Page) {
  await expect(pane(page)).toBeVisible()
  await expect(openTabs(page).getByRole('tab')).toHaveCount(1)
  await expect(tab(page, 'Браузер')).toHaveAttribute('aria-selected', 'true')
  await expect(browserBar(page)).toBeVisible()
  await expect(pane(page).getByText('Не удалось показать браузер')).toBeVisible()
}

test('a task in the browser: its window on a desktop', async ({ page, context, signedInUser }) => {
  test.slow()
  const { siteId, taskId, title } = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const calls = recordCalls(page)
  await page.goto(`/projects/${siteId}/chat/${taskId}`)

  await test.step('the question to sign in, the chat alone: the browser waits behind «+»', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    // The mode it started in stands over the dialog: «Чат», the dialog in the browser.
    await expect(
      page.getByRole('navigation', { name: 'Режим диалога' }).locator('[aria-current="true"]'),
    ).toHaveText('Чат')
    await expect(loginCard(page)).toBeVisible()
    await expectChatAlone(page)
    // The browser waits for the client: «+» says so, the panel stays closed (И13).
    await expect(plus(page)).toHaveAccessibleName('Инструменты — браузер ждёт вас')
    await expect(loginCard(page).getByRole('button', { name: 'Взять управление' })).toBeVisible()
    await expect(loginCard(page).getByRole('button', { name: 'Открыть браузер' })).toBeVisible()
    await expect(dialogs(page)).toBeVisible()
    await expect(back(page)).toBeHidden()
    // The words of the client answer the question too.
    await expect(message(page)).toBeEnabled()
    await expectNoSidewaysScroll(page)
    expect(await lowTargets(page.getByRole('main'))).toEqual([])
    await page.reload()
    await expect(loginCard(page)).toBeVisible()
    await expectChatAlone(page)
  })

  await test.step('«+» lists the browser with who it waits for; choosing it opens the panel on it', async () => {
    await plus(page).click()
    const items = toolsMenu(page).getByRole('menuitem')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toHaveAccessibleName(tile('Браузер', 'Ждём вас'))
    expect(await smallTiles(page)).toEqual([])
    await items.first().click()
    await expectBrowserShown(page)
    await expect(tab(page, 'Браузер')).toBeFocused()
    // Open, nothing is new behind «+».
    await expect(plus(page)).toHaveAccessibleName('Инструменты')
    await expect(separator(page)).toBeVisible()
    await expect(dialogs(page)).toBeHidden()
    await expect(back(page)).toBeVisible()
    const paneBox = await box(pane(page))
    const fieldBox = await box(message(page))
    expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(1280)
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(paneBox.x)
    // Chosen again, the open browser is shown, never twice.
    await plus(page).click()
    await expect(items.first()).toHaveAccessibleName(tile('Браузер', 'Открыто'))
    await items.first().click()
    await expect(openTabs(page).getByRole('tab')).toHaveCount(1)
    expect(await smallStrip(page)).toEqual([])
    await expectNoSidewaysScroll(page)
  })

  await test.step('the cross of the tab takes the panel away; the task waits as it did', async () => {
    await cross(page, 'Браузер').click()
    await expectChatAlone(page)
    await expect(plus(page)).toBeFocused()
    await expect(plus(page)).toHaveAccessibleName('Инструменты — браузер ждёт вас')
    await expect(loginCard(page).getByRole('button', { name: 'Взять управление' })).toBeVisible()
  })

  await test.step('«Открыть браузер» of the card opens it; «Скрыть панель» closes it', async () => {
    await loginCard(page).getByRole('button', { name: 'Открыть браузер' }).click()
    await expectBrowserShown(page)
    await expect(tab(page, 'Браузер')).toBeFocused()
    await hide(page).click()
    await expectChatAlone(page)
    await expect(plus(page)).toBeFocused()
  })

  await test.step('«Взять управление» opens the browser from the closed panel', async () => {
    await loginCard(page).getByRole('button', { name: 'Взять управление' }).click()
    await expectBrowserShown(page)
  })

  await test.step('the edge of the panel moves with the arrows and is kept', async () => {
    const before = (await box(pane(page))).width
    await separator(page).focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await box(pane(page))).width).toBeGreaterThan(before)
    const wider = (await box(pane(page))).width
    await page.reload()
    await expect(loginCard(page)).toBeVisible()
    // A reload starts with the chat alone again; the width waits for the next opening.
    await expectChatAlone(page)
    await chooseTool(page, /^Браузер/)
    await expectBrowserShown(page)
    expect(Math.abs((await box(pane(page))).width - wider)).toBeLessThanOrEqual(1)
    const fieldBox = await box(message(page))
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual((await box(pane(page))).x)
  })

  await test.step('the whole area for the browser, and Esc gives it back', async () => {
    await browserBar(page).getByRole('button', { name: 'Во весь экран' }).click()
    const full = await box(pane(page))
    expect(full.x).toBeLessThanOrEqual(89)
    expect(full.x + full.width).toBeGreaterThanOrEqual(1279)
    // The rail stays beside it.
    await expect(page.getByRole('navigation', { name: 'Разделы сайта' }).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(browserBar(page).getByRole('button', { name: 'Во весь экран' })).toBeVisible()
    expect((await box(pane(page))).x).toBeGreaterThan(400)
  })

  await test.step('closing the browser over the whole area leaves nothing covered', async () => {
    await browserBar(page).getByRole('button', { name: 'Во весь экран' }).click()
    await cross(page, 'Браузер').click()
    await expectChatAlone(page)
    // The head, the feed and the shell take the focus again (И17).
    await expect(page.locator('[inert]')).toHaveCount(0)
    await expect(plus(page)).toBeFocused()
    await message(page).focus()
    await expect(message(page)).toBeFocused()
  })

  await test.step('looking is no action: closing never stopped the task or resumed the agent', async () => {
    // The calls are seen: the feed is read again and again.
    expect(calls).toContain('task.feed')
    expect(calls.filter((call) => call === 'task.cancel' || call === 'task.resumeAgent')).toEqual(
      [],
    )
    await expect(loginCard(page).getByRole('button', { name: 'Взять управление' })).toBeVisible()
  })

  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`the rules of axe in the ${scheme} scheme: closed, the menu, the browser`, async () => {
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await page.reload()
      await expect(loginCard(page)).toBeVisible()
      await expectChatAlone(page)
      expect(await violations(page)).toEqual([])
      await plus(page).click()
      await menuSettled(page)
      expect(await violations(page)).toEqual([])
      await toolsMenu(page)
        .getByRole('menuitem', { name: /^Браузер/ })
        .click()
      await expectBrowserShown(page)
      expect(await violations(page)).toEqual([])
    })
  }

  await test.step('the window of commands has only «Отменить диалог»', async () => {
    await page.getByRole('button', { name: 'Команды' }).click()
    await expect(commands(page).getByRole('option')).toHaveCount(1)
    await expect(commands(page).getByRole('option', { name: /Отменить диалог/ })).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test('a task in the browser on a phone: the browser in place of the dialog, «К диалогу» back', async ({
  page,
  context,
  signedInUser,
}) => {
  test.slow()
  const { siteId, taskId } = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${siteId}/chat/${taskId}`)

  await test.step('no switch: the question in the chat, «+» marked in the head', async () => {
    await expect(loginCard(page)).toBeVisible()
    await expectChatAlone(page)
    await expect(plus(page)).toHaveAccessibleName('Инструменты — браузер ждёт вас')
    await expect(plus(page)).toBeInViewport()
    expect(await smallTargets([plus(page)])).toEqual([])
    await expectNoSidewaysScroll(page)
    expect(await violations(page)).toEqual([])
    expect(await lowTargets(page.getByRole('main'))).toEqual([])
  })

  await test.step('«+» → «Браузер» takes the place of the dialog; «К диалогу» leads back', async () => {
    await plus(page).click()
    // Below `lg` the menu comes up from the bottom as a sheet.
    await expect(page.locator('.MuiDrawer-paper')).toBeVisible()
    expect(await smallTiles(page)).toEqual([])
    await toolsMenu(page)
      .getByRole('menuitem', { name: /^Браузер/ })
      .click()
    await expectBrowserShown(page)
    await expect(tab(page, 'Браузер')).toBeFocused()
    await expect(toDialog(page)).toBeVisible()
    await expect(feed(page)).toBeHidden()
    await expect(message(page)).toBeHidden()
    await expect(pane(page).getByRole('button', { name: 'Остановить' })).toBeVisible()
    await expect(separator(page)).toHaveCount(0)
    await expect(hide(page)).toHaveCount(0)
    await expect(page.locator('#dialog-tools')).toHaveCount(1)
    await expectNoSidewaysScroll(page)
    expect(await smallStrip(page)).toEqual([])
    expect(await lowTargets(pane(page))).toEqual([])
    await toDialog(page).click()
    await expectChatAlone(page)
    await expect(loginCard(page)).toBeVisible()
    await expect(plus(page)).toBeFocused()
  })

  await test.step('«Открыть браузер» of the card opens it in place of the dialog too', async () => {
    await loginCard(page).getByRole('button', { name: 'Открыть браузер' }).click()
    await expectBrowserShown(page)
    await expect(tab(page, 'Браузер')).toBeFocused()
    await expectNoSidewaysScroll(page)
    await toDialog(page).click()
    await expectChatAlone(page)
    await expect(plus(page)).toBeFocused()
  })

  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`the rules of axe in the ${scheme} scheme: the sheet, then the browser`, async () => {
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await page.reload()
      await expect(loginCard(page)).toBeVisible()
      await expectChatAlone(page)
      await plus(page).click()
      await expect(page.locator('.MuiDrawer-paper')).toBeVisible()
      await menuSettled(page)
      expect(await violations(page)).toEqual([])
      await toolsMenu(page)
        .getByRole('menuitem', { name: /^Браузер/ })
        .click()
      await expectBrowserShown(page)
      await expectNoSidewaysScroll(page)
      expect(await violations(page)).toEqual([])
    })
  }
})
