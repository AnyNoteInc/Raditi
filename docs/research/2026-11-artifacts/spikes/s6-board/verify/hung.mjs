// A hung frame (endless loop) on the board: does the cabinet's page keep painting? Per engine; the frame
// host is the same site as the cabinet (127.0.0.1, another port) and, in Firefox, also another site (localhost).
import { start } from './vserver.mjs'
const pw = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const engine of (process.argv[2] ?? 'webkit').split(',')) {
  for (const host of ['127.0.0.1', 'localhost']) {
    const browser = engine === 'chromium' ? await pw.chromium.launch({ channel: 'chromium' }) : await pw[engine].launch()
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
    await page.goto(`http://127.0.0.1:${srv.cp}/busy.html?${new URLSearchParams({ fo: `http://${host}:${srv.fp}`, busy: 'loop' })}`)
    await sleep(1500)
    const r = await Promise.race([page.evaluate(() => window.__phase('idle', 1500)), sleep(6000).then(() => ({ hung: true }))])
    console.log(JSON.stringify({ engine: `${engine} ${process.platform}`, frameHost: host === '127.0.0.1' ? 'тот же сайт' : 'другой сайт', cabinet: r }))
    await Promise.race([browser.close(), sleep(5000)]).catch(() => {})
  }
}
await srv.close(); process.exit(0)
