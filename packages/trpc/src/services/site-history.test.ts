import type { PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { backupFileName, readSiteBackupDownload } from './site-history.ts'

const userId = '0199a3f2-0000-7000-8000-0000000000aa'
const siteId = '0199a3f2-0000-7000-8000-00000000000a'
const key = `sites/${siteId}/initial/${'a'.repeat(40)}.tar.gz`

function setup(site: unknown) {
  const db = { site: { findFirst: vi.fn().mockResolvedValue(site) } }
  const body = (async function* () {
    yield new Uint8Array([1, 2, 3])
  })()
  const storage = { get: vi.fn().mockResolvedValue(body) }
  return { db: db as unknown as PrismaClient, findFirst: db.site.findFirst, storage, body }
}

describe('backupFileName', () => {
  it('spells a Cyrillic name in Latin letters and keeps the version', () => {
    expect(backupFileName('УКК ЖКХ', 'v0.0.0')).toBe('ukk-zhkkh-v0.0.0.tar.gz')
    expect(backupFileName('Кофейня «Крошка»', 'v1.2.0')).toBe('kofeynya-kroshka-v1.2.0.tar.gz')
    expect(backupFileName('«»', 'v0.0.0')).toBe('site-v0.0.0.tar.gz')
  })
})

describe('readSiteBackupDownload', () => {
  it('streams the copy of the import of a site the user may open', async () => {
    const { db, findFirst, storage, body } = setup({
      name: 'УКК ЖКХ',
      initialVersion: { tag: 'v0.0.0', backupObjectKey: key, backupBytes: 3n },
    })
    expect(
      await readSiteBackupDownload(db, storage, { userId, siteId, backupId: 'initial' }),
    ).toEqual({
      body,
      bytes: 3,
      fileName: 'ukk-zhkkh-v0.0.0.tar.gz',
    })
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: siteId, deletedAt: null, workspace: { members: { some: { userId } } } },
    })
    expect(storage.get).toHaveBeenCalledWith('backups', key)
  })

  it('answers null for another site, a copy not made yet, a missing object and a release', async () => {
    expect(
      await readSiteBackupDownload(setup(null).db, setup(null).storage, {
        userId,
        siteId,
        backupId: 'initial',
      }),
    ).toBeNull()
    const pending = setup({
      name: 'Сайт',
      initialVersion: { tag: 'v0.0.0', backupObjectKey: null, backupBytes: null },
    })
    expect(
      await readSiteBackupDownload(pending.db, pending.storage, {
        userId,
        siteId,
        backupId: 'initial',
      }),
    ).toBeNull()
    expect(pending.storage.get).not.toHaveBeenCalled()
    const gone = setup({
      name: 'Сайт',
      initialVersion: { tag: 'v0.0.0', backupObjectKey: key, backupBytes: 3n },
    })
    gone.storage.get.mockResolvedValue(null)
    expect(
      await readSiteBackupDownload(gone.db, gone.storage, { userId, siteId, backupId: 'initial' }),
    ).toBeNull()
    const release = setup(null)
    expect(
      await readSiteBackupDownload(release.db, release.storage, {
        userId,
        siteId,
        backupId: '0199a3f2-0000-7000-8000-0000000000b1',
      }),
    ).toBeNull()
    expect(release.findFirst).not.toHaveBeenCalled()
  })
})
