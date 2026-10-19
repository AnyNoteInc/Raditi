// The trusted local connection of a site (`connect-local.mjs`) and the contract of its stand.
// The steps run on fakes here; real WordPress, PostgreSQL, OpenBao and Gitea are the business
// of `pnpm verify:site-connect`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APPLICATION_PASSWORD_NAME,
  ConnectError,
  composeWpArgs,
  connectLocalSite,
  connectSettings,
  giteaPort,
  readPrivateFile,
  vaultPort,
  wordpressInstallation,
} from './connect-local.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')

const SITE = '0199a000-0000-7000-8000-000000000001'
const OLD_SITE = '0199a000-0000-7000-8000-00000000000f'
const WORKSPACE = '0199a000-0000-7000-8000-0000000000aa'
const ORIGIN = 'http://localhost:8080'
const ACCESS_PATH = `kv/sites/${SITE}/wp`
const RECEIPT = 'raditi_content_call_0199a000-0000-7000-8000-0000000000c1'

const refuses = (code) => (error) => error instanceof ConnectError && error.code === code

/** Everything the command talks to, in memory; `log` keeps the order of what it changed. */
function world({ site = {}, wordpress = {}, vault = {}, gitea = {}, refs = [], repos = [] } = {}) {
  const log = []
  const state = {
    site:
      site === null
        ? null
        : {
            id: SITE,
            workspaceId: WORKSPACE,
            url: ORIGIN,
            stack: 'wordpress',
            status: 'onboarding',
            dataClass: 'synthetic',
            ...site,
          },
    otherSites: new Set(),
    refs: refs.map((ref) => ({ ...ref })),
    repos: repos.map((repo) => ({ ...repo })),
    wordpress: {
      ready: true,
      installed: false,
      options: new Map(),
      passwords: 0,
      ...wordpress,
    },
    vault: { secrets: new Map(), keys: new Set(), ...vault },
    gitea: { organization: true, repositories: new Map(), ...gitea },
  }
  const ports = {
    db: {
      site: async (id) => (state.site && id === state.site.id ? { ...state.site } : null),
      siteExists: async (id) => id === state.site?.id || state.otherSites.has(id),
      accessRefs: async (siteId, kind) =>
        state.refs.filter((ref) => ref.siteId === siteId && ref.kind === kind),
      saveAccessRef: async (ref) => {
        log.push(`ref:${ref.keyVersion}`)
        const existing = state.refs.find((row) => row.id === ref.id)
        if (existing) Object.assign(existing, ref)
        else state.refs.push({ ...ref, id: `ref-${state.refs.length + 1}` })
      },
      repositories: async (siteId) => state.repos.filter((repo) => repo.siteId === siteId),
      saveRepository: async (repo) => {
        log.push(`repository-row:${repo.owner}/${repo.name}`)
        state.repos.push({ ...repo })
      },
      // What packages/db/src/site-activation.ts decides in PostgreSQL.
      activate: async (siteId, requiredAccess) => {
        if (state.site.status === 'active') return { status: 'already_active' }
        const missing = requiredAccess.filter(
          (kind) =>
            state.refs.filter(
              (ref) => ref.siteId === siteId && ref.kind === kind && ref.keyVersion >= 1,
            ).length !== 1,
        )
        if (missing.length > 0) return { status: 'refused', reason: 'access', access: missing }
        if (!state.repos.some((repo) => repo.siteId === siteId))
          return { status: 'refused', reason: 'repository' }
        state.site.status = 'active'
        log.push('active')
        return { status: 'activated' }
      },
    },
    installation: {
      ready: async () => state.wordpress.ready,
      installed: async () => state.wordpress.installed,
      install: async (origin) => {
        log.push(`install:${origin}`)
        state.wordpress.installed = true
      },
      binding: async () => state.wordpress.options.get('raditi_content_site_id') ?? null,
      fenceOptions: async () =>
        [...state.wordpress.options.keys()].filter(
          (name) => name === 'raditi_content_epoch' || name.startsWith('raditi_content_call_'),
        ),
      deleteOptions: async (names) => {
        log.push(`delete:${[...names].sort().join(',')}`)
        for (const name of names) state.wordpress.options.delete(name)
      },
      bind: async (siteId) => {
        log.push(`bind:${siteId}`)
        state.wordpress.options.set('raditi_content_site_id', siteId)
      },
      administrator: async () => 'raditi_admin',
      issueApplicationPassword: async (user) => {
        state.wordpress.passwords++
        log.push(`password:${user}`)
        return `SyntheticPassword${state.wordpress.passwords}`
      },
    },
    vault: {
      accessVersion: async (path) => {
        const secret = state.vault.secrets.get(path)
        return secret ? { current: secret.version, usable: !secret.deleted } : null
      },
      writeAccess: async (path, data, cas) => {
        const current = state.vault.secrets.get(path)?.version ?? 0
        if (cas !== current) throw new Error('check-and-set mismatch')
        log.push(`vault:${path}:cas=${cas}`)
        state.vault.secrets.set(path, { version: current + 1, data })
        return current + 1
      },
      ensureKey: async (name) => {
        log.push(`key:${name}`)
        state.vault.keys.add(name)
      },
    },
    gitea: {
      repository: async (owner, name) => state.gitea.repositories.get(`${owner}/${name}`) ?? null,
      createRepository: async (owner, name) => {
        if (!state.gitea.organization) throw new ConnectError('GITEA_ORGANIZATION', 'no org')
        log.push(`repository:${owner}/${name}`)
        state.gitea.repositories.set(`${owner}/${name}`, {
          defaultBranch: 'main',
          head: 'a'.repeat(40),
        })
      },
    },
  }
  const input = { siteId: SITE, appEnv: 'development', giteaOrigin: 'https://127.0.0.1:3443' }
  return { state, ports, log, input, connect: () => connectLocalSite(ports, input) }
}

test('a new site is installed, bound, given its access, key and repository, then activated', async () => {
  const { state, log, connect } = world()
  const summary = await connect()

  // The binding is the last step on the WordPress side: it follows the stored access.
  assert.deepEqual(log, [
    `install:${ORIGIN}`,
    'password:raditi_admin',
    `vault:${ACCESS_PATH}:cas=0`,
    'ref:1',
    `bind:${SITE}`,
    `key:ws-${WORKSPACE}`,
    `repository:sites/site-${SITE}`,
    `repository-row:sites/site-${SITE}`,
    'active',
  ])
  // The secret is what the role mcp accepts: { v, origin, username, applicationPassword }.
  assert.deepEqual(state.vault.secrets.get(ACCESS_PATH), {
    version: 1,
    data: {
      v: '1',
      origin: ORIGIN,
      username: 'raditi_admin',
      applicationPassword: 'SyntheticPassword1',
    },
  })
  // The only reference of its kind: the canonical path, the workspace of the site, the version.
  assert.deepEqual(state.refs, [
    {
      id: 'ref-1',
      siteId: SITE,
      workspaceId: WORKSPACE,
      kind: 'wp',
      vaultPath: ACCESS_PATH,
      keyVersion: 1,
    },
  ])
  assert.deepEqual(state.repos, [
    {
      siteId: SITE,
      provider: 'gitea',
      owner: 'sites',
      name: `site-${SITE}`,
      defaultBranch: 'main',
      url: `https://127.0.0.1:3443/sites/site-${SITE}`,
    },
  ])
  assert.equal(state.site.status, 'active')
  assert.deepEqual(summary, {
    siteId: SITE,
    wordpress: 'installed',
    binding: 'written',
    fence: 'kept',
    access: 'written',
    accessVersion: 1,
    workspaceKey: 'ensured',
    repository: 'created',
    activation: 'activated',
  })
  assert.doesNotMatch(JSON.stringify(summary), /SyntheticPassword/)
})

test('a repeated run changes nothing', async () => {
  const { state, log, connect } = world()
  await connect()
  const after = structuredClone({ refs: state.refs, repos: state.repos })
  log.length = 0

  const summary = await connect()
  // The Transit key request is idempotent on the server; nothing else is written.
  assert.deepEqual(log, [`key:ws-${WORKSPACE}`])
  assert.equal(state.wordpress.passwords, 1)
  assert.equal(state.vault.secrets.get(ACCESS_PATH).version, 1)
  assert.deepEqual({ refs: state.refs, repos: state.repos }, after)
  assert.deepEqual(summary, {
    siteId: SITE,
    wordpress: 'present',
    binding: 'unchanged',
    fence: 'kept',
    access: 'unchanged',
    accessVersion: 1,
    workspaceKey: 'ensured',
    repository: 'present',
    activation: 'already_active',
  })
})

test('an installation left by a recreated database is rebound and its fence reset first', async () => {
  // The volumes of the site outlived the platform database: the plugin remembers another site,
  // an epoch above every lease of the new one, and receipts of calls nobody will ask about.
  const { state, log, connect } = world({
    wordpress: {
      installed: true,
      options: new Map([
        ['raditi_content_site_id', OLD_SITE],
        ['raditi_content_epoch', '7'],
        [RECEIPT, '{"proof":{}}'],
        ['raditi_content_unrelated', 'kept'],
      ]),
    },
  })
  const summary = await connect()

  assert.deepEqual(log.slice(0, 5), [
    `delete:${RECEIPT},raditi_content_epoch`,
    'password:raditi_admin',
    `vault:${ACCESS_PATH}:cas=0`,
    'ref:1',
    `bind:${SITE}`,
  ])
  assert.deepEqual([...state.wordpress.options.keys()].sort(), [
    'raditi_content_site_id',
    'raditi_content_unrelated',
  ])
  assert.equal(summary.wordpress, 'present')
  assert.equal(summary.binding, 'written')
  assert.equal(summary.fence, 'reset')
  assert.equal(state.site.status, 'active')
})

test('an installation that serves another site of this platform is not taken from it', async () => {
  const { state, log, connect } = world({
    wordpress: { installed: true, options: new Map([['raditi_content_site_id', OLD_SITE]]) },
  })
  state.otherSites.add(OLD_SITE)
  await assert.rejects(connect(), refuses('INSTALLATION_BOUND'))
  assert.deepEqual(log, [])
  assert.equal(state.wordpress.options.get('raditi_content_site_id'), OLD_SITE)
})

test('a run stopped before the binding is repeated in full: the old access is not taken for done', async () => {
  // A connected site whose installation answers for a site that is gone (its volumes were
  // replaced): the reference and the secret agree, yet the password in the secret is not one
  // of this installation.
  const { state, ports, log, connect } = world({
    site: { status: 'active' },
    wordpress: {
      installed: true,
      options: new Map([
        ['raditi_content_site_id', OLD_SITE],
        ['raditi_content_epoch', '4'],
      ]),
    },
    vault: {
      secrets: new Map([
        [ACCESS_PATH, { version: 1, data: { applicationPassword: 'PreviousInstallation' } }],
      ]),
      keys: new Set(),
    },
    refs: [
      {
        id: 'ref-1',
        siteId: SITE,
        workspaceId: WORKSPACE,
        kind: 'wp',
        vaultPath: ACCESS_PATH,
        keyVersion: 1,
      },
    ],
    repos: [{ siteId: SITE, provider: 'gitea', owner: 'sites', name: `site-${SITE}` }],
    gitea: {
      repositories: new Map([
        [`sites/site-${SITE}`, { defaultBranch: 'main', head: 'b'.repeat(40) }],
      ]),
    },
  })
  // The first run loses OpenBao after the new application password replaced the old one.
  const writeAccess = ports.vault.writeAccess
  ports.vault.writeAccess = async () => {
    throw new ConnectError('VAULT', 'OpenBao is away')
  }
  await assert.rejects(connect(), refuses('VAULT'))
  assert.deepEqual(log, ['delete:raditi_content_epoch', 'password:raditi_admin'])
  // Not bound yet: the next run cannot mistake the stored secret for the access of this site.
  assert.equal(state.wordpress.options.get('raditi_content_site_id'), OLD_SITE)

  ports.vault.writeAccess = writeAccess
  log.length = 0
  const summary = await connect()
  assert.deepEqual(log, [
    'password:raditi_admin',
    `vault:${ACCESS_PATH}:cas=1`,
    'ref:2',
    `bind:${SITE}`,
    `key:ws-${WORKSPACE}`,
  ])
  assert.equal(summary.access, 'written')
  assert.equal(summary.binding, 'written')
  assert.equal(state.vault.secrets.get(ACCESS_PATH).data.applicationPassword, 'SyntheticPassword2')
  assert.equal(state.refs[0].keyVersion, 2)
})

test('removing the binding makes the next run replace the access and reset the fence', async () => {
  // The way out when the stored password no longer works or the plugin remembers an epoch
  // above the lease (README): the operator deletes the binding option and runs the command.
  const { state, log, connect } = world()
  await connect()
  state.wordpress.options.delete('raditi_content_site_id')
  state.wordpress.options.set('raditi_content_epoch', '9')
  log.length = 0

  const summary = await connect()
  assert.deepEqual(log, [
    'delete:raditi_content_epoch',
    'password:raditi_admin',
    `vault:${ACCESS_PATH}:cas=1`,
    'ref:2',
    `bind:${SITE}`,
    `key:ws-${WORKSPACE}`,
  ])
  assert.equal(state.refs.length, 1)
  assert.equal(summary.fence, 'reset')
  assert.equal(summary.access, 'written')
  assert.equal(summary.activation, 'already_active')
})

test('a reference without its secret gets a new access under the same row', async () => {
  // The dev OpenBao keeps everything in memory: the row survived, the secret did not.
  const { state, log, connect } = world({
    site: { status: 'active' },
    wordpress: { installed: true, options: new Map([['raditi_content_site_id', SITE]]) },
    refs: [
      {
        id: 'ref-9',
        siteId: SITE,
        workspaceId: WORKSPACE,
        kind: 'wp',
        vaultPath: ACCESS_PATH,
        keyVersion: 3,
      },
    ],
    repos: [{ siteId: SITE, provider: 'gitea', owner: 'sites', name: `site-${SITE}` }],
    gitea: {
      repositories: new Map([
        [`sites/site-${SITE}`, { defaultBranch: 'main', head: 'b'.repeat(40) }],
      ]),
    },
  })
  const summary = await connect()
  assert.deepEqual(log, [
    'password:raditi_admin',
    `vault:${ACCESS_PATH}:cas=0`,
    'ref:1',
    `key:ws-${WORKSPACE}`,
  ])
  assert.equal(state.refs.length, 1)
  assert.equal(state.refs[0].id, 'ref-9')
  assert.equal(state.refs[0].keyVersion, 1)
  assert.equal(summary.access, 'written')
  assert.equal(summary.fence, 'kept')
  assert.equal(summary.activation, 'already_active')
})

test('a secret written before a crash is replaced with check-and-set on its version', async () => {
  // The previous run stopped between Vault and the database: the access cannot be read back.
  const { state, log, connect } = world({
    wordpress: { installed: true, options: new Map([['raditi_content_site_id', SITE]]) },
    vault: {
      secrets: new Map([[ACCESS_PATH, { version: 2, data: {} }]]),
      keys: new Set(),
    },
  })
  await connect()
  assert.ok(log.includes(`vault:${ACCESS_PATH}:cas=2`))
  assert.equal(state.vault.secrets.get(ACCESS_PATH).version, 3)
  assert.equal(state.refs[0].keyVersion, 3)
})

test('a deleted current version of the secret is not taken for an access', async () => {
  const { state, connect } = world({
    wordpress: { installed: true, options: new Map([['raditi_content_site_id', SITE]]) },
    vault: {
      secrets: new Map([[ACCESS_PATH, { version: 1, data: {}, deleted: true }]]),
      keys: new Set(),
    },
    refs: [
      {
        id: 'ref-1',
        siteId: SITE,
        workspaceId: WORKSPACE,
        kind: 'wp',
        vaultPath: ACCESS_PATH,
        keyVersion: 1,
      },
    ],
  })
  const summary = await connect()
  assert.equal(summary.access, 'written')
  assert.equal(state.refs[0].keyVersion, 2)
})

test('production and everything that is not a local synthetic WordPress site is refused first', async () => {
  const cases = [
    ['PRODUCTION', {}, { appEnv: 'production' }],
    ['SITE_NOT_FOUND', { site: null }, {}],
    ['SITE_NOT_LOCAL', { site: { url: 'https://example.ru' } }, {}],
    ['SITE_NOT_LOCAL', { site: { url: 'http://192.168.1.10:8080' } }, {}],
    ['SITE_NOT_LOCAL', { site: { url: 'http://localhost.example.ru' } }, {}],
    ['SITE_STACK', { site: { stack: 'bitrix' } }, {}],
    ['WORKSPACE_NOT_SYNTHETIC', { site: { dataClass: 'client' } }, {}],
    ['SITE_STATUS', { site: { status: 'archived' } }, {}],
    ['SITE_STATUS', { site: { status: 'paused' } }, {}],
    // A site of the wizard whose import has not ended: the import makes its repository.
    ['SITE_SETUP', { site: { codeImport: 'queued' } }, {}],
    ['SITE_SETUP', { site: { codeImport: 'running' } }, {}],
    ['SITE_SETUP', { site: { codeImport: 'failed' } }, {}],
    ['SITE_NOT_RUNNING', { wordpress: { ready: false } }, {}],
  ]
  for (const [code, setup, override] of cases) {
    const { ports, input, log } = world(setup)
    await assert.rejects(connectLocalSite(ports, { ...input, ...override }), refuses(code), code)
    assert.deepEqual(log, [], `${code}: nothing may be changed`)
  }
  // A site of the wizard is taken once its first version is imported, as one made before the wizard.
  for (const codeImport of ['succeeded', null]) {
    const { state, connect } = world({ site: { codeImport } })
    await connect()
    assert.ok(state.vault.secrets.get(ACCESS_PATH), `codeImport ${codeImport}`)
  }
  // Loopback names the content adapter accepts over plain http, and https on them.
  for (const url of ['http://127.0.0.1:8080', 'http://[::1]:8080', 'https://localhost:8443']) {
    const { state, connect } = world({ site: { url } })
    await connect()
    assert.equal(state.vault.secrets.get(ACCESS_PATH).data.origin, url)
  }
})

test('references the role mcp would not follow are left to the operator', async () => {
  const row = {
    siteId: SITE,
    workspaceId: WORKSPACE,
    kind: 'wp',
    vaultPath: ACCESS_PATH,
    keyVersion: 1,
  }
  const broken = [
    [
      { ...row, id: 'a' },
      { ...row, id: 'b', vaultPath: `kv/sites/${SITE}/wp-old` },
    ],
    [{ ...row, id: 'a', vaultPath: `kv/sites/${OLD_SITE}/wp` }],
    [{ ...row, id: 'a', workspaceId: OLD_SITE }],
  ]
  for (const refs of broken) {
    const { log, connect } = world({ refs })
    await assert.rejects(connect(), refuses('ACCESS_REFERENCE'))
    assert.deepEqual(log, [])
  }
  // A repository of another provider or owner is not ours to adopt.
  const { log, connect } = world({
    repos: [{ siteId: SITE, provider: 'github', owner: 'client', name: 'site' }],
  })
  await assert.rejects(connect(), refuses('REPOSITORY_FOREIGN'))
  assert.deepEqual(log, [])
})

test('a site stays in onboarding when its repository cannot be prepared', async () => {
  const missing = world({ gitea: { organization: false, repositories: new Map() } })
  await assert.rejects(missing.connect(), refuses('GITEA_ORGANIZATION'))
  assert.equal(missing.state.site.status, 'onboarding')
  assert.ok(!missing.log.includes('active'))

  // A repository somebody created empty has no base for a turn.
  const empty = world({
    gitea: {
      repositories: new Map([[`sites/site-${SITE}`, { defaultBranch: 'main', head: null }]]),
    },
  })
  await assert.rejects(empty.connect(), refuses('REPOSITORY_EMPTY'))
  assert.equal(empty.state.site.status, 'onboarding')

  // The database has the last word: a refusal of the activation is an error of the command.
  const refused = world()
  refused.ports.db.activate = async () => ({ status: 'refused', reason: 'repository' })
  await assert.rejects(refused.connect(), refuses('ACTIVATION_REFUSED'))
})

const validEnv = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://raditi:synthetic-db-password@127.0.0.1:5432/raditi',
  VAULT_ADDR: 'http://127.0.0.1:8200',
  CONNECT_SITES_WRITER_TOKEN_FILE: '/private/tokens/sites-writer',
  CONNECT_WORKSPACE_PROVISIONER_TOKEN_FILE: '/private/tokens/provisioner',
  GITEA_URL: 'https://127.0.0.1:3443',
  GIT_CA_FILE: '/private/ca.pem',
  CONNECT_GITEA_TOKEN_FILE: '/private/tokens/gitea',
}

test('the environment is explicit: every setting is named, nothing has a default address', () => {
  assert.deepEqual(connectSettings({ argv: ['--site', SITE], env: validEnv }), {
    siteId: SITE,
    appEnv: 'development',
    databaseUrl: validEnv.DATABASE_URL,
    vaultAddress: 'http://127.0.0.1:8200',
    sitesWriterTokenFile: '/private/tokens/sites-writer',
    provisionerTokenFile: '/private/tokens/provisioner',
    giteaOrigin: 'https://127.0.0.1:3443',
    giteaCaFile: '/private/ca.pem',
    giteaTokenFile: '/private/tokens/gitea',
    composeProject: 'raditi-dev',
    wpcliImage: undefined,
  })
  const custom = connectSettings({
    argv: ['--site', SITE],
    env: {
      ...validEnv,
      APP_ENV: 'test',
      GITEA_URL: 'https://localhost:3443/',
      CONNECT_COMPOSE_PROJECT: 'raditi-site-connect-0123abcd',
      SITE_WPCLI_IMAGE: `wordpress@sha256:${'a'.repeat(64)}`,
    },
  })
  assert.equal(custom.giteaOrigin, 'https://localhost:3443')
  assert.equal(custom.composeProject, 'raditi-site-connect-0123abcd')
  assert.equal(custom.wpcliImage, `wordpress@sha256:${'a'.repeat(64)}`)
  for (const name of Object.keys(validEnv).filter((key) => key !== 'GIT_CA_FILE')) {
    const { [name]: _removed, ...env } = validEnv
    assert.throws(() => connectSettings({ argv: ['--site', SITE], env }), refuses('SETTINGS'), name)
  }
})

test('production, remote addresses and plain http to Gitea are refused before anything is opened', () => {
  const settings = (env, argv = ['--site', SITE]) =>
    connectSettings({ argv, env: { ...validEnv, ...env } })
  assert.throws(() => settings({ APP_ENV: 'production' }), refuses('PRODUCTION'))
  for (const env of [
    { APP_ENV: 'staging' },
    { DATABASE_URL: 'postgresql://raditi:synthetic-db-password@db.internal:5432/raditi' },
    { DATABASE_URL: 'mysql://127.0.0.1/raditi' },
    // The PostgreSQL client takes the host from the query before the one in the address.
    { DATABASE_URL: `${validEnv.DATABASE_URL}?host=db.internal` },
    { DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=disable&hostaddr=10.0.0.5` },
    { VAULT_ADDR: 'http://vault.raditi.internal:8200' },
    { VAULT_ADDR: 'http://localhost:8200' },
    { GITEA_URL: 'http://127.0.0.1:3300' },
    { GITEA_URL: 'https://gitea.example.ru' },
    { GITEA_URL: 'https://bot:synthetic-secret@127.0.0.1:3443' },
    { CONNECT_GITEA_TOKEN_FILE: 'tokens/gitea' },
    { GIT_CA_FILE: 'ca.pem' },
    { CONNECT_COMPOSE_PROJECT: 'Other Project' },
    { SITE_WPCLI_IMAGE: 'wordpress:cli; rm -rf /' },
  ]) {
    assert.throws(() => settings(env), refuses('SETTINGS'), JSON.stringify(Object.keys(env)))
  }
  for (const argv of [[], ['--site'], ['--site', 'not-a-uuid'], ['--site', SITE, '--force']]) {
    assert.throws(() => settings({}, argv), refuses('SETTINGS'))
  }
  // A refusal names the setting, never its value.
  try {
    settings({ DATABASE_URL: 'postgresql://raditi:synthetic-db-password@db.internal:5432/raditi' })
    assert.fail('must refuse')
  } catch (error) {
    assert.match(error.message, /DATABASE_URL/)
    assert.doesNotMatch(error.message, /synthetic-db-password|db\.internal/)
  }
})

test('a token is read only from the caller’s own private regular file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-connect-local-test-'))
  try {
    const file = join(directory, 'token')
    await writeFile(file, 'synthetic-token\n', { mode: 0o600 })
    assert.equal(await readPrivateFile('TOKEN_FILE', file), 'synthetic-token')
    // Readable by the group or others, reached through a link, empty or of several lines.
    await chmod(file, 0o640)
    await assert.rejects(readPrivateFile('TOKEN_FILE', file), refuses('SETTINGS'))
    await chmod(file, 0o600)
    await symlink(file, join(directory, 'link'))
    await assert.rejects(
      readPrivateFile('TOKEN_FILE', join(directory, 'link')),
      refuses('SETTINGS'),
    )
    await writeFile(join(directory, 'lines'), 'one\ntwo\n', { mode: 0o600 })
    await assert.rejects(
      readPrivateFile('TOKEN_FILE', join(directory, 'lines')),
      refuses('SETTINGS'),
    )
    await assert.rejects(readPrivateFile('TOKEN_FILE', join(directory, 'absent')), (error) => {
      assert.ok(refuses('SETTINGS')(error))
      // The refusal names the setting, not the path or the content.
      assert.match(error.message, /^TOKEN_FILE: /)
      assert.doesNotMatch(error.message, /absent|synthetic-token/)
      return true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('WP-CLI runs in the wpcli service of the named compose project and touches no other service', () => {
  const args = composeWpArgs({
    project: 'raditi-dev',
    composeFile: '/repo/infra/dev/docker-compose.yml',
  })
  assert.deepEqual(args, [
    'compose',
    '--env-file',
    '/dev/null',
    '-p',
    'raditi-dev',
    '-f',
    '/repo/infra/dev/docker-compose.yml',
    '--profile',
    'site',
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--pull',
    'never',
    'wpcli',
  ])
})

/** A WP-CLI that answers from a script and records what it was asked. */
function scriptedWp(answers) {
  const calls = []
  const wp = async (args, options = {}) => {
    calls.push({ args, input: options.input })
    const answer = answers.find(([prefix]) => prefix.every((part, index) => args[index] === part))
    if (!answer) throw new Error(`Unexpected WP-CLI call: ${args.slice(0, 3).join(' ')}`)
    const result = typeof answer[1] === 'function' ? answer[1](args) : answer[1]
    return { code: 0, stdout: '', ...result }
  }
  return { wp, calls }
}

test('the application password is replaced, read from the output and never an argument', async () => {
  const { wp, calls } = scriptedWp([
    [
      ['user', 'application-password', 'list'],
      { stdout: '0199a000-0000-7000-8000-0000000000d1\n0199a000-0000-7000-8000-0000000000d2\n' },
    ],
    [['user', 'application-password', 'delete'], {}],
    [['user', 'application-password', 'create'], { stdout: 'abcdEFGH1234abcdEFGH1234\n' }],
  ])
  const password = await wordpressInstallation(wp).issueApplicationPassword('raditi_admin')
  assert.equal(password, 'abcdEFGH1234abcdEFGH1234')
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        'user',
        'application-password',
        'list',
        'raditi_admin',
        `--name=${APPLICATION_PASSWORD_NAME}`,
        '--field=uuid',
      ],
      [
        'user',
        'application-password',
        'delete',
        'raditi_admin',
        '0199a000-0000-7000-8000-0000000000d1',
        '0199a000-0000-7000-8000-0000000000d2',
      ],
      [
        'user',
        'application-password',
        'create',
        'raditi_admin',
        APPLICATION_PASSWORD_NAME,
        '--porcelain',
      ],
    ],
  )
  assert.doesNotMatch(JSON.stringify(calls), /abcdEFGH/)
})

test('WordPress is installed for the address of the site, with a password nobody sees', async () => {
  const { wp, calls } = scriptedWp([
    [['core', 'install'], { stdout: 'Admin password: SyntheticAdminPassword\nSuccess\n' }],
    [['core', 'is-installed'], { code: 1 }],
    [['db', 'check'], {}],
  ])
  const installation = wordpressInstallation(wp)
  assert.equal(await installation.ready(), true)
  assert.equal(await installation.installed(), false)
  assert.equal(await installation.install(ORIGIN), undefined)
  const install = calls.find((call) => call.args[1] === 'install').args
  assert.ok(install.includes(`--url=${ORIGIN}`))
  assert.ok(install.includes('--skip-email'))
  assert.ok(install.every((arg) => !arg.startsWith('--admin_password')))
})

test('only the fence of the plugin is listed and deleted; the binding is read and written', async () => {
  const { wp, calls } = scriptedWp([
    [
      ['option', 'list'],
      {
        stdout: JSON.stringify([
          'raditi_content_site_id',
          'raditi_content_epoch',
          RECEIPT,
          'raditi_content_unrelated',
          'raditiXcontent_epoch',
        ]),
      },
    ],
    [['option', 'get'], { stdout: `${OLD_SITE}\n` }],
    [['option', 'delete'], {}],
    [['option', 'update'], {}],
  ])
  const installation = wordpressInstallation(wp)
  assert.equal(await installation.binding(), OLD_SITE)
  assert.deepEqual(await installation.fenceOptions(), ['raditi_content_epoch', RECEIPT])
  await installation.deleteOptions([RECEIPT, 'raditi_content_epoch'])
  await installation.bind(SITE)
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['option', 'get', 'raditi_content_site_id'],
      ['option', 'list', '--search=raditi_content_*', '--field=option_name', '--format=json'],
      ['option', 'delete', RECEIPT, 'raditi_content_epoch'],
      ['option', 'update', 'raditi_content_site_id', SITE],
    ],
  )
  // Nothing outside the fence can be named for deletion, the binding included.
  await assert.rejects(installation.deleteOptions(['siteurl']), refuses('WORDPRESS'))
  await assert.rejects(installation.deleteOptions(['raditi_content_site_id']), refuses('WORDPRESS'))
  await assert.rejects(installation.bind('not-a-uuid'), refuses('WORDPRESS'))
  // An installation that was never bound has no such option: WP-CLI exits with 1.
  const unbound = scriptedWp([[['option', 'get'], { code: 1 }]])
  assert.equal(await wordpressInstallation(unbound.wp).binding(), null)
})

test('Vault gets the access with check-and-set and the key by the provisioner, each with its own token', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    requests.push({
      path,
      method: init.method,
      token: init.headers['X-Vault-Token'],
      body: init.body,
    })
    const answer = (status, body) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status })
    if (path === `/v1/kv/metadata/sites/${SITE}/wp` && requests.length === 1)
      return answer(404, { errors: [] })
    if (path === `/v1/kv/metadata/sites/${SITE}/wp`)
      return answer(200, {
        data: { current_version: 2, versions: { 2: { deletion_time: '', destroyed: false } } },
      })
    if (path === `/v1/kv/data/sites/${SITE}/wp`) return answer(200, { data: { version: 3 } })
    if (path === `/v1/transit/keys/ws-${WORKSPACE}`) return answer(204)
    return answer(403, { errors: ['permission denied'] })
  }
  const vault = vaultPort({
    address: 'http://127.0.0.1:8200',
    sitesWriterToken: 'writer-token',
    provisionerToken: 'provisioner-token',
    fetchImpl,
  })
  assert.equal(await vault.accessVersion(ACCESS_PATH), null)
  assert.deepEqual(await vault.accessVersion(ACCESS_PATH), { current: 2, usable: true })
  const data = {
    v: '1',
    origin: ORIGIN,
    username: 'raditi_admin',
    applicationPassword: 'SyntheticPassword1',
  }
  assert.equal(await vault.writeAccess(ACCESS_PATH, data, 2), 3)
  await vault.ensureKey(`ws-${WORKSPACE}`)
  assert.deepEqual(JSON.parse(requests[2].body), { options: { cas: 2 }, data })
  assert.deepEqual(JSON.parse(requests[3].body), { type: 'aes256-gcm96' })
  assert.deepEqual(
    requests.map((request) => request.token),
    ['writer-token', 'writer-token', 'writer-token', 'provisioner-token'],
  )
  // A refusal of the server is a fixed error: its body may repeat what was sent.
  await assert.rejects(vault.ensureKey(`ws-${OLD_SITE}`), (error) => {
    assert.ok(refuses('VAULT')(error))
    assert.doesNotMatch(error.message, /permission denied|provisioner-token/)
    return true
  })
  // Only a path of a site access and a workspace key may be named.
  await assert.rejects(vault.writeAccess('subs/data/zai-coding/1', data, 0), refuses('VAULT'))
  await assert.rejects(vault.ensureKey('exportable-key'), refuses('VAULT'))
  // Only the loopback OpenBao.
  assert.throws(
    () =>
      vaultPort({
        address: 'http://vault.internal:8200',
        sitesWriterToken: 'a',
        provisionerToken: 'b',
      }),
    /loopback/,
  )
})

test('Gitea is asked over https only, with the token in a header and no redirect followed', async () => {
  const requests = []
  const requestImpl = async (options) => {
    requests.push(options)
    if (options.method === 'GET' && options.path.endsWith('/branches/main'))
      return { status: 200, json: { commit: { id: 'c'.repeat(40) } } }
    if (options.method === 'GET')
      return { status: 200, json: { default_branch: 'main', empty: false } }
    return { status: 201, json: {} }
  }
  const gitea = giteaPort({
    origin: 'https://127.0.0.1:3443',
    token: 'gitea-token',
    ca: 'CA',
    requestImpl,
  })
  assert.deepEqual(await gitea.repository('sites', `site-${SITE}`), {
    defaultBranch: 'main',
    head: 'c'.repeat(40),
  })
  await gitea.createRepository('sites', `site-${SITE}`)
  assert.equal(requests[0].path, `/api/v1/repos/sites/site-${SITE}`)
  assert.equal(requests[2].path, '/api/v1/orgs/sites/repos')
  assert.deepEqual(requests[2].body, {
    name: `site-${SITE}`,
    private: true,
    auto_init: true,
    default_branch: 'main',
  })
  for (const request of requests) {
    assert.equal(request.host, '127.0.0.1')
    assert.equal(request.port, '3443')
    assert.equal(request.ca, 'CA')
    assert.equal(request.headers.authorization, 'token gitea-token')
    assert.doesNotMatch(request.path, /gitea-token/)
  }
  assert.throws(
    () => giteaPort({ origin: 'http://127.0.0.1:3300', token: 't', requestImpl }),
    refuses('SETTINGS'),
  )
  await assert.rejects(gitea.repository('sites', '../admin'), refuses('GITEA'))

  // 404 is «no repository»; a redirect (a renamed repository) and a refusal are errors.
  const answers = [
    { status: 404, json: null },
    { status: 301, json: null },
    { status: 404, json: null },
  ]
  const other = giteaPort({
    origin: 'https://127.0.0.1:3443',
    token: 't',
    requestImpl: async () => answers.shift(),
  })
  assert.equal(await other.repository('sites', 'absent'), null)
  await assert.rejects(other.repository('sites', 'moved'), refuses('GITEA'))
  await assert.rejects(
    other.createRepository('sites', 'no-organization'),
    refuses('GITEA_ORGANIZATION'),
  )
})

test('the profile site of the dev compose is ready for the content path', () => {
  const compose = read('infra/dev/docker-compose.yml')
  const service = (name) => {
    const [, body] = new RegExp(`\\n  ${name}:\\n((?:    .*\\n|\\n)+)`).exec(compose) ?? []
    assert.ok(body, `service ${name} is in the dev compose`)
    return body
  }
  const site = service('site')
  const wpcli = service('wpcli')
  for (const body of [service('site-db'), site, wpcli]) assert.match(body, /profiles: \['site'\]/)
  // Application passwords over plain http need the local environment type; cron, updates and
  // outbound HTTP are off, as in the disposable fixture (infra/dev/site-verify/compose.yml).
  for (const line of [
    "define('WP_ENVIRONMENT_TYPE', 'local');",
    "define('DISABLE_WP_CRON', true);",
    "define('WP_HTTP_BLOCK_EXTERNAL', true);",
    "define('WP_AUTO_UPDATE_CORE', false);",
    "define('AUTOMATIC_UPDATER_DISABLED', true);",
    "define('DISALLOW_FILE_MODS', true);",
  ]) {
    assert.ok(site.includes(line), line)
    assert.ok(read('infra/dev/site-verify/compose.yml').includes(line), `fixture: ${line}`)
  }
  // WP-CLI loads the same configuration and the same plugin as the web server.
  assert.match(site, /environment: &site_environment\n/)
  assert.match(wpcli, /environment: \*site_environment\n/)
  const plugin =
    '- ../wordpress/raditi-content.php:/var/www/html/wp-content/mu-plugins/raditi-content.php:ro'
  assert.ok(site.includes(plugin))
  assert.ok(wpcli.includes(plugin))
  // Published on loopback only; the WP-CLI image is the pinned tag unless the caller names one.
  assert.match(site, /- '127\.0\.0\.1:\$\{SITE_PORT:-8080\}:80'/)
  assert.match(wpcli, /image: \$\{SITE_WPCLI_IMAGE:-wordpress:cli-2\.12\.0-php8\.3\}\n/)
  assert.match(wpcli, /user: '33:33'/)
  // The tags the stand checks against its pinned digests.
  assert.match(site, /image: wordpress:7\.1\.2-php8\.3-apache\n/)
  assert.match(service('site-db'), /image: mariadb:11\.4\.13\n/)
  const stand = read('infra/dev/site-verify/verify-site-connect.mjs')
  assert.match(stand, /'wordpress:7\.1\.2-php8\.3-apache':\s+'sha256:[a-f0-9]{64}'/)
  assert.match(stand, /'mariadb:11\.4\.13': 'sha256:[a-f0-9]{64}'/)
})

test('the command is a stand tool: no .env, no secret in its output, no product import of it', () => {
  const command = read('infra/dev/site-verify/connect-local.mjs')
  assert.doesNotMatch(command, /loadEnvFile|dotenv|\.env'/)
  assert.doesNotMatch(command, /VAULT_DEV_ROOT_TOKEN/)
  // Tokens come from private files, never from an argument or a variable with the value.
  assert.match(command, /CONNECT_SITES_WRITER_TOKEN_FILE/)
  assert.match(command, /CONNECT_WORKSPACE_PROVISIONER_TOKEN_FILE/)
  assert.match(command, /CONNECT_GITEA_TOKEN_FILE/)
  // The names come from the platform's own functions, the access format from the adapter.
  assert.match(command, /siteAccessPath\(/)
  assert.match(command, /workspaceTransitKey\(/)
  assert.match(command, /accessSchema\.safeParse\(/)
  assert.match(command, /activateSite\(/)
})

test("the command's own home holds the compose plugin of the stand's Docker CLI and nothing else of Docker", () => {
  const stand = read('infra/dev/site-verify/verify-site-connect.mjs')
  // The command gets a home of its own, never the developer's.
  assert.match(stand, /\n    HOME: join\(directory, 'home'\),\n/)
  // Docker Desktop may keep the compose plugin only under the home: without it every WP-CLI
  // call of the command fails, and the command reports a site that does not run.
  assert.match(stand, /docker\(\['info', '--format', '\{\{json \.ClientInfo\.Plugins\}\}'\]\)/)
  assert.match(
    stand,
    /const commandPlugins = join\(directory, 'home', '\.docker', 'cli-plugins'\)\n\s+await mkdir\(commandPlugins, \{ recursive: true, mode: 0o700 \}\)\n\s+await symlink\(composePlugin, join\(commandPlugins, 'docker-compose'\)\)/,
  )
  // Only the plugin: no configuration (credentials, contexts) is copied into that home.
  assert.doesNotMatch(stand, /config\.json/)
  // The command's CLI is checked before the first connection.
  assert.match(
    stand,
    /await command\('docker', \['compose', 'version', '--short'\], \{ env: connectEnvironment\(\) \}\)/,
  )
})

test('the stand keeps its signal handlers through the cleanup and is started by exec', () => {
  const stand = read('infra/dev/site-verify/verify-site-connect.mjs')
  assert.doesNotMatch(stand, /process\.once\('SIG/)
  assert.match(stand, /process\.on\('SIGINT', interrupt\)\n\s*process\.on\('SIGTERM', interrupt\)/)
  // A second signal must find the guard, not start a second teardown.
  assert.match(stand, /if \(interrupted\) return\n\s*interrupted = true/)
  const scripts = JSON.parse(read('package.json')).scripts
  assert.equal(
    scripts['verify:site-connect'],
    'pnpm --filter orchestrator build && exec node infra/dev/site-verify/verify-site-connect.mjs',
  )
  // The role under test is the regular one, with the AppRole of the mcp service.
  assert.match(stand, /startRegularRole\(/)
  assert.match(stand, /token_policies: \['mcp-content'\]/)
  assert.match(stand, /connect-local\.mjs/)
  // The command defaults to the dev project: the stand must always name its own.
  assert.match(stand, /const project = `raditi-site-connect-\$\{run\}`/)
  assert.match(stand, /\n    CONNECT_COMPOSE_PROJECT: project,\n/)
  assert.doesNotMatch(stand, /wrapResolver|McpAppModule/)
  // What the command must do is never done by the stand itself: no access reference, no
  // repository row, no activation and no write of a site access.
  assert.doesNotMatch(stand, /gitRepository\.create|status: 'active'/)
  // The only reference the stand creates is the synthetic subscription of its turns.
  assert.deepEqual(
    [...stand.matchAll(/credentialRef\.create\(\{\s*data: \{ kind: '([a-z_]+)'/g)].map(
      ([, kind]) => kind,
    ),
    ['subscription'],
  )
  assert.equal(stand.match(/credentialRef\.create/g).length, 1)
  assert.doesNotMatch(stand, /kv\/data\/sites\/[^`]*`, \{\s*method/)
})
