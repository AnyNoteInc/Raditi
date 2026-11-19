// Independent check of spike s8 (not the builder's harness): the edge with ALL flags of the
// `traefik` service as the YAML parser reads them from infra/app/docker-compose.yml (ACME
// resolvers included, their CA a closed port inside the container), the dynamic files of the repo
// UNCHANGED (certResolver lines kept; a certificate of our own comes in a file of its own), our own
// echo backend (not whoami), curl as the client, other host names. Then every log and /metrics are
// searched for the markers.
//   node ind-edge.mjs --repo <repo> --work <dir> [--variant all52|noheaders|keepctl|debug|trace|all]
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { parse } from 'yaml'

const run = promisify(execFile)
const { values } = parseArgs({ options: { repo: { type: 'string' }, work: { type: 'string' }, variant: { type: 'string', default: 'all' } } })
const REPO = values.repo
const WORK = values.work
const IMAGE = 'ghcr.io/traefik/traefik:v3.7.13@sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259'
const NODE_IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble'
const NET = 'spike88-s8v-ind-net'
const ECHO = 'spike88-s8v-ind-echo'
const APEX = 'cabinet.ind.test'
const DASH = 'dash.ind.test'
const PAGES = 'pages.ind.test'
const PAGE_HOST = `zyxwvutsrqponmlkjihgfedcba.${PAGES}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const docker = async (args, allowFail = false) => {
  try {
    return (await run('docker', args, { maxBuffer: 256 << 20 })).stdout
  } catch (e) {
    if (allowFail) return `${e.stdout ?? ''}${e.stderr ?? ''}`
    throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${e.stderr}`)
  }
}

// --- Flags as compose would pass them -------------------------------------------------------
const compose = parse(readFileSync(join(REPO, 'infra/app/docker-compose.yml'), 'utf8'), { merge: true })
const overlay = parse(readFileSync(join(REPO, 'infra/server/docker-compose.server.yml'), 'utf8'), { merge: true })
if (overlay.services.traefik.command) throw new Error('the server overlay changes the command')
const VARS = {
  EDGE_DASHBOARD: 'true', // infra/server/env.example
  ACME_EMAIL: 'spike-acme-placeholder', // never sent: the CA below is a closed port of the container
  ACME_CA_SERVER: 'https://127.0.0.1:9/directory',
}
const expand = (flag) =>
  flag.replace(/\$\{(\w+)(?::([-?])([^}]*))?\}/g, (_, name, op, rest) => {
    if (name in VARS) return VARS[name]
    if (op === '-') return rest
    throw new Error(`no value for ${name} in ${flag}`)
  })
const repoFlags = compose.services.traefik.command.map(expand)

// --- Files ------------------------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true })
for (const d of ['dynamic', 'certs', 'secrets', 'out']) mkdirSync(join(WORK, d), { recursive: true })
copyFileSync(join(REPO, 'infra/app/traefik/dynamic/raditi.yml'), join(WORK, 'dynamic/raditi.yml'))
copyFileSync(join(REPO, 'infra/app/traefik/dynamic/pages.yml'), join(WORK, 'dynamic/pages.yml'))
copyFileSync(join(REPO, 'infra/server/traefik/server.yml'), join(WORK, 'dynamic/server.yml'))
writeFileSync(join(WORK, 'dynamic/zz-ind-cert.yml'), 'tls:\n  certificates:\n    - certFile: /ind-certs/c.crt\n      keyFile: /ind-certs/c.key\n')
const san = [APEX, `www.${APEX}`, DASH, PAGES, `*.${PAGES}`].map((h) => `DNS:${h}`).join(',')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(WORK, 'certs/c.key'), '-out', join(WORK, 'certs/c.crt'), '-days', '1', '-subj', `/CN=${APEX}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' })
execFileSync('chmod', ['0644', join(WORK, 'certs/c.key')])
writeFileSync(join(WORK, 'secrets/dashboard-users'), `${execFileSync('htpasswd', ['-nbB', 'ind', 'ind-pass']).toString().trim()}\n`)
const CA = join(WORK, 'certs/c.crt')

// --- Variants -----------------------------------------------------------------------------------
const without = (...drop) => (f) => f.filter((x) => !drop.includes(x))
const swap = (a, b) => (f) => f.map((x) => (x === a ? b : x))
const VARIANTS = {
  all52: { about: 'all compose flags, ACME included', flags: (f) => f },
  noheaders: { about: 'the flag headers.defaultmode=drop removed (not set to keep)', flags: without('--accesslog.fields.headers.defaultmode=drop') },
  keepctl: { about: 'positive control: the query flag removed', flags: without('--accesslog.fields.queryparameters.defaultmode=drop') },
  headerskeep: { about: 'positive control of noheaders: headers.defaultmode=keep', flags: swap('--accesslog.fields.headers.defaultmode=drop', '--accesslog.fields.headers.defaultmode=keep') },
  debug: { about: 'log.level=DEBUG', flags: swap('--log.level=INFO', '--log.level=DEBUG') },
  trace: { about: 'log.level=TRACE', flags: swap('--log.level=INFO', '--log.level=TRACE') },
}

const HINTS = {
  Q01: (e) => e.RequestPath === '/a',
  Q11: (e) => e.RequestHost === DASH,
  Q12: (e) => e.RequestHost === DASH,
  Q13: (e) => e.RequestPath === '/v1/browser/stream',
  Q15: (e) => e.RequestPath === '/api/auth/verify-email',
  Q16: (e) => e.RequestPath === '/stream',
}
const mark = (id) => `IND${id}q${randomBytes(5).toString('hex')}`
async function curl(args) {
  try {
    const { stdout } = await run('curl', ['-sS', '--cacert', CA, '-D', '-', '--max-time', '8', ...args], { maxBuffer: 64 << 20 })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
const statusOf = (out) => /HTTP\/[\d.]+ (\d{3})/.exec(out)?.[1] ?? null
/** One raw exchange from Python (another client than the builder's Node one). */
async function pyRaw(port, host, lines) {
  const script = `
import socket, ssl, sys
ctx = ssl.create_default_context(cafile=sys.argv[1])
s = ctx.wrap_socket(socket.create_connection(('127.0.0.1', int(sys.argv[2]))), server_hostname=sys.argv[3])
s.sendall(sys.argv[4].encode('latin-1'))
s.settimeout(5)
data = b''
try:
    while len(data) < 2000:
        chunk = s.recv(2000)
        if not chunk: break
        data += chunk
except Exception: pass
sys.stdout.write(data[:200].decode('latin-1'))
`
  const { stdout } = await run('python3', ['-I', '-c', script, CA, String(port), host, lines])
  return stdout
}

async function runVariant(name) {
  const def = VARIANTS[name]
  const flags = def.flags(repoFlags)
  const tname = `spike88-s8v-ind-traefik-${name}`
  await docker(['rm', '-f', tname], true)
  await docker([
    'run', '-d', '--name', tname, '--network', NET,
    '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:size=1m,uid=65532,gid=65532,mode=0700', '--tmpfs', '/acme:size=1m,uid=65532,gid=65532,mode=0700',
    '--cpus', '0.5', '--memory', '256m', '--pids-limit', '256',
    '-e', `APP_DOMAIN=${APEX}`, '-e', `DASHBOARD_HOST=${DASH}`, '-e', `PAGES_ROOT_HOST=${PAGES}`, '-e', `BROWSER_STREAM_HOST=${APEX}`, '-e', `PAGES_BASE_DOMAIN=${PAGES}`,
    '-v', `${join(WORK, 'dynamic')}:/etc/traefik/dynamic:ro`, '-v', `${join(WORK, 'certs')}:/ind-certs:ro`, '-v', `${join(WORK, 'secrets')}:/run/raditi:ro`,
    '-p', '127.0.0.1::8000', '-p', '127.0.0.1::8443', '-p', '127.0.0.1::9000',
    IMAGE, ...flags,
  ])
  const port = async (p) => Number((await docker(['port', tname, `${p}/tcp`])).split('\n').find((l) => l.startsWith('127.0.0.1:')).split(':')[1])
  const P = { http: await port(8000), https: await port(8443), internal: await port(9000) }
  const at = (host) => ['--connect-to', `${host}:443:127.0.0.1:${P.https}`]
  for (let i = 0; i < 80; i++) {
    const r = await curl([...at(APEX), '-o', '/dev/null', `https://${APEX}/__ready`])
    if (statusOf(r.out) === '200') break
    await sleep(500)
  }
  const cases = [
    ['Q01', 'GET /a?k= HTTP/1.1', (m) => curl([...at(APEX), '--http1.1', `https://${APEX}/a?k=${m}`])],
    ['Q02', 'GET /a?k= HTTP/2', (m) => curl([...at(APEX), '--http2', `https://${APEX}/a-q02?k=${m}`])],
    ['Q03', 'HEAD', (m) => curl([...at(APEX), '-I', `https://${APEX}/a-q03?k=${m}`])],
    ['Q04', 'POST /api/trpc body small', (m) => curl([...at(APEX), '-X', 'POST', '--data', '{}', `https://${APEX}/api/trpc/q04?k=${m}`])],
    ['Q05', 'POST /api/ body 600 KiB', (m) => curl([...at(APEX), '-X', 'POST', '-H', 'content-type: text/plain', '--data-binary', `@${join(WORK, 'out/big.txt')}`, `https://${APEX}/api/q05?k=${m}`])],
    ['Q06', 'www -> apex', (m) => curl([...at(`www.${APEX}`), `https://www.${APEX}/a-q06?k=${m}`])],
    ['Q07', 'http -> https', (m) => curl(['--connect-to', `${APEX}:80:127.0.0.1:${P.http}`, `http://${APEX}/a-q07?k=${m}`])],
    ['Q08', 'unknown host 404', (m) => curl(['--connect-to', `other.ind.test:443:127.0.0.1:${P.https}`, '-k', `https://other.ind.test/a-q08?k=${m}`])],
    ['Q09', 'page host /v/<p>', (m, p) => curl([...at(PAGE_HOST), `https://${PAGE_HOST}/v/${p}?k=${m}`])],
    ['Q10', 'pages root /v/<p>', (m, p) => curl([...at(PAGES), `https://${PAGES}/v/${p}?k=${m}`])],
    ['Q11', 'dashboard 401', (m) => curl([...at(DASH), `https://${DASH}/api/rawdata?k=${m}`])],
    ['Q12', 'dashboard 200 with auth', (m) => curl([...at(DASH), '-u', 'ind:ind-pass', '-o', '/dev/null', `https://${DASH}/api/rawdata?k=${m}`])],
    ['Q13', 'browser stream websocket 502', (m) => curl([...at(APEX), '--http1.1', '-H', 'Connection: Upgrade', '-H', 'Upgrade: websocket', '-H', 'Sec-WebSocket-Version: 13', '-H', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `https://${APEX}/v1/browser/stream?k=${m}`])],
    ['Q14', 'reset-password path', (m, p) => curl([...at(APEX), `https://${APEX}/api/auth/reset-password/${p}?k=${m}`])],
    ['Q15', 'verify-email?token=', (m) => curl([...at(APEX), `https://${APEX}/api/auth/verify-email?token=${m}`])],
    ['Q16', 'client aborts a stream', (m) => curl([...at(APEX), '--max-time', '1', '-o', '/dev/null', `https://${APEX}/stream?k=${m}`])],
    ['Q17', 'token in Cookie, Referer, Authorization, X-Raditi-Path', (m) => curl([...at(APEX), '-H', `Cookie: __Host-raditi_share=${m}`, '-H', `Referer: https://${APEX}/a?k=${m}`, '-H', `Authorization: Bearer ${m}`, '-H', `x-raditi-path: /a?k=${m}`, `https://${APEX}/a-q17`])],
    ['Q18', 'TRACE: Cookie on reset route', (m, p) => curl([...at(APEX), '-H', `Cookie: better-auth.session_token=${m}`, `https://${APEX}/api/auth/reset-password/${p}`])],
    ['Q19', 'raw # in path (python)', async (m) => pyRaw(P.https, APEX, `GET /a-q19#${m} HTTP/1.1\r\nHost: ${APEX}\r\nConnection: close\r\n\r\n`)],
    ['Q20', 'raw ? then # (python)', async (m) => pyRaw(P.https, APEX, `GET /a-q20?k=${m}#frag HTTP/1.1\r\nHost: ${APEX}\r\nConnection: close\r\n\r\n`)],
    ['Q21', 'percent-encoded ? in the path (%3F)', (m) => curl([...at(APEX), `https://${APEX}/a%3Fk=${m}`])],
  ]
  const results = []
  for (const [id, about, fn] of cases) {
    const m = mark(id)
    const p = `INDPATH${id}${randomBytes(4).toString('hex')}`
    const r = await fn(m, p)
    const out = typeof r === 'string' ? r : r.out
    results.push({ id, about, m, p, status: statusOf(out), backendGotQuery: out.includes(m), location: /^location: (.*)$/im.exec(out)?.[1]?.trim()?.replace(m, '<m>') ?? null })
    await sleep(100)
  }
  await sleep(1500)
  const tlog = await docker(['logs', tname], true)
  const elog = await docker(['logs', ECHO], true)
  const metrics = await fetch(`http://127.0.0.1:${P.internal}/metrics`).then((r) => r.text(), () => '')
  writeFileSync(join(WORK, 'out', `${name}.traefik.log`), tlog)
  const levels = {}
  const general = []
  const access = []
  for (const line of tlog.split('\n').filter(Boolean)) {
    let e
    try { e = JSON.parse(line) } catch { e = { raw: line } }
    if ('DownstreamStatus' in e) access.push(e)
    else {
      levels[e.level ?? 'raw'] = (levels[e.level ?? 'raw'] ?? 0) + 1
      general.push(e)
    }
  }
  for (const r of results) {
    r.inTraefikLog = tlog.includes(r.m)
    r.inEchoLog = elog.includes(r.m)
    r.inMetrics = metrics.includes(r.m)
    r.pathInLog = tlog.includes(r.p)
    const hint = HINTS[r.id]
    r.accessLines = access.filter((e) => {
      const t = JSON.stringify(e)
      if (t.includes(r.m) || t.includes(r.p)) return true
      if (typeof hint === 'function') return hint(e)
      return t.includes(hint ?? r.id.toLowerCase())
    }).length
    r.generalWithMarker = general.filter((e) => JSON.stringify(e).includes(r.m)).map((e) => `${e.level}: ${String(e.message ?? e.raw).slice(0, 140).replace(r.m, '<m>')}`)
  }
  const metricLabels = [...new Set([...metrics.matchAll(/^traefik_\w+\{([^}]*)\}/gm)].flatMap(([, l]) => [...l.matchAll(/(\w+)="/g)].map(([, k]) => k)))].sort()
  const acmeErrors = general.filter((e) => /acme|resolver|certificate/i.test(JSON.stringify(e)) && e.level !== 'debug').map((e) => `${e.level}: ${String(e.message ?? e.error ?? '').slice(0, 120)}`)
  const routerErrors = general.filter((e) => /router|nonexistent/i.test(JSON.stringify(e)) && ['error', 'warn'].includes(e.level)).map((e) => `${e.level}: ${String(e.message ?? '').slice(0, 120)} ${String(e.error ?? '').slice(0, 120)}`)
  await docker(['rm', '-f', tname], true)
  return { variant: name, about: def.about, flagCount: flags.length, levels, metricLabels, acmeErrors, routerErrors, results: results.map(({ m, p, ...rest }) => rest) }
}

writeFileSync(join(WORK, 'out/big.txt'), 'y'.repeat(600 * 1024))
await docker(['network', 'create', NET], true)
await docker(['rm', '-f', ECHO], true)
await docker(['run', '-d', '--name', ECHO, '--network', NET, '--network-alias', 'web', '--network-alias', 'preview', '-v', `${join(process.cwd(), 'echo.mjs')}:/echo.mjs:ro`, NODE_IMAGE, 'node', '/echo.mjs'])
await sleep(1500)
const chosen = values.variant === 'all' ? Object.keys(VARIANTS) : values.variant.split(',')
const all = { repoFlagCount: repoFlags.length, overlayChangesCommand: false, variants: [] }
for (const v of chosen) {
  const out = await runVariant(v)
  all.variants.push(out)
  console.log(`\n== ${v} (${out.flagCount} flags): ${out.about}; levels ${JSON.stringify(out.levels)}`)
  for (const r of out.results)
    console.log(`${r.id} ${r.status} backendGotQuery:${r.backendGotQuery} traefik:${r.inTraefikLog} echo:${r.inEchoLog} metrics:${r.inMetrics} pathInLog:${r.pathInLog} access:${r.accessLines} ${r.location ? `loc:${r.location}` : ''} ${r.generalWithMarker.join(' | ')}`)
  if (out.acmeErrors.length) console.log('acme:', out.acmeErrors.slice(0, 4).join(' || '))
  if (out.routerErrors.length) console.log('router:', out.routerErrors.slice(0, 4).join(' || '))
  console.log('labels:', out.metricLabels.join(','))
}
writeFileSync(join(WORK, 'out/ind-edge.json'), `${JSON.stringify(all, null, 2)}\n`)
await docker(['rm', '-f', ECHO], true)
await docker(['network', 'rm', NET], true)
