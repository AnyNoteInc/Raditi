// Independent check of spike 1 (plan 88, Э0а): a small server of its own, not the builder's.
// Three origins on loopback: the cabinet (CAB), the root of pages (PAGES) and a foreign site (FOREIGN).
// The cabinet page carries the headers of apps/web/next.config.ts and content-security-policy.ts.
import { createServer } from 'node:http'

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export function cabinetHeaders(pages) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
      `frame-src 'self' https://smartcaptcha.cloud.yandex.ru ${pages}`,
    ].join('; '),
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  }
}

/** The route policy exactly as the spike proposes it for §7.9, with the root of pages filled in. */
export function proposedCsp(pages) {
  return [
    'sandbox allow-same-origin',
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${pages}`,
    `font-src data: ${pages}`,
    'media-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

export function proposedHeaders(pages) {
  return {
    'Content-Security-Policy': proposedCsp(pages),
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
}

/** The meta policy first in head for srcdoc (no sandbox: a meta policy cannot carry it). */
export const metaCsp = (pages) =>
  `<meta http-equiv="Content-Security-Policy" content="${proposedCsp(pages).replace('sandbox allow-same-origin; ', '').replace("; frame-ancestors 'self'", '')}">`

export async function startServers() {
  const log = []
  const docs = new Map()
  const o = { CAB: '', PAGES: '', FOREIGN: '' }
  const rec = (origin, req, url) =>
    log.push({
      origin,
      path: url.pathname,
      v: url.searchParams.get('v'),
      cookie: /(?:^|;\s*)sid=/.test(req.headers.cookie ?? ''),
      dest: req.headers['sec-fetch-dest'] ?? null,
      site: req.headers['sec-fetch-site'] ?? null,
      mode: req.headers['sec-fetch-mode'] ?? null,
      at: Date.now(),
    })
  const send = (res, status, headers, body) => {
    res.writeHead(status, headers)
    res.end(body)
  }
  const cabPage = (script) =>
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Кабинет</title>` +
    `<style>body{margin:0;font:14px sans-serif}#host{position:relative;margin:20px;display:inline-block}` +
    `#host iframe{display:block;border:1px solid #999;background:#fff}#copy{position:absolute;left:0;top:0;opacity:.02}` +
    `#outside{position:absolute;left:0;bottom:0;width:140px;height:30px}</style></head>` +
    `<body><span id="copy">копия</span><div id="host"></div><button id="outside" type="button">Снаружи</button>` +
    `${script ? `<script src="${script}"></script>` : ''}</body></html>`

  const cab = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    rec('cab', req, url)
    if (p === '/cab')
      return send(res, 200, { ...cabinetHeaders(o.PAGES), 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'sid=v1; Path=/; HttpOnly; SameSite=Lax', 'Cache-Control': 'no-store' }, cabPage(null))
    if (p === '/cabcoep')
      return send(res, 200, { ...cabinetHeaders(o.PAGES), 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, cabPage(null))
    if (p === '/cab3') return send(res, 200, { ...cabinetHeaders(o.PAGES), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, cabPage('/cab3.js'))
    if (p === '/cab3.js')
      // The calls under test: the cabinet's own script asks the frame's window to compile strings.
      return send(
        res,
        200,
        { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
        `window.__doAll = (tag) => {
  const f = document.querySelector('#host iframe')
  const w = f.contentWindow
  const code = (n) => "try{localStorage.setItem('ran:" + tag + n + "','1')}catch(e){}"
  const res = {}
  try { w.eval(code('eval')); res.eval = 'called' } catch (e) { res.eval = 'threw ' + e.name }
  try { new w.Function(code('function'))(); res.function = 'called' } catch (e) { res.function = 'threw ' + e.name }
  try { w.setTimeout(code('timeout'), 0); res.timeout = 'called' } catch (e) { res.timeout = 'threw ' + e.name }
  return res
}
document.getElementById('outside').addEventListener('click', () => { window.__clickResult = window.__doAll('click-') })`,
      )
    if (p === '/cabjs')
      // Today's cabinet policy (no script-src) with a script of the cabinet's own.
      return send(res, 200, { ...cabinetHeaders(o.PAGES), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, cabPage('/cabstrict.js'))
    if (p === '/cabstrict')
      // The cabinet once M8 gives it a script policy: no 'unsafe-eval'.
      return send(
        res,
        200,
        {
          ...cabinetHeaders(o.PAGES),
          'Content-Security-Policy': `${cabinetHeaders(o.PAGES)['Content-Security-Policy']}; script-src 'self'`,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        cabPage('/cabstrict.js'),
      )
    if (p === '/cabstrict.js')
      // eval here is the object of the test: does the cabinet's own call of the frame's eval run
      // under a cabinet policy without 'unsafe-eval'? The code is a fixed synthetic marker.
      return send(
        res,
        200,
        { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
        `window.__evalResult = null
document.getElementById('outside').addEventListener('click', () => {
  const f = document.querySelector('#host iframe')
  const code = "try{localStorage.setItem('ran:feval','1')}catch(e){}"
  let own = 'n/a'
  try { eval('1'); own = 'eval allowed in the cabinet' } catch (e) { own = 'eval blocked in the cabinet' }
  try { f.contentWindow.eval(code); window.__evalResult = { frame: 'called', own } } catch (e) { window.__evalResult = { frame: 'threw: ' + String(e).slice(0, 120), own } }
})`,
      )
    const m = p.match(/^\/f\/([\w.-]+)$/)
    if (m) {
      const d = docs.get(m[1])
      if (!d) return send(res, 404, { 'Content-Type': 'text/plain' }, 'no doc')
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', ...d.headers }, d.html)
    }
    if (p === '/b') return send(res, 200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }, GIF)
    // Another page of the cabinet's origin without frame headers (an API route, say).
    if (p === '/nav') return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, '<!doctype html><p>страница кабинета</p>')
    send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
  })

  const other = (name) =>
    createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      const p = url.pathname
      rec(name, req, url)
      const cors = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' }
      if (p === '/view') {
        const v = url.searchParams.get('v') ?? 'view'
        return send(res, 200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' }, `<!doctype html><html data-view="1"><body><p>просмотр</p><script>try{top.postMessage('ran:${v}','*')}catch(e){}</script></body></html>`)
      }
      if (p === '/nav') return send(res, 200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' }, '<!doctype html><p>другой сайт</p>')
      if (url.searchParams.get('type') === 'css') return send(res, 200, { ...cors, 'Content-Type': 'text/css' }, '.q{}')
      // No body for <audio>: WebKit for Linux (GStreamer) is said to spin on a picture there.
      if (url.searchParams.get('type') === 'audio') return send(res, 404, cors, '')
      return send(res, 200, { ...cors, 'Content-Type': 'image/gif' }, GIF)
    })
  const pages = other('pages')
  const foreign = other('foreign')
  await new Promise((ok) => cab.listen(0, '127.0.0.1', ok))
  await new Promise((ok) => pages.listen(0, '127.0.0.1', ok))
  await new Promise((ok) => foreign.listen(0, '127.0.0.1', ok))
  o.CAB = `http://127.0.0.1:${cab.address().port}`
  // "localhost" resolves to 127.0.0.1 here; a different host name is a different origin and site.
  o.PAGES = `http://localhost:${pages.address().port}`
  o.FOREIGN = `http://127.0.0.1:${foreign.address().port}`
  return {
    ...o,
    log,
    put: (id, html, headers = {}) => docs.set(id, { html, headers }),
    close: () => Promise.all([cab, pages, foreign].map((s) => new Promise((ok) => s.close(ok)))),
  }
}
