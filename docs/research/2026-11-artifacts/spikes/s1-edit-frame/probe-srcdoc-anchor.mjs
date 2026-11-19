// Product check (read-only): the cabinet shows a page for reading in <iframe srcDoc sandbox="allow-popups
// allow-popups-to-escape-sandbox"> (agent-document.tsx). Does a click on its in-page anchor or on a link
// from the root (treeLinks) keep the frame, or send it to the cabinet's address? And does an anchor written
// as `about:srcdoc#…` stay? The frame is opaque, so the link sits at a known place and the check is the
// frame's address only.  node probe-srcdoc-anchor.mjs chromium,webkit,firefox
import { chromium, webkit, firefox } from 'playwright-core'
import { startServers } from './server.mjs'
const srv = await startServers()
const page = (href) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title>` +
  `<style>body{margin:0}a.l{position:absolute;left:0;top:0;width:300px;height:40px;display:block;background:#eee}</style></head>` +
  `<body><main><article><a class="l" href="${href}">ссылка</a><div style="height:1500px"></div><h2 id="doc-razdel">Раздел</h2></article></main></body></html>`
const cases = [
  ['anchor #doc-razdel', '#doc-razdel'],
  ['link from the root /uslugi/remont', '/uslugi/remont'],
  ['anchor about:srcdoc#doc-razdel', 'about:srcdoc#doc-razdel'],
]
const out = {}
for (const name of (process.argv[2] ?? 'chromium,webkit').split(',')) {
  const b = await { chromium, webkit, firefox }[name].launch()
  const p = await (await b.newContext()).newPage()
  await p.goto(`${srv.cabOrigin}/cabinet`)
  for (const [label, href] of cases) {
    await p.evaluate((html) => {
      const s = document.getElementById('stage')
      s.textContent = ''
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
      f.width = '600'
      f.height = '400'
      f.srcdoc = html
      s.appendChild(f)
      return new Promise((ok) => f.addEventListener('load', ok, { once: true }))
    }, page(href))
    const box = await p.evaluate(() => {
      const f = document.querySelector('#stage iframe')
      const r = f.getBoundingClientRect()
      return { x: r.left + f.clientLeft, y: r.top + f.clientTop }
    })
    await p.mouse.click(box.x + 20, box.y + 20)
    await p.waitForTimeout(1200)
    const url = p.frames()[1]?.url() ?? '(no frame)'
    out[`${name} ${b.version()} | ${label}`] = url.replace(srv.cabOrigin, '<cabinet>')
  }
  await b.close()
}
console.log(JSON.stringify(out, null, 1))
await srv.close()
