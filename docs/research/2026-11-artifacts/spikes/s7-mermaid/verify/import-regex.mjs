// Skeptic check: naive @import removal (/@import[^;]*;/) on beautiful-mermaid's CSS versus the harness IMPORT
// pattern; which font family the text then gets in Chromium (inline, network blocked).   node verify/import-regex.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright-core')
const svg = readFileSync(new URL('../out/verify/raw/F01.bm.svg', import.meta.url), 'utf8')
const naive = svg.replace(/@import[^;]*;/g, '')
const careful = svg.replace(/@import\s+(?:url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)|'[^']*'|"[^"]*")[^;]*;?/gi, '')
console.log('leftover after naive removal:', JSON.stringify(naive.match(/<style[^>]*>([\s\S]{0,80})/)[1]))
const browser = await chromium.launch()
const ctx = await browser.newContext(); await ctx.route('**/*', (r) => r.abort())
const page = await ctx.newPage()
for (const [k, s] of [['naive', naive], ['careful', careful]]) {
  await page.setContent('<!doctype html><body><div id="h"></div></body>')
  const ff = await page.evaluate((s) => { document.getElementById('h').innerHTML = s; const t = document.querySelector('#h svg text'); return getComputedStyle(t).fontFamily }, s)
  console.log(k, '→ text font-family:', ff)
}
await browser.close()
