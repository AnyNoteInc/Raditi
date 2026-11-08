import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const base = process.argv[2]
const b = await chromium.launch({ headless: true })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
await p.goto(`${base}/administrator/index.php`)
await p.fill('#mod-login-username', 'spikeadmin')
await p.fill('#mod-login-password', '<hidden>')
await p.click('#btn-login-submit')
await p.waitForURL(/administrator/)
await p.waitForLoadState('networkidle')
console.log('after login', p.url(), await p.title())
p.on('dialog', d => { console.log('dialog', d.message().slice(0, 100)); d.accept() })
await p.goto(`${base}/administrator/index.php?option=com_cpanel&view=cpanel`)
await p.waitForTimeout(1500)
const cancel = p.locator('.shepherd-cancel-icon').first()
if (await cancel.count()) { console.log('tour shown, cancelling'); await cancel.click() ; await p.waitForTimeout(500) }
const buttons = await p.locator('button.apply-sample-data, .sampledata-module button, [data-type]').all()
console.log('sample buttons', buttons.length)
const btn = p.locator('button.apply-sample-data[data-type="blog"], button[data-type="blog"]').first()
await btn.click()
await p.waitForTimeout(500)
const deadline = Date.now() + 120000
for (;;) {
  const text = await p.locator('.sampledata-steps-blog, .sampledata-progress-blog, [class*="sampledata"]').allInnerTexts()
  const joined = text.join(' | ').replace(/\s+/g, ' ')
  if (/finish|complet|success|заверш|всё готово/i.test(joined) && !/Step 1 of/.test(joined.slice(-20))) { console.log('done:', joined.slice(0, 400)); break }
  if (Date.now() > deadline) { console.log('timeout:', joined.slice(0, 800)); break }
  await p.waitForTimeout(1000)
}
await p.waitForTimeout(2000)
await b.close()
