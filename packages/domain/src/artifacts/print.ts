import { z } from 'zod'

import { artifactRenderLimits } from './limits.ts'

/**
 * «Скачать PDF» of «Отчёт» (docs/plan/88-artifacts.md, §7.7, §7.13; slice 88.32): core assembles the
 * page of the report — the same page a publication serves, its charts inline — and the browser
 * worker prints it in a Chromium without network and without scripts, A4, at most `pdfMaxPages`
 * pages. `POST /v1/print` behind the worker's token.
 */
export const ARTIFACT_PRINT_PATH = '/v1/print'

const MiB = 1024 * 1024

export const artifactPrintLimits = Object.freeze({
  /** The page with its charts as `data:` addresses. */
  htmlChars: 4 * MiB,
  /** The printed file. */
  pdfBytes: 8 * MiB,
  /** One print end to end in the Chromium. */
  printMs: 30_000,
  pages: artifactRenderLimits.pdfMaxPages,
})

export const artifactPrintRequestSchema = z.strictObject({
  /** A whole HTML document without scripts: printed as it is, nothing loaded from anywhere. */
  html: z.string().min(1).max(artifactPrintLimits.htmlChars),
})
export type ArtifactPrintRequest = z.infer<typeof artifactPrintRequestSchema>

export const artifactPrintResponseSchema = z.strictObject({
  /** The PDF in base64. */
  pdf: z
    .string()
    .min(1)
    .max(Math.ceil((artifactPrintLimits.pdfBytes * 4) / 3) + 4),
})
export type ArtifactPrintResponse = z.infer<typeof artifactPrintResponseSchema>
