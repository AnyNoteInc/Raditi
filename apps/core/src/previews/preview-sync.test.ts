import {
  BROWSER_ONLY,
  DomainError,
  siteWorkspaceRules,
  toTurnPlan,
  type PublicationSource,
  type SiteFacts,
} from '@repo/domain'
import { wordpressAdapter } from '@repo/site-adapters'
import { describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import type { PreviewFacts } from './preview-facts.ts'
import type { PreviewHold } from './preview-lease.ts'
import {
  checkSyncChange,
  previewSyncErrorCode,
  PreviewSyncRefused,
  syncHasCredential,
  syncWorkingTree,
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

describe('a sync of a turn without a repository (docs/plan/57-browser-tasks.md, Б4)', () => {
  it('is refused before anything reads a working tree: there is none', async () => {
    const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
    const labels = {
      workspaceId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62',
      siteId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61',
      taskId: TASK,
      sessionId: TASK,
      turn: 1,
    }
    const plan = toTurnPlan(
      {
        sandbox: {
          image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
          labels,
          runtime: 'runc',
          resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
          user: { uid: 10001, gid: 10001 },
          env: {},
          secrets: [],
          network: { mode: 'gateway', routes: ['llm', 'mcp'] },
          hardTimeoutMs: 1_200_000,
        },
        context: {
          taskId: TASK,
          sessionId: TASK,
          turn: 1,
          llm: { baseUrl: 'http://sandbox-gw:8080/llm', model: 'm' },
          mcp: { url: 'http://sandbox-gw:8080/mcp' },
          instructions: 'rules',
        },
        input: { prompt: 'words', attachments: [] },
        driverVersion: '1.0.0',
        requirements: BROWSER_ONLY,
        committedAt: '2026-10-23T10:00:00.000Z',
      },
      sampleDriverId,
    )
    const db = {
      turnAssignment: {
        findUnique: vi.fn(async () => ({
          id: 'assignment-1',
          taskId: TASK,
          sessionId: TASK,
          turnNo: 1,
          firstEpoch: 1,
          finishedAt: null,
          containerId: 'container1',
          plan,
        })),
      },
    }
    const exportWorkingTree = vi.fn()
    const facts = {
      preview: { status: 'ready', upstream: { host: '127.0.0.1', port: 8080 }, taskId: TASK },
      task: { status: 'running' },
      repo: { provider: 'gitea', owner: 'sites', name: 'site-1', defaultBranch: 'main' },
    } as unknown as PreviewFacts
    const refusal = await syncWorkingTree(
      {
        db: db as never,
        runtime: {} as never,
        git: {} as never,
        executor: { exportWorkingTree },
        credentials: { recover: vi.fn() },
      },
      {} as PreviewHold,
      facts,
      { requestId: 'request-1', assignmentId: 'assignment-1', recipe: {} as never },
    ).catch((error: unknown) => error)
    expect(previewSyncErrorCode(refusal)).toBe('not_supported')
    expect(exportWorkingTree).not.toHaveBeenCalled()
  })
})
