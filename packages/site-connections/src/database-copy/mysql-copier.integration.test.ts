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

/**
 * SHA-256 of the seed of `fixture` by `wordpressPolicy` with every `user_pass` hash replaced by
 * one constant, as the copier wrote it before `suspectColumns` (plan 62, Э3.5).
 */
const WORDPRESS_SEED_SHA256 = '7c9b54ed1a92db49b98cf39de06af58264752f1e15fc4296a7d06d3c34e50df4'

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
  ('widget_text', 'a:1:{i:2;a:4:{s:5:"title";s:12:"Привет";s:7:"api_key";s:13:"widget-secret";s:8:"smtppass";s:16:"widget-smtp-pass";s:14:"mail_smtp_pass";s:16:"widget-mail-pass";}}', 'yes'),
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
      // The SMTP passwords of a mailer and of MODX under scrub_secrets (plan 62, Т57).
      'widget-smtp-pass',
      'widget-mail-pass',
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
          [
            'widget_text',
            'a:1:{i:2;a:4:{s:5:"title";s:12:"Привет";s:7:"api_key";s:0:"";s:8:"smtppass";s:0:"";s:14:"mail_smtp_pass";s:0:"";}}',
          ],
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

  it('writes the seed of WordPress as before the second line of unnamed columns', async () => {
    // WordPress has no `suspectColumns`: `comment_status` and `comment_count` would go empty.
    // The hash of `user_pass` is random on every copy (`random_password_hash`), written as a
    // literal of hex: each one is replaced by one constant, and the rest is the same bytes.
    const { summary, seed } = await copy(source, wordpressPolicy)
    const constant = Buffer.from(`$P$B${'.'.repeat(31)}`).toString('hex')
    const fixed = Buffer.from(
      seed
        .toString('latin1')
        .replaceAll(/_utf8mb4 X'24502442[0-9a-f]{62}'/g, () => `_utf8mb4 X'${constant}'`),
      'latin1',
    )
    expect(fixed.byteLength).toBe(seed.byteLength)
    expect(fixed.equals(seed)).toBe(false)
    expect(createHash('sha256').update(fixed).digest('hex')).toBe(WORDPRESS_SEED_SHA256)
    expect(summary.emptiedColumns).toBe(0)
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

  /** Tables of an extension on the source for one test, dropped after it. */
  async function withTables(tables: string[], sql: string, test: () => Promise<void>) {
    const connection = await connectTo(source)
    try {
      await connection.query(sql)
      await test()
    } finally {
      await connection.query(`DROP TABLE IF EXISTS ${tables.join(', ')}`)
      await connection.end()
    }
  }

  const termsOnly: DatabaseCopyPolicy = {
    engine: 'mysql',
    tables: [{ table: 'terms', where: [] }],
    overrides: [],
  }
  /** The copy of the site as it is before a test adds the tables of an extension. */
  const baselineOf = async () => (await copy(source, termsOnly)).summary

  it('leaves out a table outside the policy whose definition a seed cannot hold', async () => {
    const baseline = await baselineOf()
    await withTables(
      ['wp_acme_federated'],
      `CREATE TABLE wp_acme_federated (id int NOT NULL, lead text, PRIMARY KEY (id))
        ENGINE=InnoDB PARTITION BY HASH (id) PARTITIONS 2;
       INSERT INTO wp_acme_federated VALUES (1, 'lead-of-an-extension');`,
      async () => {
        const { summary, seed } = await copy(source, termsOnly)
        // The site's tables are counted whole, the one left out among them.
        expect(summary).toMatchObject({ tables: baseline.tables + 1, leftOutTables: 1 })
        expect(seed.toString('utf8')).not.toContain('wp_acme_federated')
        expect(seed.toString('utf8')).not.toContain('lead-of-an-extension')
        await load(target, seed)
        // A rule wants its rows: without the table the preview does not work.
        await expect(
          copy(source, {
            ...termsOnly,
            tables: [...termsOnly.tables, { table: 'acme_federated', where: [] }],
          }),
        ).rejects.toEqual(new DatabaseCopyError('structure_unsupported'))
        // An override alone wants it too: the platform's own state would be lost.
        await expect(
          copy(source, {
            ...termsOnly,
            overrides: [
              { table: 'acme_federated', match: { column: 'id', value: '1' }, set: { lead: 'x' } },
            ],
          }),
        ).rejects.toEqual(new DatabaseCopyError('structure_unsupported'))
      },
    )
  }, 120_000)

  it('refuses a table outside the policy whose definition is over the limit', async () => {
    // 800 columns of long names: SHOW CREATE TABLE is over 64 KiB, a limit and no definition.
    const columns = Array.from(
      { length: 800 },
      (_, index) => `c_${'x'.repeat(56)}_${String(index).padStart(3, '0')} int NULL`,
    )
    await withTables(
      ['wp_acme_huge'],
      `CREATE TABLE wp_acme_huge (id int NOT NULL, ${columns.join(', ')}, PRIMARY KEY (id))
        DEFAULT CHARSET=utf8mb4;`,
      async () => {
        await expect(copy(source, termsOnly)).rejects.toEqual(new DatabaseCopyError('too_large'))
      },
    )
  }, 120_000)

  it('leaves out a system-versioned table outside the policy, and refuses one a rule wants', async () => {
    const baseline = await baselineOf()
    await withTables(
      ['wp_acme_history'],
      `CREATE TABLE wp_acme_history (id int NOT NULL, v text, PRIMARY KEY (id))
        DEFAULT CHARSET=utf8mb4 WITH SYSTEM VERSIONING;
       INSERT INTO wp_acme_history VALUES (1, 'history-of-an-extension');`,
      async () => {
        const { summary, seed } = await copy(source, termsOnly)
        expect(summary).toMatchObject({ tables: baseline.tables + 1, leftOutTables: 1 })
        expect(seed.toString('utf8')).not.toContain('wp_acme_history')
        expect(seed.toString('utf8')).not.toContain('history-of-an-extension')
        await expect(
          copy(source, {
            ...termsOnly,
            tables: [...termsOnly.tables, { table: 'acme_history', where: [] }],
          }),
        ).rejects.toEqual(new DatabaseCopyError('structure_unsupported'))
      },
    )
  }, 120_000)

  it('refuses a column the policy names that the site keeps in another case', async () => {
    await withTables(
      ['wp_acme_people', 'wp_acme_opts'],
      `CREATE TABLE wp_acme_people (ID bigint unsigned NOT NULL, User_Email varchar(100),
         PRIMARY KEY (ID)) DEFAULT CHARSET=utf8mb4;
       CREATE TABLE wp_acme_opts (option_id bigint unsigned NOT NULL, option_name varchar(64),
         Option_Value longtext, PRIMARY KEY (option_id)) DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_people VALUES (1, 'anna.real@person.example');
       INSERT INTO wp_acme_opts VALUES (1, 'acme_widget', '{"api_key":"sk-real-secret-value"}');`,
      async () => {
        // The server finds each of these columns, the copy would not treat it: no copy.
        for (const rule of [
          { table: 'acme_people', where: [], columns: { user_email: 'synthetic_email' } },
          { table: 'acme_opts', where: [], columns: { option_value: 'scrub_secrets' } },
          {
            table: 'acme_opts',
            where: [{ op: 'in', column: 'OPTION_NAME', values: ['acme_widget'] }],
          },
        ] as DatabaseCopyPolicy['tables'])
          await expect(
            copy(source, { ...termsOnly, tables: [...termsOnly.tables, rule] }),
            rule.table,
          ).rejects.toEqual(new DatabaseCopyError('structure_unsupported'))
      },
    )
  }, 120_000)

  const items = `
    CREATE TABLE wp_acme_items (id int NOT NULL, kind varchar(16) NOT NULL, PRIMARY KEY (id))
      DEFAULT CHARSET=utf8mb4;
    CREATE TABLE wp_acme_meta (id int NOT NULL, item_id int NOT NULL, v text, PRIMARY KEY (id))
      DEFAULT CHARSET=utf8mb4;
    INSERT INTO wp_acme_items VALUES (1, 'public'), (2, 'private');
    INSERT INTO wp_acme_meta VALUES (1, 1, 'meta-of-public'), (2, 2, 'meta-of-private');`

  it('writes a rule whose condition the source cannot answer, and the rule after it, as structure only', async () => {
    const baseline = await baselineOf()
    await withTables(['wp_acme_items', 'wp_acme_meta'], items, async () => {
      const { summary, seed } = await copy(source, {
        ...termsOnly,
        tables: [
          ...termsOnly.tables,
          {
            table: 'acme_items',
            where: [{ op: 'in', column: 'no_such_column', values: ['public'] }],
          },
          {
            table: 'acme_meta',
            where: [{ op: 'inCopied', column: 'item_id', table: 'acme_items', key: 'id' }],
          },
        ],
      })
      expect(summary).toMatchObject({
        structureOnly: baseline.structureOnly + 2,
        leftOutTables: 2,
      })
      const text = seed.toString('utf8')
      for (const table of ['wp_acme_items', 'wp_acme_meta']) {
        expect(text).toContain(`CREATE TABLE \`${table}\``)
        expect(text).not.toContain(`INSERT INTO \`${table}\``)
      }
      expect(text).not.toMatch(/meta-of-p|'private'|'public'/)
      await load(target, seed)
      const connection = await connectTo(target)
      try {
        for (const table of ['wp_acme_items', 'wp_acme_meta']) {
          const [[count]] = await connection.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS n FROM ${table}`,
          )
          expect(String(count?.n), table).toBe('0')
        }
      } finally {
        await connection.end()
      }
    })
  }, 120_000)

  it('skips a treatment of a column the source lacks, and refuses an override of one', async () => {
    await withTables(['wp_acme_items', 'wp_acme_meta'], items, async () => {
      const treated: DatabaseCopyPolicy = {
        ...termsOnly,
        tables: [{ table: 'acme_items', where: [], columns: { no_such_column: 'empty' } }],
      }
      const { summary, seed } = await copy(source, treated)
      expect(summary).toMatchObject({ rows: 2, leftOutTables: 0 })
      expect(seed.toString('utf8')).toContain('INSERT INTO `wp_acme_items`')
      // An override holds the platform's own state in the copy: without its column, no copy.
      await expect(
        copy(source, {
          ...treated,
          overrides: [
            {
              table: 'acme_items',
              match: { column: 'no_such_column', value: 'x' },
              set: { kind: 'preview' },
            },
          ],
        }),
      ).rejects.toEqual(new DatabaseCopyError('structure_unsupported'))
      // The same for a table only an override names, whose rows the copy never reads.
      await expect(
        copy(source, {
          ...termsOnly,
          overrides: [
            {
              table: 'acme_meta',
              match: { column: 'no_such_column', value: 'x' },
              set: { v: 'p' },
            },
          ],
        }),
      ).rejects.toEqual(new DatabaseCopyError('structure_unsupported'))
    })
  }, 120_000)

  it('copies an unnamed column with the name of people empty, and the seed loads', async () => {
    await withTables(
      ['wp_acme_contacts'],
      `CREATE TABLE wp_acme_contacts (id int NOT NULL, acme_phone varchar(32) NOT NULL,
         billing_zip int NOT NULL, birthdate date NOT NULL, title varchar(64) NOT NULL,
         customer_type enum('retail', 'trade') NOT NULL, PRIMARY KEY (id))
         DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_contacts VALUES
         (1, '+7 900 000-00-07', 101000, '1990-05-01', 'Контакты', 'trade'),
         (2, '+7 900 000-00-08', 190000, '1985-11-30', 'Доставка', 'trade');`,
      async () => {
        const rule = { table: 'acme_contacts', where: [] }
        const policyOf = (
          columns: Record<string, 'keep'> | undefined,
          suspectColumns: 'empty' | undefined,
        ): DatabaseCopyPolicy => ({
          ...termsOnly,
          tables: [...termsOnly.tables, columns ? { ...rule, columns } : rule],
          ...(suspectColumns ? { suspectColumns } : {}),
        })
        const contacts = async (policy: DatabaseCopyPolicy) => {
          const { summary, seed } = await copy(source, policy)
          await load(target, seed)
          const connection = await connectTo(target)
          try {
            const [rows] = await connection.query<RowDataPacket[]>(
              `SELECT id, acme_phone, billing_zip, birthdate, title, customer_type
                FROM wp_acme_contacts ORDER BY id`,
            )
            return {
              emptied: summary.emptiedColumns,
              seed: seed.toString('utf8'),
              rows: rows.map((row) => ({ ...row })),
            }
          } finally {
            await connection.end()
          }
        }

        // Each column counts once, whatever the number of rows.
        const second = await contacts(policyOf(undefined, 'empty'))
        // Without NULL every row gets the empty literal a lax seed loads: '', 0, a zero date
        // and the empty value of an enum.
        expect(second.emptied).toBe(4)
        // `trade` stays in the definition of the enum, not in a row.
        const inserted = second.seed.slice(second.seed.indexOf('INSERT INTO `wp_acme_contacts`'))
        for (const value of ['+7 900', '101000', '1990-05-01', 'trade'])
          expect(inserted).not.toContain(value)
        const emptyRow = { acme_phone: '', billing_zip: 0, birthdate: '0000-00-00' }
        expect(second.rows).toEqual([
          { id: 1, ...emptyRow, title: 'Контакты', customer_type: '' },
          { id: 2, ...emptyRow, title: 'Доставка', customer_type: '' },
        ])

        // A column the adapter names passes as it says.
        const kept = await contacts(policyOf({ acme_phone: 'keep' }, 'empty'))
        expect(kept.emptied).toBe(3)
        expect(kept.rows.map((row) => row.acme_phone)).toEqual([
          '+7 900 000-00-07',
          '+7 900 000-00-08',
        ])

        // Without the field the copy is as before: every unnamed column as it is.
        const before = await contacts(policyOf(undefined, undefined))
        expect(before.emptied).toBe(0)
        expect(before.rows).toEqual([
          {
            id: 1,
            acme_phone: '+7 900 000-00-07',
            billing_zip: 101000,
            birthdate: '1990-05-01',
            title: 'Контакты',
            customer_type: 'trade',
          },
          {
            id: 2,
            acme_phone: '+7 900 000-00-08',
            billing_zip: 190000,
            birthdate: '1985-11-30',
            title: 'Доставка',
            customer_type: 'trade',
          },
        ])
      },
    )
  }, 120_000)

  it('writes NULL into an unnamed column that takes it: JSON, geometry and a unique key load', async () => {
    await withTables(
      ['wp_acme_extras'],
      `CREATE TABLE wp_acme_extras (id int NOT NULL, title varchar(64) NOT NULL,
         customer_meta json NULL, acme_token varchar(64) NULL, address_point point NULL,
         PRIMARY KEY (id), UNIQUE KEY acme_token (acme_token)) DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_extras VALUES
         (1, 'Первый', '{"customer":"Анна"}', 'tok-secret-1', POINT(37.6, 55.7)),
         (2, 'Второй', '{"customer":"Борис"}', NULL, NULL),
         (3, 'Третий', NULL, 'tok-secret-3', POINT(30.3, 59.9));`,
      async () => {
        const { summary, seed } = await copy(source, {
          ...termsOnly,
          tables: [...termsOnly.tables, { table: 'acme_extras', where: [] }],
          suspectColumns: 'empty',
        })
        expect(summary).toMatchObject({ emptiedColumns: 3, leftOutTables: 0 })
        for (const value of ['Анна', 'Борис', 'tok-secret'])
          expect(seed.toString('utf8')).not.toContain(value)
        await load(target, seed)
        const connection = await connectTo(target)
        try {
          const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT id, title, customer_meta, acme_token, ST_AsText(address_point) AS address_point
              FROM wp_acme_extras ORDER BY id`,
          )
          expect(rows.map((row) => ({ ...row }))).toEqual(
            ['Первый', 'Второй', 'Третий'].map((title, index) => ({
              id: index + 1,
              title,
              customer_meta: null,
              acme_token: null,
              address_point: null,
            })),
          )
        } finally {
          await connection.end()
        }
      },
    )
  }, 120_000)

  it('leaves the rows of a table out when an unnamed column of it holds neither empty nor NULL', async () => {
    const baseline = await baselineOf()
    // A key of a name of people, a JSON column without NULL: one value in every row would not
    // load, the copy goes on without the rows and says so.
    await withTables(
      ['wp_acme_keyed', 'wp_acme_profile', 'wp_acme_child'],
      `CREATE TABLE wp_acme_keyed (client_id int NOT NULL, id int NOT NULL,
         title varchar(64) NOT NULL, PRIMARY KEY (client_id, id)) DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_keyed VALUES (1, 1, 'Первый'), (2, 1, 'Второй');
       CREATE TABLE wp_acme_profile (id int NOT NULL, customer_data json NOT NULL,
         PRIMARY KEY (id)) DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_profile VALUES (1, '{"customer":"Анна"}'), (2, '{"customer":"Борис"}');
       CREATE TABLE wp_acme_child (id int NOT NULL, profile_id int NOT NULL, title varchar(64),
         PRIMARY KEY (id)) DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_child VALUES (1, 1, 'Дочерняя');`,
      async () => {
        const rules: DatabaseCopyPolicy['tables'] = [
          { table: 'acme_keyed', where: [] },
          { table: 'acme_profile', where: [] },
          {
            table: 'acme_child',
            where: [{ op: 'inCopied', column: 'profile_id', table: 'acme_profile', key: 'id' }],
          },
        ]
        const { summary, seed } = await copy(source, {
          ...termsOnly,
          tables: [...termsOnly.tables, ...rules],
          suspectColumns: 'empty',
        })
        // The rule that follows a table left out goes with it.
        expect(summary).toMatchObject({
          tables: baseline.tables + 3,
          leftOutTables: baseline.leftOutTables + 3,
          emptiedColumns: 0,
        })
        for (const value of ['Анна', 'Первый', 'Дочерняя'])
          expect(seed.toString('utf8')).not.toContain(value)
        await load(target, seed)
        const connection = await connectTo(target)
        try {
          for (const table of ['wp_acme_keyed', 'wp_acme_profile', 'wp_acme_child']) {
            const [rows] = await connection.query<RowDataPacket[]>(
              `SELECT COUNT(*) AS n FROM ${table}`,
            )
            expect(Number(rows[0]?.n), table).toBe(0)
          }
        } finally {
          await connection.end()
        }
        // A column the adapter names keeps the rows.
        const named = await copy(source, {
          ...termsOnly,
          tables: [
            ...termsOnly.tables,
            { table: 'acme_keyed', where: [], columns: { client_id: 'keep' } },
          ],
          suspectColumns: 'empty',
        })
        expect(named.summary).toMatchObject({ leftOutTables: baseline.leftOutTables })
        expect(named.seed.toString('utf8')).toContain('Второй')
      },
    )
  }, 120_000)

  it('loads a table wider than a strict server creates', async () => {
    const columns = Array.from({ length: 24 }, (_, index) => `c${index} varchar(255) NULL`)
    await withTables(
      ['wp_acme_wide'],
      `SET SESSION innodb_strict_mode = 0;
       CREATE TABLE wp_acme_wide (id int NOT NULL, ${columns.join(', ')}, PRIMARY KEY (id))
         ENGINE=InnoDB ROW_FORMAT=COMPACT DEFAULT CHARSET=utf8mb4;
       INSERT INTO wp_acme_wide (id, c0, c23) VALUES (1, 'первая', 'последняя');`,
      async () => {
        const { seed } = await copy(source, {
          ...termsOnly,
          tables: [{ table: 'acme_wide', where: [] }],
        })
        // The same seed without the line: a strict server refuses the table.
        const strict = Buffer.from(
          seed.toString('latin1').replace('SET SESSION innodb_strict_mode = 0;\n', ''),
          'latin1',
        )
        expect(strict.byteLength).toBeLessThan(seed.byteLength)
        await expect(load(target, strict)).rejects.toThrow(/ERROR 1118/)
        await load(target, seed)
        const connection = await connectTo(target)
        try {
          const [rows] = await connection.query<RowDataPacket[]>(
            'SELECT id, c0, c23 FROM wp_acme_wide',
          )
          expect(rows.map((row) => ({ ...row }))).toEqual([
            { id: 1, c0: 'первая', c23: 'последняя' },
          ])
        } finally {
          await connection.end()
        }
      },
    )
  }, 120_000)
})
