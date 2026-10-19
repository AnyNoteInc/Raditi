import type {
  DatabaseCopyCondition,
  DatabaseCopyPolicy,
  PreviewCopyTarget,
  SiteDatabaseSettings,
  SiteFacts,
} from '@repo/domain'
import {
  badRequest,
  databaseCopyPolicySchema,
  siteDatabaseSettingsSchema,
  siteImportLimits,
} from '@repo/domain'

import { phpStringsAfter, type ConfigFileReader } from './php-config.ts'
import { wordpressMcpPolicy } from './wordpress-mcp-policy.ts'

// The rows a WordPress preview's database copy may hold (docs/plan/53-chat-preview-release.md,
// Р15): an allow list filtered in the SELECT at the source; every other table is structure
// only. People are synthetic, secrets stay out, the plugin «Радити» is bound to the preview.

const ws = '[ \\t\\r\\n]*'
const defineOf = (name: string) =>
  new RegExp(`\\bdefine${ws}\\(${ws}(['"])${name}\\1${ws},${ws}`, 'i')
const defineEnd = new RegExp(`${ws}\\)`)
const tablePrefixAssignment = new RegExp(`\\$table_prefix${ws}=${ws}`)
const statementEnd = new RegExp(`${ws};`)
/** A multisite network keeps a set of tables per site: its copy is not supported. */
const multisite = new RegExp(`\\bdefine${ws}\\(${ws}(['"])MULTISITE\\1${ws},${ws}true\\b`, 'i')

/** The one value a configuration states, or null when it states none or several. */
function single(values: readonly string[]): string | null {
  const distinct = [...new Set(values)]
  return distinct.length === 1 ? (distinct[0] ?? null) : null
}

/**
 * The encoding of the production connection, as `wpdb::determine_charset` makes it of
 * DB_CHARSET and DB_COLLATE: `utf8` becomes `utf8mb4` (every server WordPress supports has it),
 * and with it a `utf8_` collation its `utf8mb4_` twin, `utf8_general_ci` or none
 * `utf8mb4_unicode_ci`.
 */
function connectionEncoding(
  charset: string,
  collate: string,
): Pick<SiteDatabaseSettings, 'charset' | 'collation'> {
  if (charset !== 'utf8' && charset !== 'utf8mb4') return { charset, collation: collate || null }
  if (collate === '' || collate === 'utf8_general_ci')
    return { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }
  return { charset: 'utf8mb4', collation: collate.replace(/^utf8_/, 'utf8mb4_') }
}

/**
 * `SiteAdapter.databaseSettings`: `$table_prefix`, DB_CHARSET and DB_COLLATE of wp-config.php
 * in the site root, each a constant literal stated once. null for a multisite network, a
 * configuration that computes them, and an empty DB_CHARSET (the server's default then decides,
 * which the platform cannot know).
 */
export async function wordpressDatabaseSettings(
  read: ConfigFileReader,
): Promise<SiteDatabaseSettings | null> {
  const file = await read('wp-config.php')
  if (!file || file.byteLength > siteImportLimits.configFileBytes) return null
  if (multisite.test(new TextDecoder('latin1').decode(file))) return null
  const tablePrefix = single(phpStringsAfter(file, tablePrefixAssignment, statementEnd))
  const charset = single(phpStringsAfter(file, defineOf('DB_CHARSET'), defineEnd))
  const collations = phpStringsAfter(file, defineOf('DB_COLLATE'), defineEnd)
  const collate = collations.length === 0 ? '' : single(collations)
  if (tablePrefix === null || !charset || collate === null) return null
  const parsed = siteDatabaseSettingsSchema.safeParse({
    tablePrefix,
    ...connectionEncoding(charset.toLowerCase(), collate.toLowerCase()),
  })
  return parsed.success ? parsed.data : null
}

/** A name for `LIKE`, every wildcard of it literal. */
const literal = (name: string) => name.replace(/[\\%_]/g, (char) => `\\${char}`)
/** A pattern of wordpressMcpPolicy (`*` any run) for `LIKE`. */
const fromGlob = (pattern: string) => pattern.split('*').map(literal).join('%')

/**
 * Keys with signs of a secret: the credential patterns the MCP policy keeps away from the agent,
 * and a few more that plugins use for license keys, sessions and nonces.
 */
export const wordpressSecretKeyPatterns: readonly string[] = [
  ...wordpressMcpPolicy.protectedOptions.filter((pattern) =>
    /^\*.*(?:pass|secret|token|key|salt)/.test(pattern),
  ),
  '*credential*',
  '*license*',
  '*session*',
  '*nonce*',
  '*pwd*',
  '*pass',
].map(fromGlob)

/**
 * What a preview shows of posts: the types of Р15 and what this adapter adds so that an
 * unchanged preview looks like the site — the Additional CSS of the Customizer, the fonts of a
 * block theme, the templates and the global kit of Elementor. Attachments carry the status
 * `inherit`.
 */
export const wordpressPreviewPostTypes: readonly string[] = [
  'post',
  'page',
  'attachment',
  'nav_menu_item',
  'wp_block',
  'wp_template',
  'wp_template_part',
  'wp_global_styles',
  'wp_navigation',
  'custom_css',
  'wp_font_family',
  'wp_font_face',
  'elementor_library',
]
const postStatuses = ['publish', 'private', 'draft', 'inherit']

/**
 * Taxonomies whose terms the copy holds: those of the copied post types, never one a plugin
 * keeps people in (the `author` of Co-Authors Plus and PublishPress Authors holds names and
 * emails in the description and the meta of its terms).
 */
export const wordpressPreviewTaxonomies: readonly string[] = [
  'category',
  'post_tag',
  'post_format',
  'nav_menu',
  'link_category',
  'wp_theme',
  'wp_template_part_area',
  'wp_pattern_category',
  'elementor_library_type',
  'elementor_library_category',
]

/**
 * Options that decide how the site looks and reads, the core's and those of the builders this
 * adapter knows; nothing about people or mail.
 */
const displayOptions = [
  'siteurl',
  'home',
  'blogname',
  'blogdescription',
  'blog_charset',
  'html_type',
  'db_version',
  'initial_db_version',
  'fresh_site',
  'WPLANG',
  'timezone_string',
  'gmt_offset',
  'date_format',
  'time_format',
  'start_of_week',
  'permalink_structure',
  'category_base',
  'tag_base',
  'show_on_front',
  'page_on_front',
  'page_for_posts',
  'wp_page_for_privacy_policy',
  'posts_per_page',
  'posts_per_rss',
  'rss_use_excerpt',
  'sticky_posts',
  'default_category',
  'default_post_format',
  'use_smilies',
  'use_balanceTags',
  'default_comment_status',
  'default_ping_status',
  'comment_registration',
  'require_name_email',
  'close_comments_for_old_posts',
  'close_comments_days_old',
  'show_comments_cookies_opt_in',
  'thread_comments',
  'thread_comments_depth',
  'page_comments',
  'comments_per_page',
  'default_comments_page',
  'comment_order',
  'show_avatars',
  'avatar_rating',
  'avatar_default',
  'thumbnail_size_w',
  'thumbnail_size_h',
  'thumbnail_crop',
  'medium_size_w',
  'medium_size_h',
  'medium_large_size_w',
  'medium_large_size_h',
  'large_size_w',
  'large_size_h',
  'image_default_link_type',
  'image_default_size',
  'image_default_align',
  'uploads_use_yearmonth_folders',
  'upload_path',
  'upload_url_path',
  'wp_attachment_pages_enabled',
  'link_manager_enabled',
  'template',
  'stylesheet',
  'current_theme',
  'active_plugins',
  'sidebars_widgets',
  'nav_menu_options',
  'site_icon',
  'site_logo',
  // Elementor: the active kit (a copied `elementor_library` post), where its templates apply,
  // its layout settings and versions — without them it sets the site up anew.
  'elementor_version',
  'elementor_pro_version',
  'elementor_active_kit',
  'elementor_pro_theme_builder_conditions',
  'elementor_cpt_support',
  'elementor_disable_color_schemes',
  'elementor_disable_typography_schemes',
  'elementor_container_width',
  'elementor_space_between_widgets',
  'elementor_stretched_section_container',
  'elementor_page_title_selector',
  'elementor_viewport_lg',
  'elementor_viewport_md',
  'elementor_global_image_lightbox',
  'elementor_css_print_method',
  'elementor_font_display',
  'elementor_load_fa4_shim',
]

/** Option names that are never copied whatever the allow list says. */
const refusedOptions = ['_transient_*', '_site_transient_*', 'raditi_content_call_*'].map(fromGlob)

/** Rows copied from a table only when they belong to a copied post or term. */
const ofCopied = (column: string, table: string, key: string): DatabaseCopyCondition => ({
  op: 'inCopied',
  column,
  table,
  key,
})
const withoutSecrets = (column: string): DatabaseCopyCondition => ({
  op: 'notLike',
  column,
  patterns: [...wordpressSecretKeyPatterns],
})

/**
 * The database settings of production (`SiteAdapter.databaseSettings`), which the recipe, the
 * policy and the copier take from the same `SiteFacts.database`: without them the prefix of the
 * copied tables and the one the preview reads could differ, and WordPress would offer to install
 * itself to anyone with a preview session.
 */
export function wordpressDatabaseOf(site: SiteFacts): SiteDatabaseSettings {
  if (!site.database)
    throw badRequest('A WordPress preview needs the database settings of production')
  return site.database
}

/**
 * `SiteAdapter.databaseCopyPolicy`. Tables are named without the prefix; the roles of the site
 * live in the option `<prefix>user_roles`, so the prefix of `site.database` names it.
 */
export function wordpressDatabaseCopyPolicy(
  site: SiteFacts,
  preview: PreviewCopyTarget,
): DatabaseCopyPolicy {
  const { tablePrefix } = wordpressDatabaseOf(site)
  return databaseCopyPolicySchema.parse({
    engine: 'mysql',
    tables: [
      {
        table: 'posts',
        where: [
          { op: 'in', column: 'post_type', values: [...wordpressPreviewPostTypes] },
          { op: 'in', column: 'post_status', values: postStatuses },
        ],
        columns: { post_password: 'empty' },
      },
      // A copied value may hold secret keys of its own: the forms of a page builder, the
      // settings of a widget or a theme (Р14). Their strings are blanked in the copy.
      {
        table: 'postmeta',
        where: [ofCopied('post_id', 'posts', 'ID'), withoutSecrets('meta_key')],
        columns: { meta_value: 'scrub_secrets' },
      },
      // The authors of the copied posts, with the same ids and nothing else of them.
      {
        table: 'users',
        where: [ofCopied('ID', 'posts', 'post_author')],
        columns: {
          user_login: 'synthetic_login',
          user_nicename: 'synthetic_login',
          user_email: 'synthetic_email',
          user_pass: 'random_password_hash',
          user_url: 'empty',
          user_activation_key: 'empty',
          display_name: 'synthetic_name',
        },
      },
      // Terms of the allowed taxonomies only, and their links to copied posts.
      {
        table: 'term_taxonomy',
        where: [{ op: 'in', column: 'taxonomy', values: [...wordpressPreviewTaxonomies] }],
      },
      { table: 'terms', where: [ofCopied('term_id', 'term_taxonomy', 'term_id')] },
      {
        table: 'term_relationships',
        where: [
          ofCopied('object_id', 'posts', 'ID'),
          ofCopied('term_taxonomy_id', 'term_taxonomy', 'term_taxonomy_id'),
        ],
      },
      {
        table: 'termmeta',
        where: [ofCopied('term_id', 'terms', 'term_id'), withoutSecrets('meta_key')],
        columns: { meta_value: 'scrub_secrets' },
      },
      {
        table: 'options',
        where: [
          {
            op: 'like',
            column: 'option_name',
            patterns: [
              ...[...displayOptions, `${tablePrefix}user_roles`].map(literal),
              fromGlob('theme_mods_*'),
              fromGlob('widget_*'),
            ],
          },
          { op: 'notLike', column: 'option_name', patterns: refusedOptions },
          withoutSecrets('option_name'),
        ],
        columns: { option_value: 'scrub_secrets' },
      },
    ],
    overrides: [
      // The plugin «Радити» of the copy answers to this preview, from epoch 0, with no receipt.
      option('raditi_content_site_id', preview.previewId),
      option('raditi_content_epoch', '0'),
      // Search engines are told to stay away; the address of the site's admin is not a person's.
      option('blog_public', '0'),
      option('admin_email', 'admin@preview.invalid'),
    ],
  })
}

function option(name: string, value: string) {
  return {
    table: 'options',
    match: { column: 'option_name', value: name },
    set: { option_value: value },
  }
}
