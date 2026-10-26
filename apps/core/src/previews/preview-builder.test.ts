import {
  DatabaseCopyError,
  DomainError,
  previewDatabaseSecretPath,
  SiteConnectionError,
  type PreviewFilesInput,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { MemoryVault } from '../testing/previews.ts'
import {
  DIFF_REBUILD_FILES,
  dumpStaging,
  previewDatabasePasswords,
  previewErrorCode,
  previewFailure,
  writePreviewTree,
} from './preview-builder.ts'

const repo = { provider: 'gitea' as const, owner: 'sites', name: 'site-1' }
const from = 'a'.repeat(40)
const to = 'b'.repeat(40)
const signal = new AbortController().signal
const recipe = { generatedFiles: [{ path: 'wp-config.php', content: '<?php' }] }

function fakes(
  changed: { written: string[]; deleted: string[] } | null,
  absent: string[] = [],
  refuseDifference = false,
) {
  const exports: Array<{ sha: string; paths?: readonly string[]; exclude?: readonly string[] }> = []
  const writes: Array<Omit<PreviewFilesInput, 'archive'> & { bytes: number }> = []
  const git = {
    readBranchHead: () => Promise.resolve(null),
    changedPaths: () => Promise.resolve(changed),
    missingPaths: ({ paths }: { paths: readonly string[] }) =>
      Promise.resolve(paths.filter((path) => absent.includes(path))),
    async exportTree<T>(
      input: { sha: string; paths?: readonly string[]; exclude?: readonly string[] },
      consume: (tree: {
        archive: AsyncIterable<Uint8Array>
        files: number
        bytes: number
      }) => Promise<T>,
    ) {
      exports.push(input)
      return consume({ archive: (async function* () {})(), files: 0, bytes: 0 })
    },
  }
  const runtime = {
    async writeFiles(_id: string, input: PreviewFilesInput) {
      const { archive, ...rest } = input
      let bytes = 0
      for await (const chunk of archive) bytes += chunk.byteLength
      writes.push({ ...rest, bytes })
      // The docroot refuses a difference that turns a folder into a file (files.mjs).
      if (refuseDifference && !input.replace)
        throw new DomainError('BAD_REQUEST', 'Preview files were refused: path_conflict', 400)
    },
  }
  return { git, runtime, exports, writes }
}

describe('the files of a rebuild', () => {
  it('writes the whole tree when what the docroot holds is unknown', async () => {
    const f = fakes({ written: [], deleted: [] })
    await writePreviewTree(f.runtime, f.git, {
      repo,
      previewId: 'p',
      from: null,
      synced: [],
      to,
      recipe,
      signal,
    })
    // The repository's own copy of a platform file never reaches the docroot.
    expect(f.exports).toEqual([{ repo, sha: to, exclude: ['wp-config.php'] }])
    expect(f.writes).toEqual([
      { deletes: [], replace: true, platform: recipe.generatedFiles, bytes: 0 },
    ])
  })

  it('exports nothing when the docroot already holds the commit', async () => {
    const f = fakes({ written: [], deleted: [] })
    await writePreviewTree(f.runtime, f.git, {
      repo,
      previewId: 'p',
      from: to,
      synced: [],
      to,
      recipe,
      signal,
    })
    expect(f.exports).toEqual([])
    // An empty archive (the end of a tar) and the platform's files over the tree.
    expect(f.writes).toEqual([
      { deletes: [], replace: false, platform: recipe.generatedFiles, bytes: 1024 },
    ])
    const deletesOnly = fakes({ written: ['wp-config.php'], deleted: ['gone.php'] })
    await writePreviewTree(deletesOnly.runtime, deletesOnly.git, {
      repo,
      previewId: 'p',
      from,
      synced: [],
      to,
      recipe,
      signal,
    })
    expect(deletesOnly.exports).toEqual([])
    expect(deletesOnly.writes[0]).toMatchObject({ deletes: ['gone.php'], replace: false })
  })

  it('writes the whole tree when the docroot refuses the difference', async () => {
    const f = fakes({ written: ['a.php/inner.php'], deleted: ['a.php'] }, [], true)
    await writePreviewTree(f.runtime, f.git, {
      repo,
      previewId: 'p',
      from,
      synced: [],
      to,
      recipe,
      signal,
    })
    expect(f.writes.map((write) => write.replace)).toEqual([false, true])
    expect(f.exports.at(-1)).toEqual({ repo, sha: to, exclude: ['wp-config.php'] })
  })

  it('writes the difference, and takes back what a sync of a turn wrote over it', async () => {
    const f = fakes({ written: ['a.php', 'wp-config.php'], deleted: ['gone.php'] }, [
      'new-by-agent.php',
    ])
    await writePreviewTree(f.runtime, f.git, {
      repo,
      previewId: 'p',
      from,
      synced: ['b.php', 'new-by-agent.php'],
      to,
      recipe,
      signal,
    })
    expect(f.exports).toEqual([{ repo, sha: to, paths: ['a.php', 'b.php'] }])
    expect(f.writes).toEqual([
      {
        deletes: ['gone.php', 'new-by-agent.php'],
        replace: false,
        platform: recipe.generatedFiles,
        bytes: 0,
      },
    ])
  })

  it('writes the whole tree when the difference is larger than a rebuild takes', async () => {
    const f = fakes(null)
    await writePreviewTree(f.runtime, f.git, {
      repo,
      previewId: 'p',
      from,
      synced: [],
      to,
      recipe,
      signal,
    })
    expect(f.writes[0]?.replace).toBe(true)
    const many = fakes({
      written: Array.from({ length: DIFF_REBUILD_FILES }, (_, i) => `f${i}`),
      deleted: [],
    })
    await writePreviewTree(many.runtime, many.git, {
      repo,
      previewId: 'p',
      from,
      synced: ['x'],
      to,
      recipe,
      signal,
    })
    expect(many.writes[0]?.replace).toBe(true)
  })
})

describe('the error code of a failed preview', () => {
  it('is a word of a fixed set', () => {
    expect(previewErrorCode(previewFailure('no_base'))).toBe('no_base')
    expect(previewErrorCode(new SiteConnectionError('auth_failed'))).toBe('database_auth_failed')
    expect(previewErrorCode(new DatabaseCopyError('too_large'))).toBe('copy_too_large')
    expect(previewErrorCode(new DomainError('PREVIEW_SEED_INVALID', 'x', 409))).toBe('seed_invalid')
    expect(
      previewErrorCode(
        new DomainError('PREVIEW_CONTENT_FAILED', 'x', 502, { code: 'plan_conflict' }),
      ),
    ).toBe('content_plan_conflict')
    expect(previewErrorCode(new Error('ENOENT /var/secret'))).toBe('build_failed')
    for (const code of ['no_base', 'database_auth_failed', 'copy_too_large', 'seed_invalid'])
      expect(code).toMatch(/^[a-z][a-z0-9_]{1,47}$/)
  })
})

describe('the passwords of a preview database (owner, 19.10.2026: in Vault)', () => {
  const previewId = '0196abcd-0000-7000-8000-00000000000a'
  const path = previewDatabaseSecretPath(previewId)

  it('makes them once and gives the same ones to every build after', async () => {
    const vault = new MemoryVault()
    const first = await previewDatabasePasswords({ secrets: vault }, previewId)
    expect(first.user).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(first.root).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(first.root).not.toBe(first.user)
    expect(vault.kv.get(path)).toEqual({ version: 1, data: { v: '1', ...first } })
    expect(await previewDatabasePasswords({ secrets: vault }, previewId)).toEqual(first)
    expect(vault.kv.get(path)?.version).toBe(1)
  })

  it('replaces a secret that does not parse, by its version', async () => {
    const vault = new MemoryVault()
    await vault.kvWrite(path, { v: '1', user: 'short' })
    const made = await previewDatabasePasswords({ secrets: vault }, previewId)
    expect(vault.kv.get(path)).toEqual({ version: 2, data: { v: '1', ...made } })
  })
})

describe('the temporary database of a site’s dump', () => {
  const access = {
    v: '1' as const,
    engine: 'mysql' as const,
    host: '127.0.0.1',
    port: '49153',
    tls: 'plain' as const,
    database: 'staging',
    username: 'loader',
    password: 'p'.repeat(32),
  }
  const previewId = '0199a3f2-0000-7000-8000-0000000000e1'
  const siteId = '0199a3f2-0000-7000-8000-0000000000e2'
  const image = 'mariadb@sha256:' + 'a'.repeat(64)

  function setup(dump: string | null, read: { ok: boolean; code?: string } = { ok: true }) {
    const calls: string[] = []
    const staging = {
      async load(input: { stagingId: string; image: string; dump: AsyncIterable<Uint8Array> }) {
        for await (const _ of input.dump) void _
        calls.push(`load:${input.stagingId}:${input.image}`)
        return { access }
      },
      async remove(stagingId: string) {
        calls.push(`remove:${stagingId}`)
      },
      list: async () => [] as Array<{ stagingId: string; createdAt: number }>,
    }
    const sources = {
      databaseAccess: async () => ({ ok: true as const, access: { ...access, host: 'db.site' } }),
      withRoot: async () => null,
      async withDump<T>(
        _site: string,
        path: string,
        _signal: AbortSignal,
        use: (dump: AsyncIterable<Uint8Array>) => Promise<T>,
      ) {
        calls.push(`read:${path}`)
        if (!read.ok) return { ok: false as const, code: read.code as 'dump_not_found' }
        return { ok: true as const, value: await use((async function* () {})()) }
      },
    }
    const deps = { staging, sources, config: { images: { db: image } } } as never
    const facts = { preview: { id: previewId }, site: { id: siteId }, databaseDump: dump } as never
    return { calls, staging: dumpStaging(deps, facts, signal) }
  }

  it('loads the named dump once, gives its access to the copy and removes it after', async () => {
    const { calls, staging } = setup('backup.sql')
    expect(staging.fromDump).toBe(true)
    await expect(staging.access()).resolves.toEqual(access)
    await expect(staging.access()).resolves.toEqual(access)
    await staging.release()
    await staging.release()
    expect(calls).toEqual(['read:backup.sql', `load:${previewId}:${image}`, `remove:${previewId}`])
  })

  it('takes the live database of a site without a dump and removes nothing', async () => {
    const { calls, staging } = setup(null)
    await expect(staging.access()).resolves.toMatchObject({ host: 'db.site' })
    await staging.release()
    expect(calls).toEqual([])
  })

  it('fails the build with the reason the dump could not be read', async () => {
    const { staging } = setup('backup.sql', { ok: false, code: 'dump_not_found' })
    await expect(staging.access()).rejects.toMatchObject({
      code: 'PREVIEW_BUILD_FAILED',
      details: { code: 'dump_not_found' },
    })
    expect(previewErrorCode(await staging.access().catch((error: unknown) => error))).toBe(
      'dump_not_found',
    )
  })
})
