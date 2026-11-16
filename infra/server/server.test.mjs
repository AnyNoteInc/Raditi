import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { policyNames } from '../vault/bootstrap.mjs'
import {
  GENERATED,
  GITHUB_APP_KEY_FILE,
  MULTILINE,
  PROVIDED,
  partialGroups,
  serviceFiles,
  storedValue,
} from './host/platform-secrets.mjs'

// The single server (infra/server/README.md): its AppRoles, its secrets and its firewall.

const setup = await readFile(new URL('./host/vault-setup.sh', import.meta.url), 'utf8')
const renderer = await readFile(new URL('./host/platform-secrets.mjs', import.meta.url), 'utf8')

/** `role <name> <policies> <ttl>` lines of vault-setup.sh. */
const setupRoles = Object.fromEntries(
  [...setup.matchAll(/^role (\S+) (\S+) \S+$/gm)].map(([, name, policies]) => [
    name,
    policies.split(','),
  ]),
)

test('the AppRoles of vault-setup.sh hold the policies of bootstrap.mjs, each to its service', () => {
  const { renderer: rendererRole, ...services } = setupRoles
  assert.deepEqual(rendererRole, ['raditi-renderer'])
  assert.deepEqual(services, {
    web: ['sites-writer', 'workspace-provisioner'],
    // core reads and renews the tokens of git connections (docs/plan/84-projects.md, §4.2)
    core: ['core-turns', 'core-transit', 'core-workspace-env', 'core-git'],
    llm: ['llm-subscriptions'],
    mcp: ['mcp-content'],
  })
  // Every policy a role names is one bootstrap writes; the rest are the operator's own tokens.
  const named = Object.values(services).flat()
  for (const policy of named) assert.ok(policyNames.includes(policy), policy)
  assert.deepEqual(policyNames.filter((policy) => !named.includes(policy)).sort(), [
    'subscriptions-admin',
    'subscriptions-writer',
  ])
  // The header comment says the same as the lines below it.
  for (const [name, policies] of Object.entries(services)) {
    const comment = setup.match(new RegExp(`^#   ${name} +(.+)$`, 'm'))?.[1]
    assert.equal(comment, policies.join(', '), name)
  }
  // render issues a SecretID to every role with a policy, and to no other.
  const rendered = renderer.match(/for \(const name of (\[[^\]]+\])\) \{\n\s+if \(!named/)?.[1]
  assert.deepEqual(JSON.parse(rendered.replaceAll("'", '"')), Object.keys(services))
})

test('the secrets of the repositories of projects: generated, set by the owner, multiline key', () => {
  assert.equal(typeof GENERATED.shared.repo_confirm_secret, 'function')
  const secret = GENERATED.shared.repo_confirm_secret()
  assert.ok(secret.length >= 32 && /^[A-Za-z0-9_-]+$/.test(secret))
  assert.notEqual(secret, GENERATED.shared.repo_confirm_secret())
  assert.deepEqual(PROVIDED['gitlab-oauth'], ['client_id', 'client_secret'])
  assert.deepEqual(MULTILINE, { 'github-app': ['private_key'] })

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' })
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' })
  // The key comes as a file: several lines, CRLF of a Windows editor, a trailing line break.
  for (const pem of [pkcs1, pkcs8, pkcs1.replaceAll('\n', '\r\n'), `\n${pkcs8}\n\n`]) {
    const stored = storedValue('github-app', 'private_key', pem)
    assert.equal(stored.problem, undefined)
    assert.equal(stored.value, `${pem.replaceAll('\r\n', '\n').trim()}\n`)
    assert.ok(stored.value.split('\n').length > 3)
  }
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()
  for (const [input, problem] of [
    [ec, /RSA/],
    ['-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', /does not parse/],
    [
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      /PEM private key/,
    ],
    [`${pkcs1}"`, /PEM private key/],
    ['', /PEM private key/],
  ]) {
    const refused = storedValue('github-app', 'private_key', input)
    assert.match(refused.problem, problem)
    assert.equal(refused.value, undefined)
    // A refusal names the field, never a part of the key.
    assert.doesNotMatch(refused.problem, /BEGIN|AAAA/)
  }
  // Every other field is one line, as before: a key of several lines is refused there.
  assert.deepEqual(storedValue('gitlab-oauth', 'client_id', ' abc \n'), { value: 'abc' })
  assert.match(storedValue('gitlab-oauth', 'client_secret', 'a\nb').problem, /newline/)
  assert.match(storedValue('github-app', 'client_secret', pkcs1).problem, /newline/)
  assert.match(storedValue('github-app', 'installation', 'x').problem, /not a field/)
  assert.match(storedValue('app/web', 'private_key', pkcs1).problem, /not a field/)
})

const kv = () => ({
  shared: { pg_password: 'p', pg_superuser_password: 's', redis_password: 'r' },
  web: {},
  core: {},
  browser: {},
  preview: {},
  traefik: { dashboard_user: 'admin', dashboard_password: 'x' },
  'gitlab-oauth': {},
  'github-app': {},
})
const roles = { web: null, core: null, llm: null, mcp: null }
const render = (values) =>
  serviceFiles(values, roles, { readFile: () => 'synthetic', bcrypt: () => 'admin:hash\n' })
const envOf = (text) =>
  Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+)="([^"]*)"$/gm)].map(([, k, v]) => [k, v]))

test('render: the git apps and REPO_CONFIRM_SECRET go to web and core, the key as a file of core', () => {
  const values = kv()
  values.shared.repo_confirm_secret = 'c'.repeat(64)
  values['gitlab-oauth'] = { client_id: 'gl-id', client_secret: 'gl-secret' }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = storedValue(
    'github-app',
    'private_key',
    privateKey.export({ type: 'pkcs1', format: 'pem' }),
  ).value
  values['github-app'] = {
    app_id: '12345',
    slug: 'raditi',
    client_id: 'Iv1.synthetic',
    client_secret: 'gh-secret',
    webhook_secret: 'gh-hook',
    private_key: pem,
  }
  const files = render(values)
  const web = envOf(files.web.files['app.env'])
  const core = envOf(files.core.files['app.env'])
  assert.equal(web.REPO_CONFIRM_SECRET, 'c'.repeat(64))
  assert.equal(core.REPO_CONFIRM_SECRET, 'c'.repeat(64))
  for (const env of [web, core]) {
    assert.equal(env.GITLAB_OAUTH_CLIENT_ID, 'gl-id')
    assert.equal(env.GITLAB_OAUTH_CLIENT_SECRET, 'gl-secret')
  }
  assert.deepEqual(
    Object.keys(web).filter((name) => name.startsWith('GITHUB_')),
    [
      'GITHUB_APP_SLUG',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_WEBHOOK_SECRET',
    ],
  )
  assert.deepEqual(
    Object.keys(core).filter((name) => name.startsWith('GITHUB_')),
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE'],
  )
  assert.equal(core.GITHUB_APP_PRIVATE_KEY_FILE, GITHUB_APP_KEY_FILE)
  assert.equal(files.core.files['github-app.pem'], pem)
  // The key is in no app.env and in no other service's files.
  for (const [name, { files: own }] of Object.entries(files))
    for (const [file, contents] of Object.entries(own)) {
      if (name === 'core' && file === 'github-app.pem') continue
      assert.ok(
        typeof contents !== 'string' || !contents.includes('PRIVATE KEY'),
        `${name}/${file}`,
      )
    }
  // Nothing of git reaches the services that never use it.
  for (const name of ['llm', 'mcp', 'browser', 'preview', 'migrate'])
    assert.doesNotMatch(files[name].files['app.env'], /GIT|REPO_CONFIRM/, name)
  // The host path of the key is /run/raditi/core, mounted at /run/raditi in the container.
  const compose = renderer.match(/GITHUB_APP_KEY_FILE = '([^']+)'/)?.[1]
  assert.equal(compose, '/run/raditi/github-app.pem')
})

test('render: an app set in part is not rendered and is named without its values', () => {
  const values = kv()
  values['gitlab-oauth'] = { client_id: 'gl-id' }
  values['github-app'] = { app_id: '1', slug: 'raditi' }
  const files = render(values)
  for (const service of ['web', 'core']) {
    assert.doesNotMatch(files[service].files['app.env'], /GITLAB|GITHUB|REPO_CONFIRM/, service)
    assert.equal(files[service].files['github-app.pem'], undefined)
  }
  assert.deepEqual(partialGroups(values), [
    'gitlab-oauth (client_secret)',
    'github-app (client_id, client_secret, webhook_secret, private_key)',
  ])
  assert.deepEqual(partialGroups(kv()), [])
})

test('the host firewall keeps the git worker off the host and the private addresses', async () => {
  const nft = await readFile(new URL('./host/raditi-host.nft', import.meta.url), 'utf8')
  const compose = await readFile(new URL('../app/docker-compose.yml', import.meta.url), 'utf8')
  const env = await readFile(new URL('./env.example', import.meta.url), 'utf8')
  // The bridge the rules name is the one of git-egress with the prefix of the server.
  assert.match(env, /^BRIDGE_PREFIX=rd$/m)
  assert.match(
    compose,
    /git-egress:\n\s+driver_opts: \{ com\.docker\.network\.bridge\.name: '\$\{BRIDGE_PREFIX:-rd\}-git' \}/,
  )
  const chain = (name) => nft.split(`chain ${name} {`)[1]?.split('\n  }')[0] ?? ''
  // Before every accept of the input chain: the host answers the worker nothing.
  const input = chain('input')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
  assert.equal(input[0], 'iifname "rd-git" drop')
  const forward = chain('forward')
  assert.match(forward, /type filter hook forward priority filter - 10; policy accept;/)
  for (const subnet of [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '127.0.0.0/8',
  ])
    assert.ok(forward.includes(subnet), subnet)
  assert.match(forward, /iifname "rd-git" ip daddr \{[^}]+\} drop/)
  assert.match(forward, /iifname "rd-git" ip6 daddr \{ ::1, fc00::\/7, fe80::\/10 \} drop/)
})
