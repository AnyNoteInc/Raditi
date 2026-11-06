import { siteFileBlobKey, siteFilesTreeKey } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { SiteFiles, type SiteFilesGit } from './site-files.ts'

// The files of a project for its section «Терминал» (06.11.2026): what core puts into the bucket
// of artifacts for web, from the mirror of the site.

const SITE = '0199a3f2-0000-8000-8000-0000000000a1'
const SHA = 'a'.repeat(40)
const OID = 'b'.repeat(40)
const repo = { provider: 'gitea' as const, owner: 'sites', name: `site-${SITE}` }

function setup(options: { repository?: boolean; stored?: string[] } = {}) {
  const objects = new Map<string, string>((options.stored ?? []).map((key) => [key, '{}']))
  const storage = {
    exists: vi.fn(async (_bucket: string, key: string) => objects.has(key)),
    put: vi.fn(async (_bucket: string, key: string, body: Uint8Array) => {
      objects.set(key, Buffer.from(body).toString('utf8'))
    }),
  }
  const git = {
    listFiles: vi.fn(async () => ({
      files: [{ path: 'index.php', size: 12, oid: OID }],
      truncated: false,
    })),
    readFile: vi.fn<SiteFilesGit['readFile']>(async () => ({
      oid: OID,
      size: 12,
      bytes: Buffer.from('<?php echo 1;'),
    })),
  }
  const db = {
    gitRepository: {
      findFirst: vi.fn(async () => (options.repository === false ? null : repo)),
    },
  }
  const files = new SiteFiles({ db: db as never, git, storage })
  return { files, git, storage, objects }
}

describe('SiteFiles', () => {
  it('puts the list of the files of a commit, once', async () => {
    const { files, git, objects } = setup()
    await files.tree({ siteId: SITE, sha: SHA })
    expect(git.listFiles).toHaveBeenCalledWith({ repo, sha: SHA, limit: 50_000 })
    expect(JSON.parse(objects.get(siteFilesTreeKey(SITE, SHA))!)).toEqual({
      v: 1,
      sha: SHA,
      files: [{ path: 'index.php', size: 12, oid: OID }],
      truncated: false,
    })
    await files.tree({ siteId: SITE, sha: SHA })
    expect(git.listFiles).toHaveBeenCalledTimes(1)
  })

  it('puts a file as text, as binary or as too large, under the id of its bytes', async () => {
    const { files, git, objects } = setup()
    const job = { siteId: SITE, sha: SHA, path: 'index.php' }
    await files.blob(job)
    expect(JSON.parse(objects.get(siteFileBlobKey(SITE, OID))!)).toEqual({
      v: 1,
      state: 'text',
      text: '<?php echo 1;',
    })
    objects.clear()
    git.readFile.mockResolvedValueOnce({ oid: OID, size: 4, bytes: Buffer.from([0x89, 0, 1, 2]) })
    await files.blob(job)
    expect(JSON.parse(objects.get(siteFileBlobKey(SITE, OID))!)).toEqual({ v: 1, state: 'binary' })
    objects.clear()
    git.readFile.mockResolvedValueOnce({ oid: OID, size: 9_000_000, bytes: null })
    await files.blob(job)
    expect(JSON.parse(objects.get(siteFileBlobKey(SITE, OID))!)).toEqual({
      v: 1,
      state: 'too_large',
    })
  })

  it('reads nothing of a site without a repository, nor a file the commit lacks', async () => {
    const without = setup({ repository: false })
    await without.files.tree({ siteId: SITE, sha: SHA })
    expect(without.git.listFiles).not.toHaveBeenCalled()
    const lacking = setup()
    lacking.git.readFile.mockResolvedValueOnce(null)
    await lacking.files.blob({ siteId: SITE, sha: SHA, path: 'gone.php' })
    expect(lacking.storage.put).not.toHaveBeenCalled()
  })

  it('reads nothing while git is not configured', async () => {
    const { storage } = setup()
    const files = new SiteFiles({
      db: { gitRepository: { findFirst: async () => repo } } as never,
      git: null,
      storage,
    })
    await files.tree({ siteId: SITE, sha: SHA })
    expect(storage.put).not.toHaveBeenCalled()
  })
})
