// Spike s8 (plan 88, Э0а, for Э10): is the query of /a?k=… written to any log of the edge?
//   node edge.mjs --run <run> [--only prod,keep,...] [--keep]
// Traefik is the repo's image and static flags (prepare.mjs), web and preview are whoami. Each
// variant starts its own Traefik, sends the cases, then reads every log and the metrics and looks
// for the markers. Results: <run>/results/<variant>.json and a summary on stdout.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { docker, h2Exchange, lines, logsOf, marker, rawExchange, sleep, trustCa } from './lib.mjs'
import { backends, get, removeBackends, traefik } from './stand.mjs'

const { values } = parseArgs({
  options: { run: { type: 'string' }, only: { type: 'string' }, keep: { type: 'boolean' } },
})
if (!values.run) throw new Error('usage: node edge.mjs --run <run>')
const RUN = values.run
const stand = JSON.parse(readFileSync(join(RUN, 'stand.json'), 'utf8'))
trustCa(readFileSync(join(RUN, 'tls/spike.crt'), 'utf8'))
const { APP_DOMAIN: APEX, DASHBOARD_HOST: DASH, PAGES_ROOT_HOST: PAGES_ROOT } = stand.hosts
const PAGE_HOST = `abcdefghijklmnopqrstuvwxyz.${stand.hosts.PAGES_BASE_DOMAIN}`
const WWW = `www.${APEX}`
const QUERY_DROP = '--accesslog.fields.queryparameters.defaultmode=drop'

// --- Variants: what differs from the repo's configuration -----------------------------------
const SHARE_ROUTE = `http:
  routers:
    web-share-link:
      entryPoints: [websecure]
      rule: 'Host(\`{{ env "APP_DOMAIN" }}\`) && Path(\`/a\`)'
      priority: 1000
      service: web
      tls: {}
      observability: { accessLogs: false }
`
const REWRITE_ROUTE = `http:
  routers:
    web-share-rewrite:
      entryPoints: [websecure]
      rule: 'Host(\`{{ env "APP_DOMAIN" }}\`) && PathPrefix(\`/a\`)'
      priority: 1000
      middlewares: [share-rewrite]
      service: web
      tls: {}
  middlewares:
    share-rewrite:
      replacePathRegex: { regex: '^/a(.*)$', replacement: '/b$1' }
`
const swap = (flag, by) => (flags) => flags.map((f) => (f === flag ? by : f)).filter(Boolean)
const add = (...extra) => (flags) => [...flags, ...extra]
const VARIANTS = {
  prod: { about: 'the repo flags as they are', flags: (f) => f, cases: 'all' },
  keep: { about: 'no queryparameters flag (Traefik default: keep)', flags: swap(QUERY_DROP, null) },
  redact: { about: 'queryparameters.defaultmode=redact (not a value of this option)', flags: swap(QUERY_DROP, '--accesslog.fields.queryparameters.defaultmode=redact') },
  Drop: { about: 'queryparameters.defaultmode=Drop (capital D)', flags: swap(QUERY_DROP, '--accesslog.fields.queryparameters.defaultmode=Drop') },
  common: { about: 'format=common (CLF), query drop', flags: swap('--accesslog.format=json', '--accesslog.format=common') },
  genericCLF: { about: 'format=genericCLF, query drop', flags: swap('--accesslog.format=json', '--accesslog.format=genericCLF') },
  'common-keep': { about: 'format=common, no queryparameters flag', flags: (f) => swap(QUERY_DROP, null)(swap('--accesslog.format=json', '--accesslog.format=common')(f)) },
  'path-drop': { about: 'no queryparameters flag, fields.names.RequestPath=drop', flags: (f) => add('--accesslog.fields.names.RequestPath=drop')(swap(QUERY_DROP, null)(f)) },
  'route-off': { about: 'no queryparameters flag, a router for Path(/a) with accessLogs: false', flags: swap(QUERY_DROP, null), extra: { 'spike-share.yml': SHARE_ROUTE } },
  rewrite: { about: 'no queryparameters flag, replacePathRegex on PathPrefix(/a)', flags: swap(QUERY_DROP, null), extra: { 'spike-rewrite.yml': REWRITE_ROUTE } },
  'headers-keep': { about: 'query drop, but headers.defaultmode=keep', flags: swap('--accesslog.fields.headers.defaultmode=drop', '--accesslog.fields.headers.defaultmode=keep') },
  file: { about: 'query drop, accesslog.filepath=/var/log/traefik/access.log', flags: add('--accesslog.filepath=/var/log/traefik/access.log'), file: '/var/log/traefik/access.log' },
  dup: { about: 'the repo flags and a second queryparameters flag =keep after them', flags: add('--accesslog.fields.queryparameters.defaultmode=keep') },
  'dup-first': { about: 'a queryparameters flag =keep before the repo flags', flags: (f) => ['--accesslog.fields.queryparameters.defaultmode=keep', ...f] },
  debug: { about: 'the repo flags with log.level=DEBUG', flags: swap('--log.level=INFO', '--log.level=DEBUG'), cases: 'all' },
  trace: { about: 'the repo flags with log.level=TRACE', flags: swap('--log.level=INFO', '--log.level=TRACE'), cases: 'all' },
}
const SUBSET = ['P01', 'P02', 'P03', 'P08', 'P10', 'P11', 'P13', 'P16', 'P26']

// --- Cases -----------------------------------------------------------------------------------

/** Each case: what it sends; `m` — markers that must never be logged; `path` — the logged path. */
function cases(ports) {
  const https = (host, request, more = {}) => rawExchange({ port: ports.https, servername: host, request, ...more })
  const list = []
  const c = (id, about, fn, hint = `-${id.toLowerCase()}`) => list.push({ id, about, fn, hint })

  c('P01', 'GET /a?k=… (HTTP/1.1)', async (m) => https(APEX, get(APEX, `/a?k=${m.q}`)))
  c('P02', 'GET /a?k=… (HTTP/2)', async (m) =>
    h2Exchange({ port: ports.https, servername: APEX, headers: { ':method': 'GET', ':path': `/a-p02?k=${m.q}`, ':authority': APEX } }))
  c('P03', 'several parameters', async (m) => https(APEX, get(APEX, `/a-p03?x=1&k=${m.q}&y=2`)))
  c('P04', 'bare query without =', async (m) => https(APEX, get(APEX, `/a-p04?${m.q}`)))
  c('P05', 'semicolon in the query', async (m) => https(APEX, get(APEX, `/a-p05?k=${m.q};x=1`)))
  c('P06', 'invalid percent-escape in the query', async (m) => https(APEX, get(APEX, `/a-p06?k=%ZZ${m.q}`)))
  c('P07', 'long query (8 KiB)', async (m) => https(APEX, get(APEX, `/a-p07?k=${m.q}&pad=${'x'.repeat(8192)}`)))
  c('P08', 'www → apex redirect (301)', async (m) => https(WWW, get(WWW, `/a-p08?k=${m.q}`)))
  c('P09', 'HTTP entry point → https (301)', async (m) =>
    rawExchange({ port: ports.http, plain: true, request: get(APEX, `/a-p09?k=${m.q}`) }))
  c('P10', 'no router for the Host (404)', async (m) => https(APEX, get('other.example.test', `/a-p10?k=${m.q}`)))
  c('P11', 'POST /api/… over the body limit, with Content-Length (413)', async (m) => {
    const body = 'x'.repeat(600 * 1024)
    return https(APEX, `POST /api/a-p11?k=${m.q} HTTP/1.1\r\nHost: ${APEX}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
  })
  c('P12', 'POST /api/… chunked over the limit (413)', async (m) => {
    const chunk = 'x'.repeat(64 * 1024)
    const parts = [`POST /api/a-p12?k=${m.q} HTTP/1.1\r\nHost: ${APEX}\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`]
    for (let i = 0; i < 11; i++) parts.push(`${chunk.length.toString(16)}\r\n${chunk}\r\n`)
    parts.push('0\r\n\r\n')
    return https(APEX, parts)
  })
  c('P13', 'encoded slash in the path (400)', async (m) => https(APEX, get(APEX, `/a-p13%2Fb?k=${m.q}`)))
  c('P14', '/api/metrics at the edge (403)', async (m) => https(APEX, get(APEX, `/api/metrics?k=${m.q}`)), '/api/metrics')
  c('P15', 'reset-password router (no access log)', async (m) => https(APEX, get(APEX, `/api/auth/reset-password/${m.p}?k=${m.q}`)), 'reset-password')
  c('P16', 'upstream down: the browser stream route (502)', async (m) => https(APEX, get(APEX, `/v1/browser/stream?k=${m.q}`)), '/v1/browser/stream')
  c('P17', 'page host /v/<path token> (preview)', async (m) => https(PAGE_HOST, get(PAGE_HOST, `/v/${m.p}?k=${m.q}`)))
  c('P18', 'pages root /v/<path token> (web)', async (m) => https(PAGES_ROOT, get(PAGES_ROOT, `/v/${m.p}?k=${m.q}`)))
  c('P19', 'dashboard without auth (401)', async (m) => https(DASH, get(DASH, `/api/rawdata?k=${m.q}`)), '/api/rawdata')
  c('P20', 'raw "#" in the request target', async (m) => https(APEX, get(APEX, `/a-p20#${m.q}`)))
  c('P21', 'raw "?k=…#…" in the request target', async (m) => https(APEX, get(APEX, `/a-p21?k=${m.q}#${m.f}`)))
  c('P22', 'absolute-form request target', async (m) => https(APEX, get(APEX, `https://${APEX}/a-p22?k=${m.q}`)))
  c('P23', 'HTTP/2 :path with "#"', async (m) =>
    h2Exchange({ port: ports.https, servername: APEX, headers: { ':method': 'GET', ':path': `/a-p23#${m.q}`, ':authority': APEX } }))
  c('P24', 'client aborts a streamed answer', async (m) =>
    https(APEX, get(APEX, `/data?size=200&unit=MB&k=${m.q}`), { abortAfterBytes: 4096 }), '"/data"')
  c('P25', 'HEAD /a?k=…', async (m) => https(APEX, `HEAD /a-p25?k=${m.q} HTTP/1.1\r\nHost: ${APEX}\r\nConnection: close\r\n\r\n`))
  c('P26', 'token in Referer, Cookie and User-Agent', async (m) =>
    https(APEX, `GET /a-p26 HTTP/1.1\r\nHost: ${APEX}\r\nReferer: https://${APEX}/a?k=${m.q}\r\nCookie: __Host-raditi_share=${m.q}\r\nUser-Agent: ${m.q}\r\nConnection: close\r\n\r\n`))
  c('P27', 'token in a POST body to /api/trpc', async (m) => {
    const body = JSON.stringify({ '0': { json: { token: m.q } } })
    return https(APEX, `POST /api/trpc/artifact.share.open HTTP/1.1\r\nHost: ${APEX}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
  }, 'artifact.share.open')
  c('P28', 'headers over maxheaderbytes (431)', async (m) =>
    https(APEX, get(APEX, `/a-p28?k=${m.q}`, `X-Pad: ${'y'.repeat(40 * 1024)}\r\n`)))
  c('P29', 'unknown HTTP version', async (m) => https(APEX, `GET /a-p29?k=${m.q} HTTP/9.9\r\nHost: ${APEX}\r\nConnection: close\r\n\r\n`))
  c('P30', 'space in the request target', async (m) => https(APEX, `GET /a-p30?k=${m.q} x HTTP/1.1\r\nHost: ${APEX}\r\nConnection: close\r\n\r\n`))
  return list
}

async function runVariant(variant) {
  const def = VARIANTS[variant]
  const started = new Date().toISOString()
  const { name, ports } = await traefik(RUN, stand, variant, def)
  const all = cases(ports)
  const chosen = def.cases === 'all' ? all : all.filter((c) => SUBSET.includes(c.id))
  const results = []
  for (const c of chosen) {
    const m = { q: marker('Q', c.id), f: marker('F', c.id), p: marker('P', c.id) }
    const answer = await c.fn(m)
    results.push({ id: c.id, about: c.about, hint: c.hint, markers: m, status: answer.status, why: answer.why, head: answer.head?.split('\r\n')[0] })
    await sleep(150)
  }
  await sleep(1500)
  const metrics = await fetch(`http://127.0.0.1:${ports.internal}/metrics`).then((r) => r.text(), () => '')
  const traefikLogs = await logsOf(name)
  const web = await logsOf('spike88-s8-web')
  const preview = await logsOf('spike88-s8-preview')
  let file = ''
  if (def.file) file = (await docker(['exec', name, 'cat', def.file], { allowFail: true })).stdout
  const streams = {
    'traefik stdout': traefikLogs.stdout,
    'traefik stderr': traefikLogs.stderr,
    'web stdout+stderr': web.stdout + web.stderr,
    'preview stdout+stderr': preview.stdout + preview.stderr,
    metrics,
    ...(def.file ? { 'access file': file } : {}),
  }
  const entries = [...lines(traefikLogs.stdout), ...lines(traefikLogs.stderr), ...lines(file)]
  const access = entries.filter((e) => 'RequestPath' in e || 'DownstreamStatus' in e || (e.raw && / - - \[/.test(e.raw)))
  const general = entries.filter((e) => 'level' in e && !('DownstreamStatus' in e))
  for (const r of results) {
    const secrets = [r.markers.q, r.markers.f]
    r.leaks = Object.entries(streams)
      .filter(([, text]) => secrets.some((s) => text.includes(s)))
      .map(([stream]) => stream)
    r.pathTokenLogged = r.markers.p && (traefikLogs.stdout + file).includes(r.markers.p)
    const hint = r.id === 'P01' ? null : r.hint
    const own = access.filter((e) => {
      const text = JSON.stringify(e)
      if (secrets.some((s) => text.includes(s)) || text.includes(r.markers.p)) return true
      if (hint) return text.includes(hint)
      const path = e.RequestPath ?? /"[A-Z]+ (\S+) /.exec(e.raw ?? '')?.[1] ?? ''
      return path === '/a' || path.startsWith('/a?')
    })
    r.accessLines = own.length
    r.accessSample = own.slice(0, 1).map((e) =>
      e.raw ? e.raw : { RouterName: e.RouterName, RequestPath: e.RequestPath, DownstreamStatus: e.DownstreamStatus, RequestProtocol: e.RequestProtocol, ClientPort: e.ClientPort, StartUTC: e.StartUTC })[0] ?? null
    r.generalWithSecret = general.filter((e) => secrets.some((s) => JSON.stringify(e).includes(s))).map((e) => `${e.level}: ${String(e.message ?? e.msg ?? '').slice(0, 160)}`)
  }
  const generalLevels = {}
  for (const e of general) generalLevels[e.level] = (generalLevels[e.level] ?? 0) + 1
  const metricLabels = [...new Set([...metrics.matchAll(/^traefik_\w+\{([^}]*)\}/gm)].flatMap(([, l]) => [...l.matchAll(/(\w+)="/g)].map(([, k]) => k)))].sort()
  const out = { variant, about: def.about, started, image: stand.image, flags: def.flags(stand.flags), ports, generalLevels, metricLabels, results }
  mkdirSync(join(RUN, 'results'), { recursive: true })
  writeFileSync(join(RUN, 'results', `${variant}.json`), `${JSON.stringify(out, null, 2)}\n`)
  writeFileSync(join(RUN, 'logs', `${variant}.traefik.stdout.log`), traefikLogs.stdout)
  writeFileSync(join(RUN, 'logs', `${variant}.traefik.stderr.log`), traefikLogs.stderr)
  if (def.file) writeFileSync(join(RUN, 'logs', `${variant}.access-file.log`), file)
  if (!values.keep) await docker(['rm', '-f', name], { allowFail: true })
  return out
}

const chosen = values.only ? values.only.split(',') : Object.keys(VARIANTS)
await backends()
for (const variant of chosen) {
  if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`)
  const out = await runVariant(variant)
  console.log(`\n== ${variant}: ${out.about}  general log levels ${JSON.stringify(out.generalLevels)}`)
  for (const r of out.results)
    console.log(
      `${r.id} ${String(r.status).padEnd(4)} access:${r.accessLines} leaks:[${r.leaks.join(', ')}]` +
        `${r.pathTokenLogged ? ' pathToken:logged' : ''}  ${JSON.stringify(r.accessSample)?.slice(0, 170)}`,
    )
}
if (!values.keep) await removeBackends()
