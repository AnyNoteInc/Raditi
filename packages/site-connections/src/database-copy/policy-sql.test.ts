import type { DatabaseCopyPolicy } from '@repo/domain'
import { format } from 'mysql2'
import { describe, expect, it } from 'vitest'

import { assertCopyPolicy, ruleColumns, rowFilter } from './policy-sql.ts'

const policy: DatabaseCopyPolicy = {
  engine: 'mysql',
  tables: [
    {
      table: 'posts',
      where: [
        { op: 'in', column: 'post_type', values: ['post', "page'); DROP TABLE x; --"] },
        { op: 'in', column: 'post_status', values: ['publish'] },
      ],
      columns: { post_password: 'empty' },
    },
    {
      table: 'postmeta',
      where: [
        { op: 'inCopied', column: 'post_id', table: 'posts', key: 'ID' },
        { op: 'notLike', column: 'meta_key', patterns: ['%secret%', '%\\_key'] },
      ],
    },
    {
      table: 'users',
      where: [{ op: 'inCopied', column: 'ID', table: 'posts', key: 'post_author' }],
      columns: { user_email: 'synthetic_email' },
    },
    {
      table: 'options',
      where: [{ op: 'like', column: 'option_name', patterns: ['blogname', 'theme\\_mods\\_%'] }],
    },
    { table: 'terms', where: [] },
  ],
  overrides: [
    {
      table: 'options',
      match: { column: 'option_name', value: 'raditi_content_epoch' },
      set: { option_value: '0' },
    },
  ],
}
const prefixed = (table: string) => `wp_${table}`
const sqlOf = (table: string, exists: (table: string) => boolean = () => true) => {
  const where = rowFilter(policy, table, prefixed, exists)
  return format(where.sql, where.values as never)
}

describe('the WHERE of a copy policy', () => {
  it('filters at the source with every value escaped', () => {
    expect(sqlOf('posts')).toBe(
      "(`post_type` IN ('post', 'page\\'); DROP TABLE x; --')) AND (`post_status` IN ('publish'))",
    )
    expect(sqlOf('options')).toBe(
      "(`option_name` LIKE 'blogname' OR `option_name` LIKE 'theme\\\\_mods\\\\_%')",
    )
    expect(sqlOf('terms')).toBe('TRUE')
  })

  it('takes meta and people only of the rows it copies', () => {
    expect(sqlOf('postmeta')).toBe(
      "(`post_id` IN (SELECT `ID` FROM `wp_posts` WHERE (`post_type` IN ('post', 'page\\'); DROP TABLE x; --')) AND (`post_status` IN ('publish')))) AND (`meta_key` NOT LIKE '%secret%' AND `meta_key` NOT LIKE '%\\\\_key')",
    )
    expect(sqlOf('users')).toContain('`ID` IN (SELECT `post_author` FROM `wp_posts` WHERE')
    // Rows that belong to a table the source does not have belong to nothing.
    expect(sqlOf('users', (table) => table !== 'posts')).toBe('(FALSE)')
  })

  it('names the columns a copy needs of each table', () => {
    expect(ruleColumns(policy, 'posts').sort()).toEqual([
      'ID',
      'post_author',
      'post_password',
      'post_status',
      'post_type',
    ])
    expect(ruleColumns(policy, 'options').sort()).toEqual(['option_name', 'option_value'])
  })

  it('refuses a policy that follows a table without a rule, or itself', () => {
    expect(() => assertCopyPolicy(policy)).not.toThrow()
    expect(() =>
      assertCopyPolicy({
        ...policy,
        tables: [
          {
            table: 'postmeta',
            where: [{ op: 'inCopied', column: 'post_id', table: 'posts', key: 'ID' }],
          },
        ],
      }),
    ).toThrow(/no rule/)
    expect(() =>
      assertCopyPolicy({
        engine: 'mysql',
        overrides: [],
        tables: [
          { table: 'a', where: [{ op: 'inCopied', column: 'x', table: 'b', key: 'y' }] },
          { table: 'b', where: [{ op: 'inCopied', column: 'y', table: 'a', key: 'x' }] },
        ],
      }),
    ).toThrow(/cycle/)
    expect(() => rowFilter(policy, 'comments', prefixed, () => true)).toThrow(/no rule/)
  })
})
