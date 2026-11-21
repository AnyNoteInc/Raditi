// Details of results-v/*-frames.json: what the frames say about their origin, the controls of
// 'self', the fallback fonts, check() of a failed font, what the server saw, and the error classes.
import { readdirSync, readFileSync } from 'node:fs'
const dir = new URL('./results-v/', import.meta.url).pathname
for (const f of readdirSync(dir).filter((n) => n.endsWith('-frames.json')).sort()) {
  const set = JSON.parse(readFileSync(dir + f, 'utf8'))
  console.log(`\n### ${set.platform} ${set.engine} ${set.version} — cells ${set.cells}, off ${set.off.length}`)
  const byKey = (s, sandbox, csp) => set.runs.find((r) => r.s === s && r.sandbox === sandbox && r.csp === csp)
  const art = byKey('https', 'art', 'self')
  const h1 = art?.got?.h1
  if (h1) {
    console.log(`origin=${h1.origin} url=${h1.url} message=${h1.messageOrigin} cookie=${h1.cookie}`)
    console.log(`self controls: sib font ${h1.fonts.Vsib?.status}/${h1.fonts.Vsib?.applied}, cabinet script ${h1.flags.ctl ?? 'not run'}; violations: ${h1.violations.map((v) => v.d + ' ' + v.u.replace(/^https?:\/\//, '').replace(/-R[0-9a-z]+\.f00d/, '')).join(' | ') || 'none'}`)
    const h2 = art.got.h2
    console.log(`font widths: V(h1)=${h1.fonts.V.width} mono=${h1.fonts.V.mono} data=${h1.fonts.Vdata.width} buf=${h1.fonts.Vbuf.width}; failed V(h2): status=${h2?.fonts.V.status} width=${h2?.fonts.V.width} check()=${h2?.fonts.V.check}; check() of loaded V(h1)=${h1.fonts.V.check}`)
  }
  const star = byKey('https', 'art', 'star')?.got?.h1
  if (star) console.log(`star (positive control): sib font ${star.fonts.Vsib?.status}/${star.fonts.Vsib?.applied}, cabinet script ${star.flags.ctl ?? 'not run'}, violations ${star.violations.length}`)
  const today = byKey('https', 'art', 'today')
  const t = today?.got?.h1
  if (t) {
    const reached = today.server.filter((e) => e.path.startsWith('/v/') && !e.path.startsWith('/v/frame-')).length
    console.log(`today: data font applied=${t.fonts.Vdata.applied}, FontFace bytes applied=${t.fonts.Vbuf.applied} (${t.flags.buf ?? 'ok'}), violations=${t.violations.length}, resource requests that reached the server=${reached}`)
  }
  for (const [s, sandbox] of [['https', 'art'], ['http', 'art'], ['https', 'none']]) {
    const r = byKey(s, sandbox, 'self')
    if (!r) continue
    const kinds = {}
    for (const e of r.server) {
      const m = /\/v\/(font|js|jsx|mod|leaf|dyn|css|img)-h1-/.exec(e.path)
      if (m) kinds[m[1]] = `${e.mode ?? '-'}/${e.origin === null ? 'none' : JSON.stringify(e.origin)}/${e.site ?? '-'}`
    }
    console.log(`server ${s} ${sandbox}: ${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join('; ')}`)
    const methods = [...new Set(r.server.map((e) => e.method))].join(',')
    console.log(`  methods: ${methods}`)
  }
  // One error text per class (from the console of the h2 and h4 frames).
  const lines = art?.console ?? []
  const pick = (re) => lines.find((l) => re.test(l))
  console.log('CORS:', pick(/CORS|Access-Control-Allow-Origin|cross-site access/i)?.slice(0, 220))
  console.log('CORP:', pick(/Cross-Origin-Resource-Policy|BLOCKED_BY_RESPONSE/i)?.slice(0, 220))
  console.log('CSP :', pick(/Content Security Policy|Content-Security-Policy|font-src|script-src/i)?.slice(0, 220))
  if (set.off.length) console.log('OFF:', set.off.slice(0, 10).join(' || '))
}
