import type { DatabaseCopyPolicy } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { databaseSettingsFromCatalog } from './database-settings.ts'

const policy: Pick<DatabaseCopyPolicy, 'tables'> = {
  tables: [
    { table: 'posts', where: [] },
    { table: 'postmeta', where: [] },
    { table: 'options', where: [] },
  ],
}
const table = (name: string, collation = 'utf8mb4_unicode_ci', charset = 'utf8mb4') => ({
  name,
  collation,
  charset,
})

describe('the database settings of a copy from the catalog of production', () => {
  it('finds the one prefix that holds every table of the policy and their encoding', () => {
    expect(
      databaseSettingsFromCatalog(policy, [
        table('shop_posts'),
        table('shop_postmeta'),
        table('shop_options'),
        table('shop_users', 'latin1_swedish_ci', 'latin1'),
        table('other'),
      ]),
    ).toEqual({ tablePrefix: 'shop_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' })
  })

  it("takes the server's collation of the set when the tables share the set alone", () => {
    expect(
      databaseSettingsFromCatalog(policy, [
        table('wp_posts'),
        table('wp_postmeta', 'utf8mb4_unicode_520_ci'),
        table('wp_options'),
      ]),
    ).toEqual({ tablePrefix: 'wp_', charset: 'utf8mb4', collation: null })
  })

  it('copies nothing whose tables keep their text in different character sets', () => {
    expect(
      databaseSettingsFromCatalog(policy, [
        table('wp_posts'),
        table('wp_postmeta'),
        table('wp_options', 'latin1_swedish_ci', 'latin1'),
      ]),
    ).toBeNull()
  })

  it('takes an empty prefix as one', () => {
    expect(
      databaseSettingsFromCatalog(policy, [table('posts'), table('postmeta'), table('options')]),
    ).toEqual({ tablePrefix: '', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' })
  })

  it('guesses nothing between two sites in one database, or without the tables', () => {
    expect(
      databaseSettingsFromCatalog(policy, [
        ...['posts', 'postmeta', 'options'].map((name) => table(`a_${name}`)),
        ...['posts', 'postmeta', 'options'].map((name) => table(`b_${name}`)),
      ]),
    ).toBeNull()
    expect(databaseSettingsFromCatalog(policy, [table('wp_posts'), table('wp_options')])).toBeNull()
    expect(databaseSettingsFromCatalog({ tables: [] }, [table('wp_posts')])).toBeNull()
  })

  it('needs an encoding of the tables', () => {
    expect(
      databaseSettingsFromCatalog(
        policy,
        ['posts', 'postmeta', 'options'].map((name) => ({
          name: `wp_${name}`,
          collation: null,
          charset: null,
        })),
      ),
    ).toBeNull()
  })
})
