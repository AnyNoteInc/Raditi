import type { SiteAdapter } from '@repo/domain'
import { notImplemented } from '@repo/domain'
import { noBrowserTasks } from './no-browser-tasks.ts'

// 1С-Битрикс (docs/plan/62-site-stacks.md, Т8, Т15, fact 14): the platform recognises a site of
// it and connects none. Both ways are closed, so every method of the files throws: nothing reaches
// it, and a stack that opens its files must answer them (the contract of a stack adapter). No code
// of its core is in the repository or read here.

/**
 * The folder of the core and the access file of the root, which every installation has. The
 * `components` folder of a template and of /local/ holds a namespace folder `bitrix` too, but not
 * `.access.php` (Т15).
 */
const rootMarkers = ['bitrix', '.access.php']

const closed = (method: string) => notImplemented(`BitrixAdapter.${method}`)

export const bitrixAdapter: SiteAdapter = {
  stack: 'bitrix',
  support: {
    files: 'off',
    browser: 'off',
    generations: [],
    refuseBelow: null,
    releaseNeedsChecks: true,
    unknownVersion: 'closed',
  },
  recognition: {
    publicPaths: [],
    // Read by the early refusal of step 1 (Э9.1): `/bitrix/` is seen on `GET /` without a path.
    fingerprint: (pages) =>
      pages.some((page) => page.html.includes('/bitrix/')) ? 'yes' : 'unknown',
    publicGeneration: () => null,
    needsOwnYes: false,
    rootHint: () => null,
    // Names without a dot: a hosting may hide a file with a dot even from `LIST -a`.
    coreFolder: ['modules', 'php_interface'],
  },
  // No step of the database and no summary panel: `terms: null` — the stack is not connected.
  connection: {
    databaseEngines: [],
    fullName: '1С-Битрикс',
    adminPathDefault: null,
    shops: [],
    alwaysShop: null,
    pricesGuarded: false,
    configFile: null,
    terms: null,
  },
  readVersion: null,
  readLayout: null,
  driftProbe: null,
  derivedCopyOf: null,
  stackGuide() {
    return ''
  },
  importRules() {
    throw closed('importRules')
  },
  verify() {
    throw closed('verify')
  },
  protectedPaths() {
    throw closed('protectedPaths')
  },
  rootMarkers() {
    return [...rootMarkers]
  },
  configSecrets() {
    return Promise.reject(closed('configSecrets'))
  },
  agentWorkingSet() {
    throw closed('agentWorkingSet')
  },
  mediaRules() {
    throw closed('mediaRules')
  },
  // A database of Bitrix is not copied: its preview is `unavailable`.
  async databaseSettings() {
    return null
  },
  previewRecipe() {
    throw closed('previewRecipe')
  },
  databaseCopyPolicy() {
    throw closed('databaseCopyPolicy')
  },
  // A release of Bitrix carries no database operation.
  dbOperationKinds() {
    return []
  },
  dbSettings() {
    return []
  },
  dbPlanGuide() {
    return ''
  },
  // No preview of Bitrix runs: its browser opens nothing.
  browserRequestDenied() {
    return true
  },
  ...noBrowserTasks('bitrix'),
}
