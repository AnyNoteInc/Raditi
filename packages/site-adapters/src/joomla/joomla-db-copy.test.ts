import type { DatabaseCopyCondition, DatabaseCopyPolicy, SiteFacts } from '@repo/domain'
import { databaseCopyPolicySchema, DomainError, suspectColumnNames } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  copiedTableColumns31012,
  copiedTableColumns620,
  usersTable31012,
  usersTable620,
} from './fixtures.ts'
import { joomlaDatabaseCopyPolicy, joomlaDatabaseOf, joomlaGenerationOf } from './joomla-db-copy.ts'
import { joomlaGenerations } from './joomla-support.ts'

const previewId = '0196abcd-0000-7000-8000-00000000000a'
const database = { tablePrefix: 'q3w9_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }
const site = (generation?: string, withDatabase = true): SiteFacts => ({
  stack: 'joomla',
  url: 'https://shop.example.ru',
  docroot: '/var/www/html',
  extras: { dbtype: 'mysqli' },
  ...(generation === undefined ? {} : { generation }),
  ...(withDatabase ? { database } : {}),
})
const policyOf = (generation: string) => joomlaDatabaseCopyPolicy(site(generation), { previewId })
const ruleOf = (policy: DatabaseCopyPolicy, table: string) => {
  const rule = policy.tables.find((candidate) => candidate.table === table)
  if (!rule) throw new Error(`no rule for ${table}`)
  return rule
}
const branches = joomlaGenerations.map((row) => row.id)

/** MySQL `LIKE` with `\` as the escape. */
function like(value: string, pattern: string): boolean {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '\\' && index + 1 < pattern.length) {
      index += 1
      source += pattern[index]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (char === '%') source += '.*'
    else if (char === '_') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'is').test(value)
}

/** Whether a row passes the conditions of its rule that read its own columns. */
function passes(policy: DatabaseCopyPolicy, table: string, row: Record<string, string>): boolean {
  return ruleOf(policy, table).where.every((condition: DatabaseCopyCondition) => {
    const value = row[condition.column]
    if (value === undefined) return true
    switch (condition.op) {
      case 'in':
        return condition.values.includes(value)
      case 'like':
        return condition.patterns.some((pattern) => like(value, pattern))
      case 'notLike':
        return condition.patterns.every((pattern) => !like(value, pattern))
      case 'inCopied':
        return true
    }
  })
}

/** The columns of a `CREATE TABLE` and whether each takes `NULL`, read from the text alone. */
function columnsOf(statement: string): Map<string, { nullable: boolean }> {
  const columns = new Map<string, { nullable: boolean }>()
  for (const line of statement.split('\n')) {
    const match = /^\s+`([^`]+)`\s+(.*)$/.exec(line)
    if (match) columns.set(match[1]!, { nullable: !/\bNOT NULL\b/i.test(match[2]!) })
  }
  return columns
}

/** The tables that keep people, their sessions and what they wrote: structure only. */
const structureOnly = [
  'contact_details',
  'user_profiles',
  'user_keys',
  'user_mfa',
  'session',
  'update_sites',
  'updates',
  'action_logs',
  'history',
  'ucm_history',
  'scheduler_tasks',
  'scheduler_logs',
  'messages',
  'privacy_requests',
  'privacy_consents',
  'banner_clients',
  'redirect_links',
  'content_rating',
  'finder_links',
  'finder_terms',
  'finder_links_terms',
  'finder_logging',
  'finder_filters',
  'finder_terms_common',
  'finder_tokens',
  'finder_tokens_aggregate',
]

const copied = (column: string, table: string, key: string): DatabaseCopyCondition => ({
  op: 'inCopied',
  column,
  table,
  key,
})
const among = (column: string, values: string[]): DatabaseCopyCondition => ({
  op: 'in',
  column,
  values,
})
const ofArticles = (column: string): DatabaseCopyCondition => ({
  op: 'like',
  column,
  patterns: ['com\\_content.%'],
})
const settings = { params: 'scrub_secrets', note: 'empty', client_id: 'keep' } as const
const authorNotes = { created_by_alias: 'empty', metadata: 'empty', note: 'empty' } as const

/**
 * The table of the contract (docs/plan/62-slices/e3.md, Э3.6), row by row: conditions and
 * columns exactly, the users table aside — its dates follow the branch.
 */
const expectedRules: Record<string, Omit<DatabaseCopyPolicy['tables'][number], 'table'>> = {
  extensions: { where: [], columns: { ...settings, custom_data: 'scrub_secrets' } },
  assets: { where: [], columns: { title: 'empty' } },
  languages: { where: [] },
  usergroups: { where: [] },
  viewlevels: { where: [] },
  schemas: { where: [] },
  content_types: { where: [] },
  associations: { where: [] },
  finder_types: { where: [] },
  menu_types: { where: [], columns: { client_id: 'keep' } },
  menu: { where: [], columns: settings },
  modules: { where: [among('published', ['1'])], columns: settings },
  modules_menu: { where: [copied('moduleid', 'modules', 'id')] },
  template_styles: { where: [], columns: { params: 'scrub_secrets', client_id: 'keep' } },
  content: { where: [among('state', ['1', '2'])], columns: authorNotes },
  content_frontpage: { where: [copied('content_id', 'content', 'id')] },
  categories: {
    where: [among('published', ['1', '2'])],
    columns: { metadata: 'empty', note: 'empty' },
  },
  tags: { where: [among('published', ['1', '2'])], columns: authorNotes },
  contentitem_tag_map: {
    where: [
      copied('content_item_id', 'content', 'id'),
      among('type_alias', ['com_content.article']),
    ],
  },
  fields: { where: [ofArticles('context')], columns: { note: 'empty' } },
  fields_groups: { where: [ofArticles('context')], columns: { note: 'empty' } },
  fields_categories: { where: [copied('field_id', 'fields', 'id')] },
  fields_values: {
    where: [copied('field_id', 'fields', 'id'), copied('item_id', 'content', 'id')],
  },
  ucm_content: {
    where: [ofArticles('core_type_alias'), among('core_state', ['1', '2'])],
    columns: { core_created_by_alias: 'empty', core_metadata: 'empty', version_note: 'empty' },
  },
  ucm_base: { where: [copied('ucm_id', 'ucm_content', 'core_content_id')] },
  schemaorg: { where: [ofArticles('context'), copied('itemId', 'content', 'id')] },
  newsfeeds: { where: [among('published', ['1'])], columns: { created_by_alias: 'empty' } },
  banners: { where: [among('state', ['1'])], columns: { created_by_alias: 'empty' } },
  workflows: { where: [] },
  workflow_stages: { where: [] },
  workflow_transitions: { where: [] },
  workflow_associations: {
    where: [copied('item_id', 'content', 'id'), among('extension', ['com_content.article'])],
  },
  user_usergroup_map: { where: [copied('user_id', 'users', 'id')] },
  finder_taxonomy: { where: [among('parent_id', ['0', '1'])] },
}

describe('the database copy of a Joomla preview (Т56, Т57)', () => {
  it.each(branches)('is a policy the domain accepts on %s', (generation) => {
    const policy = policyOf(generation)
    expect(databaseCopyPolicySchema.parse(policy)).toEqual(policy)
    expect(policy.engine).toBe('mysql')
    expect(policy.tables.length).toBeLessThanOrEqual(128)
    expect(policy.suspectColumns).toBe('empty')
  })

  it('copies rows of one list on every branch, the users table aside', () => {
    const tables = (generation: string) => policyOf(generation).tables.map((rule) => rule.table)
    for (const generation of branches) expect(tables(generation)).toEqual(tables('j6'))
    expect(tables('j6').sort()).toEqual(
      [
        'assets',
        'associations',
        'banners',
        'categories',
        'content',
        'content_frontpage',
        'content_types',
        'contentitem_tag_map',
        'extensions',
        'fields',
        'fields_categories',
        'fields_groups',
        'fields_values',
        'finder_taxonomy',
        'finder_types',
        'languages',
        'menu',
        'menu_types',
        'modules',
        'modules_menu',
        'newsfeeds',
        'schemaorg',
        'schemas',
        'tags',
        'template_styles',
        'ucm_base',
        'ucm_content',
        'user_usergroup_map',
        'usergroups',
        'users',
        'viewlevels',
        'workflow_associations',
        'workflow_stages',
        'workflow_transitions',
        'workflows',
      ].sort(),
    )
    const { users: _users3, ...rest3 } = Object.fromEntries(
      policyOf('j3').tables.map((rule) => [rule.table, rule]),
    )
    const { users: _users6, ...rest6 } = Object.fromEntries(
      policyOf('j6').tables.map((rule) => [rule.table, rule]),
    )
    expect(rest3).toEqual(rest6)
  })

  it.each(structureOnly)('copies %s as structure only', (table) => {
    expect(policyOf('j5').tables.map((rule) => rule.table)).not.toContain(table)
  })

  it('takes no table of people, logs or the index but the root and branches of the taxonomy', () => {
    for (const rule of policyOf('j5').tables) {
      expect(rule.table).not.toMatch(/^privacy_/)
      if (rule.table.startsWith('finder_'))
        expect(['finder_taxonomy', 'finder_types']).toContain(rule.table)
    }
    // The leaves of the branch Author are names of people (`plg_finder_content`).
    expect(ruleOf(policyOf('j5'), 'finder_taxonomy').where).toEqual([
      { op: 'in', column: 'parent_id', values: ['0', '1'] },
    ])
  })

  it('follows only tables it copies, without a cycle', () => {
    const policy = policyOf('j4')
    const rules = new Map(policy.tables.map((rule) => [rule.table, rule]))
    const visit = (table: string, path: readonly string[]) => {
      for (const condition of rules.get(table)!.where) {
        if (condition.op !== 'inCopied') continue
        expect(rules.has(condition.table)).toBe(true)
        expect(path).not.toContain(condition.table)
        visit(condition.table, [...path, condition.table])
      }
    }
    for (const rule of policy.tables) visit(rule.table, [rule.table])
  })

  it.each(branches)(
    '%s: blanks the address of the SEF plugin in a row where production filled it (Э3.11)',
    (branch) => {
      const { overrides } = policyOf(branch)
      // The row of the installer of 6.2.0, as a site that set the address of its canonical links has it.
      const row = {
        name: 'plg_system_sef',
        params:
          '{"domain":"https:\\/\\/shop.example.ru","indexphp":"1","trailingslash":"0","enforcesuffix":"1","strictrouting":"1"}',
      }
      const matched = overrides.filter(
        (override) =>
          override.table === 'extensions' &&
          row[override.match.column as keyof typeof row] === override.match.value,
      )
      expect(matched).toHaveLength(1)
      const [sef] = matched
      // The row stays, its other columns and settings as production has them.
      expect(sef!.set).toEqual({})
      expect(sef!.blank?.column).toBe('params')
      const params = JSON.parse(row.params) as Record<string, string>
      for (const key of sef!.blank!.keys) params[key] = ''
      expect(params).toEqual({
        domain: '',
        indexphp: '1',
        trailingslash: '0',
        enforcesuffix: '1',
        strictrouting: '1',
      })
      expect(ruleOf(policyOf(branch), 'extensions').columns?.params).toBe('scrub_secrets')
    },
  )

  it('keeps no row of the cache, the scheduler, the statistics or the update mail plugin (Т56)', () => {
    const overrides = policyOf('j3').overrides.filter((override) => override.set === null)
    expect(overrides.map((override) => override.match)).toEqual([
      { column: 'name', value: 'plg_system_cache' },
      { column: 'name', value: 'plg_system_schedulerunner' },
      { column: 'name', value: 'plg_system_stats' },
      // Its `params.email` lists the addresses of superusers.
      { column: 'name', value: 'plg_system_updatenotification' },
    ])
    // A row `set` would add where the source lacks the plugin, and 3.10 and 4.0 lack the
    // scheduler: a row of two columns would not load.
    for (const override of overrides) {
      expect(override.table).toBe('extensions')
      expect(override.set).toBeNull()
    }
  })

  it('copies what visitors see and nothing in the trash', () => {
    const policy = policyOf('j5')
    for (const [state, copied] of [
      ['1', true],
      ['2', true],
      ['0', false],
      ['-2', false],
    ] as const)
      expect(passes(policy, 'content', { state })).toBe(copied)
    for (const table of ['categories', 'tags']) {
      expect(passes(policy, table, { published: '1' })).toBe(true)
      expect(passes(policy, table, { published: '2' })).toBe(true)
      expect(passes(policy, table, { published: '0' })).toBe(false)
      expect(passes(policy, table, { published: '-2' })).toBe(false)
    }
    expect(passes(policy, 'modules', { published: '1' })).toBe(true)
    expect(passes(policy, 'modules', { published: '0' })).toBe(false)
    expect(passes(policy, 'modules', { published: '-2' })).toBe(false)
    // Published only: an archived module, feed or banner is not shown.
    expect(passes(policy, 'modules', { published: '2' })).toBe(false)
    expect(passes(policy, 'newsfeeds', { published: '1' })).toBe(true)
    expect(passes(policy, 'newsfeeds', { published: '0' })).toBe(false)
    expect(passes(policy, 'newsfeeds', { published: '2' })).toBe(false)
    expect(passes(policy, 'banners', { state: '0' })).toBe(false)
    expect(passes(policy, 'banners', { state: '2' })).toBe(false)
    expect(passes(policy, 'banners', { state: '1' })).toBe(true)
    // Fields and their values of articles only; `_` is literal.
    expect(passes(policy, 'fields', { context: 'com_content.article' })).toBe(true)
    expect(passes(policy, 'fields', { context: 'com_users.user' })).toBe(false)
    expect(passes(policy, 'fields', { context: 'comXcontent.article' })).toBe(false)
    expect(passes(policy, 'fields_groups', { context: 'com_contact.contact' })).toBe(false)
    expect(passes(policy, 'ucm_content', { core_type_alias: 'com_contact.contact' })).toBe(false)
    expect(
      passes(policy, 'ucm_content', { core_type_alias: 'com_content.article', core_state: '0' }),
    ).toBe(false)
    expect(passes(policy, 'schemaorg', { context: 'com_content.article' })).toBe(true)
    expect(passes(policy, 'schemaorg', { context: 'com_contact.contact' })).toBe(false)
  })

  it('ties fields values and schema.org data to the articles of the copy', () => {
    const policy = policyOf('j6')
    expect(ruleOf(policy, 'fields_values').where).toEqual([
      { op: 'inCopied', column: 'field_id', table: 'fields', key: 'id' },
      { op: 'inCopied', column: 'item_id', table: 'content', key: 'id' },
    ])
    expect(ruleOf(policy, 'schemaorg').where).toContainEqual({
      op: 'inCopied',
      column: 'itemId',
      table: 'content',
      key: 'id',
    })
    expect(ruleOf(policy, 'users').where).toEqual([
      { op: 'inCopied', column: 'id', table: 'content', key: 'created_by' },
    ])
    expect(ruleOf(policy, 'modules_menu').where).toEqual([
      { op: 'inCopied', column: 'moduleid', table: 'modules', key: 'id' },
    ])
  })

  it.each(['j3', 'j6'])('has the conditions and columns of the contract on %s', (generation) => {
    const lastDate = generation === 'j3' ? 'empty' : 'null'
    const expected: Record<string, Omit<DatabaseCopyPolicy['tables'][number], 'table'>> = {
      ...expectedRules,
      users: {
        where: [copied('id', 'content', 'created_by')],
        columns: {
          name: 'synthetic_name',
          username: 'synthetic_login',
          email: 'synthetic_email',
          password: 'random_password_hash',
          sendEmail: 'keep',
          activation: 'empty',
          params: 'empty',
          otpKey: 'empty',
          otep: 'empty',
          authProvider: 'empty',
          lastvisitDate: lastDate,
          lastResetTime: lastDate,
        },
      },
    }
    const actual = Object.fromEntries(
      policyOf(generation).tables.map(({ table, ...rule }) => [table, rule]),
    )
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
    for (const [table, rule] of Object.entries(expected)) expect(actual[table], table).toEqual(rule)
  })

  it('makes authors synthetic and keeps their mail switch', () => {
    const columns = ruleOf(policyOf('j5'), 'users').columns
    expect(columns).toMatchObject({
      name: 'synthetic_name',
      username: 'synthetic_login',
      email: 'synthetic_email',
      password: 'random_password_hash',
      sendEmail: 'keep',
      activation: 'empty',
      params: 'empty',
      otpKey: 'empty',
      otep: 'empty',
      authProvider: 'empty',
    })
  })

  it('names every column with a name of people or a secret in the tables it copies', () => {
    for (const [release, schema] of [
      ['3.10.12', copiedTableColumns31012],
      ['6.2.0', copiedTableColumns620],
    ] as const)
      for (const generation of branches) {
        const policy = policyOf(generation)
        for (const rule of policy.tables) {
          // Every table of the list is one 6.2.0 creates: the check below is not empty.
          expect(copiedTableColumns620, rule.table).toHaveProperty(rule.table)
          const unnamed = (schema[rule.table] ?? []).filter(
            (column) =>
              suspectColumnNames.test(column) && !Object.hasOwn(rule.columns ?? {}, column),
          )
          expect(unnamed, `${release} ${rule.table}`).toEqual([])
        }
      }
  })

  it('filters on columns both releases have', () => {
    const policy = policyOf('j6')
    // `newsfeeds` publishes by `published`, `banners` by `state`.
    for (const schema of [copiedTableColumns31012, copiedTableColumns620])
      for (const rule of policy.tables) {
        const columns = schema[rule.table]
        if (!columns) continue
        for (const condition of rule.where) {
          expect(columns, `${rule.table}.${condition.column}`).toContain(condition.column)
          if (condition.op === 'inCopied')
            expect(schema[condition.table] ?? [condition.key]).toContain(condition.key)
        }
      }
  })
})

describe('the dates of an author by the branch (Э1.4: 3.10 refuses NULL)', () => {
  const schema310 = columnsOf(usersTable31012)
  const schema620 = columnsOf(usersTable620)

  it('reads the schemas as the releases give them', () => {
    expect(schema310.get('lastvisitDate')).toEqual({ nullable: false })
    expect(schema310.get('lastResetTime')).toEqual({ nullable: false })
    expect(schema620.get('lastvisitDate')).toEqual({ nullable: true })
    expect(schema620.get('lastResetTime')).toEqual({ nullable: true })
  })

  it.each(['j30', 'j3'])('gives no NULL to a NOT NULL column of 3.10 on %s', (generation) => {
    const columns = ruleOf(policyOf(generation), 'users').columns ?? {}
    for (const [column, { nullable }] of schema310)
      if (!nullable) expect(columns[column], column).not.toBe('null')
    expect(columns.lastvisitDate).toBe('empty')
    expect(columns.lastResetTime).toBe('empty')
  })

  it.each(['j4', 'j5', 'j6'])('writes NULL where 6.2 takes it on %s', (generation) => {
    const columns = ruleOf(policyOf(generation), 'users').columns ?? {}
    for (const column of ['lastvisitDate', 'lastResetTime']) {
      expect(schema620.get(column)?.nullable, column).toBe(true)
      expect(columns[column], column).toBe('null')
    }
    for (const [column, { nullable }] of schema620)
      if (!nullable) expect(columns[column], column).not.toBe('null')
  })
})

describe('what a Joomla copy needs of the site', () => {
  it('refuses a site without a generation or with one the table lacks', () => {
    for (const facts of [site(), site('j7')]) {
      expect(() => joomlaDatabaseCopyPolicy(facts, { previewId })).toThrow(DomainError)
      expect(() => joomlaGenerationOf(facts)).toThrow(
        expect.objectContaining({ code: 'BAD_REQUEST' }),
      )
    }
    expect(joomlaGenerationOf(site('j4')).id).toBe('j4')
  })

  it('refuses a site without the database settings of production', () => {
    expect(() => joomlaDatabaseOf(site('j5', false))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
    expect(() => joomlaDatabaseCopyPolicy(site('j5', false), { previewId })).toThrow(DomainError)
    expect(joomlaDatabaseOf(site('j5'))).toEqual(database)
  })
})
