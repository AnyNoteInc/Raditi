import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { provisioningLimits, type ObjectStorage, type RepoRef } from '@repo/domain'

import type { InitialVersionGit } from './initial-version.ts'

// The copy of the files of the first import in raditi-backups (owner's request of 26.10.2026):
// a tar.gz of the commit `v0.0.0`, made by core once the import published it and kept beside the
// release backups. The owner downloads it from «База и бэкап». The import never waits for it and
// never fails on it: a copy that could not be made is made again by the next pass.

/** sites/<siteId>/initial/<commitSha>.tar.gz: one object per first version, never replaced. */
export const initialBackupKey = (siteId: string, commitSha: string): string =>
  `sites/${siteId}/initial/${commitSha}.tar.gz`

/** A first version whose copy is not in the bucket yet, with the repository that holds it. */
export interface PendingInitialBackup {
  siteId: string
  commitSha: string
  repository: { ref: RepoRef; url: string }
}

export interface InitialBackupRecord {
  key: string
  bytes: number
  sha256: string
  at: Date
}

export interface InitialBackupStore {
  /** Imported first versions without a copy, of sites that are not deleted; oldest first. */
  pending(limit: number): Promise<PendingInitialBackup[]>
  /** false — the copy of this commit was recorded meanwhile, or the version is another one. */
  record(siteId: string, commitSha: string, backup: InitialBackupRecord): Promise<boolean>
}

/** Copies of this many first versions per pass: each is the whole site. */
const PASS_LIMIT = 3

export class PostgresInitialBackupStore implements InitialBackupStore {
  readonly #db: PrismaClient

  constructor(db: PrismaClient) {
    this.#db = db
  }

  async pending(limit: number): Promise<PendingInitialBackup[]> {
    const rows = await this.#db.siteInitialVersion.findMany({
      where: { importedAt: { not: null }, backupObjectKey: null, site: { deletedAt: null } },
      orderBy: { importedAt: 'asc' },
      take: limit,
      select: {
        siteId: true,
        commitSha: true,
        gitRepository: { select: { provider: true, owner: true, name: true, url: true } },
      },
    })
    return rows.map(({ siteId, commitSha, gitRepository }) => ({
      siteId,
      commitSha,
      repository: {
        ref: {
          provider: gitRepository.provider,
          owner: gitRepository.owner,
          name: gitRepository.name,
        },
        url: gitRepository.url,
      },
    }))
  }

  async record(siteId: string, commitSha: string, backup: InitialBackupRecord): Promise<boolean> {
    const { count } = await this.#db.siteInitialVersion.updateMany({
      where: { siteId, commitSha, importedAt: { not: null }, backupObjectKey: null },
      data: {
        backupObjectKey: backup.key,
        backupBytes: BigInt(backup.bytes),
        backupSha256: backup.sha256,
        backupSavedAt: backup.at,
      },
    })
    return count === 1
  }
}

export interface InitialBackupOptions {
  store: InitialBackupStore
  storage: Pick<ObjectStorage, 'put' | 'stat'>
  /** The git of the import: fetches the commit from our Gitea and writes its tar.gz. */
  git: Pick<InitialVersionGit, 'archiveCommit' | 'remoteUrl'> | null
  /** false in tests and tools: no timer. */
  background: boolean
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
  intervalMs?: number
}

/**
 * Makes the copies of imported first versions: one pass at start, one per sweep interval and one
 * as soon as an import succeeds (`kick`). Passes never overlap; the running one is awaited when
 * the module stops. A copy is written to a private temporary directory, hashed, uploaded and only
 * then recorded — a row names an object that is there.
 */
export class InitialBackupWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #options: InitialBackupOptions
  readonly #logger: { log(message: string): void; warn(message: string): void }
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<void> | undefined
  #again = false
  #closing = false

  constructor(options: InitialBackupOptions) {
    this.#options = options
    this.#logger = options.logger ?? new Logger('SiteImport')
  }

  onApplicationBootstrap(): void {
    if (!this.#options.background || this.#timer || this.#closing) return
    this.#timer = setInterval(
      () => void this.kick(),
      this.#options.intervalMs ?? provisioningLimits.sweepMs,
    )
    this.#timer.unref()
    void this.kick()
  }

  /** One pass; a kick while one runs makes one more after it. Never rejects. */
  kick(): Promise<void> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) {
      this.#again = true
      return this.#pending
    }
    const pending = this.#pass()
      .catch(() => {
        if (!this.#closing) this.#logger.warn('site_initial_backup_pass_failed')
      })
      .finally(() => {
        if (this.#pending !== pending) return
        this.#pending = undefined
        if (this.#again && !this.#closing) {
          this.#again = false
          void this.kick()
        }
      })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pending
  }

  async #pass(): Promise<void> {
    const { git, store } = this.#options
    if (!git) return
    for (const version of await store.pending(PASS_LIMIT)) {
      if (this.#closing) return
      try {
        await this.backup(version)
      } catch {
        this.#logger.warn(`site_initial_backup_failed site=${version.siteId}`)
      }
    }
  }

  /** The copy of one first version: archive, hash, upload, record. */
  async backup(version: PendingInitialBackup): Promise<void> {
    const { git, store, storage } = this.#options
    if (!git) return
    const root = await mkdtemp(join(tmpdir(), 'raditi-initial-backup-'))
    try {
      const url = await git.remoteUrl(`${version.repository.url}.git`)
      const file = join(root, 'site.tar.gz')
      await git.archiveCommit(root, url, version.repository.ref, version.commitSha, file)
      const bytes = (await stat(file)).size
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
      const key = initialBackupKey(version.siteId, version.commitSha)
      await storage.put('backups', key, createReadStream(file), {
        contentType: 'application/gzip',
        sizeBytes: bytes,
      })
      const stored = await storage.stat('backups', key)
      if (stored?.sizeBytes !== bytes) throw new Error('The stored copy has another size')
      const at = (this.#options.now ?? (() => new Date()))()
      const recorded = await store.record(version.siteId, version.commitSha, {
        key,
        bytes,
        sha256: hash.digest('hex'),
        at,
      })
      if (recorded)
        this.#logger.log(`site_initial_backup_saved site=${version.siteId} bytes=${bytes}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
