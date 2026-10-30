// The cabinet in a real Chromium (Playwright of the build copy): «Новый диалог», the dialog page of
// a task in the browser as the client opens it — the chat alone, its tools behind «+»
// (docs/plan/59-dialog-tools-panel.md, И1) —, the panel of its browser with the canvas of the
// stream, «Взять управление», the keyboard of the client going into the page through the pane's
// own input, «Продолжить работу агента». What the page's WebSocket carries is read beside it
// (Playwright's `framereceived`), decoded with the codec of the domain: the stand checks the frames
// the canvas drew, not only that something was drawn. What the page asks the server for — the
// procedures of its tRPC requests —, the answers of its feed and every time its panel of the tools
// comes on the screen are counted too: the browser of a task is read only once the client opens it
// or once it starts on the client's eyes (И2, И11).
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { trpcProcedures } from '../release-verify/stand.mjs'

const TEXT = Object.freeze({
  canvas: 'Страница сайта в браузере задачи',
  toolbar: 'Управление браузером',
  take: 'Взять управление',
  resume: 'Продолжить работу агента',
  address: 'Адрес страницы',
  keyboard: 'Ввод на страницу',
  otherTab: 'Управление в другой вкладке',
  /** «+» of the dialog: its name, then what its dot says (И4, И13). */
  tools: /^Инструменты/,
  /** The name of «+» while the browser of the task asks the client for help (И13). */
  toolsWaiting: 'Инструменты — браузер ждёт вас',
  /** The menu of «+» and its tile of the browser: the name, then who drives it (И5). */
  menu: 'Инструменты',
  browserTile: /^Браузер/,
  /** The panel of the open tools, the tab of the browser on it, and «Скрыть панель» (И7, И20). */
  panel: 'Инструменты диалога',
  browserTab: 'Браузер',
  hide: 'Скрыть панель',
  /** The field of «Новый диалог» and its button. */
  field: 'Сообщение',
  send: 'Отправить',
  /** The rows of the dialog: the card of the browser's request is one of them. */
  feed: 'Сообщения диалога',
})

/** The panel of the tools in the document: drawn only while a tool is open (И20). */
const PANEL_SELECTOR = `aside[aria-label="${TEXT.panel}"]`

/**
 * The window of the cabinet: wider than `lg` (1200 px), where the tools stand beside the dialog —
 * the browser of a task that starts on the client's eyes opens beside it there, and the panel has
 * «Скрыть панель»; below `lg` the browser opens by itself too, in place of the dialog, and «К
 * диалогу» leads back (И3, И14, owner's answers of 30.10.2026).
 */
const VIEWPORT = Object.freeze({ width: 1440, height: 1000 })

/** The address of a dialog: its id, as the page of «Новый диалог» invented it. */
const DIALOG_PATH = /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Whether the web of the copy has the browser pane of the dialog page (slice S9b). */
export async function cabinetAvailable(stand) {
  return access(join(stand.copy, 'apps/web/src/components/chat/browser-pane.tsx')).then(
    () => true,
    () => false,
  )
}

/** A Chromium of the copy's Playwright with the owner's session cookie. */
export async function cabinetBrowser(stand, client) {
  const require = createRequire(join(stand.copy, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'ru-RU' })
  await context.addCookies(
    client
      .cookie()
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=')
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stand.webUrl }
      }),
  )
  return {
    browser,
    context,
    /** The dialog page of a task as the client opens it: the chat alone. */
    load: (taskId) => loadTab(stand, context, taskId),
    /** The dialog page of a task, its browser opened from «+». */
    async open(taskId) {
      const tab = await loadTab(stand, context, taskId)
      await tab.showBrowser()
      return tab
    },
    /** «Новый диалог»: the client writes `words` and sends them; the page moves to the dialog. */
    start: (words) => startDialog(stand, context, words),
    close: () => browser.close(),
  }
}

/**
 * Runs in every document of a tab before the page's own scripts (an init script): the moments the
 * panel of the tools comes on the screen, and how often the focus lands in it. A document starts
 * with none of them: a reload counts afresh.
 */
function watchTools(selector) {
  const seen = { panels: [], focusIn: 0 }
  window.__raditiStandTools = seen
  let drawn = false
  new MutationObserver(() => {
    const now = document.querySelector(selector) !== null
    if (now && !drawn) seen.panels.push(Date.now())
    drawn = now
  }).observe(document, { childList: true, subtree: true })
  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target instanceof Element && event.target.closest(selector) !== null)
        seen.focusIn += 1
    },
    true,
  )
}

/**
 * A new tab of the cabinet and what is read beside it: the frames its stream carries (decoded),
 * the states and the viewer id the gateway gave it, the acknowledgements it sent, the procedures
 * it called and the answers of the feed it got.
 */
async function newTab(stand, context) {
  const { domain } = stand.streamTools
  const page = await context.newPage()
  await page.addInitScript(watchTools, PANEL_SELECTOR)
  const tab = {
    page,
    taskId: null,
    /** Each with the number of the socket that carried it. */
    frames: [],
    acks: 0,
    /** The sockets of the stream the page opened, numbered from 1. */
    sockets: 0,
    viewerId: null,
    state: null,
    refusals: [],
    /** The procedures the page called, in order, each with the moment of its request. */
    calls: [],
    /** The answers of `task.feed` the page got. */
    feeds: 0,
    plus: page.getByRole('button', { name: TEXT.tools }),
    panel: page.getByRole('complementary', { name: TEXT.panel }),
    canvas: page.getByRole('img', { name: TEXT.canvas }),
    toolbar: page.getByRole('toolbar', { name: TEXT.toolbar }),
    holds() {
      return (
        tab.state !== null &&
        tab.state.controller === 'user' &&
        tab.state.holder === tab.viewerId &&
        tab.state.manualReady
      )
    },
    /** How many times the page called `name` since its `from`-th call. */
    called: (name, from = 0) => tab.calls.slice(from).filter((call) => call.name === name).length,
    /** Waits until the page has read the feed `count` more times: what it draws follows them. */
    async answers(count = 2) {
      const from = tab.feeds
      await stand.rt.until(
        `${count} more answers of the feed in the cabinet`,
        async () => tab.feeds >= from + count,
        { timeoutMs: 60_000, intervalMs: 100 },
      )
    },
    /**
     * What the document has seen of the panel since it loaded (`watchTools`): the moments it came
     * on the screen, how often the focus landed in it, and whether it holds the focus now.
     */
    seen: () =>
      page.evaluate((selector) => {
        const seen = window.__raditiStandTools ?? null
        const active = document.activeElement
        return {
          panels: seen === null ? null : [...seen.panels],
          focusIn: seen === null ? null : seen.focusIn,
          focusInPanel: active instanceof Element && active.closest(selector) !== null,
        }
      }, PANEL_SELECTOR),
    /** «+» → «Браузер»: the panel of the tools opens on the browser's tab, its canvas there. */
    async showBrowser() {
      await tab.plus.click()
      await page
        .getByRole('menu', { name: TEXT.menu })
        .getByRole('menuitem', { name: TEXT.browserTile })
        .click()
      await tab.panel
        .getByRole('tab', { name: TEXT.browserTab, selected: true })
        .waitFor({ timeout: 30_000 })
      await tab.canvas.waitFor({ timeout: 120_000 })
    },
    /**
     * «Взять управление» on the card of the browser's request in the feed: with the panel closed
     * it opens the browser and asks for the control at once (И12); done once the stream says this
     * tab holds it.
     */
    async takeFromCard() {
      await page
        .getByRole('list', { name: TEXT.feed })
        .getByRole('button', { name: TEXT.take })
        .last()
        .click()
      await tab.panel
        .getByRole('tab', { name: TEXT.browserTab, selected: true })
        .waitFor({ timeout: 30_000 })
      await tab.canvas.waitFor({ timeout: 60_000 })
      await stand.rt.until('this tab of the cabinet to hold control', async () => tab.holds(), {
        timeoutMs: 30_000,
        intervalMs: 100,
      })
    },
    /** «Скрыть панель» (from `lg`): every tab closes at once, nothing is sent (И8). */
    async hidePanel() {
      await tab.panel.getByRole('button', { name: TEXT.hide }).click()
      await tab.panel.waitFor({ state: 'detached', timeout: 15_000 })
    },
    /** «+» holds the focus. */
    plusFocused: () => tab.plus.evaluate((element) => element === document.activeElement),
    /** The page loaded again: a new document, whose head draws «+» with its first answer. */
    async reload() {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await tab.plus.waitFor({ timeout: 120_000 })
    },
  }
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(stand.streamUrl)) return
    tab.sockets += 1
    const number = tab.sockets
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') {
        const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        const frame = domain.decodeBrowserFrame(bytes)
        if (frame)
          tab.frames.push({
            ...frame.header,
            size: frame.jpeg.byteLength,
            at: Date.now(),
            socket: number,
          })
        return
      }
      const message = domain.parseBrowserServerMessage(payload)
      if (message?.t === 'viewer') tab.viewerId = message.viewer
      if (message?.t === 'state') tab.state = message
      if (message?.t === 'refused') tab.refusals.push(message.reason)
    })
    socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string' && payload.includes('"t":"ack"')) tab.acks += 1
    })
  })
  page.on('request', (request) => {
    const at = Date.now()
    for (const name of trpcProcedures(request.url())) tab.calls.push({ name, at })
  })
  page.on('response', (response) => {
    if (response.ok() && trpcProcedures(response.url()).includes('task.feed')) tab.feeds += 1
  })
  return tab
}

/** The dialog page of a task in a new tab, as the client opens it: the chat alone. */
async function loadTab(stand, context, taskId) {
  const tab = await newTab(stand, context)
  tab.taskId = taskId
  await tab.page.goto(`${stand.webUrl}/projects/${stand.state.siteId}/chat/${taskId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  })
  // The head of the dialog draws «+» once the first answer of its feed is in.
  await tab.plus.waitFor({ timeout: 120_000 })
  return tab
}

/**
 * «Новый диалог» in a new tab: the client writes `words` and sends them; the page starts the
 * dialog itself (`task.create` with the id it invented) and moves to it, watching it from before
 * its browser was there (И3). What the tab counts starts with the screen of «Новый диалог».
 */
async function startDialog(stand, context, words) {
  const tab = await newTab(stand, context)
  const { page } = tab
  await page.goto(`${stand.webUrl}/projects/${stand.state.siteId}/chat/new`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  })
  // The screen comes drawn by the server: words written before React took the field over may be
  // lost, and «Отправить» stays closed until the field holds them — written again until it opens.
  const field = page.getByRole('textbox', { name: TEXT.field, exact: true })
  const send = page.getByRole('button', { name: TEXT.send, exact: true })
  await stand.rt.until(
    'the field of «Новый диалог» to take the words',
    async () => {
      await field.fill(words, { timeout: 10_000 })
      return send.isEnabled()
    },
    { timeoutMs: 120_000, intervalMs: 500 },
  )
  await send.click()
  tab.taskId = await stand.rt.until(
    'the page to move to the dialog it started',
    async () => DIALOG_PATH.exec(new URL(page.url()).pathname)?.[1] ?? null,
    { timeoutMs: 60_000, intervalMs: 100 },
  )
  await tab.plus.waitFor({ timeout: 120_000 })
  return tab
}

/**
 * What the canvas holds: the colours of its drawn (opaque) pixels and their share of the canvas —
 * the letterbox around the picture is cleared, so a painted canvas is a large opaque part of many
 * colours, an empty pane none.
 */
export async function canvasPainted(tab) {
  return tab.canvas.evaluate((canvas) => {
    const context = canvas.getContext('2d')
    if (!context || canvas.width === 0 || canvas.height === 0) return { colours: 0, drawn: 0 }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const colours = new Set()
    let sampled = 0
    let opaque = 0
    const step = Math.max(1, Math.floor(data.length / 4 / 20_000)) * 4
    for (let index = 0; index < data.length; index += step) {
      sampled += 1
      if (data[index + 3] !== 255) continue
      opaque += 1
      colours.add(`${data[index]},${data[index + 1]},${data[index + 2]}`)
    }
    return {
      colours: colours.size,
      drawn: Math.round((opaque / sampled) * 100) / 100,
      width: canvas.width,
      height: canvas.height,
    }
  })
}

/**
 * The client as the cabinet acts: «Взять управление» in the toolbar, the address field of the
 * pane, the keyboard into the pane's own input (real key events of Chromium), «Продолжить работу
 * агента». The same verbs as the stream operator of stream.mjs.
 */
export function cabinetOperator(stand, tab) {
  const { page } = tab
  const until = (what, check, timeoutMs = 30_000) =>
    stand.rt.until(what, async () => check(), { timeoutMs, intervalMs: 100 })
  const focus = () => page.getByLabel(TEXT.keyboard).focus()
  return {
    kind: 'cabinet',
    tab,
    state: () => tab.state,
    holds: () => tab.holds(),
    /** This tab takes the control: nothing to press when it holds it already (`takeFromCard`). */
    async take() {
      if (tab.holds()) return
      await tab.toolbar.getByRole('button', { name: TEXT.take }).click()
      await until('this tab of the cabinet to hold control', () => tab.holds())
    },
    async navigate(url) {
      const field = page.getByLabel(TEXT.address)
      await field.fill(url)
      await field.press('Enter')
    },
    async type(text) {
      await focus()
      await page.keyboard.type(text, { delay: 15 })
    },
    async press(key) {
      await focus()
      await page.keyboard.press(key)
    },
    async resume() {
      await tab.toolbar.getByRole('button', { name: TEXT.resume }).click()
    },
    otherTabShown: () => tab.toolbar.getByText(TEXT.otherTab).isVisible(),
    close: () => page.close(),
  }
}

/** The texts the stand looks for in the cabinet. */
export const CABINET_TEXT = TEXT
