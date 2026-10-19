import type { SiteAdapter } from '@repo/domain'
import { notImplemented } from '@repo/domain'
import { phpConfigStrings, secretValues } from './php-config.ts'
import {
  archivesAndDumps,
  dataFiles,
  phpServerConfigFiles,
  phpServerConfigProtected,
  secretFiles,
  serverLogs,
} from './php-hosting.ts'

// 1С-Битрикс — stage 3 (spec §13). Site code lives in /local/; the core /bitrix/ and the
// media in /upload/ are never imported or touched. Pattern syntax as in wordpress.ts.

const anchored = (paths: readonly string[]) => paths.map((p) => `/${p}`)

const kernelAndMedia = ['bitrix/', 'upload/']

// `.htaccess`, `.user.ini` and `php.ini` at any depth: Apache and PHP read them in every folder.
const protectedPaths = [...kernelAndMedia, ...phpServerConfigProtected]

const buildOutput = ['node_modules/', '*.log']

const snapshotExcludes = [
  ...anchored([
    'bitrix/cache/',
    'bitrix/managed_cache/',
    'bitrix/stack_cache/',
    'bitrix/html_pages/',
    'bitrix/backup/',
    'upload/',
  ]),
  ...buildOutput,
  ...serverLogs,
  'vendor/',
  ...archivesAndDumps,
  ...secretFiles,
]

// Backups live in /bitrix/backup/, already excluded with the core; dumps and archives elsewhere
// are caught by pattern. gitleaks scans the imported tree as well (P11).
const importExcludes = [
  ...anchored([...kernelAndMedia, ...phpServerConfigFiles]),
  ...buildOutput,
  ...serverLogs,
  ...archivesAndDumps,
  ...dataFiles,
  ...secretFiles,
]

/**
 * The kernel folder: every installation has it in its root.
 * TODO(stage 3): too weak for the import, which does not enter a folder below the root that has
 * every marker — the `components` folder of a template and of /local/ holds a namespace folder
 * `bitrix` too. Before Bitrix becomes connectable the list needs an entry such a folder lacks.
 */
const rootMarkers = ['bitrix']

// The connection of the kernel is written twice: `$DBPassword = "…";` of dbconn.php and
// `'password' => '…'` of .settings.php, which keeps the passwords of its other services
// under the same key. Whitespace is all that may stand between the tokens, as in wordpress.ts.
const dbconnPassword = /\$DBPassword[ \t\r\n]*=[ \t\r\n]*/
const statementEnd = /[ \t\r\n]*;/
const settingsPassword = /(['"])password\1[ \t\r\n]*=>[ \t\r\n]*/
const elementEnd = /[ \t\r\n]*[,)\]]/

const todo = (method: string) => notImplemented(`BitrixAdapter.${method} (stage 3)`)

export const bitrixAdapter: SiteAdapter = {
  stack: 'bitrix',
  async detect() {
    throw todo('detect')
  },
  importRules() {
    return {
      gitignore: [
        '# Managed by Raditi: the core, media and caches stay out of git',
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
    return []
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
    // One after the other: the reader may have a single connection to the site.
    const dbconn = await phpConfigStrings(
      read,
      'bitrix/php_interface/dbconn.php',
      dbconnPassword,
      statementEnd,
    )
    const settings = await phpConfigStrings(
      read,
      'bitrix/.settings.php',
      settingsPassword,
      elementEnd,
    )
    return secretValues([...dbconn, ...settings])
  },
  // Previews and releases of Bitrix come with stage 3 (docs/plan/53-chat-preview-release.md).
  agentWorkingSet() {
    throw todo('agentWorkingSet')
  },
  mediaRules() {
    throw todo('mediaRules')
  },
  // Until stage 3 a database of Bitrix is not copied: its preview is `unavailable`.
  async databaseSettings() {
    return null
  },
  previewRecipe() {
    throw todo('previewRecipe')
  },
  databaseCopyPolicy() {
    throw todo('databaseCopyPolicy')
  },
  // Until stage 3 a release of Bitrix carries no database operation.
  dbOperationKinds() {
    return []
  },
  dbSettings() {
    return []
  },
  dbPlanGuide() {
    return ''
  },
  // No preview of Bitrix runs before stage 3: its browser opens nothing.
  browserRequestDenied() {
    return true
  },
}
