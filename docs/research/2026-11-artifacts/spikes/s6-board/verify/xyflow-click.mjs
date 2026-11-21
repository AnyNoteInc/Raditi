// @xyflow/react 13.0.2: does onNodeDoubleClick fire on a node without onNodeClick, and what pointer-events
// does the node get? The spike's build (../dist) against a build of a copy where the onNodeClick line of
// src/board-b.jsx is deleted: NOCLICK_DIST=<absolute path of that copy's dist/> node xyflow-click.mjs
import { startServers } from '../server.mjs'
import { launchChromium, LAPTOP, boardUrl, openBoard, sleep } from '../lib.mjs'
for (const [label, dist] of [['с onNodeClick (сборка спайка)', new URL('../dist', import.meta.url).pathname], ['без onNodeClick', process.env.NOCLICK_DIST]]) {
  if (!dist) { console.log('NOCLICK_DIST is not set'); continue }
  const s = await startServers({ dist, thumbs: new URL('../thumbs', import.meta.url).pathname })
  const browser = await launchChromium()
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(s.origins.cabinet, { impl: 'b', live: 2, pe: 'shield', frames: s.origins.sameSite }))
  await page.evaluate(() => { const b = window.__board, f = b.frames.find((x) => x.id === 'm1-a@1440'), r = b.rect(); b.setViewport({ zoom: 0.35, x: r.w / 2 - (f.x + f.w / 2) * 0.35, y: r.h / 2 - (f.y + 700) * 0.35 }) })
  await sleep(500)
  const info = await page.evaluate(() => { const n = document.querySelector('.react-flow__node[data-id="m1-a@1440"]'); const r = n.getBoundingClientRect(); return { pe: getComputedStyle(n).pointerEvents, x: r.left + r.width / 2, y: Math.min(r.top + 300, innerHeight - 100) } })
  await page.mouse.dblclick(info.x, info.y); await sleep(400)
  console.log(JSON.stringify({ build: label, nodePointerEvents: info.pe, opened: await page.evaluate(() => window.__board.focused()) }))
  await browser.close(); await s.close()
}
