// The process claim of spike s2, checked a second way (full Chromium in new headless, WebKit,
// Firefox as Playwright builds it and Firefox with cross-process frames on):
// 1) who freezes whom: a busy loop of 1.5 s in one frame, heartbeats of 20 ms everywhere else —
//    frames that share a renderer process share its main thread and stop beating;
// 2) renderer processes counted by `ps` under the browser's own pid (launchServer), not by CDP.
//   node verify-process.mjs [--engine chromium|webkit|firefox|firefox-fission]   (ps — Chromium only)
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { loadavg } from 'node:os'
import { chromium, firefox, webkit } from 'playwright-core'

// A small http stand of its own: the cabinet (app.example.test), the pages root and another site.
const beat = (name) => `<!doctype html><meta charset="utf-8"><script>
const NAME = ${JSON.stringify(name)}, beats = [];
setInterval(() => beats.push(Date.now()), 20);
addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.cmd === 'busy' && m.to === NAME) { const end = Date.now() + m.ms; while (Date.now() < end) {} }
  if (m.cmd === 'gap') {
    const inside = beats.filter((t) => t >= m.from - 300 && t <= m.until);
    let max = 0; for (let i = 1; i < inside.length; i++) max = Math.max(max, inside[i] - inside[i - 1]);
    (parent === self ? self : parent).postMessage({ tag: 'gap', name: NAME, max, n: inside.length }, '*');
  }
});
if (parent !== self) parent.postMessage({ tag: 'ready', name: NAME }, '*');
</script>`
const policy = (sandbox) => `${sandbox ? 'sandbox allow-scripts; ' : ''}script-src 'unsafe-inline'; default-src 'none'; frame-ancestors http://app.example.test`
const cabinet = (frames) => `<!doctype html><meta charset="utf-8"><body><script>
self.ready = []; self.gaps = {};
const NAME = 'cabinet', beats = [];
setInterval(() => beats.push(Date.now()), 20);
const frames = {};
addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.tag === 'ready') self.ready.push(m.name);
  if (m.tag === 'gap') self.gaps[m.name] = m.max;
  if (m.cmd === 'busy' && m.to === NAME) { const end = Date.now() + m.ms; while (Date.now() < end) {} }
  if (m.cmd === 'gap') { const inside = beats.filter((t) => t >= m.from - 300 && t <= m.until); let max = 0; for (let i = 1; i < inside.length; i++) max = Math.max(max, inside[i] - inside[i - 1]); self.gaps[NAME] = max; }
});
for (const [name, src, sandbox] of ${JSON.stringify(frames)}) {
  const f = document.createElement('iframe'); if (sandbox) f.setAttribute('sandbox', 'allow-scripts');
  f.src = src; f.style.cssText = 'width:200px;height:60px'; document.body.appendChild(f); frames[name] = f;
}
self.send = (msg) => { postMessage(msg, '*'); for (const f of Object.values(frames)) f.contentWindow.postMessage(msg, '*'); };
</script>`
const server = createServer((req, res) => {
  const host = String(req.headers.host).replace(/:\d+$/, '')
  const url = new URL(req.url, `http://${host}`)
  if (host === 'app.example.test' && url.pathname === '/') {
    const frames = JSON.parse(url.searchParams.get('f'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-src http://pages.example.test http://other.test", 'Cache-Control': 'no-store' })
    return res.end(cabinet(frames))
  }
  const m = /^\/v\/hb-([a-z0-9]+)-(s|n)\.f00d$/.exec(url.pathname)
  if (host === 'pages.example.test' && m) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy(m[2] === 's'), 'Cache-Control': 'no-store' })
    return res.end(beat(m[1]))
  }
  if (host === 'other.test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(beat(url.searchParams.get('n') ?? 'other'))
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const proxy = { server: `http://127.0.0.1:${port}` } // absolute-form requests go straight to the stand

const renderersUnder = (pid) => {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: +m[1], ppid: +m[2], cmd: m[3] } })
  const mine = new Set([pid])
  let grew = true
  while (grew) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true } }
  return rows.filter((r) => mine.has(r.pid) && /--type=renderer/.test(r.cmd)).length
}

const engineAt = process.argv.indexOf('--engine')
const engine = engineAt === -1 ? 'chromium' : process.argv[engineAt + 1]
// firefox-fission: the build of Playwright turns cross-process frames off
// (fission.webContentIsolationStrategy 0 in its playwright.cfg); 1 is the desktop Firefox default.
const type = { chromium, webkit, firefox, 'firefox-fission': firefox }[engine]
const extra = engine === 'firefox-fission' ? { firefoxUserPrefs: { 'fission.webContentIsolationStrategy': 1 } } : {}
async function withBrowser(fn) {
  const browserServer = await type.launchServer({ ...(engine === 'chromium' ? { channel: 'chromium' } : {}), ...extra, headless: true, proxy })
  const browser = await type.connect(browserServer.wsEndpoint())
  try { return await fn(browser, browserServer.process().pid) } finally { await browser.close(); await browserServer.close() }
}
const open = async (browser, frames) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`http://app.example.test/?f=${encodeURIComponent(JSON.stringify(frames))}`)
  await page.waitForFunction((k) => self.ready.length >= k, frames.length, { timeout: 30_000 })
  await page.waitForTimeout(700)
  return page
}
const sandboxed = (name) => [name, `http://pages.example.test/v/hb-${name}-s.f00d`, true]
const plain = (name) => [name, `http://pages.example.test/v/hb-${name}-n.f00d`, false]
const other = (name) => [name, `http://other.test/?n=${name}`, false]

console.log(`load ${loadavg().map((x) => x.toFixed(1)).join(' ')}`)
// 1) Who freezes whom.
await withBrowser(async (browser) => {
  console.log(`browser ${browser.version()}`)
  const page = await open(browser, [sandboxed('a'), sandboxed('b'), plain('c'), other('d')])
  for (const busy of ['a', 'c', 'cabinet', 'd']) {
    const from = Date.now()
    await page.evaluate(({ to, from }) => { self.gaps = {}; self.send({ cmd: 'busy', to, ms: 1500, from }) }, { to: busy, from })
    await page.waitForTimeout(2600)
    await page.evaluate(({ from, until }) => self.send({ cmd: 'gap', from, until }), { from, until: from + 2400 })
    await page.waitForFunction(() => Object.keys(self.gaps).length >= 5, null, { timeout: 10_000 })
    const gaps = await page.evaluate(() => self.gaps)
    console.log(`busy ${busy.padEnd(7)} → longest pause, ms: ${Object.entries(gaps).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  }
})
// 2) Renderer processes under the browser's pid.
for (const frames of engine !== 'chromium' ? [] : [[], [plain('c1'), plain('c2'), plain('c3')], [sandboxed('a1')], [sandboxed('a1'), sandboxed('a2'), sandboxed('a3')], Array.from({ length: 6 }, (_, i) => sandboxed(`s${i}`)), [other('d1')]]) {
  await withBrowser(async (browser, pid) => {
    await open(browser, frames)
    console.log(`frames ${JSON.stringify(frames.map(([n, , s]) => n + (s ? '(sandboxed)' : '')))}: renderer processes ${renderersUnder(pid)}`)
  })
}
server.close()
