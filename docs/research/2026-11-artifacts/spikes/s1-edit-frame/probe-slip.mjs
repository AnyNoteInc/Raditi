// «allow-scripts» slipped into the attribute of the edit frame, the route still sends the edit policy
// (CSP `sandbox allow-same-origin`, `script-src 'none'`). Does anything of the artifact run or navigate?
// node probe-slip.mjs chromium,webkit[,firefox]
import { chromium, webkit, firefox } from 'playwright-core'
import { startServers } from './server.mjs'
import * as corpus from './corpus.mjs'
const srv = await startServers()
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const out = {}
for (const name of (process.argv[2] ?? 'chromium,webkit').split(',')) {
  const b = await { chromium, webkit, firefox }[name].launch()
  const page = await (await b.newContext()).newPage()
  await page.goto(`${srv.cabOrigin}/cabinet`)
  const res = {}
  for (const [label, sandbox, kind] of [
    ['route, attribute without allow-scripts', 'allow-same-origin', 'src'],
    ['route, allow-scripts slipped into the attribute', 'allow-same-origin allow-scripts', 'src'],
    ['srcdoc + meta CSP, allow-scripts slipped into the attribute', 'allow-same-origin allow-scripts', 'srcdoc'],
  ]) {
    const t = `slip-${name}-${label.length}`
    const m = (o) => page.evaluate((x) => H.mount(x), { kind, sandbox, h: 'good', meta: true, ...o })
    await page.evaluate(() => H.resetRan())
    await m({ doc: 'vectors', t })
    await sleep(2500)
    const ran = await page.evaluate(() => H.ranAll())
    const hits = srv.hits.filter((h) => h.t === t && h.kind === 'hit').map((h) => h.v)
    const loads = srv.hits.filter((h) => h.t === t && (h.kind === 'load' || h.kind === 'probe')).map((h) => h.v)
    const t2 = `${t}-nav`
    await m({ doc: 'nav-meta-refresh', t: t2 })
    await sleep(2000)
    const st = await page.evaluate(() => H.state())
    const probe = st.artifact ? await page.evaluate(() => H.probeListeners()) : null
    await m({ doc: 'blank', t: `${t}-l` })
    const listeners = await page.evaluate(() => H.probeListeners())
    res[label] = { scriptsRan: [...new Set([...ran, ...hits])].length, externalLoads: loads.length, metaRefreshNavigated: !st.artifact || srv.hits.some((h) => h.t === t2 && h.v === 'meta-refresh'), listeners }
  }
  out[`${name} ${b.version()}`] = res
  await b.close()
}
console.log(JSON.stringify(out, null, 1))
await srv.close()
