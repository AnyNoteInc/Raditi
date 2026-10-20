import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

import {
  publishedContentHashMaterial,
  resolvePinnedAddress,
  type DbContentUpdate,
  type DeployAccess,
  type DeployManifest,
  type PublishedContentState,
} from '@repo/domain'
import { getSiteContentAdapter } from '@repo/site-adapters'
import {
  createPinnedSiteTransport,
  createSftpHostingWriter,
  sshKeyFingerprint,
} from '@repo/site-connections/hosting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sealDbOperationValue } from '../releases/release-db-values.ts'
import { FakeReleaseApi } from '../testing/deploy-step.ts'
import { runDeploy, type DeployContext } from './deploy.ts'
import { checkSite } from './site-check.ts'
import { TreeSourceError, type TreeSource } from './tree-source.ts'

// `deploy-step` against a real WordPress 7.1.2 with the plugin «Радити», its MariaDB and an SFTP
// hosting (linuxserver/openssh-server) over the same document root: files over SFTP, a page
// through the plugin in its mode `release` (exact bytes its filter keeps), the check of the front
// page, the rollback. Only
// the release API and the files of the release commit are fakes. Needs Docker and the images
// below already pulled; runs with RADITI_HOSTING_DOCKER_TESTS=1.

const enabled = process.env.RADITI_HOSTING_DOCKER_TESTS === '1'
const run = promisify(execFile)
const IMAGES = {
  database: 'mariadb:11.4.13',
  wordpress: 'wordpress:7.1.2-php8.3-apache',
  cli: 'wordpress:cli-php8.3',
  hosting:
    'linuxserver/openssh-server@sha256:96b9a4d3b5106746d08d43a6911650d4d21f7d5c7f2ac9660e792bdb5e63157c',
}
const DOCROOT = '/var/www/html'
const plugin = readFileSync(
  new URL('../../../../infra/wordpress/raditi-content.php', import.meta.url),
  'utf8',
)

const suffix = randomBytes(4).toString('hex')
const names = {
  network: `raditi-r8c-it-${suffix}`,
  volume: `raditi-r8c-it-${suffix}-www`,
  database: `raditi-r8c-it-${suffix}-db`,
  wordpress: `raditi-r8c-it-${suffix}-wp`,
  hosting: `raditi-r8c-it-${suffix}-sftp`,
}
const secrets = {
  database: randomBytes(18).toString('base64url'),
  admin: randomBytes(18).toString('base64url'),
  hosting: randomBytes(18).toString('base64url'),
}
const siteId = '0196abcd-0000-7000-8000-0000000000aa'
const key = Buffer.alloc(32, 9)
const dbEnv = [
  'WORDPRESS_DB_HOST=database',
  'WORDPRESS_DB_USER=wp',
  `WORDPRESS_DB_PASSWORD=${secrets.database}`,
  'WORDPRESS_DB_NAME=wp',
]
let origin = ''
let hostingPort = 0
let hostKey = ''
let applicationPassword = ''
let pageId = 0

const docker = async (...args: string[]) => (await run('docker', args)).stdout
const wp = (...args: string[]) =>
  docker(
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    names.network,
    '--user',
    '33:33',
    '--volume',
    `${names.volume}:${DOCROOT}`,
    ...dbEnv.flatMap((pair) => ['--env', pair]),
    IMAGES.cli,
    'wp',
    ...args,
  )
/** Writes a file of the document root as the web server's user. */
const put = (path: string, text: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      '-u',
      '33:33',
      names.wordpress,
      'sh',
      '-c',
      'mkdir -p "$(dirname "$1")" && cat > "$1"',
      'sh',
      `${DOCROOT}/${path}`,
    ])
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    child.stdin.end(text)
  })
const fileOf = async (path: string) =>
  run('docker', ['exec', names.wordpress, 'cat', `${DOCROOT}/${path}`]).then(
    ({ stdout }) => stdout,
    () => null,
  )
const folderExists = async (path: string) =>
  run('docker', ['exec', names.wordpress, 'test', '-d', `${DOCROOT}/${path}`]).then(
    () => true,
    () => false,
  )
/** The outcome of a deploy whose last report the fake core took. */
const outcomeOf = async (context: DeployContext) => {
  const result = await runDeploy(context)
  expect(result.told).toBe(true)
  return result.outcome
}
const until = async (what: string, probe: () => Promise<unknown>, tries = 120) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await probe()
    } catch (error) {
      if (attempt >= tries) throw new Error(`${what} did not succeed`, { cause: error })
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

beforeAll(async () => {
  if (!enabled) return
  await docker('network', 'create', names.network)
  await docker('volume', 'create', names.volume)
  await docker(
    ...['run', '--detach', '--rm', '--pull', 'never', '--name', names.database],
    ...['--network', names.network, '--network-alias', 'database', '--tmpfs', '/var/lib/mysql'],
    ...['--env', 'MARIADB_DATABASE=wp', '--env', 'MARIADB_USER=wp'],
    ...['--env', `MARIADB_PASSWORD=${secrets.database}`],
    ...['--env', `MARIADB_ROOT_PASSWORD=${secrets.database}`],
    IMAGES.database,
  )
  await docker(
    ...['run', '--detach', '--rm', '--pull', 'never', '--name', names.wordpress],
    ...['--network', names.network, '--publish', '127.0.0.1::80'],
    ...['--volume', `${names.volume}:${DOCROOT}`],
    ...dbEnv.flatMap((pair) => ['--env', pair]),
    '--env',
    "WORDPRESS_CONFIG_EXTRA=define('WP_ENVIRONMENT_TYPE', 'local'); define('DISABLE_WP_CRON', true); define('WP_HTTP_BLOCK_EXTERNAL', true);",
    IMAGES.wordpress,
  )
  const port = Number(/:(\d+)\s*$/m.exec(await docker('port', names.wordpress, '80/tcp'))?.[1])
  origin = `http://127.0.0.1:${port}`
  await until('wp-config.php', () =>
    docker('exec', names.wordpress, 'test', '-f', `${DOCROOT}/wp-config.php`),
  )
  await until('WordPress install', () =>
    wp(
      'core',
      'install',
      `--url=${origin}`,
      '--title=Магазин',
      '--admin_user=admin',
      `--admin_password=${secrets.admin}`,
      '--admin_email=admin@example.test',
      '--skip-email',
    ),
  )
  await put('wp-content/mu-plugins/raditi-content.php', plugin)
  await wp('option', 'update', 'raditi_content_site_id', siteId)
  pageId = Number(
    (
      await wp(
        'post',
        'create',
        '--post_type=page',
        '--post_status=publish',
        '--post_title=Главная',
        '--post_content=<p>Привет</p>',
        '--porcelain',
      )
    ).trim(),
  )
  applicationPassword = (
    await wp('user', 'application-password', 'create', 'admin', 'raditi', '--porcelain')
  ).trim()

  await docker(
    ...['run', '--detach', '--rm', '--pull', 'never', '--name', names.hosting],
    ...['--network', names.network, '--publish', '127.0.0.1::2222'],
    ...['--volume', `${names.volume}:${DOCROOT}`],
    ...['--env', 'PUID=33', '--env', 'PGID=33', '--env', 'USER_NAME=site'],
    ...['--env', 'PASSWORD_ACCESS=true', '--env', `USER_PASSWORD=${secrets.hosting}`],
    IMAGES.hosting,
  )
  hostingPort = Number(/:(\d+)\s*$/m.exec(await docker('port', names.hosting, '2222/tcp'))?.[1])
  const line = await until('the host key', async () => {
    await docker('exec', names.hosting, 'test', '-s', '/config/sshd.pid')
    return docker('exec', names.hosting, 'cat', '/config/ssh_host_keys/ssh_host_ed25519_key.pub')
  })
  hostKey =
    sshKeyFingerprint(Buffer.from(String(line).trim().split(/\s+/)[1] ?? '', 'base64')) ?? ''
}, 300_000)

afterAll(async () => {
  if (!enabled) return
  for (const container of [names.hosting, names.wordpress, names.database])
    await run('docker', ['rm', '--force', container]).catch(() => {})
  await run('docker', ['volume', 'rm', '--force', names.volume]).catch(() => {})
  await run('docker', ['network', 'rm', names.network]).catch(() => {})
}, 60_000)

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const stateOf = (state: Omit<PublishedContentState, 'stateHash'>): PublishedContentState => ({
  ...state,
  stateHash: sha256(publishedContentHashMaterial(state)),
})

function deployment(options: {
  releaseId: string
  epoch: number
  files: Record<string, { before: string | null; after: string | null }>
  page?: { prior: PublishedContentState; title: string }
}) {
  const transport = createPinnedSiteTransport({
    lookup: async () => [],
    appEnv: 'development',
  })
  const write: DeployManifest['files']['write'] = []
  const remove: DeployManifest['files']['delete'] = []
  const tree: Record<string, string> = {}
  for (const [path, { before, after }] of Object.entries(options.files)) {
    if (after === null) remove.push({ path, before: sha256(before!) })
    else {
      tree[path] = after
      write.push({
        path,
        before: before === null ? null : sha256(before),
        after: sha256(after),
        sizeBytes: Buffer.byteLength(after),
        executable: false,
      })
    }
  }
  let value: Buffer | null = null
  const db: DeployManifest['db'] = []
  if (options.page) {
    const next = stateOf({ ...options.page.prior, title: options.page.title })
    const operation: DbContentUpdate = {
      kind: 'content_update',
      objectRef: options.page.prior.objectRef,
      fields: ['title'],
      beforeHash: options.page.prior.stateHash,
      afterHash: next.stateHash,
      before: { key: 'tasks/t/db/c/before.json', sha256: 'a'.repeat(64), sizeBytes: 10 },
      after: { key: 'tasks/t/db/c/after.json', sha256: 'b'.repeat(64), sizeBytes: 10 },
    }
    value = sealDbOperationValue({ after: next, before: null }, operation, options.releaseId, key)
    db.push({
      operation,
      after: {
        method: 'GET',
        url: 'https://s3.example.test/raditi-backups/value',
        headers: {},
        expiresAt: '2026-10-17T21:00:00.000Z',
      },
    })
  }
  const manifest: DeployManifest = {
    v: 1,
    kind: 'release',
    releaseId: options.releaseId,
    siteId,
    deployAttempt: 1,
    tag: 'v1.1.0',
    installedSha: 'c'.repeat(40),
    approvedSha: 'd'.repeat(40),
    method: 'sftp',
    files: { write, delete: remove },
    db,
    contentEpoch: options.epoch,
    rollbackOf: null,
    addOnlyPaths: [],
    verify: {
      origin,
      failureMarkers: ['There has been a critical error on this website', '<b>Fatal error</b>:'],
      pages: ['/'],
    },
  }
  const access: DeployAccess = {
    v: 1,
    hosting: {
      method: 'sftp',
      access: {
        v: '1',
        host: '127.0.0.1',
        port: String(hostingPort),
        hostKey,
        rootPath: DOCROOT,
        username: 'site',
        auth: 'password',
        password: secrets.hosting,
      },
    },
    content: {
      stack: 'wordpress',
      access: { v: '1', origin, username: 'admin', applicationPassword },
    },
  }
  const api = new FakeReleaseApi(manifest, access)
  const source: TreeSource = {
    async file(path, expected) {
      const text = tree[path]
      if (text === undefined || sha256(text) !== expected.sha256) throw new TreeSourceError()
      return Buffer.from(text)
    },
  }
  const writer = createSftpHostingWriter({ idleMs: 15_000, readyTimeoutMs: 15_000 })
  const context: DeployContext = {
    wrap: {
      releaseId: options.releaseId,
      attempt: 1,
      tag: 'v1.1.0',
      sha: 'd'.repeat(40),
      wrapToken: 'hvs.integration',
    },
    api,
    backupKey: key,
    tree: source,
    async openHosting(hosting, signal) {
      if (hosting.method !== 'sftp') throw new Error('sftp only')
      const pinned = await resolvePinnedAddress(
        { lookup: async () => [], appEnv: 'development' },
        '127.0.0.1',
        signal,
      )
      if (!pinned.ok) throw new Error('loopback refused')
      return writer.open(hosting.access, { address: pinned.address, signal })
    },
    contentGateway(content) {
      const adapter = getSiteContentAdapter(content.stack)
      const contentAccess = adapter.accessSchema.parse(content.access)
      return adapter.createGateway({
        siteId,
        origin: contentAccess.origin,
        access: contentAccess,
        transport,
        allowLoopbackHttp: true,
      })
    },
    download: async () => {
      if (!value) throw new Error('No value')
      return value
    },
    upload: async (_request, body) => {
      api.backup = Buffer.from(body)
    },
    checkSite: (verify) => checkSite(transport, verify, { sleep: async () => {} }),
    log: () => {},
    signal: new AbortController().signal,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  return { api, context }
}

async function page(): Promise<PublishedContentState> {
  const adapter = getSiteContentAdapter('wordpress')
  const gateway = adapter.createGateway({
    siteId,
    origin,
    access: adapter.accessSchema.parse({ v: '1', origin, username: 'admin', applicationPassword }),
    transport: createPinnedSiteTransport({ lookup: async () => [], appEnv: 'development' }),
    allowLoopbackHttp: true,
  })
  return gateway.read(`page:${pageId}`)
}

describe.skipIf(!enabled)('deploy-step against WordPress over SFTP (Р30, Р31)', () => {
  it('installs files and a page title, exactly as approved', async () => {
    await put('wp-content/uploads/raditi-it/a.txt', 'version 1\n')
    await put('wp-content/uploads/raditi-it/c.txt', 'deleted by the release\n')
    const prior = await page()
    const { api, context } = deployment({
      releaseId: '0196abcd-0000-7000-8000-000000000101',
      epoch: 1,
      files: {
        'wp-content/uploads/raditi-it/a.txt': { before: 'version 1\n', after: 'version 2\n' },
        'wp-content/uploads/raditi-it/b.txt': { before: null, after: 'added\n' },
        'wp-content/uploads/raditi-it/c.txt': { before: 'deleted by the release\n', after: null },
      },
      page: { prior, title: 'Добро пожаловать — «Радити» & друзья' },
    })
    expect(await outcomeOf(context)).toBe('installed')
    expect(api.sequence).toEqual([
      'conflicts started',
      'conflicts succeeded',
      'backup started',
      'backup succeeded',
      'files started',
      'files succeeded',
      'db started',
      'db succeeded',
      'verify started',
      'verify succeeded',
    ])
    expect(await fileOf('wp-content/uploads/raditi-it/a.txt')).toBe('version 2\n')
    expect(await fileOf('wp-content/uploads/raditi-it/b.txt')).toBe('added\n')
    expect(await fileOf('wp-content/uploads/raditi-it/c.txt')).toBeNull()
    // Byte for byte: the plugin's mode `release` stores the title as it was sent.
    expect((await page()).title).toBe('Добро пожаловать — «Радити» & друзья')
  }, 120_000)

  it('writes nothing when production is not the installed version', async () => {
    const prior = await page()
    await wp('post', 'update', String(pageId), '--post_title=Правка в админке')
    const { api, context } = deployment({
      releaseId: '0196abcd-0000-7000-8000-000000000102',
      epoch: 2,
      files: { 'wp-content/uploads/raditi-it/d.txt': { before: null, after: 'new\n' } },
      page: { prior, title: 'Не будет записано' },
    })
    expect(await outcomeOf(context)).toBe('failed')
    expect(api.sequence).toEqual(['conflicts started', 'conflicts failed conflict'])
    expect(await fileOf('wp-content/uploads/raditi-it/d.txt')).toBeNull()
    expect((await page()).title).toBe('Правка в админке')
  }, 120_000)

  it('never writes a value the site’s filter would change, even as an administrator', async () => {
    // The administrator of the platform has unfiltered_html, and the preview runs the agent's
    // code: a value it says it stored is written only as the filter of production keeps it.
    const prior = await page()
    const { api, context } = deployment({
      releaseId: '0196abcd-0000-7000-8000-000000000105',
      epoch: 5,
      files: { 'wp-content/uploads/raditi-it/e.txt': { before: null, after: 'e\n' } },
      page: { prior, title: 'Заголовок<script>alert(1)</script>' },
    })
    expect(await outcomeOf(context)).toBe('rolled_back')
    expect(api.sequence.slice(-6)).toEqual([
      'db started',
      'db failed write_failed',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    expect(await fileOf('wp-content/uploads/raditi-it/e.txt')).toBeNull()
    expect(await page()).toEqual(prior)
  }, 180_000)

  it('rolls back a release whose code breaks the site: the file goes, the page stays', async () => {
    const prior = await page()
    const { api, context } = deployment({
      releaseId: '0196abcd-0000-7000-8000-000000000103',
      epoch: 3,
      files: {
        'wp-content/mu-plugins/raditi-it-broken.php': {
          before: null,
          after: '<?php\nraditi_it_function_that_does_not_exist();\n',
        },
      },
      page: { prior, title: 'Сломанный выпуск' },
    })
    expect(await outcomeOf(context)).toBe('rolled_back')
    // The broken code answers every request of WordPress with a fatal error, the plugin's too:
    // the record cannot be written, and after its deadline the write is proved never to have
    // landed only once the rollback has taken the file away and the plugin answers again.
    expect(api.sequence.slice(-6)).toEqual([
      'db started',
      'db failed write_failed',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    expect(await fileOf('wp-content/mu-plugins/raditi-it-broken.php')).toBeNull()
    expect(await page()).toEqual(prior)
  }, 180_000)

  it('rolls back a release the check of the site refuses: the record comes back too', async () => {
    const prior = await page()
    const { api, context } = deployment({
      releaseId: '0196abcd-0000-7000-8000-000000000104',
      epoch: 4,
      files: {
        // A file in folders that do not exist yet: the rollback removes them again.
        'wp-content/uploads/raditi-it-new/sub/note.txt': { before: null, after: 'new\n' },
        // Loaded on every page, it breaks only the front page: the plugin goes on answering.
        'wp-content/mu-plugins/raditi-it-front.php': {
          before: null,
          after:
            "<?php\nadd_action('template_redirect', function () { if (is_front_page()) { status_header(500); echo '<b>Fatal error</b>: front page'; exit; } });\n",
        },
      },
      page: { prior, title: 'Выпуск, который откатят' },
    })
    expect(await outcomeOf(context)).toBe('rolled_back')
    expect(api.sequence.slice(-8)).toEqual([
      'db started',
      'db succeeded',
      'verify started',
      'verify failed site_broken',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    expect(await fileOf('wp-content/mu-plugins/raditi-it-front.php')).toBeNull()
    expect(await folderExists('wp-content/uploads/raditi-it-new')).toBe(false)
    expect(await folderExists('wp-content/uploads')).toBe(true)
    // The inverse write puts the title back byte for byte, under «production holds what we wrote».
    expect(await page()).toEqual(prior)
  }, 180_000)
})
