// Prints the independent check's results compactly: one line per finding.
import { readFileSync } from 'node:fs'
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(f, 'utf8'))
  console.log(`# ${f} ${r.os} node ${r.node} | ${r.uptimeAtStart} | ${r.uptimeAtEnd}`)
  for (const [e, er] of Object.entries(r.engines)) {
    console.log(`## ${e} ${er.version}`)
    for (const [g, v] of Object.entries(er.groups)) {
      if (v?.error) { console.log(`  ${g}: ERROR ${v.error}`); continue }
      if (g === 'safety') {
        for (const [variant, x] of Object.entries(v)) {
          if (variant === 'consoleBlocked') { console.log(`  safety console 'Blocked script execution': ${x}`); continue }
          const clicks = Object.entries(x.click).map(([n, c]) => `${n}=${c.error ? 'ERR' : c.ran.length ? 'RAN' : 'no'}${c.topMoved ? '(top moved)' : ''}`).join(' ')
          console.log(`  safety ${variant.padEnd(10)} load ran ${x.load.ran.length}: ${x.load.ran.join(',')} | mounted ${JSON.stringify(x.load.mounted)}`)
          console.log(`      clicks: ${clicks}`)
          console.log(`      parent calls: ${JSON.stringify(x.parentCalls)} ran: ${x.parentRan.join(',')}`)
          console.log(`      paste: ${JSON.stringify(x.paste)}`)
        }
      } else console.log(`  ${g}: ${JSON.stringify(v)}`)
    }
  }
}
