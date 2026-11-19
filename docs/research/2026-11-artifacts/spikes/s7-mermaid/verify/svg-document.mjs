// Skeptic check: a beautiful-mermaid SVG opened on its own as a document (as a downloaded file would be)
// requests Google Fonts; the same SVG through <img> does not.   node verify/svg-document.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium, webkit } = require('playwright-core')
const svg = readFileSync(new URL('../out/verify/raw/C01.bm.svg', import.meta.url), 'utf8')
for (const type of [chromium, webkit]) {
  const browser = await type.launch()
  const ctx = await browser.newContext()
  const seen = []
  await ctx.route('**/*', (r) => {
    const u = r.request().url()
    if (u === 'https://files.invalid/diagram.svg') return r.fulfill({ contentType: 'image/svg+xml', body: svg })
    if (u === 'https://files.invalid/page.html') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><img src="/diagram.svg">' })
    seen.push(u); r.abort().catch(() => {})
  })
  const page = await ctx.newPage()
  await page.goto('https://files.invalid/diagram.svg').catch(() => {})
  await page.waitForTimeout(500)
  const asDocument = [...seen]; seen.length = 0
  await page.goto('https://files.invalid/page.html').catch(() => {})
  await page.waitForTimeout(500)
  console.log(type.name(), 'as document:', JSON.stringify(asDocument.map((u) => u.slice(0, 60))), '| through <img>:', seen.length)
  await browser.close()
}
