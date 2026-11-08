import assert from 'node:assert/strict'
import { test } from 'node:test'

import { workingSetMatcher } from '../../../packages/domain/src/index.ts'
import { wordpressAgentWorkingSet } from '../../../packages/site-adapters/src/wordpress-working-set.ts'
import { wordpressAdapter } from '../../../packages/site-adapters/src/wordpress.ts'
import { CMS_ARCHIVES } from './fetch-cms.mjs'
import { standProblems } from './stand.mjs'
import {
  STAND_THEME,
  STAND_THEME_FILES,
  WORDPRESS_BUILDS,
  WORDPRESS_CANARIES,
  WORDPRESS_SEED,
  WORDPRESS_TEXT_COLUMNS_SQL,
  wordpressConfig,
  wordpressCopyChecks,
  wordpressMarksIn,
  wordpressSeedSql,
  wordpressStand,
} from './wordpress.mjs'

const [build] = WORDPRESS_BUILDS

test('the build of WordPress is the release the platform runs, with no generation', () => {
  // docs/plan/62-slices/e3.md, Э3.15: the stack has no table of generations, so the build names none.
  assert.deepEqual(WORDPRESS_BUILDS, [
    { archive: 'wordpress-7.1.2', php: '8.3', generation: null, version: '7.1.2' },
  ])
  const row = CMS_ARCHIVES['wordpress-7.1.2']
  assert.equal(row.stack, 'wordpress')
  assert.equal(row.php, '8.3')
  assert.equal(row.url, 'https://wordpress.org/wordpress-7.1.2.tar.gz')
  assert.equal(row.license, 'GPL-2.0-or-later')
  // The release unpacks into `wordpress/`; wordpress.org publishes no sha256 of it.
  assert.equal(row.tree, 'wordpress')
  assert.equal(row.sha256Source, 'first_download')
  assert.equal(wordpressAdapter.support.generations.length, 0)
  assert.equal(wordpressStand.stack, 'wordpress')
  assert.deepEqual(standProblems(wordpressStand), [])
})

test('R1–R6 edit the theme of the stand, inside the working set of the agent', () => {
  const inSet = workingSetMatcher(wordpressAgentWorkingSet())
  const edit = wordpressStand.edit(build)
  assert.equal(edit.template.path, `wp-content/themes/${STAND_THEME}/footer.php`)
  assert.equal(edit.style.path, `wp-content/themes/${STAND_THEME}/style.css`)
  // A new file of the theme: R3 expects the minor number v0.1.0, which a candidate without an
  // added file does not get (proposeBump).
  assert.equal(edit.texts.path, `wp-content/themes/${STAND_THEME}/languages/ru_RU.po`)
  assert.equal(edit.texts.created, true)
  assert.ok(!Object.hasOwn(STAND_THEME_FILES, 'languages/ru_RU.po'))
  // The footer of the theme holds its tag once, and the style is there before the turn.
  const footer = STAND_THEME_FILES['footer.php']
  assert.equal(footer.split(edit.template.before).length - 1, 1)
  assert.equal(edit.style.created, false)
  assert.ok(Object.hasOwn(STAND_THEME_FILES, 'style.css'))
  assert.equal(edit.template.line, '<p class="stack-mark">Подвал: версия 1</p>')
  // The footer is the stand's theme, not the supply's: R1 reads it in the import, not the archive.
  assert.equal(edit.template.fromImport, true)
  for (const part of [edit.template, edit.style, edit.texts])
    assert.ok(inSet(part.path), `${part.path} is in the working set`)
  // R2: a file of the core, outside the working set and under a protected path.
  assert.equal(wordpressStand.outsideWorkingSet, 'wp-includes/stack-verify.php')
  assert.ok(!inSet(wordpressStand.outsideWorkingSet))
  assert.ok(
    wordpressAdapter
      .protectedPaths()
      .some((path) => wordpressStand.outsideWorkingSet.startsWith(path)),
  )
  // R4: what breaks production only — the preview of WordPress defines the constant.
  const broken = wordpressStand.breakOnProduction(build)
  assert.match(broken, /RADITI_PREVIEW_ORIGIN/)
  assert.match(broken, /^<\?php .* \?>$/)
})

test('the theme of the stand is a classic theme of four files that draws its footer', () => {
  // A block theme of the supply has no file of the footer (Э3.15): the stand brings its own.
  assert.deepEqual(Object.keys(STAND_THEME_FILES).toSorted(), [
    'footer.php',
    'header.php',
    'index.php',
    'style.css',
  ])
  assert.match(STAND_THEME_FILES['style.css'], /^\/\*\nTheme Name: /)
  assert.match(STAND_THEME_FILES['index.php'], /get_header\(\);[\s\S]*get_footer\(\);/)
  // wp_head prints the canonical link of a singular page — what the control of P2 looks for.
  assert.match(STAND_THEME_FILES['header.php'], /wp_head\(\)/)
  assert.match(STAND_THEME_FILES['footer.php'], /wp_footer\(\)/)
  assert.deepEqual(wordpressStand.markersInRepository(build), [
    'wp-includes/version.php',
    `wp-content/themes/${STAND_THEME}/style.css`,
  ])
  assert.deepEqual(wordpressStand.page(build), {
    path: `/${WORDPRESS_SEED.recordSlug}/`,
    text: WORDPRESS_SEED.recordText,
  })
})

test('the configuration of the production replaces every placeholder of the sample once', () => {
  const sample = [
    "define( 'DB_NAME', 'database_name_here' );",
    "define( 'DB_USER', 'username_here' );",
    "define( 'DB_PASSWORD', 'password_here' );",
    "define( 'DB_HOST', 'localhost' );",
    ...['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY'].map(
      (name) => `define( '${name}', 'put your unique phrase here' );`,
    ),
    ...['AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'].map(
      (name) => `define( '${name}', 'put your unique phrase here' );`,
    ),
    "$table_prefix = 'wp_';",
    "define( 'WP_DEBUG', false );",
    "if ( ! defined( 'ABSPATH' ) ) {",
  ].join('\n')
  const keys = Array.from({ length: 8 }, (_, index) => `key${index}`)
  const config = wordpressConfig(sample, { password: 'pw1', keys })
  assert.match(config, /define\( 'DB_NAME', 'site' \);/)
  assert.match(config, /define\( 'DB_USER', 'site' \);/)
  assert.match(config, /define\( 'DB_PASSWORD', 'pw1' \);/)
  assert.match(config, /define\( 'DB_HOST', '127\.0\.0\.1' \);/)
  assert.doesNotMatch(config, /put your unique phrase here/)
  for (const key of keys) assert.equal(config.split(`'${key}'`).length - 1, 1, key)
  // No cron of WordPress on the production: no request of the site to itself on a page.
  assert.match(config, /define\( 'DISABLE_WP_CRON', true \);\n.*WP_DEBUG/)
  // A sample of another form stops the install, not a production on a half-written configuration.
  assert.throws(
    () => wordpressConfig(sample.replace('password_here', 'x'), { password: 'pw1', keys }),
    /password_here/,
  )
  assert.throws(() => wordpressConfig(sample, { password: 'pw1', keys: keys.slice(1) }), /8 keys/)
})

test('the seed marks what no copy holds: a person, a comment, a secret, a draft password', () => {
  const seed = wordpressSeedSql('wp_')
  for (const canary of WORDPRESS_CANARIES) assert.ok(seed.includes(canary), canary)
  // A comment of a person, a mark in the profile of the author, an option of a secret beside a
  // widget named as none, the name of the administrator and the password of the draft.
  assert.match(seed, /INSERT INTO `wp_comments`/)
  assert.match(seed, /INSERT INTO `wp_usermeta`/)
  assert.match(
    seed,
    /'widget_raditi_stand_token', 'canary-wp-token-[^']+', 'off'\), \('widget_raditi_stand_title'/,
  )
  assert.match(seed, /display_name = 'Канарейкин Администратор Сайта'/)
  assert.match(seed, /SET post_password = 'canary-draft-pass-7e2c' WHERE post_name = 'stand-draft'/)
  // The last line answers 1 only when the administrator, the record and the draft were found.
  assert.match(seed.trim().split('\n').at(-1), /^SELECT .* AND ROW_COUNT\(\) = 1;$/)
})

/**
 * A preview's database as P3 reads it, by the query: `copy` says what it holds, a healthy copy
 * by default. A query the checks do not make fails the test.
 */
function copyDatabase(copy = {}) {
  const state = {
    users: [['user5', 'user5@preview.invalid']],
    comments: 0,
    others: 0,
    platform: 3,
    pages: 2,
    drafts: ['draft|'],
    secret: 0,
    widget: 1,
    adminEmail: 'admin@preview.invalid',
    blogPublic: '0',
    columns: ['wp_posts|post_content', 'wp_users|display_name', 'wp_options|option_value'],
    marks: [],
    ...copy,
  }
  return async (query) => {
    if (query === WORDPRESS_TEXT_COLUMNS_SQL) return `${state.columns.join('\n')}\n`
    if (query.includes('UNHEX(')) {
      const hex = /UNHEX\('([0-9A-F]+)'\)/.exec(query)[1]
      const mark = Buffer.from(hex, 'hex').toString('utf8')
      assert.ok(WORDPRESS_CANARIES.includes(mark), mark)
      // Every listed column is searched.
      for (const row of state.columns) assert.ok(query.includes(`\`${row.split('|')[1]}\``), row)
      return state.marks.includes(mark) ? '1\n' : '0\n'
    }
    if (query.startsWith("SELECT CONCAT(user_login, '|', user_email)"))
      return state.users.map((row) => row.join('|')).join('\n')
    if (query === 'SELECT COUNT(*) FROM `wp_comments`') return `${state.comments}\n`
    if (query.includes('`wp_usermeta` m LEFT JOIN')) return `${state.others}\n`
    if (query.includes('`wp_usermeta` m JOIN')) return `${state.platform}\n`
    if (query.includes("post_status = 'publish'")) return `${state.pages}\n`
    if (query.startsWith("SELECT CONCAT(post_status, '|', post_password)"))
      return state.drafts.join('\n')
    if (query.endsWith("option_name = 'widget_raditi_stand_token'")) return `${state.secret}\n`
    if (query.endsWith("option_name = 'widget_raditi_stand_title'")) return `${state.widget}\n`
    if (query.endsWith("option_name = 'admin_email'")) return `${state.adminEmail}\n`
    if (query.endsWith("option_name = 'blog_public'")) return `${state.blogPublic}\n`
    throw new Error(`P3 made a query the test does not know: ${query}`)
  }
}

test('P3 passes a healthy copy and fails exactly the check a leak breaks', async () => {
  const healthy = await wordpressCopyChecks(copyDatabase())
  assert.equal(wordpressStand.copyChecks, wordpressCopyChecks)
  assert.equal(healthy.length, 8)
  assert.deepEqual(
    healthy.filter((check) => !check.ok).map((check) => check.name),
    [],
  )
  const named = (pattern) => healthy.find((check) => pattern.test(check.name)).name
  const breaks = [
    // A profile of a person beside the platform's, and the platform's own gone.
    [{ others: 1 }, /usermeta holds only/],
    [{ platform: 0 }, /usermeta holds only/],
    [{ comments: 1 }, /comments is empty/],
    [{ users: [['user5', 'kanareykin.admin@people.example']] }, /authors of the copy/],
    [{ users: [[WORDPRESS_SEED.adminLogin, 'user5@preview.invalid']] }, /authors of the copy/],
    [{ users: [] }, /authors of the copy/],
    [{ pages: 1 }, /published record/],
    [{ drafts: [] }, /the draft is in the copy/],
    [{ drafts: ['draft|canary-draft-pass-7e2c'] }, /the draft is in the copy/],
    [{ secret: 1 }, /widget named as a secret/],
    // The control: the copy took no widget at all.
    [{ widget: 0 }, /widget named as a secret/],
    [{ adminEmail: 'kanareykin.admin@people.example' }, /address of the admin/],
    [{ blogPublic: '1' }, /address of the admin/],
    // The name of the administrator kept in display_name, or a search that saw no column.
    [{ marks: ['Канарейкин Администратор Сайта'] }, /no mark of the seed/],
    [{ marks: ['Комментарий-канарейка 7e2c'] }, /no mark of the seed/],
    [{ columns: [] }, /no mark of the seed/],
  ]
  for (const [copy, pattern] of breaks) {
    const checks = await wordpressCopyChecks(copyDatabase(copy))
    assert.deepEqual(
      checks.filter((check) => !check.ok).map((check) => check.name),
      [named(pattern)],
      JSON.stringify(copy),
    )
  }
})

test('the search of marks reads every text column by bytes and refuses a strange name', async () => {
  assert.match(WORDPRESS_TEXT_COLUMNS_SQL, /TABLE_SCHEMA = DATABASE\(\)/)
  assert.match(WORDPRESS_TEXT_COLUMNS_SQL, /'longtext'/)
  assert.deepEqual(await wordpressMarksIn(copyDatabase()), [])
  assert.equal(await wordpressMarksIn(copyDatabase({ columns: [] })), null)
  // The production of the install holds every mark: the control of the search.
  assert.deepEqual(await wordpressMarksIn(copyDatabase({ marks: [...WORDPRESS_CANARIES] })), [
    ...WORDPRESS_CANARIES,
  ])
  await assert.rejects(
    wordpressMarksIn(copyDatabase({ columns: ['wp_posts|post`content'] })),
    /not a plain name/,
  )
})

test('P5 signs in to the panel of WordPress as the author of the copy', async () => {
  const sign = wordpressStand.signIn(build)
  // The panel is the path of the sign-in: unsigned, /wp-admin/ sends the frame to wp-login.php.
  assert.equal(sign.path, '/wp-admin/')
  assert.deepEqual(sign.fields, { login: '#user_login', password: '#user_pass' })
  assert.equal(sign.submit, '#wp-submit')
  assert.equal(sign.signedIn, '#wpadminbar')
  for (const words of ['is incorrect', 'Cookies are blocked'])
    assert.ok(sign.lostCookie.includes(words), words)
  // The author of the record of the seed is the one asked for: a login comes back only to a join
  // of the record's author, and any other SELECT answers nothing.
  const authorOfRecord = (query) =>
    query.includes('JOIN `wp_posts` p ON p.post_author = u.ID') &&
    query.includes("p.post_name = 'stand-record'") &&
    query.includes("p.post_type = 'post'")
  const queries = []
  const login = await sign.setPassword(async (query) => {
    queries.push(query)
    return query.startsWith('SELECT') && authorOfRecord(query) ? 'user5\n' : ''
  }, 'secret-of-the-run')
  assert.equal(login, 'user5')
  assert.ok(authorOfRecord(queries[0]), queries[0])
  const [, update] = queries
  assert.match(update, /WHERE user_login = 'user5'/)
  // The hash WordPress still reads and rehashes at the sign-in; the author made an administrator.
  assert.match(update, /user_pass = MD5\('secret-of-the-run'\)/)
  assert.match(update, /wp_capabilities/)
  assert.match(update, /administrator/)
  await assert.rejects(
    sign.setPassword(async () => '', 'x'),
    /no author/,
  )
})
