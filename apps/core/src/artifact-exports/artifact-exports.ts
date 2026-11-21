import { readArtifact, type PrismaClient } from '@repo/db'
import { isDomainError, type ObjectStorage } from '@repo/domain'
import {
  artifactExportKey,
  artifactExportLimits,
  artifactKindSpecOf,
  tableOfBlocks,
} from '@repo/domain/artifacts'

import { workbookBytes } from './workbook.ts'

// The workbooks of tables (docs/plan/88-artifacts.md, §7.13, question 26): a person asked for
// «Скачать → Excel», web wrote the row and the job; this builds the workbook of the checked text
// of the table — as that person reads it, their role asked again — puts it under the artifact's
// prefix and marks the row `ready`. A person who lost the artifact, or a table that is gone, gets
// `failed`. Logs carry ids, never a cell.

export interface ArtifactExportsDependencies {
  db: PrismaClient
  storage: Pick<ObjectStorage, 'put' | 'delete'>
  logger?: { log(line: string): void; warn(line: string): void }
  now?: () => Date
}

export class ArtifactExports {
  readonly #deps: ArtifactExportsDependencies

  constructor(deps: ArtifactExportsDependencies) {
    this.#deps = deps
  }

  /**
   * Builds one export. Already done or failed — nothing. A refusal of the role or of the kind
   * marks it `failed` and does not throw; a fault of S3 or the database throws: BullMQ tries again.
   */
  async build(exportId: string): Promise<'ready' | 'failed' | 'skipped'> {
    const { db, storage, logger } = this.#deps
    const row = await db.artifactExport.findUnique({
      where: { id: exportId },
      include: { artifact: { select: { workspaceId: true } } },
    })
    if (!row || row.state !== 'pending') return 'skipped'
    let artifact
    try {
      artifact = await readArtifact(db, {
        artifactId: row.artifactId,
        actor: { kind: 'user', userId: row.userId },
      })
    } catch (error) {
      if (!isDomainError(error)) throw error
      await this.#fail(exportId)
      logger?.warn(`artifact_export_refused export=${exportId} reason=${error.code}`)
      return 'failed'
    }
    if (!artifactKindSpecOf(artifact.kind)?.exports.includes('xlsx')) {
      await this.#fail(exportId)
      logger?.warn(`artifact_export_refused export=${exportId} reason=kind`)
      return 'failed'
    }
    const table = tableOfBlocks(artifact.blocks)
    const bytes = await workbookBytes({
      title: artifact.title,
      columns: table.columns,
      rows: table.rows,
    })
    const key = artifactExportKey({
      workspaceId: row.artifact.workspaceId,
      artifactId: row.artifactId,
      exportId,
    })
    await storage.put('artifacts', key, bytes, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: bytes.byteLength,
    })
    const now = this.#now()
    await db.artifactExport.updateMany({
      where: { id: exportId, state: 'pending' },
      data: { state: 'ready', objectKey: key, bytes: BigInt(bytes.byteLength), readyAt: now },
    })
    logger?.log(`artifact_export_ready export=${exportId} rows=${table.rows.length}`)
    await this.#forgetOld(row.artifactId, now)
    return 'ready'
  }

  /** The workbooks of this artifact older than a day: their objects and rows go. Never throws. */
  async #forgetOld(artifactId: string, now: Date): Promise<void> {
    const { db, storage, logger } = this.#deps
    try {
      const old = await db.artifactExport.findMany({
        where: {
          artifactId,
          createdAt: { lt: new Date(now.getTime() - artifactExportLimits.keepMs) },
        },
        select: { id: true, objectKey: true },
        take: 50,
      })
      for (const each of old) {
        if (each.objectKey !== null) await storage.delete('artifacts', each.objectKey)
        await db.artifactExport.delete({ where: { id: each.id } })
      }
    } catch {
      logger?.warn(`artifact_export_cleanup_failed artifact=${artifactId}`)
    }
  }

  async #fail(exportId: string): Promise<void> {
    await this.#deps.db.artifactExport.updateMany({
      where: { id: exportId, state: 'pending' },
      data: { state: 'failed' },
    })
  }

  /** The last try of BullMQ failed: the row says so, the person asks again. Never throws. */
  async gaveUp(exportId: string): Promise<void> {
    await this.#fail(exportId).catch(() => undefined)
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date()
  }
}
