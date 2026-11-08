// A guest buys in the OpenCart 3 storefront; the checkout accordion of the default theme.
import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const [base, product = 'iphone'] = process.argv.slice(2)
const b = await chromium.launch({ headless: true })
const c = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await c.newPage()
const bad = []
p.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) bad.push(`${r.status()} ${r.url().replace(base, '').slice(0, 80)}`) })
await p.goto(`${base}/${product}`, { waitUntil: 'load' }); console.log('product:', await p.title())
await p.click('#button-cart'); await p.waitForTimeout(1500)
console.log('alert:', (await p.locator('.alert').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 120))
await p.goto(`${base}/index.php?route=checkout/checkout`, { waitUntil: 'load' }); await p.waitForTimeout(1500)
console.log('checkout:', await p.title(), p.url().replace(base, ''))
await p.locator('input[name=account][value=guest]').check().catch(() => {})
await p.click('#button-account'); await p.waitForTimeout(1500)
const f = async (s, v) => p.locator(s).first().fill(v)
await f('#input-payment-firstname', 'Иван'); await f('#input-payment-lastname', 'Тестов'); await f('#input-payment-email', 'buyer@example.test'); await f('#input-payment-telephone', '+70000000000'); await f('#input-payment-address-1', 'ул. Синтетическая, 1'); await f('#input-payment-city', 'Москва'); await f('#input-payment-postcode', '101000')
await p.selectOption('#input-payment-country', { label: 'United Kingdom' }); await p.waitForTimeout(1200); await p.selectOption('#input-payment-zone', { index: 1 })
await p.click('#button-guest'); await p.waitForTimeout(1500)
console.log('after guest:', (await p.locator('.text-danger, .alert').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 200))
if (await p.locator('#button-shipping-method').count()) { await p.click('#button-shipping-method'); await p.waitForTimeout(1500) }
console.log('payment step:', (await p.locator('#collapse-payment-method').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200))
await p.locator('input[name=agree]').check().catch(() => {})
if (await p.locator('#button-payment-method').count()) { await p.click('#button-payment-method'); await p.waitForTimeout(1500) }
const confirm = p.locator('#button-confirm')
console.log('confirm', await confirm.count())
if (await confirm.count()) { await confirm.click(); await p.waitForTimeout(2500); console.log('after:', p.url().replace(base, '').slice(0, 70), await p.title()) }
console.log('bad:', [...new Set(bad)].slice(0, 8)); await b.close()
