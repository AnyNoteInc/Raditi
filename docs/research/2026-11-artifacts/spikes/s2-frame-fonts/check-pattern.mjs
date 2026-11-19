// Checks that every sandboxed frame whose policy allows the path shows one pattern per engine
// family (the A1 table of the README), and every unsandboxed one loads everything.
import { readdirSync, readFileSync } from 'node:fs'
import { HEADER_VARIANTS, resourcePath } from './variants.mjs'
const KINDS = ['font', 'js', 'jsx', 'mjs', 'mji', 'css', 'img']
const HS = Object.keys(HEADER_VARIANTS)
const corp = (h) => HEADER_VARIANTS[h].corp
const acao = (h) => HEADER_VARIANTS[h].acao === '*'
const noCorsOk = (h) => corp(h) !== 'same-origin' && corp(h) !== 'same-site'
// The expected pattern: CORS kinds need ACAO, no-cors kinds need a CORP that is not same-*.
const expected = (family, kind, h) => {
  const cors = ['jsx', 'mjs', 'mji'].includes(kind) || (kind === 'font' && family !== 'webkit')
  return cors ? acao(h) : noCorsOk(h)
}
let checked = 0
const bad = []
for (const f of readdirSync('results').filter((n) => /^(macos|linux)-[a-z0-9-]+\.json$/.test(n) && !n.includes('refused'))) {
  const set = JSON.parse(readFileSync(`results/${f}`, 'utf8'))
  for (const run of set.runs.filter((r) => r.kind === 'frame' && !r.cached)) {
    if (run.csp === 'c0' || (run.csp === 'c4' && run.scheme === 'http')) continue
    const res = run.results['0']
    for (const kind of KINDS)
      for (const h of HS) {
        let loaded
        if (kind === 'font') loaded = res.fonts[`F-${h}`].status === 'loaded' && res.fonts[`F-${h}`].applied
        else if (kind === 'css') loaded = res.css[`css-${h}`] === '37px'
        else if (kind === 'img') loaded = res.img[`img-${h}`] === 3
        else loaded = res.ran[`${kind}-${h}`] === 1
        const want = run.sandbox === 'none' ? true : expected(set.meta.browser, kind, h)
        checked++
        if (loaded !== want) bad.push(`${f} ${run.scheme} ${run.sandbox} ${run.csp} ${kind} ${h}: got ${loaded}`)
      }
  }
}
console.log(`cells checked against the rule: ${checked}, off the rule: ${bad.length}`)
for (const line of bad.slice(0, 20)) console.log('  ' + line)
