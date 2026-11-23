// srcdoc without a meta policy inherits the cabinet's policy: which nested <iframe src> does it load?
import { chromium, webkit, firefox } from 'playwright-core'
import { startServers } from './vserver.mjs'
const srv = await startServers()
const out = {}
for (const name of (process.argv[2] ?? 'chromium,webkit').split(',')) {
  const b = await { chromium, webkit, firefox }[name].launch()
  const page = await (await b.newContext()).newPage()
  await page.goto(`${srv.CAB}/cab`)
  const t = `${name}-n`
  await page.evaluate(({ html }) => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-same-origin')
    f.srcdoc = html
    document.getElementById('host').appendChild(f)
  }, { html: `<!doctype html><p>x</p><iframe src="${srv.FOREIGN}/nav?v=${t}-foreign"></iframe><iframe src="${srv.PAGES}/nav?v=${t}-pages"></iframe>` })
  await new Promise((ok) => setTimeout(ok, 2500))
  out[`${name} ${b.version()}`] = { foreign: srv.log.some((r) => r.v === `${t}-foreign`), pages: srv.log.some((r) => r.v === `${t}-pages`) }
  await b.close()
}
console.log(JSON.stringify(out))
await srv.close()
