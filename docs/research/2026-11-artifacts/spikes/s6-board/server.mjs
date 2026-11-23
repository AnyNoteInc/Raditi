// Two local HTTP servers on 127.0.0.1 with dynamic ports:
//  - the cabinet: the static build of the board app (dist/), thumbnails and screens.json;
//  - the frame host: /v/<token> — a mockup with the headers of a framed page (CSP sandbox
//    allow-scripts, like ARTIFACT_SANDBOX of plan 88, Ар28) and /_files/* — photos with CORP cross-origin.
// In Chromium the hosts cabinet.example.com (cabinet), pages.example.com (same site, like
// *.pages.raditi.ru next to raditi.ru) and frames.example.net (another site) are mapped to 127.0.0.1
// by --host-resolver-rules; nothing leaves the machine.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

export const SCREENS = [
  ['m1', 'Кофейня «Зерно»'], ['m2', 'Стоматология «Улыбка»'], ['m3', 'Лавка мёда'], ['m4', 'Салон «Лотос»'], ['m5', 'Ремонт «Мастер»'],
].flatMap(([m, title]) => ['a', 'b'].map((v) => ({ token: `${m}-${v}`, mockup: m, variant: v, title: `${title} · вариант ${v === 'a' ? 'А' : 'Б'}` })))

// The platform's script inside a frame (the bridge of Ар29): it only reports "ready" and the height.
const BRIDGE = `<script>(()=>{let last=0;const send=(t)=>{const h=Math.ceil(document.documentElement.scrollHeight);if(t==='h'&&h===last)return;last=h;parent.postMessage({raditi:'frame',t,h},'*')};addEventListener('load',()=>{send('ready');new ResizeObserver(()=>send('h')).observe(document.documentElement)})})()</script>`
const BUSY = '<script>setInterval(()=>{const t=performance.now();while(performance.now()-t<150){}},300)</script>'

function mockupHtml(token) {
  const busy = token === 'busy'
  const t = busy ? 'm1-a' : token
  const m = /^(m[1-5])-([ab])$/.exec(t)
  if (!m) return null
  let html = fs.readFileSync(path.join(here, 'mockups', `${m[1]}.html`), 'utf8')
  if (m[2] === 'b') html = html.replace('<body>', '<body class="variant-b">')
  html = html.replace('</body>', `${BRIDGE}${busy ? BUSY : ''}</body>`)
  return html
}

function framePolicy(ancestors) {
  return [
    'sandbox allow-scripts',
    "script-src 'unsafe-inline'",
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    `frame-ancestors ${ancestors.join(' ')}`,
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
  ].join('; ')
}

const common = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

function sendFile(res, file, headers = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': buf.length, ...headers })
    res.end(buf)
  })
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.keepAliveTimeout = 30_000
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

export async function startServers({ dist = path.join(here, 'dist'), thumbs = path.join(here, 'thumbs') } = {}) {
  const stats = { frameDocs: 0, frameFiles: 0, frameFileBytes: 0 }
  let ancestors = []
  const frames = await listen((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.startsWith('/v/')) {
      const html = mockupHtml(decodeURIComponent(url.pathname.slice(3)))
      if (!html) { res.writeHead(404); res.end(); return }
      stats.frameDocs++
      const buf = Buffer.from(html)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': framePolicy(ancestors), ...common })
      res.end(buf)
      return
    }
    if (url.pathname.startsWith('/_files/')) {
      const name = path.basename(url.pathname)
      const file = path.join(here, 'frames', 'files', name)
      stats.frameFiles++
      try { stats.frameFileBytes += fs.statSync(file).size } catch {}
      sendFile(res, file, { 'Cache-Control': 'private, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin', ...common })
      return
    }
    res.writeHead(404); res.end()
  })
  const cabinet = await listen((req, res) => {
    const url = new URL(req.url, 'http://x')
    let p = decodeURIComponent(url.pathname)
    if (p.startsWith('/thumbs/') || p === '/screens.json') {
      const file = p === '/screens.json' ? path.join(thumbs, 'screens.json') : path.join(thumbs, path.basename(p))
      sendFile(res, file, { 'Cache-Control': p === '/screens.json' ? 'no-cache' : 'max-age=3600' })
      return
    }
    if (p === '/' || !path.extname(p)) p = '/index.html'
    const file = path.join(dist, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
    sendFile(res, file, { 'Cache-Control': 'no-cache' })
  })
  const cp = cabinet.address().port
  const fp = frames.address().port
  ancestors = [`http://cabinet.example.com:${cp}`, `http://127.0.0.1:${cp}`, `http://localhost:${cp}`]
  return {
    cabinetPort: cp,
    framesPort: fp,
    stats,
    origins: {
      cabinet: `http://cabinet.example.com:${cp}`,
      sameSite: `http://pages.example.com:${fp}`,
      crossSite: `http://frames.example.net:${fp}`,
      cabinetLocal: `http://127.0.0.1:${cp}`,
      framesLocal: `http://localhost:${fp}`,
      framesLoopback: `http://127.0.0.1:${fp}`,
    },
    close: () => Promise.all([new Promise((r) => cabinet.close(r)), new Promise((r) => frames.close(r))]),
  }
}

// The flags that map the test hosts to 127.0.0.1 inside Chromium.
export const HOST_RULES = '--host-resolver-rules=MAP *.example.com 127.0.0.1, MAP *.example.net 127.0.0.1'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServers()
  console.log(JSON.stringify(s.origins, null, 2))
}
