// Order of magnitude: the spike's board with 0 and 20 live frames, moved by the page itself (setViewport
// from requestAnimationFrame, no CDP input), 2 s of zoom and 2 s of pan; own process and the cabinet's.
import { startServers } from '../server.mjs'
import { launchChromium, webkit, LAPTOP, boardUrl, openBoard, sleep } from '../lib.mjs'
// ENGINE=webkit: the same in WebKit (its frames always share the cabinet's process); CASES='[{"live":20}]'
const here = new URL('../', import.meta.url).pathname
const s = await startServers({ dist: here + 'dist', thumbs: here + 'thumbs' })
for (const c of JSON.parse(process.env.CASES ?? '[{"live":0},{"live":20},{"live":20,"opts":{"disable":["IsolateSandboxedIframes"]}}]')) {
  const wk = process.env.ENGINE === 'webkit'
  const browser = wk ? await webkit.launch() : await launchChromium(c.opts ?? {})
  const page = await (await browser.newContext(LAPTOP)).newPage()
  await openBoard(page, boardUrl(wk ? s.origins.cabinetLocal : s.origins.cabinet, { impl: 'a', live: c.live, pe: 'shield', frames: wk ? s.origins.framesLoopback : s.origins.sameSite }), { timeout: 300000 })
  await sleep(1500)
  const out = await page.evaluate(async () => {
    const b = window.__board, v0 = b.getViewport(), r = b.rect()
    const run = (kind) => new Promise((done) => { const iv = []; let last = null; const t0 = performance.now()
      const loop = (t) => { if (last != null) iv.push(t - last); last = t
        const k = (t - t0) / 1000
        if (kind === 'zoom') { const z = v0.zoom * (1 + 2 * Math.sin(k * 2) ** 2); b.setViewport({ zoom: z, x: r.w / 2 - (r.w / 2 - v0.x) * z / v0.zoom, y: r.h / 2 - (r.h / 2 - v0.y) * z / v0.zoom }) }
        else b.setViewport({ zoom: v0.zoom, x: v0.x + 300 * Math.sin(k * 3), y: v0.y })
        if (t - t0 < 2000) requestAnimationFrame(loop); else { const s = [...iv].sort((a, b) => a - b); done({ kind, fps: Math.round(iv.length / 2 * 10) / 10, p95: Math.round(s[Math.floor(0.95 * s.length)] * 10) / 10, max: Math.round(s.at(-1)) }) } }
      requestAnimationFrame(loop) })
    return [await run('zoom'), await run('pan')]
  })
  console.log(JSON.stringify({ engine: wk ? `webkit ${process.platform}` : 'chromium', live: c.live, proc: wk ? 'процесс кабинета (WebKit)' : c.opts ? 'процесс кабинета' : 'свой процесс', out }))
  await browser.close()
}
await s.close()
