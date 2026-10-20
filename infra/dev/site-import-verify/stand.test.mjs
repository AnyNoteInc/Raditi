// The pure parts of the site-import stand: SSH keys and fingerprints, the site and its manifest,
// the arguments of the containers and the environments of the processes. No Docker, no network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import {
  EMPTY_ROOT,
  NESTED_ROOT,
  SITE_ROOT,
  WP_SECRET_NAMES,
  expectedImport,
  gitBlobId,
  gitleaksFindings,
  importManifest,
  newFixtureValues,
  siteTree,
} from './fixture.mjs'
import {
  ed25519PublicBlob,
  hostKeyFingerprint,
  newEd25519Key,
  newRsaKeyWithPassphrase,
  openSshEd25519PrivateKey,
  publicKeyLine,
} from './ssh-keys.mjs'
import { cookieHeader, sessionCookie } from './accounts.mjs'
import {
  Report,
  assertReadOnlyStatements,
  foundNeedles,
  projectUrl,
  secretNeedles,
  sftpSource,
} from './scenarios.mjs'
import {
  ALPINE_IMAGE,
  BROWSER_SCENARIOS,
  EXTRA_SSH_USERS,
  HOSTINGS,
  SCENARIO_IDS,
  browserStand,
  hostingPasswords,
  playwrightGrep,
  scenarioAccounts,
  siteExpectations,
  PASSIVE_PORTS,
  PINNED_IMAGES,
  STAND_LABEL,
  bucketNames,
  containerName,
  coreEnvironment,
  exampleKeysOf,
  gitEnvironment,
  giteaArgs,
  giteaUserArgs,
  mysqlArgs,
  postgresArgs,
  readRunRecord,
  redactor,
  redisArgs,
  runRecord,
  s3Args,
  serverImageTag,
  sitePostgresArgs,
  siteServerArgs,
  standOptions,
  vaultArgs,
  webEnvironment,
} from './stand.mjs'

const root = new URL('../../../', import.meta.url)
const here = new URL('./', import.meta.url)
const RUN = '0123abcd'
const values = newFixtureValues()
/** ssh2 of the product (packages/site-connections); absent before `pnpm install`. */
const ssh2 = (() => {
  try {
    return createRequire(new URL('packages/site-connections/package.json', root))('ssh2')
  } catch {
    return null
  }
})()

// ─── SSH keys ───────────────────────────────────────────────────────────────

// RFC 8032, test 1; the fingerprint is what `ssh-keygen -lf` printed for the key written below.
const RFC_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const RFC_PUBLIC = Buffer.from(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
)

test('the fingerprint is the product format: key type, SHA256: and 43 characters', () => {
  const blob = ed25519PublicBlob(RFC_PUBLIC)
  assert.equal(
    hostKeyFingerprint(blob),
    'ssh-ed25519 SHA256:bbXpuKG6zhzdmnxq256TlqzFBzRl2f6OOg722cYNbU8',
  )
  assert.equal(
    publicKeyLine(blob, 'rfc8032'),
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea rfc8032',
  )
  // packages/domain/src/site-connection/inputs.ts, hostKeySchema.
  const schema = /^(?:ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+) SHA256:[A-Za-z0-9+/]{43}$/
  for (const key of [newEd25519Key('a'), newRsaKeyWithPassphrase('synthetic-passphrase', 'b')])
    assert.match(key.fingerprint, schema)
})

test('the OpenSSH private key is the format of PROTOCOL.key, padded to 8 bytes', () => {
  const pem = openSshEd25519PrivateKey({
    seed: RFC_SEED,
    publicKey: RFC_PUBLIC,
    comment: 'rfc8032',
    checkint: 7,
  })
  const lines = pem.trim().split('\n')
  assert.equal(lines[0], '-----BEGIN OPENSSH PRIVATE KEY-----')
  assert.equal(lines.at(-1), '-----END OPENSSH PRIVATE KEY-----')
  assert.ok(lines.slice(1, -1).every((line) => line.length <= 70))
  const body = Buffer.from(lines.slice(1, -1).join(''), 'base64')
  assert.equal(body.subarray(0, 15).toString('latin1'), 'openssh-key-v1\0')
  // The private section is the last string of the body; its length is a multiple of 8.
  const blob = ed25519PublicBlob(RFC_PUBLIC)
  // magic, two strings `none`, the empty KDF options, the key count, the public key.
  const sectionAt = 15 + 8 + 8 + 4 + 4 + 4 + blob.length
  const length = body.readUInt32BE(sectionAt)
  assert.equal(length % 8, 0)
  assert.equal(sectionAt + 4 + length, body.length)
  assert.equal(body.readUInt32BE(sectionAt + 4), 7)
  assert.equal(body.readUInt32BE(sectionAt + 8), 7)
  assert.throws(() => openSshEd25519PrivateKey({ seed: Buffer.alloc(31), publicKey: RFC_PUBLIC }))
})

test(
  'ssh2, the product’s client, reads both user keys and the host key',
  { skip: ssh2 === null },
  () => {
    const key = newEd25519Key('site@stand')
    const parsed = ssh2.utils.parseKey(key.privateKey)
    assert.equal(parsed.type, 'ssh-ed25519')
    assert.equal(hostKeyFingerprint(parsed.getPublicSSH()), key.fingerprint)
    assert.equal(parsed.getPublicSSH().toString('base64'), key.publicKey.split(' ')[1])
    const locked = newRsaKeyWithPassphrase('synthetic-passphrase', 'locked')
    assert.ok(
      ssh2.utils.parseKey(locked.privateKey) instanceof Error,
      'no key without the passphrase',
    )
    assert.ok(ssh2.utils.parseKey(locked.privateKey, 'another-passphrase') instanceof Error)
    const opened = ssh2.utils.parseKey(locked.privateKey, 'synthetic-passphrase')
    assert.equal(opened.type, 'ssh-rsa')
    assert.equal(hostKeyFingerprint(opened.getPublicSSH()), locked.fingerprint)
  },
)

// ─── The site and its manifest ──────────────────────────────────────────────

test('the tree is the same bytes every run, apart from the secret values', () => {
  const other = newFixtureValues()
  const strip = (tree, of) =>
    tree.map(({ path, type, content, target }) => {
      let text = type === 'link' ? target : content.toString('latin1')
      for (const value of [
        of.sshPassword,
        of.ftpPassword,
        of.sitebPassword,
        of.sitebNewPassword,
        of.sitecPassword,
        of.databasePassword,
        of.awsKeyId,
        of.awsSecret,
        ...Object.values(of.wpSecrets),
      ])
        text = text.replaceAll(value, '<secret>')
      return [path, type, text]
    })
  assert.deepEqual(strip(siteTree(values), values), strip(siteTree(other), other))
  const paths = siteTree(values).map(({ path }) => path)
  assert.equal(new Set(paths).size, paths.length)
  for (const folder of [SITE_ROOT, EMPTY_ROOT, NESTED_ROOT])
    assert.ok(
      paths.some((path) => path.startsWith(`${folder}/`)),
      folder,
    )
  assert.ok(!paths.some((path) => path.startsWith(`${EMPTY_ROOT}/wp-`)))
})

test('the secrets sit where the scans must find them', () => {
  const file = (path) => siteTree(values).find((entry) => entry.path === `${SITE_ROOT}/${path}`)
  const config = file('wp-config.php').content.toString()
  assert.ok(config.includes(`define( 'DB_PASSWORD', '${values.databasePassword}' );`))
  for (const name of WP_SECRET_NAMES)
    assert.ok(config.includes(`'${values.wpSecrets[name]}'`), name)
  const leaked = file('notes/leaked.txt').content.toString()
  assert.ok(leaked.includes(values.sshPassword) && leaked.includes(values.ftpPassword))
  assert.ok(file('notes/db.txt').content.toString().includes(values.databasePassword))
  assert.match(file('notes/aws.txt').content.toString(), /aws_access_key_id = AKIA[A-Z2-7]{16}\n/)
  assert.deepEqual(gitleaksFindings(values), ['notes/aws.txt'])
  // The sample ships placeholders only.
  assert.ok(!file('wp-config-sample.php').content.toString().includes(values.databasePassword))
  assert.deepEqual(file('link-to-config'), {
    path: `${SITE_ROOT}/link-to-config`,
    type: 'link',
    target: 'wp-config.php',
  })
})

test('the media are real binary files', () => {
  const file = (suffix) => siteTree(values).find(({ path }) => path.endsWith(suffix)).content
  const jpeg = file('photo.jpg')
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff])
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9])
  const pdf = file('brochure.pdf')
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4')
  assert.ok(
    pdf.subarray(9, 14).some((byte) => byte > 0x7f),
    'a binary marker line',
  )
  // Every offset of the cross-reference table points at its object.
  const text = pdf.toString('latin1')
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map(([, offset]) => Number(offset))
  offsets.forEach((offset, index) => assert.ok(text.startsWith(`${index + 1} 0 obj`, offset)))
  assert.ok(text.endsWith('%%EOF\n'))
})

test('git blob ids are the ones git computes', () => {
  assert.equal(gitBlobId('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a')
  assert.equal(gitBlobId(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

test('a password access drops the typed passwords; a key access lets them through', () => {
  const byPassword = expectedImport(values, { auth: 'password' })
  const byKey = expectedImport(values, { auth: 'key' })
  const paths = (result) => result.files.map(({ path }) => path)
  assert.deepEqual(
    paths(byKey).filter((path) => !paths(byPassword).includes(path)),
    ['notes/leaked.txt'],
  )
  for (const result of [byPassword, byKey]) {
    for (const path of [
      'index.php',
      'wp-includes/version.php',
      'wp-content/uploads/2026/10/photo.jpg',
      'Кириллица/страница.html',
    ])
      assert.ok(paths(result).includes(path), path)
    for (const path of [
      'wp-config.php',
      'wp-config-sample.php',
      '.htaccess',
      '.git/config',
      '.github/workflows/deploy.yml',
      'old/index.php',
      'link-to-config',
      'notes/aws.txt',
      'notes/db.txt',
      'backup.sql',
      'wp-content/cache/page.html',
      'wp-content/debug.log',
    ])
      assert.ok(result.absent.includes(path), path)
    assert.equal(result.files.length + result.absent.length, importManifest(values).length)
  }
  assert.deepEqual(byPassword.skipped, {
    excluded: 6,
    vcs: 1,
    ci: 1,
    nested_site: 1,
    link: 1,
    secret: 3,
  })
  assert.deepEqual(byKey.skipped, {
    excluded: 6,
    vcs: 1,
    ci: 1,
    nested_site: 1,
    link: 1,
    secret: 2,
  })
  const index = byKey.files.find(({ path }) => path === 'index.php')
  const content = siteTree(values).find(({ path }) => path === `${SITE_ROOT}/index.php`).content
  assert.deepEqual(index, { path: 'index.php', bytes: content.length, blob: gitBlobId(content) })
  assert.throws(() => expectedImport(values, { auth: 'token' }))
})

test('the manifest agrees with the WordPress rules and the path policy of the product', async () => {
  const { createImportPathPolicy, isNestedSiteRoot } = await import(
    new URL('packages/domain/src/site-connection/import-policy.ts', root)
  )
  const { wordpressAdapter } = await import(
    new URL('packages/site-adapters/src/wordpress.ts', root)
  )
  const facts = { stack: 'wordpress', url: 'https://stand.example.test', docroot: '/', extras: {} }
  const policy = createImportPathPolicy(wordpressAdapter.importRules(facts).exclude)
  const prefixes = (path) =>
    path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))
  for (const { path, type, outcome } of importManifest(values)) {
    if (outcome.expect === 'skip' && ['excluded', 'vcs', 'ci'].includes(outcome.reason)) {
      assert.equal(policy.decide(outcome.at, outcome.atType), outcome.reason, path)
      continue
    }
    if (outcome.expect === 'skip' && outcome.reason === 'nested_site') {
      const names = siteTree(values)
        .filter((entry) => entry.path.startsWith(`${SITE_ROOT}/${outcome.at}/`))
        .map((entry) => entry.path.split('/')[2])
      assert.ok(isNestedSiteRoot([...new Set(names)], wordpressAdapter.rootMarkers()), path)
      continue
    }
    // Taken, a link or a secret: nothing on the way to it is excluded by the rules.
    const parts = prefixes(path)
    parts.forEach((prefix, index) =>
      assert.equal(
        policy.decide(
          prefix,
          index < parts.length - 1 || type === 'directory' ? 'directory' : 'file',
        ),
        'take',
        path,
      ),
    )
  }
  // The site root itself is one: the markers are there.
  const top = [
    ...new Set(
      siteTree(values)
        .filter(({ path }) => path.startsWith(`${SITE_ROOT}/`))
        .map(({ path }) => path.split('/')[1]),
    ),
  ]
  assert.ok(isNestedSiteRoot(top, wordpressAdapter.rootMarkers()))
})

// ─── Containers ─────────────────────────────────────────────────────────────

const flagValues = (args, flag) =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
const passive = [50_100, 50_100 + PASSIVE_PORTS - 1]
const everyContainer = () => ({
  postgres: postgresArgs({ run: RUN, envFile: '/tmp/x/postgres.env' }),
  redis: redisArgs({ run: RUN, envFile: '/tmp/x/redis.env' }),
  s3: s3Args({ run: RUN }),
  vault: vaultArgs({ run: RUN, envFile: '/tmp/x/vault.env' }),
  gitea: giteaArgs({ run: RUN, port: 43_210 }),
  site: siteServerArgs({
    run: RUN,
    image: 'raditi-siteimport-server:0123456789abcdef',
    ssh: 43_211,
    ftp: 43_212,
    passive,
  }),
  spare: siteServerArgs({
    run: RUN,
    service: 'spare',
    image: 'raditi-siteimport-server:0123456789abcdef',
    ssh: 43_213,
    ftp: 43_214,
    passive: [50_200, 50_200 + PASSIVE_PORTS - 1],
  }),
  mysql: mysqlArgs({ run: RUN, envFile: '/tmp/x/mysql.env' }),
  sitepg: sitePostgresArgs({ run: RUN, envFile: '/tmp/x/sitepg.env' }),
})

test('every container is the run’s own, never pulled, without host mounts', () => {
  for (const [service, args] of Object.entries(everyContainer())) {
    assert.deepEqual(args.slice(0, 2), ['create', '--pull=never'], service)
    assert.deepEqual(flagValues(args, '--name'), [`raditi-siteimport-${RUN}-${service}`])
    assert.deepEqual(flagValues(args, '--label'), [`${STAND_LABEL}=${RUN}`])
    for (const flag of ['-v', '--volume', '--mount', '--network', '--privileged', '--cap-add'])
      assert.deepEqual(flagValues(args, flag), [], `${service} ${flag}`)
    for (const published of flagValues(args, '-p'))
      assert.match(published, /^127\.0\.0\.1:/, service)
    assert.ok(
      flagValues(args, '--memory').length === 1 && flagValues(args, '--pids-limit').length === 1,
    )
  }
  assert.throws(() => containerName(RUN, 'dev-postgres'), /Unknown service/)
  assert.throws(() => containerName('raditi', 'postgres'), /run id/)
  for (const image of PINNED_IMAGES) assert.match(image, /^[^@\s]+:[^@\s]+@sha256:[a-f0-9]{64}$/)
})

test('no secret is an argument: passwords come from env files, settings are named', () => {
  const allowed = /^(GITEA__[A-Za-z_]+|PASV_MIN|PASV_MAX)=/
  for (const [service, args] of Object.entries(everyContainer())) {
    for (const value of flagValues(args, '-e')) assert.match(value, allowed, service)
    for (const file of flagValues(args, '--env-file')) assert.match(file, /^\/tmp\/x\/[a-z]+\.env$/)
    assert.ok(!args.some((arg) => /PASSWORD=|TOKEN=|SECRET/.test(arg)), service)
  }
  assert.throws(() => postgresArgs({ run: RUN, envFile: 'postgres.env' }), /absolute/)
  const account = giteaUserArgs({ run: RUN, user: 'raditi-bot' })
  assert.ok(account.includes('--random-password'))
  assert.ok(!account.includes('--password'))
  assert.throws(() => giteaUserArgs({ run: RUN, user: 'Bot; rm' }))
})

test('the hosting publishes its passive range 1:1 and keeps the control ports out of it', () => {
  const args = everyContainer().site
  assert.deepEqual(flagValues(args, '-p'), [
    '127.0.0.1:43211:22',
    '127.0.0.1:43212:21',
    `127.0.0.1:${passive[0]}-${passive[1]}:${passive[0]}-${passive[1]}`,
  ])
  assert.deepEqual(flagValues(args, '-e'), [`PASV_MIN=${passive[0]}`, `PASV_MAX=${passive[1]}`])
  const image = 'raditi-siteimport-server:0123456789abcdef'
  assert.throws(
    () => siteServerArgs({ run: RUN, image, ssh: 50_101, ftp: 43_212, passive }),
    /outside/,
  )
  assert.throws(() =>
    siteServerArgs({ run: RUN, image, ssh: 43_211, ftp: 43_212, passive: [50_100, 50_105] }),
  )
  assert.throws(() =>
    siteServerArgs({ run: RUN, image: 'alpine:3.22', ssh: 43_211, ftp: 43_212, passive }),
  )
})

test('the hosting image is tagged by its content and built from the pinned Alpine', () => {
  const files = [
    ['Dockerfile', Buffer.from('a')],
    ['server/x', Buffer.from('b')],
  ]
  const tag = serverImageTag(files)
  assert.match(tag, /^raditi-siteimport-server:[0-9a-f]{16}$/)
  assert.equal(serverImageTag([...files].reverse()), tag)
  assert.notEqual(serverImageTag([files[0], ['server/x', Buffer.from('c')]]), tag)
  const dockerfile = readFileSync(new URL('Dockerfile', here), 'utf8')
  assert.deepEqual(
    [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(([, image]) => image),
    [ALPINE_IMAGE],
  )
  // Everything the image copies is in server/: the tag covers it.
  assert.match(dockerfile, /^COPY \. \/opt\/stand\/$/m)
  assert.deepEqual(readdirSync(new URL('server/', here)).sort(), [
    'entrypoint.sh',
    'ftp-users',
    'sshd_config',
    'use-host-key.sh',
    'vsftpd.conf',
  ])
})

test('the hosting configuration: SFTP only, FTPS with session reuse, passive on loopback', () => {
  const sshd = readFileSync(new URL('server/sshd_config', here), 'utf8')
  for (const line of [
    'ForceCommand internal-sftp',
    'ChrootDirectory /home/site',
    'AllowUsers site siteb sitec',
    'PasswordAuthentication yes',
    'PerSourcePenalties no',
  ])
    assert.ok(sshd.split('\n').includes(line), line)
  const vsftpd = readFileSync(new URL('server/vsftpd.conf', here), 'utf8')
  for (const line of [
    'ssl_enable=YES',
    'allow_anon_ssl=NO',
    'force_local_logins_ssl=NO',
    'require_ssl_reuse=YES',
    'pasv_address=127.0.0.1',
    'port_enable=NO',
    'anonymous_enable=NO',
  ])
    assert.ok(vsftpd.split('\n').includes(line), line)
})

// ─── Processes ──────────────────────────────────────────────────────────────

const coreEnv = () =>
  coreEnvironment({
    path: '/usr/bin:/bin',
    gitleaks: '/opt/tools/gitleaks',
    directory: '/tmp/raditi-siteimport-0123abcd',
    port: 43_300,
    webOrigin: 'http://localhost:43301',
    databaseUrl: 'postgresql://raditi:pw@127.0.0.1:5432/raditi',
    redisUrl: 'redis://default:pw@127.0.0.1:6379',
    s3: {
      endpoint: 'http://127.0.0.1:8333',
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      buckets: bucketNames(RUN),
    },
    vault: { address: 'http://127.0.0.1:8200', roleId: 'role', secretId: 'secret-id' },
    gitea: {
      origin: 'https://127.0.0.1:3000',
      botToken: 'bot-token',
      provisionerToken: 'provisioner-token',
    },
    caPath: '/tmp/raditi-siteimport-0123abcd/tls/ca.pem',
    metricsToken: 'metrics',
  })

test('core runs as the role core of a development stand, without the repository .env', () => {
  const env = coreEnv()
  assert.equal(env.NODE_ENV, 'production', 'NODE_ENV=production keeps loadRepoEnv away')
  assert.equal(env.APP_ENV, 'development')
  assert.equal(env.PATH, '/opt/tools:/usr/bin:/bin')
  assert.equal(env.HOME, '/tmp/raditi-siteimport-0123abcd/home')
  assert.equal(env.GIT_CA_FILE, env.NODE_EXTRA_CA_CERTS)
  assert.match(env.GITEA_URL, /^https:/)
  assert.equal(env.GITEA_PROVISIONER_TOKEN, 'provisioner-token')
  assert.notEqual(env.GITEA_TOKEN, env.GITEA_PROVISIONER_TOKEN)
  assert.equal(env.VAULT_DEV_ROOT_TOKEN, undefined, 'core logs in by its AppRole only')
  assert.equal(env.SANDBOX_DOCKER_SOCKET, '/tmp/raditi-siteimport-0123abcd/no-docker.sock')
  assert.equal(env.LLM_CONTROL_URL, 'http://127.0.0.1:9')
  assert.equal(env.S3_BUCKET_ARTIFACTS, `raditi-siteimport-${RUN}-artifacts`)
  for (const name of Object.keys(env)) assert.match(name, /^[A-Z][A-Z0-9_]*$/)
})

test('web gets every name of .env.example, blank unless the stand sets it', () => {
  const exampleKeys = exampleKeysOf(readFileSync(new URL('.env.example', root), 'utf8'))
  assert.ok(exampleKeys.includes('ZAI_API_KEY') && exampleKeys.includes('VAULT_ROLE_ID'))
  const env = webEnvironment({
    path: '/usr/bin:/bin',
    directory: '/tmp/raditi-siteimport-0123abcd',
    webOrigin: 'http://localhost:43301',
    databaseUrl: 'postgresql://raditi:pw@127.0.0.1:5432/raditi',
    redisUrl: 'redis://default:pw@127.0.0.1:6379',
    vault: { address: 'http://127.0.0.1:8200', roleId: 'web-role', secretId: 'web-secret' },
    caPath: '/tmp/ca.pem',
    metricsToken: 'metrics',
    authSecret: 'auth-secret',
    exampleKeys,
  })
  for (const key of exampleKeys.filter((name) => name !== 'NODE_ENV')) assert.ok(key in env, key)
  assert.equal(env.NODE_ENV, undefined, 'Next sets NODE_ENV itself')
  for (const key of [
    'ZAI_API_KEY',
    'YOOKASSA_SECRET_KEY',
    'VAULT_DEV_ROOT_TOKEN',
    'GITEA_TOKEN',
    'SENDSAY_API_KEY',
  ])
    assert.equal(env[key], '', key)
  assert.equal(env.VAULT_ROLE_ID, 'web-role')
  assert.equal(env.APP_ENV, 'development')
  assert.equal(env.APP_URL, env.BETTER_AUTH_URL)
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/ca.pem')
})

test('git carries the token in a header from the environment, never in a URL', () => {
  const env = gitEnvironment({
    path: '/usr/bin',
    home: '/tmp/h',
    caPath: '/tmp/ca.pem',
    user: 'raditi-bot',
    token: 'f'.repeat(40),
  })
  const header = Buffer.from(`raditi-bot:${'f'.repeat(40)}`).toString('base64')
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${header}`)
  assert.ok(!Object.values(env).some((value) => value.includes('f'.repeat(40))))
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

test('options: everything by default, --infra-only, --only in the order of the run', () => {
  assert.deepEqual(standOptions([]), { keep: false, infraOnly: false, selected: [...SCENARIO_IDS] })
  assert.deepEqual(standOptions(['--infra-only']), {
    keep: false,
    infraOnly: true,
    selected: ['infra'],
  })
  assert.deepEqual(standOptions(['--', '--only', 'r3,b1,r3', '--keep']), {
    keep: true,
    infraOnly: false,
    selected: ['b1', 'r3'],
  })
  assert.deepEqual(standOptions(['--only=b4']).selected, ['b4'])
  assert.throws(() => standOptions(['--only', 'b9']), /--only takes/)
  assert.throws(() => standOptions(['--only']), /--only takes/)
  assert.throws(() => standOptions(['--infra-only', '--only', 'b1']), /one of them/)
  assert.throws(() => standOptions(['--gitea=https://example.test']), /accepts/)
  for (const id of BROWSER_SCENARIOS) assert.ok(SCENARIO_IDS.includes(id))
})

test('the run record and the redaction', () => {
  const record = runRecord({
    run: RUN,
    pid: 4242,
    core: [4343],
    web: [{ pid: 4444, port: 43_300 }],
  })
  assert.deepEqual(readRunRecord(`raditi-siteimport-${RUN}`, record), {
    run: RUN,
    pid: 4242,
    core: [4343],
    web: [{ pid: 4444, port: 43_300 }],
  })
  assert.equal(
    readRunRecord('raditi-siteimport-ffffffff', record),
    null,
    'the record names its own run',
  )
  assert.equal(readRunRecord('raditi-billing-verify-0123abcd', record), null)
  assert.equal(readRunRecord(`raditi-siteimport-${RUN}`, '{'), null)
  const redact = redactor(['secret-value', 'secret-value-longer', 'short'])
  assert.equal(
    redact('a secret-value-longer and secret-value, short'),
    'a [redacted] and [redacted], short',
  )
  assert.equal(createHash('sha256').update(redact('')).digest('hex').length, 64)
})

// ─── The scenario half ──────────────────────────────────────────────────────

test('the hostings: two of them, every account with its password, FTP for two of them', () => {
  assert.deepEqual(HOSTINGS, ['site', 'spare'])
  const lines = hostingPasswords(values).trim().split('\n')
  assert.deepEqual(
    lines.map((line) => line.split(':')[0]),
    ['site', 'ftpsite', ...EXTRA_SSH_USERS],
  )
  assert.ok(lines.every((line) => /^[a-z]+:[A-Za-z0-9_-]+$/.test(line)))
  assert.throws(() => hostingPasswords({ ...values, sitecPassword: 'a:b\nroot:x' }), /password/)
  const sshd = readFileSync(new URL('server/sshd_config', here), 'utf8')
  assert.ok(sshd.split('\n').includes(`AllowUsers site ${EXTRA_SSH_USERS.join(' ')}`))
  assert.ok(sshd.split('\n').includes('ChrootDirectory /home/site'))
  assert.deepEqual(readFileSync(new URL('server/ftp-users', here), 'utf8').trim().split('\n'), [
    'site',
    'ftpsite',
  ])
  // Whichever account a scenario types, notes/leaked.txt holds its password.
  const leaked = siteTree(values)
    .find(({ path }) => path === `${SITE_ROOT}/notes/leaked.txt`)
    .content.toString()
  for (const line of lines) assert.ok(leaked.includes(line.split(':')[1]))
  assert.ok(leaked.includes(values.sitebNewPassword))
})

test('accounts per scenario, and the grep of the browser half', () => {
  assert.deepEqual(scenarioAccounts(['b1', 'b4', 'r6']), [
    'b1',
    'b4auth',
    'b4root',
    'b4hostkey',
    'b4database',
    'r6',
  ])
  assert.deepEqual(scenarioAccounts(['infra']), [])
  const grep = new RegExp(playwrightGrep(['b1', 'r4']))
  assert.ok(grep.test('wizard [b1] SSH with a password'))
  assert.ok(grep.test('site-import/setup.spec.ts [r4] a foreign v0.0.0'))
  assert.ok(!grep.test('wizard [b2] FTPS'))
  assert.throws(() => playwrightGrep(['b1|.*']), /ids/)
  assert.throws(() => playwrightGrep([]), /ids/)
})

test('every browser scenario has its tests, b1 alone in the held project', () => {
  const tests = new URL('../../../apps/e2e/tests/site-import/', import.meta.url)
  const titles = (file) =>
    [...readFileSync(new URL(file, tests), 'utf8').matchAll(/^test\('\[([a-z0-9]+)\] /gm)].map(
      ([, id]) => id,
    )
  assert.deepEqual(titles('held.spec.ts'), ['b1'])
  const others = [...titles('wizard.spec.ts'), ...titles('setup.spec.ts')]
  assert.deepEqual([...new Set(['b1', ...others])].sort(), [...BROWSER_SCENARIOS].sort())
  const config = readFileSync(
    new URL('../../../apps/e2e/playwright.site-import.config.ts', import.meta.url),
    'utf8',
  )
  assert.match(config, /trace: 'off'/, 'No trace: it would keep the typed passwords')
  assert.match(config, /\['held'\] : \[\]/, 'held is a dependency only of a run with b1')
})

test('each site the scenarios make has its expectations', () => {
  for (const id of ['b1', 'b2', 'b3', 'b5', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
    const spec = siteExpectations(id, { foreign: 'f'.repeat(40) })
    assert.ok(['password', 'key'].includes(spec.auth), id)
    assert.ok(['sftp', 'ftp'].includes(spec.kind), id)
    assert.ok(HOSTINGS.includes(spec.hosting), id)
    assert.ok(spec.events.length >= 1 && spec.events[0] === '1:1', id)
    assert.ok(
      spec.events.every((event) => /^\d+:\d+$/.test(event)),
      id,
    )
  }
  assert.equal(siteExpectations('b3').auth, 'key')
  assert.equal(siteExpectations('r4', { foreign: 'abc' }).foreign, 'abc')
  assert.deepEqual(siteExpectations('r6').events, ['1:1', '2:1', '3:1'])
  assert.throws(() => siteExpectations('b4'), /No site/)
})

test('the file of the browser half carries sessions and accesses, never the stand internals', () => {
  const server = (ssh) => ({
    host: '127.0.0.1',
    ssh: { port: ssh },
    ftp: { port: ssh + 1 },
    roots: {
      site: 'public_html',
      empty: 'empty_root',
      nestedParent: 'nested',
      nested: 'nested/public_html',
    },
    hostKeys: { first: 'ssh-ed25519 SHA256:a', second: 'ssh-ed25519 SHA256:b' },
  })
  const file = browserStand(
    {
      run: RUN,
      directory: '/tmp/raditi-siteimport-0123abcd',
      web: { origin: 'http://127.0.0.1:43300' },
      coordinates: {
        siteServer: server(43_211),
        spareServer: server(43_213),
        siteDatabases: { mysql: { port: 43_215 }, postgres: { port: 43_216 } },
      },
      secrets: {
        site: { user: 'site', password: 'p1' },
        ftpsite: { user: 'ftpsite', password: 'p2' },
        siteb: { user: 'siteb', password: 'old', newPassword: 'new' },
        mysql: { user: 'stand', password: 'm', database: 'wp_stand' },
        postgres: { user: 'stand', password: 'g', database: 'stand' },
        metricsToken: 'must-not-travel',
      },
    },
    {
      accounts: { b1: { userId: 'u', email: 'e', cookies: [{ name: 'c' }], cookie: 'c=1' } },
      control: { url: 'http://127.0.0.1:1', token: 't' },
      extras: { r6: 'site' },
      holdCore: true,
    },
  )
  assert.deepEqual(file.accounts, { b1: { userId: 'u', cookies: [{ name: 'c' }] } })
  assert.deepEqual(file.users.siteb, { user: 'siteb', password: 'new' })
  assert.deepEqual(file.hostings.spare, { host: '127.0.0.1', ssh: 43_213, ftp: 43_214 })
  assert.equal(file.databases.mysql.port, 43_215)
  assert.equal(file.reportFile, '/tmp/raditi-siteimport-0123abcd/playwright/report.json')
  assert.ok(!JSON.stringify(file).includes('must-not-travel'))
})

test('the session cookie of a sign-up, as the browser and the stand send it back', () => {
  const cookie = sessionCookie(
    'better-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
    '127.0.0.1',
  )
  assert.deepEqual(cookie, {
    name: 'better-auth.session_token',
    value: 'abc.def%3D',
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  })
  assert.equal(
    cookieHeader([cookie, { name: 'b', value: '2' }]),
    'better-auth.session_token=abc.def%3D; b=2',
  )
  assert.throws(() => sessionCookie('=x', '127.0.0.1'), /name/)
})

test('the stand’s tRPC calls: the envelope of superjson and the refusals', async () => {
  const { TrpcError, trpcBody, trpcResult } = await import('./trpc.mjs')
  assert.equal(trpcBody({ id: 'x' }), '{"json":{"id":"x"}}')
  assert.deepEqual(trpcResult('project.get', 200, { result: { data: { json: { ok: 1 } } } }), {
    ok: 1,
  })
  assert.throws(
    () =>
      trpcResult('project.create', 409, {
        error: {
          json: {
            message: 'm',
            data: { code: 'CONFLICT', domainCode: 'PROJECT_REQUEST_CONFLICT' },
          },
        },
      }),
    (error) =>
      error instanceof TrpcError &&
      error.domainCode === 'PROJECT_REQUEST_CONFLICT' &&
      error.code === 'CONFLICT',
  )
  assert.throws(() => trpcResult('project.get', 502, null), /HTTP 502/)
})

test('the scans of what a run leaves: every line of a key, indexes not values', () => {
  const key = newEd25519Key('x').privateKey
  const needles = secretNeedles([key, 'short', 'a-long-password-value'])
  assert.ok(needles.includes(key))
  assert.ok(needles.includes('a-long-password-value'))
  assert.ok(!needles.includes('short'))
  const body = key.split('\n').find((line) => line.length >= 40 && !line.startsWith('-----'))
  assert.ok(needles.includes(body), 'a body line of the key on its own')
  // A key stored as JSON has its breaks escaped: the body line still matches.
  const stored = Buffer.from(JSON.stringify({ privateKey: key }))
  assert.ok(foundNeedles(stored, needles).includes(needles.indexOf(body)))
  assert.deepEqual(foundNeedles(Buffer.from('nothing here'), needles), [])
})

test('the site databases: only reads of the catalogue pass', () => {
  assert.doesNotThrow(() =>
    assertReadOnlyStatements(
      [
        'SELECT 1',
        'START TRANSACTION READ ONLY',
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'wp_stand'",
        'COMMIT',
      ],
      ['wp_posts'],
    ),
  )
  assert.throws(
    () => assertReadOnlyStatements(['SELECT * FROM wp_posts'], ['wp_posts']),
    /user table/,
  )
  assert.throws(
    () => assertReadOnlyStatements(['  insert into x values (1)'], ['wp_posts']),
    /write/,
  )
  assert.throws(() => assertReadOnlyStatements(['CREATE TABLE y (a int)'], ['pages']), /write/)
})

test('the projects and accesses the stand types', () => {
  assert.equal(projectUrl(RUN, 'r3'), `https://r3-${RUN}.stand.example.test`)
  const source = sftpSource(
    {
      coordinates: {
        siteServer: {
          ssh: { port: 43_211 },
          roots: { site: 'public_html' },
          hostKeys: { first: 'k1' },
        },
      },
    },
    { user: 'sitec', password: 'pw' },
  )
  assert.deepEqual(source, {
    kind: 'sftp',
    host: '127.0.0.1',
    port: 43_211,
    username: 'sitec',
    auth: { method: 'password', password: 'pw' },
    rootPath: 'public_html',
    hostKey: 'k1',
  })
  const lines = []
  const report = new Report((line) => lines.push(line))
  report.pass('r1', 'ok')
  report.fail('r2', new Error('secret-value-here'), (text) =>
    text.replace('secret-value-here', '[redacted]'),
  )
  assert.deepEqual(lines, ['PASS r1 ok', 'FAIL r2 [redacted]'])
  assert.equal(report.passed, 1)
  assert.deepEqual(
    report.failures.map(({ id }) => id),
    ['r2'],
  )
})
