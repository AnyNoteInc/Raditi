import { describe, expect, it, vi } from 'vitest'

import { getSiteBackup, type SiteBackupDependencies } from './site-backup'

// «Скачать» of the copy of the import's files (owner's request of 26.10.2026): signed in, with
// the current documents accepted, and only what the reader of @repo/trpc found.

const params = { projectId: '0199A3F2-0000-7000-8000-00000000000A', backupId: 'initial' }
const userId = '0199a3f2-0000-7000-8000-0000000000a1'

function deps(patch: Partial<SiteBackupDependencies> = {}) {
  return {
    getSession: vi.fn(async () => ({ user: { id: userId } })),
    hasRequiredConsents: vi.fn(async () => true),
    read: vi.fn(async () => ({
      body: (async function* () {
        yield new Uint8Array([0x1f, 0x8b, 1])
        yield new Uint8Array([2, 3])
      })(),
      bytes: 5,
      fileName: 'ukk-zhkkh-v0.0.0.tar.gz',
    })),
    onFailure: vi.fn(),
    ...patch,
  } satisfies SiteBackupDependencies
}

const request = () => new Request('http://localhost/api/projects/x/backups/initial')

describe('the download of a copy', () => {
  it('streams the archive to a member of the site as an attachment, never cached or sniffed', async () => {
    const d = deps()
    const response = await getSiteBackup(request(), params, d)
    expect(response.status).toBe(200)
    expect(d.read).toHaveBeenCalledWith({
      userId,
      siteId: params.projectId.toLowerCase(),
      backupId: 'initial',
    })
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/gzip',
      'content-length': '5',
      'content-disposition': 'attachment; filename="ukk-zhkkh-v0.0.0.tar.gz"',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    })
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x1f, 0x8b, 1, 2, 3])
  })

  it('asks to sign in, to accept the documents, and answers not found the same for all else', async () => {
    expect(
      (await getSiteBackup(request(), params, deps({ getSession: vi.fn(async () => null) })))
        .status,
    ).toBe(401)
    expect(
      (
        await getSiteBackup(
          request(),
          params,
          deps({ hasRequiredConsents: vi.fn(async () => false) }),
        )
      ).status,
    ).toBe(428)
    expect(
      (await getSiteBackup(request(), params, deps({ read: vi.fn(async () => null) }))).status,
    ).toBe(404)
    const d = deps()
    for (const bad of [
      { projectId: 'not-a-site', backupId: 'initial' },
      { projectId: params.projectId, backupId: '../etc' },
    ]) {
      expect((await getSiteBackup(request(), bad, d)).status).toBe(404)
    }
    expect(d.read).not.toHaveBeenCalled()
  })

  it('tells the log, not the client, why a read failed', async () => {
    const d = deps({
      read: vi.fn(async () => Promise.reject(new Error('S3 away: bucket raditi-backups'))),
    })
    const response = await getSiteBackup(request(), params, d)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('raditi-backups')
    expect(d.onFailure).toHaveBeenCalled()
  })
})
