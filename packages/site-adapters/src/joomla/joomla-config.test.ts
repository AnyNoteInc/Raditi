import type { SiteTree } from '@repo/domain'
import { siteStackFactsPatchSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { configuration31012, configuration620, secrets31012, secrets620 } from './fixtures.ts'
import {
  JOOMLA_CONFIG,
  joomlaConfigSecrets,
  joomlaDatabaseSettings,
  joomlaFactsOf,
  joomlaFactsSchema,
  joomlaReadLayout,
} from './joomla-config.ts'

const encoder = new TextEncoder()

/** A reader over the given files that remembers what it was asked. */
const reader = (files: Record<string, string>) => {
  const asked: string[] = []
  const read = (path: string) => {
    asked.push(path)
    const text = files[path]
    return Promise.resolve(text === undefined ? null : encoder.encode(text))
  }
  return { asked, read }
}

/**
 * A root of a site: the files given, the folders of the core beside them. `listed: false` — the
 * root cannot be listed; `unread` — files the listing names and a read does not give.
 */
const tree = (
  files: Record<string, string>,
  { listed = true, unread = [] as readonly string[] } = {},
): SiteTree => {
  const { read } = reader(
    Object.fromEntries(Object.entries(files).filter(([name]) => !unread.includes(name))),
  )
  return {
    read,
    list: (path) =>
      Promise.resolve(
        path !== '' || !listed
          ? null
          : [
              ...['administrator', 'libraries', 'plugins'].map((name) => ({
                name,
                type: 'directory' as const,
              })),
              ...Object.keys(files).map((name) => ({ name, type: 'file' as const })),
            ],
      ),
  }
}

/** The configuration of 6.2 with one property set to `value` as written. */
const with620 = (property: string, value: string) =>
  configuration620.replace(new RegExp(`(\\tpublic \\$${property} = )[^;]*;`), `$1${value};`)

describe('joomlaConfigSecrets', () => {
  it.each([
    ['3.10', configuration31012, secrets31012],
    ['6.2', configuration620, secrets620],
  ])(
    'reads the secrets of the form of %s, from configuration.php alone',
    async (_, text, secrets) => {
      const { asked, read } = reader({ [JOOMLA_CONFIG]: text })
      await expect(joomlaConfigSecrets(read)).resolves.toEqual(secrets)
      expect(asked).toEqual([JOOMLA_CONFIG])
    },
  )

  it('leaves out the sample secret of configuration.php-dist', async () => {
    const { read } = reader({ [JOOMLA_CONFIG]: with620('secret', `'FBVtggIk5lAzEU9H'`) })
    const secrets = await joomlaConfigSecrets(read)
    expect(secrets).not.toContain('FBVtggIk5lAzEU9H')
    expect(secrets).toContain('synthetic-db-password-620')
  })

  it('reads no value that PHP would fill in from a variable', async () => {
    const { read } = reader({ [JOOMLA_CONFIG]: with620('password', `"pa$xword"`) })
    await expect(joomlaConfigSecrets(read)).resolves.toEqual(secrets620.slice(1))
  })

  it('reads nothing without the file', async () => {
    await expect(joomlaConfigSecrets(reader({}).read)).resolves.toEqual([])
  })
})

describe('joomlaDatabaseSettings', () => {
  it.each([
    ['3.10', configuration31012, 'x7k2_'],
    ['6.2', configuration620, 'q3w9_'],
  ])('reads the prefix of %s, with the encoding the driver sets', async (_, text, prefix) => {
    const { asked, read } = reader({ [JOOMLA_CONFIG]: text })
    await expect(joomlaDatabaseSettings(read)).resolves.toEqual({
      tablePrefix: prefix,
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })
    expect(asked).toEqual([JOOMLA_CONFIG])
  })

  it.each(['mysqli', 'mysql', 'pdomysql'])('answers on the driver %s', async (driver) => {
    const { read } = reader({ [JOOMLA_CONFIG]: with620('dbtype', `'${driver}'`) })
    await expect(joomlaDatabaseSettings(read)).resolves.toMatchObject({ tablePrefix: 'q3w9_' })
  })

  it.each([
    ['the driver pgsql', with620('dbtype', `'pgsql'`)],
    ['the driver sqlsrv', with620('dbtype', `'sqlsrv'`)],
    ['two drivers', `${configuration620}\n// public $dbtype = 'mysql';`],
    ['no prefix', with620('dbprefix', `getenv('PREFIX')`)],
    ['two prefixes', `${configuration620}\n// public $dbprefix = 'old_';`],
    ['a prefix the schema refuses', with620('dbprefix', `'pre-fix_'`)],
  ])('answers null on %s', async (_, text) => {
    await expect(joomlaDatabaseSettings(reader({ [JOOMLA_CONFIG]: text }).read)).resolves.toBeNull()
  })

  it('answers null without the file', async () => {
    await expect(joomlaDatabaseSettings(reader({}).read)).resolves.toBeNull()
  })
})

describe('joomlaReadLayout', () => {
  it('refuses a root with defines.php: `outside_root`', async () => {
    const files = { [JOOMLA_CONFIG]: configuration620, 'defines.php': '<?php\n' }
    await expect(joomlaReadLayout(tree(files))).resolves.toEqual({
      kind: 'refused',
      limit: 'outside_root',
    })
  })

  // Т13, Р9 of Э2: a hiccup of the hosting says nothing of the site, so no reading is refused on
  // it; the reader of the stack keeps the recorded layout.
  it.each([
    ['the root cannot be listed', tree({ [JOOMLA_CONFIG]: configuration620 }, { listed: false })],
    [
      'the root cannot be listed, defines.php and configuration.php cannot be read',
      tree(
        { [JOOMLA_CONFIG]: configuration620, 'defines.php': '<?php\n' },
        {
          listed: false,
          unread: [JOOMLA_CONFIG, 'defines.php'],
        },
      ),
    ],
    [
      'the root names configuration.php and a read does not give it',
      tree({ [JOOMLA_CONFIG]: configuration620 }, { unread: [JOOMLA_CONFIG] }),
    ],
  ])('refuses nothing when %s: it throws', async (_, root) => {
    await expect(joomlaReadLayout(root)).rejects.toThrow('could not be read')
  })

  it('refuses a root without configuration.php: `outside_root`', async () => {
    await expect(joomlaReadLayout(tree({ 'index.php': '<?php\n' }))).resolves.toEqual({
      kind: 'refused',
      limit: 'outside_root',
    })
  })

  it.each([
    ['pgsql', with620('dbtype', `'pgsql'`)],
    ['postgresql', with620('dbtype', `'postgresql'`)],
    ['sqlsrv', with620('dbtype', `'sqlsrv'`)],
    ['sqlazure', with620('dbtype', `'sqlazure'`)],
    ['no literal', with620('dbtype', `getenv('DB')`)],
    ['two literals', `${configuration620}\n// public $dbtype = 'mysql';`],
  ])('refuses the driver of %s: `other_engine`', async (_, text) => {
    await expect(joomlaReadLayout(tree({ [JOOMLA_CONFIG]: text }))).resolves.toEqual({
      kind: 'refused',
      limit: 'other_engine',
    })
  })

  it('reads the settings of the form of 3.10', async () => {
    await expect(joomlaReadLayout(tree({ [JOOMLA_CONFIG]: configuration31012 }))).resolves.toEqual({
      kind: 'read',
      adminPath: '/administrator/',
      extras: {
        dbtype: 'mysqli',
        sitename: 'Мастерская «Пример»',
        sitenamePagetitles: '2',
        metaDesc: 'Ремонт обуви и сумок в центре города',
        offset: 'Europe/Moscow',
        sef: '1',
        sefRewrite: '1',
        sefSuffix: '0',
        unicodeslugs: '0',
        listLimit: '20',
        feedLimit: '10',
      },
    })
  })

  it('reads the settings of the form of 6.2', async () => {
    await expect(joomlaReadLayout(tree({ [JOOMLA_CONFIG]: configuration620 }))).resolves.toEqual({
      kind: 'read',
      adminPath: '/administrator/',
      extras: {
        dbtype: 'pdomysql',
        sitename: 'Мастерская «Пример»',
        sitenamePagetitles: '0',
        metaDesc: 'Ремонт обуви и сумок в центре города',
        offset: 'Europe/Moscow',
        sef: '1',
        sefRewrite: '0',
        sefSuffix: '0',
        unicodeslugs: '0',
        listLimit: '20',
        feedLimit: '10',
      },
    })
  })

  it.each([`true`, `'1'`, `1`])('reads `$sef = %s` as `1`', async (value) => {
    const reading = await joomlaReadLayout(tree({ [JOOMLA_CONFIG]: with620('sef', value) }))
    expect(reading).toMatchObject({ kind: 'read', extras: { sef: '1' } })
  })

  it.each([`false`, `'0'`, `0`])('reads `$sef = %s` as `0`', async (value) => {
    const reading = await joomlaReadLayout(tree({ [JOOMLA_CONFIG]: with620('sef', value) }))
    expect(reading).toMatchObject({ kind: 'read', extras: { sef: '0' } })
  })

  it('drops a value that fails its field and keeps the others', async () => {
    const text = with620('sitename', `"Мастерская\\x01"`)
    const reading = await joomlaReadLayout(tree({ [JOOMLA_CONFIG]: text }))
    expect(reading.kind).toBe('read')
    if (reading.kind !== 'read') return
    expect(reading.extras).not.toHaveProperty('sitename')
    expect(reading.extras).toMatchObject({ dbtype: 'pdomysql', metaDesc: expect.any(String) })
    expect(Object.keys(reading.extras)).toHaveLength(10)
  })

  it('reads `dbtype` alone from a file where no other value passes', async () => {
    const text = `<?php
class JConfig {
	public $dbtype = 'mysqli';
	public $sitename = "Сайт $name";
	public $sitename_pagetitles = 3;
	public $MetaDesc = getenv('DESC');
	public $offset = '../../etc';
	public $sef = 'yes';
	public $sef_rewrite = null;
	public $sef_suffix = 2;
	public $unicodeslugs = '';
	public $list_limit = 12345;
	public $feed_limit = -1;
}`
    await expect(joomlaReadLayout(tree({ [JOOMLA_CONFIG]: text }))).resolves.toEqual({
      kind: 'read',
      adminPath: '/administrator/',
      extras: { dbtype: 'mysqli' },
    })
  })

  it.each([
    ['sitename', `1`],
    ['sitename', `true`],
    ['MetaDesc', `true`],
    ['MetaDesc', `20`],
  ])('reads no text from a bare `$%s = %s`', async (property, value) => {
    const reading = await joomlaReadLayout(tree({ [JOOMLA_CONFIG]: with620(property, value) }))
    if (reading.kind !== 'read') throw new Error('not read')
    const key = property === 'MetaDesc' ? 'metaDesc' : property
    expect(reading.extras).not.toHaveProperty(key)
    expect(reading.extras).toMatchObject({ dbtype: 'pdomysql', sef: '1' })
  })

  it('gives no key outside the schema, no secret and no path', async () => {
    for (const text of [configuration31012, configuration620]) {
      const reading = await joomlaReadLayout(tree({ [JOOMLA_CONFIG]: text }))
      if (reading.kind !== 'read') throw new Error('not read')
      for (const key of Object.keys(reading.extras))
        expect(Object.keys(joomlaFactsSchema.shape)).toContain(key)
      const values = Object.values(reading.extras).join('\n')
      for (const secret of [...secrets31012, ...secrets620]) expect(values).not.toContain(secret)
      expect(values).not.toMatch(/logs|tmp|example\.test|synthetic/)
      // What the import writes into the record of the site (stack-reading.ts).
      expect(
        siteStackFactsPatchSchema.safeParse({
          extras: reading.extras,
          adminPath: reading.adminPath,
        }).success,
      ).toBe(true)
    }
  })
})

describe('joomlaFactsOf', () => {
  it('reads the extras of a record of Joomla', () => {
    expect(joomlaFactsOf({ dbtype: 'mysqli', sef: '1', listLimit: '20' })).toEqual({
      dbtype: 'mysqli',
      sef: '1',
      listLimit: '20',
    })
  })

  it.each([
    [{ probe: 'value' }],
    [{ dbtype: 'pgsql' }],
    [{ dbtype: 'mysqli', sef: 'true' }],
    [{ dbtype: 'mysqli', password: 'x' }],
  ])('reads %j as empty', (extras) => {
    expect(joomlaFactsOf(extras)).toEqual({})
  })
})
