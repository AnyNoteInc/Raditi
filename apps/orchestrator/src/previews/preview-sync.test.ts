import {
  DomainError,
  siteWorkspaceRules,
  type PublicationSource,
  type SiteFacts,
} from '@repo/domain'
import { wordpressAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import {
  checkSyncChange,
  previewSyncErrorCode,
  PreviewSyncRefused,
  syncHasCredential,
} from './preview-sync.ts'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/',
  extras: {},
}
const source: PublicationSource = {
  repo: { provider: 'gitea', owner: 'sites', name: 'site-1' },
  branch: 'agent/task1',
  expectedBaseSha: 'a'.repeat(40),
  ...siteWorkspaceRules(wordpressAdapter, site),
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
])
const file = (path: string, bytes: Uint8Array = Buffer.from('<?php echo 1;')) => ({
  path,
  mode: '100644',
  bytes,
})
const platform = new Set(['wp-config.php', 'wp-content/mu-plugins/raditi-preview.php'])
const check = (input: Partial<Parameters<typeof checkSyncChange>[0]>) =>
  checkSyncChange({ files: [], deletes: [], source, platform, synced: new Set(), ...input })

describe('a sync of the agent working tree checked as a candidate', () => {
  it('takes changes of the working set and new media', () => {
    expect(() =>
      check({
        files: [
          file('wp-content/themes/shop/functions.php'),
          file('wp-content/uploads/raditi/banner.png', png),
        ],
        deletes: ['wp-content/themes/shop/old.php'],
      }),
    ).not.toThrow()
  })

  it('refuses the platform, protected and CI paths, paths outside the set and odd spellings', () => {
    for (const path of [
      'wp-config.php',
      'wp-content/mu-plugins/raditi-preview.php',
      '.gitea/workflows/x.yml',
      'wp-content/themes/shop/.htaccess',
      'wp-admin/index.php',
      'wp-content/themes//shop/a.php',
    ])
      expect(() => check({ files: [file(path)] }), path).toThrow()
    expect(() => check({ deletes: ['wp-includes/version.php'] })).toThrow()
  })

  it('keeps media add-only: no deletion but of what the turn added, no script as an image', () => {
    expect(() => check({ deletes: ['wp-content/uploads/raditi/old.png'] })).toThrow(
      PreviewSyncRefused,
    )
    expect(() =>
      check({
        deletes: ['wp-content/uploads/raditi/new.png'],
        synced: new Set(['wp-content/uploads/raditi/new.png']),
      }),
    ).not.toThrow()
    expect(() =>
      check({ files: [file('wp-content/uploads/raditi/a.png', Buffer.from('<?php'))] }),
    ).toThrow()
    expect(() => check({ files: [file('wp-content/uploads/raditi/a.php.png', png)] })).toThrow()
    // Publication takes media with mode 100644 only: an executable image is not shown either.
    expect(() =>
      check({ files: [{ ...file('wp-content/uploads/raditi/b.png', png), mode: '100755' }] }),
    ).toThrow(PreviewSyncRefused)
  })

  it("finds the turn's own key or token in a file or a name", () => {
    const key = 'raditi-turn-key-0123456789abcdef'
    const token = 'mcp-token-fedcba9876543210'
    const theme = 'wp-content/themes/shop/functions.php'
    expect(syncHasCredential([file(theme)], [], [key, token])).toBe(false)
    expect(
      syncHasCredential([file(theme, Buffer.from(`<?php $k = '${key}';`))], [], [key, token]),
    ).toBe(true)
    expect(syncHasCredential([file(`wp-content/themes/${token}.php`)], [], [key, token])).toBe(true)
    expect(syncHasCredential([], [`wp-content/themes/${key}.php`], [key, token])).toBe(true)
    expect(syncHasCredential([file(theme)], [], ['', ''])).toBe(false)
  })

  it('answers a refusal with a code, never a message', () => {
    expect(previewSyncErrorCode(new PreviewSyncRefused('not_ready'))).toBe('not_ready')
    expect(previewSyncErrorCode(new DomainError('PUBLICATION_FORBIDDEN', 'x', 502))).toBe(
      'files_refused',
    )
    expect(previewSyncErrorCode(new DomainError('SNAPSHOT_TOO_LARGE', 'x', 413))).toBe('too_large')
    expect(previewSyncErrorCode(new DomainError('NOT_SUPPORTED', 'x', 501))).toBe('not_supported')
    expect(previewSyncErrorCode(new Error('boom /secret/path'))).toBe('failed')
  })
})
