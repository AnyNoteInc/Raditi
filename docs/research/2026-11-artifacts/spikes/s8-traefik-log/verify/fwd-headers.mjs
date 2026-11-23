// What Traefik (all compose flags) forwards to web about the client: X-Forwarded-*, X-Real-Ip.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
const [REPO, WORK] = process.argv.slice(2)
const d = (...a) => execFileSync('docker', a, { encoding: 'utf8' })
const compose = parse(readFileSync(join(REPO, 'infra/app/docker-compose.yml'), 'utf8'), { merge: true })
const VARS = { EDGE_DASHBOARD: 'true', ACME_EMAIL: 'spike-acme-placeholder', ACME_CA_SERVER: 'https://127.0.0.1:9/directory' }
const flags = compose.services.traefik.command.map((f) => f.replace(/\$\{(\w+)(?::([-?])([^}]*))?\}/g, (_, n, op, rest) => VARS[n] ?? rest))
try { d('network', 'create', 'spike88-s8v-fwd-net') } catch {}
try { d('rm', '-f', 'spike88-s8v-fwd-echo', 'spike88-s8v-fwd-traefik') } catch {}
d('run', '-d', '--name', 'spike88-s8v-fwd-echo', '--network', 'spike88-s8v-fwd-net', '--network-alias', 'web', '-v', `${process.cwd()}/echo.mjs:/echo.mjs:ro`, 'mcr.microsoft.com/playwright:v1.63.0-noble', 'node', '/echo.mjs')
d('run', '-d', '--name', 'spike88-s8v-fwd-traefik', '--network', 'spike88-s8v-fwd-net', '--user', '65532:65532', '--read-only', '--tmpfs', '/tmp:size=1m,uid=65532', '--tmpfs', '/acme:size=1m,uid=65532',
  '-e', 'APP_DOMAIN=cabinet.ind.test', '-e', 'DASHBOARD_HOST=dash.ind.test', '-e', 'PAGES_ROOT_HOST=pages.ind.test', '-e', 'BROWSER_STREAM_HOST=cabinet.ind.test', '-e', 'PAGES_BASE_DOMAIN=pages.ind.test',
  '-v', `${WORK}/dynamic:/etc/traefik/dynamic:ro`, '-v', `${WORK}/certs:/ind-certs:ro`, '-v', `${WORK}/secrets:/run/raditi:ro`, '-p', '127.0.0.1::8443',
  'ghcr.io/traefik/traefik:v3.7.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259', ...flags)
const port = d('port', 'spike88-s8v-fwd-traefik', '8443/tcp').split('\n').find((l) => l.startsWith('127.0.0.1')).split(':')[1].trim()
let body = ''
for (let i = 0; i < 60; i++) {
  try { body = execFileSync('curl', ['-sS', '--cacert', `${WORK}/certs/c.crt`, '--connect-to', `cabinet.ind.test:443:127.0.0.1:${port}`, '--local-port', '50123', '-H', 'X-Forwarded-For: 203.0.113.9', '-H', 'X-Forwarded-Port: 1234', 'https://cabinet.ind.test/a'], { encoding: 'utf8' }); if (body.startsWith('GET')) break } catch {}
  execFileSync('sleep', ['0.5'])
}
console.log(body.split('\n').filter((l) => /^(GET|X-Forwarded|X-Real|Forwarded)/i.test(l)).join('\n'))
const log = d('logs', 'spike88-s8v-fwd-traefik').split('\n').filter((l) => l.includes('"RequestPath":"/a"')).at(-1)
const e = JSON.parse(log)
console.log('access line:', JSON.stringify({ ClientAddr: e.ClientAddr, ClientHost: e.ClientHost, ClientPort: e.ClientPort, StartUTC: e.StartUTC, RequestPath: e.RequestPath }))
d('rm', '-f', 'spike88-s8v-fwd-echo', 'spike88-s8v-fwd-traefik'); d('network', 'rm', 'spike88-s8v-fwd-net')
