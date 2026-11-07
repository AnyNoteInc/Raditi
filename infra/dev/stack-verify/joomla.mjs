// Joomla on the synthetic production of a stand of the site stacks (docs/plan/62-slices/e3.md,
// Э3.8, Э3.9): the builds the stand runs, the install without a browser, and the synthetic content a copy
// is judged by — a published article with an alias and a menu item, a draft, and values that mark
// what no preview may hold (people, their contacts and tokens, the secrets of the configuration).
// Only synthetic data. The core of Joomla runs in the container of the production only: this file
// is the stand's, the downloaded tree is not.
import { createHash, randomBytes } from 'node:crypto'

/**
 * A build of a stand: a row of cms-archives.json and the `site` image of its PHP. `absolutePageLinks`
 * — the pages of the build link to the site by absolute addresses (`<base href>` of 3.x); those of
 * 4.0 and later link relatively (docs/plan/62-site-stacks.md, §10, Э3.9). A fact of the build, so the
 * test of the preview asks it and compares no branch.
 */
export const JOOMLA_BUILDS = [
  {
    archive: 'joomla-3.10.12',
    php: '7.4',
    generation: 'j3',
    version: '3.10.12',
    absolutePageLinks: true,
  },
  {
    archive: 'joomla-4.4.14',
    php: '8.1',
    generation: 'j4',
    version: '4.4.14',
    absolutePageLinks: false,
  },
  {
    archive: 'joomla-5.4.10',
    php: '8.3',
    generation: 'j5',
    version: '5.4.10',
    absolutePageLinks: false,
  },
  {
    archive: 'joomla-6.2.0',
    php: '8.3',
    generation: 'j6',
    version: '6.2.0',
    absolutePageLinks: false,
  },
]

/** The prefix of the tables of the production. */
export const JOOMLA_PREFIX = 'jos_'
/** A setting of the SEF plugin the plugin does not read: what a copy must keep beside `domain`. */
const SEF_KEPT_KEY = 'raditiStandKept'
export const JOOMLA_SEF_KEPT = 'kept-41c7'
/** The webroot of the production container. */
const ROOT = '/var/www/html'

/** What the seed writes, by the ids a test asks for. */
export const JOOMLA_SEED = Object.freeze({
  /** Above 1000: the installer of 4.0 and later gives its superuser a random id of 1–1000. */
  authorId: 1900,
  articleId: 50,
  draftId: 51,
  menuId: 150,
  contactId: 50,
  fieldId: 50,
  articleTitle: 'О компании — стенд Радити',
  /** The full text of the article: only its own page shows it, never the featured blog of `/`. */
  articleFullText: 'Полный текст статьи стенда Радити 7d2e',
  articleAlias: 'o-kompanii',
  /** The address of the article by its menu item, with SEF rewriting on. */
  articlePath: '/o-kompanii',
  /**
   * An image of the core the intro text points to by a relative address: the Atom feed makes it
   * absolute from `Uri::base()`, which takes `$live_site` — the one link a preview that took the
   * production's `$live_site` would point at production with (_relToAbs of DocumentRenderer).
   */
  introImage: 'images/joomla_black.png',
  sitename: 'Стенд Joomla Радити',
})

/** Values of the configuration of the production that a preview never holds. */
export const JOOMLA_CONFIG_CANARIES = Object.freeze({
  smtppass: 'canary-smtp-pass-41c7a9',
  secret: 'canarysecret41c7',
})

const canary = Object.freeze({
  authorName: 'Канарейкин Автор Статьи',
  authorLogin: 'kanareykin-author',
  authorEmail: 'kanareykin.author@people.example',
  createdByAlias: 'Канарейкина Подпись Автора',
  metadataAuthor: 'Канарейкин Метаданные Записи',
  articleNote: 'Заметка-канарейка 41c7',
  draftTitle: 'Черновик-канарейка 41c7',
  draftText: 'Текст черновика-канарейки 41c7',
  contactName: 'Канарейкин Контакт Сайта',
  contactEmail: 'kanareykin.contact@people.example',
  contactPhone: '+7 900 555-41-07',
  downloadKey: 'canarydlid41c7a9b0c1d2e3f4a5b6c7d8',
  userToken: 'canary-joomlatoken-41c7a9b0c1d2e3f4',
  userField: 'Канарейкин Значение Поля Пользователя',
  sessionData: 'Канарейкин Данные Сеанса 41c7',
})

/**
 * A file the install leaves under `installation/` on the production: harmless to Joomla (3.x sends
 * a visitor to the installer only for `installation/index.php`), and it is what the import rules
 * must drop — without it the folder is gone before the import and the rule is never exercised.
 */
export const JOOMLA_INSTALLATION_MARKER = 'installation/raditi-stand.txt'

/** Values of the seed that no copy holds: none of them may reach a preview's database. */
export const JOOMLA_CANARIES = Object.freeze(Object.values(canary))

/** 3.x is one schema, 4.0 and later another: no `xreference`, nullable dates, a nested set of taxonomy. */
const isBranch3 = (build) => build.generation === 'j3'

const versionAtLeast = (version, floor) => {
  const [a = 0, b = 0] = version.split('.').map(Number)
  const [c = 0, d = 0] = floor.split('.').map(Number)
  return a !== c ? a > c : b >= d
}

/** An SQL text literal: the values above are constants, quoted all the same. */
const q = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`

/** `public $name = …;` of a configuration set to a string, the property set once and only once. */
export function withProperty(text, name, value) {
  const property = new RegExp(`(\\bpublic[ \\t]+\\$${name})[ \\t]*=[^;\\n]*;`, 'g')
  const found = text.match(property)?.length ?? 0
  if (found !== 1) throw new Error(`configuration: $${name} is set ${found} times`)
  const literal = `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  return text.replace(property, (_, head) => `${head} = ${literal};`)
}

/**
 * Installs Joomla without a browser on the production of a stand. 3.10: the SQL of
 * `installation/sql/mysql/joomla.sql` with `#__` replaced, and `configuration.php` from
 * `configuration.php-dist`; from 4.3: `php installation/joomla.php install`. Then `installation/`
 * goes but for JOOMLA_INSTALLATION_MARKER, `htaccess.txt` becomes `.htaccess`, `sef_rewrite` is 1,
 * and `$live_site` and the address of the canonical links of the SEF plugin (`params.domain`) are
 * the production's own origin, where a broken preview would show it. The
 * password of the database is read from the container's own file, never written here.
 */
export async function installJoomla(production, build, { productionOrigin } = {}) {
  if (typeof productionOrigin !== 'string' || new URL(productionOrigin).origin !== productionOrigin)
    throw new Error('installJoomla: productionOrigin is the origin of the production')
  const password = (await production.exec(['cat', '/prod-secrets/db'])).trim()
  let configuration
  if (isBranch3(build)) {
    const schema = await production.exec(['cat', `${ROOT}/installation/sql/mysql/joomla.sql`])
    await production.sql(schema.replaceAll('#__', JOOMLA_PREFIX))
    configuration = await production.exec(['cat', `${ROOT}/installation/configuration.php-dist`])
    configuration = withProperty(configuration, 'host', '127.0.0.1')
    configuration = withProperty(configuration, 'user', 'site')
    configuration = withProperty(configuration, 'password', password)
    configuration = withProperty(configuration, 'db', 'site')
    configuration = withProperty(configuration, 'dbprefix', JOOMLA_PREFIX)
    configuration = withProperty(configuration, 'sef_rewrite', '1')
    configuration = withProperty(configuration, 'tmp_path', `${ROOT}/tmp`)
    configuration = withProperty(configuration, 'log_path', `${ROOT}/administrator/logs`)
  } else if (versionAtLeast(build.version, '4.3')) {
    await production.exec([
      'sh',
      '-c',
      [
        `cd ${ROOT}`,
        'setpriv --reuid=33 --regid=33 --clear-groups php installation/joomla.php install' +
          ` --site-name=${q(JOOMLA_SEED.sitename)} --admin-user='Stand Admin'` +
          " --admin-username=standadmin --admin-password='stand-admin-not-a-person'" +
          ' --admin-email=admin@stand.invalid --db-type=mysqli --db-host=127.0.0.1' +
          ' --db-user=site --db-pass="$(cat /prod-secrets/db)" --db-name=site' +
          ` --db-prefix=${JOOMLA_PREFIX} --db-encryption=0 --no-interaction`,
      ].join(' && '),
    ])
    configuration = await production.exec(['cat', `${ROOT}/configuration.php`])
    configuration = withProperty(configuration, 'sef_rewrite', '1')
  } else {
    throw new Error(`Joomla ${build.version} has no installer without a browser`)
  }
  configuration = withProperty(configuration, 'sitename', JOOMLA_SEED.sitename)
  configuration = withProperty(configuration, 'live_site', productionOrigin)
  configuration = withProperty(configuration, 'secret', JOOMLA_CONFIG_CANARIES.secret)
  configuration = withProperty(configuration, 'smtppass', JOOMLA_CONFIG_CANARIES.smtppass)
  await production.exec(['sh', '-c', `cat > ${ROOT}/configuration.php`], configuration)
  // The address of the canonical links of the SEF plugin is the production's own (Э3.11): a copy
  // that kept it would name production in `<link rel="canonical">` of every page. 3.10 installs
  // the plugin with empty `params`, 4.0 and later with JSON. A key the plugin does not read beside
  // it: the copy blanks the address and keeps the rest of the settings.
  await production.sql(
    `UPDATE \`${JOOMLA_PREFIX}extensions\` SET params = IF(JSON_VALID(params) AND` +
      ` JSON_TYPE(params) = 'OBJECT', JSON_SET(params, '$.domain', ${q(productionOrigin)},` +
      ` '$.${SEF_KEPT_KEY}', ${q(JOOMLA_SEF_KEPT)}), JSON_OBJECT('domain', ${q(productionOrigin)},` +
      ` ${q(SEF_KEPT_KEY)}, ${q(JOOMLA_SEF_KEPT)})) WHERE name = 'plg_system_sef';\n`,
  )
  await production.exec([
    'sh',
    '-c',
    `cd ${ROOT} && rm -rf installation && mkdir installation &&` +
      ` echo 'Left by the stand: the import rules drop it.' > ${JOOMLA_INSTALLATION_MARKER} &&` +
      ` cp htaccess.txt .htaccess && chown -R 33:33 ${ROOT}`,
  ])
}

/** The indexer of Smart Search from the command line: a script of its own on 3.x, the console since 4.0. */
export function joomlaIndexerArgv(build) {
  return isBranch3(build)
    ? ['php', `${ROOT}/cli/finder_indexer.php`]
    : ['php', `${ROOT}/cli/joomla.php`, 'finder:index']
}

/**
 * The synthetic content of the production, as SQL with the prefix: a published article in
 * «Uncategorised» with an alias, a full text only its own page shows, a menu item and its place on the front page (with its row of
 * `workflow_associations` on 4.0 and later), a draft, and the marks: `created_by_alias` and
 * `metadata` of the article, a leaf of the branch Author of `finder_taxonomy`, a row of
 * `contact_details`, `update_sites.extra_query` with a `dlid=`, `user_profiles` with
 * `joomlatoken.token`, a value of a field of `com_users.user` in `fields_values`, a row of
 * `session` of the author.
 */
export function joomlaSeedSql(prefix, build) {
  const t = (name) => `\`${prefix}${name}\``
  const s = JOOMLA_SEED
  const branch3 = isBranch3(build)
  const category = `(SELECT id FROM ${t('categories')} WHERE extension = 'com_content' AND alias = 'uncategorised')`
  const component = `(SELECT extension_id FROM ${t('extensions')} WHERE type = 'component' AND element = 'com_content')`
  const article = (id, state, title, alias, text, featured, fullText = '') =>
    `INSERT INTO ${t('content')} (id, asset_id, title, alias, introtext, \`fulltext\`, state, catid,` +
    ' created, created_by, created_by_alias, modified, modified_by, publish_up, images, urls,' +
    ' attribs, version, ordering, metakey, metadesc, access, hits, metadata, featured, language,' +
    ` note) VALUES (${id}, 0, ${q(title)}, ${q(alias)}, ${q(`<p>${text}</p>`)},` +
    ` ${q(fullText && `<p>${fullText}</p>`)}, ${state},` +
    ` ${category}, NOW(), ${s.authorId}, ${q(canary.createdByAlias)}, NOW(), ${s.authorId}, NOW(),` +
    ` '{}', '{}', '{}', 1, 0, '', '', 1, 0,` +
    ` ${q(JSON.stringify({ robots: '', author: canary.metadataAuthor, rights: '' }))},` +
    ` ${featured}, '*', ${q(canary.articleNote)});`
  const lines = [
    `INSERT INTO ${t('users')} (id, name, username, email, password, block, sendEmail,` +
      ' registerDate, lastvisitDate, activation, params, lastResetTime, resetCount, otpKey, otep,' +
      ` requireReset) VALUES (${s.authorId}, ${q(canary.authorName)}, ${q(canary.authorLogin)},` +
      ` ${q(canary.authorEmail)}, 'stand-not-a-password-hash', 0, 0, NOW(), NOW(), '', '{}',` +
      " NOW(), 0, '', '', 0);",
    `INSERT INTO ${t('user_usergroup_map')} (user_id, group_id) VALUES (${s.authorId}, 3);`,
    article(
      s.articleId,
      1,
      s.articleTitle,
      s.articleAlias,
      `Синтетическая страница стенда: о компании. <img src="${s.introImage}" alt="">`,
      1,
      s.articleFullText,
    ),
    article(s.draftId, 0, canary.draftTitle, 'chernovik-kanareyka', canary.draftText, 0),
    `INSERT INTO ${t('content_frontpage')} (content_id, ordering) VALUES (${s.articleId}, 1);`,
    // The item of the main menu, the last child of the root of the nested set.
    `SELECT rgt INTO @raditi_root FROM ${t('menu')} WHERE id = 1;`,
    `INSERT INTO ${t('menu')} (id, menutype, title, alias, note, path, link, type, published,` +
      ' parent_id, level, component_id, browserNav, access, img, template_style_id, params, lft,' +
      ` rgt, home, language, client_id) VALUES (${s.menuId}, 'mainmenu', ${q(s.articleTitle)},` +
      ` ${q(s.articleAlias)}, '', ${q(s.articleAlias)},` +
      ` ${q(`index.php?option=com_content&view=article&id=${s.articleId}`)}, 'component', 1, 1, 1,` +
      ` ${component}, 0, 1, '', 0, '{}', @raditi_root, @raditi_root + 1, 0, '*', 0);`,
    `UPDATE ${t('menu')} SET rgt = @raditi_root + 2 WHERE id = 1;`,
    // A leaf of the branch Author: the name of a person, which no copy keeps.
    ...(branch3
      ? [
          `INSERT INTO ${t('finder_taxonomy')} (parent_id, title, state, access, ordering)` +
            " VALUES (1, 'Author', 1, 1, 0);",
          'SET @raditi_branch = LAST_INSERT_ID();',
          `INSERT INTO ${t('finder_taxonomy')} (parent_id, title, state, access, ordering)` +
            ` VALUES (@raditi_branch, ${q(canary.authorName)}, 1, 1, 0);`,
        ]
      : [
          `SELECT rgt INTO @raditi_root FROM ${t('finder_taxonomy')} WHERE id = 1;`,
          `INSERT INTO ${t('finder_taxonomy')} (parent_id, lft, rgt, level, path, title, alias,` +
            " state, access, language) VALUES (1, @raditi_root, @raditi_root + 3, 1, 'author'," +
            " 'Author', 'author', 1, 1, '*');",
          'SET @raditi_branch = LAST_INSERT_ID();',
          `INSERT INTO ${t('finder_taxonomy')} (parent_id, lft, rgt, level, path, title, alias,` +
            ' state, access, language) VALUES (@raditi_branch, @raditi_root + 1, @raditi_root + 2,' +
            ` 2, 'author/kanareykin', ${q(canary.authorName)}, 'kanareykin', 1, 1, '*');`,
          `UPDATE ${t('finder_taxonomy')} SET rgt = @raditi_root + 4 WHERE id = 1;`,
          // The basic stage of the basic workflow, as the installer makes it.
          ...[s.articleId, s.draftId].map(
            (id) =>
              `INSERT INTO ${t('workflow_associations')} (item_id, stage_id, extension)` +
              ` VALUES (${id}, 1, 'com_content.article');`,
          ),
        ]),
    `INSERT INTO ${t('contact_details')} (id, name, alias, con_position, address, telephone,` +
      ' email_to, published, params, user_id, catid, access, language, created, created_by,' +
      ' modified, metakey, metadesc, metadata) VALUES' +
      ` (${s.contactId}, ${q(canary.contactName)}, 'kanareykin-kontakt', '', '',` +
      ` ${q(canary.contactPhone)}, ${q(canary.contactEmail)}, 1, '{}', ${s.authorId}, 0, 1, '*',` +
      ` NOW(), ${s.authorId}, NOW(), '', '', '{}');`,
    `INSERT INTO ${t('update_sites')} (name, type, location, enabled, extra_query) VALUES` +
      " ('Stand extension', 'extension', 'https://updates.stand.invalid/list.xml', 1," +
      ` ${q(`dlid=${canary.downloadKey}`)});`,
    `INSERT INTO ${t('user_profiles')} (user_id, profile_key, profile_value, ordering) VALUES` +
      ` (${s.authorId}, 'joomlatoken.token', ${q(canary.userToken)}, 0);`,
    `INSERT INTO ${t('fields')} (id, context, title, name, label, type, description, state,` +
      ' params, fieldparams, language, created_time, modified_time, access) VALUES' +
      ` (${s.fieldId}, 'com_users.user', 'Отчество', 'otchestvo', 'Отчество', 'text', '', 1,` +
      " '{}', '{}', '*', NOW(), NOW(), 1);",
    `INSERT INTO ${t('fields_values')} (field_id, item_id, value) VALUES` +
      ` (${s.fieldId}, '${s.authorId}', ${q(canary.userField)});`,
    // A session of the author on the site, as a visit leaves one: a person and what it holds.
    `INSERT INTO ${t('session')} (session_id, client_id, guest, time, data, userid, username)` +
      " VALUES ('stand-session-41c7a9b0', 0, 0, UNIX_TIMESTAMP()," +
      ` ${q(`joomla|s:${Buffer.byteLength(canary.sessionData)}:"${canary.sessionData}";`)},` +
      ` ${s.authorId}, ${q(canary.authorLogin)});`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The row of the SEF plugin as one line `<rows>|<rows of valid JSON>|<domain>|<kept>`: on a
 * production `1|1|<its origin>|<JOOMLA_SEF_KEPT>`, on a copy `1|1||<JOOMLA_SEF_KEPT>` — the address
 * blanked, the row and its other settings kept. A missing row or key reads `0|x|NULL|NULL`.
 */
export const JOOMLA_SEF_SQL =
  "SELECT CONCAT(COUNT(*), '|', COALESCE(SUM(JSON_VALID(params)), 'x'), '|'," +
  " COALESCE(MAX(JSON_VALUE(params, '$.domain')), 'NULL'), '|'," +
  ` COALESCE(MAX(JSON_VALUE(params, '$.${SEF_KEPT_KEY}')), 'NULL'))` +
  ` FROM \`${JOOMLA_PREFIX}extensions\` WHERE name = 'plg_system_sef'`

/** What JOOMLA_SEF_SQL answers on a copy that blanked the address and kept the rest. */
export const JOOMLA_SEF_OF_COPY = `1|1||${JOOMLA_SEF_KEPT}`

/**
 * P3 of Joomla (docs/plan/62-slices/e3.md, Э3.11): the authors of the copy are synthetic, the
 * contacts and the profiles of people are empty, the draft is not there and the published article
 * is (the control), the page cache is not loaded and the SEF plugin names no address. `sql` — a
 * query as root of the preview's database, its answer as text; a row of the answer per check.
 */
async function joomlaCopyChecks(sql) {
  const t = (name) => `\`${JOOMLA_PREFIX}${name}\``
  const number = async (query) => Number((await sql(query)).trim())
  const authors = (await sql(`SELECT email FROM ${t('users')}`)).trim().split('\n').filter(Boolean)
  const checks = [
    {
      name: 'the authors of the copy are synthetic, at @preview.invalid',
      ok: authors.length > 0 && authors.every((email) => email.endsWith('@preview.invalid')),
      found: { authors: authors.length },
    },
  ]
  for (const table of ['contact_details', 'user_profiles']) {
    const rows = await number(`SELECT COUNT(*) FROM ${t(table)}`)
    checks.push({ name: `${table} is empty`, ok: rows === 0, found: { rows } })
  }
  const ofContent = (id) => number(`SELECT COUNT(*) FROM ${t('content')} WHERE id = ${id}`)
  const draft = await ofContent(JOOMLA_SEED.draftId)
  const article = await ofContent(JOOMLA_SEED.articleId)
  checks.push({
    name: 'the draft is not in the copy, the published article is',
    ok: draft === 0 && article === 1,
    found: { draft, article },
  })
  const cache = await number(
    `SELECT COUNT(*) FROM ${t('extensions')} WHERE name = 'plg_system_cache'`,
  )
  checks.push({ name: 'plg_system_cache is not in the copy', ok: cache === 0, found: { cache } })
  const [rows, valid, domain, kept] = (await sql(JOOMLA_SEF_SQL)).trim().split('|')
  checks.push({
    name: 'the SEF plugin of the copy names no address for its canonical links: one row of valid JSON, the address blank, its other settings kept',
    ok: [rows, valid, domain, kept].join('|') === JOOMLA_SEF_OF_COPY,
    found: { rows, valid, blank: domain === '', kept: kept === JOOMLA_SEF_KEPT },
  })
  return checks
}

/**
 * P5 of Joomla: the sign-in form of the administrator, the button (`.login-button` of 3.x), the
 * mark only the panel has once in — `header.header` of Isis on 3.x (its `login.php` has no
 * header), `#sidebarmenu` of Atum since 4.0 (its `login.php` has `#header` too, the menu only
 * `index.php`; checked on the trees of 4.4.14, 5.4.10 and 6.2.0) — and the texts after which the
 * sign-in did not hold: Joomla lost its cookie of the session, or refused the password
 * (JLIB_LOGIN_AUTHENTICATE).
 * `setPassword(rootSql, password)` makes the author of the copy a superuser with the stand's
 * password and gives the login: a copy keeps a random hash, and its author is no superuser. The
 * hash is the legacy `md5(password . salt):salt` every branch still reads (and rehashes at the
 * sign-in): SQL makes no bcrypt.
 */
function joomlaSignIn(build) {
  const t = (name) => `\`${JOOMLA_PREFIX}${name}\``
  return {
    path: '/administrator/',
    fields: { login: '#mod-login-username', password: '#mod-login-password' },
    submit: isBranch3(build) ? '.login-button' : '#btn-login-submit',
    signedIn: isBranch3(build) ? 'header.header' : '#sidebarmenu',
    lostCookie: [
      'Username and password do not match',
      'invalid security token',
      'security token did not match',
      'Cookies must be enabled',
      'Your session has expired',
    ],
    async setPassword(rootSql, password) {
      const id = JOOMLA_SEED.authorId
      const login = (await rootSql(`SELECT username FROM ${t('users')} WHERE id = ${id}`)).trim()
      if (!login) throw new Error('The copy holds no author to sign in as')
      const salt = randomBytes(16).toString('hex')
      const hash = `${createHash('md5').update(`${password}${salt}`).digest('hex')}:${salt}`
      await rootSql(
        `UPDATE ${t('users')} SET password = ${q(hash)}, block = 0, requireReset = 0` +
          ` WHERE id = ${id}; INSERT IGNORE INTO ${t('user_usergroup_map')} (user_id, group_id)` +
          ` VALUES (${id}, 8);`,
      )
      return login
    },
  }
}

/**
 * The template file each branch's release edits (Э3.12): Protostar on 3.x, Cassiopeia since 4.0.
 * An explicit list, not a search: R1 checks on the tree of the archive that the file is there.
 */
export const TEMPLATE_PATHS = Object.freeze({
  j3: 'templates/protostar/index.php',
  j4: 'templates/cassiopeia/index.php',
  j5: 'templates/cassiopeia/index.php',
  j6: 'templates/cassiopeia/index.php',
})

/** The line of the template R1 adds and R3 looks for on production. */
const STACK_MARK = '<p class="stack-mark">Подвал: версия 1</p>'

/**
 * What a turn of R1 changes (docs/plan/62-slices/e3.md, Э3.12). `template` — the file and the tag
 * the mark goes right before: `</footer>` of Protostar, `</body>` of Cassiopeia (its footer stands
 * inside `countModules('footer', true)` and is not drawn without a module). `style` — appended to:
 * the stylesheet of Protostar, or `user.css` of Cassiopeia, which the supply has not and the
 * template links itself (`template.user` of its joomla.asset.json) — `created` says the supply has
 * no such file. `texts` — an override of the texts, a new file: the supply holds only index.html
 * in `language/overrides/`.
 */
function joomlaEdit(build) {
  const template = TEMPLATE_PATHS[build.generation]
  if (!template) throw new Error(`No template of the branch ${build.generation}`)
  const branch3 = isBranch3(build)
  return {
    template: { path: template, before: branch3 ? '</footer>' : '</body>', line: STACK_MARK },
    style: {
      path: branch3
        ? 'templates/protostar/css/template.css'
        : 'media/templates/site/cassiopeia/css/user.css',
      line: '.stack-mark { color: #1f6f43; }',
      created: !branch3,
    },
    texts: {
      path: 'language/overrides/en-GB.override.ini',
      line: 'RADITI_STACK_MARK="Подвал: версия 1"',
      created: true,
    },
  }
}

/** The configuration of a production: the file the import must never take. */
const CONFIGURATION = `${ROOT}/configuration.php`

/** One value of the configuration of the production, read inside its container. */
async function configurationValue(production, name) {
  const text = await production.exec(['cat', CONFIGURATION])
  const value = new RegExp(`\\bpublic[ \\t]+\\$${name}[ \\t]*=[ \\t]*'([^']*)'`).exec(text)?.[1]
  if (!value) throw new Error(`configuration: no $${name}`)
  return value
}

/** The three folders a root of Joomla is recognised by, each with its empty page. */
const JOOMLA_MARKERS = Object.freeze(
  Object.fromEntries(
    ['administrator', 'libraries', 'plugins'].map((folder) => [
      `${folder}/index.html`,
      '<!DOCTYPE html><title></title>\n',
    ]),
  ),
)

/** The manifest of the files of Joomla that names its version. */
const joomlaManifest = (version) =>
  '<?xml version="1.0" encoding="utf-8"?>\n<extension type="file" method="upgrade">\n' +
  `  <name>files_joomla</name>\n  <version>${version}</version>\n</extension>\n`

/**
 * What Joomla gives the stand of the site stacks (stacks.mjs; docs/plan/62-slices/e3.md, Э3.10).
 * `install` — the install of the build, its seed and the installer gone; `markersInRepository` —
 * what `main` holds after the import, with the two classes the import rules must not cut on 4.0 and
 * later (Э3.3, discrepancy 3); `absentFromRepository` — what it never holds; `secrets` — the values
 * of the configuration that are nowhere on the platform; `factsOf`, `refusedLayout`, `refusedVersion` —
 * the fields of every stack the plan names `StackStandCases` (Э5.8), with the values of Joomla;
 * `scannerFinds` — whether the scanner drops files of the build (Т48); `copyChecks`, `browserPaths`
 * and `signIn` — the group `preview` (Э3.11); `edit`, `outsideWorkingSet` and `breakOnProduction` —
 * the group `release` (Э3.12).
 */
export const joomlaStand = Object.freeze({
  stack: 'joomla',
  builds: JOOMLA_BUILDS,
  database: Object.freeze({ name: 'site', user: 'site', prefix: JOOMLA_PREFIX }),
  async install(production, build) {
    await installJoomla(production, build, { productionOrigin: production.origin })
    await production.sql(joomlaSeedSql(JOOMLA_PREFIX, build))
    await production.exec(['test', '-f', `${ROOT}/${JOOMLA_INSTALLATION_MARKER}`])
  },
  markersInRepository: (build) => [
    'index.php',
    'administrator/manifests/files/joomla.xml',
    'libraries/src/Version.php',
    ...(isBranch3(build)
      ? []
      : [
          'libraries/vendor/joomla/application/src/ConfigurationAwareApplicationInterface.php',
          'administrator/components/com_admin/src/Service/HTML/Configuration.php',
        ]),
  ],
  absentFromRepository: Object.freeze([
    'configuration.php',
    'installation/',
    'administrator/logs/',
    'cache/index.html',
    '.htaccess',
  ]),
  /** `$password`, `$secret` and `$smtppass` of the configuration, as the production holds them. */
  secrets: async (production) => [
    await configurationValue(production, 'password'),
    await configurationValue(production, 'secret'),
    await configurationValue(production, 'smtppass'),
  ],
  page: () => ({ path: JOOMLA_SEED.articlePath, text: JOOMLA_SEED.articleFullText }),
  /** What I1 expects in `stack_facts` beside the version, the branch and the limit of the build. */
  factsOf: () => ({ adminPath: '/administrator/', extras: { sitename: JOOMLA_SEED.sitename } }),
  /**
   * The tree of I4: the markers, a manifest of a supported version, a configuration of MySQL and
   * `defines.php`, as a root of 5.0 and later that moved its public folder (Т13). With the
   * configuration there, `defines.php` is the only reason of `outside_root`.
   */
  refusedLayout: Object.freeze({
    files: Object.freeze({
      ...JOOMLA_MARKERS,
      'administrator/manifests/files/joomla.xml': joomlaManifest(JOOMLA_BUILDS.at(-1).version),
      'configuration.php':
        "<?php\nclass JConfig\n{\n\tpublic $dbtype = 'mysqli';\n\tpublic $sitename = 'Стенд';\n}\n",
      'defines.php': '<?php\n// Left by the stand: the root of a site whose public folder moved.\n',
    }),
    limit: 'outside_root',
  }),
  /** The tree of I5: the markers and a manifest of 2.5, refused before anything is written. */
  refusedVersion: Object.freeze({
    files: Object.freeze({
      ...JOOMLA_MARKERS,
      'administrator/manifests/files/joomla.xml': joomlaManifest('2.5.28'),
    }),
  }),
  /** Т48: Gitleaks drops files of `libraries/vendor` on 4.4, 5.4 and 6.2; the number is not pinned. */
  scannerFinds: (build) => !isBranch3(build),
  /** P3: what the copy of a preview holds, a row per check, by SQL as root of its database. */
  copyChecks: joomlaCopyChecks,
  /** P4: what the agent's browser may not open, and an image of the media library it may. */
  browserPaths: Object.freeze({
    closed: Object.freeze(['/administrator/', '/configuration.php']),
    open: `/${JOOMLA_SEED.introImage}`,
  }),
  /** P5: the sign-in to the panel in the cabinet's frame. */
  signIn: joomlaSignIn,
  /** R1, R6: the template, its style and an override of the texts of the branch. */
  edit: joomlaEdit,
  /** R2: a file a turn may not add — the libraries of the core, outside the working set. */
  outsideWorkingSet: 'libraries/stack-verify.php',
  /** R4: a call that fails where the preview's constant is not defined — on production only. */
  breakOnProduction: () =>
    "<?php if (!defined('RADITI_PREVIEW_ORIGIN')) { raditi_stack_verify_missing(); } ?>",
})
