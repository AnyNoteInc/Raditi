import { chromium } from '<repo>/packages/browser-providers/node_modules/playwright-core/index.mjs'
const base = process.argv[2]
const b = await chromium.launch({ headless: true })
const c = await b.newContext(); const p = await c.newPage()
const cdp = await c.newCDPSession(p); await cdp.send('Network.enable')
cdp.on('Network.responseReceivedExtraInfo', (e) => { const blocked = e.blockedCookies ?? []; for (const x of blocked) console.log('BLOCKED', x.blockedReasons?.join(','), x.cookieLine?.slice(0, 110)) })
await p.goto(`${base}/`); await p.waitForTimeout(500)
console.log('cookies kept:', (await c.cookies()).map((k) => `${k.name}[sameSite=${k.sameSite},secure=${k.secure}]`).join(' '))
await b.close()
