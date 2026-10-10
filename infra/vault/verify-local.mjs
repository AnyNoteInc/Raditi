import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  bootstrapLocalVault,
  localVaultRequest,
  mounts,
  plainMounts,
  policyNames,
} from './bootstrap.mjs'

const image = 'ghcr.io/openbao/openbao:2.7.0'
const containerLabel = 'io.raditi.vault-local-verification'
const serverConfig = `disable_mlock = true
storage "inmem" {}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_disable = true
}
`

export function assertLocalDockerEndpoint(endpoint) {
  if (
    typeof endpoint !== 'string' ||
    !/^(unix:\/\/\/[^\s?#]+|npipe:\/\/\/[/\\][^\s?#]+)$/.test(endpoint)
  ) {
    throw new Error('Local verification requires a local Docker unix socket or named pipe')
  }
}

function requireLocalDocker() {
  if (process.env.DOCKER_HOST) assertLocalDockerEndpoint(process.env.DOCKER_HOST)
  const context = process.env.DOCKER_CONTEXT || docker(['context', 'show'])
  const endpoint = docker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'])
  assertLocalDockerEndpoint(endpoint)
}

function docker(args, input) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1_000_000,
    ...(input === undefined ? {} : { input }),
  })
  if (result.error || result.status !== 0) throw new Error('Local OpenBao Docker operation failed')
  return result.stdout.trim()
}

/** Starts only an owned disposable container; no .env files or existing secret tokens are read. */
export async function verifyLocalVault({ verifyClient = verifyKvClient } = {}) {
  requireLocalDocker()
  docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  const ownership = randomBytes(16).toString('hex')
  const name = `raditi-vault-verify-${ownership}`
  let owned = false
  let interrupted = false
  const cleanup = () => {
    if (!owned) return
    try {
      const label = docker([
        'inspect',
        name,
        '--format',
        `{{index .Config.Labels "${containerLabel}"}}`,
      ])
      if (label !== ownership) throw new Error('Local OpenBao container ownership changed')
      docker(['rm', '-f', name])
      owned = false
    } catch (error) {
      // A signal may already have removed it; never remove a different container.
      if (owned) throw error
    }
  }
  const onSignal = () => {
    interrupted = true
    try {
      cleanup()
    } catch {
      // The finalizer retries cleanup and reports a failure without exposing Docker output.
    }
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let checks = 0
  try {
    // Regular server + API init keep root and unseal values out of args, env and logs.
    owned = true
    docker([
      'run',
      '-d',
      '--pull=never',
      '--name',
      name,
      '--label',
      `${containerLabel}=${ownership}`,
      '-p',
      '127.0.0.1::8200',
      '--entrypoint',
      'sh',
      image,
      '-c',
      `umask 077; cat > /tmp/raditi-bao.hcl <<'RADITI_CONFIG'\n${serverConfig}RADITI_CONFIG\nexec bao server -config=/tmp/raditi-bao.hcl`,
    ])
    const published = docker(['port', name, '8200/tcp'])
    assert.match(published, /^127\.0\.0\.1:\d+$/, 'OpenBao must bind only to loopback')
    const address = `http://${published}`
    const anonymous = { address }
    const readyUntil = Date.now() + 15_000
    let available = false
    while (Date.now() < readyUntil && !interrupted) {
      try {
        const result = await localVaultRequest(anonymous, 'sys/health')
        if ([200, 501, 503].includes(result.status)) {
          available = true
          break
        }
      } catch {
        // A fresh container may not be listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(available && !interrupted, 'Local OpenBao did not become ready')
    const initialized = await localVaultRequest(anonymous, 'sys/init', {
      method: 'POST',
      body: { secret_shares: 1, secret_threshold: 1 },
    })
    assert.equal(initialized.status, 200, 'OpenBao initialization failed')
    assert.ok(
      typeof initialized.body?.root_token === 'string' &&
        typeof initialized.body?.keys_base64?.[0] === 'string',
      'OpenBao initialization response is invalid',
    )
    const unsealed = await localVaultRequest(anonymous, 'sys/unseal', {
      method: 'POST',
      body: { key: initialized.body.keys_base64[0] },
    })
    assert.equal(unsealed.status, 200, 'OpenBao unseal failed')
    assert.equal(unsealed.body?.sealed, false, 'OpenBao remains sealed')
    const rootToken = initialized.body.root_token
    const rootOptions = { address, token: rootToken }
    const write = (data, cas) => ({
      method: 'POST',
      body: { options: { cas }, data },
    })
    const expect = async (token, path, status, options) => {
      const result = await localVaultRequest({ address, token }, path, options)
      assert.equal(result.status, status, `Unexpected ACL result for ${path}`)
      checks += 1
      return result.body
    }
    // A run interrupted between enabling turns/ and configuring it. Bootstrap finishes such a
    // mount only while it is empty: a key in it still needs an operator.
    await expect(rootToken, 'sys/mounts/turns', 204, {
      method: 'POST',
      body: { type: 'kv', options: { version: '2' } },
    })
    const strayKey = 'turns/data/t_synthetic_interrupted'
    // A new KV v2 mount refuses writes with 400 while it finishes its upgrade.
    const strayWriteUntil = Date.now() + 10_000
    let strayWrite = await localVaultRequest(rootOptions, strayKey, write({ key: 'synthetic' }))
    while (strayWrite.status === 400 && Date.now() < strayWriteUntil) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      strayWrite = await localVaultRequest(rootOptions, strayKey, write({ key: 'synthetic' }))
    }
    assert.equal(strayWrite.status, 200, 'Unconfigured mount write failed')
    await assert.rejects(
      bootstrapLocalVault(rootOptions),
      /^Error: Existing turns\/ configuration differs; explicit operator review is required$/,
    )
    checks += 1
    const untouched = await expect(rootToken, 'sys/mounts', 200)
    assert.equal(untouched?.data?.['subs/'], undefined, 'A refused bootstrap created subs/')
    await expect(rootToken, 'sys/policies/acl/core-turns', 404)
    await expect(rootToken, 'turns/metadata/t_synthetic_interrupted', 204, { method: 'DELETE' })
    // Another engine under a name bootstrap needs is never replaced: the run stops before
    // any change, although turns/ is ready to be finished and subs/ and kv/ are missing.
    await expect(rootToken, 'sys/mounts/transit', 204, { method: 'POST', body: { type: 'kv' } })
    await assert.rejects(
      bootstrapLocalVault(rootOptions),
      /^Error: Existing transit\/ is not Transit; no mount was reset$/,
    )
    checks += 1
    const refused = await expect(rootToken, 'sys/mounts', 200)
    assert.equal(refused?.data?.['subs/'], undefined, 'A refused bootstrap created subs/')
    assert.equal(refused?.data?.['kv/'], undefined, 'A refused bootstrap created kv/')
    assert.equal(refused?.data?.['transit/']?.type, 'kv', 'A refused bootstrap reset transit/')
    await expect(rootToken, 'sys/policies/acl/mcp-content', 404)
    await expect(rootToken, 'sys/mounts/transit', 204, { method: 'DELETE' })
    // subs/ is new here: its configuration write races the upgrade of a just-enabled mount.
    assert.deepEqual((await bootstrapLocalVault(rootOptions)).created, ['subs', 'kv', 'transit'])
    checks += 1
    for (const [name, expected] of Object.entries(mounts)) {
      const config = await expect(rootToken, `${name}/config`, 200)
      assert.equal(config?.data?.max_versions, expected.max_versions, `${name}/ history`)
      assert.equal(config?.data?.cas_required, expected.cas_required, `${name}/ CAS`)
    }
    const enabled = await expect(rootToken, 'sys/mounts', 200)
    for (const [name, expected] of Object.entries(plainMounts)) {
      const mount = enabled?.data?.[`${name}/`]
      assert.equal(mount?.type, expected.type, `${name}/ engine`)
      if (expected.options)
        assert.equal(String(mount?.options?.version), expected.options.version, `${name}/ version`)
    }
    // kv/ keeps the server defaults: its settings are not this script's to choose yet.
    const kvConfig = await expect(rootToken, 'kv/config', 200)
    assert.equal(kvConfig?.data?.cas_required, false, 'kv/ CAS')
    assert.equal(kvConfig?.data?.max_versions, 0, 'kv/ history')
    const scopedTokens = {}
    for (const policy of policyNames) {
      const issued = await expect(rootToken, 'auth/token/create', 200, {
        method: 'POST',
        body: {
          policies: [policy],
          no_default_policy: true,
          ttl: '15m',
          explicit_max_ttl: '15m',
          renewable: false,
        },
      })
      assert.ok(typeof issued?.auth?.client_token === 'string', 'Scoped token creation failed')
      scopedTokens[policy] = issued.auth.client_token
    }
    const core = scopedTokens['core-turns']
    const llm = scopedTokens['llm-subscriptions']
    const writer = scopedTokens['subscriptions-writer']
    const admin = scopedTokens['subscriptions-admin']
    const sub = 'zai-coding/synthetic-account'
    const turn = 't_synthetic_1_1'

    await expect(writer, `subs/data/${sub}`, 200, write({ token: 'synthetic-v1' }, 0))
    await expect(writer, `subs/data/${sub}`, 403)
    const writerMetadata = await expect(writer, `subs/metadata/${sub}`, 200)
    assert.equal(writerMetadata?.data?.current_version, 1)
    await expect(writer, 'subs/metadata/zai-coding', 403, { method: 'LIST' })
    await expect(writer, `subs/metadata/${sub}`, 403, {
      method: 'POST',
      body: { max_versions: 100 },
    })
    await expect(writer, `subs/data/${sub}`, 200, write({ token: 'synthetic-v2' }, 1))
    await expect(writer, `subs/data/${sub}`, 400, write({ token: 'synthetic-stale' }, 1))
    await expect(writer, `subs/data/${sub}`, 400, {
      method: 'POST',
      body: { data: { token: 'synthetic-no-cas' } },
    })
    const current = await expect(llm, `subs/data/${sub}`, 200)
    assert.equal(current?.data?.metadata?.version, 2)
    assert.ok(current?.data?.data?.token === 'synthetic-v2', 'Current subscription value differs')
    const old = await expect(llm, `subs/data/${sub}?version=1`, 404)
    assert.ok(old?.data?.data == null, 'A spent subscription credential remains readable')
    await expect(llm, `subs/data/${sub}`, 200, write({ token: 'synthetic-v3' }, 2))
    await expect(llm, 'subs/data/zai-coding/new-account', 403, write({ token: 'synthetic' }, 0))
    for (const path of [
      `subs/metadata/${sub}`,
      'turns/data/unknown',
      'kv/sites/unknown',
      'ops/data/x',
    ]) {
      await expect(llm, path, 403)
    }
    for (const [path, method] of [
      [`subs/data/${sub}`, 'DELETE'],
      [`subs/metadata/${sub}`, 'DELETE'],
      [`subs/delete/${sub}`, 'POST'],
      [`subs/undelete/${sub}`, 'POST'],
      [`subs/destroy/${sub}`, 'POST'],
    ]) {
      await expect(llm, path, 403, {
        method,
        ...(method === 'POST' ? { body: { versions: [3] } } : {}),
      })
    }

    await expect(core, `turns/data/${turn}`, 200, write({ key: 'synthetic-turn-key' }, 0))
    // The server's custom-metadata limits, which kvCreateOnce enforces before writing data.
    const fields = (count, value) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`field_${i}`, value]))
    for (const custom_metadata of [
      fields(65, 'x'),
      { sessionId: 'x'.repeat(513) },
      { sessionId: 'я'.repeat(257) },
      { sessionId: '' },
      { sessionId: 'synthetic\nsession' },
      { sessionId: 'synthetic session' },
      { ['k'.repeat(129)]: 'x' },
    ]) {
      await expect(core, `turns/metadata/${turn}`, 400, {
        method: 'POST',
        body: { custom_metadata },
      })
    }
    for (const custom_metadata of [
      fields(64, 'x'.repeat(512)),
      { sessionId: 'я'.repeat(256), ['k'.repeat(128)]: 'é + \u{1F600} = ok' },
    ]) {
      await expect(core, `turns/metadata/${turn}`, 204, {
        method: 'POST',
        body: { custom_metadata },
      })
    }
    await expect(core, `turns/metadata/${turn}`, 204, {
      method: 'POST',
      body: { custom_metadata: { sessionId: 'synthetic-session' } },
    })
    // Bootstrap can be repeated without touching existing credentials or metadata.
    assert.deepEqual((await bootstrapLocalVault(rootOptions)).created, [])
    const recovered = await expect(core, `turns/data/${turn}`, 200)
    assert.ok(recovered?.data?.data?.key === 'synthetic-turn-key', 'Bootstrap changed a turn key')
    const metadata = await expect(core, `turns/metadata/${turn}`, 200)
    assert.equal(metadata?.data?.custom_metadata?.sessionId, 'synthetic-session')
    const created = Date.parse(metadata?.data?.versions?.['1']?.created_time)
    const deletion = Date.parse(metadata?.data?.versions?.['1']?.deletion_time)
    assert.equal(deletion - created, 25 * 60_000, 'Turn retention differs from the mount ceiling')
    await expect(core, 'turns/metadata', 200, { method: 'LIST' })
    await expect(core, `turns/data/${turn}`, 403, write({ key: 'synthetic-replacement' }, 0))
    await expect(core, `turns/data/${turn}`, 403, write({ key: 'synthetic-replacement' }, 1))
    for (const body of [
      { max_versions: 100 },
      { cas_required: false },
      { delete_version_after: '0s' },
    ]) {
      await expect(core, `turns/metadata/${turn}`, 403, { method: 'POST', body })
    }
    await expect(core, `turns/data/${turn}`, 204, { method: 'DELETE' })
    const deleted = await expect(core, `turns/data/${turn}`, 404)
    assert.ok(deleted?.data?.data == null, 'Soft-deleted turn remains readable')
    await expect(core, `turns/data/${turn}`, 403, write({ key: 'synthetic-replacement' }, 0))
    for (const path of [`turns/undelete/${turn}`, `turns/destroy/${turn}`]) {
      await expect(core, path, 403, { method: 'POST', body: { versions: [1] } })
    }
    for (const path of [
      `subs/data/${sub}`,
      `subs/metadata/${sub}`,
      'kv/sites/unknown',
      'ops/data/x',
    ]) {
      await expect(core, path, 403)
    }
    await expect(core, `turns/metadata/${turn}`, 204, { method: 'DELETE' })
    await expect(core, `turns/metadata/${turn}`, 404)

    await expect(admin, `subs/data/${sub}`, 403)
    await expect(admin, `subs/metadata/${sub}`, 403)
    await expect(admin, `subs/destroy/${sub}`, 204, { method: 'POST', body: { versions: [3] } })
    await expect(llm, `subs/data/${sub}`, 404)
    await expect(admin, `subs/metadata/${sub}`, 204, { method: 'DELETE' })
    await expect(writer, `subs/metadata/${sub}`, 404)

    const content = await verifyContentAccess({ address, rootToken, scopedTokens, turn, expect })
    const clientChecks = verifyClient
      ? await verifyClient({ address, scopedTokens, rootToken, content })
      : 0
    assert.ok(!interrupted, 'Local OpenBao verification was interrupted')
    return { image, checks, clientChecks, clientVerified: Boolean(verifyClient), cleanedUp: true }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    cleanup()
  }
}

/**
 * Real rights of the content path: the trusted writers, then the `mcp` and `core` roles logged
 * in through AppRole. Every status below is an answer of the server, not of a policy parser.
 */
async function verifyContentAccess({ address, rootToken, scopedTokens, turn, expect }) {
  const root = { address, token: rootToken }
  const post = (body) => ({ method: 'POST', ...(body === undefined ? {} : { body }) })
  const write = (data, cas) => post({ options: { cas }, data })
  const siteId = randomUUID()
  const taskId = randomUUID()
  const key = `ws-${randomUUID()}`
  const foreignKey = `other-${randomBytes(6).toString('hex')}`
  const keyType = { type: 'aes256-gcm96' }
  const access = (password) => ({
    v: '1',
    origin: 'https://synthetic-site.invalid',
    username: 'synthetic-editor',
    applicationPassword: password,
  })
  const wp = `sites/${siteId}/wp`
  const ssh = `sites/${siteId}/ssh`
  const mask = `content-masks/${siteId}/${taskId}`
  const sub = 'zai-coding/synthetic-content'

  // workspace-provisioner: a new workspace key and nothing else about it.
  const provisioner = scopedTokens['workspace-provisioner']
  await expect(provisioner, `transit/keys/${key}`, 200, post(keyType))
  await expect(provisioner, `transit/keys/${key}`, 200, post(keyType))
  const made = await expect(rootToken, `transit/keys/${key}`, 200)
  assert.equal(made?.data?.type, 'aes256-gcm96', 'Workspace key type')
  assert.equal(made?.data?.latest_version, 1, 'A repeated creation rotated the workspace key')
  assert.equal(made?.data?.exportable, false, 'Workspace key is exportable')
  assert.equal(made?.data?.deletion_allowed, false, 'Workspace key can be deleted')
  for (const [name, body] of [
    [`ws-${randomUUID()}`, { type: 'rsa-2048' }],
    [`ws-${randomUUID()}`, { ...keyType, exportable: true }],
    [`ws-${randomUUID()}`, { ...keyType, derived: true }],
    [`ws-${randomUUID()}`, { ...keyType, allow_plaintext_backup: true }],
    [foreignKey, keyType],
  ]) {
    await expect(provisioner, `transit/keys/${name}`, 403, post(body))
  }
  for (const body of [
    { deletion_allowed: true },
    { exportable: true },
    { allow_plaintext_backup: true },
    { min_decryption_version: 2 },
  ]) {
    await expect(provisioner, `transit/keys/${key}/config`, 403, post(body))
  }
  // Imported key material would be a workspace key the provisioner knows: it is a parameter too.
  const material = { ciphertext: 'c3ludGhldGlj', hash_function: 'SHA256' }
  for (const [path, body] of [
    [`transit/keys/ws-${randomUUID()}/import`, { ...keyType, ...material }],
    [`transit/keys/${key}/import_version`, material],
  ]) {
    await expect(provisioner, path, 403, post(body))
  }
  for (const [path, options] of [
    [`transit/keys/${key}`, {}],
    [`transit/keys/${key}`, { method: 'DELETE' }],
    [`transit/keys/${key}/soft-delete`, { method: 'DELETE' }],
    [`transit/keys/${key}/trim`, post({ min_available_version: 1 })],
    ['transit/keys', { method: 'LIST' }],
    [`transit/export/encryption-key/${key}`, {}],
    [`transit/backup/${key}`, {}],
    [`transit/restore/${key}`, post({ backup: 'synthetic' })],
    [`transit/datakey/plaintext/${key}`, post({ bits: 256 })],
    [`transit/encrypt/${key}`, post({ plaintext: 'c3ludGhldGlj' })],
    [`kv/data/${wp}`, {}],
    [`kv/data/${wp}`, write(access('synthetic-provisioner'), 0)],
  ]) {
    await expect(provisioner, path, 403, options)
  }
  await expect(rootToken, `transit/keys/${foreignKey}`, 200, post(keyType))

  // sites-writer: stores site access with CAS and cannot read it back.
  const sitesWriter = scopedTokens['sites-writer']
  await expect(sitesWriter, `kv/data/${wp}`, 200, write(access('synthetic-password-1'), 0))
  await expect(sitesWriter, `kv/data/${ssh}`, 200, write({ v: '1', key: 'synthetic-ssh' }, 0))
  await expect(sitesWriter, `kv/data/${wp}`, 403)
  const stored = await expect(sitesWriter, `kv/metadata/${wp}`, 200)
  assert.equal(stored?.data?.current_version, 1)
  await expect(sitesWriter, `kv/data/${wp}`, 400, write(access('synthetic-stale'), 0))
  await expect(sitesWriter, `kv/data/${wp}`, 200, write(access('synthetic-password-2'), 1))
  for (const [path, options] of [
    [`kv/metadata/sites/${siteId}`, { method: 'LIST' }],
    [`kv/metadata/${wp}`, post({ max_versions: 1 })],
    [`kv/metadata/${wp}`, { method: 'DELETE' }],
    [`kv/data/${wp}`, { method: 'DELETE' }],
    [`kv/destroy/${wp}`, post({ versions: [1] })],
    [`kv/data/${mask}`, {}],
    [`kv/data/${mask}`, write({ entries: '[]' }, 0)],
    [`kv/data/platform/app/mcp`, write({ value: 'synthetic' }, 0)],
    [`turns/data/${turn}`, {}],
    [`subs/data/${sub}`, write({ token: 'synthetic' }, 0)],
    [`transit/keys/${key}`, {}],
    [`transit/datakey/plaintext/${key}`, post({ bits: 256 })],
  ]) {
    await expect(sitesWriter, path, 403, options)
  }

  // The policies of other services open nothing here.
  for (const policy of [
    'core-turns',
    'llm-subscriptions',
    'subscriptions-writer',
    'subscriptions-admin',
  ]) {
    for (const [path, options] of [
      [`transit/datakey/plaintext/${key}`, post({ bits: 256 })],
      [`kv/data/${wp}`, {}],
      [`kv/data/${wp}`, write(access('synthetic-foreign'), 2)],
      [`kv/data/${mask}`, {}],
    ]) {
      await expect(scopedTokens[policy], path, 403, options)
    }
  }

  // AppRole logins of the two services. A SecretID works once.
  const roles = {
    mcp: { name: 'raditi-verify-mcp', policies: ['mcp-content'] },
    core: { name: 'raditi-verify-core', policies: ['core-turns', 'core-transit'] },
  }
  await expect(rootToken, 'sys/auth/approle', 204, post({ type: 'approle' }))
  const credentials = {}
  const tokens = {}
  for (const [service, { name, policies }] of Object.entries(roles)) {
    await expect(
      rootToken,
      `auth/approle/role/${name}`,
      204,
      post({
        token_policies: policies,
        token_no_default_policy: true,
        token_ttl: '15m',
        token_max_ttl: '15m',
        secret_id_num_uses: 1,
        secret_id_ttl: '15m',
      }),
    )
    const roleId = (await localVaultRequest(root, `auth/approle/role/${name}/role-id`)).body?.data
      ?.role_id
    const secretId = async () =>
      (await localVaultRequest(root, `auth/approle/role/${name}/secret-id`, post())).body?.data
        ?.secret_id
    const login = await localVaultRequest({ address }, 'auth/approle/login', {
      method: 'POST',
      body: { role_id: roleId, secret_id: await secretId() },
    })
    assert.equal(login.status, 200, 'AppRole login failed')
    assert.deepEqual([...(login.body?.auth?.token_policies ?? [])].sort(), [...policies].sort())
    assert.deepEqual([...(login.body?.auth?.policies ?? [])].sort(), [...policies].sort())
    assert.ok(typeof login.body?.auth?.client_token === 'string', 'AppRole login failed')
    tokens[service] = login.body.auth.client_token
    // The client checks log in on their own; the core one proves it needs a single login.
    credentials[service] = { roleId, secretId: await secretId() }
    assert.ok(
      typeof roleId === 'string' && typeof credentials[service].secretId === 'string',
      'AppRole setup failed',
    )
  }
  const { mcp, core } = tokens

  // mcp: the contact map of a task — created, replaced and read with CAS, removed entirely.
  await expect(mcp, `kv/data/${mask}`, 404)
  await expect(mcp, `kv/data/${mask}`, 200, write({ entries: '[]' }, 0))
  await expect(mcp, `kv/data/${mask}`, 400, write({ entries: '["synthetic-lost-race"]' }, 0))
  const firstMap = await expect(mcp, `kv/data/${mask}`, 200)
  assert.equal(firstMap?.data?.metadata?.version, 1)
  assert.ok(firstMap?.data?.data?.entries === '[]', 'Contact map differs')
  await expect(mcp, `kv/data/${mask}`, 200, write({ entries: '["synthetic-contact"]' }, 1))
  await expect(mcp, `kv/data/${mask}`, 400, write({ entries: '["synthetic-stale"]' }, 1))
  const secondMap = await expect(mcp, `kv/data/${mask}`, 200)
  assert.equal(secondMap?.data?.metadata?.version, 2)
  assert.ok(secondMap?.data?.data?.entries === '["synthetic-contact"]', 'Contact map differs')
  for (const [path, options] of [
    [`kv/metadata/${mask}`, {}],
    [`kv/metadata/${mask}`, post({ max_versions: 100 })],
    [`kv/metadata/content-masks/${siteId}`, { method: 'LIST' }],
    [`kv/data/${mask}`, { method: 'DELETE' }],
    [`kv/delete/${mask}`, post({ versions: [1] })],
    [`kv/undelete/${mask}`, post({ versions: [1] })],
    [`kv/destroy/${mask}`, post({ versions: [1] })],
  ]) {
    await expect(mcp, path, 403, options)
  }
  // Until the map is removed its earlier version stays readable: kv/ keeps history.
  await expect(mcp, `kv/data/${mask}?version=1`, 200)
  await expect(mcp, `kv/metadata/${mask}`, 204, { method: 'DELETE' })
  await expect(mcp, `kv/data/${mask}`, 404)
  await expect(rootToken, `kv/metadata/${mask}`, 404)
  await expect(rootToken, `kv/data/${mask}?version=1`, 404)

  // mcp: the WordPress access of a site is read-only; other kinds of access are closed.
  const site = await expect(mcp, `kv/data/${wp}`, 200)
  assert.equal(site?.data?.metadata?.version, 2)
  assert.ok(
    site?.data?.data?.applicationPassword === 'synthetic-password-2' &&
      site.data.data.username === 'synthetic-editor',
    'Site access differs',
  )
  // kv/ keeps history here as well: the access that was replaced stays readable, and its
  // writer cannot remove it (refused above).
  const replaced = await expect(mcp, `kv/data/${wp}?version=1`, 200)
  assert.ok(
    replaced?.data?.data?.applicationPassword === 'synthetic-password-1',
    'Replaced site access differs',
  )
  for (const [path, options] of [
    [`kv/data/${ssh}`, {}],
    [`kv/data/sites/${siteId}/ftp`, {}],
    [`kv/data/sites/${siteId}/browser`, {}],
    [`kv/data/sites/${siteId}/wp/extra`, {}],
    [`kv/data/sites/${siteId}`, {}],
    [`kv/data/${wp}`, write(access('synthetic-mcp'), 2)],
    [`kv/data/sites/${randomUUID()}/wp`, write(access('synthetic-mcp'), 0)],
    [`kv/data/${wp}`, { method: 'DELETE' }],
    [`kv/metadata/${wp}`, {}],
    [`kv/metadata/${wp}`, { method: 'DELETE' }],
    [`kv/metadata/sites/${siteId}`, { method: 'LIST' }],
    ['kv/metadata/sites', { method: 'LIST' }],
    ['kv/data/platform/app/mcp', {}],
    ['kv/config', {}],
    [`turns/data/${turn}`, {}],
    [`turns/data/${turn}`, write({ key: 'synthetic' }, 0)],
    ['turns/metadata', { method: 'LIST' }],
    [`subs/data/${sub}`, {}],
    [`subs/data/${sub}`, write({ token: 'synthetic' }, 0)],
    [`subs/metadata/${sub}`, {}],
    ['ops/data/x', {}],
    ['sys/mounts', {}],
    ['auth/token/create', post({ policies: ['mcp-content'] })],
  ]) {
    await expect(mcp, path, 403, options)
  }

  // mcp: a data key for a content snapshot and its unwrapping — and no way to the key itself.
  const dataKey = { bits: 256 }
  const issued = await expect(mcp, `transit/datakey/plaintext/${key}`, 200, post(dataKey))
  const wrapped = issued?.data?.ciphertext
  assert.ok(typeof wrapped === 'string' && wrapped.startsWith('vault:v1:'), 'Wrapped key differs')
  assert.equal(Buffer.from(issued?.data?.plaintext ?? '', 'base64').length, 32)
  const unwrapped = await expect(mcp, `transit/decrypt/${key}`, 200, post({ ciphertext: wrapped }))
  assert.ok(unwrapped?.data?.plaintext === issued.data.plaintext, 'Unwrapped data key differs')
  for (const [path, options] of [
    [`transit/keys/${key}`, {}],
    [`transit/keys/${key}`, post(keyType)],
    [`transit/keys/ws-${randomUUID()}`, post(keyType)],
    [`transit/keys/${key}`, { method: 'DELETE' }],
    [`transit/keys/${key}/config`, post({ deletion_allowed: true })],
    [`transit/keys/${key}/rotate`, post()],
    ['transit/keys', { method: 'LIST' }],
    [`transit/export/encryption-key/${key}`, {}],
    [`transit/backup/${key}`, {}],
    [`transit/encrypt/${key}`, post({ plaintext: 'c3ludGhldGlj' })],
    [`transit/rewrap/${key}`, post({ ciphertext: wrapped })],
    [`transit/datakey/wrapped/${key}`, post(dataKey)],
    [`transit/datakey/plaintext/${foreignKey}`, post(dataKey)],
    [`transit/decrypt/${foreignKey}`, post({ ciphertext: wrapped })],
  ]) {
    await expect(mcp, path, 403, options)
  }
  // A workspace without a provisioned key gets an error, not a key created by the runtime.
  const unprovisioned = `ws-${randomUUID()}`
  await expect(mcp, `transit/datakey/plaintext/${unprovisioned}`, 400, post(dataKey))
  await expect(rootToken, `transit/keys/${unprovisioned}`, 404)

  // core: data keys of turn snapshots next to its turn keys; no site access and no maps.
  const coreIssued = await expect(core, `transit/datakey/plaintext/${key}`, 200, post(dataKey))
  const coreWrapped = coreIssued?.data?.ciphertext
  assert.ok(typeof coreWrapped === 'string', 'Wrapped key differs')
  const coreUnwrapped = await expect(
    core,
    `transit/decrypt/${key}`,
    200,
    post({ ciphertext: coreWrapped }),
  )
  assert.ok(coreUnwrapped?.data?.plaintext === coreIssued.data.plaintext, 'Data key differs')
  await expect(core, 'turns/data/t_synthetic_role_1_1', 200, write({ key: 'synthetic-turn' }, 0))
  for (const [path, options] of [
    [`kv/data/${wp}`, {}],
    [`kv/data/${ssh}`, {}],
    [`kv/data/${wp}`, write(access('synthetic-core'), 2)],
    [`kv/data/${mask}`, {}],
    [`kv/data/${mask}`, write({ entries: '[]' }, 0)],
    [`kv/metadata/${mask}`, { method: 'DELETE' }],
    [`transit/keys/${key}`, {}],
    [`transit/keys/ws-${randomUUID()}`, post(keyType)],
    [`transit/keys/${key}`, { method: 'DELETE' }],
    [`transit/keys/${key}/config`, post({ deletion_allowed: true })],
    [`transit/export/encryption-key/${key}`, {}],
    [`transit/encrypt/${key}`, post({ plaintext: 'c3ludGhldGlj' })],
    [`transit/datakey/plaintext/${foreignKey}`, post(dataKey)],
    [`subs/data/${sub}`, {}],
    ['ops/data/x', {}],
  ]) {
    await expect(core, path, 403, options)
  }
  // The workspace key is shared: either role unwraps what the other one wrapped. This is the
  // state of the code the owner still has to confirm (spec §15, §20).
  const crossed = await expect(
    mcp,
    `transit/decrypt/${key}`,
    200,
    post({ ciphertext: coreWrapped }),
  )
  assert.ok(crossed?.data?.plaintext === coreIssued.data.plaintext, 'Data key differs')
  const crossedBack = await expect(
    core,
    `transit/decrypt/${key}`,
    200,
    post({ ciphertext: wrapped }),
  )
  assert.ok(crossedBack?.data?.plaintext === issued.data.plaintext, 'Data key differs')

  // What the glob of the provisioner leaves reachable under a key: rotation and the undoing
  // of a soft deletion, both without parameters. Rotation keeps earlier wrapped keys readable.
  await expect(provisioner, `transit/keys/${key}/rotate`, 200, post())
  // The undoing is real: a key an operator has switched off serves the roles again.
  await expect(rootToken, `transit/keys/${key}/soft-delete`, 200, { method: 'DELETE' })
  await expect(mcp, `transit/datakey/plaintext/${key}`, 400, post(dataKey))
  await expect(mcp, `transit/decrypt/${key}`, 400, post({ ciphertext: wrapped }))
  await expect(provisioner, `transit/keys/${key}/soft-delete-restore`, 200, post())
  const rotated = await expect(rootToken, `transit/keys/${key}`, 200)
  assert.equal(rotated?.data?.soft_deleted, false, 'Workspace key stayed switched off')
  assert.equal(rotated?.data?.latest_version, 2)
  assert.equal(rotated?.data?.min_decryption_version, 1)
  assert.equal(rotated?.data?.exportable, false)
  assert.equal(rotated?.data?.deletion_allowed, false)
  const afterRotation = await expect(
    mcp,
    `transit/decrypt/${key}`,
    200,
    post({ ciphertext: wrapped }),
  )
  assert.ok(afterRotation?.data?.plaintext === issued.data.plaintext, 'Rotation lost a data key')
  const next = await expect(mcp, `transit/datakey/plaintext/${key}`, 200, post(dataKey))
  assert.ok(next?.data?.ciphertext?.startsWith('vault:v2:'), 'Rotation did not take effect')

  return {
    credentials,
    key,
    siteId,
    wrapped: { ciphertext: wrapped, plaintext: Buffer.from(issued.data.plaintext, 'base64') },
  }
}

async function verifyKvClient({ address, scopedTokens, rootToken, content }) {
  const { createVaultSecretStore, createDevSubscriptionToken } =
    await import('../../packages/vault/src/index.ts')
  let checks = 0
  const checked = async (name, operation) => {
    try {
      const result = await operation()
      checks += 1
      return result
    } catch {
      // Assertions and adapter failures must never disclose a returned credential.
      throw new Error(`Vault KV client check failed: ${name}`)
    }
  }
  const expectRejected = async (name, operation, status) =>
    checked(name, () => assert.rejects(operation, (error) => error.status === status))
  for (const policy of ['writer', 'admin']) {
    await checked(`dev ${policy} token has only its policy and a 15-minute lifetime`, async () => {
      const token = await createDevSubscriptionToken({
        appEnv: 'test',
        addr: address,
        rootToken,
        policy,
      })
      const lookup = await localVaultRequest({ address, token: rootToken }, 'auth/token/lookup', {
        method: 'POST',
        body: { token },
      })
      assert.equal(lookup.status, 200)
      assert.deepEqual(lookup.body.data.policies, [`subscriptions-${policy}`])
      assert.equal(lookup.body.data.renewable, false)
      assert.equal(lookup.body.data.explicit_max_ttl, 900)
      assert.ok(lookup.body.data.ttl > 0 && lookup.body.data.ttl <= 900)
    })
  }
  const trace = []
  const core = createVaultSecretStore({
    addr: address,
    token: scopedTokens['core-turns'],
    fetch: (input, options) => {
      trace.push([new URL(input).pathname, options.method])
      return fetch(input, options)
    },
  })
  const writer = createVaultSecretStore({
    addr: address,
    token: scopedTokens['subscriptions-writer'],
  })
  const llm = createVaultSecretStore({ addr: address, token: scopedTokens['llm-subscriptions'] })
  const admin = createVaultSecretStore({
    addr: address,
    token: scopedTokens['subscriptions-admin'],
  })
  const turn = 'turns/t_client_1_1'
  await checked('create once and data-before-metadata order', async () => {
    assert.equal(
      await core.kvCreateOnce(turn, { key: 'synthetic-client-key' }, { sessionId: 'client' }),
      'created',
    )
    assert.deepEqual(trace, [
      ['/v1/turns/data/t_client_1_1', 'POST'],
      ['/v1/turns/metadata/t_client_1_1', 'POST'],
    ])
  })
  await checked('read includes current version', async () => {
    const current = await core.kvRead(turn)
    assert.ok(current?.version === 1 && current.data.key === 'synthetic-client-key')
  })
  await checked('repeated create repairs metadata without changing credentials', async () => {
    assert.equal(
      await core.kvCreateOnce(turn, { key: 'synthetic-replacement' }, { sessionId: 'repaired' }),
      'exists',
    )
    const current = await core.kvRead(turn)
    assert.ok(current?.version === 1 && current.data.key === 'synthetic-client-key')
    const metadata = await core.kvMetadata(turn)
    assert.ok(metadata?.currentVersion === 1 && metadata.custom.sessionId === 'repaired')
    assert.ok(metadata.createdTime instanceof Date && !metadata.deleted && !metadata.destroyed)
  })
  await checked('repair interruption after data write', async () => {
    await core.kvWrite(
      'turns/t_client_interrupted_1_1',
      { key: 'synthetic-interrupted' },
      { cas: 0 },
    )
    assert.equal(
      await core.kvCreateOnce(
        'turns/t_client_interrupted_1_1',
        { key: 'synthetic-other' },
        { sessionId: 'recovered' },
      ),
      'exists',
    )
    const metadata = await core.kvMetadata('turns/t_client_interrupted_1_1')
    assert.ok(metadata?.custom.sessionId === 'recovered')
  })
  await expectRejected(
    'write-once update forbidden',
    () => core.kvWrite(turn, { key: 'synthetic-other' }, { cas: 1 }),
    403,
  )
  await checked('soft delete returns no data and retains a tombstone', async () => {
    await core.kvDelete(turn)
    assert.equal(await core.kvRead(turn), null)
    const metadata = await core.kvMetadata(turn)
    assert.ok(metadata?.deleted && !metadata.destroyed && metadata.currentVersion === 1)
  })
  await expectRejected(
    'deleted credentials cannot be recreated',
    () => core.kvCreateOnce(turn, { key: 'synthetic-new' }, {}),
    403,
  )
  await checked('destroy all deletes metadata and every version', async () => {
    await core.kvDestroyAll(turn)
    assert.equal(await core.kvRead(turn), null)
    assert.equal(await core.kvMetadata(turn), null)
  })
  await checked('LIST sorting, prefixes and client cursor', async () => {
    for (const key of ['b', 'a', 'nested/c']) {
      await core.kvCreateOnce(`turns/client-list/${key}`, { key: 'synthetic-list' }, {})
    }
    assert.deepEqual(await core.kvList('turns/client-list/'), ['a', 'b', 'nested/'])
    assert.deepEqual(await core.kvList('turns/client-list', { limit: 2 }), ['a', 'b'])
    assert.deepEqual(await core.kvList('turns/client-list', { after: 'b', limit: 2 }), ['nested/'])
    assert.deepEqual(await core.kvList('turns/client-list/nested'), ['c'])
    assert.deepEqual(await core.kvList('turns/nonexistent-prefix'), [])
  })
  await checked('near-limit payload survives server JSON escaping', async () => {
    const requestLimit = 64 * 1024
    const data = { first: '<>&'.repeat(10_922), second: '' }
    const remaining =
      requestLimit - Buffer.byteLength(JSON.stringify({ data, options: { cas: 0 } }), 'utf8')
    data.second = '<>&'.repeat(Math.ceil(remaining / 3)).slice(0, remaining)
    assert.equal(
      Buffer.byteLength(JSON.stringify({ data, options: { cas: 0 } }), 'utf8'),
      requestLimit,
    )
    assert.ok(Object.values(data).every((value) => value.length <= 32_768))
    const largeTurn = 'turns/t_client_large_1_1'
    assert.deepEqual(await core.kvWrite(largeTurn, data, { cas: 0 }), { version: 1 })
    assert.deepEqual(await core.kvRead(largeTurn), { data, version: 1 })
  })
  await checked('LIST beyond 64 KiB preserves every key across pages', async () => {
    const prefix = 'turns/client-large-list'
    const keys = Array.from({ length: 1500 }, () => `t_${randomUUID()}_1_1`).sort()
    assert.equal(new Set(keys).size, keys.length)
    // Even without the server envelope, this ordinary turn-key catalog exceeds 64 KiB.
    assert.ok(Buffer.byteLength(JSON.stringify({ data: { keys } }), 'utf8') > 64 * 1024)
    let nextIndex = 0
    const writes = await Promise.allSettled(
      Array.from({ length: 16 }, async () => {
        for (;;) {
          const key = keys[nextIndex++]
          if (key === undefined) return
          await core.kvWrite(`${prefix}/${key}`, { key: 'synthetic-list' }, { cas: 0 })
        }
      }),
    )
    assert.ok(
      writes.every((result) => result.status === 'fulfilled'),
      'Catalog creation failed',
    )
    assert.deepEqual(await core.kvList(prefix), keys)
    assert.deepEqual(await core.kvList(prefix, { limit: 10 }), keys.slice(0, 10))
    const collected = []
    let after
    const limit = 137
    for (let offset = 0; offset < keys.length; offset += limit) {
      const page = await core.kvList(prefix, { limit, ...(after === undefined ? {} : { after }) })
      assert.deepEqual(page, keys.slice(offset, offset + limit))
      collected.push(...page)
      after = page.at(-1)
    }
    assert.deepEqual(collected, keys)
    assert.deepEqual(await core.kvList(prefix, { limit, after }), [])
  })

  const subscription = 'subs/zai-coding/client-account'
  await checked('writer creates with CAS and reads only version metadata', async () => {
    assert.deepEqual(
      await writer.kvWrite(subscription, { apiKey: 'synthetic-first' }, { cas: 0 }),
      { version: 1 },
    )
    const metadata = await writer.kvMetadata(subscription)
    assert.ok(metadata?.currentVersion === 1 && !metadata.deleted)
    assert.deepEqual(
      await writer.kvWrite(
        subscription,
        { apiKey: 'synthetic-second' },
        { cas: metadata.currentVersion },
      ),
      { version: 2 },
    )
  })
  await expectRejected('writer cannot read data', () => writer.kvRead(subscription), 403)
  await expectRejected(
    'stale CAS is preserved as conflict',
    () => writer.kvWrite(subscription, { apiKey: 'synthetic-stale' }, { cas: 1 }),
    400,
  )
  await expectRejected(
    'missing CAS is rejected by mount',
    () => writer.kvWrite(subscription, { apiKey: 'synthetic-no-cas' }),
    400,
  )
  await checked('gateway reads version and rotates existing credentials', async () => {
    const current = await llm.kvRead(subscription)
    assert.ok(current?.version === 2 && current.data.apiKey === 'synthetic-second')
    assert.deepEqual(
      await llm.kvWrite(subscription, { apiKey: 'synthetic-third' }, { cas: current.version }),
      { version: 3 },
    )
  })
  await expectRejected('gateway cannot read metadata', () => llm.kvMetadata(subscription), 403)
  await expectRejected('gateway cannot delete data', () => llm.kvDelete(subscription), 403)
  await expectRejected(
    'gateway cannot destroy all versions',
    () => llm.kvDestroyAll(subscription),
    403,
  )
  await checked('admin retirement removes data and metadata', async () => {
    await admin.kvDestroyAll(subscription)
    assert.equal(await llm.kvRead(subscription), null)
    assert.equal(await writer.kvMetadata(subscription), null)
  })

  const fields = (count, value) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`field_${i}`, value]))
  await checked('custom metadata at the server limits is stored with its secret', async () => {
    const path = 'turns/t_client_metadata_1_1'
    const custom = fields(64, 'x'.repeat(512))
    assert.equal(await core.kvCreateOnce(path, { key: 'synthetic-metadata' }, custom), 'created')
    assert.deepEqual((await core.kvMetadata(path))?.custom, custom)
  })
  for (const [name, custom] of [
    ['65 keys', fields(65, 'x')],
    ['a value of 513 bytes', { sessionId: 'я'.repeat(256) + 'x' }],
    ['an empty value', { sessionId: '' }],
    ['a line break', { sessionId: 'synthetic\nsession' }],
  ]) {
    await checked(
      `custom metadata with ${name} is refused before the secret is written`,
      async () => {
        const path = 'turns/t_client_refused_1_1'
        trace.length = 0
        await assert.rejects(
          core.kvCreateOnce(path, { key: 'synthetic-refused' }, custom),
          (error) => error.message === 'Invalid Vault KV custom metadata',
        )
        assert.deepEqual(trace, [])
        assert.equal(await core.kvRead(path), null)
      },
    )
  }

  // AppRole stores of the two services. A single-use SecretID: one more login would fail.
  const root = { address, token: rootToken }
  const logins = { core: 0, mcp: 0 }
  const roleStore = (service) =>
    createVaultSecretStore({
      addr: address,
      appRole: content.credentials[service],
      fetch: (input, options) => {
        if (new URL(input).pathname === '/v1/auth/approle/login') logins[service] += 1
        return fetch(input, options)
      },
    })
  const role = roleStore('core')
  const mcp = roleStore('mcp')
  const sameBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0
  await checked('a refused write-once keeps the AppRole login', async () => {
    const path = 'turns/t_client_role_1_1'
    assert.equal(await role.kvCreateOnce(path, { key: 'synthetic-role' }, {}), 'created')
    for (let repair = 0; repair < 3; repair += 1)
      assert.equal(await role.kvCreateOnce(path, { key: 'synthetic-role' }, {}), 'exists')
    assert.equal(logins.core, 1)
  })
  await checked('core role takes and unwraps a snapshot data key with the same login', async () => {
    const issued = await role.transitDataKey(content.key)
    assert.ok(issued.plaintext.length === 32 && /^vault:v2:/.test(issued.ciphertext))
    assert.ok(
      sameBytes(await role.transitDecryptDataKey(content.key, issued.ciphertext), issued.plaintext),
    )
    assert.equal(logins.core, 1)
  })

  const rootStore = createVaultSecretStore({ addr: address, token: rootToken })
  await rootStore.kvList('turns/')
  const maskPath = `kv/content-masks/${content.siteId}/${randomUUID()}`
  await checked('mcp role keeps a contact map with CAS and removes every version', async () => {
    assert.equal(await mcp.kvRead(maskPath), null)
    assert.deepEqual(await mcp.kvWrite(maskPath, { entries: '[]' }, { cas: 0 }), { version: 1 })
    const first = await mcp.kvRead(maskPath)
    assert.ok(first?.version === 1 && first.data.entries === '[]')
    const entries = '["synthetic-contact"]'
    assert.deepEqual(await mcp.kvWrite(maskPath, { entries }, { cas: first.version }), {
      version: 2,
    })
    // A lost race is a conflict, not a silent overwrite.
    await assert.rejects(
      mcp.kvWrite(maskPath, { entries: '["synthetic-stale"]' }, { cas: first.version }),
      (error) => error.status === 400,
    )
    const second = await mcp.kvRead(maskPath)
    assert.ok(second?.version === 2 && second.data.entries === entries)
    await mcp.kvDestroyAll(maskPath)
    assert.equal(await mcp.kvRead(maskPath), null)
    assert.equal(await rootStore.kvMetadata(maskPath), null)
  })
  await checked('mcp role reads the WordPress access of a site with its version', async () => {
    const access = await mcp.kvRead(`kv/sites/${content.siteId}/wp`)
    assert.ok(access?.version === 2 && access.data.username === 'synthetic-editor')
    assert.deepEqual(Object.keys(access.data).sort(), [
      'applicationPassword',
      'origin',
      'username',
      'v',
    ])
  })
  await checked('mcp role takes and unwraps a content snapshot data key', async () => {
    const issued = await mcp.transitDataKey(content.key)
    assert.ok(issued.plaintext.length === 32 && /^vault:v2:/.test(issued.ciphertext))
    assert.ok(
      sameBytes(await mcp.transitDecryptDataKey(content.key, issued.ciphertext), issued.plaintext),
    )
    assert.equal(logins.mcp, 1)
  })
  const live = [core, writer, llm, admin, role, mcp, rootStore]
  await checked('health probes the mounts each store works with', async () => {
    for (const store of live) {
      const health = await store.health()
      assert.ok(health.initialized && !health.sealed)
    }
    // kv/ and transit/ are visible to the mcp policy through its `+` and prefix paths.
    assert.deepEqual(logins, { core: 1, mcp: 1 })
  })
  await checked('health reports a vanished KV mount and recovers after bootstrap', async () => {
    const disabled = await localVaultRequest(root, 'sys/mounts/subs', { method: 'DELETE' })
    assert.equal(disabled.status, 204)
    // What a restarted in-memory dev server looks like to a reader: no key, no error.
    assert.equal(await llm.kvRead('subs/zai-coding/after-restart'), null)
    for (const store of [writer, llm, admin])
      await assert.rejects(
        store.health(),
        (error) => error.message === 'Vault KV mount subs/ is not available',
      )
    for (const store of [core, role, mcp, rootStore])
      assert.equal((await store.health()).sealed, false)
    assert.deepEqual((await bootstrapLocalVault(root)).created, ['subs'])
    for (const store of live) assert.equal((await store.health()).sealed, false)
    // That run found kv/ and transit/ in use and left them alone: the site access keeps its
    // version and the workspace key still unwraps what it wrapped before.
    assert.equal((await mcp.kvRead(`kv/sites/${content.siteId}/wp`))?.version, 2)
    assert.ok(
      sameBytes(
        await mcp.transitDecryptDataKey(content.key, content.wrapped.ciphertext),
        content.wrapped.plaintext,
      ),
    )
  })
  await checked('health reports a lost Transit right and recovers after bootstrap', async () => {
    // The mount is there and the role's policy no longer names it. The token is the same one:
    // a refused probe must not cost the role its single login.
    const narrowed = await localVaultRequest(root, 'sys/policies/acl/mcp-content', {
      method: 'PUT',
      body: { policy: 'path "kv/data/content-masks/*" {\n  capabilities = ["read"]\n}\n' },
    })
    assert.equal(narrowed.status, 204)
    await assert.rejects(
      mcp.health(),
      (error) =>
        error.message === 'Vault Transit mount transit/ is not available' && error.status === 403,
    )
    for (const store of [core, writer, llm, admin, role, rootStore])
      assert.equal((await store.health()).sealed, false)
    // A repeated bootstrap writes every policy again: the right is back with nothing created.
    assert.deepEqual((await bootstrapLocalVault(root)).created, [])
    assert.equal((await mcp.health()).sealed, false)
    assert.ok(
      sameBytes(
        await mcp.transitDecryptDataKey(content.key, content.wrapped.ciphertext),
        content.wrapped.plaintext,
      ),
    )
    assert.deepEqual(logins, { core: 1, mcp: 1 })
  })
  await checked('health reports a vanished Transit mount to the roles that use it', async () => {
    const disabled = await localVaultRequest(root, 'sys/mounts/transit', { method: 'DELETE' })
    assert.equal(disabled.status, 204)
    for (const store of [role, mcp])
      await assert.rejects(
        store.health(),
        (error) => error.message === 'Vault Transit mount transit/ is not available',
      )
    for (const store of [core, writer, llm, admin, rootStore])
      assert.equal((await store.health()).sealed, false)
    await assert.rejects(mcp.transitDataKey(content.key), (error) => error.status === 404)
    assert.deepEqual((await bootstrapLocalVault(root)).created, ['transit'])
    for (const store of live) assert.equal((await store.health()).sealed, false)
    // The mount is back without its keys: health cannot see a key, the call itself fails.
    await assert.rejects(mcp.transitDataKey(content.key), (error) => error.status === 400)
    assert.deepEqual(logins, { core: 1, mcp: 1 })
  })
  // Last: a refusal drops the cached AppRole token, and the SecretID is already spent.
  await expectRejected(
    'mcp role is refused the SSH access of the same site, not told that it is missing',
    () => mcp.kvRead(`kv/sites/${content.siteId}/ssh`),
    403,
  )
  return checks
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node infra/vault/verify-local.mjs\n')
    process.exitCode = 1
  } else {
    verifyLocalVault()
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
      })
  }
}
