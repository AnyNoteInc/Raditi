import { wordpressPublicOriginals } from './wordpress-public-code.ts'
import type { SiteAdapter } from '@repo/domain'
import { notImplemented } from '@repo/domain'
import { phpConfigStrings, secretValues } from './php-config.ts'
import { wordpressBrowserRequestDenied } from './wordpress-browser.ts'
import {
  wordpressBrowserCheckpointOf,
  wordpressBrowserCommitAction,
  wordpressBrowserGuide,
  wordpressBrowserTaskPolicy,
  wordpressBrowserVerification,
} from './wordpress-browser-task.ts'
import { wordpressDatabaseCopyPolicy, wordpressDatabaseSettings } from './wordpress-db-copy.ts'
import {
  wordpressDbOperationKinds,
  wordpressDbPlanGuide,
  wordpressDbSettings,
} from './wordpress-db.ts'
import { wordpressPreviewRecipe } from './wordpress-preview.ts'
import { wordpressVerifyPlan } from './wordpress-verify.ts'
import {
  wordpressAgentWorkingSet,
  wordpressMediaRules,
  wordpressPlatformFiles,
} from './wordpress-working-set.ts'
import {
  archivesAndDumps,
  dataFiles,
  phpServerConfigFiles,
  phpServerConfigProtected,
  secretFiles,
  serverLogs,
} from './php-hosting.ts'

// Pattern syntax (the domain port leaves it open, so it is fixed here):
// - protectedPaths: path prefixes from the repository root, `*` within one segment,
//   a trailing `/` marks a directory, a leading `**/` — at any depth: the syntax of
//   forbiddenCiPaths (spec §10);
// - agentWorkingSet: the path patterns of @repo/domain (wordpress-working-set.ts);
// - importRules: .gitignore lines, usable as rsync and
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
  ...phpServerConfigProtected,
  // The platform's own files inside the site (plan 53, Р11): the agent never sees or changes them.
  ...wordpressPlatformFiles,
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

const todo = (method: string) => notImplemented(`WordPressAdapter.${method} (P10)`)

export const wordpressAdapter: SiteAdapter = {
  stack: 'wordpress',
  importRules() {
    return {
      gitignore: [
        '# Managed by Raditi: secrets, caches, backups and logs stay out of git',
        ...importExcludes,
      ],
      exclude: [...importExcludes],
    }
  },
  verify: wordpressVerifyPlan,
  agentGuide() {
    throw todo('agentGuide')
  },
  protectedPaths() {
    return [...protectedPaths]
  },
  rootMarkers() {
    return [...rootMarkers]
  },
  async configSecrets(read) {
    const values = await phpConfigStrings(read, 'wp-config.php', secretDefine, defineEnd)
    return secretValues(values.filter((value) => value !== samplePhrase))
  },
  publicOriginals: wordpressPublicOriginals,
  agentWorkingSet: wordpressAgentWorkingSet,
  mediaRules: wordpressMediaRules,
  databaseSettings: wordpressDatabaseSettings,
  previewRecipe: wordpressPreviewRecipe,
  databaseCopyPolicy: wordpressDatabaseCopyPolicy,
  dbOperationKinds: wordpressDbOperationKinds,
  dbSettings: wordpressDbSettings,
  dbPlanGuide: wordpressDbPlanGuide,
  browserRequestDenied: wordpressBrowserRequestDenied,
  browserTaskPolicy: wordpressBrowserTaskPolicy,
  browserCheckpointOf: wordpressBrowserCheckpointOf,
  browserCommitAction: wordpressBrowserCommitAction,
  browserVerification: wordpressBrowserVerification,
  browserGuide: wordpressBrowserGuide,
}
