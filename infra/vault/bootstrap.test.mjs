import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  bootstrapLocalVault,
  bootstrapSummary,
  localVaultAddress,
  localVaultRequest,
  mounts,
  plainMounts,
  policyNames,
  waitForLocalVault,
} from './bootstrap.mjs'
import { assertLocalDockerEndpoint } from './verify-local.mjs'

// What OpenBao 2.7 reports for a KV v2 mount that was enabled and never configured.
const serverDefaults = { max_versions: 0, cas_required: false, delete_version_after: '0s' }

function mockVault({
  inventory = {},
  configurations = {},
  failedPolicy = false,
  // Statuses answered, in order, to the next configuration writes of a mount.
  configWrites = {},
  keys = {},
} = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.slice('/v1/'.length)
    const body = options.body === undefined ? undefined : JSON.parse(options.body)
    calls.push({ path, method: options.method, body, headers: options.headers })
    let status = 204
    let reply = null
    if (path === 'sys/mounts') {
      status = 200
      reply = { data: inventory }
    } else if (path.startsWith('sys/mounts/')) {
      const name = path.split('/').at(-1)
      inventory[`${name}/`] = body
    } else if (path.endsWith('/config')) {
      const name = path.split('/')[0]
      if (options.method === 'POST') {
        const failure = configWrites[name]?.shift()
        if (failure === undefined) configurations[name] = body
        else {
          status = failure
          reply = { errors: ['synthetic-private-server-error'] }
        }
      } else {
        status = 200
        reply = { data: configurations[name] ?? serverDefaults }
      }
    } else if (path.endsWith('/metadata')) {
      const found = keys[path.split('/')[0]]
      status = found ? 200 : 404
      reply = found ? { data: { keys: found } } : { errors: [] }
    } else if (failedPolicy) {
      status = 403
      reply = { errors: ['synthetic-private-server-error'] }
    }
    return new Response(reply === null ? null : JSON.stringify(reply), { status })
  }
  return { calls, fetchImpl, sleep: async () => {} }
}

test('every policy grants exactly its scoped privileges and only on its own mounts', async () => {
  const expected = {
    'core-turns': {
      'turns/data/*': ['create', 'read', 'delete'],
      'turns/metadata/*': ['read', 'update', 'list', 'delete'],
      'turns/metadata': ['list'],
      'turns/undelete/*': ['deny'],
      'turns/destroy/*': ['deny'],
    },
    'llm-subscriptions': { 'subs/data/*': ['read'] },
    'subscriptions-writer': {
      'subs/data/*': ['create', 'update'],
      'subs/metadata/*': ['read'],
    },
    'subscriptions-admin': { 'subs/metadata/*': ['delete'], 'subs/destroy/*': ['update'] },
    // Only the WordPress kind of site access: no ssh, ftp, git, db or browser, no write and no
    // key management.
    'mcp-content': {
      'kv/data/sites/+/wp': ['read'],
      // The secrets of a preview, never the variables of a site (plan 53, Р21, Р24).
      'kv/data/previews/+/wp': ['read'],
      'kv/data/previews/+/browser': ['read'],
      'kv/data/content-masks/*': ['create', 'read', 'update'],
      'kv/metadata/content-masks/*': ['delete'],
      'transit/datakey/plaintext/ws-*': ['update'],
      'transit/decrypt/ws-*': ['update'],
    },
    'core-transit': {
      'transit/datakey/plaintext/ws-*': ['update'],
      'transit/decrypt/ws-*': ['update'],
    },
    // Site access and the variables of a site; of the metadata only the version for CAS and,
    // on a variable, its limit of one version (plan 53, Р13).
    'sites-writer': {
      'kv/data/sites/*': ['create', 'update'],
      'kv/metadata/sites/+/*': ['read'],
      'kv/metadata/sites/+/env/*': ['create', 'update', 'read'],
    },
    'workspace-provisioner': { 'transit/keys/ws-*': ['update'] },
    // The kinds a site is imported with, read-only: no wp or browser, no write, no metadata.
    'core-site-import': {
      'kv/data/sites/+/ftp': ['read'],
      'kv/data/sites/+/ssh': ['read'],
      'kv/data/sites/+/git': ['read'],
      'kv/data/sites/+/db': ['read'],
    },
    // Releases and previews (plan 53, Р29, Р35): reads of what a release writes with, the
    // secrets of a preview, and the three calls of a single-use wrapping — nothing that
    // creates a token or a policy.
    'core-release': {
      'kv/data/sites/+/wp': ['read'],
      'kv/data/sites/+/env/*': ['read'],
      'kv/data/platform/gitea-org-owner': ['read'],
      'kv/data/previews/*': ['create', 'read', 'update', 'delete'],
      'kv/metadata/previews/*': ['read', 'update', 'list', 'delete'],
      'sys/wrapping/wrap': ['update'],
      'sys/wrapping/lookup': ['update'],
      'auth/token/revoke-accessor': ['update'],
    },
  }
  // A policy that names a mount outside its list fails here, whatever the path under it.
  const allowedMounts = {
    'core-turns': ['turns'],
    'llm-subscriptions': ['subs'],
    'subscriptions-writer': ['subs'],
    'subscriptions-admin': ['subs'],
    'mcp-content': ['kv', 'transit'],
    'core-transit': ['transit'],
    'sites-writer': ['kv'],
    'workspace-provisioner': ['transit'],
    'core-site-import': ['kv'],
    'core-release': ['kv', 'sys', 'auth'],
  }
  // The only system and auth endpoints a policy may name.
  const systemPaths = {
    'core-release': ['sys/wrapping/wrap', 'sys/wrapping/lookup', 'auth/token/revoke-accessor'],
  }
  assert.deepEqual([...policyNames].sort(), Object.keys(expected).sort())
  assert.deepEqual(Object.keys(allowedMounts).sort(), Object.keys(expected).sort())
  for (const name of policyNames) {
    const policy = await readFile(new URL(`./policies/${name}.hcl`, import.meta.url), 'utf8')
    const grants = Object.fromEntries(
      [...policy.matchAll(/path "([^"]+)"\s*{\s*capabilities\s*=\s*\[([^\]]+)\]/g)].map(
        ([, path, capabilities]) => [
          path,
          [...capabilities.matchAll(/"([^"]+)"/g)].map(([, v]) => v),
        ],
      ),
    )
    assert.deepEqual(grants, expected[name], name)
    assert.equal([...policy.matchAll(/\bpath\s+"/g)].length, Object.keys(grants).length)
    assert.deepEqual(
      [...new Set(Object.keys(grants).map((path) => path.split('/')[0]))].sort(),
      [...allowedMounts[name]].sort(),
      name,
    )
    assert.deepEqual(
      Object.keys(grants).filter((path) => /^(sys|auth)\//.test(path)),
      systemPaths[name] ?? [],
      name,
    )
    // Outside the path names: no sudo, no root, no ops/.
    const body = policy.replaceAll(/path "[^"]+"/g, 'path')
    assert.doesNotMatch(body, /sudo|sys\/|auth\/|ops\/|"root"/, name)
  }
  const core = await readFile(new URL('./policies/core-turns.hcl', import.meta.url), 'utf8')
  assert.match(core, /allowed_parameters\s*=\s*{\s*"custom_metadata"\s*=\s*\[\]/)
  // The glob also matches ws-<id>/config: only the key type may be sent, so a provisioner
  // cannot make a key exportable or deletable.
  const provisioner = await readFile(
    new URL('./policies/workspace-provisioner.hcl', import.meta.url),
    'utf8',
  )
  assert.match(provisioner, /allowed_parameters\s*=\s*{\s*"type"\s*=\s*\["aes256-gcm96"\]\s*}/)
  assert.equal([...provisioner.matchAll(/allowed_parameters/g)].length, 1)
  // web may set one thing of the metadata of a variable: that it keeps one version. Any other
  // value or parameter — a longer history, cas_required, a deletion delay — is refused.
  const writer = await readFile(new URL('./policies/sites-writer.hcl', import.meta.url), 'utf8')
  assert.match(
    writer,
    /path "kv\/metadata\/sites\/\+\/env\/\*" {\s*capabilities = \[[^\]]+\]\s*allowed_parameters\s*=\s*{\s*"max_versions"\s*=\s*\["1"\]\s*}/,
  )
  assert.equal([...writer.matchAll(/allowed_parameters/g)].length, 1)
  // core may attach recovery metadata to a secret of a preview, never weaken its retention.
  const release = await readFile(new URL('./policies/core-release.hcl', import.meta.url), 'utf8')
  assert.match(
    release,
    /path "kv\/metadata\/previews\/\*" {\s*capabilities = \[[^\]]+\]\s*allowed_parameters\s*=\s*{\s*"custom_metadata"\s*=\s*\[\]\s*}/,
  )
  assert.equal([...release.matchAll(/allowed_parameters/g)].length, 1)
})

test('a new local bootstrap creates the four mounts and all the policies', async () => {
  const mock = mockVault({ inventory: { 'unrelated/': { type: 'transit' } } })
  const options = { address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }
  assert.deepEqual(await bootstrapLocalVault(options), {
    mounts: ['turns', 'subs', 'kv', 'transit'],
    policies: [...policyNames],
    created: ['turns', 'subs', 'kv', 'transit'],
  })
  const mountWrites = mock.calls.filter(({ path }) => path.startsWith('sys/mounts/'))
  assert.deepEqual(
    mountWrites.map(({ path, body }) => [path, body]),
    [
      ['sys/mounts/turns', { type: 'kv', options: { version: '2' } }],
      ['sys/mounts/subs', { type: 'kv', options: { version: '2' } }],
      ['sys/mounts/kv', { type: 'kv', options: { version: '2' } }],
      ['sys/mounts/transit', { type: 'transit' }],
    ],
  )
  // Only turns/ and subs/ have settings of their own: kv/ and transit/ are enabled as they are.
  const configWrites = mock.calls.filter(({ path }) => path.endsWith('/config'))
  assert.deepEqual(
    configWrites.map(({ path, body }) => [path, body]),
    Object.entries(mounts).map(([name, config]) => [`${name}/config`, config]),
  )
  assert.equal(policyNames.length, 10)
  assert.deepEqual(
    mock.calls.filter(({ path }) => path.startsWith('sys/policies/acl/')).map(({ path }) => path),
    policyNames.map((name) => `sys/policies/acl/${name}`),
  )
  assert.ok(mock.calls.every(({ method }) => method !== 'DELETE'))
  assert.ok(mock.calls.every(({ headers }) => headers['X-Vault-Token'] === 'synthetic-root'))
})

test('repeating bootstrap preserves every mount, configuration and secret path', async () => {
  const mock = mockVault()
  const options = { address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }
  await bootstrapLocalVault(options)
  mock.calls.length = 0
  assert.deepEqual((await bootstrapLocalVault(options)).created, [])
  assert.deepEqual(
    mock.calls.map(({ path, method }) => [path, method]),
    [
      ['sys/mounts', 'GET'],
      ['turns/config', 'GET'],
      ['subs/config', 'GET'],
      ...policyNames.map((name) => [`sys/policies/acl/${name}`, 'PUT']),
    ],
  )
})

test('incompatible existing mounts abort before any mutation without resetting them', async () => {
  for (const [name, existing, message] of [
    ['subs', { type: 'transit' }, /^Existing subs\/ is not KV v2; no mount was reset$/],
    ['subs', { type: 'kv', options: { version: '1' } }, /subs\/ is not KV v2; no mount was reset/],
    ['kv', { type: 'transit', options: {} }, /^Existing kv\/ is not KV v2; no mount was reset$/],
    // What OpenBao 2.7 reports for a KV v1 mount.
    ['kv', { type: 'kv', options: {} }, /^Existing kv\/ is not KV v2; no mount was reset$/],
    ['kv', { type: 'kv', options: null }, /^Existing kv\/ is not KV v2; no mount was reset$/],
    [
      'transit',
      { type: 'kv', options: { version: '2' } },
      /^Existing transit\/ is not Transit; no mount was reset$/,
    ],
  ]) {
    const mock = mockVault({ inventory: { [`${name}/`]: existing } })
    await assert.rejects(
      bootstrapLocalVault({ address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }),
      (error) => message.test(error.message),
      name,
    )
    assert.ok(mock.calls.every(({ method }) => method === 'GET'))
  }
})

test('existing kv/ and transit/ are checked by type only and never configured', async () => {
  assert.deepEqual(plainMounts, {
    kv: { type: 'kv', options: { version: '2' } },
    transit: { type: 'transit' },
  })
  // kv/ with settings and keys of its own, as a stand or an operator left it.
  const mock = mockVault({
    inventory: {
      'kv/': { type: 'kv', options: { version: 2 } },
      'transit/': { type: 'transit', options: {} },
    },
    configurations: { kv: { max_versions: 3, cas_required: true, delete_version_after: '1h' } },
    keys: { kv: ['sites/'] },
  })
  const options = { address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }
  assert.deepEqual((await bootstrapLocalVault(options)).created, ['turns', 'subs'])
  assert.ok(
    !mock.calls.some(({ path }) => /^(kv|transit)\//.test(path) || /\/(kv|transit)$/.test(path)),
  )
  assert.ok(mock.calls.every(({ method }) => method !== 'DELETE'))
})

test('different retention, history or CAS settings require explicit operator review', async () => {
  for (const difference of [
    { max_versions: 10 },
    { cas_required: false },
    { delete_version_after: '20m' },
  ]) {
    const mock = mockVault({
      inventory: { 'turns/': { type: 'kv', options: { version: '2' } } },
      configurations: { turns: { ...mounts.turns, ...difference } },
    })
    await assert.rejects(
      bootstrapLocalVault({ address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }),
      /configuration differs; explicit operator review is required/,
    )
    assert.ok(mock.calls.every(({ method }) => method === 'GET'))
  }
})

test('a configuration write refused while the new mount is still upgrading is repeated', async () => {
  const mock = mockVault({ configWrites: { turns: [400, 400] } })
  await bootstrapLocalVault({ address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock })
  assert.deepEqual(
    mock.calls
      .filter(({ path, method }) => path === 'turns/config' && method === 'POST')
      .map(({ body }) => body),
    [mounts.turns, mounts.turns, mounts.turns],
  )
  assert.equal(mock.calls.filter(({ path }) => path === 'sys/mounts/turns').length, 1)
  assert.equal(
    mock.calls.filter(({ path }) => path.startsWith('sys/policies/acl/')).length,
    policyNames.length,
  )
})

test('a configuration write that keeps failing stops the bootstrap with its status', async () => {
  const mock = mockVault({ configWrites: { turns: Array.from({ length: 100 }, () => 400) } })
  await assert.rejects(
    bootstrapLocalVault({ address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }),
    (error) => error.message === 'Configure KV mount failed (HTTP 400)',
  )
  const writes = mock.calls.filter(
    ({ path, method }) => path === 'turns/config' && method === 'POST',
  )
  assert.ok(writes.length > 1 && writes.length <= 40)
  for (const name of ['subs', 'kv', 'transit'])
    assert.ok(!mock.calls.some(({ path }) => path === `sys/mounts/${name}`))
  assert.ok(!mock.calls.some(({ path }) => path.startsWith('sys/policies/')))
})

test('a rerun finishes a mount that an interrupted run left enabled and unconfigured', async () => {
  const mock = mockVault({ configWrites: { turns: [500] } })
  const options = { address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }
  await assert.rejects(bootstrapLocalVault(options), /Configure KV mount failed \(HTTP 500\)/)
  mock.calls.length = 0
  assert.deepEqual(await bootstrapLocalVault(options), {
    mounts: ['turns', 'subs', 'kv', 'transit'],
    policies: [...policyNames],
    created: ['subs', 'kv', 'transit'],
  })
  // The unused mount is configured in place: it is never disabled or enabled again.
  assert.ok(!mock.calls.some(({ path }) => path === 'sys/mounts/turns'))
  assert.ok(mock.calls.every(({ method }) => method !== 'DELETE'))
  assert.deepEqual(
    mock.calls
      .filter(({ path, method }) => path.endsWith('/config') && method === 'POST')
      .map(({ path, body }) => [path, body]),
    [
      ['turns/config', mounts.turns],
      ['subs/config', mounts.subs],
    ],
  )
  assert.equal(
    mock.calls.filter(({ path }) => path.startsWith('sys/policies/acl/')).length,
    policyNames.length,
  )
})

test('a mount that failed to enable stops the run and is enabled by the next one', async () => {
  const mock = mockVault()
  const failing = async (url, options) => {
    if (new URL(url).pathname === '/v1/sys/mounts/transit' && options.method === 'POST')
      return new Response(JSON.stringify({ errors: ['synthetic-private-server-error'] }), {
        status: 500,
      })
    return mock.fetchImpl(url, options)
  }
  const options = { address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }
  await assert.rejects(
    bootstrapLocalVault({ ...options, fetchImpl: failing }),
    (error) => error.message === 'Enable Transit mount failed (HTTP 500)',
  )
  assert.ok(!mock.calls.some(({ path }) => path.startsWith('sys/policies/')))
  assert.deepEqual((await bootstrapLocalVault(options)).created, ['transit'])
})

test('the summary names the mounts, counts the policies and says what a new mount has lost', () => {
  const all = ['turns', 'subs', 'kv', 'transit']
  assert.deepEqual(bootstrapSummary({ mounts: all, policies: [...policyNames], created: [] }), [
    'Local OpenBao ready: turns/, subs/, kv/, transit/; 10 policies',
  ])
  const [, fresh] = bootstrapSummary({ mounts: all, policies: [...policyNames], created: all })
  assert.match(fresh, /^Created now: turns\/, subs\/, kv\/, transit\/\. /)
  assert.match(fresh, /log subscription accounts in again/)
  assert.match(fresh, /site access and contact maps/)
  assert.match(fresh, /workspace keys/)
  const [, partial] = bootstrapSummary({ mounts: all, policies: [], created: ['turns', 'kv'] })
  assert.match(partial, /^Created now: turns\/, kv\/\. /)
  assert.match(partial, /site access and contact maps/)
  assert.doesNotMatch(partial, /subscription|workspace keys/)
})

test('a mount with default settings that already holds keys still needs operator review', async () => {
  for (const name of ['turns', 'subs']) {
    const mock = mockVault({
      inventory: { [`${name}/`]: { type: 'kv', options: { version: '2' } } },
      keys: { [name]: ['synthetic-key'] },
    })
    await assert.rejects(
      bootstrapLocalVault({ address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }),
      /configuration differs; explicit operator review is required/,
    )
    assert.ok(mock.calls.every(({ method }) => method === 'GET'))
  }
})

test('equivalent server duration formats are accepted without configuration writes', async () => {
  for (const duration of ['25m0s', '1500s', 1500]) {
    const mock = mockVault({
      inventory: { 'turns/': { type: 'kv', options: { version: 2 } } },
      configurations: { turns: { ...mounts.turns, delete_version_after: duration } },
    })
    await bootstrapLocalVault({
      address: 'http://127.0.0.1:8200',
      token: 'synthetic-root',
      ...mock,
    })
    assert.ok(!mock.calls.some(({ path, method }) => path === 'turns/config' && method === 'POST'))
  }
})

test('waiting for a just-started server polls its health without a token and gives up in time', async () => {
  const answers = [new Error('synthetic-private-network-value'), 503, 501, 200]
  const tokens = []
  const options = {
    address: 'http://127.0.0.1:8200',
    token: 'synthetic-root',
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, '/v1/sys/health')
      tokens.push(init.headers['X-Vault-Token'])
      const answer = answers.shift() ?? 503
      if (answer instanceof Error) throw answer
      return new Response('{}', { status: answer })
    },
  }
  await waitForLocalVault(options)
  assert.deepEqual(answers, [])
  assert.deepEqual(tokens, [undefined, undefined, undefined, undefined])
  await assert.rejects(
    waitForLocalVault(options, { timeoutMs: 1000, intervalMs: 250 }),
    (error) => error.message === 'Local OpenBao did not become ready',
  )
  assert.equal(tokens.length, 4 + 5)
})

test('the command line takes the token from stdin only and rejects other arguments', async () => {
  const script = fileURLToPath(new URL('./bootstrap.mjs', import.meta.url))
  for (const args of [
    [],
    ['--address'],
    ['--wait', '--address', 'http://127.0.0.1:8200'],
    ['--address', 'http://127.0.0.1:8200', '--token', 'synthetic-root'],
    ['--address', 'http://127.0.0.1:8200', '--wait', 'extra'],
  ]) {
    const rejected = spawnSync(process.execPath, [script, ...args], {
      input: 'synthetic-root\n',
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(rejected.status, 1, args.join(' '))
    assert.match(rejected.stderr, /^Usage: node infra\/vault\/bootstrap\.mjs --address /)
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-root/)
  }
  // `pnpm vault:bootstrap` pipes nothing when the dev container is not running: say so at
  // once instead of waiting for a server first. Nothing listens on the discard port.
  for (const args of [
    ['--address', 'http://127.0.0.1:8200'],
    ['--address', 'http://127.0.0.1:9', '--wait'],
  ]) {
    const empty = spawnSync(process.execPath, [script, ...args], {
      input: '\n',
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(empty.status, 1, args.join(' '))
    assert.equal(empty.stderr.trim(), 'OpenBao operator token is required')
  }
})

test('bootstrap and API failures expose status, without private response or transport values', async () => {
  const mock = mockVault({ failedPolicy: true })
  await assert.rejects(
    bootstrapLocalVault({ address: 'http://127.0.0.1:8200', token: 'synthetic-root', ...mock }),
    (error) => error.message === 'Write policy failed (HTTP 403)',
  )
  await assert.rejects(
    localVaultRequest(
      {
        address: 'http://127.0.0.1:8200',
        fetchImpl: async () => {
          throw new Error('synthetic-private-network-value')
        },
      },
      'sys/health',
    ),
    (error) => error.message === 'Local OpenBao request failed',
  )
})

test('address validation rejects cloud, DNS names, URL credentials and redirects before I/O', async () => {
  for (const address of [
    'https://vault.example.com',
    'http://localhost:8200',
    'http://192.168.1.10:8200',
    'http://127.0.0.1:8200/v1',
    'http://private:secret@127.0.0.1:8200',
    'http://127.0.0.1:8200?token=private',
    'http://127.0.0.1:8200#private',
    'file:///tmp/vault',
    undefined,
  ]) {
    assert.throws(() => localVaultAddress(address), /loopback/)
  }
  assert.equal(localVaultAddress('http://127.0.0.1:8200/'), 'http://127.0.0.1:8200')
  assert.equal(localVaultAddress('https://[::1]:8200'), 'https://[::1]:8200')
  let called = false
  await assert.rejects(
    localVaultRequest(
      {
        address: 'http://127.0.0.1:8200',
        token: 'private\nvalue',
        fetchImpl: () => (called = true),
      },
      'sys/health',
    ),
    /Invalid OpenBao token input/,
  )
  assert.equal(called, false)
})

test('local verification rejects remote Docker endpoints before launching any container', () => {
  for (const endpoint of [
    'tcp://127.0.0.1:2375',
    'tcp://cloud.example.com:2376',
    'ssh://operator@cloud.example.com',
    'https://cloud.example.com',
    'unix://cloud.example.com/var/run/docker.sock',
    'unix:///tmp/docker.sock?remote=cloud',
    undefined,
  ]) {
    assert.throws(() => assertLocalDockerEndpoint(endpoint), /local Docker/)
  }
  assert.doesNotThrow(() => assertLocalDockerEndpoint('unix:///var/run/docker.sock'))
  assert.doesNotThrow(() =>
    assertLocalDockerEndpoint('unix:///Users/test/.orbstack/run/docker.sock'),
  )
  assert.doesNotThrow(() => assertLocalDockerEndpoint('npipe:////./pipe/docker_engine'))
  const script = fileURLToPath(new URL('./verify-local.mjs', import.meta.url))
  const rejected = spawnSync(process.execPath, [script], {
    env: { DOCKER_HOST: 'ssh://operator@cloud.example.com' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.stdout, '')
  assert.equal(
    rejected.stderr.trim(),
    'Local verification requires a local Docker unix socket or named pipe',
  )
})
