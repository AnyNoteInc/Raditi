// The cabinet's frame of a preview for the stand of the site stacks (docs/plan/62-site-stacks.md,
// Т35, М2к; docs/plan/62-slices/e3.md, Э3.11, P5): a page on the stand's APP_URL holds a preview in
// an iframe exactly as the cabinet does — the same sandbox, no referrer — in Chromium and in WebKit
// of Playwright, so a scenario sees what a cross-site frame keeps of the cookies of the gateway and
// of the site. The page is the browser's own answer for APP_URL (a route of Playwright): web keeps
// its port, and the frame is cross-site all the same — 127.0.0.1 against *.localhost.
//
// Chromium reaches *.localhost on the loopback by itself. WebKit has no --host-rules, and it drops
// the gateway's `__Host-` cookie on http://*.localhost (measured 07.11.2026, WebKit 26.6: a plain
// `Secure` cookie lives there, the prefix does not); so WebKit goes through a local forwarder that
// ends TLS with the stand's certificate in front of the gateway, the browser with
// `ignoreHTTPSErrors`. The forwarder speaks to the gateway as a browser does — origin form, the
// preview's own Host — and turns the preview's `http://` addresses in redirects and texts into
// `https://`. A real Safari stays a manual check (Т69).
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createSecureContext, TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'

import { PREVIEW_SANDBOX } from '../../../packages/domain/src/preview/hostname.ts'

import { HOST_KINDS } from './stand.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
/** The engines P5 runs on; WebKit through the forwarder. */
export const FRAME_ENGINES = Object.freeze(['chromium', 'webkit'])

/** Why WebKit of Playwright on Linux does not sign in inside the cabinet's frame. */
export const LINUX_WEBKIT_FRAME =
  'WebKit of Playwright on Linux blocks third-party cookies and knows no Partitioned: the cookie of the gateway does not live in the cross-site frame of the cabinet (docs/plan/62-site-stacks.md, §10, Э3.16, item 9); the sign-in of WebKit in the frame is checked on Docker Desktop, Safari by hand (Т69)'

/**
 * The engines P5 signs in with on a host of `hostOf` (stand.mjs) and the ones it only notes, with
 * the reason (docs/plan/62-site-stacks.md, §7, О2б, the default (а)): on Linux — a plain one, the
 * Colima VM, the runner of CI — WebKit is a NOTE, no row; on Docker Desktop both engines sign in.
 */
export function frameEnginesOn(kind) {
  if (!HOST_KINDS.includes(kind)) throw new Error(`No kind of host ${kind}`)
  if (kind === 'desktop') return { signIn: [...FRAME_ENGINES], noted: [] }
  return {
    signIn: FRAME_ENGINES.filter((engine) => engine !== 'webkit'),
    noted: [{ engine: 'webkit', reason: LINUX_WEBKIT_FRAME }],
  }
}

/**
 * What the rows of P5 lack on a host of `kind`: each build of `runs` with the group `preview` has a
 * row `P5 <archive> <engine>` for every engine `frameEnginesOn(kind)` signs in with (whether it
 * passed is judged by the failed rows, not here), no row for an engine it only notes, and that
 * engine among `noted` (the ids `runPreviewGroup` noted). Without it a wrong kind of host at the call
 * drops the WebKit rows of Docker Desktop, and the run stays green.
 */
export function frameRowProblems(runs, rows, noted, kind) {
  const engines = frameEnginesOn(kind)
  const problems = []
  for (const { build, groups } of runs) {
    if (!groups.includes('preview')) continue
    for (const engine of engines.signIn) {
      const id = `P5 ${build.archive} ${engine}`
      if (!rows.some((row) => row.id === id)) problems.push(`no row ${id}`)
    }
    for (const { engine } of engines.noted) {
      const id = `P5 ${build.archive} ${engine}`
      if (rows.some((row) => row.id === id)) problems.push(`a row ${id} on a ${kind} host`)
      if (!noted.includes(id)) problems.push(`no note of ${id}`)
    }
  }
  return problems
}

const escapeAttribute = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

/** The cabinet's page: the preview in an iframe of the cabinet's sandbox, no referrer. */
export function cabinetPage(enterUrl) {
  return (
    `<!doctype html><meta charset="utf-8"><title>Кабинет стенда</title>` +
    `<iframe src="${escapeAttribute(enterUrl)}" sandbox="${PREVIEW_SANDBOX}" ` +
    `referrerpolicy="no-referrer" style="width: 100%; height: 90vh; border: 0"></iframe>`
  )
}

/** The value of `sandbox` of the iframe of a page of `cabinetPage`. */
export const sandboxOf = (html) => /<iframe[^>]*\ssandbox="([^"]*)"/.exec(html)?.[1] ?? null

/** An address of a preview on the forwarder: the same host and port, over TLS. */
export function secureUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !parsed.hostname.endsWith('.localhost'))
    throw new Error(`Not an address of a preview: ${url}`)
  parsed.protocol = 'https:'
  return parsed.href
}

/**
 * A text of an answer with the plain addresses of `origin` (`http://<host>:<port>` of a preview)
 * made secure, as written and as JSON writes a slash.
 */
export function secureText(text, origin) {
  const { host } = new URL(origin)
  return text
    .replaceAll(`http://${host}`, `https://${host}`)
    .replaceAll(`http:\\/\\/${host}`, `https:\\/\\/${host}`)
}

const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|rss\+xml|atom\+xml))/i

/**
 * The forwarder WebKit goes through: a proxy on the loopback that takes CONNECT to a host of
 * `*.localhost` on the gateway's port only, ends TLS with `key` and `cert`, and sends each request
 * to the gateway in origin form with the Host the browser asked for. A plain `http://` request of a
 * preview is sent to its `https://` address (301); anything else is refused.
 */
export async function startSecureForwarder({ key, cert, gatewayPort }) {
  const secureContext = createSecureContext({ key, cert })
  const sockets = new Set()
  const site = createServer((request, response) => {
    const host = String(request.headers.host ?? '')
    const origin = `http://${host}`
    const headers = { ...request.headers }
    // Plain bytes: the texts are rewritten on the way.
    delete headers['accept-encoding']
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: gatewayPort,
        method: request.method,
        path: request.url,
        headers,
      },
      (answer) => {
        const out = { ...answer.headers }
        if (typeof out.location === 'string') out.location = secureText(out.location, origin)
        const textual = TEXTUAL.test(String(out['content-type'] ?? ''))
        if (!textual || answer.headers['content-encoding']) {
          response.writeHead(answer.statusCode ?? 502, out)
          answer.pipe(response)
          return
        }
        const chunks = []
        answer.on('data', (chunk) => chunks.push(chunk))
        answer.on('end', () => {
          const body = Buffer.from(secureText(Buffer.concat(chunks).toString('utf8'), origin))
          delete out['transfer-encoding']
          out['content-length'] = String(body.length)
          response.writeHead(answer.statusCode ?? 502, out)
          response.end(body)
        })
        answer.on('error', () => response.destroy())
      },
    )
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  const proxy = createServer((request, response) => {
    let target = null
    try {
      target = new URL(request.url ?? '')
    } catch {
      // Refused below.
    }
    if (target?.protocol === 'http:' && target.hostname.endsWith('.localhost')) {
      response.writeHead(301, { location: secureUrl(target.href) }).end()
      return
    }
    response.writeHead(403).end()
  })
  proxy.on('connect', (request, socket, head) => {
    const [hostname, port] = String(request.url ?? '').split(':')
    if (!hostname?.endsWith('.localhost') || Number(port) !== gatewayPort) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) socket.unshift(head)
    const secure = new TLSSocket(socket, { isServer: true, secureContext })
    sockets.add(secure)
    secure.on('close', () => sockets.delete(secure))
    secure.on('error', () => secure.destroy())
    site.emit('connection', secure)
  })
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  return {
    server: `http://127.0.0.1:${proxy.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      proxy.closeAllConnections()
      await new Promise((done) => proxy.close(() => done()))
    },
  }
}

/** The engines of Playwright of this tree. */
function playwright() {
  const require = createRequire(`${root}packages/browser-providers/package.json`)
  return require('playwright-core')
}

/**
 * Opens the cabinet's page with the preview of `enterUrl` in its frame, in `engine`. `forwarder` —
 * of `startSecureForwarder`, WebKit's way to the gateway: then every address of the preview this
 * frame opens is its `https://` one. Returns the page, the frame, a tab of the same browser (the
 * control that a cookie of a script lives at the top) and whether a page keeps such a cookie.
 */
export async function openCabinetFrame({ engine, appOrigin, enterUrl, forwarder = null }) {
  if (!FRAME_ENGINES.includes(engine)) throw new Error(`No engine ${engine}`)
  const app = new URL(appOrigin)
  const address = (url) => (forwarder && url.startsWith('http:') ? secureUrl(url) : url)
  // The cabinet's document is the browser's own answer (a route), with no address of its own:
  // Chromium counts it public and refuses its frame on the loopback (Local Network Access,
  // `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, measured 07.11.2026, Chromium 153). In
  // production the cabinet and the preview are both public and the check plays no part: it is
  // off here, and nothing else of the browser is changed.
  const browser = await playwright()[engine].launch(
    forwarder
      ? { proxy: { server: forwarder.server } }
      : { args: ['--disable-features=LocalNetworkAccessChecks'] },
  )
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: forwarder !== null })
    const page = await context.newPage()
    // Only the cabinet's own document is answered here; the frame goes to the gateway.
    await page.route(`${app.origin}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: cabinetPage(address(enterUrl)),
      }),
    )
    await page.goto(`${app.origin}/`, { waitUntil: 'domcontentloaded' })
    return {
      page,
      frame: page.frameLocator('iframe'),
      /** The Frame of the preview, once the iframe has one. */
      async frameOf() {
        const handle = await page.locator('iframe').elementHandle()
        return handle?.contentFrame() ?? null
      },
      async tab(url) {
        const tab = await context.newPage()
        await tab.goto(address(url))
        return tab
      },
      /**
       * Whether the page keeps a cookie written from script with no attributes. A frame whose
       * document may not touch cookies at all (Chromium throws a SecurityError) keeps none.
       */
      async keepsPlainCookie(target) {
        const name = `raditi-plain-${Math.random().toString(16).slice(2, 10)}`
        return target.evaluate((cookie) => {
          try {
            document.cookie = `${cookie}=1`
            const kept = document.cookie.split('; ').some((pair) => pair.startsWith(`${cookie}=`))
            document.cookie = `${cookie}=; Max-Age=0`
            return kept
          } catch {
            return false
          }
        }, name)
      },
      /** Where the frame stands and the start of its text: what a scenario says when it fails. */
      async whereIsFrame() {
        const handle = await page.locator('iframe').elementHandle()
        const frame = await handle?.contentFrame()
        if (!frame) return { frame: null }
        const text = await frame
          .evaluate(() => document.body?.innerText ?? '')
          .catch((error) => `(${error.message})`)
        return { url: frame.url(), text: text.replace(/\s+/g, ' ').slice(0, 400) }
      },
      /** The names of the cookies of an origin, never their values. */
      async cookieNames(url) {
        return (await context.cookies(address(url)))
          .map((cookie) =>
            cookie.partitionKey === undefined
              ? cookie.name
              : `${cookie.name} (partitioned by ${cookie.partitionKey})`,
          )
          .sort()
      },
      version: browser.version(),
      close: () => browser.close(),
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}
