// The self-checks of the stand (`--infra-only`, and the first part of every run): that each
// service is what the scenarios rely on. One PASS line each; the clients are the product's own
// libraries (ssh2, basic-ftp, mysql2, pg).
//
// What they prove: the platform database is migrated and seeded; the AppRole `web` writes a site
// access with CAS and cannot read it, the AppRole `core` reads it and cannot write; the
// provisioner's token creates a private empty repository and the bot's does not, the bot pushes
// to it over HTTPS with the stand's CA; the hosting presents the fingerprint the stand computed,
// signs `site` in by password and by both keys, swaps its host key, serves the site over SFTP,
// FTPS (verified with the stand's CA only) and plain FTP on the published passive ports, and was
// not written to; Gitleaks flags exactly the file the manifest says; both site databases answer
// over verified TLS and log what was sent; core starts on the stand and reports every dependency
// healthy (when apps/core/dist is built).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { runCommand } from '../../../apps/core/scripts/verify-agent-supervisor.mjs'
import { hostKeyFingerprint } from './ssh-keys.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const repository = resolve(here, '../../..')
const connections = createRequire(join(repository, 'packages/site-connections/package.json'))
const { Client: PgClient } = createRequire(join(repository, 'packages/db/package.json'))('pg')

let passed = () => {}
let controller = new AbortController()
export let stage = 'start'

// ─── Clients of the self-checks (the product's own libraries) ──────────────────────────────

/** An SFTP session; `hostKey` is the blob the server presented. `verify: false` stops there. */
function sftp({ port, username, password, privateKey, passphrase, verify = true }) {
  const { Client } = connections('ssh2')
  return new Promise((done, reject) => {
    const client = new Client()
    let hostKey
    client
      .on('ready', () =>
        client.sftp((error, session) => {
          if (error) {
            client.end()
            reject(error)
          } else done({ client, session, hostKey })
        }),
      )
      .on('error', (error) => {
        error.hostKey = hostKey
        reject(error)
      })
      .connect({
        host: '127.0.0.1',
        port,
        username,
        ...(password === undefined ? {} : { password }),
        ...(privateKey === undefined ? {} : { privateKey }),
        ...(passphrase === undefined ? {} : { passphrase }),
        readyTimeout: 15_000,
        hostVerifier: (key) => {
          hostKey = Buffer.from(key)
          return verify
        },
      })
  })
}

const call = (target, method, ...args) =>
  new Promise((done, reject) =>
    target[method](...args, (error, value) => (error ? reject(error) : done(value))),
  )

async function ftp({ port, user, password, secure, ca }) {
  const { Client } = connections('basic-ftp')
  const client = new Client(15_000)
  const lines = []
  client.ftp.verbose = true
  client.ftp.log = (line) => lines.push(line)
  await client.access({
    host: '127.0.0.1',
    port,
    user,
    password,
    secure,
    ...(secure && ca ? { secureOptions: { ca } } : {}),
  })
  return { client, lines }
}

async function download(client, path) {
  const chunks = []
  await client.downloadTo(
    new Writable({
      write(chunk, _encoding, next) {
        chunks.push(chunk)
        next()
      },
    }),
    path,
  )
  return Buffer.concat(chunks)
}

/** The data ports the FTP server named in its PASV / EPSV answers. */
function passivePorts(lines) {
  return lines.flatMap((line) => {
    const epsv = /229 .*\(\|\|\|(\d+)\|\)/.exec(line)
    if (epsv) return [Number(epsv[1])]
    const pasv = /227 .*\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(line)
    return pasv ? [Number(pasv[5]) * 256 + Number(pasv[6])] : []
  })
}

function pasvAddresses(lines) {
  return lines.flatMap((line) => {
    const pasv = /227 .*\((\d+),(\d+),(\d+),(\d+),\d+,\d+\)/.exec(line)
    return pasv ? [pasv.slice(1, 5).join('.')] : []
  })
}

// ─── The self-checks ───────────────────────────────────────────────────────────────────────

async function checkDatabase(stand) {
  stage = 'platform database'
  const migrations = (
    await readdir(join(repository, 'packages/db/prisma/migrations'), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory()).length
  const applied = await stand.db.query(
    'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  )
  assert.equal(applied.rows[0].n, migrations, 'Every migration of the tree is applied')
  const plans = await stand.db.query('SELECT count(*)::int AS n FROM plans')
  assert.ok(plans.rows[0].n > 0, 'The seeds wrote the tariffs')
  passed(`platform PostgreSQL: ${migrations} migrations applied, reference data seeded`)
}

async function checkVault(stand) {
  stage = 'OpenBao AppRoles'
  const path = `kv/data/sites/${randomUUID()}/ssh`
  const data = {
    v: '1',
    host: '127.0.0.1',
    port: '22',
    username: 'synthetic',
    auth: 'password',
    password: 'x',
  }
  const web = await stand.vault.login('web')
  const core = await stand.vault.login('core')
  const status = async (token, target, options) =>
    (await stand.vault.request(token, target, options)).status
  assert.equal(
    await status(web, path, { method: 'POST', body: { options: { cas: 0 }, data } }),
    200,
    'web writes with CAS 0',
  )
  assert.equal(
    await status(web, path, { method: 'POST', body: { options: { cas: 0 }, data } }),
    400,
    'a second CAS-0 write is refused',
  )
  assert.equal(await status(web, path), 403, 'web cannot read the access back')
  const read = await stand.vault.request(core, path)
  assert.equal(read.status, 200, 'core reads the access')
  assert.deepEqual(read.body?.data?.data, data)
  assert.equal(read.body?.data?.metadata?.version, 1)
  assert.equal(
    await status(core, path, { method: 'POST', body: { data } }),
    403,
    'core cannot write',
  )
  assert.equal(
    await status(core, path.replace(/ssh$/, 'wp')),
    403,
    'core cannot read the WordPress access',
  )
  const removed = await stand.vault.operator(path.replace('kv/data/', 'kv/metadata/'), {
    method: 'DELETE',
  })
  assert.ok([200, 204].includes(removed.status))
  passed(
    'OpenBao: AppRole web (sites-writer) writes kv/sites/<id>/ssh with CAS 0 and cannot read it; AppRole core (core-turns, core-transit, core-site-import) reads it, cannot write it or read …/wp',
  )
}

async function checkGitea(stand) {
  stage = 'Gitea provisioner and bot'
  const api = stand.giteaApi
  const created = await api.createRepository('selfcheck')
  assert.equal(created.private, true)
  assert.equal(created.empty, true)
  assert.equal(created.default_branch, 'main')
  assert.equal(created.owner.login, 'sites')
  const refusedBot = await api.request('POST', '/v1/orgs/sites/repos', {
    auth: { token: (await readFile(stand.coordinates.gitea.bot.tokenFile, 'utf8')).trim() },
    body: { name: 'selfcheck-bot', private: true },
  })
  assert.equal(refusedBot.status, 403, 'The bot token cannot create repositories')
  assert.equal(
    (await api.request('GET', '/v1/repos/sites/selfcheck', { auth: undefined })).status,
    404,
    'Private: invisible without a token',
  )
  assert.deepEqual(await api.refs('selfcheck'), [])

  const work = join(stand.directory, 'work', 'selfcheck')
  await mkdir(work, { recursive: true })
  const env = api.gitEnvironment('bot')
  const git = (...args) =>
    runCommand('git', args, { env, cwd: work, signal: controller.signal, timeoutMs: 60_000 })
  await git('init', '--quiet', '-b', 'main', '.')
  await writeFile(join(work, 'README.md'), 'selfcheck of the stand\n')
  await git('add', '-A')
  await git('commit', '--quiet', '-m', 'selfcheck')
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()
  await git('push', '--quiet', `${api.origin}/sites/selfcheck.git`, 'main:main')
  // Gitea fills its table of branches after a push in the background (HTTP 500 until then); the
  // refs are read from git itself.
  const deadline = Date.now() + 30_000
  let branch = null
  while (branch === null && Date.now() < deadline) {
    branch = await api.branch('selfcheck', 'main').catch(() => null)
    if (branch === null) await new Promise((done) => setTimeout(done, 300))
  }
  assert.equal(branch?.commit?.id, head, 'main is the pushed commit')
  assert.deepEqual(
    (await api.refs('selfcheck')).map(({ ref, sha }) => [ref, sha]),
    [['refs/heads/main', head]],
  )

  // The helpers the mismatch scenarios use: a commit through the Contents API, a lightweight
  // tag, the tree, a raw file and a clone.
  const next = await api.createFile('selfcheck', { path: 'other/file.txt', content: 'other\n' })
  const parents = (await api.commit('selfcheck', next))?.parents?.map(({ sha }) => sha)
  assert.deepEqual(parents, [head], 'The Contents API commits on top of main')
  await api.createTag('selfcheck', { tag: 'v0.0.0', target: next })
  assert.deepEqual(
    (await api.refs('selfcheck')).map(({ ref, sha, type }) => [ref, sha, type]),
    [
      ['refs/heads/main', next, 'commit'],
      ['refs/tags/v0.0.0', next, 'commit'],
    ],
    'A lightweight tag points straight at the commit',
  )
  assert.deepEqual(
    (await api.tree('selfcheck', next)).map(({ path, type }) => [path, type]),
    [
      ['README.md', 'blob'],
      ['other', 'tree'],
      ['other/file.txt', 'blob'],
    ],
  )
  assert.equal((await api.raw('selfcheck', 'other/file.txt'))?.toString('utf8'), 'other\n')
  assert.equal(await api.raw('selfcheck', 'missing.txt'), null)
  const clone = await api.clone('selfcheck', join(stand.directory, 'work', 'selfcheck-clone'))
  const cloned = await runCommand('git', ['rev-parse', 'HEAD'], {
    env,
    cwd: clone,
    signal: controller.signal,
  })
  assert.equal(cloned.stdout.trim(), next)
  // An empty repository gets its first branch from the Contents API: `main` the import did not make.
  await api.createRepository('selfcheck-empty')
  const foreign = await api.createFile('selfcheck-empty', { path: 'index.php', content: '<?php\n' })
  assert.deepEqual(
    (await api.refs('selfcheck-empty')).map(({ ref, sha }) => [ref, sha]),
    [['refs/heads/main', foreign]],
  )
  for (const name of ['selfcheck', 'selfcheck-empty']) {
    await api.deleteRepository(name)
    assert.equal(await api.repository(name), null)
  }
  passed(
    'Gitea 1.27.3 over HTTPS: the provisioner token creates sites/selfcheck (private, empty, main), the bot token cannot create one and pushes to it with http.extraHeader and the stand CA; Contents API commits, lightweight tags, trees, raw files and clones work for the mismatch scenarios',
  )
}

async function checkSftp(stand) {
  stage = 'SFTP of the hosting'
  const { port } = stand.coordinates.siteServer.ssh
  const { site, ftpsite } = stand.secrets
  const fingerprints = stand.coordinates.siteServer.hostKeys
  assert.match(fingerprints.first, /^ssh-ed25519 SHA256:[A-Za-z0-9+/]{43}$/)
  const logsBefore = await stand.siteServer.logs()

  // The first check of the wizard: the key exchange alone, no login.
  const probe = await sftp({ port, username: site.user, verify: false }).then(
    () => assert.fail('A refused host key must end the connection'),
    (error) => error,
  )
  assert.equal(
    hostKeyFingerprint(probe.hostKey),
    fingerprints.first,
    'The presented key is the stand’s',
  )
  const logsAfterProbe = (await stand.siteServer.logs()).slice(logsBefore.length)
  assert.doesNotMatch(
    logsAfterProbe,
    /Accepted|Failed password|Failed publickey/,
    'No login without a confirmed key',
  )

  const byPassword = await sftp({ port, username: site.user, password: site.password })
  assert.equal(hostKeyFingerprint(byPassword.hostKey), fingerprints.first)
  const home = (await call(byPassword.session, 'readdir', '/'))
    .map(({ filename }) => filename)
    .sort()
  assert.deepEqual(home, ['empty_root', 'nested', 'public_html'])
  const root = (await call(byPassword.session, 'readdir', '/public_html')).map(
    ({ filename }) => filename,
  )
  for (const expected of [
    'wp-config.php',
    'wp-content',
    'wp-includes',
    'Кириллица',
    'link-to-config',
    '.git',
    '.htaccess',
  ])
    assert.ok(root.includes(expected), `public_html lists ${expected}`)
  const version = await call(byPassword.session, 'readFile', '/public_html/wp-includes/version.php')
  assert.match(version.toString('utf8'), /\$wp_version = '6\.8\.3';/)
  assert.ok(
    (await call(byPassword.session, 'lstat', '/public_html/link-to-config')).isSymbolicLink(),
  )
  const photo = await call(
    byPassword.session,
    'readFile',
    '/public_html/wp-content/uploads/2026/10/photo.jpg',
  )
  const expectedPhoto = stand.fixture.tree.find(({ path }) => path.endsWith('photo.jpg')).content
  assert.ok(photo.equals(expectedPhoto), 'Binary files arrive byte for byte')
  byPassword.client.end()

  const byKey = await sftp({ port, username: site.user, privateKey: site.privateKey })
  byKey.client.end()
  const byPassphrase = await sftp({
    port,
    username: site.user,
    privateKey: site.keyWithPassphrase.privateKey,
    passphrase: site.keyWithPassphrase.passphrase,
  })
  byPassphrase.client.end()
  await assert.rejects(
    sftp({ port, username: site.user, password: `${site.password}x` }),
    /authentication/i,
  )
  await assert.rejects(
    sftp({ port, username: ftpsite.user, password: ftpsite.password }),
    /authentication/i,
  )

  assert.equal(await stand.siteServer.useHostKey('second'), fingerprints.second)
  const changed = await sftp({ port, username: site.user, verify: false }).catch((error) => error)
  assert.equal(
    hostKeyFingerprint(changed.hostKey),
    fingerprints.second,
    'The changed key is presented',
  )
  assert.notEqual(fingerprints.second, fingerprints.first)
  await stand.siteServer.useHostKey('first')
  const back = await sftp({ port, username: site.user, verify: false }).catch((error) => error)
  assert.equal(hostKeyFingerprint(back.hostKey), fingerprints.first)
  passed(
    'SFTP (OpenSSH 10, chrooted internal-sftp): fingerprint in the product format, no login on a refused key, site by password, ed25519 key and RSA key with a passphrase; wrong password and ftpsite refused; the second host key swaps in and out',
  )
}

async function checkFtp(stand) {
  stage = 'FTP and FTPS of the hosting'
  const { port, passive } = stand.coordinates.siteServer.ftp
  const { site, ftpsite } = stand.secrets
  const ca = await readFile(stand.caPath)
  const inRange = (ports) =>
    ports.length > 0 && ports.every((value) => value >= passive[0] && value <= passive[1])

  const secure = await ftp({ port, user: site.user, password: site.password, secure: true, ca })
  const names = (await secure.client.list('/public_html')).map(({ name }) => name)
  for (const expected of ['wp-config.php', 'wp-content', 'Кириллица', 'link-to-config'])
    assert.ok(names.includes(expected), `FTPS lists ${expected}`)
  const link = (await secure.client.list('/public_html')).find(
    ({ name }) => name === 'link-to-config',
  )
  assert.ok(link.isSymbolicLink, 'A link is listed as a link')
  const cyrillic = (await secure.client.list('/public_html/Кириллица')).map(({ name }) => name)
  assert.deepEqual(cyrillic, ['страница.html'])
  assert.match(
    (await download(secure.client, '/public_html/wp-includes/version.php')).toString('utf8'),
    /6\.8\.3/,
  )
  const pdf = await download(secure.client, '/public_html/wp-content/uploads/2026/10/brochure.pdf')
  assert.ok(
    pdf.equals(stand.fixture.tree.find(({ path }) => path.endsWith('brochure.pdf')).content),
  )
  assert.ok(inRange(passivePorts(secure.lines)), 'Data connections use the published passive ports')
  assert.ok(pasvAddresses(secure.lines).every((address) => address === '127.0.0.1'))
  secure.client.close()

  // Verified means the stand's CA: without it the certificate is not trusted.
  await assert.rejects(
    ftp({ port, user: site.user, password: site.password, secure: true }),
    /certificate|self.signed|issuer/i,
  )
  const plain = await ftp({ port, user: ftpsite.user, password: ftpsite.password, secure: false })
  assert.ok((await plain.client.list('/public_html')).some(({ name }) => name === 'wp-load.php'))
  assert.ok(inRange(passivePorts(plain.lines)))
  plain.client.close()
  await assert.rejects(
    ftp({ port, user: ftpsite.user, password: `${ftpsite.password}x`, secure: false }),
    /530|login/i,
  )
  passed(
    `FTP (vsftpd 3.0.5): explicit FTPS verified with the stand CA only (session reuse required), plain FTP for ftpsite, UTF-8 names, links listed as links, passive ports ${passive[0]}–${passive[1]} on 127.0.0.1`,
  )
}

async function checkGitleaks(stand) {
  stage = 'Gitleaks over the fixture'
  const scan = join(stand.directory, 'work', 'gitleaks')
  for (const entry of stand.fixture.manifest) {
    if (entry.type !== 'file' || entry.outcome.expect === 'skip') continue
    const source = join(stand.fixture.siteHome, 'public_html', ...entry.path.split('/'))
    const target = join(scan, 'tree', ...entry.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target)
  }
  // The configuration of the product's scan (apps/core/src/git-workspace).
  await writeFile(join(scan, 'gitleaks.toml'), '[extend]\nuseDefault = true\n', { mode: 0o600 })
  const report = join(scan, 'report.json')
  await runCommand(
    stand.tools.gitleaks,
    [
      ...['dir', '.', '--config', join(scan, 'gitleaks.toml'), '--no-banner', '--no-color'],
      ...['--log-level=error', '--redact=100', '--report-format', 'json', '--report-path', report],
      '--exit-code=0',
    ],
    {
      cwd: join(scan, 'tree'),
      env: { PATH: process.env.PATH, HOME: join(stand.directory, 'home') },
      signal: controller.signal,
      timeoutMs: 60_000,
    },
  )
  const findings = JSON.parse(await readFile(report, 'utf8'))
  const files = [...new Set(findings.map(({ File }) => File.replace(/^\.\//, '')))].sort()
  assert.deepEqual(
    files,
    stand.fixture.gitleaksFindings,
    'Gitleaks flags exactly the files of the manifest',
  )
  passed(
    `Gitleaks ${'8.30.1'} with the product's configuration flags exactly ${files.join(', ')} among the files the rules let through`,
  )
}

async function checkSiteDatabases(stand) {
  stage = 'site databases'
  const ca = await readFile(stand.caPath)
  const { mysql: mysqlAt, postgres: postgresAt } = stand.coordinates.siteDatabases
  const { mysql, postgres } = stand.secrets

  const mysql2 = connections('mysql2/promise')
  const connection = await mysql2.createConnection({
    host: mysqlAt.host,
    port: mysqlAt.port,
    user: mysql.user,
    password: mysql.password,
    database: mysql.database,
    ssl: { ca },
    connectTimeout: 10_000,
  })
  try {
    const [[one]] = await connection.query('SELECT 1 AS one')
    assert.equal(one.one, 1)
    const [[tables]] = await connection.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
      [mysql.database],
    )
    assert.equal(Number(tables.n), 1)
    const [[cipher]] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
    assert.ok(cipher.Value, 'MySQL speaks TLS')
  } finally {
    await connection.end()
  }
  const sent = await stand.siteDatabases.mysql.statements()
  assert.ok(
    sent.some(({ argument }) => argument.includes('information_schema.tables')),
    'The general log records the user stand',
  )
  assert.ok(
    !sent.some(({ argument }) => /wp_posts/i.test(argument)),
    'Nothing was sent about wp_posts',
  )

  const client = new PgClient({
    host: postgresAt.host,
    port: postgresAt.port,
    user: postgres.user,
    password: postgres.password,
    database: postgres.database,
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
  })
  await client.connect()
  try {
    assert.equal((await client.query('SELECT 1 AS one')).rows[0].one, 1)
    const tables = await client.query(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
    )
    assert.equal(tables.rows[0].n, 1)
    assert.equal(
      (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0].ssl,
      true,
    )
  } finally {
    await client.end()
  }
  const logged = await stand.siteDatabases.postgres.statements()
  assert.ok(
    logged.some((statement) => statement.includes('pg_catalog.pg_tables')),
    'log_statement=all records it',
  )
  assert.ok(
    !logged.some(
      (statement) => /\bpages\b/.test(statement) && !/CREATE TABLE|INSERT INTO/.test(statement),
    ),
  )
  passed(
    'site MySQL 8.4 and PostgreSQL 17 answer over TLS verified with the stand CA; one table each; their logs show what was sent and nothing of the rows',
  )
}

async function checkCore(stand) {
  stage = 'core on the stand'
  if (!existsSync(join(repository, 'apps/core/dist/main.js'))) {
    console.log('SKIP core: apps/core/dist/main.js is not built (pnpm --filter core build)')
    return
  }
  await stand.core.start()
  const { status, body } = await stand.core.health()
  assert.deepEqual(
    body?.checks,
    { database: 'ok', redis: 'ok', s3: 'ok', vault: 'ok' },
    `core /health ${status}: ${JSON.stringify(body?.checks)}`,
  )
  await stand.core.stop()
  const log = stand.core.log()
  for (const secret of [
    stand.env.core.GITEA_TOKEN,
    stand.env.core.GITEA_PROVISIONER_TOKEN,
    stand.env.core.VAULT_SECRET_ID,
    stand.env.core.METRICS_TOKEN,
    stand.env.core.S3_SECRET_ACCESS_KEY,
  ])
    assert.ok(!log.includes(secret), 'A secret reached the log of core')
  passed(
    `core (node apps/core/dist/main.js, AppRole core, APP_ENV=development) on ${stand.coordinates.core.url}: database, Redis, S3 and Vault ok; stopped by SIGTERM; no secret in its log`,
  )
}

/**
 * Every self-check, in order; `pass(text)` gets one line each. `core` false skips the start of
 * core (a run that goes on to the scenarios starts it itself).
 */
export async function runInfraChecks(stand, { pass, signal, core = true }) {
  passed = pass
  controller = { signal }
  const before = await stand.siteServer.snapshot()
  await checkDatabase(stand)
  await checkVault(stand)
  await checkGitea(stand)
  await checkSftp(stand)
  await checkFtp(stand)
  stage = 'the hosting was not written to'
  assert.equal(await stand.siteServer.snapshot(), before, 'The checks changed the hosting')
  passed('the tree of the hosting is byte for byte what it was before the checks')
  await checkGitleaks(stand)
  await checkSiteDatabases(stand)
  if (core) await checkCore(stand)
}
