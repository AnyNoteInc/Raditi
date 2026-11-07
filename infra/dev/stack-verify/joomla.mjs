// Joomla on the synthetic production of a stand of the site stacks (docs/plan/62-slices/e3.md,
// Э3.8): the builds the stand runs, the install without a browser, and the synthetic content a copy
// is judged by — a published article with an alias and a menu item, a draft, and values that mark
// what no preview may hold (people, their contacts and tokens, the secrets of the configuration).
// Only synthetic data. The core of Joomla runs in the container of the production only: this file
// is the stand's, the downloaded tree is not.

/** A build of a stand: a row of cms-archives.json and the `site` image of its PHP. */
export const JOOMLA_BUILDS = [
  { archive: 'joomla-3.10.12', php: '7.4', generation: 'j3', version: '3.10.12' },
]

/** The prefix of the tables of the production. */
export const JOOMLA_PREFIX = 'jos_'
/** The webroot of the production container. */
const ROOT = '/var/www/html'

/** What the seed writes, by the ids a test asks for. */
export const JOOMLA_SEED = Object.freeze({
  authorId: 900,
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
 * goes but for JOOMLA_INSTALLATION_MARKER, `htaccess.txt` becomes `.htaccess`, `sef_rewrite` is 1
 * and `$live_site` is the production's own origin, where a broken preview would show it. The
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
      'Синтетическая страница стенда: о компании.',
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
