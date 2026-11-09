import { readFileSync } from 'node:fs'

import type { SiteFacts } from '@repo/domain'
import { databaseCopyPolicySchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { wordpressDatabaseCopyPolicy, wordpressDatabaseSettings } from './wordpress-db-copy.ts'

const previewId = '0196abcd-0000-7000-8000-00000000000a'
const site = (database?: SiteFacts['database']): SiteFacts => ({
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/html',
  extras: {},
  ...(database ? { database } : {}),
})

const configOf =
  (text: string | null) =>
  async (path: string): Promise<Uint8Array | null> =>
    path === 'wp-config.php' && text !== null ? new TextEncoder().encode(text) : null
const sample = (...lines: string[]) =>
  [
    '<?php',
    `define( 'DB_NAME', 'shop' );`,
    `define( 'DB_PASSWORD', 'secret-password' );`,
    ...lines,
    `require_once ABSPATH . 'wp-settings.php';`,
  ].join('\n')

describe('the database settings of a WordPress site', () => {
  it('reads the prefix and the encoding of wp-config.php as wpdb makes them', async () => {
    const config = sample(
      `define( 'DB_CHARSET', 'utf8mb4' );`,
      `define( 'DB_COLLATE', '' );`,
      `$table_prefix = 'wp_';`,
    )
    expect(await wordpressDatabaseSettings(configOf(config))).toEqual({
      tablePrefix: 'wp_',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })
    // An older configuration: utf8 is upgraded, its collation with it.
    expect(
      await wordpressDatabaseSettings(
        configOf(
          sample(
            `define('DB_CHARSET', "utf8");`,
            `define('DB_COLLATE', 'utf8_unicode_ci');`,
            `$table_prefix  = "shop_";`,
          ),
        ),
      ),
    ).toEqual({ tablePrefix: 'shop_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' })
    // Another character set stays; no DB_COLLATE is the default collation.
    expect(
      await wordpressDatabaseSettings(
        configOf(sample(`define('DB_CHARSET', 'cp1251');`, `$table_prefix = '';`)),
      ),
    ).toEqual({ tablePrefix: '', charset: 'cp1251', collation: null })
  })

  it('reads nothing it cannot be sure of', async () => {
    for (const config of [
      null,
      // No prefix, a computed one, two different ones, one PHP would refuse.
      sample(`define('DB_CHARSET', 'utf8mb4');`),
      sample(`define('DB_CHARSET', 'utf8mb4');`, `$table_prefix = getenv('PREFIX');`),
      sample(`define('DB_CHARSET', 'utf8mb4');`, `$table_prefix = 'a_';`, `$table_prefix = 'b_';`),
      sample(`define('DB_CHARSET', 'utf8mb4');`, `$table_prefix = 'wp-';`),
      // The server's default encoding decides, or no encoding at all.
      sample(`define('DB_CHARSET', '');`, `$table_prefix = 'wp_';`),
      sample(`$table_prefix = 'wp_';`),
      sample(`define('DB_CHARSET', 'utf8mb4; SET x');`, `$table_prefix = 'wp_';`),
      // A network keeps a set of tables per site.
      sample(
        `define('DB_CHARSET', 'utf8mb4');`,
        `define( 'MULTISITE', true );`,
        `$table_prefix = 'wp_';`,
      ),
    ])
      expect(await wordpressDatabaseSettings(configOf(config))).toBeNull()
  })
})

describe('the database copy of a WordPress preview', () => {
  const policy = wordpressDatabaseCopyPolicy(
    site({ tablePrefix: 'shop_', charset: 'utf8mb4', collation: null }),
    { previewId },
  )

  it('opts into rows of unlisted tables and only filters out production receipts', () => {
    expect(databaseCopyPolicySchema.parse(policy)).toEqual(policy)
    expect(policy.engine).toBe('mysql')
    expect(policy.copyUnlistedRows).toBe(true)
    expect(policy.suspectColumns).toBeUndefined()
    expect(policy.tables).toEqual([
      {
        table: 'options',
        where: [
          { op: 'notLike', column: 'option_name', patterns: ['raditi\\_content\\_call\\_%'] },
        ],
      },
    ])
  })

  it('copies core rows when there is no prefix to identify plugin tables', () => {
    const unprefixed = wordpressDatabaseCopyPolicy(
      site({ tablePrefix: '', charset: 'utf8mb4', collation: null }),
      { previewId },
    )
    expect(unprefixed.copyUnlistedRows).toBeUndefined()
    expect(unprefixed.catalogTables).toEqual(policy.catalogTables)
    expect(unprefixed.tables.map((rule) => rule.table)).toEqual(
      expect.arrayContaining(['posts', 'users', 'usermeta', 'comments', 'commentmeta', 'options']),
    )
    expect(unprefixed.tables).toHaveLength(12)
  })

  it('binds the plugin «Радити» of the copy to the preview, from epoch 0', () => {
    expect(policy.overrides).toEqual([
      {
        table: 'options',
        match: { column: 'option_name', value: 'raditi_content_site_id' },
        set: { option_value: previewId },
      },
      {
        table: 'options',
        match: { column: 'option_name', value: 'raditi_content_epoch' },
        set: { option_value: '0' },
      },
      {
        table: 'options',
        match: { column: 'option_name', value: 'blog_public' },
        set: { option_value: '0' },
      },
      {
        table: 'options',
        match: { column: 'option_name', value: 'admin_email' },
        set: { option_value: 'admin@preview.invalid' },
      },
    ])
  })

  it('never guesses the prefix: without the settings of production there is no policy', () => {
    expect(() => wordpressDatabaseCopyPolicy(site(), { previewId })).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })

  it('is the policy the copier is tested with against MariaDB', () => {
    // @repo/site-connections may not import this package: its test reads the policy from a file.
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL(
          '../../site-connections/src/database-copy/wordpress-policy.fixture.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    expect(
      wordpressDatabaseCopyPolicy(
        site({ tablePrefix: 'wp_', charset: 'utf8mb4', collation: null }),
        {
          previewId,
        },
      ),
      'write the policy into the fixture again',
    ).toEqual(fixture)
  })
})
