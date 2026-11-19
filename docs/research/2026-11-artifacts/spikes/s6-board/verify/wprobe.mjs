// Chromium: what width and height does a 1440-wide sandboxed frame see at its load event — in its own
// process (default) and in the cabinet's — and do offscreen frames send a later correction?
import { start, HOST_RULES } from './vserver.mjs'
const { chromium } = await import(process.env.PWCORE ?? 'playwright-core')
const PW_DISABLED = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion']
const srv = await start()
for (const shared of [false, true]) for (let rep = 0; rep < 3; rep++) {
  const args = [HOST_RULES]; if (shared) args.push(`--disable-features=${[...PW_DISABLED, 'IsolateSandboxedIframes'].join(',')}`)
  const browser = await chromium.launch({ channel: 'chromium', args })
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage()
  await page.goto(`http://cabinet.example.com:${srv.cp}/wprobe.html?fo=http://pages.example.com:${srv.fp}`)
  await new Promise((r) => setTimeout(r, 2500))
  const m = await page.evaluate(() => window.__m)
  console.log(shared ? 'процесс кабинета' : 'свой процесс', rep, JSON.stringify(Object.entries(m).map(([i, v]) => `${i}: ${v.join(' ')}`)))
  await browser.close()
}
await srv.close()
