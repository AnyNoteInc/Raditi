// Which headers the App Router client sends on RSC requests after /ad?k=<t> (a side check of ind-next.mjs).
import { spawn } from 'node:child_process'
import net from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
const APP = process.argv[2]
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
let out = ''
const server = spawn(process.execPath, [join(APP, '.next/standalone/server.js')], { env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' } })
server.stdout.on('data', (d) => (out += d))
for (let i = 0; i < 100 && !/Ready/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
const rsc = []
page.on('request', async (req) => { const h = await req.allHeaders(); if (h.rsc) rsc.push({ url: req.url().replace(/^https?:\/\/[^/]+/, ''), names: Object.keys(h).filter((k) => k.startsWith('next-') || k === 'rsc').sort(), tree: (h['next-router-state-tree'] ?? '').slice(0, 300) }) })
await page.goto(`http://127.0.0.1:${port}/ad?k=TOKENQ123#TOKENF456`)
await page.waitForSelector('#len')
await page.waitForTimeout(1200)
await Promise.all([page.waitForURL('**/b'), page.click('#tob')])
await page.waitForTimeout(400)
console.log(JSON.stringify(rsc.map((r) => ({ ...r, tree: decodeURIComponent(r.tree).slice(0, 200), hasQ: decodeURIComponent(r.tree).includes('TOKENQ123'), hasF: decodeURIComponent(r.tree).includes('TOKENF456') })), null, 1))
await browser.close(); server.kill('SIGINT'); process.exit(0)
