// Independent Next.js 16.3.6 check of spike s8 (other cases than next-logs.mjs):
//  1. what the App Router client sends after /a#<t> and /a?k=<t> (Chromium): request URLs and every
//     request header of prefetch, <Link> and router.push, plus the server's raw request heads;
//  2. what the standalone server prints for a server action that throws, a stream that fails after
//     the shell, generateMetadata that throws, notFound(), an unhandled rejection, a bad path and
//     a 20 KB address;
//  3. which Referrer-Policy wins: an entry EARLIER than the global one (/b), proxy (/c), a route (/api/rej).
//   node ind-next.mjs --app <ind-next>
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { chromium } from 'playwright-core'

const { values } = parseArgs({ options: { app: { type: 'string' } } })
const APP = values.app
cpSync(join(APP, '.next/static'), join(APP, '.next/standalone/.next/static'), { recursive: true })
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
const port = await freePort()
let out = ''
let err = ''
const server = spawn(process.execPath, [join(APP, '.next/standalone/server.js')], {
  env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' },
})
server.stdout.on('data', (d) => (out += d))
server.stderr.on('data', (d) => (err += d))
for (let i = 0; i < 100 && !/Ready/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
// A recording relay in front of Next: every raw request head the browser sends
const heads = []
const relayPort = await new Promise((resolve) => {
  const relay = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1')
    let buf = ''
    client.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      let end
      while ((end = buf.indexOf('\r\n\r\n')) >= 0) { heads.push(buf.slice(0, end)); buf = buf.slice(end + 4) }
      upstream.write(chunk)
    })
    upstream.on('data', (c) => client.write(c))
    upstream.on('end', () => client.end())
    client.on('end', () => upstream.end())
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  relay.listen(0, '127.0.0.1', () => resolve(relay.address().port))
})
const base = `http://127.0.0.1:${relayPort}`
const mk = (id) => `NXT${id}x${randomBytes(6).toString('hex')}`
const report = { router: [], logs: [], headers: [] }

const browser = await chromium.launch({ headless: true })
for (const [label, path] of [['static /a', '/a'], ['dynamic /ad', '/ad']]) {
  for (const form of ['fragment', 'query']) {
    const t = mk(form[0])
    const page = await (await browser.newContext()).newPage()
    const sent = []
    page.on('request', async (req) => sent.push({ url: req.url(), headers: await req.allHeaders() }))
    const start = heads.length
    await page.goto(form === 'fragment' ? `${base}${path}#${t}` : `${base}${path}?k=${t}`)
    await page.waitForSelector('#len')
    await page.waitForTimeout(1200) // prefetch of <Link href="/b">
    await Promise.all([page.waitForURL('**/b'), page.click('#tob')])
    await page.goBack()
    await page.waitForSelector('#toc')
    await Promise.all([page.waitForURL('**/c'), page.click('#toc')])
    await page.waitForTimeout(500)
    const raw = heads.slice(start)
    const after = sent.filter((s) => !s.url.includes(t) || s !== sent[0]).slice(1)
    report.router.push({
      page: label,
      form,
      requests: raw.length,
      rscRequests: raw.filter((h) => /^rsc: 1$/im.test(h)).length,
      tokenInRawHeadsAfterFirst: raw.slice(1).filter((h) => h.includes(t)).map((h) => {
        const where = h.split('\r\n').filter((l) => l.includes(t)).map((l) => l.split(':')[0].split(' ')[0])
        return where.join(',')
      }),
      tokenInFirstRequestLine: raw[0]?.split('\r\n')[0].includes(t) ?? false,
      browserSideHeadersWithToken: [...new Set(after.flatMap((s) => Object.entries(s.headers).filter(([, v]) => String(v).includes(t)).map(([k]) => k)))],
    })
    await page.context().close()
  }
}

// Server-side failures
const direct = `http://127.0.0.1:${port}`
const marks = {}
const hit = async (id, path, init) => {
  marks[id] = mk(id)
  const url = path.replace('MARK', marks[id])
  const status = await fetch(`${direct}${url}`, { redirect: 'manual', ...init }).then((r) => r.status, (e) => `error ${e.cause?.code ?? e.message}`)
  report.logs.push({ id, path: path.replace('MARK', '<m>').slice(0, 60), status })
}
await hit('L1', '/stream?k=MARK')
await hit('L2', '/meta?k=MARK')
await hit('L3', '/nf?k=MARK')
await hit('L4', '/api/rej?k=MARK')
await hit('L5', '/%E0%A4%A/MARK?k=MARK')
await hit('L6', `/b?k=MARK&pad=${'z'.repeat(20000)}`)
// A server action that throws, invoked by the browser from /act?k=…
marks.L7 = mk('L7')
{
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${direct}/act?k=${marks.L7}`)
  const answer = page.waitForResponse((r) => r.request().method() === 'POST', { timeout: 8000 }).then((r) => r.status(), () => 'none')
  await page.click('#go')
  report.logs.push({ id: 'L7', path: '/act?k=<m> (server action)', status: await answer })
  await page.context().close()
}
await browser.close()
for (const [path, about] of [['/a', 'later entry'], ['/b', 'EARLIER entry than the global one'], ['/c', 'proxy sets it'], ['/api/rej', 'route handler sets it']]) {
  const r = await fetch(`${direct}${path}`)
  report.headers.push({ path, about, referrerPolicy: r.headers.get('referrer-policy') })
}
await new Promise((r) => setTimeout(r, 800))
server.kill('SIGINT')
await new Promise((r) => setTimeout(r, 400))
for (const l of report.logs) {
  l.inStdout = out.includes(marks[l.id])
  l.inStderr = err.includes(marks[l.id])
}
report.stderrFirstLines = err.split('\n').filter((l) => /⨯|Error|error/.test(l)).slice(0, 12).map((l) => l.replace(/NXT\w+/g, '<m>').slice(0, 160))
console.log(JSON.stringify(report, null, 1))
process.exit(0)
