// An independent test server of the s6 verification (not the spike's server.mjs). Runs from verify/ inside
// the spike's folder: photos come from ../frames/files (made by ../assets.mjs), the mockup m1 from ../mockups.
// Two ports on 127.0.0.1 (or 0.0.0.0 inside a container): the "cabinet" serves pages/*.html,
// the "frame host" serves frames/*.html with the headers of a framed artifact page:
// CSP sandbox allow-scripts (like ARTIFACT_SANDBOX), no network, frame-ancestors *.
// ?nocsp=1 drops the CSP sandbox (a control for the process test).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function policy() {
  return ["sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'none'", 'frame-ancestors *'].join('; ')
}

// the platform bridge of the spike (server.mjs): "ready" and the height by postMessage
const BRIDGE = `<script>(()=>{let last=0;const send=(t)=>{const h=Math.ceil(document.documentElement.scrollHeight);if(t==='h'&&h===last)return;last=h;parent.postMessage({raditi:'frame',t,h},'*')};addEventListener('load',()=>{send('ready');new ResizeObserver(()=>send('h')).observe(document.documentElement)})})()</script>`

function listen(host, handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, host, () => resolve(s)) })
}

export async function start({ host = '127.0.0.1' } = {}) {
  const send = (res, file, headers) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
      res.end(buf)
    })
  }
  const cabinet = await listen(host, (req, res) => {
    const u = new URL(req.url, 'http://x')
    send(res, path.join(here, 'pages', path.basename(u.pathname)), {})
  })
  const frames = await listen(host, (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname.startsWith('/_files/')) {
      // photos of the mockups (made by the spike's assets.mjs)
      fs.readFile(path.join(here, '..', 'frames', 'files', path.basename(u.pathname)), (err, buf) => {
        if (err) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'max-age=300' }); res.end(buf)
      })
      return
    }
    // hx=<list>: add the spike's own frame headers one by one (to bisect a WebKit difference)
    const hx = (u.searchParams.get('hx') ?? '').split(',').filter(Boolean)
    const extra = {}
    if (hx.includes('nosniff')) extra['X-Content-Type-Options'] = 'nosniff'
    if (hx.includes('ref')) extra['Referrer-Policy'] = 'no-referrer'
    if (hx.includes('robots')) extra['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    let csp = policy()
    if (hx.includes('fullcsp')) csp = ['sandbox allow-scripts', "script-src 'unsafe-inline'", "default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data: blob:", "media-src 'self' data: blob:", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", 'frame-ancestors *', "object-src 'none'", "worker-src 'none'", "manifest-src 'none'", "base-uri 'none'"].join('; ')
    if (hx.includes('fa')) csp = csp.replace('frame-ancestors *', `frame-ancestors http://127.0.0.1:${cabinet.address().port} http://localhost:${cabinet.address().port}`)
    const name = path.basename(u.pathname)
    const file = path.join(here, 'frames', name)
    // frames made on the fly: the spike's mockup m1 with its bridge and no wheel listener (m1-orig), and my
    // tall frame without its wheel listener (tall-nowl) — a wheel listener in the frame hides the WebKit bug
    if (name === 'm1-orig.html' || name === 'tall-nowl.html') {
      const html = name === 'm1-orig.html'
        ? fs.readFileSync(path.join(here, '..', 'mockups', 'm1.html'), 'utf8').replace('</body>', `${BRIDGE}</body>`)
        : fs.readFileSync(path.join(here, 'frames', 'tall.html'), 'utf8').replace("addEventListener('wheel', (e) => post('wheel', { ctrl: e.ctrlKey }), { passive: true })", '')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, ...extra }); res.end(html)
      return
    }
    if (hx.includes('len')) {
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, ...extra }); res.end(buf)
      })
      return
    }
    send(res, file, u.searchParams.get('nocsp') === '1' ? extra : { 'Content-Security-Policy': csp, ...extra })
  })
  return {
    cp: cabinet.address().port,
    fp: frames.address().port,
    close: () => Promise.all([new Promise((r) => cabinet.close(r)), new Promise((r) => frames.close(r))]),
  }
}

export const HOST_RULES = '--host-resolver-rules=MAP *.example.com 127.0.0.1, MAP *.example.net 127.0.0.1'
