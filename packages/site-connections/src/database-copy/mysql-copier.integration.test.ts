import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

import type { DatabaseCopyPolicy, DbAccess } from '@repo/domain'
import { DatabaseCopyError, SiteConnectionError } from '@repo/domain'
import { createConnection, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMysqlDatabaseCopier } from './mysql-copier.ts'

// The copier against two disposable MariaDB 11.4.13 servers: the source holds a WordPress-like
// site with what a preview must never get, the seed is loaded into the second one. Needs Docker
// and the image `mariadb:11.4.13` already pulled; runs with RADITI_PREVIEW_DOCKER_TESTS=1.

const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const run = promisify(execFile)
const IMAGE = 'mariadb:11.4.13'
const previewId = '0196abcd-0000-7000-8000-00000000000a'
const receipt = '0196abcd-0000-7000-8000-0000000000cc'
/** The policy of @repo/site-adapters for WordPress; its own test keeps the file equal to it. */
const wordpressPolicy = JSON.parse(
  readFileSync(new URL('./wordpress-policy.fixture.json', import.meta.url), 'utf8'),
) as DatabaseCopyPolicy

interface Server {
  container: string
  port: number
  password: string
}

const suffix = randomBytes(4).toString('hex')
const servers: Server[] = []

async function startServer(role: string): Promise<Server> {
  const password = randomBytes(18).toString('base64url')
  const container = `raditi-r5b-${role}-${suffix}`
  await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--publish',
    '127.0.0.1::3306',
    '--tmpfs',
    '/var/lib/mysql',
    '--env',
    `MARIADB_ROOT_PASSWORD=${password}`,
    '--env',
    'MARIADB_DATABASE=shop',
    '--env',
    'MARIADB_USER=shop',
    '--env',
    `MARIADB_PASSWORD=${password}`,
    IMAGE,
  ])
  const server = { container, port: 0, password }
  servers.push(server)
  const { stdout } = await run('docker', ['port', container, '3306/tcp'])
  server.port = Number(/:(\d+)\s*$/m.exec(stdout)?.[1])
  // The entrypoint first runs a server without networking: TCP answers only the final one.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const connection = await connectTo(server)
      await connection.end()
      return server
    } catch (error) {
      if (attempt > 120) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

const connectTo = (server: Server) =>
  createConnection({
    host: '127.0.0.1',
    port: server.port,
    user: 'shop',
    password: server.password,
    database: 'shop',
    charset: 'UTF8MB4_UNICODE_CI',
    multipleStatements: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  })

/** SQL into the server as root, through its own client, as an operator would load a seed. */
function load(server: Server, sql: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = spawn(
      'docker',
      ['exec', '-i', server.container, 'mariadb', '-uroot', `-p${server.password}`, 'shop'],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    let stderr = ''
    client.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    client.on('error', reject)
    client.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`mariadb exited ${code}: ${stderr}`)),
    )
    client.stdin.end(sql)
  })
}

const access = (server: Server, overrides: Partial<DbAccess> = {}): DbAccess => ({
  v: '1',
  engine: 'mysql',
  host: '127.0.0.1',
  port: String(server.port),
  tls: 'unverified',
  database: 'shop',
  username: 'shop',
  password: server.password,
  ...overrides,
})

const copier = createMysqlDatabaseCopier({
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  appEnv: 'test',
})

async function copy(server: Server, policy: DatabaseCopyPolicy, overrides?: Partial<DbAccess>) {
  const chunks: Uint8Array[] = []
  const summary = await copier.copy(
    {
      access: access(server, overrides),
      tablePrefix: 'wp_',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      policy,
    },
    async (chunk) => {
      chunks.push(chunk)
    },
  )
  return { summary, seed: Buffer.concat(chunks) }
}

const content = `<!-- wp:paragraph --><p>Цены «от 990 ₽» 🙂👍🏽 — 'кавычки', "двойные", \\слеш\\, \\n не перевод,\nперевод строки и табуляция\t; NUL: \0 конец.</p><!-- /wp:paragraph -->`

/** A WordPress site as it lies on a hosting, with what a preview must never get. */
const fixture = `
SET SESSION sql_mode = '';
CREATE TABLE wp_users (
  ID bigint(20) unsigned NOT NULL auto_increment,
  user_login varchar(60) NOT NULL default '',
  user_pass varchar(255) NOT NULL default '',
  user_nicename varchar(50) NOT NULL default '',
  user_email varchar(100) NOT NULL default '',
  user_url varchar(100) NOT NULL default '',
  user_registered datetime NOT NULL default '0000-00-00 00:00:00',
  user_activation_key varchar(255) NOT NULL default '',
  user_status int(11) NOT NULL default '0',
  display_name varchar(250) NOT NULL default '',
  PRIMARY KEY (ID), KEY user_email (user_email)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_usermeta (
  umeta_id bigint(20) unsigned NOT NULL auto_increment,
  user_id bigint(20) unsigned NOT NULL default '0',
  meta_key varchar(255) default NULL,
  meta_value longtext,
  PRIMARY KEY (umeta_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_posts (
  ID bigint(20) unsigned NOT NULL auto_increment,
  post_author bigint(20) unsigned NOT NULL default '0',
  post_date datetime NOT NULL default '0000-00-00 00:00:00',
  post_date_gmt datetime NOT NULL default '0000-00-00 00:00:00',
  post_content longtext NOT NULL,
  post_title text NOT NULL,
  post_excerpt text NOT NULL,
  post_status varchar(20) NOT NULL default 'publish',
  post_password varchar(255) NOT NULL default '',
  post_name varchar(200) NOT NULL default '',
  post_parent bigint(20) unsigned NOT NULL default '0',
  guid varchar(255) NOT NULL default '',
  post_type varchar(20) NOT NULL default 'post',
  PRIMARY KEY (ID), KEY type_status_date (post_type, post_status, post_date, ID)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_postmeta (
  meta_id bigint(20) unsigned NOT NULL auto_increment,
  post_id bigint(20) unsigned NOT NULL default '0',
  meta_key varchar(255) default NULL,
  meta_value longtext,
  PRIMARY KEY (meta_id), KEY post_id (post_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_comments (
  comment_ID bigint(20) unsigned NOT NULL auto_increment,
  comment_post_ID bigint(20) unsigned NOT NULL default '0',
  comment_author tinytext NOT NULL,
  comment_author_email varchar(100) NOT NULL default '',
  comment_author_IP varchar(100) NOT NULL default '',
  comment_content text NOT NULL,
  PRIMARY KEY (comment_ID)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_terms (
  term_id bigint(20) unsigned NOT NULL auto_increment,
  name varchar(200) NOT NULL default '',
  slug varchar(200) NOT NULL default '',
  term_group bigint(10) NOT NULL default 0,
  PRIMARY KEY (term_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_term_taxonomy (
  term_taxonomy_id bigint(20) unsigned NOT NULL auto_increment,
  term_id bigint(20) unsigned NOT NULL default 0,
  taxonomy varchar(32) NOT NULL default '',
  description longtext NOT NULL,
  parent bigint(20) unsigned NOT NULL default 0,
  count bigint(20) NOT NULL default 0,
  PRIMARY KEY (term_taxonomy_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_term_relationships (
  object_id bigint(20) unsigned NOT NULL default 0,
  term_taxonomy_id bigint(20) unsigned NOT NULL default 0,
  term_order int(11) NOT NULL default 0,
  PRIMARY KEY (object_id, term_taxonomy_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_termmeta (
  meta_id bigint(20) unsigned NOT NULL auto_increment,
  term_id bigint(20) unsigned NOT NULL default '0',
  meta_key varchar(255) default NULL,
  meta_value longtext,
  PRIMARY KEY (meta_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_options (
  option_id bigint(20) unsigned NOT NULL auto_increment,
  option_name varchar(191) NOT NULL default '',
  option_value longtext NOT NULL,
  autoload varchar(20) NOT NULL default 'yes',
  PRIMARY KEY (option_id), UNIQUE KEY option_name (option_name)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE wp_woocommerce_order_items (
  order_item_id bigint(20) unsigned NOT NULL auto_increment,
  order_item_name text NOT NULL,
  order_id bigint(20) unsigned NOT NULL,
  PRIMARY KEY (order_item_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE TABLE other_secrets (id int PRIMARY KEY, value text);

INSERT INTO wp_users (ID, user_login, user_pass, user_nicename, user_email, user_url, user_activation_key, display_name) VALUES
  (1, 'owner', '$wp$2y$10$ownerhash', 'owner', 'owner@example.com', 'https://owner.example.com', 'owner-activation', 'Анна Владелец'),
  (2, 'buyer', '$wp$2y$10$buyerhash', 'buyer', 'buyer@example.com', '', '', 'Борис Покупатель'),
  (3, 'another', '$wp$2y$10$anotherhash', 'another', 'another@example.com', '', '', 'Вера');
INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES
  (1, 'session_tokens', 'a:1:{s:5:"token-of-owner";}'),
  (1, 'billing_phone', '+7 900 000-00-01');
INSERT INTO wp_posts (ID, post_author, post_date, post_content, post_title, post_excerpt, post_status, post_password, post_type) VALUES
  (10, 1, '2026-10-01 10:00:00', ?, 'Главная 🏠', '', 'publish', '', 'page'),
  (11, 1, '2026-10-01 11:00:00', 'Скрытая запись', 'Закрыто', 'Отрывок', 'publish', 'post-password-secret', 'post'),
  (12, 1, '2026-10-02 11:00:00', 'Черновик', 'Черновик', '', 'draft', '', 'post'),
  (13, 1, '2026-10-02 12:00:00', '', 'photo.jpg', '', 'inherit', '', 'attachment'),
  (14, 1, '2026-10-02 13:00:00', '', 'Меню', '', 'publish', '', 'nav_menu_item'),
  (15, 1, '2026-10-02 14:00:00', '{"version":3}', 'Стили', '', 'publish', '', 'wp_global_styles'),
  (16, 1, '2026-10-02 15:00:00', 'В корзине', 'Удалено', '', 'trash', '', 'post'),
  (17, 1, '2026-10-02 16:00:00', 'Правка', 'Ревизия', '', 'inherit', '', 'revision'),
  (18, 1, '2026-10-02 17:00:00', '.site-title { color: #c00; }', 'twentytwentyfive', '', 'publish', '', 'custom_css'),
  (19, 1, '2026-10-02 18:00:00', '', 'Kit по умолчанию', '', 'publish', '', 'elementor_library'),
  (20, 2, '2026-10-03 10:00:00', 'Заказ buyer@example.com, +7 900 000-00-02', 'Заказ', '', 'publish', '', 'shop_order'),
  (21, 3, '2026-10-03 11:00:00', 'Заявка another@example.com', 'Заявка', '', 'publish', '', 'nf_sub'),
  (22, 3, '2026-10-03 12:00:00', 'Платёж another@example.com', 'Платёж', '', 'publish', '', 'edd_payment'),
  (23, 3, '2026-10-03 13:00:00', 'Отзыв another@example.com', 'Отзыв', '', 'publish', '', 'feedback'),
  (24, 3, '2026-10-03 14:00:00', 'Удалить мои данные another@example.com', 'Запрос', '', 'request-pending', '', 'user_request');
INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES
  (10, '_thumbnail_id', '13'),
  (10, '_wp_page_template', 'default'),
  (10, '_stripe_secret_key', 'sk_live_stripe-secret'),
  (10, 'api_token', 'token-of-a-plugin'),
  (13, '_wp_attached_file', '2026/10/photo.jpg'),
  (19, '_elementor_template_type', 'kit'),
  (10, '_elementor_data', '[{"settings":{"form_name":"Заявка","mailchimp_api_key":"mc-secret"}}]'),
  (20, '_billing_email', 'buyer@example.com'),
  (20, '_billing_phone', '+7 900 000-00-02');
INSERT INTO wp_comments (comment_post_ID, comment_author, comment_author_email, comment_author_IP, comment_content) VALUES
  (10, 'Гость', 'visitor@example.com', '203.0.113.7', 'Отличный сайт');
INSERT INTO wp_terms (term_id, name, slug) VALUES (1, 'Новости', 'news'), (2, 'Заказы', 'orders'), (3, 'Гюльнара Автор', 'cap-gulnara');
INSERT INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description) VALUES
  (1, 1, 'category', ''),
  (2, 2, 'shop_order_status', ''),
  (3, 3, 'author', 'Гюльнара Автор gulnara 7 coauthor@example.com');
INSERT INTO wp_term_relationships (object_id, term_taxonomy_id) VALUES (11, 1), (20, 2), (11, 3);
INSERT INTO wp_termmeta (term_id, meta_key, meta_value) VALUES
  (1, 'color', 'синий'),
  (1, 'license_key', 'term-license-secret'),
  (3, 'user_email', 'author-meta@example.com'),
  (3, 'first_name', 'Гюльнара');
INSERT INTO wp_options (option_name, option_value, autoload) VALUES
  ('siteurl', 'https://shop.example.ru', 'yes'),
  ('home', 'https://shop.example.ru', 'yes'),
  ('blogname', 'Магазин «Ромашка»', 'yes'),
  ('blog_public', '1', 'yes'),
  ('admin_email', 'owner@example.com', 'yes'),
  ('active_plugins', 'a:1:{i:0;s:27:"woocommerce/woocommerce.php";}', 'yes'),
  ('elementor_active_kit', '19', 'yes'),
  ('elementor_connect_common_data', 'a:1:{s:12:"access_token";s:15:"elementor-token";}', 'no'),
  ('wp_user_roles', 'a:1:{s:13:"administrator";}', 'yes'),
  ('theme_mods_twentytwentyfive', 'a:0:{}', 'yes'),
  ('widget_block', 'a:0:{}', 'yes'),
  ('widget_text', 'a:1:{i:2;a:2:{s:5:"title";s:12:"Привет";s:7:"api_key";s:13:"widget-secret";}}', 'yes'),
  ('cron', 'a:1:{s:10:"cron-event";}', 'yes'),
  ('_transient_doing_cron', '1760000000', 'yes'),
  ('wp_mail_smtp', 'a:1:{s:4:"pass";s:11:"smtp-secret";}', 'yes'),
  ('wpforms_settings', 'a:1:{s:3:"key";s:14:"wpforms-secret";}', 'yes'),
  ('auth_salt', 'salt-of-the-site', 'yes'),
  ('raditi_content_site_id', 'prod-site-binding', 'yes'),
  ('raditi_content_epoch', '7', 'no'),
  ('raditi_content_call_${receipt}', 'receipt-of-production', 'no');
INSERT INTO wp_woocommerce_order_items (order_item_name, order_id) VALUES ('Футболка для buyer@example.com', 20);
INSERT INTO other_secrets VALUES (1, 'secret-of-another-application');
`

/** Every kind of value a column can hold, for a byte-exact round trip; more rows than a page. */
const types = `
SET SESSION sql_mode = '';
CREATE TABLE wp_raditi_types (
  id bigint unsigned NOT NULL,
  b varbinary(64) NULL,
  bl blob NULL,
  bits bit(8) NULL,
  d decimal(20,6) NULL,
  big bigint unsigned NULL,
  f double NULL,
  dt datetime NULL,
  ts timestamp NULL DEFAULT NULL,
  t text CHARACTER SET utf8mb4 NULL,
  j json NULL,
  e enum('a','б') CHARACTER SET utf8mb4 NULL,
  gen bigint AS (id * 2) VIRTUAL,
  PRIMARY KEY (id)
) DEFAULT CHARACTER SET latin1;
INSERT INTO wp_raditi_types (id, b, bl, bits, d, big, f, dt, ts, t, j, e) VALUES
  (1, X'00FF275C0A0D1A22', X'', b'10100101', -12345678901234.123456, 18446744073709551615, 0.1, '0000-00-00 00:00:00', '2026-10-17 12:34:56', '🙂 \\' " \\\\ \\0', '{"a": [1, "б"]}', 'б'),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO wp_raditi_types (id, b, t, f) SELECT seq + 2, UNHEX(SHA2(seq, 256)), CONCAT('строка ', seq), seq / 7 FROM seq_1_to_1200;
`

describe.skipIf(!enabled)('the MySQL copier against MariaDB', () => {
  let source: Server
  let target: Server

  beforeAll(async () => {
    ;[source, target] = await Promise.all([startServer('source'), startServer('target')])
    const connection = await connectTo(source)
    try {
      await connection.query(fixture.replace('?', connection.escape(content)))
      await connection.query(types)
    } finally {
      await connection.end()
    }
  }, 180_000)

  afterAll(async () => {
    await Promise.all(
      servers.map((server) => run('docker', ['rm', '--force', server.container]).catch(() => {})),
    )
  }, 60_000)

  it('writes a seed without a row the policy does not name', async () => {
    const { summary, seed } = await copy(source, wordpressPolicy)
    const text = seed.toString('utf8')
    for (const secret of [
      'owner@example.com',
      'buyer@example.com',
      'another@example.com',
      'visitor@example.com',
      '203.0.113.7',
      'token-of-owner',
      '+7 900',
      'owner-activation',
      'ownerhash',
      'post-password-secret',
      'sk_live_stripe-secret',
      'token-of-a-plugin',
      'term-license-secret',
      'cron-event',
      'doing_cron',
      'smtp-secret',
      'wpforms-secret',
      'salt-of-the-site',
      'prod-site-binding',
      receipt,
      'receipt-of-production',
      'Футболка',
      'Борис',
      'Анна',
      // An author of Co-Authors Plus or PublishPress Authors: a person in the terms.
      'coauthor@example.com',
      'author-meta@example.com',
      'Гюльнара',
      "'author'",
      'elementor-token',
      "'shop_order'",
      "'nf_sub'",
      "'edd_payment'",
      "'user_request'",
      "'feedback'",
      'В корзине',
      'Ревизия',
      'other_secrets',
      'secret-of-another-application',
      'AUTO_INCREMENT=',
    ])
      expect(text, secret).not.toContain(secret)
    // People, comments, orders: structure only.
    for (const table of ['wp_usermeta', 'wp_comments', 'wp_woocommerce_order_items']) {
      expect(text).toContain(`CREATE TABLE \`${table}\``)
      expect(text).not.toContain(`INSERT INTO \`${table}\``)
    }
    expect(summary).toMatchObject({
      tables: 12,
      structureOnly: 4,
      bytes: seed.byteLength,
      sha256: createHash('sha256').update(seed).digest('hex'),
    })
    expect(summary.serverVersion).toMatch(/MariaDB/)

    await load(target, seed)
    const [sourceConnection, targetConnection] = await Promise.all([
      connectTo(source),
      connectTo(target),
    ])
    try {
      const posts = `SELECT ID, HEX(post_content) AS content, HEX(post_title) AS title, post_type,
        post_status, post_date_gmt FROM wp_posts ORDER BY ID`
      const [copied] = await targetConnection.query<RowDataPacket[]>(posts)
      expect(copied.map((post) => Number(post.ID))).toEqual([10, 11, 12, 13, 14, 15, 18, 19])
      // Their bytes are the source's, four-byte characters, quotes and NUL included.
      const [original] = await sourceConnection.query<RowDataPacket[]>(
        `${posts.replace(' ORDER BY ID', '')} WHERE ID IN (10, 11, 12, 13, 14, 15, 18, 19) ORDER BY ID`,
      )
      expect(copied).toEqual(original)
      expect(Buffer.from(String(copied[0]?.content), 'hex').toString('utf8')).toBe(content)
      expect(copied[0]?.post_date_gmt).toBe('0000-00-00 00:00:00')

      const one = async (sql: string) =>
        (await targetConnection.query<RowDataPacket[]>(sql))[0].map((row) => ({ ...row }))
      expect(await one('SELECT post_password FROM wp_posts WHERE ID = 11')).toEqual([
        { post_password: '' },
      ])
      expect(
        await one(
          'SELECT ID, user_login, user_nicename, user_email, user_url, user_activation_key, display_name FROM wp_users',
        ),
      ).toEqual([
        {
          ID: '1',
          user_login: 'user1',
          user_nicename: 'user1',
          user_email: 'user1@preview.invalid',
          user_url: '',
          user_activation_key: '',
          display_name: 'Пользователь 1',
        },
      ])
      const [[password]] = await targetConnection.query<RowDataPacket[]>(
        'SELECT user_pass FROM wp_users WHERE ID = 1',
      )
      expect(String(password?.user_pass)).toMatch(/^\$P\$B[./0-9A-Za-z]{31}$/)
      expect(await one('SELECT post_id, meta_key FROM wp_postmeta ORDER BY meta_id')).toEqual([
        { post_id: '10', meta_key: '_thumbnail_id' },
        { post_id: '10', meta_key: '_wp_page_template' },
        { post_id: '13', meta_key: '_wp_attached_file' },
        { post_id: '19', meta_key: '_elementor_template_type' },
        { post_id: '10', meta_key: '_elementor_data' },
      ])
      // A secret key inside a copied value (Р14): its string is blanked, nothing else changes.
      expect(
        await one(`SELECT meta_value FROM wp_postmeta WHERE meta_key = '_elementor_data'`),
      ).toEqual([{ meta_value: '[{"settings":{"form_name":"Заявка","mailchimp_api_key":""}}]' }])
      expect(await one('SELECT term_id, taxonomy FROM wp_term_taxonomy')).toEqual([
        { term_id: '1', taxonomy: 'category' },
      ])
      expect(await one('SELECT term_id FROM wp_terms')).toEqual([{ term_id: '1' }])
      expect(await one('SELECT object_id, term_taxonomy_id FROM wp_term_relationships')).toEqual([
        { object_id: '11', term_taxonomy_id: '1' },
      ])
      expect(await one('SELECT meta_key FROM wp_termmeta')).toEqual([{ meta_key: 'color' }])
      const byName = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        String(a.option_name) < String(b.option_name) ? -1 : 1
      expect((await one('SELECT option_name, option_value FROM wp_options')).sort(byName)).toEqual(
        [
          ['active_plugins', 'a:1:{i:0;s:27:"woocommerce/woocommerce.php";}'],
          ['admin_email', 'admin@preview.invalid'],
          ['blog_public', '0'],
          ['blogname', 'Магазин «Ромашка»'],
          ['elementor_active_kit', '19'],
          ['home', 'https://shop.example.ru'],
          ['raditi_content_epoch', '0'],
          ['raditi_content_site_id', previewId],
          ['siteurl', 'https://shop.example.ru'],
          ['theme_mods_twentytwentyfive', 'a:0:{}'],
          ['widget_block', 'a:0:{}'],
          ['widget_text', 'a:1:{i:2;a:2:{s:5:"title";s:12:"Привет";s:7:"api_key";s:0:"";}}'],
          ['wp_user_roles', 'a:1:{s:13:"administrator";}'],
        ]
          .map(([option_name, option_value]) => ({ option_name, option_value }))
          .sort(byName),
      )
      for (const table of ['wp_usermeta', 'wp_comments', 'wp_woocommerce_order_items'])
        expect(await one(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: '0' }])
    } finally {
      await Promise.all([sourceConnection.end(), targetConnection.end()])
    }
  }, 120_000)

  it('copies every kind of value byte for byte, page after page', async () => {
    const policy: DatabaseCopyPolicy = {
      engine: 'mysql',
      tables: [{ table: 'raditi_types', where: [] }],
      overrides: [],
    }
    const { summary, seed } = await copy(source, policy)
    expect(summary.rows).toBe(1202)
    await load(target, seed)
    const values = `SELECT id, HEX(b) AS b, HEX(bl) AS bl, bits + 0 AS bits, d, big, f, dt, ts,
      HEX(t) AS t, j, e, gen FROM wp_raditi_types ORDER BY id`
    const [sourceConnection, targetConnection] = await Promise.all([
      connectTo(source),
      connectTo(target),
    ])
    try {
      await sourceConnection.query(`SET time_zone = '+00:00'`)
      await targetConnection.query(`SET time_zone = '+00:00'`)
      const [original] = await sourceConnection.query<RowDataPacket[]>(values)
      const [copied] = await targetConnection.query<RowDataPacket[]>(values)
      expect(copied).toHaveLength(1202)
      expect(copied).toEqual(original)
    } finally {
      await Promise.all([sourceConnection.end(), targetConnection.end()])
    }
  }, 120_000)

  it('refuses a row larger than its limit, a certificate nobody vouches for and a wrong password', async () => {
    const connection = await connectTo(source)
    try {
      await connection.query(
        `INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (10, 'huge', REPEAT('x', 5 * 1024 * 1024))`,
      )
      await expect(copy(source, wordpressPolicy)).rejects.toEqual(
        new DatabaseCopyError('too_large'),
      )
    } finally {
      await connection.query(`DELETE FROM wp_postmeta WHERE meta_key = 'huge'`)
      await connection.end()
    }
    await expect(copy(source, wordpressPolicy, { tls: 'verified' })).rejects.toEqual(
      new SiteConnectionError('certificate_untrusted'),
    )
    await expect(copy(source, wordpressPolicy, { password: 'not-the-password' })).rejects.toEqual(
      new SiteConnectionError('auth_failed'),
    )
  }, 120_000)

  it('stops the query at once when the caller stops, and writes nothing after', async () => {
    // One query streams the whole table: its key is no integer to page by.
    const connection = await connectTo(source)
    await connection.query(`CREATE TABLE wp_raditi_bulk (k varchar(16) NOT NULL, v mediumtext,
      PRIMARY KEY (k)) DEFAULT CHARSET=utf8mb4`)
    await connection.query(
      `INSERT INTO wp_raditi_bulk SELECT LPAD(seq, 16, '0'), REPEAT('x', 2000) FROM seq_1_to_40000`,
    )
    await connection.end()
    const policy: DatabaseCopyPolicy = {
      engine: 'mysql',
      tables: [{ table: 'raditi_bulk', where: [] }],
      overrides: [],
    }
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    try {
      // The writer stopping the copy on the first rows, and the writer still busy with them.
      for (const busy of [0, 3_000]) {
        const controller = new AbortController()
        const reason = new Error('stopped by the caller')
        let stoppedAt = 0
        let afterStop = 0
        const copying = copier.copy(
          {
            access: access(source),
            tablePrefix: 'wp_',
            charset: 'utf8mb4',
            collation: null,
            policy,
          },
          async (chunk) => {
            if (controller.signal.aborted) {
              afterStop += 1
              return
            }
            if (Buffer.from(chunk).toString('latin1').startsWith('INSERT INTO `wp_raditi_bulk`')) {
              controller.abort(reason)
              stoppedAt = performance.now()
              await pause(busy)
            }
          },
          controller.signal,
        )
        await expect(copying).rejects.toBe(reason)
        // 80 MB were still to come: the copy ends long before the server could send them.
        expect(performance.now() - stoppedAt, `busy ${busy}`).toBeLessThan(1_000)
        await pause(busy + 500)
        expect(afterStop, `busy ${busy}`).toBe(0)
      }
    } finally {
      const cleanup = await connectTo(source)
      await cleanup.query('DROP TABLE wp_raditi_bulk')
      await cleanup.end()
    }
  }, 120_000)
})
