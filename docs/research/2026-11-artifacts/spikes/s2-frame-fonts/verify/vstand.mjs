// An independent stand for the skeptic of spike s2 (plan 88, Э0а). Not the spike's stand.mjs:
// other names, another layout of the frames (one header variant per frame, all frames at once),
// other probes (canvas measureText, link.sheet, img.decode, dynamic import()), and the product's
// own TypeScript sources (headers.ts, files.ts, page-cookie.ts, type-stripped by Node) instead of
// a replica. One https and one http server behind a local proxy; every other name is refused.
//
//   example.test             the cabinet (apex, as raditi.ru)
//   pages.example.test       the root of the domain of pages (as pages.raditi.ru)
//   sib.pages.example.test   a sibling host of the same site: the negative control of 'self'
//   <slug>.pages.example.test published sites (pub, pubfix, pw, pwfix, ref)
//   other.test               another site
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { connect } from 'node:net'
import { crc32, deflateSync } from 'node:zlib'

import { pagePolicy, pageResponseHeaders, PAGE_COMMON_HEADERS } from './product/headers.ts'
import { pageFileHeaders } from './product/files.ts'
import { PAGE_COOKIE, pageCookieOpens, pageSetCookie } from './product/page-cookie.ts'

export const APP = 'example.test'
export const PAGES = 'pages.example.test'
export const SIB = 'sib.pages.example.test'
export const OTHER = 'other.test'
export const SITES = {
  pub: { password: false, acao: false },
  pubfix: { password: false, acao: true },
  pw: { password: true, acao: false },
  pwfix: { password: true, acao: true },
  ref: { password: true, acao: true, referrer: 'strict-origin' },
}
export const PASSWORD = 'пароль-проверки'
const SECRET = randomBytes(32).toString('hex')
export const TEXT = 'Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства'

/** A 4×5 PNG: naturalHeight 5 proves it decoded. */
function png(w = 4, h = 5) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 0, 0, 0, 0], 8) // 8-bit greyscale
  const rows = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.from([0, ...Array(w).fill(40 * y)])))
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CORP × ACAO of a resource of the platform, as the spike names them. */
export const VARIANTS = {
  h1: ['cross-origin', '*'],
  h2: ['cross-origin', null],
  h3: ['same-origin', '*'],
  h4: ['same-origin', null],
  h5: [null, '*'],
  h6: [null, null],
  h7: ['same-site', '*'],
  h8: ['same-site', null],
}

/** The probe of a frame or a page: canvas width, FontFace status, link.sheet, img.decode, flags. */
function probe({ fonts, post }) {
  return `
self.__v = {};
const __violations = [];
document.addEventListener('securitypolicyviolation', (e) => __violations.push({ d: e.effectiveDirective, u: String(e.blockedURI).replace(/[?#].*$/, '') }));
async function __report(extra) {
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (family) => { ctx.font = '32px ' + family; return Math.round(ctx.measureText(${JSON.stringify(TEXT)}).width * 100) / 100; };
  await Promise.allSettled(${JSON.stringify(fonts)}.map((f) => document.fonts.load('32px "' + f + '"')));
  await new Promise((r) => setTimeout(r, 200));
  const statuses = {}; document.fonts.forEach((f) => { statuses[f.family.replace(/["']/g, '')] = f.status; });
  const mono = measure('monospace');
  const fonts = {};
  for (const f of ${JSON.stringify(fonts)}) {
    const w = measure('"' + f + '", monospace');
    fonts[f] = { status: statuses[f] ?? 'absent', width: w, mono, applied: Math.abs(w - mono) > 1, check: document.fonts.check('32px "' + f + '"') };
  }
  const sheets = {}; for (const l of document.querySelectorAll('link[rel=stylesheet]')) { let rules = null; try { rules = l.sheet ? l.sheet.cssRules.length : null; } catch (e) { rules = 'throws:' + e.name; } sheets[l.id] = { sheet: !!l.sheet, rules }; }
  const boxes = {}; for (const b of document.querySelectorAll('[data-box]')) boxes[b.id] = getComputedStyle(b).height;
  const images = {};
  for (const i of document.images) { images[i.id] = await i.decode().then(() => i.naturalHeight, (e) => 'fail:' + e.name); }
  let cookie; try { cookie = 'read:' + document.cookie.length; } catch (e) { cookie = 'throws:' + e.name; }
  const result = { tag: 'v2', origin: String(self.origin), url: location.origin, flags: self.__v, fonts, sheets, boxes, images, violations: __violations, cookie, ...extra };
  self.__result = result;
  ${post ? "parent.postMessage(result, '*');" : ''}
}`
}

export async function startStand({ certDir, fontFile }) {
  const font = readFileSync(fontFile)
  const fontB64 = font.toString('base64')
  const picture = png()
  const log = []
  const refused = []
  const scheme = { https: null, http: null }

  const lib = (kind, h, run) => `/v/${kind}-${h}-${run}.f00d`

  /** A resource of the platform on the pages root (or the sibling host, for the controls). */
  function resource(kind, h, run, cache) {
    const bodies = {
      font: [font, 'font/woff2'],
      css: [Buffer.from(`#box-${h}{height:23px}`), 'text/css; charset=utf-8'],
      js: [Buffer.from(`self.__v['js-${h}'] = 1;`), 'text/javascript; charset=utf-8'],
      jsx: [Buffer.from(`self.__v['jsx-${h}'] = 1;`), 'text/javascript; charset=utf-8'],
      mod: [Buffer.from(`import { x } from './leaf-${h}-${run}.f00d'; self.__v['mod-${h}'] = x;`), 'text/javascript; charset=utf-8'],
      leaf: [Buffer.from('export const x = 1;'), 'text/javascript; charset=utf-8'],
      dyn: [Buffer.from('export const y = 2;'), 'text/javascript; charset=utf-8'],
      img: [picture, 'image/png'],
      ctl: [Buffer.from(`self.__v['ctl'] = 1;`), 'text/javascript; charset=utf-8'],
      ctlfont: [font, 'font/woff2'],
    }
    const [body, type] = bodies[kind]
    // The product's own headers of a shared file (files.ts), then CORP and ACAO of the variant.
    const headers = { ...pageFileHeaders(type) }
    delete headers['Cross-Origin-Resource-Policy']
    const [corp, acao] = VARIANTS[h]
    if (corp) headers['Cross-Origin-Resource-Policy'] = corp
    if (acao) headers['Access-Control-Allow-Origin'] = acao
    headers['Cache-Control'] = cache
    headers['Content-Length'] = String(body.byteLength)
    return { headers, body }
  }

  /**
   * The policy of a frame: the product's pagePolicy('html', cabinet) as it is ("today"), then
   * the sandbox of Ар28 and the sources of the variant added by replacing its directives.
   */
  function framePolicy(origin, appOrigin, csp, run, sandbox) {
    let policy = pagePolicy('html', appOrigin)
    if (sandbox === 'art') policy = policy.replace('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox', 'sandbox allow-scripts')
    if (sandbox === 'none') policy = policy.replace(/^sandbox [^;]*; /, '')
    const exact = (kinds) => Object.keys(VARIANTS).flatMap((h) => kinds.map((k) => `${origin}${lib(k, h, run)}`))
    const add = {
      today: { script: [], style: [], img: [], font: [] },
      self: { script: ["'self'"], style: ["'self'"], img: ["'self'"], font: ["'self'"] },
      host: { script: [origin], style: [origin], img: [origin], font: [origin] },
      exact: { script: exact(['js', 'jsx', 'mod', 'leaf', 'dyn']), style: exact(['css']), img: exact(['img']), font: exact(['font']) },
      // The positive control of the controls: any host of the scheme lets them load.
      star: { script: ['*'], style: ['*'], img: ['*'], font: ['*'] },
    }[csp]
    const put = (directive, list) => {
      if (!list.length) return
      policy = policy.replace(new RegExp(`(^|; )${directive} `), `$1${directive} ${list.join(' ')} `)
    }
    put('script-src', add.script)
    put('style-src', add.style)
    put('img-src', add.img)
    put('font-src', add.font)
    return policy
  }

  /** The document of one frame: one header variant, every kind; with the controls in h1. */
  function frameDoc(h, run, controls, s) {
    const sib = `${s}://${SIB}`
    const app = `${s}://${APP}`
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>v2 ${h}</title>
<script>${probe({ fonts: ['V', 'Vdata', 'Vbuf', ...(controls ? ['Vsib'] : [])], post: true })}</script>
<style>
@font-face{font-family:"V";src:url("${lib('font', h, run)}") format("woff2")}
@font-face{font-family:"Vdata";src:url("data:font/woff2;base64,${fontB64}") format("woff2")}
${controls ? `@font-face{font-family:"Vsib";src:url("${sib}${lib('ctlfont', 'h1', run)}") format("woff2")}` : ''}
</style>
<link id="sheet" rel="stylesheet" href="${lib('css', h, run)}">
</head><body>
<div id="box-${h}" data-box style="width:2px"></div>
<p style='font:32px "V",monospace'>${TEXT}</p>
<img id="img" src="${lib('img', h, run)}" alt="">
<script src="${lib('js', h, run)}"></script>
<script src="${lib('jsx', h, run)}" crossorigin></script>
${controls ? `<script src="${app}${lib('ctl', 'h1', run)}"></script>` : ''}
<script type="module" src="${lib('mod', h, run)}"></script>
<script type="module">
try { const m = await import(${JSON.stringify(lib('dyn', h, run))}); self.__v['dyn-${h}'] = m.y; } catch (e) { self.__v['dyn-${h}'] = 'fail:' + e.name; }
try { const face = new FontFace('Vbuf', Uint8Array.from(atob(${JSON.stringify(fontB64)}), (c) => c.charCodeAt(0))); document.fonts.add(face); await face.load(); } catch (e) { self.__v.buf = 'fail:' + e.name; }
if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r));
await __report({ h: ${JSON.stringify(h)} });
</script>
</body></html>`
  }

  /** The cabinet: every variant of a configuration in a frame of its own, all at once. */
  function cabinetDoc(s, { csp, sandbox, run, hs }) {
    const attribute = { art: 'allow-scripts', page: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', none: null }[sandbox]
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>cabinet</title></head><body>
<script>
self.__got = {};
addEventListener('message', (e) => { if (e.data && e.data.tag === 'v2') self.__got[e.data.h] = { messageOrigin: e.origin, ...e.data }; });
for (const h of ${JSON.stringify(hs)}) {
  const f = document.createElement('iframe');
  ${attribute ? `f.setAttribute('sandbox', ${JSON.stringify(attribute)});` : ''}
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.style.cssText = 'width:900px;height:200px';
  f.src = ${JSON.stringify(`${s}://${PAGES}`)} + '/v/frame-' + h + '-${csp}-${sandbox}-${run}.f00d';
  document.body.appendChild(f);
}
</script></body></html>`
  }

  /** A published page with its shared files (Дер34), the probe inline. */
  function sitePage() {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>site</title>
<script>${probe({ fonts: ['Fdirect', 'Fcss'], post: false })}</script>
<style>@font-face{font-family:"Fdirect";src:url("/_files/f/one.woff2") format("woff2")}</style>
<link id="s" rel="stylesheet" href="/_files/s.css">
</head><body>
<div id="box" data-box style="width:2px"></div>
<img id="i" src="/_files/i.png" alt="">
<script src="/_files/a.js"></script>
<script type="module" src="/_files/m.mjs"></script>
<script type="module">
try { const m = await import('/_files/d.mjs'); self.__v.dyn = m.y; } catch (e) { self.__v.dyn = 'fail:' + e.name; }
if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r));
await __report({});
</script>
</body></html>`
  }

  const siteFiles = {
    '/_files/f/one.woff2': ['font/woff2', font],
    '/_files/f/two.woff2': ['font/woff2', font],
    '/_files/s.css': ['text/css; charset=utf-8', Buffer.from('@font-face{font-family:"Fcss";src:url("/_files/f/two.woff2") format("woff2")}\n#box{height:23px}\n')],
    '/_files/a.js': ['text/javascript; charset=utf-8', Buffer.from("self.__v.js = 1; self.__secretOfSite = 'visible';")],
    '/_files/m.mjs': ['text/javascript; charset=utf-8', Buffer.from('self.__v.mod = 1; export {};')],
    '/_files/d.mjs': ['text/javascript; charset=utf-8', Buffer.from('export const y = 2;')],
    '/_files/i.png': ['image/png', picture],
  }

  /** Another site embeds the files of a site in the same browser (no-cors), then reads them. */
  function embedDoc(s, slug) {
    const base = `${s}://${slug}.${PAGES}`
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>other</title>
<link rel="stylesheet" href="${base}/_files/s.css"></head><body>
<div id="box" style="width:2px"></div><img id="i" src="${base}/_files/i.png" alt="">
<script>self.__v = {};</script>
<script src="${base}/_files/a.js"></script>
<script>
addEventListener('load', async () => {
  const read = (init) => fetch(${JSON.stringify(base + '/_files/a.js')}, init).then((r) => r.text().then((t) => 'read ' + r.status + ' ' + t.length), (e) => 'blocked ' + e.name);
  const img = document.getElementById('i');
  self.__embed = {
    script: self.__v.js === 1, secret: self.__secretOfSite ?? null,
    box: getComputedStyle(document.getElementById('box')).height,
    img: await img.decode().then(() => img.naturalHeight, (e) => 'fail:' + e.name),
    include: await read({ credentials: 'include' }), omit: await read({ credentials: 'omit' }), plain: await read({}),
  };
});
</script></body></html>`
  }

  const send = (res, status, headers, body, head) => {
    res.writeHead(status, headers)
    res.end(head ? undefined : body)
  }

  async function handle(req, res, s) {
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
    const url = new URL(req.url ?? '/', `${s}://${host}`)
    const path = url.pathname
    const head = req.method === 'HEAD'
    const appOrigin = `${s}://${APP}`
    const entry = {
      s, host, method: req.method, path, status: 0,
      origin: req.headers.origin ?? null, mode: req.headers['sec-fetch-mode'] ?? null,
      dest: req.headers['sec-fetch-dest'] ?? null, site: req.headers['sec-fetch-site'] ?? null,
      cookie: String(req.headers.cookie ?? '').includes(`${PAGE_COOKIE}=`),
      referer: req.headers.referer ?? null, inm: req.headers['if-none-match'] ?? null,
    }
    log.push(entry)
    const out = (status, headers, body) => {
      entry.status = status
      send(res, status, headers, body, head)
    }
    const html = (body) => out(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body)

    if (host === APP) {
      if (path === '/frames') {
        const cfg = { csp: url.searchParams.get('csp'), sandbox: url.searchParams.get('sandbox'), run: url.searchParams.get('run'), hs: url.searchParams.get('hs').split(',') }
        // The cabinet's own policy names the pages root in frame-src (content-security-policy.ts).
        return out(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'self' ${s}://${PAGES}`,
        }, cabinetDoc(s, cfg))
      }
      if (path === '/cache') {
        // Frames of the cache check, one after another (seq) or all at once (par).
        const q = url.searchParams
        const attribute = q.get('sandbox') === 'art' ? 'f.setAttribute("sandbox", "allow-scripts");' : ''
        return html(`<!doctype html><meta charset="utf-8"><script>
self.__done = [];
const n = ${Number(url.searchParams.get('n'))}, par = ${JSON.stringify(q.get('mode') === 'par')};
const add = (i) => { const f = document.createElement('iframe'); ${attribute} f.src = ${JSON.stringify(`${s}://${PAGES}/cache-frame?sandbox=${q.get('sandbox')}&run=${q.get('run')}`)} + '#' + i; document.body.appendChild(f); };
addEventListener('message', (e) => { if (e.data && e.data.tag === 'cache') { self.__done.push(e.data); if (!par && self.__done.length < n) add(self.__done.length); } });
addEventListener('load', () => { if (par) for (let i = 0; i < n; i++) add(i); else add(0); });
</script>`)
      }
      // A control resource on the cabinet's own origin (with 'self' in the frame it must be refused).
      const m = /^\/v\/(ctl)-(h1)-([A-Za-z0-9]+)\.f00d$/.exec(path)
      if (m) {
        const { headers, body } = resource(m[1], m[2], m[3], 'no-store')
        return out(200, headers, body)
      }
      return out(404, { 'Content-Type': 'text/plain' }, 'no')
    }
    if (host === PAGES || host === SIB) {
      const frame = /^\/v\/frame-(h[1-8])-(today|self|host|exact|star)-(art|page|none)-([A-Za-z0-9]+)\.f00d$/.exec(path)
      if (frame && host === PAGES) {
        const [, h, csp, sandbox, run] = frame
        const body = Buffer.from(frameDoc(h, run, h === 'h1', s))
        const headers = { ...pageResponseHeaders('html', { framedBy: appOrigin }), 'Content-Length': String(body.byteLength) }
        headers['Content-Security-Policy'] = framePolicy(`${s}://${PAGES}`, appOrigin, csp, run, sandbox)
        return out(200, headers, body)
      }
      const r = /^\/v\/(font|css|js|jsx|mod|leaf|dyn|img|ctlfont)-(h[1-8])-([A-Za-z0-9]+)\.f00d$/.exec(path)
      if (r) {
        const cache = r[3].startsWith('K') ? 'public, max-age=31536000, immutable' : 'no-store'
        const { headers, body } = resource(r[1], r[2], r[3], cache)
        return out(200, headers, body)
      }
      if (path === '/cache-frame' && host === PAGES) {
        // The frame of the cache check: one immutable library, a font and a module, then a report.
        const run = url.searchParams.get('run')
        const body = `<!doctype html><meta charset="utf-8"><script>self.__v = {};</script><style>@font-face{font-family:K;src:url("${lib('font', 'h1', run)}")}</style>
<p style="font:20px K,monospace">${TEXT}</p><script src="${lib('js', 'h1', run)}"></script><script type="module" src="${lib('mod', 'h1', run)}"></script>
<script>addEventListener('load', async () => { await document.fonts.ready; await new Promise((r) => setTimeout(r, 100)); parent.postMessage({ tag: 'cache', n: location.hash, js: self.__v['js-h1'], mod: self.__v['mod-h1'], font: [...document.fonts].map((f) => f.status).join() }, '*'); });</script>`
        const policy = framePolicy(`${s}://${PAGES}`, appOrigin, 'self', run, url.searchParams.get('sandbox'))
        return out(200, { ...pageResponseHeaders('html', { framedBy: appOrigin }), 'Content-Security-Policy': policy }, body)
      }
      return out(404, { 'Content-Type': 'text/plain' }, 'no')
    }
    const slug = host.endsWith(`.${PAGES}`) ? host.slice(0, -(PAGES.length + 1)) : null
    const site = slug && SITES[slug]
    if (site) {
      const opens = !site.password || pageCookieOpens(SECRET, { id: slug, passwordEpoch: 1 }, req.headers.cookie, Date.now())
      // pages-server.ts #file: 404 by sendText without the cookie, else pageFileHeaders + ETag.
      if (path.startsWith('/_files/')) {
        const file = siteFiles[path]
        const text = (status, t) => out(status, { ...PAGE_COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }, t)
        if (!opens || !file) return text(404, 'Not found')
        const etag = `"${createHash('sha256').update(file[1]).digest('hex')}"`
        const headers = { ...pageFileHeaders(file[0]), ETag: etag }
        if (site.acao) headers['Access-Control-Allow-Origin'] = '*'
        if (req.headers['if-none-match'] === etag) {
          entry.status = 304
          res.writeHead(304, headers)
          return res.end()
        }
        return out(200, { ...headers, 'Content-Length': String(file[1].byteLength) }, file[1])
      }
      if (path !== '/') return out(404, { 'Content-Type': 'text/plain' }, 'no')
      if (req.method === 'POST' && site.password) {
        let raw = ''
        for await (const chunk of req) raw += chunk
        if (new URLSearchParams(raw).get('password') === PASSWORD) {
          entry.status = 303
          res.writeHead(303, { ...PAGE_COMMON_HEADERS, Location: '/', 'Cache-Control': 'no-store', 'Content-Length': '0', 'Set-Cookie': pageSetCookie(SECRET, { id: slug, passwordEpoch: 1 }, Date.now(), 3600) })
          return res.end()
        }
      }
      if (!opens) {
        const body = '<!doctype html><meta charset="utf-8"><form method="post" action="/"><input id="p" name="password" type="password"><button id="go">Открыть</button></form>'
        return out(200, { ...pageResponseHeaders('platform'), 'Content-Length': String(Buffer.byteLength(body)) }, body)
      }
      const body = Buffer.from(sitePage())
      const etag = `"${slug}.v1"`
      const headers = { ...pageResponseHeaders('html'), ETag: etag }
      if (site.referrer) headers['Referrer-Policy'] = site.referrer
      if (req.headers['if-none-match'] === etag) {
        entry.status = 304
        res.writeHead(304, headers)
        return res.end()
      }
      return out(200, { ...headers, 'Content-Length': String(body.byteLength) }, body)
    }
    if (host === OTHER && path === '/embed') return html(embedDoc(s, url.searchParams.get('site')))
    return out(404, { 'Content-Type': 'text/plain' }, 'no')
  }

  const fail = (res) => (e) => { if (!res.headersSent) res.writeHead(500); res.end(String(e)) }
  const tls = httpsServer({ key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`) }, (q, r) => handle(q, r, 'https').catch(fail(r)))
  const plain = httpServer((q, r) => handle(q, r, 'http').catch(fail(r)))
  for (const server of [tls, plain]) await new Promise((r) => server.listen(0, '127.0.0.1', r))
  scheme.https = tls.address().port
  scheme.http = plain.address().port

  const ours = (name) => name === APP || name.endsWith(`.${APP}`) || name === OTHER
  const proxy = httpServer((req, res) => {
    let target
    try { target = new URL(req.url) } catch { res.writeHead(400); return res.end() }
    if (target.protocol !== 'http:' || !ours(target.hostname)) { refused.push(`${req.method} ${target.host}`); res.writeHead(403); return res.end() }
    const up = httpRequest({ host: '127.0.0.1', port: scheme.http, method: req.method, path: target.pathname + target.search, headers: req.headers }, (a) => { res.writeHead(a.statusCode, a.rawHeaders); a.pipe(res) })
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(up)
  })
  proxy.on('connect', (req, socket, head) => {
    const [name, port] = String(req.url).split(':')
    if (!ours(name) || port !== '443') { refused.push(`CONNECT ${req.url}`); return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') }
    const up = connect(scheme.https, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up) })
    const drop = () => { up.destroy(); socket.destroy() }
    up.on('error', drop)
    socket.on('error', drop)
  })
  for (const server of [proxy, tls, plain]) server.on('clientError', (_e, socket) => socket.destroy())
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  return {
    proxyPort: proxy.address().port,
    log,
    refused,
    framePolicy,
    async close() {
      for (const server of [proxy, tls, plain]) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) }
    },
  }
}
