import type { PreviewRecipe, SiteFacts } from '@repo/domain'
import { PREVIEW_SETTINGS_PATH, previewRecipeSchema } from '@repo/domain'

import { phpVersionNumber, phpVersionsNear } from './php/versions.ts'
import { wordpressDatabaseOf } from './wordpress-db-copy.ts'
import {
  previewApacheConf,
  previewWpConfigPhp,
  raditiContentPhp,
  raditiPreviewPhp,
} from './wordpress-preview-files.ts'

// How a WordPress site runs as a preview and what its release may replay in the database
// (docs/plan/53-chat-preview-release.md, Р3, Р14–Р16). The files come from infra/wordpress
// (wordpress-preview-files.ts): a wp-config.php and the mu-plugin raditi-preview.php that read
// the preview's settings file, the platform's content plugin, the configuration of Apache.

/** PHP versions a WordPress preview may run on; the images come from PREVIEW_SITE_IMAGES. */
const phpVersions = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'] as const
/** A site whose PHP is unknown runs on the version WordPress recommends. */
const DEFAULT_PHP = '8.3'

/**
 * The PHP versions to try for a site, the one of its hosting first, then by distance from it
 * (`phpVersionsNear`); a site whose PHP is unknown runs on the version WordPress recommends.
 */
export function wordpressPhpVersions(runtimeVersion: string | undefined): string[] {
  const known = phpVersionNumber(runtimeVersion ?? '') !== null
  return phpVersionsNear(phpVersions, known ? runtimeVersion : DEFAULT_PHP)
}

/** Where the runtime writes the configuration files of the server: next to the settings file. */
const settingsFolder = PREVIEW_SETTINGS_PATH.slice(0, PREVIEW_SETTINGS_PATH.lastIndexOf('/'))

/** The platform's files in a preview's tree; the agent's working set leaves them out (Р11). */
export const wordpressPreviewFiles = [
  { path: 'wp-config.php', content: previewWpConfigPhp },
  { path: 'wp-content/mu-plugins/raditi-content.php', content: raditiContentPhp },
  { path: 'wp-content/mu-plugins/raditi-preview.php', content: raditiPreviewPhp },
] as const

/**
 * The account of the platform in a preview's copy (R5c): an administrator with an application
 * password for the plugin «Радити». The copy holds no user meta of the site, so it is made after
 * every load of the seed; plugins and themes of the site are not loaded for it.
 */
const accessPhp = [
  "$l = 'raditi-platform';",
  "$u = get_user_by('login', $l);",
  'if (!$u) {',
  "  $i = wp_insert_user(['user_login' => $l, 'user_email' => 'platform@preview.invalid', 'user_pass' => wp_generate_password(64, true, true), 'role' => 'administrator']);",
  '  if (is_wp_error($i)) { fwrite(STDERR, "user\\n"); exit(3); }',
  "  $u = get_user_by('id', $i);",
  "} elseif (!in_array('administrator', (array) $u->roles, true)) { $u->set_role('administrator'); }",
  "$p = WP_Application_Passwords::create_new_application_password($u->ID, ['name' => 'raditi-' . wp_generate_uuid4()]);",
  'if (is_wp_error($p)) { fwrite(STDERR, "password\\n"); exit(3); }',
  "echo wp_json_encode(['v' => '1', 'username' => $l, 'applicationPassword' => $p[0]]);",
].join('\n')

/** The published posts and pages of the copy the plugin edits, as refs (`post:42`). */
const objectsPhp = [
  'global $wpdb;',
  "$r = $wpdb->get_results(\"SELECT ID, post_type FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_type IN ('post', 'page') AND post_password = '' ORDER BY ID LIMIT 5000\");",
  "echo wp_json_encode(array_map(function ($o) { return $o->post_type . ':' . $o->ID; }, $r ?: []));",
].join('\n')

const wpEval = (php: string) => ['wp', '--skip-plugins', '--skip-themes', 'eval', php]

/**
 * `SiteAdapter.previewRecipe`. The prefix and the encoding are those of `site.database`, the
 * same the copy policy and the copier take: a preview never guesses them.
 */
export function wordpressPreviewRecipe(site: SiteFacts): PreviewRecipe {
  const database = wordpressDatabaseOf(site)
  return previewRecipeSchema.parse({
    runtime: 'php',
    runtimeVersions: wordpressPhpVersions(site.runtimeVersion),
    database: 'mysql',
    // The core is in the repository since the import of 17.10.2026 (plan 39): without it the
    // preview is unavailable (`no_core`), never a broken page.
    requiredPaths: [
      'index.php',
      'wp-load.php',
      'wp-settings.php',
      'wp-blog-header.php',
      'wp-includes/version.php',
    ],
    generatedFiles: wordpressPreviewFiles.map((file) => ({ ...file })),
    // What the generated wp-config.php takes from the production configuration (Р15).
    settings: {
      TABLE_PREFIX: database.tablePrefix,
      DB_CHARSET: database.charset,
      DB_COLLATE: database.collation ?? '',
    },
    healthPath: '/',
    // A dead WordPress answers 5xx or fails `content.access` first; a text would only mark a live
    // site that quotes it as dead. `fatalMark`: wp-config marks a fatal error with the check's key.
    ready: { header: 'x-raditi-preview', absent: [], fatalMark: true },
    // Apache of the official PHP images (php:*-apache) as www-data on 127.0.0.1:8081, behind
    // the gateway of the preview's own container (docs/plan/58). The whole configuration is
    // preview-apache.conf; its run and lock folders are on the tmpfs /tmp.
    web: {
      command: ['apache2-foreground', '-f', `${settingsFolder}/apache2.conf`],
      env: {
        APACHE_RUN_DIR: '/tmp/apache2/run',
        APACHE_LOCK_DIR: '/tmp/apache2/lock',
        APACHE_PID_FILE: '/tmp/apache2/run/apache2.pid',
      },
      port: 8081,
      user: '33:33',
      docroot: '/var/www/html',
      tmpfs: ['/tmp'],
      configFiles: [{ name: 'apache2.conf', content: previewApacheConf }],
    },
    content: {
      access: wpEval(accessPhp),
      objects: wpEval(objectsPhp),
      pages: { post: '/?p={id}', page: '/?page_id={id}' },
    },
  })
}

export { wordpressDbOperationKinds } from './wordpress-db.ts'
