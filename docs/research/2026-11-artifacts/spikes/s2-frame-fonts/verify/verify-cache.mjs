// The cache claim of spike s2, checked a second way: a library with
// `Cache-Control: public, max-age=31536000, immutable` (script, module with an import, font) in
// three frames of one cabinet page — one after another and all at once — and the same page opened
// a second time in the same context. Counts how often the server gave each file.
//   node verify-cache.mjs --platform macos --engines chromium,chromium-shell,webkit
import { createRequire } from 'node:module'
import { loadavg } from 'node:os'
import { chromium, firefox, webkit } from 'playwright-core'
import { startStand, APP } from './vstand.mjs'

const require = createRequire(import.meta.url)
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const ENGINES = {
  chromium: [chromium, { channel: 'chromium', headless: true }],
  'chromium-shell': [chromium, { headless: true }],
  webkit: [webkit, { headless: true }],
  firefox: [firefox, { headless: true }],
}
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
let n = 0
for (const id of arg('engines', 'chromium,webkit').split(',')) {
  const [type, options] = ENGINES[id]
  const browser = await type.launch({ ...options, proxy: { server: `http://127.0.0.1:${stand.proxyPort}` } })
  const lines = []
  for (const s of ['http', 'https']) {
    for (const [sandbox, mode] of [['art', 'seq'], ['art', 'par'], ['none', 'seq']]) {
      const run = `K${(++n).toString(36)}${Date.now().toString(36).slice(-5)}`
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      const counts = []
      let ok = []
      for (const open of [1, 2]) {
        const mark = stand.log.length
        await page.goto(`${s}://${APP}/cache?sandbox=${sandbox}&mode=${mode}&n=3&run=${run}`)
        await page.waitForFunction(() => self.__done.length >= 3, null, { timeout: 60_000 })
        ok.push((await page.evaluate(() => self.__done)).map((d) => `${d.js}${d.mod}${d.font === 'loaded' ? 'F' : 'x'}`).join(''))
        const hits = stand.log.slice(mark).filter((e) => e.path.includes(run) && /\/v\/(js|mod|leaf|font)-/.test(e.path))
        const per = {}
        for (const e of hits) per[e.path.split('-')[0].slice(3)] = (per[e.path.split('-')[0].slice(3)] ?? 0) + 1
        counts.push(`open ${open}: ${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(', ')}`)
      }
      await context.close()
      lines.push(`${s} ${sandbox} ${mode}: ${counts.join(' | ')} (frames: ${ok.join(' / ')})`)
    }
  }
  console.log(`== ${id} ${browser.version()} load ${loadavg().map((x) => x.toFixed(1)).join(' ')}`)
  for (const l of lines) console.log('   ' + l)
  await browser.close()
}
setTimeout(() => process.exit(0), 3000).unref()
await stand.close()
