// Question B of spike s2, checked a second way (vstand.mjs, the product's own headers.ts,
// files.ts and page-cookie.ts): a published page with shared files — a font directly and from
// CSS, CSS, a classic script, a module, a dynamic import(), a picture — on a public site and on a
// site with a password, today and with Access-Control-Allow-Origin: *; then another site embeds
// the files of that site in the same browser.
//   node verify-sites.mjs --engines chromium,webkit [--label chromium-3pcb]
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium, firefox, webkit } from 'playwright-core'
import { startStand, SITES, PAGES, OTHER, PASSWORD } from './vstand.mjs'

const require = createRequire(import.meta.url)
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const platform = arg('platform', process.platform === 'darwin' ? 'macos' : 'linux')
const ENGINES = {
  chromium: [chromium, { channel: 'chromium', headless: true }],
  webkit: [webkit, { headless: true }],
  firefox: [firefox, { headless: true }],
  'firefox-tcp': [firefox, { headless: true, firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5 } }],
}
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
mkdirSync(new URL('./results-v', import.meta.url).pathname, { recursive: true })

const mark = (b) => (b ? '✓' : '✗')
const summary = (r) => r
  ? `Fdirect ${mark(r.fonts.Fdirect.status === 'loaded' && r.fonts.Fdirect.applied)} Fcss ${mark(r.fonts.Fcss.status === 'loaded' && r.fonts.Fcss.applied)} css ${mark(r.boxes.box === '23px')} js ${mark(r.flags.js === 1)} mod ${mark(r.flags.mod === 1)} dyn ${mark(r.flags.dyn === 2)} img ${mark(r.images.i === 5)} origin=${r.origin}`
  : 'no result'
const wait = async (page, what) => {
  for (let i = 0; i < 150; i++) {
    const v = await page.evaluate(what).catch(() => null)
    if (v) return v
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}
for (const id of arg('engines', 'chromium,webkit').split(',')) {
  const [type, options] = ENGINES[id]
  const label = arg('label', id)
  const browser = await type.launch({ ...options, proxy: { server: `http://127.0.0.1:${stand.proxyPort}` } })
  const out = { engine: label, version: browser.version(), platform, sites: [] }
  console.log(`== ${label} ${browser.version()} (${platform})`)
  for (const s of ['https', 'http']) {
    for (const slug of Object.keys(SITES)) {
      if (s === 'http' && SITES[slug].password) continue // a Secure cookie is never set over http
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      const host = `${slug}.${PAGES}`
      const at0 = stand.log.length
      await page.goto(`${s}://${host}/`)
      if (SITES[slug].password) {
        await page.fill('#p', PASSWORD)
        await Promise.all([page.waitForURL(`${s}://${host}/`), page.click('#go')])
      }
      const first = await wait(page, () => self.__result)
      const at1 = stand.log.length
      await page.reload()
      const second = await wait(page, () => self.__result)
      const at2 = stand.log.length
      let embed = null
      if (s === 'https') {
        await page.goto(`${s}://${OTHER}/embed?site=${slug}`)
        embed = await wait(page, () => self.__embed)
      }
      const at3 = stand.log.length
      await context.close()
      const files = (from, to) => stand.log.slice(from, to).filter((e) => e.host === host && e.path.startsWith('/_files/'))
      const line = (e) => `${e.path.slice(8)} ${e.status}${e.cookie ? ' c' : ''}${e.inm ? ' inm' : ''}`
      const firstFiles = files(at0, at1)
      const reloadFiles = files(at1, at2)
      const embedFiles = files(at2, at3)
      const referers = [...new Set(firstFiles.map((e) => e.referer ?? 'none'))]
      out.sites.push({ s, slug, first, second, embed, firstFiles, reloadFiles, embedFiles })
      console.log(`  ${s} ${slug.padEnd(6)} first: ${summary(first)}`)
      console.log(`  ${''.padEnd(s.length)} ${''.padEnd(6)} reload: ${summary(second)}; page ${stand.log.slice(at1, at2).find((e) => e.host === host && e.path === '/')?.status}; files on reload: ${reloadFiles.map(line).join(', ')}`)
      console.log(`  ${''.padEnd(s.length)} ${''.padEnd(6)} files first: ${firstFiles.map((e) => line(e) + ' ' + (e.mode ?? '-') + ' ' + JSON.stringify(e.origin)).join(', ')}; Referer: ${referers.join(', ')}`)
      if (embed) console.log(`  ${''.padEnd(s.length)} ${''.padEnd(6)} other site: script ${embed.script} secret ${embed.secret} box ${embed.box} img ${embed.img} | include: ${embed.include} | omit: ${embed.omit} | plain: ${embed.plain}; files: ${embedFiles.map(line).join(', ')}`)
    }
  }
  writeFileSync(new URL(`./results-v/${platform}-${label}-sites.json`, import.meta.url), JSON.stringify(out, null, 1))
  await browser.close()
}
console.log('methods seen:', [...new Set(stand.log.map((e) => e.method))].join(','))
setTimeout(() => process.exit(0), 3000).unref()
await stand.close()
