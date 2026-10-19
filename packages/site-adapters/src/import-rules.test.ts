import type { SiteAdapter, SiteFacts } from '@repo/domain'
import { createImportPathPolicy, siteStacks } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import {
  dataFiles,
  phpServerConfigFiles,
  phpServerConfigProtected,
  secretFiles,
  serverLogs,
} from './php-hosting.ts'
import { connectableStacks, getSiteAdapter } from './registry.ts'

// The import of a connected site builds its path policy from the exclude lines of the adapter
// (docs/plan/39-site-connection-wizard.md). The policy refuses a line outside the syntax it
// supports, so a line added to an adapter is proven here, not by the first import.

/** Every stack that has an adapter; the others are planned and throw. */
const adapters = siteStacks.flatMap((stack): SiteAdapter[] => {
  try {
    return [getSiteAdapter(stack)]
  } catch {
    return []
  }
})

/** The facts the import knows before anything was detected on the server. */
const factsOf = (adapter: SiteAdapter): SiteFacts => ({
  stack: adapter.stack,
  url: 'https://shop.example.ru',
  docroot: '/',
  extras: {},
})
const importPolicy = (adapter: SiteAdapter) =>
  createImportPathPolicy(adapter.importRules(factsOf(adapter)).exclude)

const clientToolFiles = [
  '.my.cnf',
  '.pgpass',
  '.netrc',
  'sftp-config.json',
  '.ftpconfig',
  '.vscode/',
  '.idea/',
]

describe('exclude lines of the adapters', () => {
  it('covers every adapter of the registry, the connectable stacks among them', () => {
    const stacks = adapters.map((adapter) => adapter.stack)
    expect(stacks).toEqual(['wordpress', 'bitrix'])
    expect(stacks).toEqual(expect.arrayContaining([...connectableStacks]))
  })

  it('shares the lists of data files, server logs and client tool files', () => {
    expect(dataFiles).toEqual([
      '*.csv',
      '*.xls',
      '*.xlsx',
      '*.sqlite',
      '*.sqlite3',
      '*.db',
      '*.mdb',
    ])
    expect(serverLogs).toEqual(['error_log', 'access_log'])
    expect(secretFiles).toEqual(expect.arrayContaining(clientToolFiles))
  })

  describe.each(adapters.map((adapter) => [adapter.stack, adapter] as const))(
    '%s',
    (_, adapter) => {
      const facts = factsOf(adapter)

      it('writes import lines the path policy accepts', () => {
        const { exclude } = adapter.importRules(facts)
        expect(exclude.length).toBeGreaterThan(0)
        expect(() => createImportPathPolicy(exclude)).not.toThrow()
        // One line at a time, so a refused one is named by the failure.
        for (const line of exclude) expect(() => createImportPathPolicy([line]), line).not.toThrow()
      })

      it('writes snapshot lines of the same syntax', () => {
        const lines = adapter.snapshotExcludes(facts)
        expect(lines.length).toBeGreaterThan(0)
        for (const line of lines) expect(() => createImportPathPolicy([line]), line).not.toThrow()
      })

      it('never imports data files, server logs or the files of client tools', () => {
        expect(adapter.importRules(facts).exclude).toEqual(
          expect.arrayContaining([...dataFiles, ...serverLogs, ...clientToolFiles]),
        )
      })

      it('protects the server configuration at any depth, and imports it below the root', () => {
        // Two syntaxes, two lists: `**/` belongs to protectedPaths (plan 53, Р12), which the
        // import policy refuses; the import leaves out the root's copy only.
        expect(adapter.protectedPaths(facts)).toEqual(
          expect.arrayContaining(phpServerConfigProtected),
        )
        for (const line of adapter.importRules(facts).exclude) expect(line).not.toContain('**')
        for (const name of phpServerConfigFiles) {
          expect(importPolicy(adapter).decide(name, 'file')).toBe('excluded')
          expect(importPolicy(adapter).decide(`some/folder/below/${name}`, 'file')).toBe('take')
        }
      })

      it('keeps server logs and the files of client tools out of turn snapshots', () => {
        expect(adapter.snapshotExcludes(facts)).toEqual(
          expect.arrayContaining([...serverLogs, ...clientToolFiles]),
        )
      })

      it.each([
        ['export.csv', 'file'],
        ['local/reports/Orders.XLSX', 'file'],
        ['prices.xls', 'file'],
        ['data/shop.sqlite', 'file'],
        ['data/shop.sqlite3', 'file'],
        ['images/Thumbs.db', 'file'],
        ['old/clients.mdb', 'file'],
        ['backup.sql', 'file'],
        ['error_log', 'file'],
        ['some/folder/below/error_log', 'file'],
        ['access_log', 'file'],
        ['.my.cnf', 'file'],
        ['.pgpass', 'file'],
        ['.netrc', 'file'],
        ['sftp-config.json', 'file'],
        ['some/folder/below/sftp-config.json', 'file'],
        ['.ftpconfig', 'file'],
        ['.vscode', 'directory'],
        ['.vscode/sftp.json', 'file'],
        ['some/folder/below/.idea', 'directory'],
        ['some/folder/below/.idea/webServers.xml', 'file'],
        ['.env', 'file'],
      ] as const)('leaves %s out of the import', (path, type) => {
        expect(importPolicy(adapter).decide(path, type)).toBe('excluded')
      })

      it.each([
        // Names that only look like an excluded one.
        ['some/folder/error_log.php', 'file'],
        ['some/folder/access_log_report.php', 'file'],
        ['some/folder/csv', 'directory'],
        ['some/folder/csv/reader.php', 'file'],
        ['some/folder/export-csv.php', 'file'],
        ['some/folder/db.php', 'file'],
        ['some/folder/sftp-config.json.php', 'file'],
        // A file may carry the name of an editor folder.
        ['some/folder/.idea', 'file'],
      ] as const)('takes %s', (path, type) => {
        expect(importPolicy(adapter).decide(path, type)).toBe('take')
      })
    },
  )
})

describe('import of a WordPress site', () => {
  const adapter = getSiteAdapter('wordpress')
  const facts = factsOf(adapter)
  const policy = importPolicy(adapter)

  it('excludes copies of the configuration at any depth and the two data folders', () => {
    expect(adapter.importRules(facts).exclude).toEqual(
      expect.arrayContaining(['wp-config*', '/wp-content/blogs.dir/', '/wp-content/wflogs/']),
    )
    expect(adapter.snapshotExcludes(facts)).toEqual(
      expect.arrayContaining(['/wp-content/blogs.dir/', '/wp-content/wflogs/']),
    )
  })

  it.each([
    ['wp-config.php', 'file'],
    ['wp-config.php.save', 'file'],
    ['wp-config-old.php', 'file'],
    ['wp-config.txt', 'file'],
    ['WP-CONFIG.PHP.BAK', 'file'],
    ['wp-config-sample.php', 'file'],
    ['old/wp-config.php', 'file'],
    ['wp-content/themes/shop/backup/wp-config.php.save', 'file'],
    // The price of a line without a slash: a file of a theme named like the configuration.
    ['wp-content/themes/shop/wp-config-helper.php', 'file'],
    ['wp-config-backups', 'directory'],
    ['wp-config-backups/2025.php', 'file'],
    // And a whole plugin or theme whose folder is named so, with every file below it.
    ['wp-content/plugins/wp-config-file-editor', 'directory'],
    ['wp-content/plugins/wp-config-file-editor/includes/editor.php', 'file'],
    ['wp-content/themes/wp-configurator/style.css', 'file'],
    ['wp-content/blogs.dir', 'directory'],
    ['wp-content/blogs.dir/1/files/a.jpg', 'file'],
    ['wp-content/wflogs', 'directory'],
    ['wp-content/wflogs/config.php', 'file'],
    ['wp-content/uploads', 'directory'],
    ['wp-content/uploads/2026/a.jpg', 'file'],
    ['wp-includes', 'directory'],
    ['wp-includes/version.php', 'file'],
    ['wp-admin/index.php', 'file'],
    ['wp-login.php', 'file'],
    ['index.php', 'file'],
    ['wp-content/debug.log', 'file'],
    ['wp-content/plugins/shop/error_log', 'file'],
    ['wp-content/themes/shop/export.csv', 'file'],
    ['wp-content/db.php', 'file'],
    ['.htaccess', 'file'],
  ] as const)('leaves %s out', (path, type) => {
    expect(policy.decide(path, type)).toBe('excluded')
  })

  it.each([
    ['wp-content', 'directory'],
    ['wp-content/themes', 'directory'],
    ['wp-content/themes/shop/style.css', 'file'],
    ['wp-content/themes/shop/index.php', 'file'],
    ['wp-content/themes/shop/functions.php', 'file'],
    ['wp-content/themes/shop/inc/db.php', 'file'],
    ['wp-content/themes/shop/test.php', 'file'],
    ['wp-content/plugins/shop/shop.php', 'file'],
    ['wp-content/plugins/shop/includes/class-config.php', 'file'],
    ['wp-content/mu-plugins/loader.php', 'file'],
    // Anchored lines hold at the root only.
    ['wp-content/themes/shop/blogs.dir/a.php', 'file'],
    ['wp-content/themes/shop/wflogs/a.php', 'file'],
    ['old/wp-content/themes/shop/style.css', 'file'],
    ['my-wp-config.php', 'file'],
  ] as const)('takes %s', (path, type) => {
    expect(policy.decide(path, type)).toBe('take')
  })

  it('leaves version control and pipeline paths to the rules that stand before the lines', () => {
    expect(policy.decide('.svn/pristine/ab/abc.svn-base', 'file')).toBe('vcs')
    expect(policy.decide('.git/config', 'file')).toBe('vcs')
    expect(policy.decide('.github/workflows/deploy.yml', 'file')).toBe('ci')
    expect(policy.decide('.gitmodules', 'file')).toBe('ci')
  })
})

describe('import of a Bitrix site', () => {
  const policy = importPolicy(getSiteAdapter('bitrix'))

  it.each([
    ['bitrix', 'directory'],
    ['bitrix/php_interface/dbconn.php', 'file'],
    ['bitrix/.settings.php', 'file'],
    ['upload/iblock/a.jpg', 'file'],
    ['local/export.csv', 'file'],
    ['local/php_interface/error_log', 'file'],
    ['.htaccess', 'file'],
  ] as const)('leaves %s out', (path, type) => {
    expect(policy.decide(path, type)).toBe('excluded')
  })

  it.each([
    ['local', 'directory'],
    ['local/php_interface/init.php', 'file'],
    ['local/templates/main/header.php', 'file'],
    ['local/components/shop/catalog/class.php', 'file'],
    // The configuration of another platform is no rule of this one.
    ['local/wp-config.php', 'file'],
  ] as const)('takes %s', (path, type) => {
    expect(policy.decide(path, type)).toBe('take')
  })
})
