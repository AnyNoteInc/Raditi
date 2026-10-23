// The contract of `pnpm verify:mcp-content` with the trust boundaries of the content path: who
// holds which Vault credential on the stand. Text only; the stand itself proves the behaviour.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const launcher = read('infra/dev/site-verify/verify-content.mjs')
// The worker and its scenarios drive the mcp app alone: they live with it (plan 56, decision 2).
const workers = readdirSync(join(root, 'apps/mcp/scripts'))
  .filter((name) => /^verify-content-.*\.mjs$/.test(name))
  .map((name) => read(`apps/mcp/scripts/${name}`))
const worker = read('apps/mcp/scripts/verify-content-worker.mjs')

test('the operator token stays in the launcher: the role logs in by AppRole mcp', () => {
  // Mounts and policies come from the bootstrap every stand and the dev OpenBao share.
  assert.match(launcher, /from '\.\.\/\.\.\/vault\/bootstrap\.mjs'/)
  assert.match(launcher, /await bootstrapLocalVault\(\{ address: env\.VAULT_ADDR, token \}\)/)
  assert.match(launcher, /'auth\/approle\/role\/mcp'/)
  assert.match(launcher, /token_policies: \['mcp-content'\]/)
  assert.match(launcher, /token_no_default_policy: true/)
  // The worker's environment is the launcher's without the operator token, plus the AppRole.
  assert.match(launcher, /const \{ VAULT_DEV_ROOT_TOKEN: _operator, \.\.\.roleEnv \} = env/)
  assert.match(
    launcher,
    /env: \{\n\s+\.\.\.roleEnv,\n\s+VAULT_ROLE_ID: appRole\.roleId,\n\s+VAULT_SECRET_ID: appRole\.secretId,\n\s+RADITI_CONTENT_FIXTURE_FILE: privateFile,\n\s+\},/,
  )
  assert.equal(launcher.match(/\.\.\.env\b/g), null, 'the full environment reaches no child')
  for (const script of workers) {
    assert.doesNotMatch(script, /X-Vault-Token/i)
    assert.doesNotMatch(script, /VAULT_DEV_ROOT_TOKEN: /)
    assert.doesNotMatch(script, /token: process\.env/)
  }
  // The worker refuses to start with the operator token in its environment.
  assert.match(worker, /assert\.equal\(\s*process\.env\.VAULT_DEV_ROOT_TOKEN,\s*undefined,/)
  assert.match(
    worker,
    /vault: \{\n\s+addr: process\.env\.VAULT_ADDR,\n\s+appRole: \{\n\s+roleId: process\.env\.VAULT_ROLE_ID,\n\s+secretId: process\.env\.VAULT_SECRET_ID,\n\s+\},\n\s+\},/,
  )
})

test('the site access reaches the role through Vault and credential_refs only', () => {
  // Written by the trusted connection step under sites-writer, with CAS; never read back there.
  assert.match(launcher, /scoped\('sites-writer'\)/)
  assert.match(launcher, /`kv\/data\/sites\/\$\{siteId\}\/wp`/)
  assert.match(launcher, /options: \{ cas: 0 \}/)
  assert.match(launcher, /scoped\('workspace-provisioner'\)/)
  // The private file of the worker names the site and the version of its access, no password.
  const [, fixture] =
    /privateFile,\n\s+JSON\.stringify\(\{\n((?:.*\n)*?)\s+\}\),/.exec(launcher) ?? []
  assert.ok(fixture, 'the launcher writes the fixture file of the worker')
  assert.match(fixture, /accessVersion,/)
  assert.doesNotMatch(fixture, /applicationPassword|username/)
  for (const script of workers) {
    assert.doesNotMatch(script, /applicationPassword/)
    // No gateway is built by hand: the regular resolver builds it from the Vault secret.
    assert.doesNotMatch(script, /new WordpressPublishedContentGateway/)
    assert.doesNotMatch(script, /site-adapters/)
  }
  assert.match(worker, /vaultPath: siteAccessPath\(fixture\.siteId, 'wp'\)/)
  assert.match(worker, /keyVersion: fixture\.accessVersion/)
})

test('the fixture resolver is only a wrapper around the regular one, for fault injection', () => {
  assert.match(worker, /AppModule\.forRoot\(config, \{\n\s+wrapResolver: \(resolver\) => \{/)
  assert.match(worker, /const gateway = await regular\(scope\)/)
  assert.match(worker, /contentProfile: 'local-site'/)
  // The role composes its own S3 client and Vault client from the configuration.
  assert.doesNotMatch(worker, /AppModule\.forRoot\(config, \{\n\s+storage/)
})

test('a repeated signal cannot end the cleanup of the stand', () => {
  for (const script of [launcher, read('infra/dev/site-verify/verify-site.mjs')]) {
    assert.doesNotMatch(script, /process\.once\('SIG/)
    assert.match(
      script,
      /process\.on\('SIGINT', interrupt\)\n\s*process\.on\('SIGTERM', interrupt\)/,
    )
  }
})
