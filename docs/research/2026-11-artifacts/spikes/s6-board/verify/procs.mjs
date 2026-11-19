// Independent check of the process model claims of s6 (not the spike's identify()/whichProcess()):
// my own page with N frames, counted three ways — out-of-process frame targets over CDP
// (Target.getTargets), renderer processes over CDP (SystemInfo.getProcessInfo) and renderer processes
// of the browser's own process tree from the OS (ps).   node procs.mjs
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { start, HOST_RULES } from './vserver.mjs'

const { chromium } = await import(process.env.PWCORE ?? 'playwright-core')
const srv = await start()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Playwright's own --disable-features list (checked against playwright-core 1.63.0); ours repeats it
const PW_DISABLED = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion']
const ps = () => execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }))
const browserPids = () => new Set(ps().filter((p) => /(Google Chrome for Testing|chrome-headless-shell)( --|$)/.test(p.cmd) && !/--type=/.test(p.cmd)).map((p) => p.pid))

const cab = `http://cabinet.example.com:${srv.cp}`
const same = `http://pages.example.com:${srv.fp}`, cross = `http://frames.example.net:${srv.fp}`
const cases = [
  { name: '0 рамок (основа)', n: 0, fo: same },
  { name: '6, тот же сайт, sandbox и CSP sandbox', n: 6, fo: same },
  { name: '20, тот же сайт, sandbox и CSP sandbox', n: 20, fo: same },
  { name: '6, тот же сайт, только CSP sandbox', n: 6, fo: same, attr: '0' },
  { name: '6, тот же сайт, только атрибут sandbox', n: 6, fo: same, nocsp: '1' },
  { name: '6, тот же сайт, без sandbox (контроль)', n: 6, fo: same, attr: '0', nocsp: '1' },
  { name: '6, другой сайт, sandbox', n: 6, fo: cross },
  { name: '6, тот же сайт, IsolateSandboxedIframes выключен', n: 6, fo: same, disable: ['IsolateSandboxedIframes'] },
  { name: '6, тот же сайт, --disable-site-isolation-trials', n: 6, fo: same, args: ['--disable-site-isolation-trials'] },
  { name: '6, другой сайт, --disable-site-isolation-trials', n: 6, fo: cross, args: ['--disable-site-isolation-trials'] },
  { name: '0 рамок, headless shell', n: 0, fo: same, shell: true },
  { name: '6, тот же сайт, sandbox, headless shell', n: 6, fo: same, shell: true },
]
const rows = []
for (const c of cases) {
  const before = browserPids()
  const args = [HOST_RULES, ...(c.args ?? [])]
  if (c.disable) args.push(`--disable-features=${[...PW_DISABLED, ...c.disable].join(',')}`)
  const browser = await chromium.launch(c.shell ? { args } : { channel: 'chromium', args })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const q = new URLSearchParams({ n: String(c.n), fo: c.fo, ...(c.attr ? { attr: c.attr } : {}), ...(c.nocsp ? { nocsp: c.nocsp } : {}) })
  await page.goto(`${cab}/procs.html?${q}`)
  await page.waitForFunction((n) => window.__loaded >= n, c.n, { timeout: 30000 })
  await sleep(1200)
  const bs = await browser.newBrowserCDPSession()
  await bs.send('Target.setDiscoverTargets', { discover: true })
  const t = (await bs.send('Target.getTargets')).targetInfos
  const info = (await bs.send('SystemInfo.getProcessInfo')).processInfo
  const main = [...browserPids()].filter((p) => !before.has(p))
  const all = ps()
  const kids = all.filter((p) => main.includes(p.ppid))
  const renderers = kids.filter((p) => /--type=renderer/.test(p.cmd))
  const row = {
    case: c.name, version: browser.version(), iframeTargets: t.filter((x) => x.type === 'iframe').length,
    cdpRenderers: info.filter((p) => p.type === 'renderer').length, osRenderers: renderers.length,
    osRendererFlags: renderers.map((p) => (/--extension-process/.test(p.cmd) ? 'ext' : /--webui/.test(p.cmd) ? 'webui' : 'r')).join(','),
  }
  rows.push(row); console.log(JSON.stringify(row))
  await browser.close()
}
await srv.close()
fs.mkdirSync('out', { recursive: true })
fs.writeFileSync('out/procs.json', JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))
