import { readFile } from 'node:fs/promises'

import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

import { baseURL } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

import {
  addBrowserTask,
  addLongChat,
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
// «К чату» leading back. The run blanks BROWSER_STREAM_PUBLIC_URL (playwright.site.config.ts):
// a browser cannot be shown here. What is
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

const message = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' })
const feed = (page: Page) => page.getByRole('list', { name: 'Сообщения чата' })
const dialogs = (page: Page) => page.getByRole('navigation', { name: 'Чаты' })
const back = (page: Page) => page.getByRole('link', { name: 'К чатам' })
const commands = (page: Page) => page.getByRole('listbox', { name: 'Команды' })

// The tools of a dialog (docs/plan/59, И4–И8, И14, И20).
/** «+»: one on the screen — in the head while the panel is closed, by the tabs while it is open. */
const plus = (page: Page) => page.getByRole('button', { name: /^Инструменты/ })
const toolsMenu = (page: Page) => page.getByRole('menu', { name: 'Инструменты' })
const pane = (page: Page) => page.getByRole('complementary', { name: 'Инструменты чата' })
const openTabs = (page: Page) => page.getByRole('tablist', { name: 'Открытые инструменты' })
const tab = (page: Page, name: string) => openTabs(page).getByRole('tab', { name, exact: true })
const separator = (page: Page) => page.getByRole('separator', { name: 'Ширина панели' })
// Inside the panel: the panel of the chats beside it has its own «Скрыть панель» (#107).
const hide = (page: Page) => pane(page).getByRole('button', { name: 'Скрыть панель' })
const toDialog = (page: Page) => page.getByRole('button', { name: 'К чату' })
/** The cross of a tab: the pointer's way, hidden from a screen reader (Delete is the keyboard's). */
const cross = (page: Page, name: string) =>
  page.getByTitle(`Закрыть вкладку «${name}»`, { exact: true })

/**
 * The name of a tile of «+»: the tool, then what it holds, «Файлы и изменения, 4». Chrome may put
 * a space before the comma, which is hidden on the screen: a screen reader reads both alike.
 */
const tile = (name: string, mark: string) => new RegExp(`^${name}\\s*,\\s*${mark}$`)

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

/** The strip of the panel: the tabs, «Скрыть панель» or «К чату», «+»; the crosses at 24px. */
async function smallStrip(page: Page): Promise<string[]> {
  const tabs = await openTabs(page).getByRole('tab').all()
  const around = [plus(page), ...(await hide(page).all()), ...(await toDialog(page).all())]
  const crosses = await pane(page).locator('[role="tab"] [title^="Закрыть вкладку"]').all()
  expect(crosses).toHaveLength(tabs.length)
  return [...(await smallTargets([...tabs, ...around])), ...(await smallTargets(crosses, 24))]
}

/**
 * Nothing of the tools is on the screen (И1): no panel, no edge, no tabs, no frame or picture of
 * a tool, no switch «Диалог | …» — only «+», once, and not even that in a chat with no tool at all
 * (docs/plan/61-chats-first.md, К19).
 */
async function expectChatAlone(page: Page, { tools = true }: { tools?: boolean } = {}) {
  await expect(pane(page)).toHaveCount(0)
  await expect(page.locator('[data-chat-pane]')).toHaveCount(0)
  await expect(separator(page)).toHaveCount(0)
  await expect(openTabs(page)).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: 'Что показать' })).toHaveCount(0)
  await expect(page.getByRole('main').locator('iframe, canvas')).toHaveCount(0)
  await expect(page.locator('#dialog-tools')).toHaveCount(tools ? 1 : 0)
  if (tools) await expect(plus(page)).toBeVisible()
}

/** Chooses a tool in the menu of «+»; the menu closes. */
async function chooseTool(page: Page, name: RegExp) {
  await plus(page).click()
  await expect(toolsMenu(page)).toBeVisible()
  await toolsMenu(page).getByRole('menuitem', { name }).click()
  await expect(toolsMenu(page)).toHaveCount(0)
  // The card leaves the tree of roles at once, the page as it fades: gone, it cannot lie half
  // transparent over what axe reads next (its title of 3.66:1 under a slow machine).
  await expect(page.locator('[data-tools-menu]')).toHaveCount(0)
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

// The changes of a chat (docs/plan/59, И5–И8; docs/plan/61, К19): its files and its checks, each
// with what it holds; no database, which they do not touch, and no preview in this run, which
// builds none.

// The place in the feed and the draft (docs/plan/59, И19): the feed and the field stay mounted
// while the tools open, switch and close. From `lg` the feed scrolls in its own area, which the
// panel narrows; below it the page scrolls, and a tool hides the dialog until «К чату».

// What sticks over the feed (docs/plan/59, И4, И14): below `lg` the head of the dialog keeps to
// the top of the window, and on every width the field keeps to the bottom. Neither hides the element the keyboard lands on (WCAG 2.4.11): the rows of
// the feed keep their room from them, as the landing keeps its anchors from under its header. A
// window lower than 420px — a phone on its side, a page zoomed to 400% — leaves the head with the
// page: stuck over the field there, it would leave the feed a line (WCAG 1.4.10).

/**
 * Walks the feed by the keyboard — Shift+Tab up, or Tab down — from where the focus is, and names
 * every element of the feed it lands on that is out of sight: entirely under what sticks over the
 * top of the window (the head) or entirely under the field at its bottom.
 * Stops once the focus leaves the feed.
 */
async function walkFeed(
  page: Page,
  key: 'Shift+Tab' | 'Tab',
): Promise<{ steps: number; hidden: string[] }> {
  const hidden: string[] = []
  let steps = 0
  for (let press = 0; press < 60; press += 1) {
    await page.keyboard.press(key)
    const place = await feed(page).evaluate((list) => {
      const active = document.activeElement
      if (active === null || !list.contains(active)) return null
      const stuck = (element: Element | null | undefined): Element | null => {
        let node = element ?? null
        while (node !== null && getComputedStyle(node).position !== 'sticky')
          node = node.parentElement
        return node
      }
      // Over the top: the head of the dialog, while it sticks.
      const top = stuck(document.querySelector('main h1'))?.getBoundingClientRect().bottom ?? 0
      const field = stuck(document.querySelector('textarea'))?.getBoundingClientRect().top
      const found = active.getBoundingClientRect()
      return {
        name: (active.textContent ?? '').trim().slice(0, 40),
        top: Math.round(found.top),
        bottom: Math.round(found.bottom),
        underTop: found.bottom <= top + 0.5,
        underField: field !== undefined && found.top >= field - 0.5,
      }
    })
    if (place === null) break
    steps += 1
    if (place.underTop || place.underField)
      hidden.push(
        `${place.name}: ${place.top}..${place.bottom}, ${place.underTop ? 'under the head' : 'under the field'}`,
      )
  }
  return { steps, hidden }
}

/** Whether the head of the dialog keeps to the top of the window. */
const headSticks = (page: Page) =>
  page.evaluate(() => {
    let node: Element | null = document.querySelector('main h1')
    while (node !== null && getComputedStyle(node).position !== 'sticky') node = node.parentElement
    return node !== null
  })

/** Up the feed from the field and down again: every stop of the keyboard stays in sight. */
async function expectFocusInSight(page: Page) {
  // Every answer links to its page: one stop of the keyboard each.
  await message(page).focus()
  const up = await walkFeed(page, 'Shift+Tab')
  expect(up.steps).toBeGreaterThanOrEqual(15)
  expect(up.hidden).toEqual([])
  // Up the feed the focus left it for the head; down it goes again, to the field.
  const down = await walkFeed(page, 'Tab')
  expect(down.steps).toBeGreaterThanOrEqual(15)
  expect(down.hidden).toEqual([])
  await expect(message(page)).toBeFocused()
}

// The head of a chat without a project is one line lower on a narrow screen: `HEAD_ROOM` of its
// own, measured here (docs/plan/61-chats-first.md, §5.11).
test('a long chat without a project: the head and the field never hide the element in focus', async ({
  page,
  signedInUser,
}) => {
  test.slow()
  const { taskId, title } = await addLongChat(signedInUser.id)
  await hideDevIndicator(page)

  for (const [width, height] of [
    [390, 844],
    [768, 1024],
  ] as const) {
    await test.step(`${width}×${height}: Shift+Tab up the feed from the field, then Tab down`, async () => {
      await page.setViewportSize({ width, height })
      await page.goto(`/chats/${taskId}`)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
      await expect(feed(page).getByRole('listitem')).toHaveCount(30)
      expect(await headSticks(page)).toBe(true)
      await expectFocusInSight(page)
    })
  }
})

test('a chat without a project: no tools, no word of a site, no commands of the site', async ({
  page,
  signedInUser,
}) => {
  const { taskId, title } = await addLongChat(signedInUser.id, 2)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  await expectChatAlone(page, { tools: false })
  await expect(page.getByRole('link', { name: /^Открыть проект/ })).toHaveCount(0)
  await expect(feed(page).getByRole('link', { name: 'Открыть сайт' })).toHaveCount(0)
  // The reminder under the field points to the variables of the workspace (plan 83, БП4).
  await expect(message(page)).toHaveAccessibleDescription(
    /Не отправляйте в чат пароли и ключи: сохраните их в «Настройки → Переменные»/,
  )

  await page.getByRole('button', { name: 'Команды' }).click()
  // No group «Сайт» and no `/retry` without the repository (К27).
  await expect(commands(page).getByRole('group')).toHaveCount(2)
  // With /usage, /status and /context of the chat (#105).
  await expect(commands(page).getByRole('option')).toHaveCount(15)
  await expect(commands(page).getByText('Сайт', { exact: true })).toHaveCount(0)
  await commands(page)
    .getByRole('option', { name: /Отменить чат/ })
    .click()
  const confirm = page.getByRole('dialog', { name: 'Отменить чат?' })
  await expect(confirm).toContainText('Чат завершится, а агент остановится, если ещё работает.')
  await expect(confirm).not.toContainText('сайт')
  await confirm.getByRole('button', { name: 'Не отменять' }).click()
})

test('the commands of the page work in a chat: the file, the theme, the level, the list', async ({
  page,
  signedInUser,
}) => {
  const { taskId, title } = await addLongDialog(signedInUser.id, 2)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/chats/${taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  const run = async (slash: string) => {
    await message(page).fill(slash)
    await commands(page).waitFor()
    await page.keyboard.press('Enter')
  }

  await test.step('`/export` gives the chat as a file', async () => {
    const saving = page.waitForEvent('download')
    await run('/export')
    const file = await saving
    expect(file.suggestedFilename()).toMatch(/\.md$/u)
    const path = await file.path()
    expect(await readFile(path, 'utf8')).toContain(`# ${title}`)
  })

  await test.step('`/themes` offers the three and takes the choice', async () => {
    await run('/themes')
    const menu = page.getByRole('menu', { name: 'Оформление' })
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Светлая', 'Тёмная', 'Как в системе'])
    await menu.getByRole('menuitemradio', { name: 'Тёмная' }).click()
    await expect(menu).toHaveCount(0)
    await expect
      .poll(async () => (await page.context().cookies()).find((one) => one.name === 'theme')?.value)
      .toBe('dark')
  })

  await test.step('`/mo` opens the menu of the level', async () => {
    await run('/mo')
    const menu = page.getByRole('menu', { name: 'Размышление' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  await test.step('`/help` opens the list whole, and `/resume` leads to the chats', async () => {
    await run('/help')
    await expect(commands(page)).toBeFocused()
    await expect(commands(page).getByRole('option', { name: /Справка/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await run('/resume')
    await expect(page).toHaveURL('/chats')
  })
})

test('the last row of the window of commands is seen whole at any height of a row', async ({
  page,
  signedInUser,
}) => {
  await addLongDialog(signedInUser.id, 2)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chats/new')
  await message(page).fill('/')
  const rows = commands(page).getByRole('option')
  await expect(rows.first()).toBeInViewport({ ratio: 1 })
  // A scroll stops on a whole pixel. The fonts of a run decide where the last row ends, so the
  // end is put on .3 of a pixel: rounded down, a row with no margin stays that far outside.
  await commands(page).evaluate((list) => {
    const options = list.querySelectorAll<HTMLElement>('[role="option"]')
    const edge =
      list.getBoundingClientRect().bottom - parseFloat(getComputedStyle(list).borderBottomWidth)
    const end = options[options.length - 1]!.getBoundingClientRect().bottom - edge
    options[0]!.style.marginTop = `${(1.3 - (end - Math.floor(end))) % 1}px`
  })
  await page.keyboard.press('End')
  await expect(rows.last()).toBeInViewport({ ratio: 1 })
})

// A task in the browser (docs/plan/57-browser-tasks.md, Б29; docs/plan/59, И1, И11, И12, И14,
// И17, И18): the browser is a tool of the dialog like the others — behind «+» and «Взять
// управление» of the card, no button of the feed only shows it (owner's answer of 30.10.2026) —,
// never open by itself at a load: no stream here, so it does not open by itself as it starts
// either. It shows the real state of the session: no worker runs in this stand, and the cabinet
// has no stream to open, so the panel says it cannot show the browser — the stream itself is
// proven by `pnpm verify:browser-task`. The page says the client looks at the dialog while the
// session holds a browser (`browser.watch`, И18).

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
  const { taskId, title } = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const calls = recordCalls(page)
  await page.goto(`/chats/${taskId}`)

  await test.step('the question to sign in, the chat alone: the browser waits behind «+»', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    await expect(loginCard(page)).toBeVisible()
    await expectChatAlone(page)
    // The browser waits for the client: «+» says so, the panel stays closed (И13).
    await expect(plus(page)).toHaveAccessibleName('Инструменты — браузер ждёт вас')
    // «Взять управление» alone: the browser itself is in «+» (owner's answer of 30.10.2026).
    await expect(loginCard(page).getByRole('button')).toHaveCount(1)
    await expect(loginCard(page).getByRole('button', { name: 'Взять управление' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Открыть браузер' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Смотреть, что делает агент' })).toHaveCount(0)
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
    await expect(dialogs(page)).toBeVisible()
    await expect(back(page)).toBeHidden()
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

  await test.step('«+» → «Браузер» opens it again; «Скрыть панель» closes it', async () => {
    await chooseTool(page, /^Браузер/)
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
    expect(full.x).toBeLessThanOrEqual(73)
    expect(full.x + full.width).toBeGreaterThanOrEqual(1279)
    // The rail stays beside it.
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible()
    // What it covers leaves the tab order: the list and the way back to it (И17).
    await expect(page.locator('[data-chat-list]')).toHaveAttribute('inert', '')
    await expect(page.locator('[data-chat-back]')).toHaveAttribute('inert', '')
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
    // The client looked at the dialog of a live browser: the page said so (И18).
    expect(calls).toContain('browser.watch')
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

  await test.step('the window of commands has no commands of the site', async () => {
    await page.getByRole('button', { name: 'Команды' }).click()
    // With /usage, /status and /context of the chat (#105).
    await expect(commands(page).getByRole('option')).toHaveCount(15)
    await expect(commands(page).getByText('Сайт', { exact: true })).toHaveCount(0)
    await expect(commands(page).getByRole('option', { name: /Отменить чат/ })).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test('a task in the browser on a phone: the browser in place of the dialog, «К чату» back', async ({
  page,
  context,
  signedInUser,
}) => {
  test.slow()
  const { taskId } = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/chats/${taskId}`)

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

  await test.step('«+» → «Браузер» takes the place of the dialog; «К чату» leads back', async () => {
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

  await test.step('«Взять управление» of the card opens it in place of the dialog too, the focus on its tab', async () => {
    await expect(loginCard(page).getByRole('button')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Открыть браузер' })).toHaveCount(0)
    await loginCard(page).getByRole('button', { name: 'Взять управление' }).click()
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

// In a window lower than 420px the head goes with the page (WCAG 1.4.10): «+» is out of sight
// while the client reads further down. «К чату» brings the feed back where it was read and
// gives the focus to «+» where it stands — never scrolling the page up to the head (docs/plan/59,
// И14, И19).
test('a task in the browser in a window lower than 420px: «К чату» keeps the place, not the head', async ({
  page,
  signedInUser,
}) => {
  const { taskId } = await addBrowserTask(signedInUser.id)
  await hideDevIndicator(page)
  await page.setViewportSize({ width: 320, height: 256 })
  await page.goto(`/chats/${taskId}`)
  await expect(loginCard(page)).toBeVisible()
  // The client reads the question to sign in, the head above it out of sight; «Взять управление»
  // of its card opens the browser (owner's answer of 30.10.2026: no button only shows it).
  const open = loginCard(page).getByRole('button', { name: 'Взять управление' })
  await open.scrollIntoViewIfNeeded()
  await expect(open).toBeInViewport()
  await expect(plus(page)).not.toBeInViewport()
  const place = await page.evaluate(() => Math.round(window.scrollY))
  await open.click()
  await expectBrowserShown(page)
  await expect(toDialog(page)).toBeVisible()
  await toDialog(page).click()
  await expectChatAlone(page)
  await expect(plus(page)).toBeFocused()
  await expect
    .poll(() => page.evaluate((top) => Math.abs(Math.round(window.scrollY) - top), place))
    .toBeLessThanOrEqual(1)
  await expect(open).toBeInViewport()
  await expect(plus(page)).not.toBeInViewport()
})

// docs/plan/61-chats-first.md, К31: the answer to `/init` becomes the notes of the project only as
// the client saw and left it, beside the notes that stand.
