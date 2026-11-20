import { z } from 'zod'

import { DomainError } from '../errors.ts'

/**
 * «Скачать → Excel» of a table (docs/plan/88-artifacts.md, §7.7, §7.13, question 26 — by default
 * core builds the workbook, the browser keeps CSV): web writes a row of `artifact_exports` and the
 * job `artifact.export` of the queue `artifacts` in one transaction; core builds the workbook with
 * `write-excel-file/node`, puts it under the artifact's prefix of the artifacts bucket and marks the
 * row; web gives it to the person who asked, as an attachment.
 */
export const ARTIFACT_QUEUE = 'artifacts' as const
export const ARTIFACT_EXPORT_JOB = 'artifact.export'

export const artifactExportFormats = ['xlsx'] as const
export type ArtifactExportFormat = (typeof artifactExportFormats)[number]

export const artifactExportStates = ['pending', 'ready', 'failed'] as const
export type ArtifactExportState = (typeof artifactExportStates)[number]

export const artifactExportJobSchema = z.strictObject({ exportId: z.uuid() })

export const artifactExportLimits = Object.freeze({
  /** A workbook is kept this long after it was built; a newer export of the artifact removes older ones. */
  keepMs: 24 * 60 * 60 * 1000,
  /** Requests of one person for one artifact that may wait at once. */
  pendingPerArtifact: 3,
})

/** The key of a workbook: under the artifact's prefix of the artifacts bucket (spec §14). */
export function artifactExportKey(input: {
  workspaceId: string
  artifactId: string
  exportId: string
}): string {
  const ids = z.uuid()
  for (const id of [input.workspaceId, input.artifactId, input.exportId])
    if (!ids.safeParse(id).success)
      throw new DomainError('BAD_REQUEST', 'An export key is built from three ids', 400)
  return `artifacts/${input.workspaceId.toLowerCase()}/${input.artifactId.toLowerCase()}/exports/${input.exportId.toLowerCase()}.xlsx`
}

/** The name of a downloaded file: the title without what a file system refuses. */
export function artifactExportFileName(title: string, extension: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${name === '' ? 'Таблица' : name}.${extension}`
}
