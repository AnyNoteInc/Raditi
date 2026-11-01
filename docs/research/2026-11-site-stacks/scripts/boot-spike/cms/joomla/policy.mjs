// The allow list of joomla.md §6.1 and the rules of §6.3, written exactly as the report proposes.
const all = (table, columns) => ({ table, where: [], ...(columns ? { columns } : {}) })
const scrub = { params: 'scrub_secrets' }
const copied = (table, column, from, key, extra = []) => ({ table, where: [{ op: 'inCopied', column, table: from, key }, ...extra] })
export const tables = [
  all('extensions', { params: 'scrub_secrets', custom_data: 'scrub_secrets' }),
  all('assets'), all('languages'), all('menu'), all('menu_types'),
  all('modules', scrub), all('modules_menu'), all('template_styles', scrub),
  all('usergroups'), all('viewlevels'), all('schemas'), all('content_types'),
  { table: 'content', where: [{ op: 'in', column: 'state', values: ['0', '1', '2'] }], columns: { created_by_alias: 'empty' } },
  copied('content_frontpage', 'content_id', 'content', 'id'),
  all('categories'), all('tags'),
  copied('contentitem_tag_map', 'content_item_id', 'content', 'id'),
  all('fields'), all('fields_groups'), all('fields_categories'), all('fields_values'),
  all('ucm_base'), all('ucm_content'), all('associations'), all('schemaorg'), all('newsfeeds'), all('banners'),
  all('workflows'), all('workflow_stages'), all('workflow_transitions'),
  copied('workflow_associations', 'item_id', 'content', 'id', [{ op: 'in', column: 'extension', values: ['com_content.article'] }]),
  { table: 'users', where: [{ op: 'inCopied', column: 'id', table: 'content', key: 'created_by' }],
    columns: { name: 'synthetic_name', username: 'synthetic_login', email: 'synthetic_email', password: 'random_password_hash', activation: 'empty', params: 'empty', otpKey: 'empty', otep: 'empty', authProvider: 'empty', lastvisitDate: 'null', lastResetTime: 'null' } },
  copied('user_usergroup_map', 'user_id', 'users', 'id'),
]

export const tablesFinder = [...tables, all('finder_taxonomy'), all('finder_types')]
