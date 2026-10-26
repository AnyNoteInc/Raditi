import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import {
  InitialBackupWorker,
  initialBackupKey,
  type InitialBackupRecord,
  type InitialBackupStore,
  type PendingInitialBackup,
} from './initial-backup.ts'

const siteId = '0199a3f2-0000-7000-8000-00000000000a'
const sha = 'a'.repeat(40)
const version: PendingInitialBackup = {
  siteId,
  commitSha: sha,
  repository: {
    ref: { provider: 'gitea', owner: 'sites', name: `site-${siteId}` },
    url: `https://git.example/sites/site-${siteId}`,
  },
}
const archive = Buffer.from('tar.gz bytes of the first version')

function setup(options: { pending?: PendingInitialBackup[]; stored?: number | null } = {}) {
  const recorded: { siteId: string; commitSha: string; backup: InitialBackupRecord }[] = []
  let pending = options.pending ?? [version]
  const store: InitialBackupStore = {
    pending: vi.fn(async () => pending),
    record: vi.fn(async (site, commit, backup) => {
      recorded.push({ siteId: site, commitSha: commit, backup })
      pending = []
      return true
    }),
  }
  const objects = new Map<string, Buffer>()
  const storage = {
    put: vi.fn(
      async (
        _bucket: string,
        key: string,
        body: AsyncIterable<Uint8Array> | Uint8Array,
        _options?: { contentType?: string; sizeBytes?: number },
      ) => {
        const chunks: Buffer[] = []
        if (body instanceof Uint8Array) chunks.push(Buffer.from(body))
        else for await (const chunk of body) chunks.push(Buffer.from(chunk))
        objects.set(key, Buffer.concat(chunks))
      },
    ),
    stat: vi.fn(async (_bucket: string, key: string) => {
      if (options.stored === null) return null
      const object = objects.get(key)
      return object ? { sizeBytes: options.stored ?? object.byteLength } : null
    }),
  }
  const git = {
    remoteUrl: vi.fn(async (url: string) => url),
    archiveCommit: vi.fn(
      async (_root: string, _url: string, _ref: unknown, _sha: string, file: string) => {
        await writeFile(file, archive)
      },
    ),
  }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const worker = new InitialBackupWorker({
    store,
    storage,
    git,
    background: false,
    logger,
    now: () => new Date('2026-10-26T10:00:00Z'),
  })
  return { worker, store, storage, git, objects, recorded, logger }
}

describe('InitialBackupWorker', () => {
  it('archives the commit from the repository, uploads it to backups and records it', async () => {
    const { worker, storage, git, objects, recorded, logger } = setup()
    await worker.kick()
    expect(git.remoteUrl).toHaveBeenCalledWith(`${version.repository.url}.git`)
    expect(git.archiveCommit.mock.calls[0]?.slice(1, 4)).toEqual([
      `${version.repository.url}.git`,
      version.repository.ref,
      sha,
    ])
    const key = initialBackupKey(siteId, sha)
    expect(key).toBe(`sites/${siteId}/initial/${sha}.tar.gz`)
    expect(storage.put.mock.calls[0]?.[0]).toBe('backups')
    expect(storage.put.mock.calls[0]?.[3]).toEqual({
      contentType: 'application/gzip',
      sizeBytes: archive.byteLength,
    })
    expect(objects.get(key)?.equals(archive)).toBe(true)
    expect(recorded).toEqual([
      {
        siteId,
        commitSha: sha,
        backup: {
          key,
          bytes: archive.byteLength,
          sha256: createHash('sha256').update(archive).digest('hex'),
          at: new Date('2026-10-26T10:00:00Z'),
        },
      },
    ])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('records nothing when the stored object is not the archive it uploaded, and tells the log', async () => {
    const { worker, recorded, logger } = setup({ stored: 1 })
    await worker.kick()
    expect(recorded).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(`site_initial_backup_failed site=${siteId}`)
  })

  it('leaves a failed copy for the next pass and goes on with the others', async () => {
    const other = { ...version, siteId: '0199a3f2-0000-7000-8000-00000000000b' }
    const { worker, git, recorded, logger } = setup({ pending: [version, other] })
    git.archiveCommit.mockRejectedValueOnce(new Error('Gitea away'))
    await worker.kick()
    expect(logger.warn).toHaveBeenCalledWith(`site_initial_backup_failed site=${siteId}`)
    expect(recorded.map((item) => item.siteId)).toEqual([other.siteId])
  })

  it('makes no copy without the git of the import', async () => {
    const { store } = setup()
    const worker = new InitialBackupWorker({
      store,
      storage: { put: vi.fn(), stat: vi.fn() },
      git: null,
      background: false,
      logger: { log: vi.fn(), warn: vi.fn() },
    })
    await worker.kick()
    expect(store.pending).not.toHaveBeenCalled()
  })

  it('runs one pass at a time and one more after a kick that came during it', async () => {
    const { worker, store } = setup({ pending: [] })
    const first = worker.kick()
    const second = worker.kick()
    expect(second).toBe(first)
    await first
    await vi.waitFor(() => expect(store.pending).toHaveBeenCalledTimes(2))
    await worker.onModuleDestroy()
  })
})
