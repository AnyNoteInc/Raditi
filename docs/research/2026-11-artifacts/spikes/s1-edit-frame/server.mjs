// Two origins on loopback: the cabinet (http://127.0.0.1:<p>) and «outside» (http://localhost:<q>),
// which records every request a vector makes. Headers of the cabinet replicate
// apps/web/next.config.ts and apps/web/src/lib/content-security-policy.ts.
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as corpus from './corpus.mjs'
import { stamp, patchText, editCopy } from './stamp.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** 0.1 s of silence, 8 kHz, 8 bit, mono. */
const WAV = (() => {
  const n = 800
  const b = Buffer.alloc(44 + n, 128)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(8000, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  return b
})()

/** The cabinet's policy (content-security-policy.ts) with the domain of pages added by proxy.ts. */
export const cabinetCsp = (pages) =>
  [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
    `frame-src 'self' https://smartcaptcha.cloud.yandex.ru${pages ? ` ${pages}` : ''}`,
  ].join('; ')

/** securityHeaders of next.config.ts (development: no HSTS). */
export const cabinetHeaders = (pages) => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': cabinetCsp(pages),
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
})

/** The policy proposed for the edit frame route on the cabinet's origin. */
export const EDIT_CSP = [
  'sandbox allow-same-origin',
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
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

export const EDIT_HEADERS = {
  'Content-Security-Policy': EDIT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()',
}

/** Header sets of the edit frame route, by `h`. */
export function routeHeaders(h, pages) {
  const html = { 'Content-Type': 'text/html; charset=utf-8' }
  switch (h) {
    case 'good':
      return [html, EDIT_HEADERS]
    case 'good-no-xfo': {
      const { 'X-Frame-Options': _, ...rest } = EDIT_HEADERS
      return [html, rest]
    }
    case 'good-coep':
      return [html, EDIT_HEADERS, { 'Cross-Origin-Embedder-Policy': 'require-corp' }]
    case 'cabinet': // the route left inside the regex of next.config.ts headers()
      return [html, cabinetHeaders(pages)]
    case 'cabinet-and-good': // the route adds its own policy, next.config.ts still sends the cabinet's
      return [html, cabinetHeaders(pages), { 'Content-Security-Policy': [cabinetCsp(pages), EDIT_CSP] }]
    case 'good-xfo-deny': // own policy, but X-Frame-Options: DENY still there
      return [html, EDIT_HEADERS, { 'X-Frame-Options': 'DENY' }]
    case 'none':
      return [html]
    case 'csp-only': // no sandbox at all: only script-src 'none' and the rest of the policy
      return [html, EDIT_HEADERS, { 'Content-Security-Policy': EDIT_CSP.replace('sandbox allow-same-origin; ', '') }]
    case 'scripts-csp-none': // sandbox lets scripts run, the policy forbids every script of the artifact
      return [html, EDIT_HEADERS, { 'Content-Security-Policy': EDIT_CSP.replace('sandbox allow-same-origin', 'sandbox allow-same-origin allow-scripts') }]
    default:
      throw new Error(`unknown header set ${h}`)
  }
}

function merge(list) {
  const out = {}
  for (const h of list) Object.assign(out, h)
  return out
}

function send(res, status, headers, body) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.statusCode = status
  res.end(body)
}

const readBody = (req) =>
  new Promise((ok) => {
    const parts = []
    req.on('data', (c) => parts.push(c))
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')))
  })

export async function startServers() {
  const hits = []
  const stored = new Map()
  let cabOrigin = ''
  let extOrigin = ''

  const record = (origin, kind, req, url) =>
    hits.push({
      origin,
      kind,
      t: url.searchParams.get('t') ?? url.pathname.split('/')[2] ?? '',
      v: url.searchParams.get('v') ?? url.pathname.split('/').pop(),
      cookie: (req.headers.cookie ?? '').includes('cabsession='),
      method: req.method,
      path: url.pathname,
      dest: req.headers['sec-fetch-dest'] ?? null,
      site: req.headers['sec-fetch-site'] ?? null,
      at: Date.now(),
    })

  /** The HTML of one synthetic artifact. */
  function docOf(name, t, { meta, doStamp }) {
    const ext = extOrigin
    let html
    if (name === 'vectors') html = corpus.vectorsDoc(ext, t, { meta })
    else if (name === 'landing') html = corpus.landingDoc(ext, t, { meta })
    else if (name === 'clobber') html = corpus.clobberDoc({ meta })
    else if (name === 'base') html = corpus.baseDoc(ext, t, { meta })
    else if (name.startsWith('one-')) {
      // One vector alone (to find which one hangs an engine).
      const v = [...corpus.autoVectors(ext, t), ...corpus.networkVectors(ext, t)].find(([n]) => n === name.slice(4))
      if (!v) throw new Error(`no vector ${name}`)
      html = corpus.wrap(v[1] ?? '', { meta, bodyAttrs: v[0] === 'body-onload' ? ` onload="${corpus.mark('body-onload', ext, t).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : '' })
    }
    else if (name === 'blank') html = corpus.wrap('<p id="p">Пусто</p>', { meta })
    else if (name.startsWith('click-')) {
      const v = corpus.clickVectors(ext, t).find(([n]) => n === name.slice(6))
      if (!v) throw new Error(`no click vector ${name}`)
      html = corpus.wrap(`<p>Вектор</p>${v[1]}`, { meta })
    } else if (name.startsWith('nav-')) {
      const v = corpus.navVectors(ext, t).find(([n]) => n === name.slice(4))
      if (!v) throw new Error(`no nav vector ${name}`)
      html = corpus.wrap('<p>Вектор</p>', { meta, head: v[1] })
    } else if (name.startsWith('stored-')) {
      html = stored.get(name.slice(7))
      if (html === undefined) throw new Error(`no stored ${name}`)
      return meta ? html.replace('<head>', `<head>${corpus.metaCsp()}`) : html
    } else throw new Error(`no doc ${name}`)
    return doStamp ? stamp(html).html : html
  }

  const cab = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    const pages = extOrigin
    const cabinet = cabinetHeaders(pages)
    try {
      if (p === '/cabinet' || p === '/react-cabinet') {
        const coep = url.searchParams.get('coep') === '1' ? { 'Cross-Origin-Embedder-Policy': 'require-corp' } : {}
        const script = p === '/cabinet' ? '/harness.js' : '/react.js'
        const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Кабинет</title>
<style>body{margin:0;font:14px system-ui,sans-serif}#stage{position:relative;margin:20px;display:inline-block}
#stage iframe{border:2px solid #888;display:block;background:#fff}#copysrc{position:absolute;left:0;top:0;opacity:.01}</style></head>
<body><div id="copysrc">Копия</div><div id="stage"></div><div id="root"></div><script src="${script}"></script></body></html>`
        return send(res, 200, { ...cabinet, ...coep, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'cabsession=s1; Path=/; HttpOnly; SameSite=Lax', 'Cache-Control': 'no-store' }, body)
      }
      if (p === '/harness.js') return send(res, 200, { ...cabinet, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }, readFileSync(join(here, 'harness.js')))
      if (p === '/react.js') {
        const f = join(here, 'dist', 'react.js')
        return send(res, 200, { ...cabinet, 'Content-Type': 'text/javascript; charset=utf-8' }, existsSync(f) ? readFileSync(f) : 'console.error("no bundle")')
      }
      if (p.startsWith('/corpus/')) {
        const name = p.slice(8)
        const t = url.searchParams.get('t') ?? 'x'
        const raw = docOf(name, t, { meta: url.searchParams.get('meta') === '1', doStamp: url.searchParams.get('stamp') === '1' })
        const html = url.searchParams.get('clean') === '1' ? editCopy(raw) : raw
        return send(res, 200, { ...cabinet, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, html)
      }
      const route = p.match(/^\/api\/artifacts\/([a-z0-9-]+)\/edit-frame$/)
      if (route) {
        record('cab', 'route', req, url)
        const t = url.searchParams.get('t') ?? 'x'
        const raw = docOf(route[1], t, { meta: url.searchParams.get('meta') === '1', doStamp: url.searchParams.get('stamp') === '1' })
        const html = url.searchParams.get('clean') === '1' ? editCopy(raw) : raw
        return send(res, 200, merge(routeHeaders(url.searchParams.get('h') ?? 'good', pages)), html)
      }
      if (p === '/store' && req.method === 'POST') {
        const { key, name, t } = JSON.parse(await readBody(req))
        stored.set(key, docOf(name, t, { meta: false, doStamp: true }))
        return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, bytes: stored.get(key).length }))
      }
      if (p === '/patch' && req.method === 'POST') {
        const { key, id, shape, edits } = JSON.parse(await readBody(req))
        const before = stored.get(key)
        const out = patchText(before, { id, shape, edits })
        let outside = null
        if (out.ok) {
          // Bytes outside the patched ranges must not move.
          const r = [...out.ranges].sort((a, b) => a[0] - b[0])
          const first = r[0][0]
          const last = r[r.length - 1]
          const tail = before.length - (last[0] + last[1])
          outside = before.slice(0, first) === out.html.slice(0, first) && before.slice(before.length - tail) === out.html.slice(out.html.length - tail)
          stored.set(key, out.html)
        }
        return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: out.ok, refusal: out.refusal ?? null, ranges: out.ranges ?? null, outsideUnchanged: outside }))
      }
      if (p === '/api/probe') {
        record('cab', 'probe', req, url)
        return send(res, 200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }, GIF)
      }
      if (p === '/js') {
        record('cab', 'load', req, url)
        return send(res, 200, { 'Content-Type': 'text/javascript' }, corpus.mark(url.searchParams.get('v'), extOrigin, url.searchParams.get('t')))
      }
      if (p === '/hit') {
        record('cab', 'hit', req, url)
        return send(res, 204, {}, '')
      }
      send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
    } catch (e) {
      send(res, 500, { 'Content-Type': 'text/plain' }, String(e?.stack ?? e))
    }
  })

  const extHandler = (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' }
    if (p === '/hit') {
      record('ext', 'hit', req, url)
      return send(res, 200, { ...cors, 'Content-Type': 'image/gif' }, GIF)
    }
    if (p === '/res' || p.startsWith('/b/')) {
      record('ext', 'load', req, url)
      if (url.searchParams.get('type') === 'css') return send(res, 200, { ...cors, 'Content-Type': 'text/css' }, '.x{}')
      // A real sound: WebKit on Linux (WPE, GStreamer) spins at 100 % CPU on a picture in <audio>.
      if (url.searchParams.get('type') === 'audio') return send(res, 200, { ...cors, 'Content-Type': 'audio/wav' }, WAV)
      return send(res, 200, { ...cors, 'Content-Type': 'image/gif' }, GIF)
    }
    if (p === '/js') {
      record('ext', 'load', req, url)
      return send(res, 200, { ...cors, 'Content-Type': 'text/javascript' }, corpus.mark(url.searchParams.get('v'), extOrigin, url.searchParams.get('t')))
    }
    if (p === '/page') {
      record('ext', 'load', req, url)
      const v = url.searchParams.get('v')
      return send(res, 200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' }, `<!doctype html><p>чужая страница</p><script>${corpus.mark(`${v}-ran`, extOrigin, url.searchParams.get('t'))}</script>`)
    }
    if (p === '/view') {
      // A «view» document with scripts, like /v/<token> on the domain of pages.
      const v = url.searchParams.get('v') ?? 'view'
      return send(res, 200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' }, `<!doctype html><html data-view="1"><body><p>просмотр</p><script>${corpus.mark(v, extOrigin, url.searchParams.get('t') ?? 'x')}</script></body></html>`)
    }
    send(res, 404, cors, 'not found')
  }
  const ext4 = createServer(extHandler)
  const ext6 = createServer(extHandler)

  await new Promise((ok) => cab.listen(0, '127.0.0.1', ok))
  await new Promise((ok) => ext4.listen(0, '127.0.0.1', ok))
  const extPort = ext4.address().port
  await new Promise((ok) => {
    ext6.once('error', () => ok())
    ext6.listen(extPort, '::1', ok)
  })
  cabOrigin = `http://127.0.0.1:${cab.address().port}`
  extOrigin = `http://localhost:${extPort}`
  return {
    cabOrigin,
    extOrigin,
    hits,
    stored,
    close: () => Promise.all([cab, ext4, ext6].map((s) => new Promise((ok) => (s.listening ? s.close(ok) : ok())))),
  }
}
