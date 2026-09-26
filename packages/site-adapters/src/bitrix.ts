import type { SiteAdapter } from '@repo/domain'
import { notImplemented } from '@repo/domain'
import { archivesAndDumps, phpServerConfigFiles, secretFiles } from './php-hosting.ts'

// 1С-Битрикс — stage 3 (spec §13). Site code lives in /local/; the core /bitrix/ and the
// media in /upload/ are never imported or touched. Pattern syntax as in wordpress.ts.

const anchored = (paths: readonly string[]) => paths.map((p) => `/${p}`)

const protectedPaths = ['bitrix/', 'upload/', ...phpServerConfigFiles]

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
  'vendor/',
  ...archivesAndDumps,
  ...secretFiles,
]

// Backups live in /bitrix/backup/, already excluded with the core; dumps and archives elsewhere
// are caught by pattern. gitleaks scans the imported tree as well (P11).
const importExcludes = [
  ...anchored(protectedPaths),
  ...buildOutput,
  ...archivesAndDumps,
  ...secretFiles,
]

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
}
