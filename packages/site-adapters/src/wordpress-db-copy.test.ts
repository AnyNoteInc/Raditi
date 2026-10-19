import { readFileSync } from 'node:fs'

import type { DatabaseCopyCondition, DatabaseCopyPolicy, SiteFacts } from '@repo/domain'
import { databaseCopyPolicySchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  wordpressDatabaseCopyPolicy,
  wordpressDatabaseSettings,
  wordpressSecretKeyPatterns,
} from './wordpress-db-copy.ts'

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

/** MySQL `LIKE` with `\` as the escape, ignoring letter case as the collations of WordPress do. */
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

/** Whether a row of the table passes the conditions of its rule that read its own columns. */
function passes(
  policy: DatabaseCopyPolicy,
  table: string,
  row: Record<string, string>,
): boolean | null {
  const rule = policy.tables.find((candidate) => candidate.table === table)
  if (!rule) return null
  return rule.where.every((condition: DatabaseCopyCondition) => {
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

  it('is an allow list the domain accepts', () => {
    expect(databaseCopyPolicySchema.parse(policy)).toEqual(policy)
    expect(policy.engine).toBe('mysql')
    // People, their comments and their sessions are structure only.
    expect(policy.tables.map((rule) => rule.table).sort()).toEqual([
      'options',
      'postmeta',
      'posts',
      'term_relationships',
      'term_taxonomy',
      'termmeta',
      'terms',
      'users',
    ])
  })

  it('copies the posts a site shows and none of its orders, requests or form entries', () => {
    for (const type of [
      'post',
      'page',
      'attachment',
      'nav_menu_item',
      'wp_global_styles',
      // What the adapter adds so that an unchanged preview looks like the site.
      'custom_css',
      'wp_font_family',
      'wp_font_face',
      'elementor_library',
    ])
      expect(passes(policy, 'posts', { post_type: type, post_status: 'publish' }), type).toBe(true)
    expect(passes(policy, 'posts', { post_type: 'attachment', post_status: 'inherit' })).toBe(true)
    for (const type of [
      'shop_order',
      'shop_order_refund',
      'shop_subscription',
      'user_request',
      'feedback',
      'flamingo_inbound',
      'nf_sub',
      'edd_payment',
      'wpforms',
      'customize_changeset',
      'revision',
      'oembed_cache',
    ])
      expect(passes(policy, 'posts', { post_type: type, post_status: 'publish' })).toBe(false)
    for (const status of ['trash', 'auto-draft', 'pending', 'future'])
      expect(passes(policy, 'posts', { post_type: 'post', post_status: status })).toBe(false)
    expect(policy.tables.find((rule) => rule.table === 'posts')?.columns).toEqual({
      post_password: 'empty',
    })
  })

  it('copies meta only of copied posts and terms, without keys that look like a secret', () => {
    const postmeta = policy.tables.find((rule) => rule.table === 'postmeta')
    expect(postmeta?.where).toContainEqual({
      op: 'inCopied',
      column: 'post_id',
      table: 'posts',
      key: 'ID',
    })
    expect(policy.tables.find((rule) => rule.table === 'termmeta')?.where).toContainEqual({
      op: 'inCopied',
      column: 'term_id',
      table: 'terms',
      key: 'term_id',
    })
    for (const key of ['user_email', 'first_name', 'last_name'])
      expect(passes(policy, 'termmeta', { meta_key: key }), key).toBe(true)
    for (const key of ['_thumbnail_id', '_wp_page_template', '_wp_attached_file', '_menu_item_url'])
      expect(passes(policy, 'postmeta', { meta_key: key })).toBe(true)
    for (const key of [
      '_stripe_secret',
      'api_token',
      'Mailchimp_API_Key',
      '_license_key',
      'smtp_password',
      'session_tokens',
      '_wpnonce',
      'auth_salt',
    ])
      expect(passes(policy, 'postmeta', { meta_key: key })).toBe(false)
  })

  it('copies terms of the taxonomies of the copied posts only, never of people', () => {
    for (const taxonomy of [
      'category',
      'post_tag',
      'nav_menu',
      'wp_theme',
      'wp_template_part_area',
      'wp_pattern_category',
      'elementor_library_type',
    ])
      expect(passes(policy, 'term_taxonomy', { taxonomy }), taxonomy).toBe(true)
    // Co-Authors Plus and PublishPress Authors keep names and emails in `author`; orders,
    // products and anything else of a plugin is not a taxonomy of a copied post.
    for (const taxonomy of ['author', 'shop_order_status', 'product_cat', 'pa_color', 'ngg_tag'])
      expect(passes(policy, 'term_taxonomy', { taxonomy }), taxonomy).toBe(false)
    // Terms, their meta (whatever its keys, `user_email` of an author too) and their links
    // follow the copied taxonomy rows.
    const where = (table: string) => policy.tables.find((rule) => rule.table === table)?.where
    expect(where('terms')).toEqual([
      { op: 'inCopied', column: 'term_id', table: 'term_taxonomy', key: 'term_id' },
    ])
    expect(where('termmeta')?.[0]).toEqual({
      op: 'inCopied',
      column: 'term_id',
      table: 'terms',
      key: 'term_id',
    })
    expect(where('term_relationships')).toEqual([
      { op: 'inCopied', column: 'object_id', table: 'posts', key: 'ID' },
      {
        op: 'inCopied',
        column: 'term_taxonomy_id',
        table: 'term_taxonomy',
        key: 'term_taxonomy_id',
      },
    ])
  })

  it('makes the authors of the copied posts synthetic, with the same ids', () => {
    const users = policy.tables.find((rule) => rule.table === 'users')
    expect(users?.where).toEqual([
      { op: 'inCopied', column: 'ID', table: 'posts', key: 'post_author' },
    ])
    expect(users?.columns).toEqual({
      user_login: 'synthetic_login',
      user_nicename: 'synthetic_login',
      user_email: 'synthetic_email',
      user_pass: 'random_password_hash',
      user_url: 'empty',
      user_activation_key: 'empty',
      display_name: 'synthetic_name',
    })
  })

  it('copies the options of how the site looks and reads, never a secret, a transient or cron', () => {
    for (const name of [
      'siteurl',
      'home',
      'blogname',
      'db_version',
      'permalink_structure',
      'active_plugins',
      'template',
      'stylesheet',
      'sidebars_widgets',
      'theme_mods_twentytwentyfive',
      'widget_block',
      // The roles of the site, under its own prefix.
      'shop_user_roles',
      // The kit and the template conditions of Elementor.
      'elementor_active_kit',
      'elementor_pro_theme_builder_conditions',
    ])
      expect(passes(policy, 'options', { option_name: name }), name).toBe(true)
    for (const name of [
      'cron',
      '_transient_doing_cron',
      '_site_transient_update_core',
      'auth_salt',
      'nonce_key',
      'logged_in_key',
      'secure_auth_salt',
      'mailserver_pass',
      'admin_email',
      'new_admin_email',
      'wp_mail_smtp',
      'wpforms_settings',
      'woocommerce_stripe_settings',
      'wp_user_roles',
      'rewrite_rules',
      'recently_edited',
      // A widget or a theme's settings named like a secret.
      'widget_mailchimp_api_key',
      'theme_mods_shop_license',
      // The plugin «Радити»: its receipts never, its binding and epoch only as overridden.
      'raditi_content_call_0196abcd-0000-7000-8000-00000000000b',
      'raditi_content_site_id',
      'raditi_content_epoch',
      // `_` of an allowed name is no wildcard.
      'blognameX',
      'theme-mods-x',
      // Elementor by an explicit list: its connection to the vendor keeps tokens in a value.
      'elementor_connect_common_data',
      'elementor_pro_license_key',
      'elementor_activeXkit',
    ])
      expect(passes(policy, 'options', { option_name: name }), name).toBe(false)
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

  it('takes the patterns of a secret from the MCP policy and keeps the roles of the site', () => {
    for (const pattern of ['%password%', '%secret%', '%token%', '%api\\_key%', '%\\_salt'])
      expect(wordpressSecretKeyPatterns).toContain(pattern)
    expect(wordpressSecretKeyPatterns.some((pattern) => like('wp_user_roles', pattern))).toBe(false)
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
