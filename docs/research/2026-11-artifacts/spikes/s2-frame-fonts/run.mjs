// The driver of spike s2: every engine × scheme × sandbox × CSP of the frame, the published
// sites of pages, a cache check of a content-addressed library and, in Chromium, the process of
// a sandboxed frame. Writes the raw results to results/<platform>-<engine>.json; report.mjs turns
// them into tables, check-pattern.mjs checks every frame cell against one rule.
//
//   node run.mjs [--engines chromium-shell,chromium,webkit,firefox,firefox-tcp] [--platform macos]
//                [--quick] [--only-sites s5]
// chromium-3pcb only inside the Linux container with the managed policy (README, «Как проверено»).
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, loadavg, platform as osPlatform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { chromium, firefox, webkit } from 'playwright-core'

import { CABINET, PAGES, SITES, XSITE, startStand } from './stand.mjs'
import { CSP_VARIANTS, HASH, SANDBOXES } from './variants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const quick = args.includes('--quick')
// --only-sites s5,s2: only these published sites, written to <platform>-<engine>.extra.json
const onlySites = option('only-sites', null)?.split(',') ?? null
const platformName = option('platform', osPlatform() === 'darwin' ? 'macos' : 'linux')

const ENGINES = {
  'chromium-shell': { type: chromium, launch: { headless: true } },
  chromium: { type: chromium, launch: { channel: 'chromium', headless: true } },
  webkit: { type: webkit, launch: { headless: true } },
  firefox: { type: firefox, launch: { headless: true } },
  // The cookie policy of a real Firefox, which Playwright relaxes: Total Cookie Protection is its
  // default (cookieBehavior 5), Playwright sets 0. Only the published sites differ. Chromium with
  // third-party cookies blocked could not be emulated here (README, «Не подтверждено»).
  'firefox-tcp': {
    type: firefox,
    launch: { headless: true, firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5 } },
    sitesOnly: true,
  },
  // Chromium with third-party cookies blocked: only in the Linux container, where the run writes
  // the managed policy {"BlockThirdPartyCookies": true} to /etc/opt/chrome_for_testing/policies/managed first
  // (README, «Как проверено»). Elsewhere it is plain Chromium and its results mean nothing.
  'chromium-3pcb': {
    type: chromium,
    launch: { channel: 'chromium', headless: true },
    sitesOnly: true,
  },
}
const engines = option('engines', 'chromium-shell,chromium,webkit,firefox,firefox-tcp').split(',')
const unknown = engines.filter((id) => !ENGINES[id])
if (unknown.length) throw new Error(`unknown engines: ${unknown.join(', ')}`)

const fontFile = require.resolve(
  '@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2',
)
const stand = await startStand({ certDir: join(here, 'certs'), fontFile })
const PASSWORD = 'секрет-е'

let counter = 0
const nextFid = (prefix) => `${prefix}${(++counter).toString(36)}${Date.now().toString(36).slice(-4)}`

function listen(page) {
  const out = { console: [], failed: [], responses: [] }
  page.on('console', (m) =>
    out.console.push({ type: m.type(), text: m.text(), url: m.location()?.url ?? '' }),
  )
  page.on('pageerror', (e) => out.console.push({ type: 'pageerror', text: String(e) }))
  page.on('requestfailed', (r) => out.failed.push({ url: r.url(), error: r.failure()?.errorText ?? '' }))
  page.on('response', (r) => out.responses.push({ url: r.url(), status: r.status() }))
  return out
}

async function iframeTargets(browser) {
  if (browser.browserType().name() !== 'chromium') return null
  const cdp = await browser.newBrowserCDPSession()
  try {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos
      .filter((t) => t.type === 'iframe')
      .map((t) => ({ url: t.url.replace(/[?#].*$/, '') }))
  } finally {
    await cdp.detach()
  }
}

async function frameRun(browser, scheme, sandbox, csp, { cached = false, count = 1 } = {}) {
  const fid = nextFid(cached ? 'K' : 'F')
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const seen = listen(page)
  const view = `/v/view-${sandbox}-${csp}-${fid}.${HASH}`
  const started = stand.log.length
  let results = null
  let error = null
  let oopif = null
  try {
    await page.goto(
      `${scheme}://${CABINET}/chat?view=${encodeURIComponent(view)}&sandbox=${sandbox}&n=${count}`,
    )
    await page.waitForFunction((n) => Object.keys(window.__results).length >= n, count, {
      timeout: 45_000,
    })
    results = await page.evaluate(() => window.__results)
    oopif = await iframeTargets(browser)
  } catch (e) {
    error = String(e).slice(0, 600)
    results = await page.evaluate(() => window.__results).catch(() => null)
  }
  const messages = await page.evaluate(() => window.__messages).catch(() => null)
  await context.close()
  const server = stand.log.slice(started).filter((entry) => entry.path.includes(fid))
  return { kind: 'frame', scheme, sandbox, csp, fid, cached, count, results, messages, oopif, error, ...seen, server }
}

/** Chromium only: is a sandboxed frame of the pages root in a process of its own (an OOPIF)? */
async function oopifRun(browser, scheme) {
  const a = `/v/view-art-c1-${nextFid('P')}.${HASH}`
  const c = `/v/view-none-c1-${nextFid('P')}.${HASH}`
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  let targets = null
  let error = null
  try {
    await page.goto(`${scheme}://${CABINET}/oopif?a=${encodeURIComponent(a)}&c=${encodeURIComponent(c)}`)
    await page.waitForFunction(() => Object.keys(window.__results).length >= 2, null, { timeout: 45_000 })
    targets = await iframeTargets(browser)
  } catch (e) {
    error = String(e).slice(0, 600)
  }
  await context.close()
  return { kind: 'oopif', scheme, sandboxed: a, unsandboxed: c, targets, error }
}

async function readResult(page) {
  for (let i = 0; i < 100; i++) {
    try {
      const result = await page.evaluate(() => window.__result ?? null)
      if (result) return result
    } catch {
      // a navigation is under way
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

async function siteRun(browser, scheme, slug) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const seen = listen(page)
  const host = `${slug}.${PAGES}`
  const started = stand.log.length
  let first = null
  let second = null
  let error = null
  try {
    await page.goto(`${scheme}://${host}/`)
    if (SITES[slug].password) {
      await page.fill('#password', PASSWORD)
      await page.click('button[type=submit]')
    }
    first = await readResult(page)
    await page.reload()
    second = await readResult(page)
  } catch (e) {
    error = String(e).slice(0, 600)
  }
  // After the password: another site embeds the files of this one in the same browser.
  let xssi = null
  if (scheme === 'https') {
    const mark = stand.log.length
    try {
      await page.goto(`${scheme}://${XSITE}/xssi?site=${slug}`)
      await page.waitForFunction(() => window.__xssi, null, { timeout: 20_000 })
      xssi = await page.evaluate(() => window.__xssi)
    } catch (e) {
      xssi = { error: String(e).slice(0, 300) }
    }
    xssi.server = stand.log
      .slice(mark)
      .filter((entry) => entry.host.startsWith(`${slug}.`))
      .map((entry) => ({ path: entry.path, status: entry.status, cookie: entry.cookie, site: entry.site, mode: entry.mode }))
  }
  const cookies = (await context.cookies().catch(() => [])).map((c) => ({
    name: c.name,
    domain: c.domain,
    sameSite: c.sameSite,
    secure: c.secure,
    partitionKey: c.partitionKey ?? null,
  }))
  await context.close()
  const server = stand.log.slice(started).filter((entry) => entry.host.startsWith(`${slug}.`))
  return { kind: 'site', scheme, slug, site: SITES[slug], first, second, xssi, cookies, error, ...seen, server }
}

mkdirSync(join(here, 'results'), { recursive: true })
for (const id of engines) {
  const engine = ENGINES[id]
  let browser
  try {
    browser = await engine.type.launch({
      ...engine.launch,
      proxy: { server: `http://127.0.0.1:${stand.proxyPort}` },
    })
  } catch (e) {
    console.log(`== ${id}: does not launch here: ${String(e).split('\n').slice(0, 6).join(' | ')}`)
    writeFileSync(
      join(here, 'results', `${platformName}-${id}.launch-failed.txt`),
      String(e).split('\n').slice(0, 12).join('\n'),
    )
    continue
  }
  const meta = {
    engine: id,
    browser: browser.browserType().name(),
    version: browser.version(),
    platform: platformName,
    os: `${osPlatform()} ${release()} ${arch()}`,
    playwright: require('playwright-core/package.json').version,
    node: process.version,
    fontBytes: stand.fontBytes,
    viewBytes: stand.viewBytes('Fexample'),
    startedAt: new Date().toISOString(),
    loadAtStart: loadavg().map((x) => x.toFixed(2)),
  }
  console.log(`== ${id} ${meta.version}`)
  const runs = []
  const sandboxes = Object.keys(SANDBOXES)
  const csps = Object.keys(CSP_VARIANTS)
  for (const scheme of onlySites ? ['https'] : ['https', 'http']) {
    for (const sandbox of engine.sitesOnly || onlySites ? [] : scheme === 'https' ? sandboxes : ['art', 'none']) {
      for (const csp of scheme === 'https' ? csps : ['c0', 'c1', 'c2', 'c3', 'c4']) {
        if (quick && !(csp === 'c1' || csp === 'c0')) continue
        const run = await frameRun(browser, scheme, sandbox, csp)
        runs.push(run)
        console.log(`  frame ${scheme} ${sandbox} ${csp}: ${run.error ? 'ERROR ' + run.error.slice(0, 120) : 'ok'}`)
      }
    }
    for (const slug of onlySites ?? (scheme === 'https' ? ['s1', 's3', 's2', 's4'] : ['s1', 's3'])) {
      const run = await siteRun(browser, scheme, slug)
      runs.push(run)
      console.log(`  site ${scheme} ${slug}: ${run.error ? 'ERROR ' + run.error.slice(0, 120) : 'ok'}`)
    }
  }
  if (!quick && !engine.sitesOnly && !onlySites) {
    for (const scheme of ['https', 'http']) {
      for (const [sandbox, csp] of [['art', 'c1'], ['art', 'c3'], ['none', 'c1']]) {
        const run = await frameRun(browser, scheme, sandbox, csp, { cached: true, count: 3 })
        runs.push(run)
        console.log(`  cache ${scheme} ${sandbox} ${csp} ×3: ${run.error ? 'ERROR ' + run.error.slice(0, 120) : 'ok'}`)
      }
    }
  }
  if (browser.browserType().name() === 'chromium' && !engine.sitesOnly && !onlySites) {
    for (const scheme of ['https', 'http']) {
      const run = await oopifRun(browser, scheme)
      runs.push(run)
      console.log(`  oopif ${scheme}: ${run.error ? 'ERROR ' + run.error.slice(0, 120) : JSON.stringify(run.targets)}`)
    }
  }
  await browser.close()
  meta.finishedAt = new Date().toISOString()
  meta.loadAtFinish = loadavg().map((x) => x.toFixed(2))
  writeFileSync(
    join(here, 'results', `${platformName}-${id}${onlySites ? '.extra' : ''}.json`),
    JSON.stringify({ meta, runs }, null, 1),
  )
}
writeFileSync(
  join(here, 'results', `${platformName}-refused${onlySites ? '.extra' : ''}.json`),
  JSON.stringify(stand.refused, null, 1),
)
console.log('refused by the proxy:', stand.refused.length, [...new Set(stand.refused)].slice(0, 20))
// A tunnel a browser left open must not keep the process: the results are written.
setTimeout(() => process.exit(0), 5000).unref()
await stand.close()
