// The stand of spike s2: one Node process with the cabinet, the root of the domain of pages and
// published sites of pages, over https and http, behind a local proxy that maps the names
// *.spike.test to it. The cabinet (cabinet.spike.test) and the pages (pages.spike.test,
// <slug>.pages.spike.test) are same-site, as raditi.ru and pages.raditi.ru are. Nothing leaves
// the machine: the proxy refuses every other name and records it.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { deflateSync } from 'node:zlib'

import {
  FILE_TYPES,
  PAGE_COMMON_HEADERS,
  PAGE_PLATFORM_CSP,
  PAGE_ROBOTS_TXT,
  PAGES_PATHS,
  cabinetSecurityHeaders,
  contentSecurityPolicy,
  pageAnswerHeaders,
  pageFileHeaders,
  pageHeaders,
  pageResponseHeaders,
  pageSetCookie,
  PAGE_COOKIE,
  sendTextHeaders,
} from './headers.mjs'
import { bufferFontScript, probeScript, TEXT } from './probe.mjs'
import {
  HASH,
  HEADER_VARIANTS,
  RESOURCE_KINDS,
  SANDBOXES,
  frameCsp,
  resourceHeaders,
  resourcePath,
} from './variants.mjs'

export const CABINET = 'cabinet.spike.test'
export const PAGES = 'pages.spike.test'
/** Another site (another registrable domain): only the control of the process check. */
export const XSITE = 'xsite.test'
/** Published sites: s1 public as today, s3 public with the fix, s2 password as today, s4 password with the fix. */
export const SITES = {
  s1: { password: false, fix: false },
  s3: { password: false, fix: true },
  s2: { password: true, fix: false },
  s4: { password: true, fix: true },
  // A probe of a mitigation, not today's headers: the page of a site with a password sends
  // Referrer-Policy: strict-origin, so the server could tell its own requests by Referer.
  s5: { password: true, fix: true, referrer: 'strict-origin' },
}
const PASSWORD = 'секрет-е'

/** A PNG of 3×2 pixels: naturalWidth 3 proves it decoded. */
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(3, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.from([0, 200, 30, 30, 30, 200, 30, 30, 30, 200, 0, 9, 9, 9, 99, 99, 99, 199, 199, 199])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function startStand({ certDir, fontFile }) {
  const font = readFileSync(fontFile)
  if (font.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('not a woff2')
  const fontBase64 = font.toString('base64')
  const picture = png()
  const log = []
  const refused = []
  const cookies = new Set()

  const originOf = (scheme, host) => `${scheme}://${host}`

  /** The body of one resource of the platform. */
  function resourceBody(kind, h, fid) {
    switch (kind) {
      case 'font':
        return font
      case 'img':
        return picture
      case 'css':
        return Buffer.from(`#css-${h}{width:37px}`)
      case 'js':
      case 'jsx':
        return Buffer.from(`window.__ran[${JSON.stringify(`${kind}-${h}`)}] = 1;\n`)
      case 'mjs':
      case 'leaf':
        return Buffer.from(`window.__ran[${JSON.stringify(`${kind}-${h}`)}] = 1;\nexport const ok = 1;\n`)
      case 'mji':
        return Buffer.from(
          `import { ok } from './leaf-${h}-${fid}.${HASH}';\nwindow.__ran[${JSON.stringify(`mji-${h}`)}] = ok;\n`,
        )
    }
    return null
  }

  /** The document in the frame: every kind × every header variant, plus data: and buffer fonts. */
  function viewHtml(fid) {
    const hs = Object.keys(HEADER_VARIANTS)
    const fonts = [...hs.map((h) => `F-${h}`), 'F-data', 'F-buf']
    const faces = hs
      .map((h) => `@font-face{font-family:"F-${h}";src:url("${resourcePath('font', h, fid)}") format("woff2")}`)
      .join('\n')
    const spec = {
      fid,
      fonts,
      css: hs.map((h) => `css-${h}`),
      img: hs.map((h) => `img-${h}`),
      grace: 150,
    }
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>frame ${fid}</title>
<script>${probeScript(spec)}</script>
<style>
${faces}
@font-face{font-family:"F-data";src:url("data:font/woff2;base64,${fontBase64}") format("woff2")}
.cssprobe{width:1px;height:1px}
body{margin:8px;font:14px/1.3 monospace}
p{margin:0;font-size:20px}
</style>
${hs.map((h) => `<link rel="stylesheet" href="${resourcePath('css', h, fid)}">`).join('\n')}
</head><body>
${fonts.map((f) => `<p style='font-family:"${f}",monospace'>${f}: ${TEXT}</p>`).join('\n')}
${hs.map((h) => `<div class="cssprobe" id="css-${h}"></div>`).join('\n')}
${hs.map((h) => `<img id="img-${h}" src="${resourcePath('img', h, fid)}" alt="">`).join('\n')}
${hs.map((h) => `<script src="${resourcePath('js', h, fid)}"></script>`).join('\n')}
${hs.map((h) => `<script src="${resourcePath('jsx', h, fid)}" crossorigin></script>`).join('\n')}
${hs.map((h) => `<script type="module" src="${resourcePath('mjs', h, fid)}"></script>`).join('\n')}
${hs.map((h) => `<script type="module" src="${resourcePath('mji', h, fid)}"></script>`).join('\n')}
<script>${bufferFontScript('F-buf', fontBase64)}</script>
</body></html>`
  }

  /** The published page of a site: its shared files from /_files/ (Дер34). */
  function publishedHtml(slug) {
    const spec = {
      fid: slug,
      fonts: ['F-files', 'F-css', 'F-data'],
      css: ['css-files'],
      img: ['img-files'],
      grace: 150,
    }
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>site ${slug}</title>
<script>${probeScript(spec)}</script>
<style>
@font-face{font-family:"F-files";src:url("/_files/fonts/golos.woff2") format("woff2")}
@font-face{font-family:"F-data";src:url("data:font/woff2;base64,${fontBase64}") format("woff2")}
.cssprobe{width:1px;height:1px}
p{margin:0;font-size:20px}
</style>
<link rel="stylesheet" href="/_files/style.css">
</head><body>
${spec.fonts.map((f) => `<p style='font-family:"${f}",monospace'>${f}: ${TEXT}</p>`).join('\n')}
<div class="cssprobe" id="css-files"></div>
<img id="img-files" src="/_files/img/logo.png" alt="">
<script src="/_files/app.js"></script>
<script type="module" src="/_files/app.mjs"></script>
</body></html>`
  }

  const siteFiles = {
    '/_files/fonts/golos.woff2': { type: FILE_TYPES.woff2, bytes: font },
    '/_files/fonts/golos-css.woff2': { type: FILE_TYPES.woff2, bytes: font },
    '/_files/style.css': {
      type: FILE_TYPES.css,
      bytes: Buffer.from(
        '@font-face{font-family:"F-css";src:url("/_files/fonts/golos-css.woff2") format("woff2")}\n#css-files{width:37px}\n',
      ),
    },
    '/_files/app.js': { type: FILE_TYPES.js, bytes: Buffer.from('window.__ran["files-js"] = 1;\n') },
    '/_files/app.mjs': {
      type: FILE_TYPES.mjs,
      bytes: Buffer.from('window.__ran["files-mjs"] = 1;\nexport {};\n'),
    },
    '/_files/img/logo.png': { type: FILE_TYPES.png, bytes: picture },
  }

  function write(res, status, headers, body, head) {
    res.writeHead(status, headers)
    res.end(head ? undefined : body)
  }

  function record(req, scheme, status) {
    const h = req.headers
    log.push({
      scheme,
      host: String(h.host ?? '').toLowerCase(),
      method: req.method,
      path: req.url,
      status,
      origin: h.origin ?? null,
      mode: h['sec-fetch-mode'] ?? null,
      dest: h['sec-fetch-dest'] ?? null,
      site: h['sec-fetch-site'] ?? null,
      cookie: typeof h.cookie === 'string' && h.cookie.includes(`${PAGE_COOKIE}=`),
      referer: h.referer ?? null,
      inm: h['if-none-match'] ?? null,
    })
  }

  async function handle(req, res, scheme) {
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:(?:443|80)$/, '')
    const url = new URL(req.url ?? '/', `${scheme}://${host}`)
    const path = url.pathname
    const head = req.method === 'HEAD'
    const appOrigin = originOf(scheme, CABINET)
    const pagesOrigin = originOf(scheme, PAGES)
    let status = 200
    const done = (s) => {
      status = s
    }
    try {
      if (host === XSITE && path === '/xssi') {
        // Another site embeds the files of a site with a password (no-cors): do they come with
        // the visitor's cookie (SameSite=None), and does the script run here?
        const slug = (url.searchParams.get('site') ?? 's2').replace(/[^a-z0-9]/g, '')
        const base = `${scheme}://${slug}.${PAGES}`
        const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>xssi</title>
<script>window.__ran = {};</script>
<link rel="stylesheet" href="${base}/_files/style.css">
<style>.cssprobe{width:1px;height:1px}</style>
</head><body><div class="cssprobe" id="css-files"></div><img id="img" src="${base}/_files/img/logo.png" alt="">
<script src="${base}/_files/app.js"></script>
<script>
const read = (init) => fetch('${base}/_files/app.js', init).then((r) => 'read ' + r.status, (e) => 'blocked ' + e.name);
addEventListener('load', async () => {
  const withCookie = await read({ credentials: 'include' });
  const plain = await read({});
  window.__xssi = { script: window.__ran['files-js'] === 1, css: getComputedStyle(document.getElementById('css-files')).width, img: document.getElementById('img').naturalWidth, fetchWithCookie: withCookie, fetchPlain: plain };
});
</script>
</body></html>`
        done(200)
        return write(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body, head)
      }
      if (host === XSITE) {
        // A page of another site: the control of the process check (it must be an OOPIF).
        done(200)
        return write(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, '<!doctype html><p>another site</p>', head)
      }
      if (host === CABINET && path === '/oopif') {
        // The process check: a sandboxed frame of the pages root, an unsandboxed one, a frame of
        // another site. Not a page of the cabinet: its frame-src names the other site too.
        const a = url.searchParams.get('a') ?? ''
        const c = url.searchParams.get('c') ?? ''
        const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>oopif</title></head><body>
<script>window.__results = {}; addEventListener('message', (e) => { if (e.data && e.data.spike === 's2') window.__results[e.data.fid] = e.data });</script>
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${pagesOrigin}${a}" style="width:400px;height:300px"></iframe>
<iframe referrerpolicy="no-referrer" src="${pagesOrigin}${c}" style="width:400px;height:300px"></iframe>
<iframe referrerpolicy="no-referrer" src="${scheme}://${XSITE}/" style="width:400px;height:300px"></iframe>
</body></html>`
        done(200)
        return write(
          res,
          200,
          {
            ...cabinetSecurityHeaders,
            'Content-Security-Policy': `${contentSecurityPolicy(pagesOrigin)} ${scheme}://${XSITE}`,
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
          body,
          head,
        )
      }
      if (host === CABINET) {
        if (path !== '/chat') {
          done(404)
          return write(res, 404, { 'content-type': 'text/plain' }, 'Not found', head)
        }
        const view = url.searchParams.get('view') ?? ''
        const sandbox = url.searchParams.get('sandbox') ?? 'art'
        const count = Number(url.searchParams.get('n') ?? '1')
        const attribute = SANDBOXES[sandbox].attribute
        const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>cabinet</title></head><body>
<script>
window.__results = {}; window.__messages = [];
const src = ${JSON.stringify(pagesOrigin + view)};
const count = ${count};
const attribute = ${JSON.stringify(attribute)};
function frame(i) {
  const f = document.createElement('iframe');
  if (attribute !== null) f.setAttribute('sandbox', attribute);
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.style.cssText = 'width:1100px;height:900px;border:0;display:block';
  f.src = src + '#' + i;
  document.body.appendChild(f);
}
addEventListener('message', (e) => {
  window.__messages.push({ origin: e.origin, kind: typeof e.data });
  if (!e.data || e.data.spike !== 's2') return;
  window.__results[e.data.frame] = e.data;
  const next = Number(e.data.frame) + 1;
  if (next < count) frame(next);
});
frame(0);
</script>
</body></html>`
        done(200)
        return write(
          res,
          200,
          {
            ...cabinetSecurityHeaders,
            'Content-Security-Policy': contentSecurityPolicy(pagesOrigin),
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
          body,
          head,
        )
      }

      if (host === PAGES) {
        // proxy.ts:36-43 — the pages root answers robots.txt and GET/HEAD /v/<token> only.
        if (path === '/robots.txt') {
          done(200)
          return write(
            res,
            200,
            { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
            PAGE_ROBOTS_TXT,
            head,
          )
        }
        const read = req.method === 'GET' || req.method === 'HEAD'
        if (!read || !PAGES_PATHS.test(path)) {
          done(404)
          return write(res, 404, pageAnswerHeaders, 'Not found', head)
        }
        const label = path.slice(3, path.lastIndexOf('.'))
        const view = /^view-(art|page|none)-(c[0-5])-([A-Za-z0-9]+)$/.exec(label)
        if (view) {
          const [, sandbox, csp, fid] = view
          const bytes = Buffer.from(viewHtml(fid))
          const headers = pageHeaders(appOrigin, bytes.byteLength)
          headers['Content-Security-Policy'] = frameCsp({ sandbox, csp, appOrigin, pagesOrigin, fid })
          done(200)
          return write(res, 200, headers, bytes, head)
        }
        const resource = /^(font|js|jsx|mjs|mji|leaf|css|img)-(h[1-8])-([A-Za-z0-9]+)$/.exec(label)
        if (resource) {
          const [, kind, h, fid] = resource
          const body = resourceBody(kind, h, fid)
          // A fid that begins with K asks for the caching of a content-addressed library.
          const cache = fid.startsWith('K') ? 'public, max-age=31536000, immutable' : 'no-store'
          const headers = {
            ...resourceHeaders(RESOURCE_KINDS[kind].type, h, cache),
            'Content-Length': String(body.byteLength),
          }
          done(200)
          return write(res, 200, headers, body, head)
        }
        done(404)
        return write(res, 404, pageAnswerHeaders, 'Не найдено', head)
      }

      const slug = host.endsWith(`.${PAGES}`) ? host.slice(0, -(PAGES.length + 1)) : null
      const site = slug === null ? null : SITES[slug]
      if (site) {
        const cookie = String(req.headers.cookie ?? '')
          .split(';')
          .map((p) => p.trim())
          .find((p) => p.startsWith(`${PAGE_COOKIE}=`))
        const opens = !site.password || (cookie !== undefined && cookies.has(cookie.slice(PAGE_COOKIE.length + 1)))
        if (path === '/robots.txt') {
          const bytes = Buffer.from(PAGE_ROBOTS_TXT)
          done(200)
          return write(res, 200, sendTextHeaders(bytes.byteLength), bytes, head)
        }
        // pages-server.ts:298-345 — a shared file.
        if (path.startsWith('/_files/')) {
          if (req.method === 'POST') {
            done(405)
            return write(res, 405, { ...sendTextHeaders(18), Allow: 'GET, HEAD' }, 'Method not allowed', false)
          }
          const file = siteFiles[path]
          if (!opens || !file) {
            const bytes = Buffer.from('Not found')
            done(404)
            return write(res, 404, sendTextHeaders(bytes.byteLength), bytes, head)
          }
          const etag = `"${sha256(file.bytes)}"`
          const headers = { ...pageFileHeaders(file.type), ETag: etag }
          // The fix under test: Access-Control-Allow-Origin: * on every shared file.
          if (site.fix) headers['Access-Control-Allow-Origin'] = '*'
          if (String(req.headers['if-none-match'] ?? '') === etag) {
            done(304)
            return write(res, 304, headers, undefined, true)
          }
          done(200)
          return write(res, 200, { ...headers, 'Content-Length': String(file.bytes.byteLength) }, file.bytes, head)
        }
        if (path !== '/') {
          const bytes = Buffer.from('Not found')
          done(404)
          return write(res, 404, sendTextHeaders(bytes.byteLength), bytes, head)
        }
        if (site.password && req.method === 'POST') {
          // pages-server.ts:380-437 — the form posts; a right password: 303 with the cookie.
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          if (form.get('password') === PASSWORD) {
            const value = randomBytes(16).toString('base64url')
            cookies.add(value)
            done(303)
            return write(
              res,
              303,
              {
                ...PAGE_COMMON_HEADERS,
                Location: '/',
                'Cache-Control': 'no-store',
                'Content-Length': '0',
                'Set-Cookie': pageSetCookie(value, 3600),
              },
              undefined,
              true,
            )
          }
        }
        if (!opens) {
          // pages-server.ts:362-378 — the password form, the platform's own answer.
          const bytes = Buffer.from(
            `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Пароль</title></head><body><form method="post" action="/"><label for="password">Пароль</label><input id="password" name="password" type="password"><button type="submit">Открыть</button></form></body></html>`,
          )
          done(200)
          return write(
            res,
            200,
            { ...pageResponseHeaders('platform'), 'Content-Length': String(bytes.byteLength) },
            bytes,
            head,
          )
        }
        // pages-server.ts:271-290 — the page under its policy, with its ETag.
        const bytes = Buffer.from(publishedHtml(slug))
        const etag = `"${slug}.1"`
        if (String(req.headers['if-none-match'] ?? '') === etag) {
          done(304)
          return write(res, 304, { ...pageResponseHeaders('html'), ETag: etag }, undefined, true)
        }
        done(200)
        const pageHeadersOfSite = { ...pageResponseHeaders('html'), 'Content-Length': String(bytes.byteLength), ETag: etag }
        if (site.referrer) pageHeadersOfSite['Referrer-Policy'] = site.referrer
        return write(res, 200, pageHeadersOfSite, bytes, head)
      }
      done(404)
      return write(res, 404, { 'content-type': 'text/plain' }, 'Not found', head)
    } finally {
      record(req, scheme, status)
    }
  }

  const onError = (res) => (error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error))
  }
  const tls = createHttpsServer(
    { key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`) },
    (req, res) => handle(req, res, 'https').catch(onError(res)),
  )
  const plain = createHttpServer((req, res) => handle(req, res, 'http').catch(onError(res)))
  await new Promise((r) => tls.listen(0, '127.0.0.1', r))
  await new Promise((r) => plain.listen(0, '127.0.0.1', r))
  const tlsPort = tls.address().port
  const plainPort = plain.address().port

  // The proxy every browser of the run goes through: CONNECT to *.spike.test:443 is piped to the
  // https server, an absolute-form http request to *.spike.test is forwarded to the http server.
  const ours = (name) => name === 'spike.test' || name.endsWith('.spike.test') || name === XSITE
  const proxy = createHttpServer((req, res) => {
    req.on('error', () => res.destroy())
    res.on('error', () => {})
    let target
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400)
      return res.end()
    }
    if (target.protocol !== 'http:' || !ours(target.hostname) || (target.port && target.port !== '80')) {
      refused.push(`${req.method} ${target.protocol}//${target.host}`)
      res.writeHead(403)
      return res.end()
    }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    const forward = httpRequest(
      { host: '127.0.0.1', port: plainPort, method: req.method, path: target.pathname + target.search, headers },
      (answer) => {
        answer.on('error', () => res.destroy())
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders)
        answer.pipe(res)
      },
    )
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(forward)
  })
  proxy.on('connect', (req, socket, head) => {
    const [name, port] = String(req.url ?? '').split(':')
    if (!ours(name ?? '') || port !== '443') {
      refused.push(`CONNECT ${req.url}`)
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const drop = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', drop)
    socket.on('error', drop)
  })
  // A browser that closes mid-request resets its sockets: nothing to do but drop them.
  for (const server of [proxy, tls, plain]) server.on('clientError', (_error, socket) => socket.destroy())
  tls.on('tlsClientError', () => {})
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const proxyPort = proxy.address().port

  return {
    proxyPort,
    log,
    refused,
    fontBytes: font.byteLength,
    viewBytes: (fid) => Buffer.byteLength(viewHtml(fid)),
    async close() {
      for (const server of [proxy, tls, plain]) {
        server.closeAllConnections?.()
        await new Promise((r) => server.close(() => r()))
      }
    },
  }
}
