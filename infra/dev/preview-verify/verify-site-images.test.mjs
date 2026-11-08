import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  EXTENSIONS,
  MANDATORY,
  PULLED_IN,
  STACKS,
  expectedModules,
  expectedStackRows,
  parsePhpModules,
  siteImageBuildArgs,
  siteImagesOptions,
} from './verify-site-images.mjs'

// The pure parts of the stand of the `site` images (docs/plan/62, Э1.2): what `php -m` must hold,
// the arguments of the build and the options. The images themselves are proven by the stand.

const bases = JSON.parse(
  readFileSync(new URL('../../preview/site-bases.json', import.meta.url), 'utf8'),
).versions
const row = (php) => bases.find((entry) => entry.php === php)

const PHP_M = `[PHP Modules]
bcmath
Core
ctype
PDO
pdo_mysql
SimpleXML
Zend OPcache
the ionCube PHP Loader

[Zend Modules]
the ionCube PHP Loader
Zend OPcache
`

test('php -m: the names of [PHP Modules] alone, in lower case', () => {
  assert.deepEqual(parsePhpModules(PHP_M), [
    'bcmath',
    'core',
    'ctype',
    'pdo',
    'pdo_mysql',
    'simplexml',
    'zend opcache',
    'the ioncube php loader',
  ])
  // A warning before the list or no list at all gives nothing more than the list.
  assert.deepEqual(parsePhpModules('PHP Warning: x\n[PHP Modules]\nzip\n'), ['zip'])
  assert.deepEqual(parsePhpModules(''), [])
})

test('the expected modules: those of the base, the list without `without`, nothing of ionCube', () => {
  const base = ['core', 'ctype', 'json', 'pdo', 'standard']
  const all = expectedModules({ ...row('8.3'), without: [] }, base)
  for (const name of base) assert.ok(all.includes(name), `the base's ${name}`)
  for (const name of EXTENSIONS)
    assert.ok(all.includes(name === 'opcache' ? 'zend opcache' : name), name)
  assert.ok(!all.some((name) => name.includes('ioncube')))
  for (const name of PULLED_IN) assert.ok(all.includes(name), name)
  assert.equal(new Set(all).size, all.length, 'every name once')
  // A module of the base stays when the list names it too, and when the row goes without it.
  const without = expectedModules({ ...row('8.3'), without: ['ldap', 'soap'] }, [...base, 'soap'])
  assert.ok(!without.includes('ldap'))
  assert.ok(without.includes('soap'), 'the base has soap of its own')
  assert.equal(without.length, all.length - 1, 'ldap alone goes')
  for (const name of MANDATORY)
    assert.ok(without.includes(name === 'opcache' ? 'zend opcache' : name), name)
})

test('the list of the stand is the list of the Dockerfile, the nine among it', () => {
  const dockerfile = readFileSync(new URL('../../preview/Dockerfile', import.meta.url), 'utf8')
  const loop = /for name in ([^;]+); do/.exec(dockerfile)
  assert.ok(loop)
  assert.deepEqual(EXTENSIONS, loop[1].replace(/\\\n/g, ' ').trim().split(/\s+/))
  assert.equal(EXTENSIONS.length, 26)
  for (const name of MANDATORY) assert.ok(EXTENSIONS.includes(name), name)
  assert.equal(MANDATORY.length, 9)
  assert.deepEqual(PULLED_IN, [])
})

test('the build of a row: its base and pins always, the names to skip only when there are some', () => {
  const php83 = row('8.3')
  assert.deepEqual(siteImageBuildArgs(php83), [
    '--build-arg',
    'BASE=php-base',
    '--build-arg',
    `PHP_BASE=${php83.image}`,
    '--build-arg',
    `PHP_PECL_PINS=${php83.pecl.join(' ')}`,
  ])
  const args = siteImageBuildArgs({ ...php83, without: ['ldap', 'xmlrpc'] })
  assert.equal(args.length, 8)
  assert.deepEqual(args.slice(-2), ['--build-arg', 'PHP_EXTENSIONS_SKIP=ldap xmlrpc'])
  // Every row of the table builds on its own base.
  for (const entry of bases)
    assert.ok(siteImageBuildArgs(entry).includes(`PHP_BASE=${entry.image}`), entry.php)
})

test('the options: every version by default, only the known ones and flags', () => {
  const plain = siteImagesOptions([])
  assert.deepEqual(
    plain.versions,
    bases.map((entry) => entry.php),
  )
  assert.equal(plain.runtime, 'runc')
  assert.equal(plain.build, true)
  assert.equal(plain.buildOnly, false)
  assert.equal(plain.keep, false)
  assert.equal(plain.image, null)
  const some = siteImagesOptions(['--', '--only', '8.3,7.4', '--runtime=runsc', '--keep'])
  assert.deepEqual(some.versions, ['7.4', '8.3'], 'in the order of the table')
  assert.equal(some.runtime, 'runsc')
  assert.equal(some.keep, true)
  assert.deepEqual(siteImagesOptions(['--only=8.5']).versions, ['8.5'])
  assert.equal(siteImagesOptions(['--no-build']).build, false)
  assert.equal(siteImagesOptions(['--build-only']).buildOnly, true)
  const old = siteImagesOptions(['--only', '8.3', '--image=raditi-preview-site:8.3-local'])
  assert.equal(old.image, 'raditi-preview-site:8.3-local')
  assert.equal(old.build, true, 'the image of the version is ready, the tools are still built')
  for (const argv of [
    ['--only', '7.2'],
    ['--only', '8.3,9.0'],
    ['--only'],
    ['--only', ''],
    ['--all'],
    ['8.3'],
    ['--runtime=kata'],
    ['--image=raditi-preview-site:8.3-local'],
    ['--only', '7.4,8.3', '--image=x:y'],
    ['--only', '8.3', '--image='],
    ['--only', '8.3', '--image=x:y', '--build-only'],
  ])
    assert.throws(() => siteImagesOptions(argv), /verify:site-images/, JSON.stringify(argv))
})

test('the stand finds the file of WordPress and its rows on the versions of its recipe', async () => {
  assert.ok(STACKS.includes('./site-wordpress.mjs'), JSON.stringify(STACKS))
  const wordpress = await import('./site-wordpress.mjs')
  assert.equal(wordpress.name, 'wordpress')
  assert.deepEqual([...wordpress.versions()].sort(), [
    '7.4',
    '8.0',
    '8.1',
    '8.2',
    '8.3',
    '8.4',
    '8.5',
  ])
  assert.equal(wordpress.oldModules.php, '8.3')
  const rows = bases.flatMap((entry) => expectedStackRows(wordpress, entry.php))
  assert.equal(rows.filter((name) => name === 'wordpress').length, 7)
  assert.deepEqual(expectedStackRows(wordpress, '8.3'), ['wordpress modules', 'wordpress'])
  assert.deepEqual(expectedStackRows(wordpress, '7.3'), [])
  // Every version a stack names is a row of the table: no row of a stack is quietly left out.
  for (const php of wordpress.versions())
    assert.ok(
      bases.some((entry) => entry.php === php),
      php,
    )
})

test('the row of WordPress needs the header of its recipe on every version, never by choice', async () => {
  const wordpress = await import('./site-wordpress.mjs')
  /** A preview that serves the recipe's pages once its files are written; `headers` of a page. */
  const stand = (recipe, headers = { [wordpress.PREVIEW_HEADER]: '1' }) => {
    let platform = false
    return {
      recipe,
      tree: Buffer.alloc(0),
      origin: 'http://site.preview.test',
      write: async (input) => {
        platform ||= input.platform !== undefined
      },
      loadSeed: async () => {},
      exec: async () => ({ code: 0, stdout: '{"applicationPassword":"x"}' }),
      http: async (path) => {
        if (!platform) return { status: 500, headers: new Headers() }
        if (path.startsWith('/wp-json/')) return { status: 401, headers: new Headers() }
        return { status: 200, headers: new Headers(headers) }
      },
    }
  }
  const recipe = wordpress.recipe('8.3')
  assert.equal(recipe.ready?.header, wordpress.PREVIEW_HEADER)
  const passed = await wordpress.check(stand(recipe))
  assert.equal(passed.ok, true, passed.detail)
  assert.match(passed.detail, /with x-raditi-preview/)
  // A page without the header: a dead site answers 200 too.
  const bare = await wordpress.check(stand(recipe, {}))
  assert.deepEqual(bare, { ok: false, detail: '/: no x-raditi-preview' })
  // A recipe that lost `ready`, or names another header, fails the row: nothing quietly green.
  const { ready: _lost, ...unready } = recipe
  assert.equal((await wordpress.check(stand(unready))).ok, false)
  const other = { ...recipe, ready: { ...recipe.ready, header: 'x-other' } }
  assert.equal((await wordpress.check(stand(other, { 'x-other': '1' }))).ok, false)
})
