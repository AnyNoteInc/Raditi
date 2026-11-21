// write-excel-file under four policies: none, worker-src 'self' (the spike's strict one),
// script-src 'self' without worker-src (falls back to script-src), and worker-src 'self' blob:
// (the fix the report proposes). A positive control for the hang and for the fix.
//   node csp-worker.mjs [chromium|webkit|firefox] [--no-build]   (in Docker: firefox --no-build)
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import { serve } from './server.mjs'

// The page is built here, so this script is the whole step (Vite of the spike's node_modules).
if (process.argv[3] !== '--no-build') {
  const { build } = await import('vite')
  await build({ configFile: join(import.meta.dirname, 'csp', 'vite.config.mjs') })
}

const which = process.argv[2] ?? 'chromium'
const type = { chromium, firefox, webkit }[which]
const server = await serve(join(import.meta.dirname, 'csp', 'dist'))
const browser = await type.launch()
console.log(`${which} ${browser.version()}`)
for (const policy of ['', 'workerSelf', 'scriptOnly', 'workerBlob']) {
  const line = []
  for (const n of [300, 800, 900, 1000, 5000]) {
    const page = await browser.newPage()
    await page.goto(`${server.origin}/?mycsp=${policy}`)
    await page.waitForFunction(() => window.ready === true)
    const r = await page.evaluate(
      (rows) => Promise.race([window.run(rows).then((x) => `${x.ms} ms, ${x.bytes} B`), new Promise((res) => setTimeout(() => res('no file in 6 s'), 6000))]),
      n,
    )
    const v = await page.evaluate(() => window.violations.join(','))
    line.push(`${n}: ${r}${v ? ` [violation: ${v}]` : ''}`)
    await page.close()
  }
  console.log(`  ${policy || 'no CSP'} — ${line.join('; ')}`)
}
await browser.close()
await server.close()
