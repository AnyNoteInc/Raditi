import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { workingSetMatcher } from '../../../packages/domain/src/index.ts'
import {
  joomlaAgentWorkingSet,
  joomlaProtectedPaths,
} from '../../../packages/site-adapters/src/joomla/joomla-working-set.ts'
import {
  installJoomla,
  JOOMLA_BUILDS,
  JOOMLA_CANARIES,
  JOOMLA_CONFIG_CANARIES,
  JOOMLA_INSTALLATION_MARKER,
  JOOMLA_SEED,
  JOOMLA_SEF_KEPT,
  JOOMLA_SEF_OF_COPY,
  JOOMLA_SEF_SQL,
  joomlaIndexerArgv,
  joomlaStand,
  joomlaSeedSql,
  TEMPLATE_PATHS,
  withProperty,
} from './joomla.mjs'

const j3 = JOOMLA_BUILDS.find((build) => build.generation === 'j3')
const j6 = JOOMLA_BUILDS.find((build) => build.generation === 'j6')

test('the builds are the four branches of the stand, one generation each', () => {
  // docs/plan/62-slices/e3.md, Э3.9: 3.10, 4.4, 5.4 and 6.2, each on the first PHP of its branch.
  assert.deepEqual(
    JOOMLA_BUILDS.map((build) => [build.generation, build.version, build.php]),
    [
      ['j3', '3.10.12', '7.4'],
      ['j4', '4.4.14', '8.1'],
      ['j5', '5.4.10', '8.3'],
      ['j6', '6.2.0', '8.3'],
    ],
  )
  // `<base href>` of 3.x: only its pages link to the site by absolute addresses.
  assert.deepEqual(
    JOOMLA_BUILDS.filter((build) => build.absolutePageLinks).map((build) => build.generation),
    ['j3'],
  )
  for (const build of JOOMLA_BUILDS) assert.equal(build.archive, `joomla-${build.version}`)
  // The superuser of the installer of 4.0 and later takes a random id of 1–1000
  // (installation/src/Model/ConfigurationModel.php): the author of the seed never meets it.
  assert.ok(JOOMLA_SEED.authorId > 1000)
})

test('the seed of 3.x has no workflow, that of 6.x has its row', () => {
  assert.ok(j3, 'a build of 3.x is in the list')
  const old = joomlaSeedSql('jos_', j3)
  const recent = joomlaSeedSql('jos_', j6)
  assert.doesNotMatch(old, /workflow_associations/)
  assert.match(recent, /INSERT INTO `jos_workflow_associations`/)
  // 3.x has no nested set of taxonomy; 4.0 and later have one.
  assert.doesNotMatch(old, /`jos_finder_taxonomy` \(parent_id, lft/)
  assert.match(recent, /`jos_finder_taxonomy` \(parent_id, lft/)
  // Every table is named with the prefix it was given.
  assert.doesNotMatch(joomlaSeedSql('x1_', j3), /`jos_/)
})

test('every canary is in the seed, and the seed names the article, its menu item and the draft', () => {
  for (const build of [j3, j6]) {
    const seed = joomlaSeedSql('jos_', build)
    for (const value of JOOMLA_CANARIES)
      assert.ok(seed.includes(value.replaceAll("'", "''")), `${build.generation}: ${value}`)
    assert.ok(seed.includes(`'${JOOMLA_SEED.articleAlias}'`))
    assert.ok(
      seed.includes(`index.php?option=com_content&view=article&id=${JOOMLA_SEED.articleId}`),
    )
    assert.match(seed, /dlid=/)
    assert.match(seed, /'joomlatoken\.token'/)
    assert.match(seed, /'com_users\.user'/)
    assert.match(seed, /INSERT INTO `jos_session` /)
    // The full text is the article's alone: the draft has none.
    assert.equal(seed.split(JOOMLA_SEED.articleFullText).length, 2)
  }
  assert.equal(new Set(JOOMLA_CANARIES).size, JOOMLA_CANARIES.length)
})

test('every build names a row of the table with its PHP', () => {
  const table = JSON.parse(readFileSync(new URL('./cms-archives.json', import.meta.url), 'utf8'))
  for (const build of JOOMLA_BUILDS) {
    assert.equal(table[build.archive]?.stack, 'joomla', build.archive)
    assert.equal(table[build.archive].php, build.php, build.archive)
    assert.ok(table[build.archive].url.includes(`/${build.version}/`), build.archive)
  }
})

test('a property of the configuration is set once, as a string of PHP', () => {
  const text =
    "<?php\nclass JConfig {\n\tpublic $sef = '1';\n\tpublic $sef_rewrite = '0';\n\tpublic $secret = 'x'; // c\n}\n"
  const changed = withProperty(withProperty(text, 'sef_rewrite', '1'), 'secret', "a'b\\$1")
  assert.match(changed, /public \$sef = '1';/)
  assert.match(changed, /public \$sef_rewrite = '1';/)
  assert.ok(changed.includes("public $secret = 'a\\'b\\\\$1'; // c"))
  assert.throws(() => withProperty(text, 'smtppass', 'x'), /0 times/)
})

test('the install of 3.10 loads the schema and writes a configuration with the marks', async () => {
  const calls = []
  const files = {
    '/prod-secrets/db': 'StandPassword123\n',
    '/var/www/html/installation/sql/mysql/joomla.sql': 'CREATE TABLE `#__users` (id int);\n',
    '/var/www/html/installation/configuration.php-dist': [
      '<?php',
      'class JConfig {',
      "\tpublic $host = 'localhost';",
      "\tpublic $user = '';",
      "\tpublic $password = '';",
      "\tpublic $db = '';",
      "\tpublic $dbprefix = 'jos_';",
      "\tpublic $sitename = 'Joomla!';",
      "\tpublic $live_site = '';",
      "\tpublic $secret = 'FBVtggIk5lAzEU9H';",
      "\tpublic $smtppass = '';",
      "\tpublic $sef_rewrite = '0';",
      "\tpublic $tmp_path = '/tmp';",
      "\tpublic $log_path = '/administrator/logs';",
      '}',
    ].join('\n'),
  }
  const production = {
    exec: async (argv, input) => {
      calls.push({ argv, input })
      return argv[0] === 'cat' ? files[argv[1]] : ''
    },
    sql: async (query) => {
      calls.push({ sql: query })
      return ''
    },
  }
  await assert.rejects(installJoomla(production, j3), /productionOrigin/)
  await assert.rejects(
    installJoomla(production, j3, { productionOrigin: 'https://prod.example.ru/path' }),
    /productionOrigin/,
  )
  calls.length = 0
  await installJoomla(production, j3, { productionOrigin: 'https://prod.example.ru' })
  const statements = calls.filter((call) => call.sql).map((call) => call.sql)
  assert.equal(statements.length, 2)
  assert.equal(statements[0], 'CREATE TABLE `jos_users` (id int);\n')
  // The SEF plugin names the production in its canonical links (Э3.11): 3.10 has empty params.
  assert.match(statements[1], /^UPDATE `jos_extensions` SET params = IF\(JSON_VALID\(params\)/)
  assert.ok(
    statements[1].includes(
      `JSON_OBJECT('domain', 'https://prod.example.ru', 'raditiStandKept', '${JOOMLA_SEF_KEPT}')`,
    ),
  )
  assert.ok(statements[1].endsWith("WHERE name = 'plg_system_sef';\n"))
  const written = calls.find((call) => call.input !== undefined)
  assert.deepEqual(written.argv, ['sh', '-c', 'cat > /var/www/html/configuration.php'])
  assert.match(written.input, /public \$password = 'StandPassword123';/)
  assert.match(written.input, /public \$sef_rewrite = '1';/)
  assert.ok(written.input.includes(`public $smtppass = '${JOOMLA_CONFIG_CANARIES.smtppass}';`))
  assert.ok(written.input.includes(`public $secret = '${JOOMLA_CONFIG_CANARIES.secret}';`))
  // The production names itself, where a broken preview would show it.
  assert.ok(written.input.includes("public $live_site = 'https://prod.example.ru';"))
  // installation/ goes but for one harmless file, which the import rules must drop.
  assert.match(calls.at(-1).argv[2], /rm -rf installation && mkdir installation &&/)
  assert.ok(calls.at(-1).argv[2].includes(`> ${JOOMLA_INSTALLATION_MARKER} &&`))
  assert.match(JOOMLA_INSTALLATION_MARKER, /^installation\/[a-z-]+\.txt$/)
  assert.match(calls.at(-1).argv[2], /cp htaccess\.txt \.htaccess/)
  // The password is never part of an argument.
  assert.ok(calls.every((call) => !(call.argv ?? []).join(' ').includes('StandPassword123')))
})

test('the install of 4.3 and later is the installer of the command line, run as www-data', async () => {
  const builds = JOOMLA_BUILDS.filter((row) => row.generation !== 'j3')
  assert.deepEqual(
    builds.map((build) => build.version),
    ['4.4.14', '5.4.10', '6.2.0'],
  )
  for (const build of builds) {
    const calls = []
    const production = {
      exec: async (argv, input) => {
        calls.push({ argv, input })
        if (argv[0] === 'cat' && argv[1] === '/prod-secrets/db') return 'StandPassword123\n'
        if (argv[0] === 'cat' && argv[1] === '/var/www/html/configuration.php')
          return [
            '<?php',
            'class JConfig {',
            "\tpublic $sitename = 'x';",
            "\tpublic $live_site = '';",
            "\tpublic $secret = 'random';",
            "\tpublic $smtppass = '';",
            '\tpublic $sef_rewrite = false;',
            '}',
          ].join('\n')
        return ''
      },
      sql: async (query) => {
        calls.push({ sql: query })
        return ''
      },
    }
    await installJoomla(production, build, { productionOrigin: 'https://prod.example.ru' })
    // No schema by hand: the installer makes the tables; SQL only names the production in the
    // canonical links of the SEF plugin.
    const statements = calls.filter((call) => call.sql).map((call) => call.sql)
    assert.equal(statements.length, 1, build.version)
    assert.ok(
      statements[0].includes(
        `JSON_SET(params, '$.domain', 'https://prod.example.ru', '$.raditiStandKept', '${JOOMLA_SEF_KEPT}')`,
      ),
      build.version,
    )
    const install = calls.find((call) => (call.argv[2] ?? '').includes('installation/joomla.php'))
    assert.ok(install, build.version)
    assert.match(
      install.argv[2],
      /setpriv --reuid=33 --regid=33 --clear-groups php installation\/joomla\.php install/,
    )
    assert.match(install.argv[2], /--db-prefix=jos_ /)
    // The password of the database is read inside the container, never written in an argument.
    assert.ok(install.argv[2].includes('--db-pass="$(cat /prod-secrets/db)"'))
    assert.ok(calls.every((call) => !(call.argv ?? []).join(' ').includes('StandPassword123')))
    const written = calls.find((call) => call.input !== undefined)
    assert.match(written.input, /public \$sef_rewrite = '1';/)
    assert.ok(written.input.includes(`public $secret = '${JOOMLA_CONFIG_CANARIES.secret}';`))
    assert.ok(written.input.includes(`public $smtppass = '${JOOMLA_CONFIG_CANARIES.smtppass}';`))
    assert.ok(written.input.includes("public $live_site = 'https://prod.example.ru';"))
  }
  // 4.0–4.2 have no installer without a browser.
  await assert.rejects(
    installJoomla(
      { exec: async () => '', sql: async () => '' },
      { archive: 'x', php: '8.1', generation: 'j4', version: '4.2.9' },
      { productionOrigin: 'https://prod.example.ru' },
    ),
    /no installer without a browser/,
  )
})

test('the indexer is the script of 3.x and the console of 4.0 and later', () => {
  assert.deepEqual(joomlaIndexerArgv(j3), ['php', '/var/www/html/cli/finder_indexer.php'])
  assert.deepEqual(joomlaIndexerArgv(j6), ['php', '/var/www/html/cli/joomla.php', 'finder:index'])
})

test('P3 counts the SEF plugin blank only when its one row of valid JSON kept its other settings', async () => {
  // A copy as it should be, then the plugin's row gone, its JSON broken and its settings wiped.
  const answers = {
    [JOOMLA_SEF_OF_COPY]: true,
    '0|x|NULL|NULL': false,
    '1|0|NULL|NULL': false,
    '1|1||NULL': false,
    [`1|1|https://prod.example.ru|${JOOMLA_SEF_KEPT}`]: false,
    [`2|2||${JOOMLA_SEF_KEPT}`]: false,
  }
  for (const [row, ok] of Object.entries(answers)) {
    const sql = async (query) =>
      query === JOOMLA_SEF_SQL
        ? `${row}\n`
        : query.startsWith('SELECT email')
          ? 'user1900@preview.invalid\n'
          : query.includes(`id = ${JOOMLA_SEED.articleId}`)
            ? '1\n'
            : '0\n'
    const checks = await joomlaStand.copyChecks(sql)
    assert.equal(checks.length, 6, row)
    const sef = checks.at(-1)
    assert.match(sef.name, /SEF plugin/)
    assert.equal(sef.ok, ok, row)
    assert.ok(
      checks.slice(0, -1).every((check) => check.ok),
      row,
    )
  }
})

test('P5 marks the panel by what only the panel has, and counts a refused password as failed', () => {
  // `#header` of Atum is on its page of sign-in too (atum/login.php of 4.4.14, 5.4.10, 6.2.0).
  for (const build of JOOMLA_BUILDS) {
    const sign = joomlaStand.signIn(build)
    assert.equal(sign.signedIn, build.generation === 'j3' ? 'header.header' : '#sidebarmenu')
    assert.notEqual(sign.signedIn, '#header')
    assert.ok(sign.lostCookie.includes('Username and password do not match'))
  }
})

test('R1–R6 edit the template of the branch from the list, inside the working set of the agent', () => {
  // docs/plan/62-slices/e3.md, Э3.12: the template file comes from the explicit list per branch;
  // whether the supply holds it is R1's to see on the tree of the archive (fixtures.ts names no
  // template), so a new user.css is neither looked for here nor counted as missing.
  const inSet = workingSetMatcher(joomlaAgentWorkingSet())
  // The paths of the table of the contract, as literals: `edit` reads the same map, so only these
  // tell a misspelt theme or Protostar and Cassiopeia swapped between the branches.
  assert.deepEqual(TEMPLATE_PATHS, {
    j3: 'templates/protostar/index.php',
    j4: 'templates/cassiopeia/index.php',
    j5: 'templates/cassiopeia/index.php',
    j6: 'templates/cassiopeia/index.php',
  })
  for (const build of JOOMLA_BUILDS) {
    const edit = joomlaStand.edit(build)
    assert.equal(edit.template.path, TEMPLATE_PATHS[build.generation], build.archive)
    assert.equal(edit.template.before, build.generation === 'j3' ? '</footer>' : '</body>')
    assert.equal(edit.template.line, '<p class="stack-mark">Подвал: версия 1</p>')
    // 3.x appends to the style of Protostar; Cassiopeia links its user.css itself (template.user).
    assert.equal(
      edit.style.path,
      build.generation === 'j3'
        ? 'templates/protostar/css/template.css'
        : 'media/templates/site/cassiopeia/css/user.css',
    )
    assert.equal(edit.style.created, build.generation !== 'j3')
    assert.equal(edit.texts.path, 'language/overrides/en-GB.override.ini')
    assert.equal(edit.texts.created, true)
    assert.match(edit.texts.line, /^[A-Z_]+="[^"]+"$/)
    for (const part of [edit.template, edit.style, edit.texts])
      assert.ok(inSet(part.path), `${build.archive}: ${part.path} is in the working set`)
  }
  // R2: a file outside the working set, under a path no candidate may change.
  assert.equal(joomlaStand.outsideWorkingSet, 'libraries/stack-verify.php')
  assert.ok(!inSet(joomlaStand.outsideWorkingSet))
  assert.ok(joomlaProtectedPaths().some((path) => joomlaStand.outsideWorkingSet.startsWith(path)))
  // R4: what breaks production only — the preview defines the constant, production does not.
  for (const build of JOOMLA_BUILDS) {
    const broken = joomlaStand.breakOnProduction(build)
    assert.match(broken, /RADITI_PREVIEW_ORIGIN/)
    assert.match(broken, /^<\?php .* \?>$/)
  }
})
