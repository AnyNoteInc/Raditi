import type {
  DatabaseColumnTreatment,
  DatabaseCopyCondition,
  DatabaseCopyPolicy,
  PreviewCopyTarget,
  SiteDatabaseSettings,
  SiteFacts,
  StackGeneration,
} from '@repo/domain'
import { badRequest, compareSiteVersions, databaseCopyPolicySchema } from '@repo/domain'

import { joomlaGenerations } from './joomla-support.ts'

// The rows a Joomla preview's database copy holds (docs/plan/62-site-stacks.md, Т56, Т57;
// docs/plan/62-slices/e3.md, Э3.6): what Joomla needs to start and to show the site as visitors
// see it, and no one's data. An allow list filtered in the SELECT at the source, one list on every
// branch: a table a branch lacks is copied as nothing. Every other table — contacts, profiles,
// sessions, logs, history, the scheduler, messages, privacy requests, the search index — is
// structure only. Tables are named without the prefix.

/** The database settings of production, which the recipe, the policy and the copier share. */
export function joomlaDatabaseOf(site: SiteFacts): SiteDatabaseSettings {
  if (!site.database) throw badRequest('A Joomla preview needs the database settings of production')
  return site.database
}

/**
 * The row of `joomlaGenerations` the record of the site names (`sites.stack_facts.generation`).
 * The branch is not guessed from a column of the copy: a wrong one breaks the seed.
 */
export function joomlaGenerationOf(site: SiteFacts): StackGeneration {
  const row = joomlaGenerations.find((generation) => generation.id === site.generation)
  if (!row) throw badRequest('A Joomla preview needs the generation of the site')
  return row
}

/**
 * The dates of an author no one needs in a copy: `NOT NULL` in the schema of 3.x, where NULL stops
 * the seed at `#__users` (ERROR 1048; docs/plan/62-site-stacks.md, §10, «Э1.4: итог Т20», № 8),
 * nullable since 4.0, where NULL says «never» as Joomla itself does.
 */
function lastDateTreatment(generation: StackGeneration): DatabaseColumnTreatment {
  return compareSiteVersions(generation.from, '4.0') < 0 ? 'empty' : 'null'
}

type Rule = DatabaseCopyPolicy['tables'][number]
type Columns = Record<string, DatabaseColumnTreatment>

const all = (table: string, columns?: Columns): Rule => ({
  table,
  where: [],
  ...(columns ? { columns } : {}),
})
const ofCopied = (column: string, table: string, key: string): DatabaseCopyCondition => ({
  op: 'inCopied',
  column,
  table,
  key,
})
const isIn = (column: string, values: string[]): DatabaseCopyCondition => ({
  op: 'in',
  column,
  values,
})
/** Published, and archived: an archived article is still shown to visitors. */
const visible = (column: string) => isIn(column, ['1', '2'])
/** Of articles: fields, schema.org data and history of other components hold people. */
const ofArticles = (column: string): DatabaseCopyCondition => ({
  op: 'like',
  column,
  patterns: ['com\\_content.%'],
})

/**
 * Settings of extensions, menus and templates may hold keys of services: their strings under a
 * key that names a secret are blanked. `note` is the administrator's own remark. `client_id`
 * says site or administrator, not a client of anyone: kept, else the second line empties it.
 */
const scrubbed = { params: 'scrub_secrets', note: 'empty', client_id: 'keep' } as const
/** What an author wrote about the record beside its text: an alias, keywords of the author, notes. */
const authorNotes = { created_by_alias: 'empty', metadata: 'empty', note: 'empty' } as const

/**
 * `SiteAdapter.databaseCopyPolicy`. `preview` is not read: Joomla has no platform plugin bound to
 * a preview. The rows are what Joomla needs to start and what visitors see: the settings of
 * extensions, menus and templates without their secrets and the addresses of people, published
 * content of the site and the authors of the copied articles, synthetic.
 */
export function joomlaDatabaseCopyPolicy(
  site: SiteFacts,
  _preview: PreviewCopyTarget,
): DatabaseCopyPolicy {
  joomlaDatabaseOf(site)
  const lastDate = lastDateTreatment(joomlaGenerationOf(site))
  return databaseCopyPolicySchema.parse({
    engine: 'mysql',
    tables: [
      all('extensions', { ...scrubbed, custom_data: 'scrub_secrets' }),
      // Titles of assets repeat the titles of every article, drafts included; rights read `name`.
      all('assets', { title: 'empty' }),
      all('languages'),
      all('usergroups'),
      all('viewlevels'),
      all('schemas'),
      all('content_types'),
      all('associations'),
      all('finder_types'),
      all('menu_types', { client_id: 'keep' }),
      // Every item: `lft` and `rgt` of the tree count unpublished ones too, and no one's data is here.
      all('menu', scrubbed),
      { table: 'modules', where: [isIn('published', ['1'])], columns: scrubbed },
      { table: 'modules_menu', where: [ofCopied('moduleid', 'modules', 'id')] },
      all('template_styles', { params: 'scrub_secrets', client_id: 'keep' }),
      { table: 'content', where: [visible('state')], columns: authorNotes },
      { table: 'content_frontpage', where: [ofCopied('content_id', 'content', 'id')] },
      {
        table: 'categories',
        where: [visible('published')],
        columns: { metadata: 'empty', note: 'empty' },
      },
      { table: 'tags', where: [visible('published')], columns: authorNotes },
      {
        table: 'contentitem_tag_map',
        where: [
          ofCopied('content_item_id', 'content', 'id'),
          isIn('type_alias', ['com_content.article']),
        ],
      },
      { table: 'fields', where: [ofArticles('context')], columns: { note: 'empty' } },
      { table: 'fields_groups', where: [ofArticles('context')], columns: { note: 'empty' } },
      { table: 'fields_categories', where: [ofCopied('field_id', 'fields', 'id')] },
      {
        table: 'fields_values',
        where: [ofCopied('field_id', 'fields', 'id'), ofCopied('item_id', 'content', 'id')],
      },
      {
        table: 'ucm_content',
        where: [ofArticles('core_type_alias'), visible('core_state')],
        columns: {
          core_created_by_alias: 'empty',
          core_metadata: 'empty',
          version_note: 'empty',
        },
      },
      { table: 'ucm_base', where: [ofCopied('ucm_id', 'ucm_content', 'core_content_id')] },
      {
        table: 'schemaorg',
        where: [ofArticles('context'), ofCopied('itemId', 'content', 'id')],
      },
      {
        table: 'newsfeeds',
        where: [isIn('published', ['1'])],
        columns: { created_by_alias: 'empty' },
      },
      { table: 'banners', where: [isIn('state', ['1'])], columns: { created_by_alias: 'empty' } },
      all('workflows'),
      all('workflow_stages'),
      all('workflow_transitions'),
      {
        table: 'workflow_associations',
        where: [ofCopied('item_id', 'content', 'id'), isIn('extension', ['com_content.article'])],
      },
      // The authors of the copied articles, with the same ids and nothing else of them.
      {
        table: 'users',
        where: [ofCopied('id', 'content', 'created_by')],
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
      { table: 'user_usergroup_map', where: [ofCopied('user_id', 'users', 'id')] },
      // The root and the branches: the leaves of the branch Author are names of people, and the
      // indexer makes the leaves anew; without the root saving an article fails (`_getNode`).
      { table: 'finder_taxonomy', where: [isIn('parent_id', ['0', '1'])] },
    ],
    // A plugin without a row is not loaded (Т56: a preview does not act for the site): the page
    // cache, the runner of the scheduler on page views, the statistics sent to joomla.org, the
    // mail about updates to superusers, whose addresses its `params.email` lists (3.x and 4.x).
    // A null `set`, not `enabled = 0`: 3.10 and 4.0 lack the scheduler, 5.0 and later the update
    // mail, and the row a `set` adds where the source has none would not load.
    overrides: [
      'plg_system_cache',
      'plg_system_schedulerunner',
      'plg_system_stats',
      'plg_system_updatenotification',
    ].map((name) => ({ table: 'extensions', match: { column: 'name', value: name }, set: null })),
    suspectColumns: 'empty',
  })
}
