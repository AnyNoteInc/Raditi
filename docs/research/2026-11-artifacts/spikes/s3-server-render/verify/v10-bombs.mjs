// Hostile frames beyond the harness (skeptic of spike s3, plan 88):
//   dom     — a script builds 150 000 elements: is the render still bounded by its limits?
//   beside  — a memory bomb (ArrayBuffers) renders beside a normal frame in the same browser, as
//             «2 renders per container» would run them: does the neighbour survive? (Docker only:
//             without a cgroup the bomb just takes the machine's memory.)
//   node v10-bombs.mjs <harness dir> dom|beside
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, which] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { stamp, assembleFrame, ensureAssets } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, renderFrame } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)
const frameOf = (name, html) => { const s = stamp(html); return { name, html: s.html, ids: s.ids, bugs: s.bugs, parents: s.parents } }
const doc = (body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Бомба</title><style>body{margin:0;font:14px sans-serif} .c{padding:2px 8px;border-bottom:1px solid #eee}</style></head><body><h1>Кадр с бомбой</h1>${body}</body></html>`

const { browser, server } = await launch(chromium)
const out = { which }
if (which === 'dom') {
  const bomb = frameOf('dom', doc(`<div id="root"></div><script>const root = document.getElementById('root'); const f = document.createDocumentFragment(); for (let i = 0; i < ${Number(process.env.BOMB_N || 150000)}; i++) { const d = document.createElement('div'); d.className = 'c'; d.textContent = 'Строка ' + i + ' — позиция прайса'; f.appendChild(d) } root.appendChild(f)</script>`))
  const t0 = performance.now()
  const r = await renderFrame(browser, bomb, { width: 1440, assets: {}, outputs: { png: true, pdf: true, thumb: true } })
  out.dom = { ms: Math.round(performance.now() - t0), error: r.error || null, hung: r.hung, docH: r.map && r.map.doc.docH, elements: r.map && r.map.doc.elements, steps: r.t, sizes: r.sizes }
  const next = await renderFrame(browser, frameOf('next', doc('<p>Обычный кадр.</p>')), { width: 390, assets: {}, outputs: { png: true } })
  out.nextOk = !next.error && Boolean(next.map)
} else {
  const assets = await ensureAssets(browser)
  const bomb = assembleFrame('h4-memory', { assets, memory: 'buffers' })
  const normal = assembleFrame('10-one-page-site', { assets })
  const [a, b] = await Promise.all([
    renderFrame(browser, bomb, { width: 1440, assets, outputs: { png: true } }),
    renderFrame(browser, normal, { width: 390, assets, outputs: { png: true, pdf: true, thumb: true } }),
  ])
  out.bomb = { error: a.error || null, crashed: a.events.crashed, ms: a.t.total }
  out.neighbour = { error: b.error || null, crashed: b.events.crashed, ms: b.t.total, png: b.sizes.png || null, pdfPages: b.sizes.pdfPages || null, issues: b.map ? b.map.issues.length : null }
  out.browserConnected = browser.isConnected()
  const next = await renderFrame(browser, assembleFrame('09-faq-accordion', { assets }), { width: 390, assets, outputs: { png: true } })
  out.nextOk = !next.error && Boolean(next.map)
}
await browser.close().catch(() => {}); await server.close().catch(() => {})
console.log(JSON.stringify(out, null, 1))
