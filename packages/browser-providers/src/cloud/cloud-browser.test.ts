import {
  isDomainError,
  isPageBrowserError,
  type BrowserTaskPolicy,
  type CloudBrowserConnection,
  type CloudBrowserEvent,
  type CloudBrowserFrame,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { createPlaywrightCloudBrowser } from './cloud-browser.ts'
import { SECRET_INPUTS } from './secret-fields.ts'

// The session against a minimal Playwright of its own: what it decides before and around the
// browser — the connection, the route, references, secret fields, held input, tabs, dialogs,
// the screencast. Its work on a real Chromium is cloud-browser.integration.test.ts.

const SECRET_PATH = `/${'s'.repeat(43)}`
const ORIGIN = 'https://example.ru'

type Listener = (...args: never[]) => unknown

class Emitter {
  readonly #listeners = new Map<string, Listener[]>()
  on(event: string, listener: Listener) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? [])
      (listener as (...a: unknown[]) => unknown)(...args)
  }
}

class FakeFrame {
  address = 'about:blank'
  readonly owner: FakePage
  readonly parent: FakeFrame | null
  constructor(owner: FakePage, parent: FakeFrame | null) {
    this.owner = owner
    this.parent = parent
  }
  url() {
    return this.address
  }
  parentFrame() {
    return this.parent
  }
  page() {
    return this.owner
  }
  locator(selector: string) {
    return this.owner.locator(selector)
  }
}

/** What the fake pages did, in order, for every page of a context. */
type Log = string[]

class FakePage extends Emitter {
  readonly main = new FakeFrame(this, null)
  closed = false
  titleText = ''
  tree = '- generic [ref=e1]'
  /** References a locator of the last tree finds. */
  refs = new Set<string>()
  secretFields: { ref: string; value: string }[] = []
  /** Where a click on a reference navigates the page: a link. */
  links = new Map<string, string>()
  cast: { onFrame: (frame: unknown) => Promise<unknown>; size: unknown; quality: unknown } | null =
    null
  readonly name: string
  readonly log: Log
  readonly context: FakeContext
  constructor(name: string, log: Log, context: FakeContext) {
    super()
    this.name = name
    this.log = log
    this.context = context
  }
  #record(entry: string) {
    this.log.push(`${this.name} ${entry}`)
  }
  readonly keyboard = {
    down: async (key: string) => this.#record(`key down ${key}`),
    up: async (key: string) => this.#record(`key up ${key}`),
    press: async (key: string) => this.#record(`key press ${key}`),
    insertText: async (text: string) => this.#record(`insert ${text}`),
  }
  readonly mouse = {
    move: async (x: number, y: number) => this.#record(`mouse move ${x},${y}`),
    down: async (options: { button: string }) => this.#record(`mouse down ${options.button}`),
    up: async (options: { button: string }) => this.#record(`mouse up ${options.button}`),
    wheel: async (dx: number, dy: number) => this.#record(`wheel ${dx},${dy}`),
  }
  readonly screencast = {
    start: async (options: NonNullable<FakePage['cast']>) => {
      this.cast = options
      this.#record('cast start')
    },
    stop: async () => {
      this.cast = null
      this.#record('cast stop')
    },
  }
  url() {
    return this.main.address
  }
  async title() {
    return this.titleText
  }
  isClosed() {
    return this.closed
  }
  mainFrame() {
    return this.main
  }
  frames() {
    return [this.main]
  }
  /** A navigation as Chromium makes it: routed first, committed unless the route aborted it. */
  async goto(url: string) {
    this.#record(`goto ${url}`)
    if (url !== 'about:blank') {
      const verdict = await this.context.routeRequest({ url, page: this, navigation: true })
      if (verdict !== 'continue') throw new Error('net::ERR_BLOCKED_BY_CLIENT')
    }
    this.commit(url)
    return null
  }
  commit(url: string) {
    this.main.address = url
    this.emit('framenavigated', this.main)
  }
  async waitForLoadState() {}
  async ariaSnapshot() {
    this.#record('snapshot page')
    return this.tree
  }
  locator(selector: string) {
    if (selector === SECRET_INPUTS)
      return {
        count: async () => this.secretFields.length,
        nth: (index: number) => {
          const field = this.secretFields[index]
          return {
            ariaSnapshot: async () => {
              this.#record(`snapshot field ${field?.ref}`)
              return `- textbox "Поле" [ref=${field?.ref}]: ${field?.value}`
            },
            inputValue: async () => field?.value ?? '',
          }
        },
      }
    const ref = /^aria-ref=(.+)$/.exec(selector)?.[1] ?? ''
    return {
      count: async () => (this.refs.has(ref) ? 1 : 0),
      click: async () => {
        this.#record(`click ${ref}`)
        const link = this.links.get(ref)
        if (link === undefined) return
        const verdict = await this.context.routeRequest({ url: link, page: this, navigation: true })
        this.commit(verdict === 'continue' ? link : 'chrome-error://chromewebdata/')
      },
      fill: async (text: string) => this.#record(`fill ${ref} ${text}`),
      press: async (key: string) => this.#record(`press ${ref} ${key}`),
      innerText: async () => '',
      ariaSnapshot: async () => {
        this.#record(`snapshot ${ref}`)
        return `- textbox [ref=${ref}]`
      },
    }
  }
  async setViewportSize(size: { width: number; height: number }) {
    this.#record(`viewport ${size.width}x${size.height}`)
  }
  async bringToFront() {}
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakeContext extends Emitter {
  route?: (route: unknown) => Promise<unknown>
  readonly pages: FakePage[] = []
  readonly request = { get: vi.fn() }
  readonly log: Log
  constructor(log: Log) {
    super()
    this.log = log
  }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async close() {
    this.log.push('context close')
  }
  async newPage() {
    return this.open()
  }
  /** A page of the context: the first one, a popup, a `target=_blank`. */
  open() {
    const page = new FakePage(`p${this.pages.length + 1}`, this.log, this)
    this.pages.push(page)
    this.emit('page', page)
    return page
  }
  async routeRequest(request: {
    url: string
    page: FakePage
    navigation: boolean
    method?: string
    postData?: string | null
    headers?: Record<string, string>
  }): Promise<string> {
    let verdict = ''
    await this.route?.({
      request: () => ({
        url: () => request.url,
        method: () => request.method ?? 'GET',
        postData: () => request.postData ?? null,
        headers: () => request.headers ?? {},
        isNavigationRequest: () => request.navigation,
        frame: () => request.page.main,
      }),
      continue: async () => {
        verdict = 'continue'
      },
      abort: async (code: string) => {
        verdict = code
      },
    })
    return verdict
  }
}

function fakeBrowser() {
  const log: Log = []
  const context = new FakeContext(log)
  const browser = Object.assign(new Emitter(), {
    connected: true,
    newContext: vi.fn(async () => context),
    isConnected: () => browser.connected,
    close: vi.fn(async () => {
      browser.connected = false
    }),
  })
  // The route and the listeners are on before the first page.
  const route = vi.fn(async (_pattern: string, handler: (route: unknown) => Promise<unknown>) => {
    context.route = handler
  })
  Object.assign(context, { route })
  return { log, context, browser, connect: vi.fn(async () => browser as never) }
}

const policy: BrowserTaskPolicy = {
  startPath: '/wp-admin/',
  extraHosts: [],
  requestDenied: ({ path, method }) =>
    path.startsWith('/wp-admin/users.php') || (method === 'DELETE' && path.startsWith('/wp-json/')),
  pageDenied: (path) => path.startsWith('/wp-admin/plugins.php'),
}

function connectionWith(events: CloudBrowserEvent[] = []): CloudBrowserConnection {
  return {
    endpoint: `ws://127.0.0.1:9333${SECRET_PATH}`,
    allowedHosts: ['example.ru:443', 'www.example.ru:443'],
    localSites: [],
    startUrl: `${ORIGIN}/wp-admin/`,
    viewport: { width: 1280, height: 800 },
    policy,
    onEvent: (event) => events.push(event),
  }
}

async function opened() {
  const fake = fakeBrowser()
  const events: CloudBrowserEvent[] = []
  const session = await createPlaywrightCloudBrowser({ connect: fake.connect }).open(
    connectionWith(events),
  )
  const page = fake.context.pages[0] as FakePage
  return { ...fake, events, session, page }
}

const codeOf = (error: unknown) =>
  isPageBrowserError(error) ? error.reason : isDomainError(error) ? error.code : String(error)

/** The smallest JPEG this adapter reads a size from: SOI and a baseline frame header. */
const jpeg = (width: number, height: number) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ])

describe('the cloud browser session', () => {
  it('connects only to a control socket on loopback, for a start page of the session', async () => {
    const { connect } = fakeBrowser()
    const factory = createPlaywrightCloudBrowser({ connect })
    for (const wrong of [
      { endpoint: `ws://10.0.0.1:9333${SECRET_PATH}` },
      { endpoint: `wss://127.0.0.1:9333${SECRET_PATH}` },
      { endpoint: 'not a url' },
      { startUrl: 'https://elsewhere.example/' },
      { startUrl: `${ORIGIN}/wp-admin/plugins.php` },
      { viewport: { width: 1000, height: 700 } },
    ])
      await expect(factory.open({ ...connectionWith(), ...wrong })).rejects.toThrow(
        'Invalid cloud browser connection',
      )
    expect(connect).not.toHaveBeenCalled()
  })

  it('says a browser it cannot reach is closed, and never names its secret path', async () => {
    const connect = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ws://127.0.0.1:9333${SECRET_PATH}`)
    })
    const error = await createPlaywrightCloudBrowser({ connect, connectTimeoutMs: 1_234 })
      .open(connectionWith())
      .catch((caught: unknown) => caught)
    expect(codeOf(error)).toBe('closed')
    expect(String((error as Error).message)).not.toContain(SECRET_PATH)
    expect(connect).toHaveBeenCalledExactlyOnceWith(`ws://127.0.0.1:9333${SECRET_PATH}`, {
      timeout: 1_234,
    })
  })

  it('opens one context that records nothing, and its first page at the start address', async () => {
    const { browser, page, events, session, log } = await opened()
    expect(browser.newContext).toHaveBeenCalledExactlyOnceWith({
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
    })
    expect(log).toContain(`p1 goto ${ORIGIN}/wp-admin/`)
    expect(page.url()).toBe(`${ORIGIN}/wp-admin/`)
    expect(session.shown()).toBe(1)
    expect(events).toContainEqual({ kind: 'navigation', pageId: 1, url: `${ORIGIN}/wp-admin/` })
    expect(events).toContainEqual({
      kind: 'tabs',
      tabs: [{ pageId: 1, url: 'about:blank', title: '' }],
      shown: 1,
    })
  })

  it('aborts requests to other hosts and what the stack denies, for every page', async () => {
    const { context, page } = await opened()
    const ask = (url: string, more = {}) =>
      context.routeRequest({ url, page, navigation: false, ...more })
    expect(await ask(`${ORIGIN}/wp-json/wp/v2/media`, { method: 'POST' })).toBe('continue')
    expect(await ask('https://elsewhere.example/pixel.gif')).toBe('blockedbyclient')
    expect(await ask(`${ORIGIN}/wp-admin/users.php`)).toBe('accessdenied')
    expect(await ask(`${ORIGIN}/wp-admin/plugins.php`, { navigation: true })).toBe('accessdenied')
    // A deletion the page sends as a POST with a method override is a deletion.
    expect(
      await ask(`${ORIGIN}/wp-json/wp/v2/posts/7`, {
        method: 'POST',
        headers: { 'X-HTTP-Method-Override': 'DELETE' },
      }),
    ).toBe('accessdenied')
    const popup = context.open()
    expect(
      await context.routeRequest({
        url: 'https://elsewhere.example/',
        page: popup,
        navigation: true,
      }),
    ).toBe('blockedbyclient')
  })

  it('says a click was denied when the navigation it started was refused', async () => {
    const { session, page } = await opened()
    page.refs = new Set(['e2', 'e3'])
    page.links.set('e2', `${ORIGIN}/wp-admin/plugins.php`)
    page.links.set('e3', `${ORIGIN}/wp-admin/edit.php`)
    await session.observe({})
    await expect(session.act({ tool: 'web_click', ref: 'e2' })).rejects.toSatisfy(
      (error) => codeOf(error) === 'denied',
    )
    expect(page.url()).toBe('chrome-error://chromewebdata/')
    await session.observe({})
    expect(await session.act({ tool: 'web_click', ref: 'e3' })).toEqual({
      page: { pageId: 1, url: `${ORIGIN}/wp-admin/edit.php`, title: '' },
    })
  })

  it('refuses an address outside the session before the page is asked', async () => {
    const { session, log } = await opened()
    log.length = 0
    for (const url of ['https://elsewhere.example/', `${ORIGIN}/wp-admin/plugins.php`]) {
      await expect(session.act({ tool: 'web_open', url })).rejects.toSatisfy(
        (error) => codeOf(error) === 'denied',
      )
      await expect(session.navigate(url)).rejects.toSatisfy((error) => codeOf(error) === 'denied')
    }
    expect(log).toEqual([])
  })

  it('drops what a redirect committed where the session may not be, and says the action was denied', async () => {
    const { session, page, events, log } = await opened()
    // The route sees the first address of a chain only: the page lands where the policy denies.
    page.goto = vi.fn(async (url: string) => {
      log.push(`p1 goto ${url}`)
      page.commit(url === 'about:blank' ? url : `${ORIGIN}/wp-admin/plugins.php`)
      return null
    }) as never
    events.length = 0
    await expect(
      session.act({ tool: 'web_open', url: `${ORIGIN}/wp-admin/edit.php` }),
    ).rejects.toSatisfy((error) => codeOf(error) === 'denied')
    expect(log.at(-1)).toBe('p1 goto about:blank')
    expect(page.url()).toBe('about:blank')
    // The address it was dropped from is told to no one.
    expect(JSON.stringify(events)).not.toContain('plugins.php')
  })

  it('acts only on references of the shown page’s latest tree', async () => {
    const { session, page, context, log } = await opened()
    page.refs.add('e5')
    const click = () => session.act({ tool: 'web_click', ref: 'e5' })
    const stale = (error: unknown) => codeOf(error) === 'BROWSER_STALE_OBSERVATION'
    // Before any tree.
    await expect(click()).rejects.toSatisfy(stale)
    await session.observe({})
    await click()
    expect(log).toContain('p1 click e5')
    // The page navigated since.
    page.commit(`${ORIGIN}/wp-admin/post.php?post=12&action=edit`)
    await expect(click()).rejects.toSatisfy(stale)
    await session.observe({})
    await click()
    // Playwright no longer finds it in the last tree of its frame.
    page.refs.delete('e5')
    await expect(click()).rejects.toSatisfy(stale)
    // Another page was shown since.
    page.refs.add('e5')
    await session.observe({})
    const popup = context.open()
    await session.selectTab(2)
    popup.refs.add('e5')
    await expect(click()).rejects.toSatisfy(stale)
    // Never a selector of anything but a reference.
    await session.observe({})
    log.length = 0
    await expect(session.act({ tool: 'web_click', ref: 'e5 >> css=body' })).rejects.toSatisfy(stale)
    expect(log).toEqual([])
  })

  it('hides the values of secret fields, their own trees read before the page’s', async () => {
    const { session, page, log } = await opened()
    page.secretFields = [{ ref: 'e3', value: 'Tr0ub4dor&3' }]
    page.tree = [
      '- generic [ref=e1]:',
      '  - textbox "Поле 2" [ref=e3]: Tr0ub4dor&3',
      '  - textbox "Пароль" [ref=e4]: pass-word-1',
      '  - textbox "Имя" [ref=e2]: admin',
    ].join('\n')
    log.length = 0
    const { tree } = await session.observe({})
    expect(tree).not.toContain('Tr0ub4dor&3')
    expect(tree).not.toContain('pass-word-1')
    expect(tree).toContain('- textbox "Имя" [ref=e2]: admin')
    expect(log.filter((entry) => entry.includes('snapshot'))).toEqual([
      'p1 snapshot field e3',
      'p1 snapshot page',
    ])
    // A subtree after a field's own tree: the page's is read again before it.
    page.refs.add('e1')
    log.length = 0
    await session.observe({ ref: 'e1' })
    expect(log.filter((entry) => entry.includes('snapshot'))).toEqual([
      'p1 snapshot field e3',
      'p1 snapshot page',
      'p1 snapshot e1',
    ])
  })

  it('lets go of every key and button the client holds, on the page that took them', async () => {
    const { session, context, log } = await opened()
    await session.input({
      kind: 'mouse',
      type: 'down',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
    await session.input({
      kind: 'key',
      type: 'down',
      key: 'a',
      code: 'KeyA',
      modifiers: ['Control'],
    })
    expect(log.slice(-3)).toEqual(['p1 mouse down left', 'p1 key down Control', 'p1 key down a'])
    // The key goes up with the modifier it went down with.
    await session.input({ kind: 'key', type: 'up', key: 'a', code: 'KeyA', modifiers: ['Control'] })
    expect(log.slice(-2)).toEqual(['p1 key up a', 'p1 key up Control'])
    // A lost key-up of a modifier does not stick: the next key says it is not held.
    await session.input({
      kind: 'key',
      type: 'down',
      key: 'Control',
      code: 'ControlLeft',
      modifiers: ['Control'],
    })
    await session.input({ kind: 'key', type: 'down', key: 'b', code: 'KeyB', modifiers: [] })
    expect(log.slice(-3)).toEqual(['p1 key down Control', 'p1 key up Control', 'p1 key down b'])
    log.length = 0
    await session.releaseInputs()
    expect(log).toEqual(['p1 mouse up left', 'p1 key up b'])
    log.length = 0
    await session.releaseInputs()
    expect(log).toEqual([])
    // Input to another page lets go first of what the first one holds.
    await session.input({
      kind: 'key',
      type: 'down',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: ['Shift'],
    })
    context.open()
    await session.selectTab(2)
    log.length = 0
    await session.input({ kind: 'text', text: 'Привет' })
    expect(log).toEqual(['p1 key up Shift', 'p2 insert Привет'])
  })

  it('puts no modifier of a shortcut on the click after it', async () => {
    const { session, log } = await opened()
    const key = (type: 'down' | 'up', name: string, modifiers: ('Control' | 'Shift')[]) =>
      session.input({ kind: 'key', type, key: name, code: '', modifiers })
    const click = (x: number) =>
      session.input({ kind: 'mouse', type: 'down', x, y: 5, button: 'left', clickCount: 1 })
    log.length = 0
    // Ctrl+S as the cabinet sends it: no key-up of Control of its own ever comes.
    await key('down', 's', ['Control'])
    await key('up', 's', ['Control'])
    await click(5)
    expect(log).toEqual([
      'p1 key down Control',
      'p1 key down s',
      'p1 key up s',
      'p1 key up Control',
      'p1 mouse move 5,5',
      'p1 mouse down left',
    ])
    // A modifier another held key went down with stays down until that key goes up.
    log.length = 0
    await key('down', 'a', ['Control'])
    await key('down', 'b', ['Control'])
    await key('up', 'a', ['Control'])
    await click(6)
    await key('up', 'b', ['Control'])
    expect(log).toEqual([
      'p1 key down Control',
      'p1 key down a',
      'p1 key down b',
      'p1 key up a',
      'p1 mouse move 6,5',
      'p1 mouse down left',
      'p1 key up b',
      'p1 key up Control',
    ])
    // A modifier pressed as a key of its own is the client's to let go: a Shift+click.
    log.length = 0
    await key('down', 'Shift', ['Shift'])
    await click(7)
    await key('up', 'Shift', ['Shift'])
    expect(log).toEqual([
      'p1 key down Shift',
      'p1 mouse move 7,5',
      'p1 mouse down left',
      'p1 key up Shift',
    ])
  })

  it('lets go of a modifier no key holds before a mouse event, and sends no key Playwright lacks', async () => {
    const { session, page, log } = await opened()
    const down = page.keyboard.down
    // The page stops answering after Control went down: Shift never did, and nothing holds them.
    page.keyboard.down = async (key: string) => {
      if (key === 'Shift') throw new Error('Target page, context or browser has been closed')
      await down(key)
    }
    await expect(
      session.input({
        kind: 'key',
        type: 'down',
        key: 'a',
        code: '',
        modifiers: ['Control', 'Shift'],
      }),
    ).rejects.toSatisfy((error) => codeOf(error) === 'BROWSER_ACTION_FAILED')
    page.keyboard.down = down
    log.length = 0
    await session.input({ kind: 'wheel', x: 1, y: 2, dx: 0, dy: 100 })
    expect(log).toEqual([
      'p1 key up Control',
      'p1 key up Shift',
      'p1 mouse move 1,2',
      'p1 wheel 0,100',
    ])
    // A key that is no key of Playwright's keyboard: neither it nor its modifiers go down.
    log.length = 0
    for (const type of ['down', 'up'] as const)
      await session.input({
        kind: 'key',
        type,
        key: 'ж',
        code: 'Semicolon',
        modifiers: ['Control'],
      })
    await session.input({ kind: 'key', type: 'down', key: '€', code: '', modifiers: [] })
    expect(log).toEqual([])
    page.refs.add('e2')
    await session.observe({})
    log.length = 0
    for (const key of ['Control+ж', 'ж'])
      await expect(session.act({ tool: 'web_press', key })).rejects.toSatisfy(
        (error) => codeOf(error) === 'BROWSER_ACTION_FAILED',
      )
    await expect(session.act({ tool: 'web_press', ref: 'e2', key: 'Shift+ё' })).rejects.toSatisfy(
      (error) => codeOf(error) === 'BROWSER_ACTION_FAILED',
    )
    expect(log).toEqual([])
    await session.act({ tool: 'web_press', key: 'Control++' })
    expect(log).toContain('p1 key press Control++')
  })

  it('finds the element that has the focus from a whole tree of the page, in any frame', async () => {
    const { session, page, log } = await opened()
    page.tree = [
      '- generic [ref=e1]:',
      '  - iframe [active] [ref=e2]:',
      '    - textbox "Заголовок" [active] [ref=f1e1]',
      '  - button "Опубликовать" [ref=e3]',
    ].join('\n')
    log.length = 0
    expect(await session.focused()).toEqual({ role: 'textbox', name: 'Заголовок' })
    expect(log).toEqual(['p1 snapshot page'])
    // The agent reached the button with Tab: its latest tree still acts after the read.
    page.tree = '- generic [ref=e1]:\n  - button "Опубликовать" [active] [ref=e3]'
    page.refs.add('e3')
    await session.observe({})
    expect(await session.focused()).toEqual({ role: 'button', name: 'Опубликовать' })
    await session.act({ tool: 'web_click', ref: 'e3' })
    expect(log).toContain('p1 click e3')
    // A read that fails is a failure, never a guess.
    page.ariaSnapshot = async () => {
      throw Object.assign(new Error('Timeout 10000ms exceeded.'), { name: 'TimeoutError' })
    }
    await expect(session.focused()).rejects.toSatisfy((error) => codeOf(error) === 'timeout')
    // Under a dialog nothing takes a key, and the page is not asked.
    page.emit('dialog', {
      type: () => 'alert',
      message: () => 'Сохранено',
      defaultValue: () => '',
      accept: async () => undefined,
      dismiss: async () => undefined,
    })
    log.length = 0
    expect(await session.focused()).toBeNull()
    expect(log).toEqual([])
  })

  it('tracks every page as a tab, shows one only when asked, and another when it closes', async () => {
    const { session, context, events } = await opened()
    events.length = 0
    const popup = context.open()
    expect(session.tabs().map((tab) => tab.pageId)).toEqual([1, 2])
    expect(session.shown()).toBe(1)
    expect(events.at(-1)).toMatchObject({ kind: 'tabs', shown: 1 })
    popup.commit(`${ORIGIN}/?p=12&preview=true`)
    expect(events).toContainEqual({
      kind: 'navigation',
      pageId: 2,
      url: `${ORIGIN}/?p=12&preview=true`,
    })
    await session.closeTab(1)
    expect(session.shown()).toBe(2)
    expect(session.tabs().map((tab) => tab.pageId)).toEqual([2])
    // Numbers are never given again; a page past the limit is closed unseen.
    for (let index = 0; index < 8; index++) context.open()
    expect(session.tabs().map((tab) => tab.pageId)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    expect(context.pages.at(-1)?.closed).toBe(true)
  })

  it('keeps a dialog until it is answered, and gives a page under it no input', async () => {
    const { session, page, events, log } = await opened()
    const dialog = {
      type: () => 'confirm',
      message: () => 'Удалить запись?\nЭто навсегда.',
      defaultValue: () => '',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    }
    page.emit('dialog', dialog)
    expect(events.at(-1)).toEqual({
      kind: 'dialog',
      dialog: { id: 'd1', kind: 'confirm', message: 'Удалить запись? Это навсегда.' },
    })
    log.length = 0
    await session.input({ kind: 'mouse', type: 'move', x: 1, y: 1, button: 'none', clickCount: 0 })
    expect(log).toEqual([])
    expect(await session.observe({})).toMatchObject({ tree: '' })
    await expect(session.act({ tool: 'web_type', text: 'x' })).rejects.toSatisfy(
      (error) => codeOf(error) === 'BROWSER_ACTION_FAILED',
    )
    expect(dialog.accept).not.toHaveBeenCalled()
    expect(dialog.dismiss).not.toHaveBeenCalled()
    await session.resolveDialog('d1', false)
    expect(dialog.dismiss).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual({ kind: 'dialog', dialog: null })
    await expect(session.resolveDialog('d1', true)).rejects.toSatisfy(
      (error) => codeOf(error) === 'BROWSER_ACTION_FAILED',
    )
  })

  it('casts the shown page only while someone takes frames, and the consumer paces Chromium', async () => {
    const { session, page, context, log } = await opened()
    expect(page.cast).toBeNull()
    let release = () => {}
    const frames: CloudBrowserFrame[] = []
    const stop = await session.startFrames(
      (frame) => {
        frames.push(frame)
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
      { size: { width: 1280, height: 800 }, quality: 70 },
    )
    expect(page.cast).toMatchObject({ size: { width: 1280, height: 800 }, quality: 70 })
    const first = page.cast?.onFrame({ data: jpeg(1280, 800), timestamp: 1_700_000_000_000 })
    let acknowledged = false
    void first?.then(() => {
      acknowledged = true
    })
    await Promise.resolve()
    expect(frames).toEqual([
      {
        pageId: 1,
        jpeg: expect.any(Uint8Array),
        timestamp: 1_700_000_000_000,
        width: 1280,
        height: 800,
      },
    ])
    // Chromium's acknowledgement waits for the consumer.
    expect(acknowledged).toBe(false)
    release()
    await first
    // Another tab shown: the screencast moves, frames of the old one are dropped.
    const old = page.cast?.onFrame
    const popup = context.open()
    await session.selectTab(2)
    expect(page.cast).toBeNull()
    expect(popup.cast).not.toBeNull()
    await old?.({ data: jpeg(1280, 800), timestamp: 1 })
    expect(frames).toHaveLength(1)
    // Not a JPEG: no frame.
    await popup.cast?.onFrame({ data: Buffer.from('nope'), timestamp: 2 })
    expect(frames).toHaveLength(1)
    // A new size restarts it.
    log.length = 0
    await session.setViewport({ width: 390, height: 844 })
    expect(log).toEqual([
      'p1 viewport 390x844',
      'p2 viewport 390x844',
      'p2 cast stop',
      'p2 cast start',
    ])
    await expect(session.setViewport({ width: 1000, height: 700 })).rejects.toThrow()
    await stop()
    expect(popup.cast).toBeNull()
  })

  it('reads the site through the context’s request API, no redirect followed by it', async () => {
    const { session, context } = await opened()
    context.request.get.mockResolvedValue({
      status: () => 200,
      headers: () => ({ 'content-length': '7' }),
      body: async () => Buffer.from('nonce-1'),
      dispose: async () => undefined,
    })
    const reading = await session.verify({
      steps: [{ id: 'nonce', method: 'GET', path: '/nonce', readAs: 'text' }],
      read: ([reply]) =>
        reply?.body === 'nonce-1' ? { state: 'missing' } : { state: 'unreadable' },
    })
    expect(reading).toEqual({ state: 'missing' })
    expect(context.request.get).toHaveBeenCalledWith(`${ORIGIN}/nonce`, {
      headers: {},
      timeout: 10_000,
      maxRedirects: 0,
      failOnStatusCode: false,
    })
  })

  it('reports the browser gone once, and nothing after it closed it itself', async () => {
    const lost = await opened()
    lost.browser.emit('disconnected')
    lost.context.emit('close')
    expect(lost.events.filter((event) => event.kind === 'closed')).toHaveLength(1)
    const closed = await opened()
    await closed.session.close()
    closed.browser.emit('disconnected')
    expect(closed.events.filter((event) => event.kind === 'closed')).toHaveLength(0)
    expect(closed.session.isConnected()).toBe(false)
    expect(closed.log).toContain('context close')
  })
})
