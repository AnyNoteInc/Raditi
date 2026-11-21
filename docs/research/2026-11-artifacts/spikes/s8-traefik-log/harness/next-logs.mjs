// Spike s8: does the production server of Next.js 16.3.6 (standalone server.js, as apps/web runs)
// print request URLs? Starts <nextapp>/.next/standalone/server.js, sends requests with markers in
// the query, then looks for the markers in its stdout and stderr.
//   node next-logs.mjs --app <nextapp> --out <run>/results/next.json
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { marker, sleep } from './lib.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, out: { type: 'string' } } })
const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
let stdout = ''
let stderr = ''
const server = spawn(process.execPath, [join(values.app, '.next/standalone/server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' },
})
server.stdout.on('data', (d) => (stdout += d))
server.stderr.on('data', (d) => (stderr += d))
for (let i = 0; i < 100 && !/Ready|ready/.test(stdout); i++) await sleep(200)

const cases = [
  ['N1', 'page /a?k=…', (m) => `/a?k=${m}`],
  ['N2', 'page that throws', (m) => `/boom?k=${m}`],
  ['N3', 'route handler that throws', (m) => `/api/echo?throw=1&k=${m}`],
  ['N4', 'no such page (404)', (m) => `/missing?k=${m}`],
  ['N5', 'redirect to /sign-in?next=<path+query>', (m) => `/protected?k=${m}`],
  ['N6', 'malformed percent-escape in the query', (m) => `/a?k=%E0%A4%A${m}`],
]
const results = []
for (const [id, about, path] of cases) {
  const m = marker('N', id)
  const answer = await fetch(`http://127.0.0.1:${port}${path(m)}`, { redirect: 'manual' }).then(
    async (r) => ({ status: r.status, location: r.headers.get('location') }),
    (e) => ({ status: null, error: String(e) }),
  )
  results.push({ id, about, status: answer.status, locationCarriesToken: answer.location?.includes(m) ?? false, m })
}
await sleep(1000)
server.kill('SIGINT')
await sleep(500)
for (const r of results) {
  r.inStdout = stdout.includes(r.m)
  r.inStderr = stderr.includes(r.m)
  delete r.m
}
const out = {
  next: '16.3.6',
  node: process.version,
  results,
  stdoutLines: stdout.split('\n').filter(Boolean).map((l) => l.replace(/S8N\w+/g, '<marker>')),
  stderrLines: stderr.split('\n').filter(Boolean).slice(0, 40).map((l) => l.replace(/S8N\w+/g, '<marker>')),
}
writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out, null, 2))
