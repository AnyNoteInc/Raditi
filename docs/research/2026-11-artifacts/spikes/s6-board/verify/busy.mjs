// Order-of-magnitude check of the busy-frame claims (not the spike's busy-split.mjs): my own page, the
// board moved by the page's own rAF (no CDP input), 2 s per phase.  node busy.mjs
import { start, HOST_RULES } from './vserver.mjs'
const { chromium } = await import(process.env.PWCORE ?? 'playwright-core')
const PW_DISABLED = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion']
const srv = await start()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const c of [
  { name: 'тяжёлая рамка, свой процесс', busy: 'split' },
  { name: 'тяжёлая рамка, свой процесс, скрыть при масштабе', busy: 'split', hz: '1' },
  { name: 'тяжёлая рамка, процесс кабинета', busy: 'split', shared: true },
  { name: 'без тяжёлой рамки, свой процесс', busy: 'none' },
  { name: 'зависшая рамка (бесконечный цикл), свой процесс', busy: 'loop' },
  { name: 'зависшая рамка (бесконечный цикл), процесс кабинета', busy: 'loop', shared: true },
]) {
  const args = [HOST_RULES]
  if (c.shared) args.push(`--disable-features=${[...PW_DISABLED, 'IsolateSandboxedIframes'].join(',')}`)
  const browser = await chromium.launch({ channel: 'chromium', args })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()
  await page.goto(`http://cabinet.example.com:${srv.cp}/busy.html?${new URLSearchParams({ fo: `http://pages.example.com:${srv.fp}`, busy: c.busy, ...(c.hz ? { hz: c.hz } : {}) })}`)
  await sleep(1500)
  const out = []
  for (const ph of ['idle', 'pan', 'zoom']) {
    const r = await Promise.race([page.evaluate(([n]) => window.__phase(n, 2000), [ph]), sleep(8000).then(() => ({ name: ph, hung: true }))])
    out.push(r)
  }
  console.log(c.name, JSON.stringify(out))
  await browser.close().catch(() => {})
}
await srv.close()
