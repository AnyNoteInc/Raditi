// Turns results/<platform>-<engine>.json into the tables of the report (Markdown on stdout).
//   node report.mjs > results/summary.md
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HEADER_VARIANTS, resourcePath } from './variants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, 'results')
const files = readdirSync(dir).filter((f) => /^(macos|linux)-[a-z0-9-]+\.json$/.test(f) && !f.includes('refused'))
const sets = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
// The extra passes (--only-sites) join the set of their platform and engine.
for (const f of readdirSync(dir).filter((name) => /^(macos|linux)-[a-z0-9-]+\.extra\.json$/.test(name) && !name.includes('refused'))) {
  const extra = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const set = sets.find((s) => s.meta.engine === extra.meta.engine && s.meta.platform === extra.meta.platform)
  if (set) set.runs.push(...extra.runs)
  else sets.push(extra)
}
const originOf = (value) => (value === null || value === undefined ? 'absent' : JSON.stringify(value))
const KINDS = ['font', 'js', 'jsx', 'mjs', 'mji', 'css', 'img']
const HS = Object.keys(HEADER_VARIANTS)
const label = (meta) => `${meta.engine}@${meta.platform}`

const out = []
const p = (line = '') => out.push(line)

function textsFor(run, url) {
  const path = new URL(url).pathname
  const texts = []
  for (const f of run.failed ?? []) if (f.url.includes(path)) texts.push(f.error)
  for (const c of run.console ?? []) if (c.text.includes(path)) texts.push(c.text)
  return [...new Set(texts)]
}

function classify(texts) {
  const all = texts.join(' | ')
  if (/Content Security Policy|Content-Security-Policy|CSP|ERR_BLOCKED_BY_CSP|NS_ERROR_CONTENT_BLOCKED/i.test(all)) return 'CSP'
  if (/Cross-Origin-Resource-Policy|NotSameOrigin|NotSameSite|CORP|NS_ERROR_DOM_CORP_FAILED/i.test(all)) return 'CORP'
  if (/CORS|Access-Control-Allow-Origin|Cross-Origin Request Blocked|NS_ERROR_DOM_BAD_URI|access control checks|ERR_FAILED/i.test(all)) return 'CORS'
  return all ? 'other' : '—'
}

function frameCell(run, kind, h) {
  const res = run.results?.['0']
  if (!res) return { loaded: null }
  let loaded
  if (kind === 'font') loaded = res.fonts[`F-${h}`]?.status === 'loaded' && res.fonts[`F-${h}`]?.applied === true
  else if (kind === 'css') loaded = res.css[`css-${h}`] === '37px'
  else if (kind === 'img') loaded = res.img[`img-${h}`] === 3
  else loaded = res.ran[`${kind}-${h}`] === 1
  const path = resourcePath(kind, h, run.fid)
  const hits = run.server.filter((e) => e.path === path)
  const url = `${run.scheme}://pages.spike.test${path}`
  const texts = loaded ? [] : textsFor(run, url)
  const violated = (res.violations ?? []).some((v) => v.blocked && v.blocked.includes(path))
  let reason = null
  if (!loaded) {
    if (hits.length === 0) reason = violated || classify(texts) === 'CSP' ? 'CSP' : 'not asked'
    else if (hits[0].mode === 'cors') reason = 'CORS'
    else if (hits[0].mode === 'no-cors') reason = 'CORP'
    else reason = classify(texts)
  }
  return { loaded, hits: hits.length, mode: hits[0]?.mode ?? null, origin: hits[0]?.origin ?? null, reason, texts }
}

const mark = (cell) => (cell.loaded === null ? '?' : cell.loaded ? '✓' : `✗ ${cell.reason}`)

function runOf(set, pred) {
  return set.runs.find((r) => r.kind === 'frame' && !r.cached && pred(r))
}

p('# Spike s2: raw tables')
p()
p('## Engines')
p()
p('| engine | version | os | load at start → finish |')
p('| --- | --- | --- | --- |')
for (const s of sets)
  p(`| ${label(s.meta)} | ${s.meta.version} | ${s.meta.os} | ${s.meta.loadAtStart?.join(' ')} → ${s.meta.loadAtFinish?.join(' ')} |`)
p()

// A1: what loads with each header variant under a policy that allows the path.
for (const csp of ['c1', 'c3']) {
  for (const scheme of ['https', 'http']) {
    p(`## A1 ${scheme}, sandbox art, ${csp}: resource × headers`)
    p()
    p(`| engine | kind | ${HS.join(' | ')} |`)
    p(`| --- | --- | ${HS.map(() => '---').join(' | ')} |`)
    for (const s of sets) {
      const run = runOf(s, (r) => r.scheme === scheme && r.sandbox === 'art' && r.csp === csp)
      if (!run) continue
      for (const kind of KINDS) p(`| ${label(s.meta)} | ${kind} | ${HS.map((h) => mark(frameCell(run, kind, h))).join(' | ')} |`)
    }
    p()
  }
}

// A2: the policy variants with the proposed headers (h1) and with today's /_files/ headers (h2).
for (const h of ['h1', 'h2']) {
  for (const scheme of ['https', 'http']) {
    p(`## A2 ${scheme}, sandbox art, headers ${h}: CSP × kind`)
    p()
    p(`| engine | csp | ${KINDS.join(' | ')} | data: font | buffer font | violations |`)
    p(`| --- | --- | ${KINDS.map(() => '---').join(' | ')} | --- | --- | --- |`)
    for (const s of sets) {
      for (const csp of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) {
        const run = runOf(s, (r) => r.scheme === scheme && r.sandbox === 'art' && r.csp === csp)
        if (!run) continue
        const res = run.results?.['0']
        const font = (f) => (res?.fonts[f]?.status === 'loaded' && res.fonts[f].applied ? '✓' : '✗')
        p(`| ${label(s.meta)} | ${csp} | ${KINDS.map((k) => mark(frameCell(run, k, h))).join(' | ')} | ${font('F-data')} | ${font('F-buf')} | ${res?.violations?.length ?? '?'} |`)
      }
    }
    p()
  }
}

// A3: do `page` (today's PAGE_SANDBOX) and `art` (ARTIFACT_SANDBOX) differ anywhere? And `none`?
p('## A3 sandbox page vs art vs none (cells that differ from art)')
p()
p('| engine | scheme | csp | page ≠ art | none: loaded / all |')
p('| --- | --- | --- | --- | --- |')
for (const s of sets) {
  for (const scheme of ['https', 'http']) {
    for (const csp of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) {
      const art = runOf(s, (r) => r.scheme === scheme && r.sandbox === 'art' && r.csp === csp)
      const page = runOf(s, (r) => r.scheme === scheme && r.sandbox === 'page' && r.csp === csp)
      const none = runOf(s, (r) => r.scheme === scheme && r.sandbox === 'none' && r.csp === csp)
      if (!art) continue
      let differ = page ? 0 : '—'
      let noneLoaded = 0
      let total = 0
      for (const kind of KINDS)
        for (const h of HS) {
          if (page && frameCell(page, kind, h).loaded !== frameCell(art, kind, h).loaded) differ++
          if (none) {
            total++
            if (frameCell(none, kind, h).loaded) noneLoaded++
          }
        }
      p(`| ${label(s.meta)} | ${scheme} | ${csp} | ${differ} | ${none ? `${noneLoaded} / ${total}` : '—'} |`)
    }
  }
}
p()

// A4: the origin of the frame and what the server saw.
p('## A4 origin of the frame and request headers (https, art, c1)')
p()
p('| engine | self.origin | message origin | document.cookie | font: mode / Origin | mjs: mode / Origin | js: mode / Origin | Sec-Fetch-Site of resources |')
p('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const s of sets) {
  const run = runOf(s, (r) => r.scheme === 'https' && r.sandbox === 'art' && r.csp === 'c1')
  if (!run) continue
  const res = run.results['0']
  const at = (kind) => {
    const e = run.server.find((x) => x.path === resourcePath(kind, 'h1', run.fid))
    return e ? `${e.mode} / ${originOf(e.origin)}` : '—'
  }
  const sites = [...new Set(run.server.filter((e) => e.path.includes('-h1-')).map((e) => e.site))].join(', ')
  p(`| ${label(s.meta)} | ${res.origin} | ${run.messages?.[0]?.origin} | ${res.cookie} | ${at('font')} | ${at('mjs')} | ${at('js')} | ${sites} |`)
}
p()

// A5: the error texts, one per class and engine.
p('## A5 error texts (https, art)')
p()
p('| engine | class | example |')
p('| --- | --- | --- |')
for (const s of sets) {
  const seen = new Set()
  for (const csp of ['c0', 'c1']) {
    const run = runOf(s, (r) => r.scheme === 'https' && r.sandbox === 'art' && r.csp === csp)
    if (!run) continue
    for (const kind of KINDS)
      for (const h of HS) {
        const cell = frameCell(run, kind, h)
        if (cell.loaded !== false) continue
        const key = `${cell.reason}:${kind}`
        if (seen.has(key)) continue
        seen.add(key)
        const text = cell.texts.map((t) => t.replace(/https?:\/\/pages\.spike\.test\/v\/[a-z]+-h\d-[A-Za-z0-9]+\.a1b2c3d4/g, '<url>')).join(' ‖ ')
        p(`| ${label(s.meta)} | ${cell.reason} (${kind}) | ${text.slice(0, 400).replace(/\|/g, '\\|') || '(none captured)'} |`)
      }
  }
}
p()

// A6: fonts — widths.
p('## A6 font widths (https, art, c1): loaded vs fallback')
p()
p('| engine | F-h1 | fallback | F-data | F-buf | check() of F-h1 / F-h2 |')
p('| --- | --- | --- | --- | --- | --- |')
for (const s of sets) {
  const run = runOf(s, (r) => r.scheme === 'https' && r.sandbox === 'art' && r.csp === 'c1')
  if (!run) continue
  const f = run.results['0'].fonts
  p(`| ${label(s.meta)} | ${f['F-h1'].width} (${f['F-h1'].status}) | ${f['F-h1'].fallback} | ${f['F-data'].width} | ${f['F-buf'].width} | ${f['F-h1'].check} / ${f['F-h2'].check} |`)
}
p()

// B: published sites.
p('## B published sites')
p()
const siteRes = (x) => {
  if (!x) return '?'
  const f = (k) => (x.fonts[k]?.status === 'loaded' && x.fonts[k].applied ? '✓' : '✗')
  return `font ${f('F-files')} · font from css ${f('F-css')} · css ${x.css['css-files'] === '37px' ? '✓' : '✗'} · js ${x.ran['files-js'] ? '✓' : '✗'} · mjs ${x.ran['files-mjs'] ? '✓' : '✗'} · img ${x.img['img-files'] === 3 ? '✓' : '✗'} · data ${f('F-data')}`
}
p('| engine | scheme | site | first load | reload | font requests: status, mode, cookie, Origin | statuses on reload | Referer of /_files/ |')
p('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const s of sets) {
  for (const run of s.runs.filter((r) => r.kind === 'site')) {
    const name = `${run.slug} (${run.site.password ? 'password' : 'public'}, ${run.site.fix ? 'ACAO *' : 'today'})`
    const fonts = run.server.filter((e) => e.path.endsWith('.woff2'))
    const firstFonts = fonts.slice(0, 2).map((e) => `${e.status} ${e.mode ?? '-'} ${e.cookie ? 'cookie' : 'no cookie'} ${originOf(e.origin)}`).join('; ')
    const reloads = run.server.filter((e) => e.inm).length
    const statuses = [...new Set(run.server.slice(Math.floor(run.server.length / 2)).map((e) => e.status))].join(',')
    const referers = [...new Set(run.server.filter((e) => e.path.startsWith('/_files/')).map((e) => e.referer ?? 'absent'))].join(', ')
    p(`| ${label(s.meta)} | ${run.scheme} | ${name}${run.site.referrer ? ` + Referrer-Policy ${run.site.referrer}` : ''} | ${siteRes(run.first)} | ${siteRes(run.second)} | ${firstFonts} | ${statuses}; If-None-Match ${reloads} | ${referers} |`)
  }
}
p()
p('## B2 another site embeds the files of a site with a password (after the password)')
p()
p('| engine | site | script ran there | css applied | img | fetch with credentials | fetch | requests: status, cookie |')
p('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const s of sets)
  for (const run of s.runs.filter((r) => r.kind === 'site' && r.xssi))
    p(`| ${label(s.meta)} | ${run.slug} (${run.site.password ? 'password' : 'public'}, ${run.site.fix ? 'ACAO *' : 'today'}${run.site.referrer ? ', ' + run.site.referrer : ''}) | ${run.xssi.script ?? run.xssi.error} | ${run.xssi.css} | ${run.xssi.img} | ${run.xssi.fetchWithCookie} | ${run.xssi.fetchPlain} | ${(run.xssi.server ?? []).map((e) => `${e.path.replace('/_files/', '')} ${e.status} ${e.cookie ? 'cookie' : 'no cookie'}`).join('; ')} |`)
p()

// C: cache across frames.
p('## C a content-addressed library in three frames (Cache-Control immutable)')
p()
p('| engine | scheme | sandbox | csp | frames with font F-h1 | server hits per kind (h1) |')
p('| --- | --- | --- | --- | --- | --- |')
for (const s of sets)
  for (const run of s.runs.filter((r) => r.kind === 'frame' && r.cached)) {
    const frames = Object.values(run.results ?? {})
    const applied = frames.filter((res) => res.fonts['F-h1']?.status === 'loaded' && res.fonts['F-h1'].applied).length
    const hits = KINDS.map((k) => `${k} ${run.server.filter((e) => e.path === resourcePath(k, 'h1', run.fid)).length}`).join(', ')
    p(`| ${label(s.meta)} | ${run.scheme} | ${run.sandbox} | ${run.csp} | ${applied} / ${frames.length} | ${hits} |`)
  }
p()

// D: processes (Chromium).
p('## D Chromium: frames in a process of their own (CDP iframe targets)')
p()
p('| engine | scheme | iframe targets |')
p('| --- | --- | --- |')
for (const s of sets)
  for (const run of s.runs.filter((r) => r.kind === 'oopif'))
    p(`| ${label(s.meta)} | ${run.scheme} | ${run.error ? run.error.slice(0, 80) : JSON.stringify(run.targets.map((t) => t.url.replace(/^https?:\/\//, '').replace(/view-(art|none)-c1-[A-Za-z0-9]+\.a1b2c3d4/, 'view-$1')))} |`)
p()

// Consistency: within a family, do builds and platforms agree?
p('## E agreement within an engine family (all frame cells)')
p()
const family = (meta) => (meta.browser === 'chromium' ? 'Chromium' : meta.browser === 'webkit' ? 'WebKit' : 'Firefox')
const byFamily = {}
for (const s of sets) (byFamily[family(s.meta)] ??= []).push(s)
p('| family | builds | cells compared | differ |')
p('| --- | --- | --- | --- |')
for (const [name, list] of Object.entries(byFamily)) {
  let compared = 0
  let differ = 0
  const diffs = []
  list.sort((a, b) => b.runs.filter((r) => r.kind === 'frame').length - a.runs.filter((r) => r.kind === 'frame').length)
  const base = list[0]
  for (const other of list.slice(1))
    for (const run of base.runs.filter((r) => r.kind === 'frame' && !r.cached)) {
      const twin = runOf(other, (r) => r.scheme === run.scheme && r.sandbox === run.sandbox && r.csp === run.csp)
      if (!twin) continue
      for (const kind of KINDS)
        for (const h of HS) {
          compared++
          if (frameCell(run, kind, h).loaded !== frameCell(twin, kind, h).loaded) {
            differ++
            if (diffs.length < 6) diffs.push(`${label(other.meta)} ${run.scheme} ${run.sandbox} ${run.csp} ${kind} ${h}`)
          }
        }
    }
  p(`| ${name} | ${list.map((s) => label(s.meta)).join(', ')} | ${compared} | ${differ}${diffs.length ? ` (${diffs.join('; ')})` : ''} |`)
}
p()
process.stdout.write(out.join('\n') + '\n')
