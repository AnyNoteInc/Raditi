import type { SiteFacts } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { bitrixAdapter } from './bitrix.ts'

const site: SiteFacts = {
  stack: 'bitrix',
  url: 'https://shop.example.ru',
  docroot: '/home/bitrix/www',
  extras: {},
}

describe('bitrixAdapter', () => {
  it('protects the core and the media, leaving /local/ editable', () => {
    const protectedPaths = bitrixAdapter.protectedPaths(site)
    expect(protectedPaths).toEqual(expect.arrayContaining(['bitrix/', 'upload/']))
    expect(protectedPaths.some((p) => p.startsWith('local'))).toBe(false)
  })

  it('excludes caches and media from turn snapshots', () => {
    expect(bitrixAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([
        '/bitrix/cache/',
        '/bitrix/managed_cache/',
        '/upload/',
        'node_modules/',
      ]),
    )
  })

  it('never imports the core or the media', () => {
    const { gitignore, exclude } = bitrixAdapter.importRules(site)
    expect(exclude).toEqual(expect.arrayContaining(['/bitrix/', '/upload/']))
    expect(gitignore.slice(1)).toEqual(exclude)
  })

  it('never imports or snapshots DB dumps, archives or secrets, at any depth', () => {
    const patterns = ['*.sql', '*.sql.gz', '*.zip', '*.tar.gz', '*.tgz', '*.bak', '.env', '*.pem']
    expect(bitrixAdapter.importRules(site).exclude).toEqual(expect.arrayContaining(patterns))
    expect(bitrixAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([...patterns, '/bitrix/backup/']),
    )
  })

  it('has no MCP tools before stage 3', () => {
    expect(bitrixAdapter.mcpTools(site)).toEqual([])
  })

  it('leaves the server-dependent parts to stage 3', () => {
    for (const call of [
      () => bitrixAdapter.deployVars(site),
      () => bitrixAdapter.backup(site),
      () => bitrixAdapter.verify(site),
      () => bitrixAdapter.agentGuide(site),
    ]) {
      expect(call).toThrow('(stage 3)')
    }
  })
})
