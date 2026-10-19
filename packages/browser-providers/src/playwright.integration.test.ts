import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promisify } from 'node:util'

import { isPageBrowserError, type PageBrowser, type PageBrowserConnection } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPlaywrightBrowserFactory } from './playwright.ts'

// The adapter against the real browser of a preview: the container of
// `raditi-preview-browser:local` (infra/preview/Dockerfile, target `browser`) runs Chromium behind
// `launchServer` with its secret path, its proxy is a tiny server of this test standing in for
// the gateway of the `preview` role (Р19, Р21): it serves the preview's host in absolute form,
// trades the one-time ticket for a session cookie and refuses every other host. Docker Desktop
// or a Linux daemon; RADITI_PREVIEW_DOCKER_TESTS=1.

const run = promisify(execFile)
const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const IMAGE = 'raditi-preview-browser:local'
const HOST = 'site-0a1b2c3d-chat-0a1b2c.localhost'
const ORIGIN = `http://${HOST}:8090`
const TICKET = 'T'.repeat(43)
const docker = async (...args: string[]) => (await run('docker', args)).stdout.trim()

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/** The gateway as the browser's proxy sees it: absolute-form requests for the preview's host. */
function gateway(requests: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const target = URL.parse(req.url ?? '')
    requests.push(`${req.method} ${req.url}`)
    if (!target || target.origin !== ORIGIN) {
      res.writeHead(403).end()
      return
    }
    const send = (status: number, html: string) =>
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html)
    if (target.pathname === '/__raditi/enter') {
      if (target.searchParams.get('t') !== TICKET) return send(403, page('Нет', 'Билет не тот'))
      res
        .writeHead(303, {
          location: target.searchParams.get('to') ?? '/',
          'set-cookie': '__Host-raditi-preview=session; Path=/; HttpOnly; Secure; SameSite=Lax',
        })
        .end()
      return
    }
    if (!(req.headers.cookie ?? '').includes('__Host-raditi-preview=session'))
      return send(403, page('Нет', 'Нет сессии'))
    if (target.pathname === '/')
      return send(
        200,
        page(
          'Главная',
          `<h1>Добро пожаловать</h1>
           <a href="/about/">О нас</a> <a href="https://elsewhere.example/">Чужой</a>
           <a href="/wp-admin/users.php">Пользователи</a>
           <form><input id="name" aria-label="Имя"><button type="button" id="go">Отправить</button></form>
           <p id="out"></p><img src="/missing.png" alt="">
           <script>
             console.log('страница готова')
             console.error('ошибка на странице')
             fetch('https://elsewhere.example/beacon').catch(() => {})
             document.getElementById('go').addEventListener('click', () => {
               document.getElementById('out').textContent = 'Привет, ' + document.getElementById('name').value
             })
           </script>`,
        ),
      )
    if (target.pathname === '/about/') return send(200, page('О нас', '<h1>О компании</h1>'))
    if (target.pathname === '/away/') {
      res.writeHead(302, { location: 'https://elsewhere.example/' }).end()
      return
    }
    // An allowed path of the same origin that sends the page where the policy denies.
    if (target.pathname === '/go-admin/') {
      res.writeHead(302, { location: '/wp-admin/users.php' }).end()
      return
    }
    if (target.pathname === '/wp-admin/users.php')
      return send(200, page('Пользователи', '<h1>Список пользователей сайта</h1>'))
    send(404, page('Нет страницы', 'Нет такой страницы'))
  }
}

describe.skipIf(!enabled)('Playwright page browser on a real preview browser', () => {
  const requests: string[] = []
  let server: Server
  let container = ''
  let connection: PageBrowserConnection
  let browser: PageBrowser | undefined

  beforeAll(async () => {
    // Where the container reaches this machine: the address of `host-gateway` on its daemon.
    const resolved = await docker(
      'run',
      '--rm',
      '--add-host=raditi-host:host-gateway',
      '--entrypoint',
      'getent',
      IMAGE,
      'ahostsv4',
      'raditi-host',
    )
    const hostAddress = resolved.split(/\s+/)[0] ?? ''
    expect(hostAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    // On Linux that is the bridge of this host (docker0), where the server must listen; Docker
    // Desktop's is another machine, which passes the connection on to this one's loopback.
    server = createServer(gateway(requests))
    const listen = (host: string) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
    await listen(hostAddress).catch(() => listen('127.0.0.1'))
    const port = (server.address() as { port: number }).port
    const wsPath = `/${randomBytes(32).toString('base64url')}`
    container = await docker(
      'run',
      '-d',
      '--rm',
      '--name',
      `raditi-r7-browser-${randomBytes(4).toString('hex')}`,
      '--user',
      '10001:10001',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/run/raditi/browser:uid=10001,gid=10001,mode=0700',
      '-p',
      '127.0.0.1::3000',
      IMAGE,
      '/usr/bin/node',
      '/usr/local/lib/raditi/browser/server.mjs',
      '--host=0.0.0.0',
      '--port=3000',
      `--proxy=http://${hostAddress}:${port}`,
    )
    // The runtime writes the secret path after start; the server waits for it.
    await docker(
      'exec',
      '-e',
      `RADITI_WS_PATH=${wsPath}`,
      container,
      'sh',
      '-c',
      'umask 077 && printf %s "$RADITI_WS_PATH" > /run/raditi/browser/ws-path',
    )
    for (let attempt = 0; ; attempt++) {
      const ready = await run('docker', [
        'exec',
        container,
        'test',
        '-f',
        '/run/raditi/browser/ready',
      ]).then(
        () => true,
        () => false,
      )
      if (ready) break
      if (attempt > 120) throw new Error('The preview browser did not start')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const published = (await docker('port', container, '3000/tcp')).split('\n')[0] ?? ''
    connection = {
      endpoint: { wsEndpoint: `ws://${published}${wsPath}` },
      origin: ORIGIN,
      enterUrl: `${ORIGIN}/__raditi/enter?t=${TICKET}&to=%2F`,
      denyRequest: (request) => request.path.startsWith('/wp-admin/'),
    }
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (container) await run('docker', ['rm', '-f', container]).catch(() => undefined)
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  it('enters through the ticket, then acts on the preview only', async () => {
    const factory = createPlaywrightBrowserFactory()
    browser = await factory.connect(connection)
    expect(browser.isConnected()).toBe(true)
    expect(requests).toContain(`GET ${ORIGIN}/__raditi/enter?t=${TICKET}&to=%2F`)

    const home = await browser.navigate({ path: '/' })
    expect(home).toEqual({ path: '/', title: 'Главная', status: 200 })
    const snapshot = await browser.snapshot({})
    expect(snapshot.text).toContain('Добро пожаловать')
    // Links of the preview by path; another origin is not named.
    expect(snapshot.links).toEqual([
      { text: 'О нас', path: '/about/' },
      { text: 'Пользователи', path: '/wp-admin/users.php' },
    ])

    await browser.fill({ selector: '#name', value: 'Анна' })
    const clicked = await browser.click({ role: 'button', name: 'Отправить' })
    expect(clicked.status).toBeNull()
    expect(await browser.expect({ selector: '#out', text: 'Привет, Анна' })).toEqual({
      passed: true,
    })
    expect(await browser.expect({ selector: '#out', text: 'Не будет', timeoutMs: 500 })).toEqual({
      passed: false,
    })

    const messages = await browser.console()
    expect(messages).toEqual(
      expect.arrayContaining([
        { level: 'log', text: 'страница готова' },
        { level: 'error', text: 'ошибка на странице' },
      ]),
    )
    const network = await browser.network()
    expect(network).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/missing.png', status: 404, resourceType: 'image' },
        { method: 'GET', path: null, status: null, resourceType: 'fetch' },
      ]),
    )
    // The page's request to another host never reached the gateway.
    expect(requests.some((line) => line.includes('elsewhere.example'))).toBe(false)

    const shot = await browser.screenshot()
    expect(Buffer.from(shot.bytes.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
    expect(shot).toMatchObject({ contentType: 'image/png', width: 1280, height: 800 })

    const about = await browser.click({ selector: 'text=О нас' })
    expect(about).toEqual({ path: '/about/', title: 'О нас', status: 200 })
  }, 120_000)

  it('refuses what the policy denies and a way out of the preview', async () => {
    const opened = browser ?? (await createPlaywrightBrowserFactory().connect(connection))
    browser = opened
    const denied = await opened.navigate({ path: '/wp-admin/users.php' }).catch((error) => error)
    expect(isPageBrowserError(denied) && denied.reason).toBe('denied')
    const away = await opened.navigate({ path: '/away/' }).catch((error) => error)
    expect(isPageBrowserError(away) && away.reason).toBe('denied')
    expect(requests.some((line) => line.includes('/wp-admin/'))).toBe(false)
    // The browser stays usable after a refusal.
    expect(await opened.navigate({ path: '/about/' })).toMatchObject({ status: 200 })
    const missing = await opened.navigate({ path: '/nowhere/' })
    expect(missing).toMatchObject({ path: '/nowhere/', status: 404 })
  }, 60_000)

  it('refuses a redirect to what the policy denies and drops the page it loaded', async () => {
    const opened = browser ?? (await createPlaywrightBrowserFactory().connect(connection))
    browser = opened
    const redirected = await opened.navigate({ path: '/go-admin/' }).catch((error) => error)
    expect(isPageBrowserError(redirected) && redirected.reason).toBe('denied')
    // The redirect was sent before it was seen — routing never sees one — but nothing of the
    // page it loaded is read: the next look at the page finds it empty.
    expect(requests).toContain(`GET ${ORIGIN}/wp-admin/users.php`)
    const after = await opened.snapshot({})
    expect(after.text).not.toContain('Список пользователей')
    expect(after.title).not.toBe('Пользователи')
    expect(await opened.expect({ selector: 'h1', timeoutMs: 500 })).toEqual({ passed: false })
    expect(await opened.navigate({ path: '/about/' })).toMatchObject({ status: 200 })
  }, 60_000)

  it('takes no entry with a ticket the gateway refuses', async () => {
    const error = await createPlaywrightBrowserFactory()
      .connect({ ...connection, enterUrl: `${ORIGIN}/__raditi/enter?t=${'W'.repeat(43)}&to=%2F` })
      .catch((caught: unknown) => caught)
    expect(isPageBrowserError(error) && error.reason).toBe('denied')
  }, 60_000)

  it('closes its own context only: the browser server takes the next connection', async () => {
    await browser?.close()
    expect(browser?.isConnected()).toBe(false)
    browser = undefined
    // A ticket is one-time in the real gateway; this one takes it again.
    const again = await createPlaywrightBrowserFactory().connect(connection)
    browser = again
    expect((await again.navigate({ path: '/' })).title).toBe('Главная')
  }, 60_000)

  it('refuses an endpoint that is not on loopback and an entry of another origin', async () => {
    const factory = createPlaywrightBrowserFactory()
    await expect(
      factory.connect({ ...connection, endpoint: { wsEndpoint: 'ws://10.0.0.1:3000/x' } }),
    ).rejects.toThrow('Invalid page browser connection')
    await expect(
      factory.connect({
        ...connection,
        enterUrl: `http://elsewhere.example/__raditi/enter?t=${TICKET}&to=%2F`,
      }),
    ).rejects.toThrow('Invalid page browser connection')
  })
})
