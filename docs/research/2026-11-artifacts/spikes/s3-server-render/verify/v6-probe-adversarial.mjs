// Adversarial check of the layout probe (spike s3, plan 88): the README says the isolated world
// protects the probe «by design, not tested adversarially». Frames here try to fool it.
//   node v6-probe-adversarial.mjs <harness dir>
// Uses the harness's own stamper and render pipeline on new frames: a page script that patches
// the measuring functions of its world, one that moves and copies the stamped ids, and one that
// draws itself differently for the renderer (navigator.webdriver).
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.argv[2]
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { stamp } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, renderFrame } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)
const { layoutReport } = await import(pathToFileURL(join(dir, 'lib/report.mjs')).href)

const BASE = (script) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Проверка зонда</title>
<style>body { margin: 0; font: 16px/1.5 sans-serif; color: #222; background: #fff } .wide { width: 600px; height: 40px; background: #90caf9 } .tiny { font-size: 9px } h1 { margin: 16px }</style></head>
<body><h1 class="title">Заголовок</h1><div class="wide">Широкий блок шириной 600 px</div><p class="tiny">Мелкая сноска девять пикселей для проверки</p><p class="plain">Обычный абзац текста страницы.</p>
<script>${script}</script></body></html>`
const frames = {
  control: BASE('/* nothing */'),
  patcher: BASE(`
    const fake = () => ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })
    Element.prototype.getBoundingClientRect = fake
    Range.prototype.getClientRects = () => [fake()]
    const real = window.getComputedStyle
    window.getComputedStyle = (el) => new Proxy(real(el), { get: (t, k) => (k === 'fontSize' ? '40px' : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
    Document.prototype.elementsFromPoint = () => []
    Object.defineProperty(Element.prototype, 'scrollWidth', { get: () => 10 })`),
  thief: BASE(`
    const ids = [...document.querySelectorAll('[data-raditi-id]')]
    const title = document.querySelector('h1').getAttribute('data-raditi-id')
    // The wide block now carries the title's id; every paragraph carries it too.
    document.querySelector('.wide').setAttribute('data-raditi-id', title)
    for (const p of document.querySelectorAll('p')) p.setAttribute('data-raditi-id', title)
    document.querySelector('h1').removeAttribute('data-raditi-id')`),
  cloak: BASE(`
    if (navigator.webdriver || /Headless/.test(navigator.userAgent)) {
      document.querySelector('.wide').style.width = '100px'
      document.querySelector('.tiny').style.fontSize = '16px'
    }
    document.body.dataset.ua = navigator.userAgent.slice(0, 60) + ' webdriver=' + navigator.webdriver`),
}

const { browser, server } = await launch(chromium)
const out = {}
for (const [name, html] of Object.entries(frames)) {
  const s = stamp(html)
  const frame = { name, html: s.html, ids: s.ids, bugs: s.bugs, parents: s.parents }
  const r = await renderFrame(browser, frame, { width: 390, assets: {}, outputs: {}, extract: 'body' })
  const issues = (r.map ? r.map.issues : []).map((i) => ({ kind: i.kind, id: i.id || null, tag: i.tag || null, px: i.px, culprits: i.culprits && i.culprits.map((c) => `${c.id} ${c.tag} ${c.width}`) }))
  const ids = r.map ? r.map.rects.map((x) => x[0]) : []
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
  out[name] = { error: r.error || null, issues, rects: ids.length, duplicateIds: [...new Set(dup)], stampedIds: s.ids, report: layoutReport({ name, title: 'Проверка зонда', byWidth: { 390: r } }).text.split('\n').slice(1, 5) }
}
// What the renderer looks like to the page.
const ctx = await browser.newContext()
const page = await ctx.newPage()
out.rendererSeenAs = await page.evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent, coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches }))
await ctx.close()
await browser.close(); await server.close()
console.log(JSON.stringify(out, null, 1))
