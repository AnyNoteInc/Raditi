// oc4-order.mjs <origin>: a guest buys a product in the storefront; prints every step.
import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const base = process.argv[2]
const b = await chromium.launch({ headless: true })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
const bad = []
p.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) bad.push(`${r.status()} ${r.url().replace(base, '')}`) })
p.on('response', async (r) => { if (/shipping_method|payment_method|confirm|cod/.test(r.url())) console.log('  xhr', r.url().replace(base, '').slice(0, 90), (await r.text().catch(() => '')).slice(0, 220)) })
p.on('pageerror', (e) => bad.push(`pageerror ${e.message.slice(0, 120)}`))
await p.goto(`${base}/en-gb/product/${process.argv[3] ?? 'iphone'}`, { waitUntil: 'load' })
console.log('product:', await p.title())
await p.click('#button-cart')
await p.waitForTimeout(1500)
console.log('alert:', (await p.locator('#alert .alert').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 160))
await p.goto(`${base}/index.php?route=checkout/checkout&language=en-gb`, { waitUntil: 'load' })
console.log('checkout:', await p.title(), p.url().replace(base, ''))
await p.waitForTimeout(800)
const guest = p.locator('#input-guest, input[value="0"][name="account"]')
if (await guest.count()) { await guest.first().check({ force: true }).catch(() => {}); await p.waitForTimeout(300) }
const set = async (s, v) => { const l = p.locator(s); if (await l.count()) await l.first().fill(v) }
await set('#input-firstname', 'Иван'); await set('#input-lastname', 'Тестов'); await set('#input-email', 'buyer@example.test')
await set('#input-shipping-firstname', 'Иван'); await set('#input-shipping-lastname', 'Тестов'); await set('#input-shipping-address-1', 'ул. Синтетическая, 1'); await set('#input-shipping-city', 'Москва'); await set('#input-shipping-postcode', '101000')
const country = p.locator('#input-shipping-country')
if (await country.count()) { await country.selectOption({ label: 'United Kingdom' }).catch(async (e) => console.log('country', e.message.slice(0, 80))); await p.waitForTimeout(1200) }
const zone = p.locator('#input-shipping-zone')
if (await zone.count()) { const n = await zone.locator('option').count(); console.log('zones', n); if (n > 1) await zone.selectOption({ index: 1 }); }
const cont = p.locator('#button-register')
console.log('button-register', await cont.count())
if (await cont.count()) { await cont.click(); await p.waitForTimeout(1800) }
console.log('alerts:', (await p.locator('.alert, .invalid-feedback.d-block').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 300))
console.log('buttons:', (await p.locator('button[id]').evaluateAll((l) => l.map((e) => e.id))).join(' '))
const ship = p.locator('#button-shipping-methods')
if (await ship.count()) { await ship.click(); await p.waitForTimeout(1200); const m = p.locator('#modal-shipping input[type=radio], #modal-shipping input[name="shipping_method"]'); console.log('shipping options', await m.count()); if (await m.count()) { await m.first().check(); await p.locator('#modal-shipping button[type=submit], #button-shipping-method').first().click(); await p.waitForTimeout(1200) } else console.log('shipping modal:', (await p.locator('#modal-shipping').allInnerTexts()).join(' ').replace(/\s+/g, ' ').slice(0, 200)) }
const pay = p.locator('#button-payment-methods')
if (await pay.count()) { await pay.click(); await p.waitForTimeout(1200); const m = p.locator('#modal-payment input[type=radio]'); console.log('payment options', await m.count()); console.log('payment modal:', (await p.locator('#modal-payment').allInnerTexts()).join(' ').replace(/\s+/g, ' ').slice(0, 240)); if (await m.count()) { await m.first().check(); await p.locator('#modal-payment button[type=submit], #button-payment-method').first().click(); await p.waitForTimeout(1200) } }
console.log('alerts2:', (await p.locator('.alert').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 300))
const confirm = p.locator('#button-confirm')
console.log('confirm', await confirm.count())
if (await confirm.count()) { await confirm.click().catch((e) => console.log(e.message.slice(0, 100))); await p.waitForTimeout(2500); console.log('after confirm:', p.url().replace(base, ''), await p.title()) }
console.log('bad responses:', [...new Set(bad)].slice(0, 12))
await b.close()
