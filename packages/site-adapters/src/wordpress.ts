import type { McpToolDescriptor, SiteAdapter } from '@repo/domain'
import { notImplemented } from '@repo/domain'
import { phpConfigStrings, secretValues } from './php-config.ts'
import {
  archivesAndDumps,
  dataFiles,
  phpServerConfigFiles,
  secretFiles,
  serverLogs,
} from './php-hosting.ts'

// Pattern syntax (the domain port leaves it open, so it is fixed here):
// - protectedPaths: path prefixes from the repository root, `*` within one segment,
//   a trailing `/` marks a directory — the syntax of forbiddenCiPaths (spec §10);
// - importRules and snapshotExcludes: .gitignore lines, usable as rsync and
//   `git ls-files --exclude` patterns. A leading `/` anchors to the root; patterns without a
//   slash (`*.sql`, `.env`) match at any depth.
// TODO(P10): WordPress in a subdirectory of the docroot and wp-config.php one level above it.

/** Core files in the docroot: WordPress updates own them. */
const coreRootFiles = ['wp-*.php', 'index.php', 'xmlrpc.php', 'license.txt', 'readme.html']

/** Drop-ins run before plugins with full access; cache plugins generate them. */
const dropIns = [
  'wp-content/advanced-cache.php',
  'wp-content/object-cache.php',
  'wp-content/db.php',
]

/** Caches and update leftovers. */
const generatedDirs = [
  'wp-content/cache/',
  'wp-content/upgrade/',
  'wp-content/upgrade-temp-backup/',
]

/** Full-site archives and DB dumps of backup plugins: personal data and credentials. */
const backupDirs = [
  'wp-content/backup*/',
  'wp-content/ai1wm-backups/',
  'wp-content/updraft/',
  'wp-content/backups-dup-lite/',
  'wp-content/backups-dup-pro/',
  'wp-content/wpvividbackups/',
  'wp-snapshots/',
]

/** Build output and logs at any depth; debug.log may hold personal data. */
const buildOutput = ['node_modules/', '*.log']

/** Uploads of a legacy multisite and the firewall logs of Wordfence: visitors' data, not code. */
const dataDirs = ['wp-content/blogs.dir/', 'wp-content/wflogs/']

/**
 * Folders inside the media where plugins keep what visitors sent: form attachments, the files of
 * shop customers, avatars, comment attachments, shop logs. The media library is imported (owner's
 * decision of 17.10.2026); these are personal data of third parties and never are (CLAUDE.md rule 1,
 * spec §11). A plugin that is not listed here is caught only by the scanners.
 */
const visitorDirs = [
  'gravity_forms/',
  'wpforms/',
  'wpcf7_uploads/',
  'ninja-forms/',
  'formidable/',
  'forminator/',
  'fluentform/',
  'elementor/forms/',
  'woocommerce_uploads/',
  'wc-logs/',
  // PDF invoices and packing slips of WooCommerce: names and addresses of customers.
  'wpo_wcpdf/',
  'edd/',
  'ultimatemember/',
  'avatars/',
  'group-avatars/',
  'buddypress/',
  'wpdiscuz/',
]

/**
 * The same folders in the media of every site of a network: `uploads/sites/<N>/` since WordPress 3.5,
 * `blogs.dir/<N>/files/` before it. `*` stays inside one segment, so `<N>` is any one folder name.
 */
const visitorUploadDirs = [
  'wp-content/uploads/',
  'wp-content/uploads/sites/*/',
  'wp-content/blogs.dir/*/files/',
].flatMap((media) => visitorDirs.map((dir) => `${media}${dir}`))

const anchored = (paths: readonly string[]) => paths.map((p) => `/${p}`)

const protectedPaths = [
  'wp-config.php',
  ...coreRootFiles,
  'wp-admin/',
  'wp-includes/',
  // Media is content: it changes through MCP with a snapshot, never through git.
  'wp-content/uploads/',
  ...generatedDirs,
  ...backupDirs,
  ...dropIns,
  ...phpServerConfigFiles,
]

const snapshotExcludes = [
  ...anchored(['wp-content/uploads/', ...dataDirs, ...generatedDirs, ...backupDirs]),
  ...buildOutput,
  ...serverLogs,
  'vendor/',
  ...archivesAndDumps,
  ...secretFiles,
]

// gitleaks scans the imported tree as well (P11): these lines are the first filter, not the only one.
// The core of WordPress and the media are imported (owner's decision of 17.10.2026): the first
// version of a site is the site as it runs, so it can be put back. The protected paths keep an
// agent diff out of them all the same.
const importExcludes = [
  ...anchored([
    'wp-config.php',
    'wp-content/wflogs/',
    ...visitorUploadDirs,
    ...generatedDirs,
    ...backupDirs,
    ...dropIns,
    ...phpServerConfigFiles,
  ]),
  // No slash: copies of the configuration at any depth — old/wp-config.php, wp-config.php.save.
  // The price: a folder of that name is left out whole, a plugin called wp-config-… included.
  'wp-config*',
  ...buildOutput,
  ...serverLogs,
  ...archivesAndDumps,
  ...dataFiles,
  ...secretFiles,
]

/** In the root folder of every installation; wp-config.php is not: it may lie one folder above. */
const rootMarkers = ['wp-content', 'wp-includes']

// `define( 'NAME', ` in front of the database password and of the eight keys and salts. Letter
// case is ignored: PHP reads `define` in any. Whitespace is all that may stand between the
// tokens: a comment there, parentheses around the value or a `const` declaration give no value.
const secretDefine =
  /\bdefine[ \t\r\n]*\([ \t\r\n]*(['"])(?:DB_PASSWORD|(?:SECURE_AUTH|LOGGED_IN|AUTH|NONCE)_(?:KEY|SALT))\1[ \t\r\n]*,[ \t\r\n]*/i
const defineEnd = /[ \t\r\n]*[),]/
/** What wp-config-sample.php ships in place of a key: no secret, and present in every copy of it. */
const samplePhrase = 'put your unique phrase here'

/**
 * MCP tools of the gateway for WordPress (spec §8, §11). Everything that changes the site
 * right away is reversible and snapshotted first. What CLAUDE.md rule 4 calls dangerous has
 * separate tools that the gateway runs only after an approved request_approval. Users,
 * orders and payment settings get no tool at all (spec §11): wordpressMcpPolicy is the
 * denylist the gateway applies to wp_cli, wp_rest and browser_* on every call, and it counts
 * changed objects per turn (above 20 → request_approval). TODO(P10): confirm the split.
 */
const mcpTools: McpToolDescriptor[] = [
  {
    name: 'site_info',
    description: 'Stack, versions, active theme, plugins and key pages of the site.',
    dangerous: false,
  },
  {
    name: 'wp_cli',
    description:
      'Whitelisted WP-CLI commands: reading and reversible edits of posts, pages, options, menus and media.',
    dangerous: false,
  },
  {
    name: 'wp_rest',
    description:
      'WordPress REST API: reading and reversible edits of pages, posts, media and menus.',
    dangerous: false,
  },
  {
    name: 'snapshot',
    description:
      'Save an object (post, option, media file) before changing it, so it can be undone.',
    dangerous: false,
  },
  {
    name: 'restore',
    description: 'Return an object to a snapshot taken in this task.',
    dangerous: false,
  },
  {
    name: 'media_upload',
    description: 'Upload a file from the client inbox to the media library.',
    dangerous: false,
  },
  {
    name: 'browser_open',
    description: 'Open a page of the client site in the browser; other domains are blocked.',
    dangerous: false,
  },
  {
    name: 'browser_click',
    description: 'Click an element on the open page of the client site.',
    dangerous: false,
  },
  {
    name: 'browser_fill',
    description: 'Fill a form field on the open page of the client site.',
    dangerous: false,
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the open page.',
    dangerous: false,
  },
  {
    name: 'request_approval',
    description:
      'Show the client what will change and wait for the decision. Required before every dangerous tool.',
    dangerous: false,
  },
  {
    name: 'wp_delete',
    description: 'Delete pages, posts or media files.',
    dangerous: true,
  },
  {
    name: 'wp_theme',
    description: 'Switch or update the theme.',
    dangerous: true,
  },
  {
    name: 'wp_plugin',
    description: 'Install, activate, deactivate or update plugins.',
    dangerous: true,
  },
  {
    name: 'wp_bulk_edit',
    description: 'Change more than 20 objects in one go; the client sees the full list.',
    dangerous: true,
  },
]

const todo = (method: string) => notImplemented(`WordPressAdapter.${method} (P10)`)

export const wordpressAdapter: SiteAdapter = {
  stack: 'wordpress',
  async detect() {
    throw todo('detect')
  },
  importRules() {
    return {
      gitignore: [
        '# Managed by Raditi: secrets, caches, backups and logs stay out of git',
        ...importExcludes,
      ],
      exclude: [...importExcludes],
    }
  },
  deployVars() {
    throw todo('deployVars')
  },
  backup() {
    throw todo('backup')
  },
  verify() {
    throw todo('verify')
  },
  mcpTools() {
    return mcpTools.map((tool) => ({ ...tool }))
  },
  agentGuide() {
    throw todo('agentGuide')
  },
  protectedPaths() {
    return [...protectedPaths]
  },
  snapshotExcludes() {
    return [...snapshotExcludes]
  },
  rootMarkers() {
    return [...rootMarkers]
  },
  async configSecrets(read) {
    const values = await phpConfigStrings(read, 'wp-config.php', secretDefine, defineEnd)
    return secretValues(values.filter((value) => value !== samplePhrase))
  },
}
