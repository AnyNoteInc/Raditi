// The cabinet in a real Chromium (Playwright of the build copy): the dialog page of a task in the
// browser, its pane with the canvas of the stream, «Взять управление», the keyboard of the client
// going into the page through the pane's own input, «Продолжить работу агента». What the page's
// WebSocket carries is read beside it (Playwright's `framereceived`), decoded with the codec of
// the domain: the stand checks the frames the canvas drew, not only that something was drawn.
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const TEXT = Object.freeze({
  canvas: 'Страница сайта в браузере задачи',
  toolbar: 'Управление браузером',
  take: 'Взять управление',
  resume: 'Продолжить работу агента',
  address: 'Адрес страницы',
  keyboard: 'Ввод на страницу',
  otherTab: 'Управление в другой вкладке',
})

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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
  })
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
    open: (taskId) => openTab(stand, context, taskId),
    close: () => browser.close(),
  }
}

/**
 * The dialog page of a task in a new tab, with what its stream carries: the frames (decoded), the
 * states and the viewer id the gateway gave this tab, the acknowledgements it sent.
 */
async function openTab(stand, context, taskId) {
  const { domain } = stand.streamTools
  const page = await context.newPage()
  const tab = {
    page,
    frames: [],
    acks: 0,
    sockets: 0,
    viewerId: null,
    state: null,
    refusals: [],
    holds() {
      return (
        tab.state !== null &&
        tab.state.controller === 'user' &&
        tab.state.holder === tab.viewerId &&
        tab.state.manualReady
      )
    },
  }
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(stand.streamUrl)) return
    tab.sockets += 1
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') {
        const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        const frame = domain.decodeBrowserFrame(bytes)
        if (frame) tab.frames.push({ ...frame.header, size: frame.jpeg.byteLength, at: Date.now() })
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
  await page.goto(`${stand.webUrl}/projects/${stand.state.siteId}/chat/${taskId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  })
  tab.canvas = page.getByRole('img', { name: TEXT.canvas })
  await tab.canvas.waitFor({ timeout: 120_000 })
  tab.toolbar = page.getByRole('toolbar', { name: TEXT.toolbar })
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
    async take() {
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
