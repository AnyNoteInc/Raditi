// Spike s8 (plan 88, Э0а): builds the run directory of the stand from the repository files.
//   node prepare.mjs --repo <repo> --out <run>
// What it takes as is: the static flags of the `traefik` service of infra/app/docker-compose.yml
// (EDGE_DASHBOARD as on the single server, infra/server/env.example), the dynamic files
// infra/app/traefik/dynamic/{raditi,pages}.yml and infra/server/traefik/server.yml, the image
// digest of infra/server/env.example. What it changes, and only that: the ACME resolvers (no CA
// here) — the flags `--certificatesresolvers.*` are left out and every router's
// `tls: { certResolver, domains }` becomes `tls: {}`; a self-signed certificate for the synthetic
// hosts comes in a file of its own (spike-tls.yml), so `sniStrict: true` stays as it is.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' } } })
if (!values.repo || !values.out) throw new Error('usage: node prepare.mjs --repo <repo> --out <run>')
const repo = values.repo
const out = values.out

export const HOSTS = {
  APP_DOMAIN: 'cabinet.example.test',
  DASHBOARD_HOST: 'dash.example.test',
  PAGES_ROOT_HOST: 'pages.example.test',
  PAGES_BASE_DOMAIN: 'pages.example.test',
  BROWSER_STREAM_HOST: 'cabinet.example.test',
}

// --- Static flags of the `traefik` service ---------------------------------------------------
const compose = readFileSync(join(repo, 'infra/app/docker-compose.yml'), 'utf8')
const service = compose.slice(compose.indexOf('\n  traefik:\n'))
const commandBlock = service.slice(service.indexOf('    command:\n'), service.indexOf('    environment:\n'))
const flags = [...commandBlock.matchAll(/^ {6}- (--.+)$/gm)].map(([, flag]) => flag.trim())
const items = [...commandBlock.matchAll(/^ {6}- /gm)].length
if (flags.length < 30 || flags.length !== items) throw new Error(`${flags.length} flags of ${items} items`)
const serverEnv = readFileSync(join(repo, 'infra/server/env.example'), 'utf8')
const dashboard = /^EDGE_DASHBOARD=(\S+)$/m.exec(serverEnv)?.[1] ?? 'false'
const image = /^TRAEFIK_IMAGE=(\S+)$/m.exec(serverEnv)?.[1]
if (!image) throw new Error('TRAEFIK_IMAGE is not in infra/server/env.example')
const left = []
const kept = []
for (const flag of flags) {
  if (flag.startsWith('--certificatesresolvers.')) {
    left.push(flag)
    continue
  }
  const value = flag.replace('${EDGE_DASHBOARD:-false}', dashboard)
  if (/\$\{/.test(value)) throw new Error(`unexpanded variable in ${flag}`)
  kept.push(value)
}
for (const must of [
  '--accesslog=true',
  '--accesslog.format=json',
  '--accesslog.fields.queryparameters.defaultmode=drop',
  '--accesslog.fields.headers.defaultmode=drop',
])
  if (!kept.includes(must)) throw new Error(`${must} is not among the repo flags`)

// --- Dynamic files ---------------------------------------------------------------------------
/** `tls:` with only certResolver/domains under it becomes `tls: {}`: no ACME in the spike. */
function withoutAcme(text) {
  const lines = text.split('\n')
  const result = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)tls:\s*$/.exec(lines[i])
    if (!open) {
      result.push(lines[i])
      continue
    }
    const indent = open[1].length
    let j = i + 1
    while (j < lines.length && /^\s*(certResolver|domains):/.test(lines[j]) && lines[j].search(/\S/) > indent) j++
    if (j === i + 1) {
      result.push(lines[i]) // the top-level `tls:` of options, kept
      continue
    }
    result.push(`${open[1]}tls: {}`)
    i = j - 1
  }
  return result.join('\n')
}

rmSync(out, { recursive: true, force: true })
for (const dir of ['dynamic', 'tls', 'secrets', 'logs']) mkdirSync(join(out, dir), { recursive: true })
const dynamic = {
  'raditi.yml': 'infra/app/traefik/dynamic/raditi.yml',
  'pages.yml': 'infra/app/traefik/dynamic/pages.yml',
  'server.yml': 'infra/server/traefik/server.yml',
}
const changed = {}
for (const [name, source] of Object.entries(dynamic)) {
  const text = readFileSync(join(repo, source), 'utf8')
  const spike = withoutAcme(text)
  changed[name] = text.split('\n').length - spike.split('\n').length
  writeFileSync(join(out, 'dynamic', name), spike)
}
writeFileSync(
  join(out, 'dynamic', 'spike-tls.yml'),
  'tls:\n  certificates:\n    - certFile: /spike-tls/spike.crt\n      keyFile: /spike-tls/spike.key\n',
)

// --- A certificate for the synthetic hosts, the dashboard's users ---------------------------
const san = [
  HOSTS.APP_DOMAIN,
  `www.${HOSTS.APP_DOMAIN}`,
  HOSTS.DASHBOARD_HOST,
  HOSTS.PAGES_ROOT_HOST,
  `*.${HOSTS.PAGES_BASE_DOMAIN}`,
]
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
  '-keyout', join(out, 'tls/spike.key'), '-out', join(out, 'tls/spike.crt'), '-days', '2',
  '-subj', `/CN=${HOSTS.APP_DOMAIN}`, '-addext', `subjectAltName=${san.map((h) => `DNS:${h}`).join(',')}`,
], { stdio: 'ignore' })
execFileSync('chmod', ['0644', join(out, 'tls/spike.key')])
const users = execFileSync('htpasswd', ['-nbB', 'spike', 'spike-dashboard-pass']).toString().trim()
writeFileSync(join(out, 'secrets', 'dashboard-users'), `${users}\n`, { mode: 0o644 })

const stand = { image, hosts: HOSTS, flags: kept, leftOut: left, dynamicLinesRemoved: changed, dashboard }
writeFileSync(join(out, 'stand.json'), `${JSON.stringify(stand, null, 2)}\n`)
console.log(JSON.stringify({ image, flags: kept.length, leftOut: left.length, changed }, null, 2))
