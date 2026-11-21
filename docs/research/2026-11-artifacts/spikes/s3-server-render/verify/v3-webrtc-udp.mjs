// Independent check of «the network is closed» for a path the harness did not exercise: WebRTC
// over UDP. The harness's frame h1-network makes an RTCPeerConnection but never calls
// setLocalDescription, so ICE gathering never starts, and its trap listens on TCP only.
// Here a UDP trap on loopback plays the STUN server; the frame gathers candidates for real.
//   node v3-webrtc-udp.mjs
// Cases: the spike's launch (its flags and the closed proxy) and a plain launch as a positive control.
import { createServer } from 'node:http'
import dgram from 'node:dgram'
import { chromium } from 'playwright-core'

const udp = dgram.createSocket('udp4')
const packets = []
udp.on('message', (msg, rinfo) => packets.push({ bytes: msg.length, from: `${rinfo.address}:${rinfo.port}` }))
await new Promise((r) => udp.bind(0, '127.0.0.1', r))
const stun = `stun:127.0.0.1:${udp.address().port}`

const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out">…</pre><script>
(async () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: '${stun}' }] })
  const kinds = []
  pc.onicecandidate = (e) => { if (e.candidate) kinds.push(e.candidate.type) }
  pc.createDataChannel('x')
  await pc.setLocalDescription(await pc.createOffer())
  setTimeout(() => { document.getElementById('out').textContent = JSON.stringify({ state: pc.iceGatheringState, candidates: kinds }) }, 2500)
})().catch((e) => { document.getElementById('out').textContent = 'error ' + e.name + ' ' + e.message })
</script></body></html>`
const POLICY = "sandbox allow-scripts; script-src 'unsafe-inline'; default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'"
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY }); res.end(FRAME) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const SPIKE_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--no-pings', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=512']
const cases = [
  ['spike launch: flags + closed proxy', { args: SPIKE_ARGS, proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' } }],
  ['spike flags, no proxy', { args: SPIKE_ARGS }],
  ['control: plain launch', {}],
]
const out = { stun, cases: {} }
for (const [name, opts] of cases) {
  const before = packets.length
  const browser = await chromium.launch({ headless: true, ...opts })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  let result
  try {
    // The document itself must load: with the closed proxy only a route can serve it.
    if (opts.proxy) await ctx.route(url, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY }, body: FRAME }))
    await page.goto(url)
    await page.waitForFunction(() => document.getElementById('out').textContent !== '…', null, { timeout: 6000 })
    result = await page.$eval('#out', (e) => e.textContent)
  } catch (e) { result = 'error ' + e.message.slice(0, 100) }
  await new Promise((r) => setTimeout(r, 500))
  out.cases[name] = { page: result, udpPacketsAtTrap: packets.length - before }
  await browser.close()
}
udp.close(); server.close()
console.log(JSON.stringify(out, null, 1))
