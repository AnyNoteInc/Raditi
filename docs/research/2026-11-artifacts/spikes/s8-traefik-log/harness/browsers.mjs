// Spike s8: does the fragment of /a#<token> ever reach the server? Chromium and WebKit of
// Playwright 1.63.0 on macOS, then Firefox, Chromium and WebKit of the Linux image in Docker, then
// curl, Node fetch and Python urllib. The edge is the repo's Traefik with the repo's flags.
//   node browsers.mjs --run <run> [--keep]
// Results: <run>/results/browsers.json.
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { chromium, firefox, webkit } from 'playwright-core'

import { browserChecks, marks, plainHttpChecks, requestLineOf } from './checks.mjs'
import { docker, logsOf, NET, sleep } from './lib.mjs'
import { startProxy, startRecorder } from './proxy.mjs'
import { backends, removeBackends, traefik } from './stand.mjs'

const run = promisify(execFile)
const { values } = parseArgs({ options: { run: { type: 'string' }, keep: { type: 'boolean' } } })
const RUN = values.run
const HARNESS = new URL('.', import.meta.url).pathname
const stand = JSON.parse(readFileSync(join(RUN, 'stand.json'), 'utf8'))
const CA = join(RUN, 'tls/spike.crt')
const APEX = stand.hosts.APP_DOMAIN
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble'
const { all: markers, mark } = marks()

async function clientChecks(proxyPort) {
  const results = {}
  const env = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '' }
  const curlToken = mark('F', 'cu')
  const curl = await run('curl', ['-sS', '--proxy', `http://127.0.0.1:${proxyPort}`, '--cacert', CA, `https://${APEX}/a#${curlToken}`], { env })
  results.curl = { backendRequestLine: requestLineOf(curl.stdout), backendSawToken: curl.stdout.includes(curlToken), version: (await run('curl', ['-V'])).stdout.split('\n')[0] }
  const nodeToken = mark('F', 'nf')
  const node = await run(process.execPath, ['-e', `fetch(${JSON.stringify(`https://${APEX}/a#${nodeToken}`)}).then((r) => r.text()).then((t) => process.stdout.write(t))`], {
    env: { ...env, NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: CA },
  })
  results.nodeFetch = { backendRequestLine: requestLineOf(node.stdout), backendSawToken: node.stdout.includes(nodeToken), version: process.version }
  const pyToken = mark('F', 'py')
  const script = [
    'import ssl, sys, urllib.request',
    `ctx = ssl.create_default_context(cafile=${JSON.stringify(CA)})`,
    `proxy = urllib.request.ProxyHandler({'https': 'http://127.0.0.1:${proxyPort}'})`,
    'opener = urllib.request.build_opener(proxy, urllib.request.HTTPSHandler(context=ctx))',
    `sys.stdout.write(opener.open(${JSON.stringify(`https://${APEX}/a#${pyToken}`)}).read().decode())`,
  ].join('\n')
  const py = await run('python3', ['-I', '-c', script], { env })
  results.pythonUrllib = { backendRequestLine: requestLineOf(py.stdout), backendSawToken: py.stdout.includes(pyToken), version: (await run('python3', ['-V'])).stdout.trim() }
  return results
}

await backends()
const { name, ports } = await traefik(RUN, stand, 'browsers', { flags: (f) => f })
const proxy = await startProxy({ hosts: [APEX, `www.${APEX}`], ports })
const recorder = await startRecorder()
const browsers = []
const plain = []
for (const [type, label] of [[chromium, 'chromium'], [webkit, 'webkit'], [firefox, 'firefox']]) {
  try {
    browsers.push({ platform: 'macos', ...(await browserChecks({ type, name: label, proxyPort: proxy.port, apex: APEX, mark })) })
    plain.push({ platform: 'macos', ...(await plainHttpChecks({ type, name: label, recorder, mark })) })
  } catch (error) {
    browsers.push({ platform: 'macos', browser: label, error: String(error).split('\n').slice(0, 8).join(' | ').slice(0, 400) })
  }
}
const clients = await clientChecks(proxy.port)

// Linux: the image's browsers on the stand's network; the harness (with playwright-core) mounted.
const linux = await docker([
  'run', '--rm', '--name', 'spike88-s8-browsers', '--network', NET, '--ipc=host', '--init',
  '-v', `${HARNESS}:/harness:ro`, '-w', '/harness', PLAYWRIGHT_IMAGE,
  'node', 'in-docker.mjs', '--traefik', name, '--apex', APEX,
], { allowFail: true })
let inDocker = { error: linux.stderr.slice(0, 2000) }
try {
  inDocker = JSON.parse(linux.stdout.trim().split('\n').at(-1))
} catch {}
markers.push(...(inDocker.markers ?? []))

await sleep(1500)
const t = await logsOf(name)
const web = await logsOf('spike88-s8-web')
const streams = {
  'traefik stdout': t.stdout,
  'traefik stderr': t.stderr,
  'web (whoami) logs': web.stdout + web.stderr,
  'edge proxy (macOS) request lines': proxy.seen.map((s) => s.line).join('\n'),
  'edge proxy (Linux) request lines': (inDocker.proxySeen ?? []).map((s) => s.line).join('\n'),
}
const found = {}
for (const m of markers) {
  const where = Object.entries(streams).filter(([, text]) => text.includes(m)).map(([s]) => s)
  if (where.length) found[m] = where
}
const accessPaths = t.stdout.split('\n').filter((l) => l.includes('"RequestPath"')).map((l) => JSON.parse(l).RequestPath)
const out = {
  image: stand.image,
  playwrightImage: PLAYWRIGHT_IMAGE,
  browsers: [...browsers, ...(inDocker.browsers ?? [])],
  plainHttp: [...plain, ...(inDocker.plain ?? [])],
  clients,
  linuxNode: inDocker.node,
  linuxError: inDocker.error,
  markers: markers.length,
  markersInEdgeLogs: found,
  proxySeen: { macos: proxy.seen, linux: inDocker.proxySeen },
  accessPaths,
}
writeFileSync(join(RUN, 'results', 'browsers.json'), `${JSON.stringify(out, null, 2)}\n`)
writeFileSync(join(RUN, 'logs', 'browsers.traefik.stdout.log'), t.stdout)
console.log(JSON.stringify({ ...out, proxySeen: undefined, accessPaths: accessPaths.length }, null, 2))
proxy.close()
recorder.close()
if (!values.keep) {
  await docker(['rm', '-f', name], { allowFail: true })
  await removeBackends()
}
