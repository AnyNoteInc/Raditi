import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Redis keeps authentication and blocks administrative and bulk destructive commands', () => {
  const acl = read('./secrets.example/redis/users.acl')
    .replace(/<[^>]+>/g, 'example')
    .trim()
    .split('\n')
  assert.equal(acl.length, 1, 'application and health checks share one Redis login')
  const rules = acl[0].split(/\s+/)
  assert.deepEqual(rules.slice(0, 3), ['user', 'default', 'on'])
  assert.equal(rules.filter((rule) => rule.startsWith('#')).length, 1)
  assert.ok(!rules.includes('nopass'))
  assert.ok(!rules.includes('off'))
  const allCommands = rules.indexOf('+@all')
  assert.ok(allCommands >= 0, 'BullMQ uses scripts, transactions, lists and streams')
  for (const forbidden of ['-@admin', '-flushall', '-flushdb', '-keys', '-swapdb']) {
    assert.ok(rules.indexOf(forbidden) > allCommands, `${forbidden} must override +@all`)
  }
})

test('web, core and the health check share a password', () => {
  const core = read('./secrets.example/core/app.env')
  const url = /^REDIS_URL="([^"]+)"$/m.exec(core)?.[1]
  assert.match(url, /^redis:\/\/:<[^>]+>@redis:6379$/)
  const web = read('./secrets.example/web/app.env')
  assert.equal(/^REDIS_URL="([^"]+)"$/m.exec(web)?.[1], url)
  const compose = read('./docker-compose.yml')
  assert.match(compose, /REDISCLI_AUTH="\$\$\(cat \/run\/raditi\/password\)" redis-cli ping/)
  assert.doesNotMatch(compose, /health-password|redis-cli --user/)
  assert.match(read('./preflight.sh'), /^check_secrets redis 10003 users\.acl password$/m)
  assert.ok(existsSync(new URL('./secrets.example/redis/password', import.meta.url)))
  assert.ok(!existsSync(new URL('./secrets.example/redis/health-password', import.meta.url)))
})
