// Sizes behind the s3 claims, recomputed another way (skeptic): the cost of stamping ids on the
// source without the test marks, fonts and photos as data: addresses.
//   node v12-sizes.mjs <harness dir>   (photos: after one run of check.mjs, which draws assets/)
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const dir = resolve(process.argv[2])
const require = createRequire(join(dir, 'package.json'))
const { parse } = require('parse5')
const SKIP = new Set(['html', 'head', 'meta', 'link', 'title', 'style', 'script', 'noscript', 'template', 'base', 'br', 'wbr', 'source', 'track'])
const rows = []
for (const f of readdirSync(join(dir, 'fixtures')).filter((f) => /^\d\d-.*\.html$/.test(f)).sort()) {
  const source = readFileSync(join(dir, 'fixtures', f), 'utf8').replace(/\s+data-bug="[^"]*"/g, '')
  const doc = parse(source)
  let n = 0
  const walk = (node, inBody, inSvg) => { for (const c of node.childNodes || []) { if (!c.tagName) continue; const body = inBody || c.tagName === 'body'; if (body && !SKIP.has(c.tagName) && !inSvg) n++; if (c.tagName !== 'template') walk(c, body, inSvg || c.tagName === 'svg') } }
  walk(doc, false, false)
  let added = 0
  for (let i = 1; i <= n; i++) added += ` data-raditi-id="e${i}"`.length
  const bytes = Buffer.byteLength(source)
  rows.push({ frame: f.slice(0, 2), bytes, ids: n, added, pct: Math.round((added / bytes) * 1000) / 10 })
}
const fontDir = join(require.resolve('@fontsource-variable/golos-text/package.json'), '..', 'files')
const fonts = ['cyrillic-ext', 'cyrillic', 'latin-ext', 'latin'].map((s) => readFileSync(join(fontDir, `golos-text-${s}-wght-normal.woff2`)).length)
const menu = readFileSync(join(dir, 'fixtures', '06-menu.html'), 'utf8')
const photoIds = [...menu.matchAll(/\{\{DATA_JPEG:([\w-]+)\}\}/g)].map((m) => m[1])
// assets/ is drawn by the first run of check.mjs; without it the photos are not counted.
const photos = existsSync(join(dir, 'assets')) ? photoIds.map((id) => readFileSync(join(dir, 'assets', `${id}.jpg`)).length) : []
console.log(JSON.stringify({ stamping: rows, pctRange: [Math.min(...rows.map((r) => r.pct)), Math.max(...rows.map((r) => r.pct))], fontsWoff2: fonts, fontsBase64Total: fonts.reduce((a, b) => a + Math.ceil(b / 3) * 4, 0), menuPhotos: { ids: photoIds, jpegBytes: photos, base64Total: photos.reduce((a, b) => a + Math.ceil(b / 3) * 4, 0) } }, null, 1))
