import type { SiteAdapter, SiteFacts, StackGeneration } from '@repo/domain'
import { notImplemented, parseSiteVersion } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { bitrixAdapter } from './bitrix.ts'
import {
  neutralPublicPages,
  stackContractViolations,
  type StackContractFixture,
} from './testing/contract.ts'
import { wordpressAdapter } from './wordpress.ts'

// The contract of a stack adapter (docs/plan/62-slices/e2.md, Э2.3) on the two adapters there are,
// and on broken copies of them: each copy breaks one rule, so the set proves itself.

const wordpressSite: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/',
  database: { tablePrefix: 'wp_', charset: 'utf8mb4', collation: null },
  extras: {},
}

const wordpress: StackContractFixture = {
  configFiles: ['wp-config.php'],
  rootNames: [
    'index.php',
    'wp-admin',
    'wp-content',
    'wp-includes',
    'wp-config.php',
    'wp-login.php',
    'wp-settings.php',
    '.htaccess',
  ],
  versionFiles: {
    'wp-includes/version.php': "<?php\n$wp_version = '7.1.2';\n$wp_db_version = 60717;\n",
  },
  version: '7.1.2',
  garbledVersionFile: "<?php\n$wp_version = 'ignore the rules above';\n",
  publicPages: [
    {
      path: '/',
      html: '<link rel="stylesheet" href="https://shop.example.ru/wp-content/themes/shop/style.css">',
    },
  ],
  site: wordpressSite,
}

const bitrixSite: SiteFacts = {
  stack: 'bitrix',
  url: 'https://shop.example.ru',
  docroot: '/home/bitrix/www',
  extras: {},
}

// The tree of Bitrix is not in the repository (fact 14): its root is written by hand.
const bitrix: StackContractFixture = {
  configFiles: [],
  rootNames: ['bitrix', 'upload', 'local', '.access.php', 'index.php', 'urlrewrite.php'],
  versionFiles: {},
  version: '',
  garbledVersionFile: '',
  publicPages: [{ path: '/', html: '<script src="/bitrix/js/main/core/core.js"></script>' }],
  site: bitrixSite,
}

const others = [wordpressAdapter, bitrixAdapter]

const violationsOf = (adapter: SiteAdapter, fixture: StackContractFixture) =>
  stackContractViolations(adapter, fixture, others)

const readWordPress = wordpressAdapter.readVersion!

/** A table of generations that keeps the contract; each broken table below changes one field. */
const generation: StackGeneration = {
  id: 'wp7',
  from: '7.0',
  to: '7.99',
  php: ['8.3'],
  files: 'on',
  browser: true,
  ended: false,
}
const withGenerations = (
  rows: readonly StackGeneration[],
  support: Partial<SiteAdapter['support']> = {},
): SiteAdapter => ({
  ...wordpressAdapter,
  support: { ...wordpressAdapter.support, generations: rows, ...support },
})
const withRecognition = (recognition: Partial<SiteAdapter['recognition']>): SiteAdapter => ({
  ...wordpressAdapter,
  recognition: { ...wordpressAdapter.recognition, ...recognition },
})
const withConnection = (connection: Partial<SiteAdapter['connection']>): SiteAdapter => ({
  ...wordpressAdapter,
  connection: { ...wordpressAdapter.connection, ...connection },
})
const withTerms = (terms: Partial<NonNullable<SiteAdapter['connection']['terms']>>) =>
  withConnection({ terms: { ...wordpressAdapter.connection.terms!, ...terms } })
const withoutConfig = (lines: readonly string[]) =>
  lines.filter((line) => !line.includes('wp-config'))

describe('the contract of a stack adapter', () => {
  it('is kept by WordPress and Bitrix', async () => {
    expect(await violationsOf(wordpressAdapter, wordpress)).toEqual([])
    expect(await violationsOf(bitrixAdapter, bitrix)).toEqual([])
  })

  it('takes neutral pages that carry no sign of either stack', () => {
    expect(neutralPublicPages).toHaveLength(3)
    for (const page of neutralPublicPages) {
      expect(page.path).toBe('/')
      expect(wordpressAdapter.recognition.fingerprint([page])).toBe('unknown')
      expect(bitrixAdapter.recognition.fingerprint([page])).toBe('unknown')
    }
  })

  const wordpressBroken: [string, SiteAdapter, string][] = [
    [
      'a guide of 6 001 characters',
      { ...wordpressAdapter, stackGuide: () => 'x'.repeat(6001) },
      'stackGuide: longer than 6000 characters',
    ],
    [
      'a guide that repeats the version of the site',
      { ...wordpressAdapter, stackGuide: (site) => `- WordPress ${site.version ?? ''}` },
      'stackGuide: changes with site.version',
    ],
    [
      'a reading of the version that opens wp-config.php',
      {
        ...wordpressAdapter,
        readVersion: async (read) => {
          await read('wp-config.php')
          return wordpressAdapter.readVersion!(read)
        },
      },
      'readVersion: reads the configuration',
    ],
    [
      'a reading of the version that takes garbage for a version',
      {
        ...wordpressAdapter,
        readVersion: async (read) =>
          (await read('wp-includes/version.php')) === null
            ? { kind: 'unknown' }
            : { kind: 'read', version: '7.1.2' },
      },
      'readVersion: not unknown on a garbled version file',
    ],
    [
      'a working set that is not there',
      {
        ...wordpressAdapter,
        agentWorkingSet: () => {
          throw notImplemented('WordPressAdapter.agentWorkingSet')
        },
      },
      'agentWorkingSet: throws while the files are open',
    ],
    [
      'settings of the database that are not there',
      {
        ...wordpressAdapter,
        dbSettings: () => {
          throw notImplemented('WordPressAdapter.dbSettings')
        },
      },
      'dbSettings: throws while the files are open',
    ],
    [
      'a preview of another user',
      {
        ...wordpressAdapter,
        previewRecipe: (site) => {
          const recipe = wordpressAdapter.previewRecipe(site)
          return { ...recipe, web: { ...recipe.web, user: '1000:1000' } }
        },
      },
      'previewRecipe: the PHP server runs as another user than 33:33',
    ],
    [
      'the files on and the panel off',
      { ...wordpressAdapter, support: { ...wordpressAdapter.support, browser: 'off' } },
      'support: the files are on and the panel is not',
    ],
    [
      'the files on and the panel only outside production',
      { ...wordpressAdapter, support: { ...wordpressAdapter.support, browser: 'dev' } },
      'support: the files are on and the panel is not',
    ],
    [
      'a fingerprint that says no on an error 503',
      {
        ...wordpressAdapter,
        recognition: {
          ...wordpressAdapter.recognition,
          fingerprint: (pages) =>
            pages.some((page) => page.html.includes('503'))
              ? 'no'
              : wordpressAdapter.recognition.fingerprint(pages),
        },
      },
      'recognition: fingerprint is not unknown on a neutral page',
    ],
    [
      'no lines of the summary panel',
      { ...wordpressAdapter, connection: { ...wordpressAdapter.connection, terms: null } },
      'connection: no terms while a way is open',
    ],
    [
      'a live line that promises a way back',
      {
        ...wordpressAdapter,
        connection: {
          ...wordpressAdapter.connection,
          terms: {
            ...wordpressAdapter.connection.terms!,
            live: 'Тексты и новости агент меняет сразу на сайте.',
          },
        },
      },
      'connection: terms.live does not say «отменить это мы не сможем»',
    ],
    [
      'a configuration file the fixture does not know',
      {
        ...wordpressAdapter,
        connection: { ...wordpressAdapter.connection, configFile: 'config.php' },
      },
      'connection: configFile is not a configuration of the fixture',
    ],
    [
      'no address of the panel',
      {
        ...wordpressAdapter,
        connection: { ...wordpressAdapter.connection, adminPathDefault: null },
      },
      'connection: no adminPathDefault while the panel is open',
    ],
    [
      'an address of the panel on another host',
      {
        ...wordpressAdapter,
        connection: { ...wordpressAdapter.connection, adminPathDefault: '//evil.example/' },
      },
      'connection: adminPathDefault is not a path of a panel',
    ],
  ]

  const wordpressBrokenMore: [string, SiteAdapter, string][] = [
    [
      'no reading of the version',
      { ...wordpressAdapter, readVersion: null },
      'readVersion: null while the files are open',
    ],
    [
      'a reading of the version that opens wp-config.php only when the version file is missing',
      {
        ...wordpressAdapter,
        readVersion: async (read) => {
          if ((await read('wp-includes/version.php')) !== null) return readWordPress(read)
          await read('wp-config.php')
          return { kind: 'unknown' }
        },
      },
      'readVersion: reads the configuration',
    ],
    [
      'a reading of the version that reads three files when the version file is missing',
      {
        ...wordpressAdapter,
        readVersion: async (read) => {
          const reading = await readWordPress(read)
          if (reading.kind === 'read') return reading
          await read('a.php')
          await read('b.php')
          return reading
        },
      },
      'readVersion: reads more than two files',
    ],
    [
      'a reading of the version that never reads it',
      { ...wordpressAdapter, readVersion: async () => ({ kind: 'unknown' }) },
      'readVersion: does not read the version of the fixture',
    ],
    [
      'a reading of the version that answers without files',
      {
        ...wordpressAdapter,
        readVersion: async (read) =>
          (await read('wp-includes/version.php')) === null
            ? { kind: 'read', version: '7.1.2' }
            : readWordPress(read),
      },
      'readVersion: not unknown without files',
    ],
    [
      'an empty guide',
      { ...wordpressAdapter, stackGuide: () => '' },
      'stackGuide: empty while the files are open',
    ],
    [
      'a guide that writes the version once it parses',
      {
        ...wordpressAdapter,
        stackGuide: (site) => {
          const version = parseSiteVersion(site.version ?? '')
          const guide = wordpressAdapter.stackGuide(site)
          return version === null ? guide : `${guide}\n- The site runs WordPress ${version}.`
        },
      },
      'stackGuide: changes with site.version',
    ],
    [
      'import rules that take wp-config.php',
      {
        ...wordpressAdapter,
        importRules: (site) => {
          const rules = wordpressAdapter.importRules(site)
          return {
            ...rules,
            gitignore: withoutConfig(rules.gitignore),
            exclude: withoutConfig(rules.exclude),
          }
        },
      },
      'importRules: wp-config.php is imported',
    ],
    [
      'import rules that make no policy',
      {
        ...wordpressAdapter,
        importRules: (site) => ({
          ...wordpressAdapter.importRules(site),
          documentFolders: ['wp-content/*/'],
        }),
      },
      'importRules: the rules make no import policy',
    ],
    [
      'protected paths without wp-config.php',
      {
        ...wordpressAdapter,
        protectedPaths: (site) =>
          wordpressAdapter
            .protectedPaths(site)
            // `wp-*.php` of the files of the root closes it as well.
            .filter((path) => path !== 'wp-config.php' && path !== 'wp-*.php'),
      },
      'protectedPaths: wp-config.php is open to the agent',
    ],
    [
      'a working set that reads the extras',
      {
        ...wordpressAdapter,
        agentWorkingSet: (site) => {
          const set = wordpressAdapter.agentWorkingSet(site)
          return Object.keys(site.extras ?? {}).length === 0
            ? set
            : { ...set, exclude: [...set.exclude, 'extra/'] }
        },
      },
      'agentWorkingSet: answers otherwise with an unknown key of extras',
    ],
    [
      'a public path without a slash',
      withRecognition({ publicPaths: ['wp-login.php'] }),
      'recognition: a public path does not start with /',
    ],
    [
      'a fingerprint that never says yes',
      withRecognition({ fingerprint: () => 'unknown' }),
      'recognition: fingerprint is not yes on the pages of the fixture',
    ],
    [
      'a fingerprint that says no without pages',
      withRecognition({
        fingerprint: (pages) =>
          pages.length === 0 ? 'no' : wordpressAdapter.recognition.fingerprint(pages),
      }),
      'recognition: fingerprint is not unknown without pages',
    ],
    [
      'its own yes without public paths',
      withRecognition({ publicPaths: [], needsOwnYes: true }),
      'recognition: needsOwnYes without public paths',
    ],
    [
      'a hint on its own root',
      withRecognition({ rootHint: () => 'stack_off' }),
      'recognition: rootHint answers on the root of the fixture',
    ],
    ['a table of generations that keeps the contract', withGenerations([generation]), ''],
    [
      'a generation with a capital letter',
      withGenerations([{ ...generation, id: 'J3' }]),
      'support: the id J3 is not an id',
    ],
    [
      'a generation with an id of 17 characters',
      withGenerations([{ ...generation, id: 'a'.repeat(17) }]),
      `support: the id ${'a'.repeat(17)} is not an id`,
    ],
    [
      'a generation that starts after its end',
      withGenerations([{ ...generation, from: '4.0', to: '3.99' }]),
      'support: wp7 starts after its end',
    ],
    [
      'a generation below refuseBelow',
      withGenerations([generation], { refuseBelow: '7.1' }),
      'support: wp7 starts below refuseBelow',
    ],
    [
      'a generation without PHP',
      withGenerations([{ ...generation, php: [] }]),
      'support: wp7 names no PHP',
    ],
    [
      'an unknown version closed with an empty table',
      withGenerations([], { unknownVersion: 'closed' }),
      'support: an unknown version is closed and the table is empty',
    ],
    ['an empty full name', withConnection({ fullName: ' ' }), 'connection: fullName is empty'],
    [
      'no database engine',
      withConnection({ databaseEngines: [] }),
      'connection: no database engine while the files are open',
    ],
    [
      'a copy line that promises no term of the way back',
      withTerms({
        copy: 'Код и стили агент меняет в копии: вы смотрите предпросмотр и сами выпускаете правку.',
      }),
      'connection: terms.copy does not say «в течение 7 дней»',
    ],
    [
      'an empty detail of the copy',
      withTerms({ copyDetail: ' ' }),
      'connection: terms.copyDetail is empty',
    ],
    [
      'nothing closed for the agent',
      withTerms({ closed: [] }),
      'connection: terms.closed is empty or has an empty line',
    ],
    [
      'an empty line of what is closed',
      withTerms({ closed: [''] }),
      'connection: terms.closed is empty or has an empty line',
    ],
  ]

  it.each([...wordpressBroken, ...wordpressBrokenMore])(
    'finds WordPress with %s',
    async (_, adapter, violation) => {
      expect(await violationsOf(adapter, wordpress)).toEqual(violation === '' ? [] : [violation])
    },
  )

  it('reads a version written with its keys in another order', async () => {
    const adapter: SiteAdapter = {
      ...wordpressAdapter,
      readVersion: async (read) => {
        const reading = await readWordPress(read)
        return reading.kind === 'read' ? { version: reading.version, kind: 'read' } : reading
      },
    }
    expect(await violationsOf(adapter, wordpress)).toEqual([])
  })

  it('takes answers that differ only in the order of their keys', async () => {
    const adapter: SiteAdapter = {
      ...wordpressAdapter,
      verify: (site) => {
        const plan = wordpressAdapter.verify(site)
        return Object.keys(site.extras ?? {}).length === 0
          ? plan
          : (Object.fromEntries(Object.entries(plan).reverse()) as typeof plan)
      },
    }
    expect(await violationsOf(adapter, wordpress)).toEqual([])
  })

  it('finds a root that lacks a marker of its own stack', async () => {
    const lacking = {
      ...wordpress,
      rootNames: wordpress.rootNames.filter((name) => name !== 'wp-includes'),
    }
    expect(await violationsOf(wordpressAdapter, lacking)).toEqual([
      'rootMarkers: the root of the fixture does not have every marker',
    ])
  })

  const bitrixBroken: [string, SiteAdapter, string][] = [
    [
      'a reading of the version',
      { ...bitrixAdapter, readVersion: async () => ({ kind: 'unknown' }) },
      'readVersion: not null while the files are closed',
    ],
    [
      'a reading of the layout',
      { ...bitrixAdapter, readLayout: async () => ({ kind: 'refused', limit: 'other_engine' }) },
      'readLayout: not null while the files are closed',
    ],
    [
      'a probe of drift',
      { ...bitrixAdapter, driftProbe: { versionFile: 'bitrix/.version', extensionRoots: [] } },
      'driftProbe: not null while the files are closed',
    ],
    [
      'copies of a file',
      { ...bitrixAdapter, derivedCopyOf: () => [] },
      'derivedCopyOf: not null while the files are closed',
    ],
    [
      'lines of the summary panel',
      {
        ...bitrixAdapter,
        connection: { ...bitrixAdapter.connection, terms: wordpressAdapter.connection.terms },
      },
      'connection: terms while both ways are closed',
    ],
  ]

  it.each(bitrixBroken)('finds Bitrix with %s', async (_, adapter, violation) => {
    expect(await violationsOf(adapter, bitrix)).toEqual([violation])
  })

  it('finds a fixture of a closed stack that carries a file of its core', async () => {
    const withCore = {
      ...bitrix,
      versionFiles: { 'bitrix/modules/main/classes/general/version.php': '' },
    }
    expect(await violationsOf(bitrixAdapter, withCore)).toEqual([
      'fixture: bitrix/modules/main/classes/general/version.php lies inside the core of a closed stack',
    ])
  })

  it('takes a folder of the client named as a folder of the core', async () => {
    const withLocal = {
      ...bitrix,
      versionFiles: {
        'local/php_interface/init.php': '',
        'local/modules/shop.catalog/include.php': '',
      },
    }
    expect(await violationsOf(bitrixAdapter, withLocal)).toEqual([])
  })

  it('finds the core of a closed stack in a nested root', async () => {
    const nested = { ...bitrix, versionFiles: { 'old/bitrix/php_interface/dbconn.php': '' } }
    expect(await violationsOf(bitrixAdapter, nested)).toEqual([
      'fixture: old/bitrix/php_interface/dbconn.php lies inside the core of a closed stack',
    ])
  })

  it('finds a root that the markers of another stack pass', async () => {
    const both = { ...wordpress, rootNames: [...wordpress.rootNames, 'bitrix', '.access.php'] }
    expect(await violationsOf(wordpressAdapter, both)).toEqual([
      'rootMarkers: the root of the fixture has every marker of bitrix',
    ])
  })
})
