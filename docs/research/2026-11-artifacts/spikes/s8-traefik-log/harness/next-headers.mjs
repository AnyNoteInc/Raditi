// Spike s8, a side check: which Referrer-Policy does Next.js 16.3.6 send on /a when next.config.mjs
// sets a global one? <app> is nextapp-headers, built with `next build`.
//   node next-headers.mjs --app <nextapp-headers> [--out <file.json>]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { sleep } from './lib.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, out: { type: 'string' } } })
const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
let stdout = ''
const server = spawn(process.execPath, [join(values.app, '.next/standalone/server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' },
})
server.stdout.on('data', (d) => (stdout += d))
for (let i = 0; i < 100 && !/Ready/.test(stdout); i++) await sleep(200)
const how = {
  '/a': 'a later headers() entry for /a in next.config.mjs',
  '/b': 'proxy.js sets the header on the response',
  '/c': 'nothing but the global headers() entry',
  '/r': 'a route handler returns the header itself',
}
const results = []
for (const [path, about] of Object.entries(how)) {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`)
  results.push({ path, about, status: answer.status, referrerPolicy: answer.headers.get('referrer-policy') })
}
server.kill('SIGINT')
const out = { next: '16.3.6', results }
if (values.out) writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out, null, 2))
