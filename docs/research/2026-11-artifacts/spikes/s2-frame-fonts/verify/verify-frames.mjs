// Question A of spike s2, checked a second way (vstand.mjs): one frame per header variant, all at
// once; fonts by canvas measureText and FontFace.status; a static module with an import and a
// dynamic import(); controls of 'self' on a sibling host and on the cabinet. Prints the cells that
// break the spike's rule and writes everything to results-v/<platform>-<engine>-frames.json.
//   node verify-frames.mjs --platform macos --engines chromium,chromium-shell,webkit
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadavg } from 'node:os'
import { chromium, firefox, webkit } from 'playwright-core'
import { startStand, VARIANTS, APP, PAGES, SIB } from './vstand.mjs'

const require = createRequire(import.meta.url)
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const platform = arg('platform', process.platform === 'darwin' ? 'macos' : 'linux')
const ENGINES = {
  chromium: [chromium, { channel: 'chromium', headless: true }],
  'chromium-shell': [chromium, { headless: true }],
  webkit: [webkit, { headless: true }],
  firefox: [firefox, { headless: true }],
}
const HS = Object.keys(VARIANTS)
const CONFIGS = [
  ['https', 'art', 'today', ['h1']],
  ['https', 'art', 'self', HS],
  ['https', 'art', 'star', ['h1']],
  ['https', 'art', 'host', ['h1', 'h2', 'h4']],
  ['https', 'art', 'exact', ['h1', 'h2', 'h4']],
  ['https', 'page', 'self', ['h1', 'h2', 'h4']],
  ['https', 'none', 'self', HS],
  ['http', 'art', 'self', ['h1', 'h2', 'h4']],
  ['http', 'none', 'self', ['h1', 'h4']],
]
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
mkdirSync(new URL('./results-v', import.meta.url).pathname, { recursive: true })

const corsKinds = (family) => ['jsx', 'mod', 'dyn', ...(family === 'webkit' ? [] : ['font'])]
const expected = (family, sandbox, kind, h) => {
  if (sandbox === 'none') return true
  const [corp, acao] = VARIANTS[h]
  return corsKinds(family).includes(kind) ? acao === '*' : corp !== 'same-origin' && corp !== 'same-site'
}
const loadedOf = (r, kind, h) => ({
  font: r.fonts.V.status === 'loaded' && r.fonts.V.applied,
  css: r.boxes[`box-${h}`] === '23px',
  js: r.flags[`js-${h}`] === 1,
  jsx: r.flags[`jsx-${h}`] === 1,
  mod: r.flags[`mod-${h}`] === 1,
  dyn: r.flags[`dyn-${h}`] === 2,
  img: r.images.img === 5,
})[kind]

let n = 0
for (const id of arg('engines', 'chromium,webkit').split(',')) {
  const [type, options] = ENGINES[id]
  const browser = await type.launch({ ...options, proxy: { server: `http://127.0.0.1:${stand.proxyPort}` } })
  const family = browser.browserType().name()
  const out = { engine: id, version: browser.version(), platform, load: loadavg().map((x) => x.toFixed(1)).join(' '), runs: [] }
  let cells = 0
  const off = []
  for (const [s, sandbox, csp, hs] of CONFIGS) {
    const run = `R${(++n).toString(36)}${Date.now().toString(36).slice(-5)}`
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const consoleLines = []
    page.on('console', (m) => consoleLines.push(m.text()))
    page.on('requestfailed', (r) => consoleLines.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`))
    const mark = stand.log.length
    let got = null
    let error = null
    try {
      await page.goto(`${s}://${APP}/frames?csp=${csp}&sandbox=${sandbox}&run=${run}&hs=${hs.join(',')}`)
      await page.waitForFunction((k) => Object.keys(self.__got).length >= k, hs.length, { timeout: 60_000 })
      got = await page.evaluate(() => self.__got)
    } catch (e) {
      error = String(e).slice(0, 300)
      got = await page.evaluate(() => self.__got).catch(() => null)
    }
    await context.close()
    const server = stand.log.slice(mark).filter((e) => e.path.includes(run))
    out.runs.push({ s, sandbox, csp, hs, run, got, error, console: consoleLines, server })
    if (error) console.log(`${id} ${s} ${sandbox} ${csp}: ERROR ${error}`)
    if (!got) continue
    for (const h of hs) {
      const r = got[h]
      if (!r) { off.push(`${s} ${sandbox} ${csp} ${h}: no result`); continue }
      const allowed = csp !== 'today'
      for (const kind of ['font', 'css', 'js', 'jsx', 'mod', 'dyn', 'img']) {
        const want = allowed ? expected(family, sandbox, kind, h) : false
        const loaded = loadedOf(r, kind, h)
        cells++
        if (loaded !== want) off.push(`${s} ${sandbox} ${csp} ${h} ${kind}: loaded=${loaded} want=${want}`)
      }
    }
  }
  out.cells = cells
  out.off = off
  writeFileSync(new URL(`./results-v/${platform}-${id}-frames.json`, import.meta.url), JSON.stringify(out, null, 1))
  console.log(`== ${id} ${out.version} (${platform}, load ${out.load}): cells ${cells}, off the rule ${off.length}`)
  for (const line of off.slice(0, 30)) console.log('   ' + line)
  await browser.close()
}
console.log('refused:', [...new Set(stand.refused)].join(', ') || 'none')
setTimeout(() => process.exit(0), 3000).unref()
await stand.close()
