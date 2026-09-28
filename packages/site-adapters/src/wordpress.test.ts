import type { SiteFacts } from '@repo/domain'
import { isForbiddenPath } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { wordpressAdapter } from './wordpress.ts'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/shop',
  extras: {},
}

describe('wordpressAdapter', () => {
  it('protects the paths from spec §10, §13 and the media library', () => {
    expect(wordpressAdapter.protectedPaths(site)).toEqual(
      expect.arrayContaining([
        'wp-config.php',
        'wp-admin/',
        'wp-includes/',
        'wp-content/uploads/',
        '.htaccess',
      ]),
    )
  })

  it('keeps the themes and plugins editable', () => {
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    expect(protectedPaths.some((p) => p.startsWith('wp-content/themes'))).toBe(false)
    expect(protectedPaths.some((p) => p.startsWith('wp-content/plugins'))).toBe(false)
  })

  it('writes patterns without traversal or leading ./', () => {
    const all = [
      ...wordpressAdapter.protectedPaths(site),
      ...wordpressAdapter.snapshotExcludes(site),
      ...wordpressAdapter.importRules(site).exclude,
    ]
    for (const pattern of all) {
      expect(pattern).not.toMatch(/(^|\/)\.\.(\/|$)|^\.\/|^$/)
    }
  })

  it('excludes media, caches and dependencies from turn snapshots', () => {
    expect(wordpressAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([
        'node_modules/',
        'vendor/',
        '/wp-content/cache/',
        '/wp-content/uploads/',
      ]),
    )
  })

  it('never imports secrets, core, media or caches, anchoring root files', () => {
    const { gitignore, exclude } = wordpressAdapter.importRules(site)
    expect(exclude).toEqual(
      expect.arrayContaining([
        '/wp-config.php',
        '/wp-admin/',
        '/wp-includes/',
        '/wp-content/uploads/',
        '/wp-content/cache/',
        '/index.php',
      ]),
    )
    // An unanchored index.php would hide every theme template from git.
    expect(exclude).not.toContain('index.php')
    expect(gitignore[0]).toMatch(/^# /)
    expect(gitignore.slice(1)).toEqual(exclude)
  })

  it('never imports or snapshots DB dumps, archives, backups or secrets, at any depth', () => {
    const patterns = [
      '*.sql',
      '*.sql.gz',
      '*.zip',
      '*.tar',
      '*.tar.gz',
      '*.tgz',
      '*.7z',
      '*.rar',
      '*.bak',
      '*.wpress',
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa*',
      '*.p12',
    ]
    const backups = ['/wp-content/backup*/', '/wp-content/ai1wm-backups/', '/wp-content/updraft/']
    expect(wordpressAdapter.importRules(site).exclude).toEqual(
      expect.arrayContaining([...patterns, ...backups]),
    )
    expect(wordpressAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([...patterns, ...backups]),
    )
    // Unanchored, so they match in every directory.
    for (const pattern of patterns) expect(pattern.startsWith('/')).toBe(false)
  })

  it('keeps an agent diff out of backup directories, in the DiffPolicy syntax', () => {
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    expect(protectedPaths).toEqual(
      expect.arrayContaining(['wp-content/backup*/', 'wp-content/ai1wm-backups/']),
    )
    expect(isForbiddenPath('wp-content/backups/site.sql.gz', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/backup-db/x.sql', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-config.php', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/themes/shop/style.css', protectedPaths)).toBe(false)
  })

  it('describes the MCP tools of spec §8 with unique names', () => {
    const tools = wordpressAdapter.mcpTools(site)
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        'site_info',
        'wp_cli',
        'wp_rest',
        'snapshot',
        'restore',
        'media_upload',
        'browser_open',
        'browser_click',
        'browser_fill',
        'browser_screenshot',
        'request_approval',
      ]),
    )
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(10)
  })

  it('flags exactly the CLAUDE.md rule 4 operations as dangerous', () => {
    const dangerous = wordpressAdapter
      .mcpTools(site)
      .filter((t) => t.dangerous)
      .map((t) => t.name)
    expect(dangerous.sort()).toEqual(['wp_bulk_edit', 'wp_delete', 'wp_plugin', 'wp_theme'])
    const approval = wordpressAdapter.mcpTools(site).find((t) => t.name === 'request_approval')
    expect(approval?.dangerous).toBe(false)
  })

  it('returns copies, so callers cannot change the shared lists', () => {
    wordpressAdapter.protectedPaths(site).length = 0
    wordpressAdapter.mcpTools(site)[0]!.dangerous = true
    expect(wordpressAdapter.protectedPaths(site)).toContain('wp-config.php')
    expect(wordpressAdapter.mcpTools(site)[0]!.dangerous).toBe(false)
  })

  it('leaves the server-dependent parts to P10', async () => {
    const probe = {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      readFile: async () => null,
      httpGet: async () => ({ status: 200, body: '' }),
    }
    await expect(wordpressAdapter.detect(probe)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('WordPressAdapter.detect (P10)'),
    })
    for (const call of [
      () => wordpressAdapter.deployVars(site),
      () => wordpressAdapter.backup(site),
      () => wordpressAdapter.verify(site),
      () => wordpressAdapter.agentGuide(site),
    ]) {
      expect(call).toThrow('(P10)')
    }
  })
})
