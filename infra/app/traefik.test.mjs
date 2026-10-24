// The edge routes (spec §19): web only, separate certificates for apex and www, the reset token
// and the metrics never through the edge, a limit on the bodies sent to the API. The previews of
// dialogs (docs/plan/53, Р19) have a file of their own: exactly their hosts, to the gateway role.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const routes = readFileSync(new URL('./traefik/dynamic/raditi.yml', import.meta.url), 'utf8')
const code = routes.replace(/#.*$/gm, '')

/** The lines of one router, up to the next key at the same depth. */
function router(name) {
  const lines = code.split('\n')
  const start = lines.indexOf(`    ${name}:`)
  assert.notEqual(start, -1, `router ${name} is missing`)
  const end = lines.findIndex((line, index) => index > start && /^ {0,4}\S/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

// A middleware is a named block at the same depth.
const middleware = router

const apex = 'Host(`{{ env "APP_DOMAIN" }}`)'
const www = 'Host(`www.{{ env "APP_DOMAIN" }}`)'

test('web is the only backend behind the edge', () => {
  assert.deepEqual(
    [...code.matchAll(/url: '([^']+)'/g)].map(([, url]) => url),
    ['http://web:3000'],
  )
  assert.doesNotMatch(code, /core|8081|8083|mcp|8082|llm|8084/i)
})

test('apex and www are separate ACME orders', () => {
  assert.match(router('web'), /domains: \[\{ main: '\{\{ env "APP_DOMAIN" \}\}' \}\]/)
  assert.match(router('www'), /domains: \[\{ main: 'www\.\{\{ env "APP_DOMAIN" \}\}' \}\]/)
  assert.equal(code.match(/certResolver: le/g)?.length, 2)
  assert.match(router('www'), /middlewares: \[www-to-apex\]/)
})

test('the reset token never reaches the access log, on either host', () => {
  const reset = router('web-reset-password')
  assert.ok(reset.includes(apex) && reset.includes(www))
  assert.match(reset, /PathPrefix\(`\/api\/auth\/reset-password\/`\)/)
  assert.match(reset, /observability: \{ accessLogs: false \}/)
  assert.match(reset, /priority: 1000/)
})

test('metrics are refused at the edge, on either host', () => {
  const metrics = router('web-metrics')
  assert.ok(metrics.includes(apex) && metrics.includes(www))
  assert.match(metrics, /PathPrefix\(`\/api\/metrics`\)/)
  assert.match(metrics, /middlewares: \[edge-deny\]/)
  assert.match(metrics, /priority: 1000/)
  assert.match(code, /edge-deny:\n\s+ipAllowList: \{ sourceRange: \['127\.0\.0\.1\/32'\] \}/)
})

test('a body sent to the API is limited at the edge; pages and GET are never buffered', () => {
  const api = router('web-api-body')
  assert.ok(api.includes(apex) && !api.includes(www))
  assert.match(api, /PathPrefix\(`\/api\/`\)/)
  // Every method that can carry a body, whatever its name
  assert.match(api, /!Method\(`GET`\) && !Method\(`HEAD`\)/)
  assert.match(api, /middlewares: \[api-body-limit\]/)
  assert.match(api, /service: web$/m)
  // Below the reset and metrics routers (1000), above the catch-all `web` (the rule's length)
  assert.match(api, /priority: 900/)
  // The reset path has a router of its own: the same limit there
  assert.match(router('web-reset-password'), /middlewares: \[www-to-apex, api-body-limit\]/)
  // The middleware holds the whole answer back: a page or an SSE stream must never pass it
  assert.doesNotMatch(router('web'), /middlewares/)
  assert.equal(code.match(/api-body-limit/g)?.length, 3)

  const limit = middleware('api-body-limit')
  const bytes = (name) => Number(new RegExp(`^ +${name}: (\\d+)$`, 'm').exec(limit)?.[1])
  // The root file system is read-only: a body or an answer that leaves memory answers 500
  assert.equal(bytes('memRequestBodyBytes'), bytes('maxRequestBodyBytes'))
  assert.equal(bytes('memResponseBodyBytes'), bytes('maxResponseBodyBytes'))
  assert.ok(bytes('maxResponseBodyBytes') >= 1024 * 1024)

  // Above the largest body web itself takes on these routes
  const web = readFileSync(
    new URL('../../apps/web/src/server/body-limit.ts', import.meta.url),
    'utf8',
  )
  const own = [...web.matchAll(/^export const MAX_\w+_BODY_BYTES = (\d+) \* 1024$/gm)]
  assert.ok(own.length >= 2, 'the limits of web are not found')
  // Above, not equal: a body of exactly the limit would be written to disk, that is 500
  for (const [, kib] of own) assert.ok(bytes('maxRequestBodyBytes') > Number(kib) * 1024)
  // Each body in flight sits in Traefik's memory (256 MiB for everything): the limit stays small,
  // and the 5 MiB avatar upload, which web reads only after the session check, stays off it
  assert.ok(bytes('maxRequestBodyBytes') <= 1024 * 1024)
  assert.match(api, /!Path\(`\/api\/profile\/avatar`\)/)
  // So does the upload of an attached file (20 MiB, Б26): web streams it to the inbox after its
  // own checks; nothing else under the prefix takes a body
  assert.match(api, /!PathPrefix\(`\/api\/attachments\/`\)/)
  const route = readFileSync(
    new URL('../../apps/web/src/app/api/attachments/[id]/route.ts', import.meta.url),
    'utf8',
  )
  assert.deepEqual(
    [...route.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]),
    ['PUT'],
  )
})

test('TLS 1.2 at least, and only for the names the edge serves', () => {
  assert.match(code, /minVersion: VersionTLS12/)
  assert.match(code, /sniStrict: true/)
  assert.doesNotMatch(code, /CBC|RC4|3DES/)
})

// --- Previews of dialogs: traefik/dynamic/preview.yml --------------------------------------------

const previewRoutes = readFileSync(
  new URL('./traefik/dynamic/preview.yml', import.meta.url),
  'utf8',
)

/** The file as Traefik's Go template renders it with this environment (the parts it uses). */
function rendered(baseDomain) {
  const guarded = /^# \{\{ if env "PREVIEW_BASE_DOMAIN" \}\}\n([\s\S]*)^# \{\{ end \}\}\n$/m.exec(
    previewRoutes,
  )
  assert.ok(guarded, 'the whole file is guarded by PREVIEW_BASE_DOMAIN')
  // Nothing outside the guard but comments, and nothing inside it is one.
  const outside = previewRoutes.replace(guarded[0], '')
  assert.ok(outside.split('\n').every((line) => line === '' || line.startsWith('# ')))
  assert.doesNotMatch(outside, /\{\{/)
  if (!baseDomain) return ''
  return guarded[1]
    .replaceAll(
      '{{ env "PREVIEW_BASE_DOMAIN" | replace "." "\\\\." }}',
      baseDomain.replaceAll('.', '\\.'),
    )
    .replaceAll('{{ env "PREVIEW_BASE_DOMAIN" }}', baseDomain)
}

test('the edge has two route files: the cabinet (web only) and previews', () => {
  const files = readdirSync(new URL('./traefik/dynamic/', import.meta.url)).sort()
  assert.deepEqual(files, ['preview.yml', 'raditi.yml'])
  assert.doesNotMatch(code, /preview|8090|HostRegexp/i)
})

test('without PREVIEW_BASE_DOMAIN the preview file routes nothing and orders no certificate', () => {
  assert.equal(rendered(''), '')
})

test('previews: exactly their hosts, one label under the base, to the gateway role alone', () => {
  const yaml = rendered('preview.example.com')
  assert.doesNotMatch(yaml, /\{\{|\}\}/)
  assert.deepEqual(
    [...yaml.matchAll(/url: '([^']+)'/g)].map(([, url]) => url),
    ['http://preview:8090'],
  )
  assert.doesNotMatch(yaml, /web:3000|core|8081|8083|mcp|8082|llm|8084|middlewares/i)
  assert.match(yaml, /entryPoints: \[websecure\]/)
  assert.match(yaml, /certResolver: preview$/m)
  assert.match(yaml, /domains: \[\{ main: '\*\.preview\.example\.com' \}\]/)
  const rule = /rule: 'HostRegexp\(`([^`]+)`\)'/.exec(yaml)?.[1]
  assert.ok(rule)
  const host = new RegExp(rule)
  for (const name of [
    'site-abcd1234-chat-ef5678.preview.example.com',
    'site-0000-chat-0000.preview.example.com',
  ])
    assert.match(name, host, name)
  for (const name of [
    'preview.example.com',
    'www.preview.example.com',
    'site-abcd1234-chat-ef5678.preview.example.com.evil.ru',
    'x.site-abcd1234-chat-ef5678.preview.example.com',
    'site-abcd1234-chat-ef5678xpreviewxexample.com',
    'site-ab-chat-ef5678.preview.example.com',
    'site-abcd1234-chat-ef5678.raditi.ru',
  ])
    assert.doesNotMatch(name, host, name)
})
