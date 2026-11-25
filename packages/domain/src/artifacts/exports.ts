import { z } from 'zod'

import { DomainError } from '../errors.ts'

/**
 * «Скачать» of an artifact (docs/plan/88-artifacts.md, §7.7, §7.13): web writes a row of
 * `artifact_exports` and the job `artifact.export` of the queue `artifacts` in one transaction;
 * core builds the file (the PDF and the PPTX of «Презентация», the PNG of «Изображение»), puts it
 * under the artifact's prefix of the artifacts bucket and marks the row; web gives it to the person
 * who asked, as an attachment.
 */
export const ARTIFACT_QUEUE = 'artifacts' as const
export const ARTIFACT_EXPORT_JOB = 'artifact.export'

/** The PDF and the PPTX of «Презентация» (88.25в), the PNG of «Изображение» (88.26). */
export const artifactExportFormats = ['pdf', 'pptx', 'png'] as const
export type ArtifactExportFormat = (typeof artifactExportFormats)[number]

export const artifactExportContentTypes: Readonly<Record<ArtifactExportFormat, string>> =
  Object.freeze({
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
  })

export const artifactExportStates = ['pending', 'ready', 'failed'] as const
export type ArtifactExportState = (typeof artifactExportStates)[number]

export const artifactExportJobSchema = z.strictObject({ exportId: z.uuid() })

/**
 * The thumbnails of the screens of a canvas (docs/plan/88-artifacts.md, §7.7, slice 88.15): core
 * draws the missing ones in the background through the renderer of the browser worker.
 */
export const ARTIFACT_THUMBS_JOB = 'artifact.thumbs'
export const artifactThumbsJobSchema = z.strictObject({ artifactId: z.uuid() })

export const artifactExportLimits = Object.freeze({
  /** A file is kept this long after it was built; a newer export of the artifact removes older ones. */
  keepMs: 24 * 60 * 60 * 1000,
  /** Requests of one person for one artifact that may wait at once. */
  pendingPerArtifact: 3,
})

/** The key of an exported file: under the artifact's prefix of the artifacts bucket (spec §14). */
export function artifactExportKey(input: {
  workspaceId: string
  artifactId: string
  exportId: string
  format: ArtifactExportFormat
}): string {
  const ids = z.uuid()
  for (const id of [input.workspaceId, input.artifactId, input.exportId])
    if (!ids.safeParse(id).success)
      throw new DomainError('BAD_REQUEST', 'An export key is built from three ids', 400)
  return `artifacts/${input.workspaceId.toLowerCase()}/${input.artifactId.toLowerCase()}/exports/${input.exportId.toLowerCase()}.${input.format}`
}

/** The name of a downloaded file: the title without what a file system refuses. */
export function artifactExportFileName(title: string, extension: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${name === '' ? 'Артефакт' : name}.${extension}`
}
