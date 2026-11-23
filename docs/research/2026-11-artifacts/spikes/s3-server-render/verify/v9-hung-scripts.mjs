// Hung scripts the harness did not try (skeptic of spike s3, plan 88), and a prototype of the
// proposed §7.12 rule «while waiting for load, ping every 0.5 s; two pings without an answer —
// stop the script», which the README predicts at 1–1.5 s but the prototype never ran.
//   node v9-hung-scripts.mjs <harness dir>
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.argv[2]
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { stamp, DOC_URL } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, renderFrame, framePolicy } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)

const page = (script, where = 'end') => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Зависание</title></head><body><h1>Кадр с зависшим скриптом</h1><p>Абзац текста до скрипта.</p>${where === 'end' ? `<script>${script}</script>` : ''}<p>Абзац после.</p></body></html>`
const VARIANTS = {
  'loop while parsing (h2)': page('let i = 0; while (true) { i++ }'),
  'loop 50 ms after load': page("addEventListener('load', () => setTimeout(() => { while (true) {} }, 50))"),
  'loop in a later animation frame': page('let n = 0; requestAnimationFrame(function f() { if (++n > 5) { while (true) {} } requestAnimationFrame(f) })'),
  'endless microtasks': page('setTimeout(() => { const f = () => Promise.resolve().then(f); f() }, 20)'),
}
const frameOf = (name, html) => { const s = stamp(html); return { name, html: s.html, ids: s.ids, bugs: s.bugs, parents: s.parents } }

const { browser, server } = await launch(chromium)
const out = { harness: {}, pingPrototype: {} }
for (const [name, html] of Object.entries(VARIANTS)) {
  const t0 = performance.now()
  const r = await renderFrame(browser, frameOf(name, html), { width: 1440, assets: {}, outputs: { png: true } })
  const next = await renderFrame(browser, frameOf('next', page('/* fine */')), { width: 390, assets: {}, outputs: {} })
  out.harness[name] = { ms: Math.round(performance.now() - t0 - (next.t.total || 0)), hung: r.hung, loadError: r.loadError || null, error: r.error || null, drawn: Boolean(r.sizes.png), textBlocks: r.map ? r.map.doc.textBlocks : null, steps: r.t, nextOk: !next.error && Boolean(next.map) }
}

// The proposed rule, alone: commit, isolated world, then ping it every 500 ms while load is awaited.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
for (const name of ['loop while parsing (h2)', 'loop 50 ms after load']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route('**/*', (route) => route.request().url() === DOC_URL ? route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': framePolicy() }, body: frameOf(name, VARIANTS[name]).html }) : route.abort())
  const p = await ctx.newPage()
  const cdp = await ctx.newCDPSession(p)
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const t0 = performance.now()
  await p.goto(DOC_URL, { waitUntil: 'commit' })
  let world = null
  let stoppedAt = null
  let how = null
  try { world = await withTimeout(cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'ping' }), 1500) } catch { /* held at its start */ }
  if (!world) { await cdp.send('Runtime.terminateExecution'); stoppedAt = performance.now() - t0; how = 'world not created in 1.5 s'; world = await withTimeout(cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'ping' }), 2000) }
  let misses = 0
  let complete = false
  const deadline = t0 + 3000
  while (!stoppedAt && performance.now() < deadline) {
    const started = performance.now()
    const answer = await withTimeout(cdp.send('Runtime.evaluate', { expression: 'document.readyState', contextId: world.executionContextId, returnByValue: true }), 500).catch(() => null)
    if (answer) { misses = 0; if (answer.result.value === 'complete') complete = true } else if (++misses >= 2) { await cdp.send('Runtime.terminateExecution'); stoppedAt = performance.now() - t0; how = 'two pings without an answer'; break }
    if (complete && !stoppedAt) { /* load reached: the real pipeline would go on to settle; keep pinging to catch a late loop */ }
    const rest = 500 - (performance.now() - started)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
  }
  const after = await withTimeout(cdp.send('Runtime.evaluate', { expression: 'document.body.innerText.length', contextId: world.executionContextId, returnByValue: true }), 1000).then((a) => a.result.value).catch(() => 'no answer')
  out.pingPrototype[name] = { stoppedAtMs: stoppedAt && Math.round(stoppedAt), how, loadReached: complete, bodyTextAfter: after }
  await ctx.close()
}
await browser.close(); await server.close()
console.log(JSON.stringify(out, null, 1))
