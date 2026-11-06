import type { PrismaClient } from '@repo/db'
import {
  siteFileBlobKey,
  siteFileText,
  siteFilesLimits,
  siteFilesTreeKey,
  type ObjectStorage,
  type RepoRef,
  type SiteFileContent,
  type SiteFilesBlobJob,
  type SiteFilesTree,
  type SiteFilesTreeJob,
} from '@repo/domain'

import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'

/** What the files of a project read of git: the mirror of the site, never a working copy. */
export type SiteFilesGit = Pick<GitWorkspaceService, 'listFiles' | 'readFile'>

export interface SiteFilesDependencies {
  db: Pick<PrismaClient, 'gitRepository'>
  /** null while git is not configured: nothing is read, web keeps waiting and says so. */
  git: SiteFilesGit | null
  storage: Pick<ObjectStorage, 'exists' | 'put'>
}

/**
 * The files of a project for its section «Терминал» (owner's request of 06.11.2026): the list of
 * the files of a commit of the site and the content of one of them, read from the mirror and put
 * into the bucket of artifacts, where web reads them (it has no credential of git, CLAUDE.md rule
 * 2). Both objects are immutable — a commit names its files, an id its bytes —, so a job that finds
 * its object does nothing, and one put twice writes the same bytes.
 */
export class SiteFiles {
  constructor(private readonly deps: SiteFilesDependencies) {}

  async tree(job: SiteFilesTreeJob): Promise<void> {
    const key = siteFilesTreeKey(job.siteId, job.sha)
    const repo = await this.#repo(job.siteId)
    if (!repo || !this.deps.git || (await this.deps.storage.exists('artifacts', key))) return
    const listed = await this.deps.git.listFiles({
      repo,
      sha: job.sha,
      limit: siteFilesLimits.entries,
    })
    const tree: SiteFilesTree = { v: 1, sha: job.sha, ...listed }
    const body = Buffer.from(JSON.stringify(tree))
    await this.deps.storage.put('artifacts', key, body, {
      contentType: 'application/json',
      sizeBytes: body.byteLength,
    })
  }

  async blob(job: SiteFilesBlobJob): Promise<void> {
    const repo = await this.#repo(job.siteId)
    if (!repo || !this.deps.git) return
    const file = await this.deps.git.readFile({
      repo,
      sha: job.sha,
      path: job.path,
      maxBytes: siteFilesLimits.viewBytes,
    })
    if (!file) return
    const key = siteFileBlobKey(job.siteId, file.oid)
    if (await this.deps.storage.exists('artifacts', key)) return
    const text = file.bytes === null ? null : siteFileText(file.bytes)
    const content: SiteFileContent =
      file.bytes === null
        ? { v: 1, state: 'too_large' }
        : text === null
          ? { v: 1, state: 'binary' }
          : { v: 1, state: 'text', text }
    const body = Buffer.from(JSON.stringify(content))
    await this.deps.storage.put('artifacts', key, body, {
      contentType: 'application/json',
      sizeBytes: body.byteLength,
    })
  }

  /** The repository of the site, the first it was given, as the dialogs read it. */
  async #repo(siteId: string): Promise<RepoRef | null> {
    const repository = await this.deps.db.gitRepository.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true },
    })
    return repository
      ? { provider: repository.provider, owner: repository.owner, name: repository.name }
      : null
  }
}
