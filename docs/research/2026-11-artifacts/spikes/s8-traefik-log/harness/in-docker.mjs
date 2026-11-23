// The Linux side of spike s8, run inside mcr.microsoft.com/playwright:v1.63.0-noble on the stand's
// network: the same checks for Firefox, Chromium and WebKit of the image. Prints one JSON object.
//   node in-docker.mjs --traefik <container> --apex <host>
import { parseArgs } from 'node:util'

import { chromium, firefox, webkit } from 'playwright-core'

import { browserChecks, marks, plainHttpChecks } from './checks.mjs'
import { startProxy, startRecorder } from './proxy.mjs'

const { values } = parseArgs({ options: { traefik: { type: 'string' }, apex: { type: 'string' } } })
const { all, mark } = marks()
const apex = values.apex
const proxy = await startProxy({ hosts: [apex, `www.${apex}`], ports: { https: 8443, http: 8000 }, upstreamHost: values.traefik })
const recorder = await startRecorder()
const browsers = []
const plain = []
for (const [type, name] of [[firefox, 'firefox'], [chromium, 'chromium'], [webkit, 'webkit']]) {
  try {
    browsers.push({ platform: 'linux', ...(await browserChecks({ type, name, proxyPort: proxy.port, apex, mark })) })
  } catch (error) {
    browsers.push({ platform: 'linux', browser: name, error: String(error).slice(0, 400) })
  }
  try {
    plain.push({ platform: 'linux', ...(await plainHttpChecks({ type, name, recorder, mark })) })
  } catch (error) {
    plain.push({ platform: 'linux', browser: name, error: String(error).slice(0, 400) })
  }
}
proxy.close()
recorder.close()
process.stdout.write(`${JSON.stringify({ browsers, plain, markers: all, proxySeen: proxy.seen, node: process.version })}\n`)
