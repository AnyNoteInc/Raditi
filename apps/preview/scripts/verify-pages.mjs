// Published pages from the side of a viewer (docs/plan/69-pages.md, §7, slice 69.10): the real
// listener of the pages of apps/preview on a disposable PostgreSQL, pages written by the store
// functions core and the cabinet call (`reservePagePublication`, `applyPageVersion`,
// `setPagePassword`, `takeDownPage`, `restorePage`), and a real Chromium on `<slug>.pages.localhost`.
// The path of a page: its address, its headers byte for byte, a new version at the same address,
// the password, 410 and back, the operator's take-down; the protections: no cookie, no request,
// no form, no frame; the strict host. Never the repository .env, the dev infrastructure, a model
// or a key: a synthetic workspace with synthetic pages.
//
//   pnpm verify:pages [-- --no-build] [--keep]
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL, URLSearchParams } from 'node:url'
import { TextEncoder } from 'node:util'

import {
  CheckFailed,
  callerEnv,
  createRuntime,
  freeLoopbackPort,
  startProcess,
} from '../../../infra/dev/browser-task-verify/runtime.mjs'
import { POSTGRES_IMAGE, PULLED_TAGS } from '../../../infra/dev/browser-task-verify/stand.mjs'
import {
  FIRST,
  PROBE_MARK,
  SECOND,
  framingPage,
  probePage,
} from '../../../infra/dev/pages-verify/fixtures.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const root = resolve(here, '../../..')
const rt = createRuntime({ root })
const run = randomBytes(4).toString('hex')
const LABEL = `raditi.pages-verify=${run}`
const POSTGRES = `raditi-pages-verify-${run}-postgres`
const BASE = 'pages.localhost'
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

const options = {
  build: !process.argv.includes('--no-build'),
  keep: process.argv.includes('--keep'),
}

/** One request with the `Host` it names, to the listener on loopback: fetch cannot set `Host`. */
function hit(port, host, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { host, ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', fail)
    req.end(body)
  })
}

/** What another site of the stand saw: each request a page let through is counted here. */
function startTarget() {
  const hits = []
  let framing = ''
  const server = createServer((req, res) => {
    if (req.url === '/frame' || req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(
        req.url === '/frame' ? framing : '<!doctype html><p id="v">Обычная страница</p>',
      )
    }
    if (req.url === '/control') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // From the neighbouring origin, the same request the probe page makes.
      const to = `http://127.0.0.1:${req.socket.localPort}/fetch`
      return res.end(`<!doctype html><script>fetch(${JSON.stringify(to)})</script>`)
    }
    // What a browser asks of any site by itself is no request of a page.
    if (req.url !== '/favicon.ico') hits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'access-control-allow-origin': '*' })
    res.end('ok')
  })
  server.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url}`)
    socket.destroy()
  })
  return {
    hits,
    frame: (html) => {
      framing = html
    },
    async listen() {
      server.listen(0, '127.0.0.1')
      await new Promise((done) => server.once('listening', done))
      return server.address().port
    },
    close: () => new Promise((done) => server.close(done)),
  }
}

async function preflight() {
  rt.setStage('preflight')
  const image = await rt.docker(['image', 'inspect', POSTGRES_IMAGE], { allowFailure: true })
  if (image.code !== 0)
    throw new Error(
      `The pinned image ${POSTGRES_IMAGE} is missing locally; pull it first (docker pull ${PULLED_TAGS[POSTGRES_IMAGE] ?? POSTGRES_IMAGE})`,
    )
  await rt.run('pnpm', ['--version'])
}

async function startPostgres() {
  const password = rt.secret(randomBytes(24).toString('hex'))
  await rt.docker([
    ...['run', '-d', '--rm', '--name', POSTGRES, '--label', LABEL],
    ...['--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432'],
    ...['-e', 'POSTGRES_USER=raditi', '-e', 'POSTGRES_DB=raditi'],
    ...['-e', `POSTGRES_PASSWORD=${password}`],
    POSTGRES_IMAGE,
  ])
  const mapping = (await rt.docker(['port', POSTGRES, '5432/tcp'])).output.trim().split('\n')[0]
  const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1))
  const url = `postgresql://raditi:${password}@127.0.0.1:${port}/raditi`
  await rt.until(
    'PostgreSQL answers a query after its init',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            POSTGRES,
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            'raditi',
            '-d',
            'raditi',
            '-c',
            'select 1',
          ],
          { allowFailure: true },
        )
      ).code === 0,
    { timeoutMs: 60_000 },
  )
  return { url, port }
}

const load = (path) => import(pathToFileURL(join(root, path)).href)

/**
 * A synthetic workspace with one chat: what a turn of an agent would publish its pages in. It is
 * on a tariff of the stand with room for its sites (docs/plan/73-pages-sites.md, Дер36): without
 * a paid tariff a workspace has one.
 */
async function workspaceWithChat(db) {
  const workspace = await db.workspace.create({
    data: { name: 'Synthetic pages', dataClass: 'synthetic' },
  })
  const plan = await db.plan.create({
    data: {
      slug: 'stand-sites',
      name: 'Стенд',
      kind: 'quota',
      price: '0.00',
      creditsPerMonth: 1,
      pageSites: 100,
      pageCustomNames: true,
      isActive: false,
    },
  })
  const now = new Date()
  await db.subscription.create({
    data: {
      workspaceId: workspace.id,
      planId: plan.id,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      periodAnchor: now,
    },
  })
  const task = await db.task.create({
    data: {
      workspaceId: workspace.id,
      needsBrowser: false,
      title: 'Цены',
    },
  })
  return { workspaceId: workspace.id, taskId: task.id }
}

async function publish(modules, chat, title, html, turnNo, port, place) {
  const page = await modules.db.reservePagePublication(modules.prisma, {
    ...chat,
    turnNo,
    title,
    target: { fileName: 'page.html' },
    ...(place ? { place } : {}),
  })
  // As the end of its turn does: the version fulfils the turn's reservation, which closes.
  const reservation = await modules.prisma.pageReservation.findFirstOrThrow({
    where: { pageId: page.pageId, turnNo, outcome: null },
  })
  const version = await modules.db.applyPageVersion(modules.prisma, {
    pageId: page.pageId,
    bytes: new TextEncoder().encode(html),
    source: 'outbox',
    reservationId: reservation.id,
  })
  const url = modules.domain.pageAddressUrl(
    page.slug,
    { baseDomain: BASE, scheme: 'http', port },
    page.path,
  )
  return { ...page, url, version: version.version }
}

/** The headers of a page answer against the constants of the domain, byte for byte (Ст9). */
function sameHeaders(response, expected) {
  return Object.entries(expected).every(
    ([name, value]) => response.headers[name.toLowerCase()] === value,
  )
}

async function pagePath(stand) {
  const { modules, chat, port } = stand
  const { domain, prisma } = modules
  const host = (slug) => `${slug}.${BASE}:${port}`

  rt.begin('A', 'the path of a page: address, headers, versions, take-down')
  const page = await publish(modules, chat, 'Прайс', FIRST, 1, port)
  rt.check(
    page.url === `http://${page.slug}.${BASE}:${port}/`,
    'the address of the page is its own subdomain',
    page.url,
  )
  rt.check(
    /^[a-z2-7]{26}$/.test(page.slug),
    'the label of the page is 128 random bits in base32',
    page.slug,
  )
  const first = await hit(port, host(page.slug))
  rt.check(
    first.status === 200 && first.body === FIRST,
    'the page answers its first version',
    first.status,
  )
  rt.check(
    sameHeaders(first, domain.pageResponseHeaders('html')),
    'the headers of the page are the constants of the domain, byte for byte',
    first.headers,
  )
  rt.check(first.headers['set-cookie'] === undefined, 'a page without a password sets no cookie')

  const second = await publish(modules, chat, 'Прайс', SECOND, 2, port).catch(() => null)
  rt.check(
    second !== null && second.pageId !== page.pageId,
    'a publication without pageId is a new page',
  )
  const next = await modules.db.applyPageVersion(prisma, {
    pageId: page.pageId,
    bytes: new TextEncoder().encode(SECOND),
    source: 'outbox',
  })
  const updated = await hit(port, host(page.slug))
  rt.check(
    next.version === 2 && updated.body === SECOND,
    'a new version answers at the same address, its number grew',
    next,
  )
  const contents = await prisma.pageContent.count({ where: { pageId: page.pageId } })
  const versions = await prisma.pageVersion.count({ where: { pageId: page.pageId } })
  rt.check(
    contents === 1 && versions === 2,
    'only the content of the current version is kept; the former one stays a row of history',
    { contents, versions },
  )
  // A site of one page answers its home page alone: other paths are no pages (Дер15).
  for (const path of ['/v1', '/v2', '/v/abc', '/index.html', '/../', '/%2e%2e', '/a//b'])
    rt.check((await hit(port, host(page.slug), { path })).status === 404, `${path} is 404`)
  const slashed = await hit(port, host(page.slug), { path: '/v/' })
  rt.check(
    slashed.status === 308 && slashed.headers.location === '/v',
    '/v/ is sent on to its canon /v, which is no page',
  )
  const robots = await hit(port, host(page.slug), { path: '/robots.txt' })
  rt.check(robots.body === domain.PAGE_ROBOTS_TXT, 'robots.txt forbids indexing')
  rt.check(
    (await hit(port, host(page.slug), { method: 'POST' })).status === 405,
    'a page without a password takes no POST',
  )
  rt.check(
    (await hit(port, host(page.slug), { method: 'PUT' })).status === 405,
    'other methods are 405',
  )

  // The trash (docs/plan/73-pages-sites.md, Дер2): 410 at once, back with the same version.
  const actor = { type: 'system', service: 'pages-verify' }
  await modules.db.deletePage(prisma, {
    pageId: page.pageId,
    workspaceId: chat.workspaceId,
    by: 'client',
    actor,
  })
  const trashed = await hit(port, host(page.slug))
  rt.check(
    trashed.status === 410 &&
      trashed.body.includes('Страница удалена') &&
      !trashed.body.includes('вторая версия'),
    'a page in the trash answers 410 «Страница удалена», without its content',
  )
  rt.check(
    sameHeaders(trashed, domain.pageResponseHeaders('platform')),
    'the stub of a deleted page goes under the policy of the platform',
  )
  await modules.db.returnDeletedPage(prisma, {
    pageId: page.pageId,
    workspaceId: chat.workspaceId,
    actor,
  })
  rt.check(
    (await hit(port, host(page.slug))).body === SECOND,
    '«Вернуть» from the trash puts the current version back at the same address',
  )

  await modules.db.takeDownPage(prisma, {
    pageId: page.pageId,
    by: 'client',
    workspaceId: chat.workspaceId,
  })
  const gone = await hit(port, host(page.slug))
  rt.check(
    gone.status === 410 && !gone.body.includes('вторая версия'),
    'a page taken down answers 410, without its content',
  )
  rt.check(
    sameHeaders(gone, domain.pageResponseHeaders('platform')),
    'the stub of the platform goes under its own policy',
  )
  await modules.db.restorePage(prisma, { pageId: page.pageId, workspaceId: chat.workspaceId })
  rt.check(
    (await hit(port, host(page.slug))).body === SECOND,
    '«Вернуть на публикацию» puts the current version back at the same address',
  )
  await modules.db.takeDownPage(prisma, { pageId: page.pageId, by: 'operator' })
  const client = await modules.db
    .restorePage(prisma, { pageId: page.pageId, workspaceId: chat.workspaceId })
    .then(
      () => 'restored',
      () => 'refused',
    )
  rt.check(
    client === 'refused' && (await hit(port, host(page.slug))).status === 410,
    'a page the operator took down the client cannot put back',
  )

  const missing = await hit(port, host('a'.repeat(26)))
  rt.check(missing.status === 404, 'a page that never was is 404')
  rt.check(
    (await hit(port, `x.${page.slug}.${BASE}:${port}`)).status === 404,
    'a second label is 404',
  )
  for (const other of [`${BASE}:${port}`, `localhost:${port}`, `${page.slug}.example.com`])
    rt.check((await hit(port, other)).body === 'Not found', `${other} is no page host`)
  rt.note(
    'a page has no term (Ст14): only the trash has one (plan 73, Дер2), and its sweep is checked on PostgreSQL by the tRPC suite',
  )
  rt.end()
  return second
}

async function passwordPath(stand, page) {
  const { modules, chat, port } = stand
  const { db, prisma, domain } = modules
  const host = `${page.slug}.${BASE}:${port}`

  rt.begin('B', 'the password of a page')
  const passwordHash = await db.hashPagePassword(rt.secret('секрет-стенда-1'))
  await db.setPagePassword(prisma, { ...chat, pageId: page.pageId, passwordHash })
  const form = await hit(port, host)
  rt.check(
    form.status === 200 &&
      form.body.includes('type="password"') &&
      !form.body.includes('вторая версия'),
    'a page with a password answers the form, not its content',
  )
  rt.check(
    sameHeaders(form, domain.pageResponseHeaders('platform')),
    'the form goes under the policy of the platform',
  )
  const post = (password, extra = {}) =>
    hit(port, host, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
      body: new URLSearchParams({ password }).toString(),
    })
  const wrong = await post('неверный')
  rt.check(
    wrong.status === 200 &&
      wrong.headers['set-cookie'] === undefined &&
      !wrong.body.includes('вторая версия'),
    'a wrong password opens nothing and sets no cookie',
  )
  const right = await post('секрет-стенда-1')
  const cookie = right.headers['set-cookie']?.[0] ?? ''
  rt.check(
    right.status === 303 && cookie.startsWith('raditi_page='),
    'the right password sets the cookie of the page',
  )
  rt.check(
    !/domain=/i.test(cookie) && /HttpOnly/.test(cookie) && /Secure/.test(cookie),
    'the cookie is host-only, HttpOnly and Secure',
    cookie.replace(/=[^;]+/, '=…'),
  )
  const value = cookie.split(';')[0]
  rt.check(
    (await hit(port, host, { headers: { cookie: value } })).body === SECOND,
    'the cookie opens the page',
  )
  await db.applyPageVersion(prisma, {
    pageId: page.pageId,
    bytes: new TextEncoder().encode(FIRST),
    source: 'outbox',
  })
  rt.check(
    (await hit(port, host, { headers: { cookie: value } })).body === FIRST,
    'the cookie outlives a new version: the password closes the page, not a version',
  )
  const other = await publish(modules, chat, 'Другая', SECOND, 3, port)
  const otherHost = `${other.slug}.${BASE}:${port}`
  await db.setPagePassword(prisma, {
    ...chat,
    pageId: other.pageId,
    passwordHash: await db.hashPagePassword(rt.secret('секрет-другой-1')),
  })
  rt.check(
    (await hit(port, otherHost, { headers: { cookie: value } })).body.includes('type="password"'),
    'the cookie of one page does not open another',
  )
  const own = await hit(port, otherHost, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'секрет-другой-1' }).toString(),
  })
  const ownValue = (own.headers['set-cookie']?.[0] ?? '').split(';')[0]
  rt.check(
    (await hit(port, otherHost, { headers: { cookie: ownValue } })).body === SECOND,
    'control: its own cookie opens the other page',
  )
  await db.setPagePassword(prisma, {
    ...chat,
    pageId: page.pageId,
    passwordHash: await db.hashPagePassword(rt.secret('секрет-стенда-2')),
  })
  rt.check(
    (await hit(port, host, { headers: { cookie: value } })).body.includes('type="password"'),
    'a new password stops the cookies of the former one',
  )
  let limited = null
  for (let attempt = 0; attempt < 40 && limited === null; attempt += 1) {
    const answer = await post(`неверный-${attempt}`)
    if (answer.status === 429) limited = answer
  }
  rt.check(
    limited !== null && Number(limited.headers['retry-after']) > 0,
    'attempts of one address are limited, with Retry-After',
  )
  await db.setPagePassword(prisma, { ...chat, pageId: page.pageId, passwordHash: null })
  rt.end()
}

async function protections(stand, page) {
  const { modules, chat, port, target, targetPort } = stand
  rt.begin('C', 'the protections of a page in Chromium')
  const origin = `http://127.0.0.1:${targetPort}`
  // A second origin of the same server: the controls come from another site, as the page does.
  const neighbour = `http://neighbour.${BASE}:${targetPort}`
  const probe = await publish(modules, chat, 'Проба', probePage(origin), 4, port)
  const require = createRequire(join(root, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    // A cookie of the whole domain of the pages, as a cookie with Domain=raditi.ru would be
    // (Ст3): every subdomain of it is sent the cookie.
    await context.addCookies([
      {
        name: 'cabinet',
        value: 'synthetic',
        domain: `.${BASE}`,
        path: '/',
        secure: false,
        httpOnly: false,
      },
    ])
    const reader = await context.newPage()
    await reader.goto(`${neighbour}/plain`)
    rt.check(
      (await reader.evaluate('document.cookie')).includes('cabinet=synthetic'),
      'control: an ordinary page of a neighbouring subdomain reads that cookie',
    )
    await reader.close()
    const tab = await context.newPage()
    const lines = []
    tab.on('console', (message) => {
      const text = message.text()
      if (text.startsWith(PROBE_MARK)) lines.push(JSON.parse(text.slice(PROBE_MARK.length)))
    })
    await tab.goto(probe.url)
    await rt.until('the probe page says it is done', async () => lines.some((each) => each.done), {
      timeoutMs: 20_000,
    })
    const said = (key) => lines.find((each) => key in each)
    rt.check(
      said('cookie')?.cookie === null,
      'the page reads no cookie of the domain: its origin is opaque',
      said('cookie'),
    )
    rt.check(
      said('storage')?.storage === null,
      'the page has no storage of the host',
      said('storage'),
    )
    for (const key of ['fetch', 'xhr', 'ws'])
      rt.check(said(key)?.[key] === 'refused', `${key} of the page is refused`, said(key))
    const violations = new Set(lines.filter((each) => each.violation).map((each) => each.violation))
    rt.check(violations.has('connect-src'), 'the policy reports the blocked requests', [
      ...violations,
    ])
    await rt.pause(500)
    rt.check(target.hits.length === 0, 'no request of the page reached the other site', target.hits)
    // The control: the same request from a page without the policy reaches the other site.
    const control = await context.newPage()
    await control.goto(`${neighbour}/control`)
    await rt.until('the control page fetched', async () => target.hits.includes('GET /fetch'), {
      timeoutMs: 10_000,
    })
    rt.passed('control: the same request from a page of another site without the policy reaches it')
    await control.close()
    rt.check(
      (await tab.locator('#v').textContent()) === 'Проба страницы',
      'the form did not take the page away',
    )

    const framedCount = async (url) => {
      target.frame(framingPage(url))
      const framing = await context.newPage()
      await framing.goto(`${origin}/frame`)
      const frame = await rt.until(
        'the frame is there',
        async () => framing.frames().find((each) => each !== framing.mainFrame()),
        { timeoutMs: 10_000 },
      )
      // Wait for the frame to finish, loaded or refused, before counting.
      await frame.waitForLoadState('load', { timeout: 10_000 }).catch(() => {})
      const count = await frame
        .locator('#v')
        .count()
        .catch(() => 0)
      await framing.close()
      return count
    }
    rt.check(
      (await framedCount(`${neighbour}/plain`)) === 1,
      'control: the frame opens an ordinary page of another site',
    )
    rt.check(
      (await framedCount(page.url)) === 0,
      'the page does not open in a frame of another site',
    )
  } finally {
    await browser.close()
  }
  rt.note(
    'not in this stand yet: the agent path on OpenCode and the synthetic Z.ai (page_publish, the doc_* tools, the refusals of a publication — a turn key, a client value, a password form posting out, a JWT, the size), «Скачать .md» end to end, the reading page of a document and «Опубликовать по ссылке» (69.5), the host of the cabinet (no page there, no cabinet and /v/ on a page host), the cabinet setting no cookie with Domain=raditi.ru, the Origin check of a mutating cabinet route reached from a page, the browser of a task opening a page and not the root, both scenarios of the brief in dev',
  )
  rt.end()
}

/**
 * A site of pages in Chromium (docs/plan/73-pages-sites.md, Дер20, 73.7): a home page and two pages
 * below it, linked from the root. A link to its own host is a navigation of the window, which the
 * sandbox lets through; a link out opens a new tab; a link to another site of pages opens that
 * site, its password form first; a request of a page to its own host stays closed (connect-src).
 */
async function siteOfPages(stand) {
  const { modules, chat, port, targetPort } = stand
  rt.begin('D', 'a site of pages in Chromium: links between its pages and out')
  const origin = `http://127.0.0.1:${targetPort}`
  const other = await publish(modules, chat, 'Другой сайт', '<p id="v">Другой сайт</p>', 20, port)
  await modules.db.setPagePassword(modules.prisma, {
    ...chat,
    pageId: other.pageId,
    passwordHash: await modules.db.hashPagePassword('секрет-д'),
  })
  const home = await publish(
    modules,
    chat,
    'Главная',
    `<!doctype html><title>Главная</title><p id="v">Главная</p>
<a id="to-uslugi" href="/uslugi">Услуги</a>
<a id="out" href="${origin}/plain" target="_blank" rel="noopener">Наружу</a>
<a id="other" href="${other.url}">Другой сайт</a>
<script>fetch('/uslugi').then(() => console.log('${PROBE_MARK}' + JSON.stringify({ fetch: 'reached' })), () => console.log('${PROBE_MARK}' + JSON.stringify({ fetch: 'refused' })))</script>`,
    21,
    port,
  )
  const place = (path) => ({ treeId: home.treeId, path })
  const uslugi = await publish(
    modules,
    chat,
    'Услуги',
    '<!doctype html><p id="v">Услуги</p><a id="home" href="/">На главную</a><a id="remont" href="/uslugi/remont">Ремонт</a>',
    22,
    port,
    place('/uslugi'),
  )
  await publish(
    modules,
    chat,
    'Ремонт',
    '<!doctype html><p id="v">Ремонт</p><a id="up" href="/uslugi">Услуги</a>',
    23,
    port,
    place('/uslugi/remont'),
  )
  rt.check(
    uslugi.url === `http://${home.slug}.${BASE}:${port}/uslugi`,
    'a page below the home page has the host of its site and its path',
    uslugi.url,
  )
  const require = createRequire(join(root, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const tab = await context.newPage()
    const lines = []
    tab.on('console', (message) => {
      const text = message.text()
      if (text.startsWith(PROBE_MARK)) lines.push(JSON.parse(text.slice(PROBE_MARK.length)))
    })
    await tab.goto(home.url)
    const said = () => tab.locator('#v').textContent()
    rt.check((await said()) === 'Главная', 'the home page opens at the root of its host')
    await Promise.all([tab.waitForURL(`**/uslugi`), tab.click('#to-uslugi')])
    rt.check(
      (await said()) === 'Услуги' && new URL(tab.url()).pathname === '/uslugi',
      'a link from the root opens the page of the site in the same window',
    )
    await Promise.all([tab.waitForURL(`**/uslugi/remont`), tab.click('#remont')])
    rt.check((await said()) === 'Ремонт', 'a page two levels down opens by its link')
    await Promise.all([tab.waitForURL(`**/uslugi`), tab.click('#up')])
    await Promise.all([tab.waitForURL(home.url), tab.click('#home')])
    rt.check((await said()) === 'Главная', 'and back to the home page by a link to /')
    await tab.goBack()
    rt.check((await said()) === 'Услуги', 'the history of the window goes back through the site')
    await tab.goto(home.url)
    await rt.until(
      'the home page tried its request',
      async () => lines.some((each) => 'fetch' in each),
      {
        timeoutMs: 10_000,
      },
    )
    rt.check(
      lines.find((each) => 'fetch' in each)?.fetch === 'refused',
      'a request of a page to its own host is refused: navigation, not fetch',
    )
    const [outside] = await Promise.all([context.waitForEvent('page'), tab.click('#out')])
    await outside.waitForLoadState('load')
    rt.check(
      (await outside.locator('#v').textContent()) !== null && outside.url() === `${origin}/plain`,
      'control: a link out opens the other site in a new tab',
    )
    await outside.close()
    await Promise.all([tab.waitForURL(other.url), tab.click('#other')])
    rt.check(
      (await tab.content()).includes('Страница закрыта паролем'),
      'a link to another site of pages opens that site, its password first',
    )
  } finally {
    await browser.close()
  }
  rt.end()
}

/**
 * The shared files and the own name of a site (docs/plan/73-pages-sites.md, Дер32–Дер35): a page
 * loads the CSS and a picture of its site from its own host in Chromium — `'self'` of its policy —,
 * a request of it to the same file stays closed; a site with a password gives its files only with
 * its cookie, which goes with the requests of a sandboxed page (SameSite=None); a site asked by its
 * slug sends the viewer on to its own name.
 */
async function sharedFiles(stand) {
  const { modules, chat, port } = stand
  const { db, prisma } = modules
  rt.begin('E', 'shared files and the own name of a site')
  const html = (text) => new TextEncoder().encode(text)
  const page = await publish(
    modules,
    chat,
    'Файлы',
    `<!doctype html><link rel="stylesheet" href="/_files/style.css">
<style>@font-face{font-family:'StandFont';src:url(/_files/golos.woff2) format('woff2')}</style>
<p id="v">Файлы</p><img id="logo" src="/_files/logo.png" alt=""><span id="f" style="font-family:StandFont,monospace">Привет</span>
<script>fetch('/_files/style.css').then(() => console.log('${PROBE_MARK}' + JSON.stringify({ fetch: 'reached' })), () => console.log('${PROBE_MARK}' + JSON.stringify({ fetch: 'refused' })))</script>`,
    30,
    port,
  )
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const put = async (fileName, path, bytes, turnNo) => {
    const reserved = await db.reservePageFile(prisma, {
      ...chat,
      turnNo,
      treeId: page.treeId,
      fileName,
      path,
    })
    await db.applyPageFile(prisma, { reservationId: reserved.reservationId, bytes })
  }
  await put('style.css', '/_files/style.css', html('#v{color:rgb(1, 2, 3)}'), 31)
  await put('logo.png', '/_files/logo.png', new Uint8Array(png), 32)
  // A font of the site (docs/plan/88-artifacts.md, spike 2, question 25): a sandboxed page asks it
  // by CORS from an opaque origin, so it loads only with `Access-Control-Allow-Origin: *`.
  const { artifactFontSources } = await import(
    join(root, 'apps/web/src/server/artifact-fonts.generated.ts')
  )
  await put(
    'golos.woff2',
    '/_files/golos.woff2',
    new Uint8Array(Buffer.from(artifactFontSources['lib-golos-cyr'].base64, 'base64')),
    33,
  )
  const host = (label) => `${label}.${BASE}:${port}`
  const file = await hit(port, host(page.slug), { path: '/_files/style.css' })
  rt.check(
    file.status === 200 &&
      file.headers['content-type'] === 'text/css; charset=utf-8' &&
      file.headers['cross-origin-resource-policy'] === 'cross-origin' &&
      file.headers['x-content-type-options'] === 'nosniff',
    'a shared file goes with its own type, loadable by a page, read as nothing else',
  )
  rt.check(
    (await hit(port, host(page.slug), { path: '/_files/index.html' })).status === 404,
    'no HTML is a shared file',
  )
  const font = await hit(port, host(page.slug), { path: '/_files/golos.woff2' })
  rt.check(
    font.status === 200 &&
      font.headers['content-type'] === 'font/woff2' &&
      font.headers['access-control-allow-origin'] === '*',
    'a font of the site goes with Access-Control-Allow-Origin: * (question 25)',
  )
  const require = createRequire(join(root, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const tab = await context.newPage()
    const lines = []
    tab.on('console', (message) => {
      const text = message.text()
      if (text.startsWith(PROBE_MARK)) lines.push(JSON.parse(text.slice(PROBE_MARK.length)))
    })
    await tab.goto(page.url)
    await rt.until('the page tried its request', async () => lines.length > 0, {
      timeoutMs: 10_000,
    })
    rt.check(
      (await tab.evaluate("getComputedStyle(document.getElementById('v')).color")) ===
        'rgb(1, 2, 3)',
      "the CSS of the site loads from its own host ('self')",
    )
    rt.check(
      (await tab.evaluate("document.getElementById('logo').naturalWidth")) === 1,
      'a picture of the site loads from its own host',
    )
    rt.check(lines[0]?.fetch === 'refused', 'a request of the page to that file is refused')
    const fontStatus = await tab.evaluate(async () => {
      await document.fonts.load('16px StandFont', 'Привет')
      return [...document.fonts].find((face) => face.family.replace(/["']/g, '') === 'StandFont')
        ?.status
    })
    rt.check(
      fontStatus === 'loaded',
      'the sandboxed page loads the font of its site (FontFace.status)',
      String(fontStatus),
    )

    // A site with a password: its files only with its cookie, sent by the sandboxed page too.
    await db.setPagePassword(prisma, {
      ...chat,
      pageId: page.pageId,
      passwordHash: await db.hashPagePassword('секрет-е'),
    })
    rt.check(
      (await hit(port, host(page.slug), { path: '/_files/style.css' })).status === 404,
      'a file of a site with a password is no file without its cookie',
    )
    const locked = await context.newPage()
    await locked.goto(page.url)
    await locked.fill('#password', 'секрет-е')
    await Promise.all([locked.waitForURL(page.url), locked.click('button[type=submit]')])
    await rt.until(
      'the page of the site with a password shows',
      async () => (await locked.locator('#v').count()) === 1,
      { timeoutMs: 10_000 },
    )
    rt.check(
      (await locked.evaluate("getComputedStyle(document.getElementById('v')).color")) ===
        'rgb(1, 2, 3)',
      'with the cookie the sandboxed page loads the files of its site (SameSite=None)',
    )
  } finally {
    await browser.close()
  }

  // The own name of the site (Дер32, Дер33).
  const name = 'stand-firma'
  await db.setTreeName(prisma, { pageId: page.pageId, workspaceId: chat.workspaceId, name })
  await db.setPagePassword(prisma, { ...chat, pageId: page.pageId, passwordHash: null })
  const named = await hit(port, host(name))
  rt.check(named.status === 200 && named.body.includes('Файлы'), 'the site answers by its own name')
  const moved = await hit(port, host(page.slug), { path: '/' })
  rt.check(
    moved.status === 308 && moved.headers.location === `//${name}.${BASE}:${port}/`,
    'its slug sends the viewer on to its name',
  )
  rt.check((await hit(port, host('www'))).status === 404, 'a reserved word is no name of a site')
  rt.end()
}

async function main(owned) {
  await preflight()
  if (options.build) {
    rt.setStage('build preview')
    await rt.run('pnpm', ['turbo', 'run', 'build', '--filter', 'preview'], { timeoutMs: 600_000 })
  }
  const directory = await mkdtemp(join(tmpdir(), 'raditi-pages-verify-'))
  owned.directory = directory
  rt.setStage('PostgreSQL and migrations')
  owned.postgres = true
  const postgres = await startPostgres()
  rt.secret(postgres.url)
  // The migration files go to psql in the container, in their order: Prisma's config would read
  // the repository .env (packages/db/prisma.config.ts), and this stand reads none.
  const migrations = join(root, 'packages/db/prisma/migrations')
  for (const name of (await readdir(migrations)).filter((each) => /^\d{14}_/.test(each)).sort())
    await rt.docker(
      [
        'exec',
        '-i',
        POSTGRES,
        'psql',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'raditi',
        '-d',
        'raditi',
      ],
      { input: await readFile(join(migrations, name, 'migration.sql')), timeoutMs: 120_000 },
    )
  const db = await load('packages/db/src/index.ts')
  const domain = await load('packages/domain/src/index.ts')
  const prisma = db.createPrismaClient({ databaseUrl: postgres.url, log: [] })
  owned.prisma = prisma
  const modules = { db, domain, prisma }

  const target = startTarget()
  owned.target = target
  const targetPort = await target.listen()
  const port = await freeLoopbackPort()
  const stream = await freeLoopbackPort()
  rt.setStage('the preview app with its pages listener')
  const preview = startProcess(rt, 'preview', ['dist/main.js'], {
    cwd: join(root, 'apps/preview'),
    env: {
      PATH: callerEnv.PATH,
      HOME: directory,
      NODE_ENV: 'production',
      NO_COLOR: '1',
      APP_ENV: 'test',
      DATABASE_URL: postgres.url,
      APP_URL: 'http://127.0.0.1:3999',
      BROWSER_STREAM_PORT: String(stream),
      PAGES_BASE_DOMAIN: BASE,
      PAGES_PORT: String(port),
      PAGES_PUBLIC_PORT: String(port),
      PAGES_HOST: '127.0.0.1',
      PAGES_COOKIE_SECRET: rt.secret(randomBytes(32).toString('hex')),
    },
    logFile: join(directory, 'preview.log'),
  })
  owned.preview = preview
  await rt.until(
    'the pages listener answers',
    async () => (await hit(port, `${BASE}:${port}`)).status === 404,
    { timeoutMs: 60_000, service: preview },
  )
  const chat = await workspaceWithChat(prisma)
  const stand = { modules, chat, port, target, targetPort }
  const page = await pagePath(stand)
  await passwordPath(stand, page)
  await protections(stand, page)
  await siteOfPages(stand)
  await sharedFiles(stand)
  const lines = rt.rows.map(
    (row) =>
      `${row.ok ? 'OK  ' : 'FAIL'} ${row.id} ${row.title}: ${row.checks} checks, ${row.notes} notes`,
  )
  console.log(`\n${lines.join('\n')}`)
  console.log(`\nverify:pages — ${rt.rows.reduce((sum, row) => sum + row.checks, 0)} checks`)
}

async function cleanUp(owned) {
  await owned.preview?.stop()
  await owned.target?.close()
  await owned.prisma?.$disconnect().catch(() => {})
  if (options.keep) {
    console.log(`--keep: PostgreSQL ${POSTGRES} and ${owned.directory} stay`)
    return
  }
  if (owned.postgres) await rt.docker(['rm', '-f', POSTGRES], { allowFailure: true, cleanup: true })
  if (owned.directory) await rm(owned.directory, { recursive: true, force: true })
}

const owned = {}
for (const signal of SIGNALS)
  process.once(signal, () => rt.controller.abort(new Error('The stand was interrupted')))
try {
  await main(owned)
  await cleanUp(owned)
} catch (error) {
  console.error(
    `FAIL ${rt.stage}: ${rt.redact(error instanceof CheckFailed ? error.message : (error?.stack ?? String(error)))}`,
  )
  if (owned.preview && !owned.preview.running())
    console.error(rt.redact(owned.preview.log().slice(-4000)))
  await cleanUp(owned)
  process.exitCode = 1
}
