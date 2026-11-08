import type { DatabaseCopyPolicy } from '@repo/domain'
import { format } from 'mysql2'
import { describe, expect, it } from 'vitest'

import {
  assertCopyPolicy,
  namedColumns,
  overrideColumns,
  rowFilter,
  rulesWithoutRows,
} from './policy-sql.ts'

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

  it('names only the columns the overrides of a table set or match', () => {
    expect(overrideColumns(policy, 'options').sort()).toEqual(['option_name', 'option_value'])
    // Conditions, keys of other rules and treatments are not the platform's own state.
    expect(overrideColumns(policy, 'posts')).toEqual([])
    expect(overrideColumns(policy, 'users')).toEqual([])
  })

  it('names every column the policy reads, treats, follows or sets in a table', () => {
    expect(namedColumns(policy, 'posts').sort()).toEqual([
      'ID',
      'post_author',
      'post_password',
      'post_status',
      'post_type',
    ])
    expect(namedColumns(policy, 'users').sort()).toEqual(['ID', 'user_email'])
    expect(namedColumns(policy, 'options').sort()).toEqual(['option_name', 'option_value'])
    expect(namedColumns(policy, 'terms')).toEqual([])
  })

  it('names the column whose keys an override blanks, so that the source must have it', () => {
    // An override that only blanks keys of a row (Э3.11): its column is the stack's own state too.
    const blanking: DatabaseCopyPolicy = {
      ...policy,
      overrides: [
        ...policy.overrides,
        {
          table: 'options',
          match: { column: 'option_name', value: 'siteurl' },
          set: {},
          blank: { column: 'autoload', keys: ['domain'] },
        },
      ],
    }
    expect(overrideColumns(blanking, 'options').sort()).toEqual([
      'autoload',
      'option_name',
      'option_value',
    ])
    expect(namedColumns(blanking, 'options')).toContain('autoload')
    expect(overrideColumns(blanking, 'posts')).toEqual([])
  })
})

describe('rules a copy writes as structure only', () => {
  const columns: Record<string, string[]> = {
    posts: ['ID', 'post_author', 'post_password', 'post_status', 'post_type'],
    postmeta: ['post_id', 'meta_key'],
    users: ['ID', 'user_email'],
    options: ['option_name', 'option_value'],
    terms: ['term_id'],
  }
  const without = (table: string, column: string) => (name: string) => {
    const found = columns[name]
    if (!found) return null
    return new Set(name === table ? found.filter((other) => other !== column) : found)
  }
  const emptied = (columnsOf: (table: string) => ReadonlySet<string> | null) =>
    [...rulesWithoutRows(policy, columnsOf)].sort()

  it('keeps every rule whose columns the source has', () => {
    expect(emptied(without('', ''))).toEqual([])
  })

  it('takes a rule whose condition names a column the source lacks, and every rule after it', () => {
    // Without post_status, posts would copy drafts: the rule goes whole, and so do the rows
    // that follow posts.
    expect(emptied(without('posts', 'post_status'))).toEqual(['postmeta', 'posts', 'users'])
    expect(emptied(without('postmeta', 'meta_key'))).toEqual(['postmeta'])
  })

  it('takes a rule that follows a key its target lacks', () => {
    expect(emptied(without('posts', 'post_author'))).toEqual(['users'])
  })

  it('takes a rule whose own column of a followed table the source lacks', () => {
    expect(emptied(without('postmeta', 'post_id'))).toEqual(['postmeta'])
    expect(emptied(without('users', 'ID'))).toEqual(['users'])
  })

  it('takes a whole chain, whatever order the policy lists it in', () => {
    const chain: DatabaseCopyPolicy = {
      engine: 'mysql',
      tables: [
        { table: 'c', where: [{ op: 'inCopied', column: 'b_id', table: 'b', key: 'id' }] },
        { table: 'b', where: [{ op: 'inCopied', column: 'a_id', table: 'a', key: 'id' }] },
        { table: 'a', where: [{ op: 'in', column: 'gone', values: ['x'] }] },
      ],
      overrides: [],
    }
    const present: Record<string, string[]> = {
      a: ['id'],
      b: ['id', 'a_id'],
      c: ['id', 'b_id'],
    }
    expect([...rulesWithoutRows(chain, (table) => new Set(present[table] ?? []))].sort()).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('takes a table the copy leaves out for its own reason, and every rule after it', () => {
    const present = (name: string) => (columns[name] ? new Set(columns[name]) : null)
    expect([...rulesWithoutRows(policy, present, ['posts'])].sort()).toEqual([
      'postmeta',
      'posts',
      'users',
    ])
    expect([...rulesWithoutRows(policy, present, ['postmeta'])].sort()).toEqual(['postmeta'])
  })

  it('leaves a rule whose treatment names a column the source lacks', () => {
    expect(emptied(without('posts', 'post_password'))).toEqual([])
    expect(emptied(without('users', 'user_email'))).toEqual([])
  })

  it('leaves a table the source lacks to the WHERE', () => {
    expect(emptied((table) => (table === 'posts' ? null : new Set(columns[table])))).toEqual([])
  })
})

describe('a copy policy as a whole', () => {
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
