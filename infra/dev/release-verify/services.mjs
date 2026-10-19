// The services of the release stand, each started and made ready here: the certificates,
// PostgreSQL, Redis, S3, OpenBao, Gitea, the loopback mirror and the deploy runner, and the
// synthetic production site — MariaDB, WordPress and its SFTP hosting. Every container is
// labelled with the run; the caller removes them (verify-release.mjs, cleanup).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { bootstrapLocalVault, localVaultRequest } from '../../vault/bootstrap.mjs'
import { generatedGiteaPassword, giteaAccountArgs } from '../gitea-verify/stand.mjs'
import { hostKeyFingerprint } from '../pipeline-verify/stand.mjs'
import { exchange } from './runtime.mjs'
import {
  BUCKETS,
  HOSTING_ROOT,
  HOSTING_USER,
  caWriterArgs,
  certificateConfigs,
  giteaArgs,
  hostingArgs,
  mirrorArgs,
  openbaoArgs,
  postgresArgs,
  postgresEnvFile,
  redisArgs,
  redisEnvFile,
  runnerArgs,
  runnerConfig,
  s3Args,
  s3Identities,
  siteDbArgs,
  siteDbEnvFile,
  siteWebArgs,
  siteWebEnvFile,
  wpCliArgs,
} from './stand.mjs'

const publishedPort = (output) => {
  const [, port] = /^127\.0\.0\.1:(\d+)$/m.exec(output.trim()) ?? []
  assert.ok(port, 'A container is not published on loopback only')
  return Number(port)
}

/** The stand's own CA (two days) and one server certificate: Gitea and the synthetic Z.ai. */
export async function createCertificates(rt, directory) {
  const openssl = (...args) =>
    rt.run('openssl', args, { env: { PATH: process.env.PATH, HOME: directory }, timeoutMs: 30_000 })
  const file = (leaf) => join(directory, leaf)
  const configs = certificateConfigs()
  await writeFile(file('ca.ext'), configs.authority)
  await writeFile(file('server.ext'), configs.server)
  await mkdir(file('tls'), { mode: 0o755 })
  const key = (path) =>
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', path)
  await key(file('ca-key.pem'))
  await openssl(
    'req',
    '-new',
    '-key',
    file('ca-key.pem'),
    '-subj',
    '/CN=raditi-release-verify CA',
    '-out',
    file('ca.csr'),
  )
  await openssl(
    ...['x509', '-req', '-in', file('ca.csr'), '-signkey', file('ca-key.pem'), '-days', '2'],
    ...['-sha256', '-extfile', file('ca.ext'), '-out', file('ca.pem')],
  )
  await key(file('tls/server-key.pem'))
  await openssl(
    'req',
    '-new',
    '-key',
    file('tls/server-key.pem'),
    '-subj',
    '/CN=localhost',
    '-out',
    file('server.csr'),
  )
  await openssl(
    ...[
      'x509',
      '-req',
      '-in',
      file('server.csr'),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca-key.pem'),
    ],
    ...['-days', '2', '-sha256', '-set_serial', `0x${randomBytes(16).toString('hex')}`],
    ...['-extfile', file('server.ext'), '-out', file('tls/server.pem')],
  )
  // A synthetic key of a two-day certificate: the uid of Gitea's container must read it.
  await chmod(file('tls/server-key.pem'), 0o444)
  await chmod(file('tls/server.pem'), 0o444)
  return {
    caFile: file('ca.pem'),
    ca: await readFile(file('ca.pem')),
    key: await readFile(file('tls/server-key.pem')),
    cert: await readFile(file('tls/server.pem')),
    tlsDirectory: file('tls'),
  }
}

export async function startPostgres(rt, names, directory) {
  const password = rt.secret(randomBytes(24).toString('hex'))
  const envFile = join(directory, 'postgres.env')
  await writeFile(envFile, postgresEnvFile(password), { mode: 0o600 })
  await rt.docker(postgresArgs({ names, envFile }))
  const port = publishedPort(
    (await rt.docker(['port', names.containers.postgres, '5432/tcp'])).output,
  )
  await rt.until(
    'PostgreSQL accepts connections',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            names.containers.postgres,
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-U',
            'raditi',
            '-d',
            'raditi',
          ],
          { allowFailure: true },
        )
      ).code === 0,
    { timeoutMs: 60_000 },
  )
  // The entrypoint restarts the server once after its init scripts: wait past that.
  await rt.until(
    'PostgreSQL answers a query after its init',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            names.containers.postgres,
            'psql',
            '-U',
            'raditi',
            '-d',
            'raditi',
            '-tAc',
            'SELECT 1',
          ],
          { allowFailure: true },
        )
      ).output.trim() === '1',
  )
  return { url: rt.secret(`postgresql://raditi:${password}@127.0.0.1:${port}/raditi`), port }
}

export async function startRedis(rt, names, directory) {
  const password = rt.secret(randomBytes(24).toString('hex'))
  const envFile = join(directory, 'redis.env')
  await writeFile(envFile, redisEnvFile(password), { mode: 0o600 })
  await rt.docker(redisArgs({ names, envFile }))
  const port = publishedPort((await rt.docker(['port', names.containers.redis, '6379/tcp'])).output)
  await rt.until('Redis answers PING', async () =>
    (
      await rt.docker(
        [
          'exec',
          names.containers.redis,
          'sh',
          '-c',
          'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping',
        ],
        {
          allowFailure: true,
        },
      )
    ).output.includes('PONG'),
  )
  return { url: rt.secret(`redis://default:${password}@127.0.0.1:${port}`), port }
}

/** SeaweedFS with the buckets of the platform. */
export async function startS3(rt, names, directory, port) {
  const identity = {
    accessKey: rt.secret(`rv-${randomBytes(12).toString('hex')}`),
    secretKey: rt.secret(randomBytes(24).toString('hex')),
  }
  const config = join(directory, 's3')
  await mkdir(config, { mode: 0o755 })
  await writeFile(join(config, 's3.json'), s3Identities(identity), { mode: 0o644 })
  await rt.docker(s3Args({ names, port }))
  await rt.docker(['cp', config, `${names.containers.s3}:/stand`])
  await rt.docker(['start', names.containers.s3])
  const shell = async (command) =>
    (
      await rt.docker(['exec', names.containers.s3, 'sh', '-c', `echo '${command}' | weed shell`], {
        allowFailure: true,
      })
    ).output
  await rt.until(
    'S3 with the buckets of the platform',
    async () => {
      const listed = await shell('s3.bucket.list')
      const missing = Object.values(BUCKETS).filter((bucket) => !listed.includes(bucket))
      for (const bucket of missing) await shell(`s3.bucket.create -name ${bucket}`)
      if (missing.length > 0) return false
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
      return true
    },
    { timeoutMs: 120_000, intervalMs: 1000 },
  )
  return { endpoint: `http://127.0.0.1:${port}`, port, ...identity }
}

/**
 * OpenBao initialised and unsealed through its API, the mounts and policies of the platform
 * (infra/vault/bootstrap.mjs), an AppRole per process of the platform with the policies of its
 * service, and the scoped tokens of the trusted steps the stand plays: the operator's writer of
 * subscriptions, the writer of site accesses, the provisioner of workspace keys.
 */
export async function startOpenbao(rt, names, port) {
  await rt.docker(openbaoArgs({ names, port }))
  const address = `http://127.0.0.1:${port}`
  await rt.until('OpenBao answers', async () =>
    [200, 501, 503].includes((await localVaultRequest({ address }, 'sys/health')).status),
  )
  const init = await localVaultRequest({ address }, 'sys/init', {
    method: 'POST',
    body: { secret_shares: 1, secret_threshold: 1 },
  })
  assert.equal(init.status, 200, 'OpenBao initialisation failed')
  const rootToken = rt.secret(init.body.root_token)
  rt.secret(init.body.keys_base64[0])
  await localVaultRequest({ address }, 'sys/unseal', {
    method: 'POST',
    body: { key: init.body.keys_base64[0] },
  })
  const root = { address, token: rootToken }
  const request = async (path, options = {}) => {
    const result = await localVaultRequest(root, path, options)
    assert.ok([200, 204].includes(result.status), `OpenBao refused ${path} (${result.status})`)
    return result.body
  }
  await bootstrapLocalVault(root)
  await request('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
  const roles = {}
  for (const [name, policies] of [
    ['core', ['core-turns', 'core-transit', 'core-site-import', 'core-release']],
    ['mcp', ['mcp-content']],
    ['llm', ['llm-subscriptions']],
    ['web', ['sites-writer']],
  ]) {
    await request(`auth/approle/role/${name}`, {
      method: 'POST',
      body: {
        token_policies: policies,
        token_no_default_policy: true,
        token_ttl: '15m',
        token_max_ttl: '2h',
        secret_id_ttl: '4h',
      },
    })
    roles[name] = {
      roleId: rt.secret((await request(`auth/approle/role/${name}/role-id`)).data.role_id),
      secretId: rt.secret(
        (await request(`auth/approle/role/${name}/secret-id`, { method: 'POST', body: {} })).data
          .secret_id,
      ),
    }
  }
  const tokens = {}
  for (const policy of ['subscriptions-writer', 'sites-writer', 'workspace-provisioner'])
    tokens[policy] = rt.secret(
      (
        await request('auth/token/create', {
          method: 'POST',
          body: { policies: [policy], no_default_policy: true, ttl: '4h', renewable: false },
        })
      ).auth.client_token,
    )
  return { address, root, request, roles, tokens }
}

/** A client of the stand's Gitea over HTTPS, trusting the stand's CA only. */
function giteaClient(rt, port, ca) {
  const base = `https://127.0.0.1:${port}`
  const authorization = (as) =>
    as?.token
      ? { authorization: `token ${as.token}` }
      : as
        ? { authorization: `Basic ${Buffer.from(`${as.user}:${as.password}`).toString('base64')}` }
        : {}
  const api = async (method, path, { as, body, expect } = {}) => {
    const answer = await exchange(`${base}/api/v1${path}`, {
      method,
      ca,
      signal: rt.signal,
      headers: {
        accept: 'application/json',
        ...authorization(as),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (expect !== undefined && ![expect].flat().includes(answer.status))
      throw new Error(
        `Gitea answered HTTP ${answer.status} to ${method} ${path}: ${rt.redact(answer.text).slice(0, 200)}`,
      )
    return answer
  }
  return { base, port, api }
}

/**
 * Gitea with the accounts of the platform: the administrator of the instance (the stand), the
 * bot of core (GITEA_TOKEN) in a team that writes every repository of `sites`, and the owner of
 * `sites` — the release account, whose token core reads from Vault. `platform/ci` holds the
 * obligatory workflows of `ci/` and is the source of scoped workflows of the instance.
 */
export async function startGitea(rt, names, { port, certificates, directory }) {
  const name = names.containers.gitea
  await rt.docker(giteaArgs({ names, port }))
  await rt.docker(['cp', certificates.tlsDirectory, `${name}:/tls`])
  await rt.docker(['start', name])
  const gitea = giteaClient(rt, port, certificates.ca)
  await rt.until(
    'Gitea answers over HTTPS',
    async () =>
      (await exchange(`${gitea.base}/api/healthz`, { ca: certificates.ca })).status === 200,
    { timeoutMs: 120_000 },
  )
  const version = await gitea.api('GET', '/version', { expect: 200 })
  assert.equal(version.json?.version, '1.27.3', 'Unexpected Gitea version')
  const account = async (user, admin = false) => {
    const created = await rt.docker(giteaAccountArgs({ container: name, user, admin }))
    return { user, password: rt.secret(generatedGiteaPassword(created.output)) }
  }
  const admin = await account('stand-admin', true)
  const bot = await account('raditi-bot')
  const owner = await account('raditi-release')
  const api = (method, path, options = {}) => gitea.api(method, path, { as: admin, ...options })
  for (const org of ['platform', 'sites'])
    await api('POST', '/orgs', { body: { username: org, visibility: 'private' }, expect: 201 })
  const bots = await api('POST', '/orgs/sites/teams', {
    body: {
      name: 'bots',
      permission: 'write',
      includes_all_repositories: true,
      units: ['repo.code', 'repo.pulls', 'repo.actions'],
    },
    expect: 201,
  })
  await api('PUT', `/teams/${bots.json.id}/members/${bot.user}`, { expect: 204 })
  const teams = await api('GET', '/orgs/sites/teams', { expect: 200 })
  const owners = teams.json.find((team) => team.name === 'Owners')
  assert.ok(owners, 'The organization sites has no Owners team')
  await api('PUT', `/teams/${owners.id}/members/${owner.user}`, { expect: 204 })
  // platform/ci: the product's workflows, as `ci/` holds them; the source of scoped workflows.
  await api('POST', '/orgs/platform/repos', {
    body: { name: 'ci', private: true, auto_init: true, default_branch: 'main' },
    expect: 201,
  })
  for (const file of ['check.yml', 'deploy.yml']) {
    const content = await readFile(join(rt.root, 'ci/.gitea/scoped_workflows', file))
    await api('POST', `/repos/platform/ci/contents/.gitea/scoped_workflows/${file}`, {
      body: { content: content.toString('base64'), message: `ci: ${file}`, branch: 'main' },
      expect: 201,
    })
  }
  // Only a web form with a session of the administrator registers the source (Gitea 1.27.3).
  const login = await exchange(`${gitea.base}/user/login`, {
    method: 'POST',
    ca: certificates.ca,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_name: admin.user, password: admin.password }).toString(),
  })
  assert.equal(login.status, 303, 'The administrator could not sign in to Gitea')
  const session = rt.secret(
    (login.headers['set-cookie'] ?? [])
      .map((line) => line.split(';')[0])
      .filter((cookie) => cookie.startsWith('i_like_gitea='))
      .at(-1),
  )
  const added = await exchange(`${gitea.base}/-/admin/actions/scoped-workflows/add`, {
    method: 'POST',
    ca: certificates.ca,
    headers: {
      cookie: session,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ repo_name: 'platform/ci' }).toString(),
  })
  assert.equal(
    added.status,
    200,
    'platform/ci was not registered as the source of scoped workflows',
  )
  const source = (await api('GET', '/repos/platform/ci', { expect: 200 })).json
  const token = async (accountOf, scopes, label) =>
    rt.secret(
      (
        await gitea.api('POST', `/users/${accountOf.user}/tokens`, {
          as: accountOf,
          body: { name: label, scopes },
          expect: 201,
        })
      ).json.sha1,
    )
  const botToken = await token(bot, ['write:user', 'write:repository'], 'raditi-core')
  const ownerToken = await token(owner, ['write:repository'], 'raditi-release')
  const adminToken = await token(
    admin,
    ['write:repository', 'write:organization', 'write:admin'],
    'stand',
  )
  return {
    ...gitea,
    name,
    admin,
    bot,
    owner,
    source,
    tokens: { bot: botToken, owner: ownerToken, admin: adminToken },
    as: (who) => ({ token: { bot: botToken, owner: ownerToken, admin: adminToken }[who] }),
    directory,
  }
}

/** The mirror of the host's loopback on the network of the Docker VM (stand.mjs, MIRROR_SCRIPT). */
export async function startMirror(rt, names, { image, ports }) {
  await rt.docker(mirrorArgs({ names, image, ports }))
  await rt.until('the loopback mirror listens', async () =>
    (await rt.docker(['logs', names.containers.mirror], { allowFailure: true })).output.includes(
      'mirror ready',
    ),
  )
}

/** The deploy runner of `sites`: registered with a token of the instance, online. */
export async function startRunner(
  rt,
  names,
  { gitea, ports, deployImage, certificates, directory },
) {
  const registration = await gitea.api('POST', '/admin/actions/runners/registration-token', {
    as: gitea.admin,
    expect: 200,
  })
  const config = join(directory, 'runner')
  await mkdir(config, { mode: 0o700 })
  await writeFile(join(config, 'runner.yaml'), runnerConfig({ names, ports }))
  await writeFile(join(config, 'ca.pem'), certificates.ca)
  await writeFile(join(config, 'registration-token'), rt.secret(registration.json.token), {
    mode: 0o600,
  })
  await rt.docker(['volume', 'create', '--label', names.label, names.volumes.ca])
  await rt.docker(caWriterArgs({ names, image: deployImage }), { input: certificates.ca })
  await rt.docker(runnerArgs({ names, ports, deployImage, socket: '/var/run/docker.sock' }))
  await rt.docker(['cp', config, `${names.containers.runner}:/config`])
  await rt.docker(['start', names.containers.runner])
  await rt.until(
    'the deploy runner is online',
    async () => {
      const list = await gitea.api('GET', '/admin/actions/runners', {
        as: gitea.admin,
        expect: 200,
      })
      return (list.json?.runners ?? []).some((runner) => runner.status === 'online')
    },
    { timeoutMs: 90_000 },
  )
  const state = await rt.docker(['exec', names.containers.runner, 'cat', '/data/.runner'])
  const { uuid } = JSON.parse(state.output.slice(state.output.indexOf('{')))
  return { uuid }
}

/**
 * The synthetic production site: MariaDB, WordPress 7.1.2 on a published loopback port and the
 * hosting over the same document root. `wp(args)` runs WP-CLI; `files.read/write/list` act on the
 * document root as the web server's user, the way an owner with access to the hosting would.
 */
export async function startSite(rt, names, { directory, sitePort, sshPort }) {
  const dbPassword = rt.secret(randomBytes(18).toString('base64url'))
  const dbEnv = join(directory, 'site-db.env')
  const webEnv = join(directory, 'site-web.env')
  await writeFile(dbEnv, siteDbEnvFile(dbPassword), { mode: 0o600 })
  await writeFile(webEnv, siteWebEnvFile(dbPassword), { mode: 0o600 })
  await rt.docker(['network', 'create', '--label', names.label, names.network])
  await rt.docker(['volume', 'create', '--label', names.label, names.volumes.docroot])
  await rt.docker(siteDbArgs({ names, envFile: dbEnv }))
  const dbPort = publishedPort(
    (await rt.docker(['port', names.containers['site-db'], '3306/tcp'])).output,
  )
  await rt.until(
    'MariaDB of the site accepts its user',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            names.containers['site-db'],
            'sh',
            '-c',
            'mariadb -uwordpress -p"$MARIADB_PASSWORD" -e "SELECT 1" wordpress',
          ],
          { allowFailure: true },
        )
      ).code === 0,
    { timeoutMs: 120_000 },
  )
  await rt.docker(siteWebArgs({ names, port: sitePort, envFile: webEnv }))
  const web = names.containers['site-web']
  // The entrypoint of the image copies WordPress into the empty document root.
  await rt.until(
    'WordPress is in the document root',
    async () =>
      (
        await rt.docker(['exec', web, 'test', '-f', '/var/www/html/wp-includes/version.php'], {
          allowFailure: true,
        })
      ).code === 0,
    { timeoutMs: 120_000 },
  )
  // The entrypoint writes wp-config.php after the copy and only then starts Apache: WP-CLI reads
  // the configuration, so the site must answer first.
  await rt.until(
    'the web server of the site answers',
    async () => {
      const answer = await exchange(`http://127.0.0.1:${sitePort}/`, { signal: rt.signal })
      return answer.status >= 200 && answer.status < 500
    },
    { timeoutMs: 120_000 },
  )
  const wp = (args, { allowFailure = false, input } = {}) =>
    rt.docker(wpCliArgs({ names, envFile: webEnv, args, input: input !== undefined }), {
      allowFailure,
      input,
      timeoutMs: 180_000,
    })
  const inside = (relative) => {
    if (
      !/^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/.test(relative) ||
      relative.split('/').includes('..')
    )
      throw new Error('Invalid path of the site')
    return `/var/www/html/${relative}`
  }
  const files = {
    read: async (relative) => {
      const read = await rt.docker(['exec', web, 'cat', inside(relative)], { allowFailure: true })
      return read.code === 0 ? read.output : null
    },
    write: (relative, content) =>
      rt.docker(
        [
          'exec',
          '-i',
          '-u',
          '33:33',
          web,
          'sh',
          '-c',
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          'sh',
          inside(relative),
        ],
        { input: content },
      ),
    exists: async (relative) =>
      (await rt.docker(['exec', web, 'test', '-e', inside(relative)], { allowFailure: true }))
        .code === 0,
    remove: (relative) => rt.docker(['exec', '-u', '33:33', web, 'rm', '-f', inside(relative)]),
  }
  /** A query of production's database as its own user, tab-separated rows without a header. */
  const sql = async (query) =>
    (
      await rt.docker([
        'exec',
        names.containers['site-db'],
        'sh',
        '-c',
        'mariadb -uwordpress -p"$MARIADB_PASSWORD" -N -B wordpress -e "$1"',
        'sh',
        query,
      ])
    ).output.trim()
  return { dbPassword, dbPort, sitePort, sshPort, wp, files, web, webEnv, sql }
}

/** The SFTP hosting over the site's document root: its password is a file, its host key read back. */
export async function startHosting(rt, names, { directory, port }) {
  const name = names.containers.hosting
  const password = rt.secret(randomBytes(18).toString('base64url'))
  const files = join(directory, 'hosting')
  await mkdir(files, { mode: 0o755 })
  await writeFile(join(files, 'password'), password, { mode: 0o644 })
  await rt.docker(hostingArgs({ names, port }))
  await rt.docker(['cp', files, `${name}:/stand`])
  await rt.docker(['start', name])
  const publicKey = await rt.until(
    'the SFTP hosting listens with its host key',
    async () => {
      const key = await rt.docker(
        ['exec', name, 'cat', '/config/ssh_host_keys/ssh_host_ed25519_key.pub'],
        {
          allowFailure: true,
        },
      )
      const listening = await rt.docker(['exec', name, 'test', '-s', '/config/sshd.pid'], {
        allowFailure: true,
      })
      return key.code === 0 && listening.code === 0 ? key.output : null
    },
    { timeoutMs: 90_000 },
  )
  return {
    access: {
      v: '1',
      host: '127.0.0.1',
      port: String(port),
      hostKey: hostKeyFingerprint(publicKey),
      rootPath: HOSTING_ROOT,
      username: HOSTING_USER,
      auth: 'password',
      password,
    },
  }
}
