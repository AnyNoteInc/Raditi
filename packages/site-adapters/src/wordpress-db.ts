import { dbSettingSchema, type DbOperationKind, type DbSetting } from '@repo/domain'

// What a database plan of WordPress may change (docs/plan/53-chat-preview-release.md, «Операции
// БД и миграции»): the kinds the plugin «Радити» of version 2 writes, and the closed list of
// settings — the same list the plugin keeps in `raditi_content_settings()` (a test compares
// them). The list allows: addresses of the site, its theme and plugins, users and roles, mail,
// payments and its visibility to search engines are never in it (CLAUDE.md rule 4).

/** `SiteAdapter.dbOperationKinds` of WordPress. */
export function wordpressDbOperationKinds(): readonly DbOperationKind[] {
  return ['content_update', 'option_update', 'post_create', 'schema_migration']
}

const settings: readonly DbSetting[] = Object.freeze(
  [
    {
      option: 'blogname',
      setting: 'title',
      label: 'Название сайта',
      value: 'text',
      maxBytes: 200,
      display: 'html_text',
    },
    {
      option: 'blogdescription',
      setting: 'description',
      label: 'Описание сайта под названием',
      value: 'text',
      maxBytes: 500,
      display: 'html_text',
    },
    {
      option: 'date_format',
      setting: 'date_format',
      label: 'Формат даты',
      value: 'text',
      maxBytes: 64,
      forbidden: '<>',
      display: 'plain',
    },
    {
      option: 'time_format',
      setting: 'time_format',
      label: 'Формат времени',
      value: 'text',
      maxBytes: 64,
      forbidden: '<>',
      display: 'plain',
    },
    {
      option: 'start_of_week',
      setting: 'start_of_week',
      label: 'Первый день недели (0 — воскресенье)',
      value: 'integer',
      min: 0,
      max: 6,
      display: 'plain',
    },
    {
      option: 'posts_per_page',
      setting: 'posts_per_page',
      label: 'Записей на странице блога',
      value: 'integer',
      min: 1,
      max: 100,
      display: 'plain',
    },
  ].map((setting) => Object.freeze(dbSettingSchema.parse(setting))),
)

/** `SiteAdapter.dbSettings` of WordPress: the names the agent knows from `/wp/v2/settings`. */
export function wordpressDbSettings(): readonly DbSetting[] {
  return settings
}

/**
 * `SiteAdapter.dbPlanGuide` of WordPress: the routes of `wp_rest` for each kind, and how a theme
 * or a plugin names a table of the platform — the prefix of the plugin «Радити» puts `raditi_`
 * after the prefix of the site's tables.
 */
export function wordpressDbPlanGuide(): string {
  return `- On this site: the title, the text and the excerpt of a post or a page — \`wp_rest\` POST
  /wp/v2/pages/<id> or /wp/v2/posts/<id>; a new page or post — \`wp_rest\` POST /wp/v2/pages or
  /wp/v2/posts; a setting of the list — \`wp_rest\` GET and POST /wp/v2/settings; a table of the
  platform — \`db_schema\`.
- In code, the table of \`db_schema\` is \`$wpdb->prefix . 'raditi_' . name\`. No dbDelta, no CREATE
  TABLE or ALTER TABLE on activation, on init or anywhere else.
`
}
