import type { ImportRules } from '@repo/domain'
import {
  archivesAndDumps,
  dataFiles,
  phpServerConfigFiles,
  secretFiles,
  serverLogs,
} from '../php-hosting.ts'

// What the import of a site of Joomla leaves out (docs/plan/62-site-stacks.md, Т57;
// docs/plan/62-slices/e3.md, Э3.3; docs/research/2026-11-site-stacks/joomla.md, §3.2–§3.4). The
// lines are those of `importRules` of WordPress: `.gitignore` syntax, a leading `/` anchors to the
// root, a line without a slash matches at any depth. The policy matches without regard to letter
// case, so no mask here may catch a class of the core in another case.

const anchored = (paths: readonly string[]) => paths.map((path) => `/${path}`)

const importExcludes = [
  ...anchored([
    // Only the root: `configuration*` at any depth without regard to case would cut
    // libraries/vendor/joomla/application/src/ConfigurationAwareApplicationInterface.php.
    // Copies deeper down are `configCopies` below: an exact name, not a mask.
    'configuration*',
    'defines.php',
    'installation/',
    'cache/',
    'administrator/cache/',
    'tmp/',
    'logs/',
    'administrator/logs/',
    'kickstart.php',
    'administrator/components/com_akeeba/backup/',
    'administrator/components/com_akeebabackup/backup/',
    'components/com_jshopping/files/pdf_orders/',
    'components/com_jshopping/files/importexport/',
    ...phpServerConfigFiles,
  ]),
  // Copies of the configuration at any depth: no class of the core has such a name.
  'configuration.php.*',
  'configuration.bak',
  'configuration_old.php',
  // `old/configuration.php` holds the password of before, and configSecrets knows only the current
  // one: see configCopies. Akeeba: the encrypted archive and the parts `.j01`…`.j99`; the policy
  // refuses `[` and `?`, so one line per first digit.
  '*.jps',
  ...'0123456789'.split('').map((digit) => `*.j${digit}*`),
  'node_modules/',
  '*.log',
  ...serverLogs,
  ...archivesAndDumps,
  ...dataFiles,
  ...secretFiles,
]

/** `importRules` of the adapter: the same answer whatever the site (Т13). */
export function joomlaImportRules(): ImportRules {
  return {
    gitignore: [
      '# Managed by Raditi: secrets, caches, backups and logs stay out of git',
      ...importExcludes,
    ],
    exclude: [...importExcludes],
    // The core has no folder of visitors' uploads: both folders are the client's media library
    // (joomla.md, §3.2, §3.4; question В2). An extension keeps its visitors' files in its own
    // `components/`, where a document stays out.
    documentFolders: ['images/', 'files/'],
    // A file of that name below the core or an extension is a class, not a copy of the
    // configuration: `Configuration.php` of PSR-4 (`Aws\Retry\Configuration`, league/config, a
    // component's service) and the models `configuration.php` of 3.x. The names match in any letter
    // case, so the folders of extensions are left out whole; a copy lies in a folder of its own.
    configCopies: {
      names: ['configuration.php'],
      except: [
        'libraries/',
        'administrator/',
        'api/',
        'components/',
        'modules/',
        'plugins/',
        'templates/',
      ],
      maxDepth: null,
    },
    coreFiles: [...joomlaCoreFiles],
  }
}

/**
 * The names of the SQL of the schema updates of the core: `<version>-<yyyy>-<mm>-<dd>[-<n>].sql`
 * since 3.2.2, plain `<version>.sql` of 2.5.5–3.2.1 before (the names of 3.10.12, 4.4.14, 5.4.10 and
 * 6.2.0). A pattern holds only `*`, so a dated name is three dots and three dashes before `.sql`; any
 * other SQL beside them — a dump the owner left there — stays out by `archivesAndDumps`.
 */
const joomlaUpdateNames = [
  '*.*.*-*-*-*.sql',
  ...['2.5.5', '2.5.6', '2.5.7', '3.0.0', '3.0.1', '3.0.2', '3.0.3']
    .concat(['3.1.0', '3.1.1', '3.1.2', '3.1.3', '3.1.4', '3.1.5', '3.2.0', '3.2.1'])
    .map((version) => `${version}.sql`),
] as const

/**
 * Files of the release of Joomla the lines above would cut (`*.sql` of `archivesAndDumps`, `*.pem`
 * of `secretFiles`; docs/plan/62-slices/e3.md, Э3.11, discrepancy 24): the SQL of the schema
 * updates the panel checks the database by, and the bundles of CA the HTTP transports of the core
 * load with no other way — without them the copy has no outgoing HTTPS. Paths of 3.10.12, 4.4.14,
 * 5.4.10 and 6.2.0 (sqlazure only on 3.x); a path a branch lacks matches nothing. The SQL of the
 * installer and of extensions stays out.
 */
const joomlaCoreFiles = [
  ...['mysql', 'postgresql', 'sqlazure'].flatMap((driver) =>
    [...joomlaUpdateNames].map(
      (name) => `/administrator/components/com_admin/sql/updates/${driver}/${name}`,
    ),
  ),
  '/libraries/vendor/composer/ca-bundle/res/cacert.pem',
  '/libraries/src/Http/Transport/cacert.pem',
  '/libraries/fof/download/adapter/cacert.pem',
] as const
