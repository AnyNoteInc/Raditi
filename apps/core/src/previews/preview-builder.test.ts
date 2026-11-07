import {
  DatabaseCopyError,
  DB_CREATED_ID_BASE,
  DomainError,
  emptySiteStackFacts,
  previewDatabaseSecretPath,
  SiteConnectionError,
  type PreviewFilesInput,
  type SiteAdapter,
  type SiteContentGateway,
  type SiteDbCapabilities,
  type SiteStackFacts,
} from '@repo/domain'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { extract } from 'tar-stream'
import { wordpressAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import { TAR_END, tarFileHeader, tarPadding } from '../git-workspace/tree-tar.ts'
import { MemoryVault, memorySiteTree } from '../testing/previews.ts'
import {
  dbCapabilitiesOf,
  DIFF_REBUILD_FILES,
  dumpStaging,
  previewDatabasePasswords,
  previewErrorCode,
  previewDbRuntime,
  previewFailure,
  previewSiteFacts,
  PreviewUnavailable,
  readSiteRoot,
  settleStackFacts,
  unaskedProduction,
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

/** The entries of an archive in their order, as the docroot's writer reads them. */
async function entriesOf(archive: AsyncIterable<Uint8Array>) {
  const found: Array<{ name: string; type: string }> = []
  const parser = extract()
  parser.on('entry', (header, stream, next) => {
    found.push({ name: header.name, type: header.type ?? 'file' })
    stream.on('end', () => next())
    stream.resume()
  })
  const chunks: Buffer[] = []
  for await (const chunk of archive) chunks.push(Buffer.from(chunk))
  await pipeline(Readable.from([Buffer.concat(chunks)]), parser)
  return found
}

describe('the folders PHP owns (Т21)', () => {
  const folders = { ...recipe, writableFolders: ['system/storage/logs'] }
  /** A git whose export holds one file, and a runtime that keeps what each write got. */
  function recording(changed: { written: string[]; deleted: string[] } | null) {
    const f = fakes(changed)
    const archives: Array<{ replace: boolean; entries: Array<{ name: string; type: string }> }> = []
    const content = Buffer.from('<?php echo 1;')
    const git = {
      ...f.git,
      async exportTree<T>(
        _input: unknown,
        consume: (tree: {
          archive: AsyncIterable<Uint8Array>
          files: number
          bytes: number
        }) => Promise<T>,
      ) {
        const archive = (async function* () {
          yield tarFileHeader('index.php', content.byteLength, false)
          yield content
          yield tarPadding(content.byteLength)
          yield TAR_END
        })()
        return consume({ archive, files: 1, bytes: content.byteLength })
      },
    }
    const runtime = {
      async writeFiles(_id: string, input: PreviewFilesInput) {
        archives.push({ replace: input.replace, entries: await entriesOf(input.archive) })
      },
    }
    return { git, runtime, archives }
  }
  const folder = { name: 'system/storage/logs/', type: 'directory' }

  it('go first in the archive of the whole tree, of a difference and of an empty one', async () => {
    const whole = recording({ written: [], deleted: [] })
    await writePreviewTree(whole.runtime, whole.git, {
      repo,
      previewId: 'p',
      from: null,
      synced: [],
      to,
      recipe: folders,
      signal,
    })
    const empty = recording({ written: [], deleted: [] })
    await writePreviewTree(empty.runtime, empty.git, {
      repo,
      previewId: 'p',
      from: to,
      synced: [],
      to,
      recipe: folders,
      signal,
    })
    const difference = recording({ written: ['index.php'], deleted: [] })
    await writePreviewTree(difference.runtime, difference.git, {
      repo,
      previewId: 'p',
      from,
      synced: [],
      to,
      recipe: folders,
      signal,
    })
    expect(whole.archives).toEqual([
      { replace: true, entries: [folder, { name: 'index.php', type: 'file' }] },
    ])
    expect(empty.archives).toEqual([{ replace: false, entries: [folder] }])
    expect(difference.archives).toEqual([
      { replace: false, entries: [folder, { name: 'index.php', type: 'file' }] },
    ])
  })

  it('leave the bytes of the archive as they were when the recipe names none', async () => {
    const f = recording(null)
    await writePreviewTree(f.runtime, f.git, {
      repo,
      previewId: 'p',
      from: null,
      synced: [],
      to,
      recipe,
      signal,
    })
    expect(f.archives).toEqual([{ replace: true, entries: [{ name: 'index.php', type: 'file' }] }])
    const empty = fakes({ written: [], deleted: [] })
    await writePreviewTree(empty.runtime, empty.git, {
      repo,
      previewId: 'p',
      from: to,
      synced: [],
      to,
      recipe: { ...recipe, writableFolders: [] },
      signal,
    })
    expect(empty.writes[0]?.bytes).toBe(TAR_END.byteLength)
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

describe('what production’s plugin can write of a plan (Т37)', () => {
  const everything: SiteDbCapabilities = {
    version: 1,
    kind: 'capabilities',
    plugin: 2,
    operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
    settings: ['blogname'],
    maxRecordId: 812,
  }
  const site = {
    stack: 'wordpress' as const,
    url: 'https://site.example.test/',
    docroot: '/',
    extras: {},
  }
  /** A gateway whose plugin fails the first `failures` questions of what it can write. */
  const gateway = (failures: number) => {
    let asked = 0
    return {
      db: {
        capabilities: () => {
          asked += 1
          return asked <= failures
            ? Promise.reject(new Error('timed out'))
            : Promise.resolve(everything)
        },
      },
    } as unknown as SiteContentGateway
  }
  const preview = { ...everything, nextCreatedId: DB_CREATED_ID_BASE }

  it('asks once more after a failure, and the answer gives every kind', async () => {
    expect(
      previewDbRuntime(wordpressAdapter, site, await dbCapabilitiesOf(gateway(1)), preview).kinds,
    ).toEqual(['content_update', 'option_update', 'post_create', 'schema_migration'])
  })

  it('leaves the text of records alone after two failures', async () => {
    expect(await dbCapabilitiesOf(gateway(2))).toBe('no_answer')
    expect(
      previewDbRuntime(wordpressAdapter, site, await dbCapabilitiesOf(gateway(2)), preview).kinds,
    ).toEqual(['content_update'])
  })

  it('tells a gateway without a plan apart from one that does not answer', async () => {
    expect(await dbCapabilitiesOf(null)).toBeNull()
    expect(await dbCapabilitiesOf({} as SiteContentGateway)).toBeNull()
  })

  describe('a production whose gateway could not be had', () => {
    type Deps = Parameters<typeof unaskedProduction>[0]
    const deps = (count: () => Promise<number>, adapters: Deps['contentAdapters']) =>
      ({ db: { credentialRef: { count } }, contentAdapters: adapters }) as unknown as Deps
    const wp = (() => ({ accessKind: 'wp' })) as unknown as Deps['contentAdapters']

    it('has no gateway without an access row of its content adapter', async () => {
      expect(
        await unaskedProduction(
          deps(() => Promise.resolve(0), wp),
          'site',
          'wordpress',
        ),
      ).toBe(null)
    })

    it('did not answer where the row is there', async () => {
      expect(
        await unaskedProduction(
          deps(() => Promise.resolve(1), wp),
          'site',
          'wordpress',
        ),
      ).toBe('no_answer')
    })

    it('has no gateway where two rows of the kind stand, as the resolver and a release read them', async () => {
      expect(
        await unaskedProduction(
          deps(() => Promise.resolve(2), wp),
          'site',
          'wordpress',
        ),
      ).toBe(null)
    })

    it('keeps the text of records where the count itself failed', async () => {
      const failed = deps(() => Promise.reject(new Error('connection reset')), wp)
      expect(await unaskedProduction(failed, 'site', 'wordpress')).toBe('no_answer')
    })

    it('has no gateway where the stack has no content adapter', async () => {
      const none = (() => {
        throw new Error('no content adapter')
      }) as unknown as Deps['contentAdapters']
      expect(
        await unaskedProduction(
          deps(() => Promise.resolve(1), none),
          'site',
          'bitrix',
        ),
      ).toBe(null)
    })
  })
})

describe('the record of the site a fresh copy goes on with (Т13, Т16)', () => {
  const siteId = '0199a3f2-0000-7000-8000-0000000000f1'
  /** A stack with a layout to read, its versions judged from 3.0 on. */
  const layoutStack: Pick<SiteAdapter, 'support' | 'readLayout'> = {
    support: {
      ...wordpressAdapter.support,
      refuseBelow: '3.0',
    },
    readLayout: async () => ({
      kind: 'read',
      extras: { admin: 'manager' },
      adminPath: '/manager/',
    }),
  }
  /** A database that keeps the parts of the record it is asked to write. */
  function recording() {
    const writes: string[] = []
    const db = {
      $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        writes.push(String(values[0]))
        return 1
      },
    }
    return { writes, deps: { db, appEnv: 'test' as const } as never }
  }
  const site = (stackFacts: Partial<SiteStackFacts> = {}) => ({
    id: siteId,
    stackFacts: { ...emptySiteStackFacts, ...stackFacts },
  })
  const unavailable = (reason: string) =>
    expect.objectContaining({ name: 'PreviewUnavailable', reason }) as unknown

  it('writes what the look read, and the recipe gets its layout and generation', async () => {
    const { writes, deps } = recording()
    const facts = await settleStackFacts(deps, layoutStack, site(), {
      patch: {
        cmsVersion: '3.0.4',
        generation: 'r3',
        extras: { admin: 'manager' },
        adminPath: '/manager/',
        limit: null,
      },
      refused: false,
      layoutRead: true,
    })
    expect(writes.map((json) => JSON.parse(json) as unknown)).toEqual([
      {
        v: 1,
        cmsVersion: '3.0.4',
        generation: 'r3',
        extras: { admin: 'manager' },
        adminPath: '/manager/',
        limit: null,
      },
    ])
    expect(facts).toMatchObject({ cmsVersion: '3.0.4', extras: { admin: 'manager' } })
    expect(
      previewSiteFacts({ stack: 'modx', url: 'https://a.example', stackFacts: facts }, null),
    ).toEqual({
      stack: 'modx',
      url: 'https://a.example',
      docroot: '/',
      extras: { admin: 'manager' },
      version: '3.0.4',
      generation: 'r3',
    })
  })

  it('goes on with the recorded layout when the hosting could not be read now', async () => {
    const { writes, deps } = recording()
    const recorded = site({ cmsVersion: '3.0.4', extras: { admin: 'manager' } })
    await expect(settleStackFacts(deps, layoutStack, recorded, null)).resolves.toEqual(
      recorded.stackFacts,
    )
    // A layout that did not pass now keeps the recorded one too.
    await expect(
      settleStackFacts(deps, layoutStack, recorded, {
        patch: { cmsVersion: '3.0.5', generation: null },
        refused: false,
        layoutRead: false,
      }),
    ).resolves.toMatchObject({ cmsVersion: '3.0.5', extras: { admin: 'manager' } })
    expect(writes).toHaveLength(1)
  })

  it('builds no copy of a layout neither read now nor recorded: none is guessed', async () => {
    const { writes, deps } = recording()
    await expect(settleStackFacts(deps, layoutStack, site(), null)).rejects.toEqual(
      unavailable('no_layout'),
    )
    await expect(
      settleStackFacts(deps, layoutStack, site(), {
        patch: { cmsVersion: '3.0.4', generation: null },
        refused: false,
        layoutRead: false,
      }),
    ).rejects.toBeInstanceOf(PreviewUnavailable)
    // The version it did read is written all the same.
    expect(writes.map((json) => JSON.parse(json) as unknown)).toEqual([
      { v: 1, cmsVersion: '3.0.4', generation: null },
    ])
  })

  it('writes the limit of a refused layout and builds nothing, a recorded layout or not', async () => {
    const { writes, deps } = recording()
    await expect(
      settleStackFacts(deps, layoutStack, site({ extras: { admin: 'manager' } }), {
        patch: { limit: 'renamed_folder' },
        refused: true,
        layoutRead: false,
      }),
    ).rejects.toEqual(unavailable('no_layout'))
    expect(writes.map((json) => JSON.parse(json) as unknown)).toEqual([
      { v: 1, limit: 'renamed_folder' },
    ])
  })

  it('builds no copy of a version the platform does not support', async () => {
    const { writes, deps } = recording()
    await expect(
      settleStackFacts(deps, layoutStack, site({ cmsVersion: '2.8.1', extras: { a: 'b' } }), null),
    ).rejects.toEqual(unavailable('version_unsupported'))
    // The version read now is judged, not the record: an empty one, and a supported one.
    const read = {
      patch: { cmsVersion: '2.8.1', generation: null, extras: { a: 'b' } },
      refused: false,
      layoutRead: true,
    }
    await expect(settleStackFacts(deps, layoutStack, site(), read)).rejects.toEqual(
      unavailable('version_unsupported'),
    )
    await expect(
      settleStackFacts(deps, layoutStack, site({ cmsVersion: '3.0.4', extras: { a: 'b' } }), read),
    ).rejects.toEqual(unavailable('version_unsupported'))
    expect(writes).toHaveLength(2)
  })

  it('leaves WordPress as it was: no layout to read, an unread hosting stops nothing', async () => {
    const { writes, deps } = recording()
    await expect(settleStackFacts(deps, wordpressAdapter, site(), null)).resolves.toEqual(
      emptySiteStackFacts,
    )
    await expect(
      settleStackFacts(deps, wordpressAdapter, site({ cmsVersion: '6.8.1' }), {
        patch: { cmsVersion: '6.8.3', generation: null, limit: null },
        refused: false,
        layoutRead: false,
      }),
    ).resolves.toMatchObject({ cmsVersion: '6.8.3', extras: {} })
    expect(writes).toHaveLength(1)
  })
})

describe('one look at the site root for a build (Т13, Т16)', () => {
  const root = memorySiteTree({
    'wp-config.php': "<?php\ndefine( 'DB_CHARSET', 'utf8mb4' );\n$table_prefix = 'shop_';\n",
    'wp-includes/version.php': "<?php\n$wp_version = '6.8.3';\n",
  })
  /** A source whose session hands `use` the root and lets its failure through. */
  const sources = {
    sources: {
      withRoot: <T>(
        _siteId: string,
        _signal: AbortSignal,
        use: (tree: typeof root) => Promise<T>,
      ) => use(root),
    },
  } as never
  const failing = (onRead: () => void) => ({
    ...wordpressAdapter,
    readLayout: async () => {
      onRead()
      throw new Error('the hosting dropped the session')
    },
  })

  it('keeps the settings it read when the stack cannot be read', async () => {
    const reading = await readSiteRoot(
      sources,
      failing(() => {}),
      { id: 'site' },
      signal,
    )
    expect(reading?.settings).toMatchObject({ tablePrefix: 'shop_' })
    expect(reading?.stack).toBeNull()
  })

  it('stops a cancelled build instead of going on without the stack', async () => {
    const cancel = new AbortController()
    await expect(
      readSiteRoot(
        sources,
        failing(() => cancel.abort()),
        { id: 'site' },
        cancel.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
