// Which vector makes the WebKit process spin? Each vector alone, in a fresh page, with a deadline.
// node probe-wpe.mjs webkit control,route+sandbox
import { chromium, webkit, firefox } from 'playwright-core'
import { startServers } from './server.mjs'
import * as corpus from './corpus.mjs'
const [engine = 'webkit', labels = 'control'] = process.argv.slice(2)
const D = {
  control: { kind: 'src', sandbox: null, h: 'none' },
  'srcdoc+sandbox': { kind: 'srcdoc', sandbox: 'allow-same-origin', meta: false },
  'srcdoc+sandbox+meta': { kind: 'srcdoc', sandbox: 'allow-same-origin', meta: true },
  'route+sandbox': { kind: 'src', sandbox: 'allow-same-origin', h: 'good' },
}
const srv = await startServers()
const names = [...corpus.autoVectors('x', 'x'), ...corpus.networkVectors('x', 'x')].map(([n]) => n)
const deadline = (p, ms) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('DEADLINE'), ms))])
const out = {}
let browser = await { chromium, webkit, firefox }[engine].launch()
for (const label of labels.split(',')) {
  out[label] = {}
  for (const n of names) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${srv.cabOrigin}/cabinet`)
    const r = await deadline(page.evaluate((o) => H.mount(o), { ...D[label], doc: `one-${n}`, t: `wpe-${n}` }), 6000)
    await new Promise((ok) => setTimeout(ok, 600))
    const alive = await deadline(page.evaluate(() => 1 + 1), 3000)
    out[label][n] = r === 'DEADLINE' ? 'mount did not return' : alive === 'DEADLINE' ? 'PAGE HANGS' : 'ok'
    if (r === 'DEADLINE' || alive === 'DEADLINE') {
      await browser.close().catch(() => {})
      browser = await { chromium, webkit, firefox }[engine].launch()
    } else await ctx.close()
  }
}
await browser.close().catch(() => {})
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== 'ok'))])), null, 1))
await srv.close()
