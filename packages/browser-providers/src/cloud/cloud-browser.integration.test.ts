import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  isDomainError,
  isPageBrowserError,
  type BrowserTaskPolicy,
  type BrowserVerificationPlan,
  type CloudBrowserEvent,
  type CloudBrowserFrame,
  type CloudBrowserSession,
} from '@repo/domain'
import { chromium, type BrowserServer } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createPlaywrightCloudBrowser } from './cloud-browser.ts'

// The cloud browser against a real Chromium of this machine: `launchServer` behind a secret path
// on loopback, as the session's container serves it, and a tiny site of this test on 127.0.0.1 —
// a local site of the session (`BROWSER_LOCAL_SITES`). A sign-in form, an editable block inside a
// frame, file inputs, a confirm(), a link to a new tab, a page the policy closes. Needs the
// Chromium of playwright-core 1.63 (`pnpm --filter e2e exec playwright install chromium`);
// RADITI_BROWSER_LOCAL_TESTS=1.

const enabled = process.env.RADITI_BROWSER_LOCAL_TESTS === '1'
const installed = existsSync(chromium.executablePath())
if (enabled && !installed)
  console.warn(
    'RADITI_BROWSER_LOCAL_TESTS=1, but no Chromium of playwright-core is installed: skipped.',
  )

const html = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

const PAGES: Record<string, string> = {
  '/login': html(
    'Вход',
    `<form>
       <label>Имя пользователя <input name="log"></label>
       <label>Пароль <input type="password" name="pwd"></label>
       <input type="password" aria-label="Поле 2" autocomplete="current-password">
       <input aria-label="Число" autocomplete="one-time-code">
       <button type="button">Войти</button>
     </form>`,
  ),
  '/editor': html(
    'Редактор',
    `<h1>Новая запись</h1>
     <iframe src="/canvas" title="Холст" style="width:800px;height:200px"></iframe>`,
  ),
  '/canvas': html(
    'Холст',
    '<div contenteditable="true" role="textbox" aria-label="Текст записи" style="min-height:60px"></div>',
  ),
  '/upload': html(
    'Файлы',
    `<label>Файл <input type="file" id="direct"></label>
     <input type="file" id="hidden" style="display:none" multiple>
     <button type="button" id="pick">Загрузить</button>
     <p id="out">ничего</p>
     <script>
       for (const id of ['direct', 'hidden'])
         document.getElementById(id).addEventListener('change', (event) => {
           document.getElementById('out').textContent =
             'файлы ' + [...event.target.files].map((file) => file.name + ' ' + file.size).join(', ')
         })
       document.getElementById('pick').addEventListener('click', () =>
         document.getElementById('hidden').click())
     </script>`,
  ),
  '/confirm': html(
    'Удаление',
    `<button type="button" id="del">Удалить</button><p id="out">ждём</p>
     <script>
       document.getElementById('del').addEventListener('click', () => {
         document.getElementById('out').textContent = confirm('Удалить запись?') ? 'ответ да' : 'ответ нет'
       })
     </script>`,
  ),
  '/unsaved': html(
    'Черновик',
    `<button type="button" id="edit">Изменить</button>
     <script>
       document.getElementById('edit').addEventListener('click', () =>
         addEventListener('beforeunload', (event) => event.preventDefault()))
     </script>`,
  ),
  '/long': html(
    'Длинная',
    `<p id="where">наверху</p><div style="height:5000px"></div>
     <script>
       addEventListener('scroll', () => {
         document.getElementById('where').textContent = scrollY > 0 ? 'прокручено' : 'наверху'
       })
     </script>`,
  ),
  '/tabs': html('Вкладки', '<a href="/popup" target="_blank">Предпросмотр</a>'),
  '/popup': html('Предпросмотр', '<h1>Так увидят посетители</h1>'),
  '/denied/users': html('Пользователи', '<h1>Список пользователей</h1>'),
  '/send': html(
    'Отправка',
    `<button type="button" id="go">Отправить</button><p id="out">ждём</p>
     <script>
       document.getElementById('go').addEventListener('click', () =>
         fetch('/api/delete', { method: 'POST', body: 'id=1' }).then(
           () => { document.getElementById('out').textContent = 'дошло' },
           () => { document.getElementById('out').textContent = 'отказано' }))
     </script>`,
  ),
  '/input': html(
    'Ввод',
    `<button type="button" style="width:300px;height:100px">Кнопка</button><p id="log">журнал:</p>
     <script>
       for (const type of ['mousedown', 'mouseup', 'keydown', 'keyup'])
         addEventListener(type, (event) => {
           document.getElementById('log').textContent +=
             ' ' + type + '=' + (event.key ?? event.button) + (event.ctrlKey ? '+ctrl' : '')
         })
     </script>`,
  ),
  '/publish': html(
    'Запись',
    `<label>Заголовок <input name="title"></label>
     <button type="button">Опубликовать</button>
     <iframe src="/canvas" title="Холст" style="width:800px;height:200px"></iframe>`,
  ),
}

/** The saved sign-in the site of this test takes (Б36). */
const SAVED = { login: 'admin-test', password: 'Пароль-верный-1' }

/** A form like WordPress's own: the same ids, the address to go back to in a hidden field. */
const signInPage = (redirectTo: string, login = '', error = '', submit = true) =>
  html(
    'Вход',
    `${error ? `<div id="login_error">${error}</div>` : ''}
     <form id="loginform" method="post" action="/wp-login.php">
       <label>Имя пользователя <input id="user_login" name="log" value="${login}"></label>
       <label>Пароль <input type="password" id="user_pass" name="pwd"></label>
       <input type="hidden" name="redirect_to" value="${redirectTo}">
       ${submit ? '<input type="submit" id="wp-submit" value="Войти">' : ''}
     </form>`,
  )

/** The sign-in of the saved form: a cookie and the address asked for, or the form again. */
function signInAnswer(req: IncomingMessage, res: ServerResponse) {
  let body = ''
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
  req.on('end', () => {
    const form = new URLSearchParams(body)
    const login = form.get('log') ?? ''
    if (login === SAVED.login && form.get('pwd') === SAVED.password)
      // No address asked for: the dashboard, which the policy closes, as WordPress does.
      return res
        .writeHead(302, {
          location: form.get('redirect_to') || '/denied/dashboard',
          'set-cookie': 'raditi_wp=1; Path=/; HttpOnly',
        })
        .end()
    const page = signInPage(form.get('redirect_to') ?? '', login, 'Неверный пароль')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
  })
}

/** The site: pages, a redirect to a closed page, a session cookie and a REST read behind a nonce. */
function site(hits: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push(`${req.method} ${url.pathname}`)
    const signedIn = (req.headers.cookie ?? '').includes('raditi_test_session=1')
    if (url.pathname === '/wp-login.php') {
      if (req.method === 'POST') return signInAnswer(req, res)
      // `nosubmit`: a form whose button is not there — a step of the sign-in fails.
      const page = signInPage(
        url.searchParams.get('redirect_to') ?? '',
        '',
        '',
        url.searchParams.get('nosubmit') !== '1',
      )
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
    }
    if (url.pathname === '/admin') {
      if (!(req.headers.cookie ?? '').includes('raditi_wp=1'))
        return res.writeHead(302, { location: '/wp-login.php?redirect_to=%2Fadmin' }).end()
      return res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(html('Записи', '<h1>Записи</h1>'))
    }
    if (url.pathname === '/go-denied')
      return res.writeHead(302, { location: '/denied/users' }).end()
    // A redirect to a host nothing answers on: the navigation fails in the network, and
    // Chromium's error page commits a moment later.
    if (url.pathname === '/go-nowhere')
      return res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end()
    if (url.pathname === '/nonce')
      return signedIn ? res.writeHead(200).end(' nonce-123 \n') : res.writeHead(403).end('0')
    if (url.pathname === '/posts/12') {
      if (!signedIn || req.headers['x-wp-nonce'] !== 'nonce-123')
        return res.writeHead(401).end('{}')
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: 12, status: 'draft', title: 'Новость' }))
    }
    const body = PAGES[url.pathname]
    if (!body) return res.writeHead(404).end()
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
    // Signing in: the cookie of the session the trusted read must send along.
    if (url.pathname === '/login') headers['set-cookie'] = 'raditi_test_session=1; Path=/; HttpOnly'
    res.writeHead(200, headers).end(body)
  }
}

/** The reference of the element with this role and name (none: no name) in a tree. */
function refOf(tree: string, role: string, name: string): string {
  const key = name === '' ? `- ${role} [` : `- ${role} "${name}"`
  const line = tree.split('\n').find((entry) => entry.includes(key))
  const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(line ?? '')?.[1]
  if (!ref) throw new Error(`No ${role} "${name}" in the tree:\n${tree}`)
  return ref
}

const codeOf = (error: unknown) =>
  isPageBrowserError(error) ? error.reason : isDomainError(error) ? error.code : String(error)

async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('Waited too long')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!enabled || !installed)('the cloud browser on a local Chromium', () => {
  const hits: string[] = []
  const factory = createPlaywrightCloudBrowser()
  let server: BrowserServer
  let http: Server
  let origin = ''
  /** Another local site of the session: the saved sign-in of the first is never its. */
  const elsewhereHits: string[] = []
  let elsewhereHttp: Server
  let elsewhere = ''
  let session: CloudBrowserSession | undefined
  let events: CloudBrowserEvent[] = []

  const policy: BrowserTaskPolicy = {
    startPath: '/login',
    extraHosts: [],
    requestDenied: ({ path }) => path.startsWith('/api/delete'),
    pageDenied: (path) => path.startsWith('/denied'),
    signIn: {
      isSignInPage: (path) => path.startsWith('/wp-login.php'),
      login: '#loginform #user_login',
      password: '#loginform #user_pass',
      submit: '#loginform #wp-submit',
    },
  }

  const open = async (path: string) => {
    events = []
    session = await factory.open({
      endpoint: server.wsEndpoint(),
      allowedHosts: [],
      localSites: [origin, elsewhere],
      startUrl: `${origin}${path}`,
      viewport: { width: 1280, height: 800 },
      policy,
      onEvent: (event) => events.push(event),
    })
    return session
  }

  beforeAll(async () => {
    http = createServer(site(hits))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    elsewhereHttp = createServer(site(elsewhereHits))
    await new Promise<void>((resolve) => elsewhereHttp.listen(0, '127.0.0.1', resolve))
    elsewhere = `http://127.0.0.1:${(elsewhereHttp.address() as { port: number }).port}`
    server = await chromium.launchServer({
      host: '127.0.0.1',
      port: 0,
      wsPath: `/${randomBytes(32).toString('base64url')}`,
      headless: true,
    })
  }, 60_000)

  afterEach(async () => {
    await session?.close()
    session = undefined
  })

  afterAll(async () => {
    await server?.close()
    await new Promise<void>((resolve) => http?.close(() => resolve()))
    await new Promise<void>((resolve) => elsewhereHttp?.close(() => resolve()))
  })

  it('streams JPEG frames of the shown page, the last one to a new consumer at once', async () => {
    const browser = await open('/editor')
    const frames: CloudBrowserFrame[] = []
    const stop = await browser.startFrames(
      async (frame) => {
        frames.push(frame)
      },
      { size: { width: 1280, height: 800 }, quality: 70 },
    )
    const first = await until(() => frames[0])
    expect([...first.jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(first).toMatchObject({ pageId: browser.shown(), width: 1280, height: 800 })
    expect(first.timestamp).toBeGreaterThan(Date.now() - 60_000)
    await stop()

    const again: CloudBrowserFrame[] = []
    const stopAgain = await browser.startFrames(
      async (frame) => {
        again.push(frame)
      },
      { size: { width: 1280, height: 800 }, quality: 70 },
    )
    expect(again[0]).toBe(frames.at(-1))
    // Another window size: frames of the old one never come after the change.
    await browser.setViewport({ width: 390, height: 844 })
    const count = again.length
    const narrow = await until(() => again.slice(count).find((frame) => frame.width < frame.height))
    expect(narrow.height).toBeLessThanOrEqual(800)
    expect(again.slice(count).every((frame) => frame.width < frame.height)).toBe(true)
    await stopAgain()
  }, 30_000)

  it('takes a snapshot of the viewport for the client as a JPEG within its size', async () => {
    const browser = await open('/editor')
    const shot = await browser.screenshot({ qualities: [80, 60, 40], maxBytes: 1024 * 1024 })
    expect([...shot.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(shot).toMatchObject({ width: 1280, height: 800, page: { pageId: browser.shown() } })
    expect(shot.bytes.byteLength).toBeLessThanOrEqual(1024 * 1024)
  }, 30_000)

  it('never shows the agent what a secret field holds, typed by the agent or the client', async () => {
    const browser = await open('/login')
    let tree = (await browser.observe({})).tree
    await browser.act({
      tool: 'web_fill',
      ref: refOf(tree, 'textbox', 'Имя пользователя'),
      text: 'admin',
    })
    await browser.act({
      tool: 'web_fill',
      ref: refOf(tree, 'textbox', 'Пароль'),
      text: 's3cret-pass',
    })
    await browser.act({
      tool: 'web_fill',
      ref: refOf(tree, 'textbox', 'Поле 2'),
      text: 'Tr0ub4dor&3',
    })
    // The client types the code by hand.
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'textbox', 'Число') })
    await browser.input({ kind: 'text', text: '4711' })
    tree = (await browser.observe({})).tree
    for (const secret of ['s3cret-pass', 'Tr0ub4dor&3', '4711']) expect(tree).not.toContain(secret)
    expect(tree).toContain('[hidden]')
    expect(tree).toMatch(/textbox "Имя пользователя" \[ref=e\d+\]: admin/)
    // Its references still act on the page after the fields' own reads.
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'button', 'Войти') })
  }, 30_000)

  it('acts by references inside a frame, and writes Russian text where the focus is', async () => {
    const browser = await open('/editor')
    let tree = (await browser.observe({})).tree
    const editor = refOf(tree, 'textbox', 'Текст записи')
    expect(editor).toMatch(/^f\d+e\d+$/)
    await browser.act({ tool: 'web_fill', ref: editor, text: 'Заголовок новости' })
    await browser.act({ tool: 'web_click', ref: editor })
    await browser.act({ tool: 'web_press', key: 'End' })
    await browser.act({ tool: 'web_type', text: '. Привет, мир! Ёлка' })
    await browser.input({ kind: 'text', text: ' — и ещё' })
    tree = (await browser.observe({})).tree
    expect(tree).toContain('Заголовок новости. Привет, мир! Ёлка — и ещё')
    // A subtree of the latest tree, then a reference of it.
    const subtree = await browser.observe({ ref: refOf(tree, 'iframe', '') })
    expect(subtree.tree).toContain('Текст записи')
    expect(await browser.act({ tool: 'web_wait', ms: 2_000, text: 'Привет, мир' })).toMatchObject({
      matched: true,
    })
  }, 30_000)

  it('uploads into a file input, through a chooser it opens, and into one that waits', async () => {
    const browser = await open('/upload')
    const file = (name: string, text: string) => ({
      name,
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(text),
    })
    let tree = (await browser.observe({})).tree
    expect(
      await browser.act({
        tool: 'web_upload',
        ref: refOf(tree, 'button', 'Загрузить'),
        files: [file('фото.jpg', 'abc'), file('отчёт.pdf', 'abcdef')],
      }),
    ).toMatchObject({ uploaded: 2 })
    expect(
      await browser.act({ tool: 'web_wait', ms: 2_000, text: 'файлы фото.jpg 3, отчёт.pdf 6' }),
    ).toMatchObject({ matched: true })

    tree = (await browser.observe({})).tree
    await browser.act({
      tool: 'web_upload',
      ref: refOf(tree, 'button', 'Файл'),
      files: [file('один.txt', 'x')],
    })
    expect(
      await browser.act({ tool: 'web_wait', ms: 2_000, text: 'файлы один.txt 1' }),
    ).toMatchObject({ matched: true })

    // A click of the agent opens the chooser: it waits for the client (or the agent's upload).
    tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'button', 'Загрузить') })
    const chooser = await until(() => {
      const event = events.findLast((entry) => entry.kind === 'chooser')
      return event?.kind === 'chooser' && event.chooser ? event.chooser : undefined
    })
    expect(chooser.multiple).toBe(true)
    await browser.setChooserFiles(chooser.id, [file('вручную.txt', 'xy')])
    expect(
      await browser.act({ tool: 'web_wait', ms: 2_000, text: 'файлы вручную.txt 2' }),
    ).toMatchObject({ matched: true })
    expect(events.at(-1)).not.toMatchObject({ kind: 'chooser', chooser: chooser })
  }, 30_000)

  it('holds a dialog until it is answered, and takes no input under it', async () => {
    const browser = await open('/confirm')
    const tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'button', 'Удалить') })
    const dialog = await until(() => {
      const event = events.findLast((entry) => entry.kind === 'dialog')
      return event?.kind === 'dialog' && event.dialog ? event.dialog : undefined
    })
    expect(dialog).toMatchObject({ kind: 'confirm', message: 'Удалить запись?' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    // Still waiting: nothing answered it; the page is not read and takes no input meanwhile.
    expect(await browser.observe({})).toMatchObject({ tree: '' })
    await browser.input({
      kind: 'mouse',
      type: 'move',
      x: 10,
      y: 10,
      button: 'none',
      clickCount: 0,
    })
    await expect(browser.act({ tool: 'web_type', text: 'x' })).rejects.toSatisfy(
      (error) => codeOf(error) === 'BROWSER_ACTION_FAILED',
    )
    await browser.act({ tool: 'web_dialog', accept: true })
    expect(events.at(-1)).toEqual({ kind: 'dialog', dialog: null })
    expect((await browser.observe({})).tree).toContain('ответ да')
  }, 30_000)

  it('stops waiting for a navigation the page holds with «leave the page?», until it is answered', async () => {
    const browser = await open('/unsaved')
    const tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'button', 'Изменить') })
    const started = Date.now()
    await browser.act({ tool: 'web_open', url: `${origin}/popup` })
    expect(Date.now() - started).toBeLessThan(5_000)
    const dialog = await until(() => {
      const event = events.findLast((entry) => entry.kind === 'dialog')
      return event?.kind === 'dialog' && event.dialog ? event.dialog : undefined
    })
    expect(dialog.kind).toBe('beforeunload')
    expect(browser.tabs()[0]?.url).toBe(`${origin}/unsaved`)
    await browser.resolveDialog(dialog.id, true)
    await until(() => (browser.tabs()[0]?.url === `${origin}/popup` ? true : undefined))
  }, 30_000)

  it('scrolls the page with the wheel', async () => {
    const browser = await open('/long')
    await browser.observe({})
    await browser.act({ tool: 'web_scroll', direction: 'down' })
    expect(await browser.act({ tool: 'web_wait', ms: 2_000, text: 'прокручено' })).toMatchObject({
      matched: true,
    })
  }, 30_000)

  it('tracks a new tab without showing it, shows one on request, and goes back when it closes', async () => {
    const browser = await open('/tabs')
    const first = browser.shown()
    let tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'link', 'Предпросмотр') })
    const popup = await until(() => browser.tabs().find((tab) => tab.title === 'Предпросмотр'))
    expect(browser.shown()).toBe(first)
    expect(events).toContainEqual({ kind: 'tabs', tabs: expect.any(Array), shown: first })
    await browser.selectTab(popup.pageId)
    expect(browser.shown()).toBe(popup.pageId)
    expect((await browser.observe({})).tree).toContain('Так увидят посетители')
    // A reference of the other tab's tree is stale once another one is shown.
    await browser.selectTab(first ?? 0)
    await expect(
      browser.act({ tool: 'web_click', ref: refOf(tree, 'link', 'Предпросмотр') }),
    ).rejects.toSatisfy((error) => codeOf(error) === 'BROWSER_STALE_OBSERVATION')
    await browser.selectTab(popup.pageId)
    await browser.closeTab(popup.pageId)
    expect(browser.shown()).toBe(first)
    expect(browser.tabs()).toHaveLength(1)
    tree = (await browser.observe({})).tree
    expect(tree).toContain('Предпросмотр')
  }, 30_000)

  it('refuses what the policy closes: a page, a redirect to it, another site, a request', async () => {
    const browser = await open('/send')
    for (const address of [`${origin}/denied/users`, 'https://elsewhere.example/'])
      await expect(browser.act({ tool: 'web_open', url: address })).rejects.toSatisfy(
        (error) => codeOf(error) === 'denied',
      )
    await expect(browser.act({ tool: 'web_open', url: `${origin}/go-denied` })).rejects.toSatisfy(
      (error) => codeOf(error) === 'denied',
    )
    // What the redirect loaded was dropped before anyone read it.
    expect(browser.tabs()[0]?.url).not.toContain('/denied')
    expect((await browser.observe({})).tree).not.toContain('Список пользователей')

    await browser.act({ tool: 'web_open', url: `${origin}/send` })
    const tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'button', 'Отправить') })
    expect(await browser.act({ tool: 'web_wait', ms: 3_000, text: 'отказано' })).toMatchObject({
      matched: true,
    })
    expect(hits).not.toContain('POST /api/delete')
  }, 30_000)

  // The error page of a navigation the network refused commits after the action has ended: the
  // next navigation of the agent is neither interrupted by it nor by the navigation it
  // interrupted (preview.yml on GitHub's runners, 30.10.2026; the browser of a preview had it too).
  it('opens the next page after a navigation the network refused, every time', async () => {
    const browser = await open('/send')
    for (let round = 0; round < 10; round++) {
      await expect(
        browser.act({ tool: 'web_open', url: `${origin}/go-nowhere` }),
      ).rejects.toBeDefined()
      await browser.act({ tool: 'web_open', url: `${origin}/send` })
      expect(browser.tabs()[0]?.url).toBe(`${origin}/send`)
    }
  }, 120_000)

  it('signs in with the saved sign-in on the stack’s form and lands where the site sends it', async () => {
    const browser = await open('/admin')
    expect(browser.tabs()[0]?.url).toContain('/wp-login.php?redirect_to=')
    expect(await browser.signIn(SAVED)).toBe('signed_in')
    expect(browser.tabs()[0]?.url).toBe(`${origin}/admin`)
    expect((await browser.observe({})).tree).toContain('heading "Записи"')
    // Not on the form any more: nothing is filled or sent.
    const posts = hits.filter((hit) => hit === 'POST /wp-login.php').length
    expect(await browser.signIn(SAVED)).toBe('absent')
    expect(hits.filter((hit) => hit === 'POST /wp-login.php')).toHaveLength(posts)
  }, 30_000)

  it('goes to the start page when the site sends the signed-in browser where it may not go', async () => {
    const browser = await open('/admin')
    await browser.act({ tool: 'web_open', url: `${origin}/wp-login.php` })
    expect(await browser.signIn(SAVED)).toBe('signed_in')
    // The closed page was dropped as it committed (a redirect is not routed): the start page.
    expect(browser.tabs()[0]?.url).toBe(`${origin}/admin`)
    expect((await browser.observe({})).tree).toContain('heading "Записи"')
  }, 30_000)

  it('never fills the form of another host the session reaches', async () => {
    const browser = await open('/admin')
    await browser.act({ tool: 'web_open', url: `${elsewhere}/wp-login.php` })
    expect(await browser.signIn(SAVED)).toBe('absent')
    expect(elsewhereHits).not.toContain('POST /wp-login.php')
    expect((await browser.observe({})).tree).not.toContain(SAVED.login)
  }, 30_000)

  it('empties the form when a step of the sign-in fails: no value stays for the agent', async () => {
    const browser = await open('/wp-login.php?nosubmit=1')
    const posts = () => hits.filter((hit) => hit === 'POST /wp-login.php').length
    const before = posts()
    await expect(browser.signIn(SAVED)).rejects.toBeDefined()
    // Nothing was sent, and the login typed in is gone.
    expect(posts()).toBe(before)
    expect((await browser.observe({})).tree).not.toContain(SAVED.login)
  }, 40_000)

  it('empties a form that came back refused: no value of the sign-in stays for the agent', async () => {
    const browser = await open('/admin')
    const wrong = { login: SAVED.login, password: 'Пароль-неверный' }
    expect(await browser.signIn(wrong)).toBe('refused')
    const tree = (await browser.observe({})).tree
    expect(tree).toContain('Неверный пароль')
    expect(tree).not.toContain(SAVED.login)
    expect(tree).not.toContain(wrong.password)
  }, 30_000)

  it('refuses a reference of a tree the page has navigated away from', async () => {
    const browser = await open('/login')
    const tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_open', url: `${origin}/login` })
    await expect(
      browser.act({ tool: 'web_click', ref: refOf(tree, 'button', 'Войти') }),
    ).rejects.toSatisfy((error) => codeOf(error) === 'BROWSER_STALE_OBSERVATION')
  }, 30_000)

  it('reads the site with the session’s own sign-in, and answers only what it found', async () => {
    const browser = await open('/login')
    const plan: BrowserVerificationPlan = {
      steps: [
        { id: 'nonce', method: 'GET', path: '/nonce', readAs: 'text' },
        {
          id: 'post',
          method: 'GET',
          path: '/posts/12',
          headers: { 'X-WP-Nonce': { fromStep: 'nonce' } },
          readAs: 'json',
        },
      ],
      read: ([, post]) => {
        const body = post?.body as { id?: number; status?: string; title?: string } | null
        if (post?.status !== 200 || body?.id !== 12) return { state: 'unreadable' }
        return {
          state: 'verified',
          object: {
            kind: 'post',
            objectId: '12',
            title: body.title ?? '',
            status: body.status === 'draft' ? 'draft' : 'unknown',
            editUrl: `${origin}/wp-admin/post.php?post=12&action=edit`,
            images: 0,
            files: 0,
            featuredImage: false,
          },
        }
      },
    }
    expect(await browser.verify(plan)).toMatchObject({
      state: 'verified',
      object: { objectId: '12', title: 'Новость', status: 'draft' },
    })
  }, 30_000)

  it('finds the element the agent reached with Tab, inside a frame too, and keeps its tree', async () => {
    const browser = await open('/publish')
    const tree = (await browser.observe({})).tree
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'textbox', 'Заголовок') })
    expect(await browser.focused()).toEqual({ role: 'textbox', name: 'Заголовок' })
    await browser.act({ tool: 'web_press', key: 'Tab' })
    expect(await browser.focused()).toEqual({ role: 'button', name: 'Опубликовать' })
    // A reference of the tree read before still acts: the canvas of the editor, in its frame.
    await browser.act({ tool: 'web_click', ref: refOf(tree, 'textbox', 'Текст записи') })
    expect(await browser.focused()).toEqual({ role: 'textbox', name: 'Текст записи' })
  }, 30_000)

  it('lets go of Control with the key of a shortcut: the next click is a plain one', async () => {
    const browser = await open('/input')
    const key = (type: 'down' | 'up') =>
      browser.input({ kind: 'key', type, key: 's', code: 'KeyS', modifiers: ['Control'] })
    const mouse = (type: 'down' | 'up') =>
      browser.input({ kind: 'mouse', type, x: 100, y: 40, button: 'left', clickCount: 1 })
    await key('down')
    await key('up')
    await mouse('down')
    await mouse('up')
    const tree = (await browser.observe({})).tree
    expect(tree).toContain('keydown=s+ctrl')
    expect(tree).toContain('keyup=Control')
    expect(tree).toContain('mousedown=0')
    expect(tree).not.toContain('mousedown=0+ctrl')
  }, 30_000)

  it('lets go of every key and button the client held', async () => {
    const browser = await open('/input')
    await browser.input({
      kind: 'mouse',
      type: 'move',
      x: 100,
      y: 40,
      button: 'none',
      clickCount: 0,
    })
    await browser.input({
      kind: 'mouse',
      type: 'down',
      x: 100,
      y: 40,
      button: 'left',
      clickCount: 1,
    })
    await browser.input({
      kind: 'key',
      type: 'down',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: ['Shift'],
    })
    await browser.releaseInputs()
    const tree = (await browser.observe({})).tree
    expect(tree).toContain('mousedown=0')
    expect(tree).toContain('keydown=Shift')
    expect(tree).toContain('mouseup=0')
    expect(tree).toContain('keyup=Shift')
  }, 30_000)
})
