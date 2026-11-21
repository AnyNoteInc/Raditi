// Independent check of «an aborted navigation draws Chromium's error page, 204 keeps the document»
// (spike s3, plan 88). The frame leaves its page by a script after 100 ms.
//   node v5-nav-abort.mjs
import { chromium } from 'playwright-core'

const DOC = 'https://frame.check.invalid/v/frame'
const HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><h1 id="h">Кадр</h1><script>setTimeout(() => { location.href = 'https://elsewhere.check.invalid/away' }, 100)</script></body></html>`
const browser = await chromium.launch({ headless: true })
const out = {}
for (const answer of ['abort', '204']) {
  const ctx = await browser.newContext()
  await ctx.route('**/*', (route) => {
    const r = route.request()
    if (r.url() === DOC) return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-scripts' }, body: HTML })
    if (r.isNavigationRequest()) return answer === 'abort' ? route.abort('blockedbyclient') : route.fulfill({ status: 204, body: '' })
    return route.abort()
  })
  const page = await ctx.newPage()
  await page.goto(DOC, { waitUntil: 'commit' })
  await page.waitForTimeout(1000)
  const shot = await page.screenshot()
  out[answer] = { url: page.url(), h1: await page.$eval('#h', (e) => e.textContent).catch(() => null), title: await page.title().catch(() => null), pngBytes: shot.length }
  await ctx.close()
}
await browser.close()
console.log(JSON.stringify(out, null, 1))
