// The edge routes (spec §19): web only, separate certificates for apex and www, the reset token
// and the metrics never through the edge.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

const apex = 'Host(`{{ env "APP_DOMAIN" }}`)'
const www = 'Host(`www.{{ env "APP_DOMAIN" }}`)'

test('web is the only backend behind the edge', () => {
  assert.deepEqual(
    [...code.matchAll(/url: '([^']+)'/g)].map(([, url]) => url),
    ['http://web:3000'],
  )
  assert.doesNotMatch(code, /core|8081|8083|mcp|8082|litellm|4000/i)
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

test('TLS 1.2 at least, and only for the names the edge serves', () => {
  assert.match(code, /minVersion: VersionTLS12/)
  assert.match(code, /sniStrict: true/)
  assert.doesNotMatch(code, /CBC|RC4|3DES/)
})
