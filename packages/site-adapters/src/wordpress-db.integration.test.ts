import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import {
  DB_CREATED_ID_BASE,
  isCreatedRef,
  type DbTableState,
  type DbWriteChange,
  type DbWriteOutcome,
  type SiteDbGateway,
  type TableDefinition,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WordpressPublishedContentGateway } from './wordpress-content.ts'
import { raditiContentPhp } from './wordpress-preview-files.ts'

// The plugin «Радити» of version 2 on a real WordPress 7.1.2 over MariaDB 11.4 and MySQL 8.4
// (docs/plan/53-chat-preview-release.md, «Операции БД и миграции»), through the gateway the
// platform uses: settings of the list, records the platform creates and takes out, tables of the
// platform made and extended by the dictionary, the fence. The preview's constant is switched by
// a file of the docroot. Needs Docker and the pulled images below; runs with
// RADITI_PREVIEW_DOCKER_TESTS=1.

const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const run = promisify(execFile)
const WEB_IMAGE = 'wordpress:7.1.2-php8.3-apache'
const CLI_IMAGE = 'wordpress:cli-php8.3'
const servers = [
  {
    name: 'MariaDB 11.4',
    image: 'mariadb:11.4.13',
    env: (password: string) => [
      'MARIADB_DATABASE=synthetic',
      'MARIADB_USER=synthetic',
      `MARIADB_PASSWORD=${password}`,
      `MARIADB_ROOT_PASSWORD=${password}`,
    ],
    client: 'mariadb',
  },
  {
    name: 'MySQL 8.4',
    image: 'mysql:8.4',
    env: (password: string) => [
      'MYSQL_DATABASE=synthetic',
      'MYSQL_USER=synthetic',
      `MYSQL_PASSWORD=${password}`,
      `MYSQL_ROOT_PASSWORD=${password}`,
    ],
    client: 'mysql',
  },
]
const docker = async (...args: string[]) => (await run('docker', args)).stdout

function dockerWithInput(input: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))))
    child.stdin.end(input)
  })
}

const until = async (check: () => Promise<boolean>, what: string, ms = 90_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const bookings: TableDefinition = {
  columns: [
    { name: 'name', type: 'string', length: 120, nullable: false },
    { name: 'starts_at', type: 'datetime', nullable: false, default: { now: true } },
    { name: 'guests', type: 'integer', nullable: false, default: { value: '2' } },
    {
      name: 'price',
      type: 'decimal',
      precision: 10,
      scale: 2,
      nullable: true,
      default: { value: '-1.50' },
    },
    { name: 'paid', type: 'boolean', nullable: false, default: { value: '0' } },
    { name: 'day', type: 'date', nullable: true, default: { value: '2026-10-18' } },
    { name: 'city', type: 'string', length: 40, nullable: true, default: { value: 'Тверь' } },
    { name: 'ref', type: 'unsigned_big_integer', nullable: true },
    { name: 'note', type: 'text', nullable: true },
  ],
  indexes: [
    { name: 'by_name', columns: ['name'], unique: true },
    { name: 'starts', columns: ['starts_at', 'guests'], unique: false },
  ],
}
const extended: TableDefinition = {
  columns: [
    ...bookings.columns,
    { name: 'phone', type: 'string', length: 32, nullable: true },
    { name: 'seats', type: 'big_integer', nullable: false, default: { value: '-7' } },
  ],
  // By name, as a definition keeps them.
  indexes: [
    bookings.indexes[0]!,
    { name: 'by_phone', columns: ['phone'], unique: false },
    bookings.indexes[1]!,
  ],
}

describe.skipIf(!enabled).each(servers)('the plugin of version 2 on $name', (server) => {
  const suffix = randomBytes(4).toString('hex')
  const names = {
    network: `raditi-a1-net-${suffix}`,
    volume: `raditi-a1-docroot-${suffix}`,
    db: `raditi-a1-db-${suffix}`,
    web: `raditi-a1-web-${suffix}`,
  }
  const password = randomBytes(18).toString('hex')
  const siteId = randomUUID()
  const wordpressEnv = [
    `WORDPRESS_DB_HOST=${names.db}`,
    'WORDPRESS_DB_USER=synthetic',
    `WORDPRESS_DB_PASSWORD=${password}`,
    'WORDPRESS_DB_NAME=synthetic',
    'WORDPRESS_TABLE_PREFIX=shop_',
    "WORDPRESS_CONFIG_EXTRA=define('WP_ENVIRONMENT_TYPE', 'local'); if (file_exists(__DIR__ . '/.raditi-preview')) { define('RADITI_PREVIEW_ORIGIN', 'http://preview.invalid'); }",
  ]
  let db: SiteDbGateway
  let held: ChildProcess | undefined

  const wp = (...args: string[]) =>
    docker(
      'run',
      '--rm',
      '--network',
      names.network,
      '--user',
      '33:33',
      '--volume',
      `${names.volume}:/var/www/html`,
      ...wordpressEnv.flatMap((value) => ['--env', value]),
      CLI_IMAGE,
      'wp',
      ...args,
    )
  const sql = (statement: string) =>
    docker(
      'exec',
      names.db,
      server.client,
      '-usynthetic',
      `-p${password}`,
      '-N',
      '-B',
      'synthetic',
      '-e',
      statement,
    )
  const preview = (on: boolean) =>
    docker('exec', names.web, on ? 'touch' : 'rm', '-f', '/var/www/html/.raditi-preview')

  let epoch = 1
  const write = (objectRef: string, expectedStateHash: string, change: DbWriteChange, extra = {}) =>
    db.writeObject({
      callId: randomUUID(),
      siteId,
      epoch,
      requestHash: randomBytes(32).toString('hex'),
      objectRef,
      expectedStateHash,
      deadlineAt: Date.now() + 60_000,
      ttlMs: 60_000,
      mode: 'edit',
      change,
      ...extra,
    })
  const committed = (outcome: DbWriteOutcome) => {
    if (outcome.kind !== 'committed') throw new Error(`refused: ${JSON.stringify(outcome)}`)
    return outcome
  }

  beforeAll(async () => {
    await docker('network', 'create', names.network)
    await docker('volume', 'create', names.volume)
    await docker(
      'run',
      '-d',
      '--name',
      names.db,
      '--network',
      names.network,
      ...server.env(password).flatMap((value) => ['--env', value]),
      server.image,
    )
    await until(
      async () => (await sql('SELECT 1')).trim() === '1',
      `${server.name} to take connections`,
    )
    await docker(
      'run',
      '-d',
      '--name',
      names.web,
      '--network',
      names.network,
      '-p',
      '127.0.0.1::80',
      '--volume',
      `${names.volume}:/var/www/html`,
      ...wordpressEnv.flatMap((value) => ['--env', value]),
      WEB_IMAGE,
    )
    const port = (await docker('port', names.web, '80/tcp')).split('\n')[0]!.trim()
    const origin = `http://${port}`
    await until(
      async () =>
        (await docker('exec', names.web, 'test', '-f', '/var/www/html/wp-config.php')) === '',
      'WordPress files',
    )
    await wp(
      'core',
      'install',
      `--url=${origin}`,
      '--title=Цветы у дома',
      '--admin_user=synthetic_admin',
      `--admin_password=${password}`,
      '--admin_email=admin@example.test',
      '--skip-email',
    )
    await docker('exec', names.web, 'mkdir', '-p', '/var/www/html/wp-content/mu-plugins')
    await dockerWithInput(
      raditiContentPhp,
      'exec',
      '-i',
      names.web,
      'sh',
      '-c',
      'cat > /var/www/html/wp-content/mu-plugins/raditi-content.php',
    )
    await wp('option', 'update', 'raditi_content_site_id', siteId)
    const applicationPassword = (
      await wp('user', 'application-password', 'create', 'synthetic_admin', 'raditi', '--porcelain')
    ).trim()
    await preview(true)
    db = new WordpressPublishedContentGateway({
      origin,
      siteId,
      username: 'synthetic_admin',
      applicationPassword,
      allowLoopbackHttp: true,
    }).db
  }, 240_000)

  afterAll(async () => {
    held?.kill()
    for (const name of [names.web, names.db])
      await docker('rm', '-f', '-v', name).catch(() => undefined)
    await docker('volume', 'rm', '-f', names.volume).catch(() => undefined)
    await docker('network', 'rm', names.network).catch(() => undefined)
  }, 60_000)

  it('says what it can write here: every kind, the list of settings, the next created id', async () => {
    const capabilities = await db.capabilities()
    expect(capabilities).toMatchObject({
      plugin: 2,
      operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
      settings: [
        'blogname',
        'blogdescription',
        'date_format',
        'time_format',
        'start_of_week',
        'posts_per_page',
      ],
    })
    expect(capabilities.maxRecordId).toBeGreaterThan(0)
    expect(capabilities.nextCreatedId).toBe(DB_CREATED_ID_BASE)
  })

  it('writes a setting of the list in each mode, its integers too, and nothing else', async () => {
    const before = await db.readObject('option:blogname')
    expect(before).toMatchObject({ value: 'Цветы у дома' })
    // `edit` stores what the filter of WordPress makes of the value.
    const edited = committed(
      await write('option:blogname', before.stateHash, {
        kind: 'option_update',
        value: 'Цветы & Co "у дома"',
      }),
    )
    const after = await db.readObject('option:blogname')
    expect(after).toMatchObject({ value: 'Цветы &amp; Co &quot;у дома&quot;' })
    expect(edited.stateHash).toBe(after.stateHash)
    // `release` takes only bytes the filter keeps: these do, the agent's raw ones do not.
    expect(
      await write(
        'option:blogname',
        after.stateHash,
        { kind: 'option_update', value: 'Цветы & Co' },
        { mode: 'release' },
      ),
    ).toMatchObject({ kind: 'rejected', code: 'invalid', reason: 'markup' })
    const perPage = await db.readObject('option:posts_per_page')
    committed(
      await write(
        'option:posts_per_page',
        perPage.stateHash,
        { kind: 'option_update', value: '12' },
        { mode: 'release' },
      ),
    )
    expect(await db.readObject('option:posts_per_page')).toMatchObject({ value: '12' })
    expect(
      await write('option:posts_per_page', perPage.stateHash, {
        kind: 'option_update',
        value: '11',
      }),
    ).toMatchObject({ kind: 'rejected', code: 'conflict' })
    // `restore` puts back the exact bytes the site held.
    committed(
      await write(
        'option:blogname',
        after.stateHash,
        { kind: 'option_update', value: 'Цветы у дома' },
        { mode: 'restore' },
      ),
    )
    expect((await db.readObject('option:blogname')).stateHash).toBe(before.stateHash)
    await expect(db.readObject('option:siteurl')).rejects.toMatchObject({
      code: 'CONTENT_OBJECT_UNAVAILABLE',
    })
    expect(
      await sql("SELECT option_value FROM shop_options WHERE option_name = 'siteurl'"),
    ).toMatch(/^http:\/\/127\.0\.0\.1:/)
  })

  it('gives a record its own id on production and never stores one under a plan’s id there', async () => {
    await preview(false)
    try {
      const ref = `page:${DB_CREATED_ID_BASE + 5}`
      const absent = await db.readObject(ref)
      const record = {
        status: 'publish' as const,
        slug: 'team',
        title: 'Команда',
        content: '',
        excerpt: '',
      }
      expect(
        await write(ref, absent.stateHash, {
          kind: 'post_create',
          record,
          createCallId: randomUUID(),
        }),
      ).toMatchObject({ kind: 'rejected', code: 'invalid' })
      const created = committed(
        await write(
          ref,
          absent.stateHash,
          { kind: 'post_create', record, createCallId: randomUUID() },
          { mode: 'release' },
        ),
      )
      expect(created.objectRef).toBe(ref)
      expect(isCreatedRef(created.createdRef!)).toBe(false)
      expect(await db.readObject(created.createdRef!)).toMatchObject({
        status: 'publish',
        slug: 'team',
        stateHash: created.stateHash,
      })
      expect((await db.capabilities()).nextCreatedId).toBeUndefined()
    } finally {
      await preview(true)
    }
  })

  it('takes a record of the platform out only without what stands on it, and brings it back', async () => {
    // «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): on production, under its own id — before
    // a record of a preview takes the base of the ids (the next test).
    await preview(false)
    try {
      const ref = `page:${DB_CREATED_ID_BASE + 7}`
      const createCallId = randomUUID()
      const record = {
        status: 'publish' as const,
        slug: 'delivery',
        title: 'Доставка',
        content: '<p>Привезём за час</p>',
        excerpt: '',
      }
      const created = committed(
        await write(
          ref,
          (await db.readObject(ref)).stateHash,
          { kind: 'post_create', record, createCallId },
          { mode: 'release' },
        ),
      )
      const own = created.createdRef!
      const id = Number(own.split(':')[1])
      expect(await db.dependents(own)).toBe(0)
      // A comment of a visitor, held for moderation: the trash would take it along.
      await wp(
        'comment',
        'create',
        `--comment_post_ID=${id}`,
        '--comment_content=Спасибо',
        '--comment_approved=0',
      )
      expect(await db.dependents(own)).toBe(1)
      expect(
        await write(
          own,
          created.stateHash,
          { kind: 'post_trash', expectedSlug: 'delivery', createCallId },
          { mode: 'restore' },
        ),
      ).toMatchObject({ kind: 'rejected', code: 'conflict', reason: 'dependents' })
      await sql(`DELETE FROM shop_comments WHERE comment_post_ID = ${id}`)
      const trashed = committed(
        await write(
          own,
          created.stateHash,
          { kind: 'post_trash', expectedSlug: 'delivery', createCallId },
          { mode: 'restore' },
        ),
      )
      expect(await db.readObject(own)).toMatchObject({ absent: true })
      // Back from the trash: only in `restore`, only of its mark, at its address.
      const untrash = { kind: 'post_untrash' as const, expectedSlug: 'delivery', createCallId }
      expect(await write(own, trashed.stateHash, untrash, { mode: 'release' })).toMatchObject({
        kind: 'rejected',
        code: 'invalid',
      })
      expect(
        await write(
          own,
          trashed.stateHash,
          { ...untrash, createCallId: randomUUID() },
          { mode: 'restore' },
        ),
      ).toMatchObject({ kind: 'rejected', code: 'conflict' })
      const back = committed(await write(own, trashed.stateHash, untrash, { mode: 'restore' }))
      expect(back.stateHash).toBe(created.stateHash)
      expect(await db.readObject(own)).toMatchObject({
        status: 'publish',
        slug: 'delivery',
        stateHash: created.stateHash,
      })
      expect(await sql(`SELECT post_status, post_name FROM shop_posts WHERE ID = ${id}`)).toBe(
        'publish\tdelivery\n',
      )
      expect(
        await sql(
          `SELECT COUNT(*) FROM shop_postmeta WHERE post_id = ${id} AND meta_key LIKE '_wp_%'`,
        ),
      ).toBe('0\n')
    } finally {
      await preview(true)
    }
  })

  it('creates a record under the id of a plan in a preview, and takes it out by its mark', async () => {
    const ref = `page:${DB_CREATED_ID_BASE}`
    const absent = await db.readObject(ref)
    expect(absent).toMatchObject({ absent: true })
    expect(await db.slugTaken('page', 'prices')).toBe(false)
    const createCallId = randomUUID()
    const record = {
      status: 'draft' as const,
      slug: 'prices',
      title: 'Цены',
      content: '<p>Букеты от 1 500 ₽</p>',
      excerpt: '',
    }
    const created = committed(
      await write(ref, absent.stateHash, { kind: 'post_create', record, createCallId }),
    )
    expect(created.createdRef).toBe(ref)
    const state = await db.readObject(ref)
    expect(state).toMatchObject({ status: 'draft', slug: 'prices', title: 'Цены' })
    expect(created.stateHash).toBe(state.stateHash)
    expect(await db.slugTaken('page', 'prices')).toBe(true)
    // The id is taken, the address too.
    expect(
      await write(ref, absent.stateHash, { kind: 'post_create', record, createCallId }),
    ).toMatchObject({ kind: 'rejected', code: 'conflict' })
    expect(
      await write(
        `page:${DB_CREATED_ID_BASE + 1}`,
        (await db.readObject(`page:${DB_CREATED_ID_BASE + 1}`)).stateHash,
        {
          kind: 'post_create',
          record,
          createCallId,
        },
      ),
    ).toMatchObject({ kind: 'rejected', code: 'invalid', reason: 'slug' })
    expect(
      await write(
        ref,
        state.stateHash,
        { kind: 'post_trash', expectedSlug: 'other', createCallId },
        { mode: 'restore' },
      ),
    ).toMatchObject({ kind: 'rejected', code: 'conflict' })
    const trashed = committed(
      await write(
        ref,
        state.stateHash,
        { kind: 'post_trash', expectedSlug: 'prices', createCallId },
        { mode: 'restore' },
      ),
    )
    expect(trashed.stateHash).toBe(absent.stateHash)
    expect(await db.readObject(ref)).toEqual(absent)
    expect(
      await sql(`SELECT post_status, post_name FROM shop_posts WHERE ID = ${DB_CREATED_ID_BASE}`),
    ).toBe('trash\tprices__trashed\n')
    expect(await db.slugTaken('page', 'prices')).toBe(false)
    expect((await db.capabilities()).nextCreatedId).toBe(DB_CREATED_ID_BASE + 1)
  })

  it('makes and extends a table of the platform by the dictionary, and reads it back the same', async () => {
    const ref = 'table:bookings'
    const absent = (await db.readObject(ref)) as DbTableState
    expect(absent).toMatchObject({ exists: false, managed: false, definition: null })
    const created = committed(
      await write(ref, absent.stateHash, {
        kind: 'schema_migration',
        before: { exists: false, managed: false, definition: null },
        definition: bookings,
      }),
    )
    const table = (await db.readObject(ref)) as DbTableState
    expect(table).toMatchObject({ exists: true, managed: true, definition: bookings })
    expect(created.stateHash).toBe(table.stateHash)
    expect(
      await sql(
        "SELECT TABLE_COMMENT, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shop_raditi_bookings'",
      ),
    ).toBe('raditi-managed\tInnoDB\n')
    // Columns and an index at once are two statements; a call finds where an earlier one left
    // the table — here after the first, made by hand — and goes on from there.
    await sql(
      "ALTER TABLE shop_raditi_bookings ADD COLUMN `phone` VARCHAR(32) NULL, ADD COLUMN `seats` BIGINT NOT NULL DEFAULT '-7', ALGORITHM=INSTANT",
    )
    const grown = committed(
      await write(ref, table.stateHash, {
        kind: 'schema_migration',
        before: { exists: true, managed: true, definition: bookings },
        definition: extended,
      }),
    )
    expect(await db.readObject(ref)).toMatchObject({
      definition: extended,
      stateHash: grown.stateHash,
    })
    // Anything but an addition is refused on production; a preview takes the platform's own back.
    await preview(false)
    try {
      expect(
        await write(ref, grown.stateHash, {
          kind: 'schema_migration',
          before: { exists: true, managed: true, definition: extended },
          definition: bookings,
        }),
      ).toMatchObject({ kind: 'rejected', code: 'invalid', reason: 'unsupported' })
      expect(
        await write(ref, grown.stateHash, {
          kind: 'schema_migration',
          before: { exists: true, managed: true, definition: extended },
          definition: {
            ...extended,
            indexes: [...extended.indexes, { name: 'zz', columns: ['phone'], unique: true }],
          },
        }),
      ).toMatchObject({ kind: 'rejected', code: 'invalid', reason: 'unsupported' })
    } finally {
      await preview(true)
    }
    committed(
      await write(
        ref,
        grown.stateHash,
        {
          kind: 'schema_migration',
          before: { exists: true, managed: true, definition: extended },
          definition: bookings,
        },
        { mode: 'restore' },
      ),
    )
    expect((await db.readObject(ref)).stateHash).toBe(table.stateHash)
  })

  it('does not hold the site behind a table someone holds: it gives up in seconds', async () => {
    const ref = 'table:bookings'
    const table = (await db.readObject(ref)) as DbTableState
    held = spawn(
      'docker',
      [
        'exec',
        names.db,
        server.client,
        '-usynthetic',
        `-p${password}`,
        'synthetic',
        '-e',
        'BEGIN; SELECT COUNT(*) FROM shop_raditi_bookings; SELECT SLEEP(40);',
      ],
      { stdio: 'ignore' },
    )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const started = Date.now()
    const migration = write(ref, table.stateHash, {
      kind: 'schema_migration',
      before: { exists: true, managed: true, definition: bookings },
      definition: extended,
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // A visitor of the site waits behind the statement no longer than its 5 seconds.
    const visitor = Date.now()
    expect(await sql('SELECT COUNT(*) FROM shop_raditi_bookings')).toBe('0\n')
    expect(Date.now() - visitor).toBeLessThan(10_000)
    expect(await migration).toMatchObject({ kind: 'rejected', code: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(20_000)
    held.kill()
    held = undefined
    expect((await db.readObject(ref)).stateHash).toBe(table.stateHash)
  }, 60_000)

  it('moves the fence: a write of an earlier epoch can no longer land', async () => {
    const before = await db.readObject('option:blogdescription')
    await db.fence({ siteId, epoch: 50 })
    expect(
      await write('option:blogdescription', before.stateHash, {
        kind: 'option_update',
        value: 'Поздно',
      }),
    ).toMatchObject({ kind: 'rejected', code: 'fenced' })
    epoch = 50
    committed(
      await write('option:blogdescription', before.stateHash, {
        kind: 'option_update',
        value: 'Доставка за час',
      }),
    )
  })
})
