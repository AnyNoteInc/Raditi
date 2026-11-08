// WordPress on the synthetic production of a stand of the site stacks (docs/plan/62-slices/e3.md,
// Э3.15): the stack on which everything already works, so that a group of the stand that fails on it
// is the stand's fault, not a new adapter's (§5.1, Т65). The release of wordpress.org, installed by
// WP-CLI of the image `site` inside the container of the production, a classic theme of the stand
// (the block themes of the supply have no file of the footer), a published record, a static front
// page, and values that mark what no preview may hold. The site is made by the wizard as for any
// stack: without the plugin «Радити», so its database plan is empty — the path of a new WordPress
// site. Only synthetic data; the core of WordPress runs in the container of the production only.
import { randomBytes } from 'node:crypto'

/** The build of the stand: the release the platform runs (verify:release), on the PHP of its image. */
export const WORDPRESS_BUILDS = [
  { archive: 'wordpress-7.1.2', php: '8.3', generation: null, version: '7.1.2' },
]

/** The prefix of the tables of the production, as wp-config-sample.php ships it. */
export const WORDPRESS_PREFIX = 'wp_'
/** The theme of the stand: a folder of wp-content/themes/. */
export const STAND_THEME = 'raditi-stand'
/** The webroot of the production container. */
const ROOT = '/var/www/html'
const THEME = `wp-content/themes/${STAND_THEME}`

/** What the install writes, by what a test asks for. */
export const WORDPRESS_SEED = Object.freeze({
  sitename: 'Стенд WordPress Радити',
  /** The administrator the installer makes; the author of every page of the seed. */
  adminLogin: 'standadmin',
  recordTitle: 'Запись стенда',
  recordSlug: 'stand-record',
  /** What only the page of the record shows (`page()`, P2). */
  recordText: 'Запись стенда',
  recordContent: 'Запись стенда: синтетический текст, который показывает только её страница.',
  frontTitle: 'Главная стенда',
  frontSlug: 'glavnaya-stenda',
  /** A draft behind a password: Р15 copies drafts, and the copy clears `post_password`. */
  draftTitle: 'Черновик стенда',
  draftSlug: 'stand-draft',
  /** An image of the media library, drawn by the front page: what the agent's browser may open. */
  image: 'wp-content/uploads/stand/stand-logo.png',
})

/** Values of the seed that no copy holds. */
const canary = Object.freeze({
  adminEmail: 'kanareykin.admin@people.example',
  adminName: 'Канарейкин Администратор Сайта',
  firstName: 'Канарейкин Имя Автора',
  commentAuthor: 'Канарейкина Комментатор Записи',
  commentEmail: 'kanareykina.comment@people.example',
  commentText: 'Комментарий-канарейка 7e2c',
  optionToken: 'canary-wp-token-7e2c9a1b0c1d2e3f',
  draftPassword: 'canary-draft-pass-7e2c',
})

export const WORDPRESS_CANARIES = Object.freeze(Object.values(canary))

/** The account of the platform a WordPress preview makes for itself (wordpress-preview.ts). */
const PLATFORM_LOGIN = 'raditi-platform'

/** An option with the name of a secret among the widgets the copy takes: refused by its name. */
const SECRET_OPTION = 'widget_raditi_stand_token'
/** A widget of the seed without such a name, under the same rule of the copy: the control. */
const WIDGET_OPTION = 'widget_raditi_stand_title'
const WIDGET_VALUE = 'Заголовок виджета стенда'

/** An SQL text literal: the values above are constants, quoted all the same. */
const q = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`

/** The classic theme of the stand, four files: its style, its header, the loop and its footer. */
export const STAND_THEME_FILES = Object.freeze({
  'style.css': [
    '/*',
    'Theme Name: Raditi Stand',
    'Description: The classic theme of the stand of the site stacks: a header, the loop, a footer.',
    'Version: 1.0',
    'License: GPL-2.0-or-later',
    '*/',
    'body { font-family: sans-serif; margin: 2rem; }',
    '',
  ].join('\n'),
  'header.php': [
    '<!DOCTYPE html>',
    '<html <?php language_attributes(); ?>>',
    '<head>',
    '<meta charset="<?php bloginfo(\'charset\'); ?>">',
    '<link rel="stylesheet" href="<?php echo esc_url(get_stylesheet_uri()); ?>">',
    '<?php wp_head(); ?>',
    '</head>',
    '<body <?php body_class(); ?>>',
    '<?php wp_body_open(); ?>',
    "<header><p><?php bloginfo('name'); ?></p></header>",
    '',
  ].join('\n'),
  'index.php': [
    '<?php get_header(); ?>',
    '<main>',
    '<?php while (have_posts()) : the_post(); ?>',
    '<article><h1><?php the_title(); ?></h1><?php the_content(); ?></article>',
    '<?php endwhile; ?>',
    '</main>',
    '<?php get_footer(); ?>',
    '',
  ].join('\n'),
  'footer.php': [
    '<footer><p>Стенд Радити</p></footer>',
    '<?php wp_footer(); ?>',
    '</body>',
    '</html>',
    '',
  ].join('\n'),
})

/** The rules of WordPress for pretty links, as it writes them into `.htaccess`. */
const HTACCESS = [
  '# BEGIN WordPress',
  '<IfModule mod_rewrite.c>',
  'RewriteEngine On',
  'RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]',
  'RewriteBase /',
  'RewriteRule ^index\\.php$ - [L]',
  'RewriteCond %{REQUEST_FILENAME} !-f',
  'RewriteCond %{REQUEST_FILENAME} !-d',
  'RewriteRule . /index.php [L]',
  '</IfModule>',
  '# END WordPress',
  '',
].join('\n')

/** The keys and salts of wp-config.php, in the order of wp-config-sample.php. */
const KEY_NAMES = [
  'AUTH_KEY',
  'SECURE_AUTH_KEY',
  'LOGGED_IN_KEY',
  'NONCE_KEY',
  'AUTH_SALT',
  'SECURE_AUTH_SALT',
  'LOGGED_IN_SALT',
  'NONCE_SALT',
]
const PHRASE = "'put your unique phrase here'"

/** `text` with `from` replaced by `to`, `from` found exactly once. */
function once(text, from, to) {
  const found = text.split(from).length - 1
  if (found !== 1) throw new Error(`wp-config-sample.php: ${from} is there ${found} times`)
  return text.replace(from, () => to)
}

/**
 * wp-config.php of the production from wp-config-sample.php of the release: the database of the
 * container, its password, the keys of the run and no cron of WordPress (a page would request the
 * site from inside its container, where its address is closed). Every placeholder is replaced
 * once; a sample of another form stops the install.
 */
export function wordpressConfig(sample, { password, keys }) {
  if (!Array.isArray(keys) || keys.length !== KEY_NAMES.length)
    throw new Error(`wp-config.php takes ${KEY_NAMES.length} keys`)
  const literal = (value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('A value of wp-config.php is not plain')
    return `'${value}'`
  }
  let text = once(sample, "'database_name_here'", "'site'")
  text = once(text, "'username_here'", "'site'")
  text = once(text, "'password_here'", literal(password))
  text = once(text, "define( 'DB_HOST', 'localhost' );", "define( 'DB_HOST', '127.0.0.1' );")
  if (text.split(PHRASE).length - 1 !== keys.length)
    throw new Error(`wp-config-sample.php: ${PHRASE} is not there ${keys.length} times`)
  for (const key of keys) text = text.replace(PHRASE, () => literal(key))
  return once(
    text,
    "define( 'WP_DEBUG', false );",
    "define( 'DISABLE_WP_CRON', true );\ndefine( 'WP_DEBUG', false );",
  )
}

/** WP-CLI as www-data in the webroot of the production: its answer, trimmed. */
async function wp(production, ...args) {
  const output = await production.exec([
    'setpriv',
    '--reuid=33',
    '--regid=33',
    '--clear-groups',
    'env',
    'HOME=/tmp',
    'wp',
    `--path=${ROOT}`,
    ...args,
  ])
  return output.trim()
}

/** A file of the webroot written as root from stdin, its folder made. */
const writeFile = (production, path, text) =>
  production.exec(
    ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', `${ROOT}/${path}`],
    text,
  )

/**
 * Installs WordPress without a browser on the production of a stand: wp-config.php from the sample
 * (the password of the database read from the container's own file), the theme of the stand, the
 * rules of pretty links in `.htaccess`, an image of the media library and a page of a cache —
 * what the import must leave out —, then `wp core install` at the production's own origin, the theme
 * activated, `/%postname%/`, the record, a static front page and a draft: WordPress prints a
 * canonical link only on a singular page, and the control of P2 asks it of both pages.
 */
export async function installWordpress(production, { productionOrigin } = {}) {
  if (typeof productionOrigin !== 'string' || new URL(productionOrigin).origin !== productionOrigin)
    throw new Error('installWordpress: productionOrigin is the origin of the production')
  const password = (await production.exec(['cat', '/prod-secrets/db'])).trim()
  const sample = await production.exec(['cat', `${ROOT}/wp-config-sample.php`])
  const keys = KEY_NAMES.map(() => randomBytes(36).toString('base64url'))
  await writeFile(production, 'wp-config.php', wordpressConfig(sample, { password, keys }))
  for (const [name, text] of Object.entries(STAND_THEME_FILES))
    await writeFile(production, `${THEME}/${name}`, text)
  await writeFile(production, '.htaccess', HTACCESS)
  await writeFile(production, 'wp-content/cache/stand-page.html', '<!-- a page of a cache -->\n')
  await production.exec([
    'sh',
    '-c',
    `mkdir -p "$(dirname ${ROOT}/${WORDPRESS_SEED.image})" &&` +
      ` cp ${ROOT}/wp-admin/images/wordpress-logo.png ${ROOT}/${WORDPRESS_SEED.image} &&` +
      ` chown -R 33:33 ${ROOT}`,
  ])
  await wp(
    production,
    'core',
    'install',
    `--url=${productionOrigin}`,
    `--title=${WORDPRESS_SEED.sitename}`,
    `--admin_user=${WORDPRESS_SEED.adminLogin}`,
    '--admin_password=stand-admin-not-a-person',
    '--admin_email=admin@stand.invalid',
    '--skip-email',
  )
  await wp(production, 'theme', 'activate', STAND_THEME)
  await wp(production, 'rewrite', 'structure', '/%postname%/')
  await wp(
    production,
    // As the administrator: WP-CLI without a user writes no author, and the copy takes the
    // authors of its posts only.
    `--user=${WORDPRESS_SEED.adminLogin}`,
    'post',
    'create',
    '--post_type=post',
    '--post_status=publish',
    `--post_title=${WORDPRESS_SEED.recordTitle}`,
    `--post_name=${WORDPRESS_SEED.recordSlug}`,
    `--post_content=<p>${WORDPRESS_SEED.recordContent}</p>`,
    '--porcelain',
  )
  const front = await wp(
    production,
    // As the administrator: WP-CLI without a user writes no author, and the copy takes the
    // authors of its posts only.
    `--user=${WORDPRESS_SEED.adminLogin}`,
    'post',
    'create',
    '--post_type=page',
    '--post_status=publish',
    `--post_title=${WORDPRESS_SEED.frontTitle}`,
    `--post_name=${WORDPRESS_SEED.frontSlug}`,
    `--post_content=<p>Синтетическая главная стенда.</p><img src="/${WORDPRESS_SEED.image}" alt="">`,
    '--porcelain',
  )
  if (!/^\d+$/.test(front)) throw new Error('wp post create gave no id of the front page')
  await wp(
    production,
    `--user=${WORDPRESS_SEED.adminLogin}`,
    'post',
    'create',
    '--post_type=post',
    '--post_status=draft',
    `--post_title=${WORDPRESS_SEED.draftTitle}`,
    `--post_name=${WORDPRESS_SEED.draftSlug}`,
    '--post_content=<p>Синтетический черновик стенда.</p>',
    '--porcelain',
  )
  await wp(production, 'option', 'update', 'show_on_front', 'page')
  await wp(production, 'option', 'update', 'page_on_front', front)
}

/**
 * The marks of the production, as SQL with the prefix: the administrator's address and name and
 * the address of the site are a person's, a mark in the profile of the author, a comment of a
 * person on the record, an option named as a secret among the widgets the copy takes beside a
 * widget named as none, and the password of the draft.
 */
export function wordpressSeedSql(prefix) {
  const t = (name) => `\`${prefix}${name}\``
  const admin = `(SELECT ID FROM ${t('users')} WHERE user_login = ${q(WORDPRESS_SEED.adminLogin)})`
  const record =
    `(SELECT ID FROM ${t('posts')} WHERE post_name = ${q(WORDPRESS_SEED.recordSlug)}` +
    " AND post_type = 'post')"
  const lines = [
    `UPDATE ${t('users')} SET user_email = ${q(canary.adminEmail)},` +
      ` display_name = ${q(canary.adminName)} WHERE user_login = ${q(WORDPRESS_SEED.adminLogin)};`,
    `UPDATE ${t('options')} SET option_value = ${q(canary.adminEmail)}` +
      " WHERE option_name = 'admin_email';",
    `INSERT INTO ${t('usermeta')} (user_id, meta_key, meta_value)` +
      ` SELECT ID, 'raditi_stand_first_name', ${q(canary.firstName)} FROM ${t('users')}` +
      ` WHERE user_login = ${q(WORDPRESS_SEED.adminLogin)};`,
    `SET @raditi_record = ${record};`,
    `INSERT INTO ${t('comments')} (comment_post_ID, comment_author, comment_author_email,` +
      ' comment_author_url, comment_author_IP, comment_date, comment_date_gmt, comment_content,' +
      ' comment_karma, comment_approved, comment_agent, comment_type, comment_parent, user_id)' +
      ` VALUES (@raditi_record, ${q(canary.commentAuthor)}, ${q(canary.commentEmail)}, '',` +
      ` '203.0.113.7', NOW(), UTC_TIMESTAMP(), ${q(canary.commentText)}, 0, '1', '',` +
      " 'comment', 0, 0);",
    `UPDATE ${t('posts')} SET comment_count = 1 WHERE ID = @raditi_record;`,
    `INSERT INTO ${t('options')} (option_name, option_value, autoload)` +
      ` VALUES (${q(SECRET_OPTION)}, ${q(canary.optionToken)}, 'off'),` +
      ` (${q(WIDGET_OPTION)}, ${q(WIDGET_VALUE)}, 'off');`,
    `UPDATE ${t('posts')} SET post_password = ${q(canary.draftPassword)}` +
      ` WHERE post_name = ${q(WORDPRESS_SEED.draftSlug)} AND post_type = 'post';`,
    `SELECT ${admin} IS NOT NULL AND @raditi_record IS NOT NULL AND ROW_COUNT() = 1;`,
  ]
  return `${lines.join('\n')}\n`
}

/** The types of columns a mark of the seed could be copied into. */
const TEXT_TYPES = ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']
/** The text columns of the database a query runs in, `table|column` a row. */
export const WORDPRESS_TEXT_COLUMNS_SQL =
  "SELECT CONCAT(TABLE_NAME, '|', COLUMN_NAME) FROM information_schema.COLUMNS" +
  ` WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN (${TEXT_TYPES.map(q).join(', ')})` +
  ' ORDER BY TABLE_NAME, ORDINAL_POSITION'
const NAME = /^[A-Za-z0-9_$]{1,64}$/

/**
 * The marks of the seed (`WORDPRESS_CANARIES`) a database holds in any text column of any table:
 * by their bytes (`LOCATE` in the column cast to binary), so the character set of the client does
 * not matter. `null` when the database lists no text column — a query that saw nothing proves
 * nothing. `sql` — a query in that database, its answer as text.
 */
export async function wordpressMarksIn(sql) {
  const byTable = new Map()
  for (const row of (await sql(WORDPRESS_TEXT_COLUMNS_SQL)).split('\n').filter(Boolean)) {
    const [table, column] = row.trim().split('|')
    if (!NAME.test(table ?? '') || !NAME.test(column ?? ''))
      throw new Error(`A column of the database is not a plain name: ${row}`)
    byTable.set(table, [...(byTable.get(table) ?? []), column])
  }
  if (byTable.size === 0) return null
  const found = []
  for (const mark of WORDPRESS_CANARIES) {
    const bytes = `UNHEX('${Buffer.from(mark, 'utf8').toString('hex').toUpperCase()}')`
    const counts = [...byTable].map(
      ([table, columns]) =>
        `(SELECT COUNT(*) FROM \`${table}\` WHERE ` +
        columns
          .map((column) => `LOCATE(${bytes}, CAST(\`${column}\` AS BINARY)) > 0`)
          .join(' OR ') +
        ')',
    )
    if (Number((await sql(`SELECT ${counts.join(' + ')}`)).trim()) > 0) found.push(mark)
  }
  return found
}

/**
 * P3 of WordPress: the authors of the copy are synthetic, comments and the profiles of people are
 * not copied (the only profile is the platform's own account the preview makes), the record and
 * the front page are (the control), the draft is, without its password, the option named as a
 * secret is not while a widget of the seed under the same rule is, the address of the site's admin
 * and the search engines are the copy's own, and no mark of the seed is in any text column of the
 * copy (the install proves production holds every one). `sql` — a query as root of the preview's
 * database, its answer as text.
 */
export async function wordpressCopyChecks(sql) {
  const t = (name) => `\`${WORDPRESS_PREFIX}${name}\``
  const text = async (query) => (await sql(query)).trim()
  const number = async (query) => Number(await text(query))
  const users = (await text(`SELECT CONCAT(user_login, '|', user_email) FROM ${t('users')}`))
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('|'))
  const checks = [
    {
      name: 'the authors of the copy are synthetic, at @preview.invalid, none under the login of production',
      ok:
        users.length > 0 &&
        users.every(
          ([login, email]) =>
            email.endsWith('@preview.invalid') && login !== WORDPRESS_SEED.adminLogin,
        ),
      found: { authors: users.length },
    },
  ]
  const comments = await number(`SELECT COUNT(*) FROM ${t('comments')}`)
  checks.push({ name: 'comments is empty', ok: comments === 0, found: { rows: comments } })
  // The preview makes its own account of the platform (`content.access` of the recipe), with its
  // profile: every other row of usermeta would be a person's of production.
  const profiles = await number(
    `SELECT COUNT(*) FROM ${t('usermeta')} m LEFT JOIN ${t('users')} u ON u.ID = m.user_id` +
      ` WHERE u.user_login IS NULL OR u.user_login <> ${q(PLATFORM_LOGIN)}`,
  )
  const platform = await number(
    `SELECT COUNT(*) FROM ${t('usermeta')} m JOIN ${t('users')} u ON u.ID = m.user_id` +
      ` WHERE u.user_login = ${q(PLATFORM_LOGIN)}`,
  )
  checks.push({
    name: `usermeta holds only the profile of the account of the platform (${PLATFORM_LOGIN})`,
    ok: profiles === 0 && platform > 0,
    found: { others: profiles, platform },
  })
  const pages = await number(
    `SELECT COUNT(*) FROM ${t('posts')} WHERE post_status = 'publish' AND post_name IN` +
      ` (${q(WORDPRESS_SEED.recordSlug)}, ${q(WORDPRESS_SEED.frontSlug)})`,
  )
  checks.push({
    name: 'the published record and the front page are in the copy',
    ok: pages === 2,
    found: { pages },
  })
  const drafts = (
    await text(
      `SELECT CONCAT(post_status, '|', post_password) FROM ${t('posts')}` +
        ` WHERE post_name = ${q(WORDPRESS_SEED.draftSlug)} AND post_type = 'post'`,
    )
  )
    .split('\n')
    .filter(Boolean)
  checks.push({
    name: 'the draft is in the copy, its password cleared',
    ok: drafts.length === 1 && drafts[0] === 'draft|',
    found: { rows: drafts.length, cleared: drafts.length === 1 && drafts[0].endsWith('|') },
  })
  const count = (name) =>
    number(`SELECT COUNT(*) FROM ${t('options')} WHERE option_name = ${q(name)}`)
  const secret = await count(SECRET_OPTION)
  const widget = await count(WIDGET_OPTION)
  checks.push({
    name: `the widget named as a secret is not in the copy, ${WIDGET_OPTION} is`,
    ok: secret === 0 && widget === 1,
    found: { secret, widget },
  })
  const option = async (name) =>
    text(`SELECT option_value FROM ${t('options')} WHERE option_name = ${q(name)}`)
  const adminEmail = await option('admin_email')
  const blogPublic = await option('blog_public')
  checks.push({
    name: 'the address of the admin is admin@preview.invalid, search engines are told to stay away',
    ok: adminEmail === 'admin@preview.invalid' && blogPublic === '0',
    found: { adminEmail: adminEmail === 'admin@preview.invalid', blogPublic },
  })
  const marks = await wordpressMarksIn(sql)
  checks.push({
    name: 'no mark of the seed is in a text column of the copy: names, addresses, comment, secrets',
    ok: marks !== null && marks.length === 0,
    found: marks === null ? { columns: 0 } : { marks: marks.length },
  })
  return checks
}

/**
 * P5 of WordPress: the panel at /wp-admin/, which sends a frame without a session to the form of
 * wp-login.php and back after the sign-in; the button, the bar only a signed-in page has, and the
 * texts after which the sign-in did not hold — a wrong password, cookies WordPress did not get back,
 * an expired session or link.
 * `setPassword(rootSql, password)` makes the author of the record in the copy an administrator with
 * the stand's password and gives its login: a copy holds its authors with synthetic logins, a random
 * hash and no profile. The hash is the plain MD5 WordPress still reads and rehashes at the sign-in:
 * SQL makes no bcrypt. No mark of the address of the admin to confirm: the preview's must-use
 * plugin turns the check off.
 */
function wordpressSignIn() {
  const t = (name) => `\`${WORDPRESS_PREFIX}${name}\``
  return {
    path: '/wp-admin/',
    fields: { login: '#user_login', password: '#user_pass' },
    submit: '#wp-submit',
    signedIn: '#wpadminbar',
    lostCookie: [
      'is incorrect',
      'Cookies are blocked',
      'session has expired',
      'The link you followed has expired',
      'is not registered on this site',
    ],
    async setPassword(rootSql, password) {
      const login = (
        await rootSql(
          `SELECT u.user_login FROM ${t('users')} u JOIN ${t('posts')} p ON p.post_author = u.ID` +
            ` WHERE p.post_name = ${q(WORDPRESS_SEED.recordSlug)} AND p.post_type = 'post' LIMIT 1`,
        )
      ).trim()
      if (!login) throw new Error('The copy holds no author to sign in as')
      const id = `(SELECT ID FROM ${t('users')} WHERE user_login = ${q(login)})`
      const meta = (key, value) =>
        `INSERT INTO ${t('usermeta')} (user_id, meta_key, meta_value) SELECT ID,` +
        ` ${q(`${WORDPRESS_PREFIX}${key}`)}, ${q(value)} FROM ${t('users')}` +
        ` WHERE user_login = ${q(login)};`
      await rootSql(
        `UPDATE ${t('users')} SET user_pass = MD5(${q(password)}), user_activation_key = ''` +
          ` WHERE user_login = ${q(login)};` +
          ` DELETE FROM ${t('usermeta')} WHERE user_id = ${id} AND meta_key IN` +
          ` (${q(`${WORDPRESS_PREFIX}capabilities`)}, ${q(`${WORDPRESS_PREFIX}user_level`)});` +
          ` ${meta('capabilities', 'a:1:{s:13:"administrator";b:1;}')} ${meta('user_level', '10')}`,
      )
      return login
    },
  }
}

/** The line of the footer R1 adds and R3 looks for on production. */
const STACK_MARK = '<p class="stack-mark">Подвал: версия 1</p>'

/**
 * What a turn of R1 changes: the footer of the theme of the stand, the mark right before its
 * `</footer>`, a line appended to its style, and a new file of translations of the theme. The new
 * file is what makes the release a new feature: R3 expects `v0.1.0` over `v0.0.0`, and a candidate
 * without an added file is a fix (`proposeBump`, Р26) — `v0.0.1`.
 */
function wordpressEdit() {
  return {
    // The theme is the stand's, not the supply's: R1 finds its footer in the import (v0.0.0).
    template: {
      path: `${THEME}/footer.php`,
      before: '</footer>',
      line: STACK_MARK,
      fromImport: true,
    },
    style: { path: `${THEME}/style.css`, line: '.stack-mark { color: #1f6f43; }', created: false },
    texts: { path: `${THEME}/languages/ru_RU.po`, line: '# Подвал: версия 1', created: true },
  }
}

/** One value of wp-config.php of the production, read inside its container. */
async function configValue(production, name) {
  const text = await production.exec(['cat', `${ROOT}/wp-config.php`])
  const value = new RegExp(`define\\(\\s*'${name}',\\s*'([^']*)'\\s*\\)`).exec(text)?.[1]
  if (!value) throw new Error(`wp-config.php: no ${name}`)
  return value
}

/**
 * What WordPress gives the stand of the site stacks (stacks.mjs; docs/plan/62-slices/e3.md,
 * Э3.15), in the fields `joomlaStand` names. `refusedLayout` and `refusedVersion` are null: the
 * adapter reads no layout and refuses no version, so neither I4 nor I5 runs. `factsOf` is empty:
 * without a layout the import writes only the version, and a stack without generations none.
 */
export const wordpressStand = Object.freeze({
  stack: 'wordpress',
  builds: WORDPRESS_BUILDS,
  // prod/entry.sh makes the database `site` and its user `site` for every stack.
  database: Object.freeze({ name: 'site', user: 'site', prefix: WORDPRESS_PREFIX }),
  async install(production) {
    await installWordpress(production, { productionOrigin: production.origin })
    const seeded = await production.sql(wordpressSeedSql(WORDPRESS_PREFIX))
    if (seeded.trim().split('\n').at(-1) !== '1')
      throw new Error('The seed of WordPress found no administrator, no record or no draft')
    // The control of the search of P3: production holds every mark it looks for in the copy.
    const held = await wordpressMarksIn(production.sql)
    const missing = WORDPRESS_CANARIES.filter((mark) => !held?.includes(mark))
    if (missing.length > 0)
      throw new Error(`The production of WordPress lacks ${missing.length} marks of the seed`)
  },
  markersInRepository: () => ['wp-includes/version.php', `${THEME}/style.css`],
  absentFromRepository: Object.freeze(['wp-config.php', 'wp-content/cache/', '.htaccess']),
  /** DB_PASSWORD and the eight keys and salts of wp-config.php, as the production holds them. */
  secrets: async (production) => [
    await configValue(production, 'DB_PASSWORD'),
    ...(await Promise.all(KEY_NAMES.map((name) => configValue(production, name)))),
  ],
  page: () => ({ path: `/${WORDPRESS_SEED.recordSlug}/`, text: WORDPRESS_SEED.recordText }),
  factsOf: () => ({}),
  refusedLayout: null,
  refusedVersion: null,
  /** P3: what the copy of a preview holds, a row per check, by SQL as root of its database. */
  copyChecks: wordpressCopyChecks,
  /** P4: pages of the panel and the list of the media library are closed; an image is open. */
  browserPaths: Object.freeze({
    closed: Object.freeze(['/wp-admin/users.php', '/wp-admin/plugins.php', '/wp-json/wp/v2/media']),
    open: `/${WORDPRESS_SEED.image}`,
  }),
  /** P5: the sign-in to the panel in the cabinet's frame. */
  signIn: wordpressSignIn,
  /** R1, R6: the footer of the theme of the stand, its style and a new file of its translations. */
  edit: wordpressEdit,
  /** R2: a file a turn may not add — the core, outside the working set. */
  outsideWorkingSet: 'wp-includes/stack-verify.php',
  /** R4: a call that fails where the preview's constant is not defined — on production only. */
  breakOnProduction: () =>
    "<?php if (!defined('RADITI_PREVIEW_ORIGIN')) { raditi_stack_verify_missing(); } ?>",
})
