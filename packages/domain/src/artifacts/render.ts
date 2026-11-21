import { z } from 'zod'

import { artifactBlockKeySchema } from './blocks.ts'
import { artifactRenderLimits } from './limits.ts'

/**
 * The renderer of frames in `apps/browser` (docs/plan/88-artifacts.md, Ар32, §7.12, §7.13; spike 3;
 * slices 88.15, 88.15б, 88.15в): `POST /v1/render` behind the worker's token. It reads the blocks of
 * the artifact from PostgreSQL as the caller sees them — the agent of a chat with its own blocks
 * that wait for the check, a person with the checked ones — and its files from the artifacts
 * bucket, draws the frame in a Chromium without network at the widths of a computer and a phone,
 * and answers one of three: the text report of its layout (`artifact_layout`), strips of JPEG for
 * the helper `look` (`artifact_render`), or the thumbnails of a canvas (core, in the background).
 */

export const ARTIFACT_RENDER_PATH = '/v1/render'

export const artifactRenderOutputs = ['layout', 'image', 'thumbs'] as const
export type ArtifactRenderOutput = (typeof artifactRenderOutputs)[number]

const widths = [
  artifactRenderLimits.viewportWidths.desktop,
  artifactRenderLimits.viewportWidths.phone,
] as const
export const artifactRenderWidthSchema = z.union([z.literal(widths[0]), z.literal(widths[1])])
export type ArtifactRenderWidth = z.infer<typeof artifactRenderWidthSchema>

/** Who looks: the agent of a turn (with its own unchecked blocks) or a person. */
export const artifactRenderViewerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    taskId: z.uuid(),
    turnNo: z.number().int().min(1).max(1_000_000),
  }),
  z.strictObject({ kind: z.literal('user'), userId: z.string().min(1).max(200) }),
])
export type ArtifactRenderViewer = z.infer<typeof artifactRenderViewerSchema>

export const artifactRenderRequestSchema = z.strictObject({
  artifactId: z.uuid(),
  /** The frame of a canvas; null — the mockup itself (its blocks at the top). */
  frame: artifactBlockKeySchema.nullable(),
  viewer: artifactRenderViewerSchema,
  output: z.enum(artifactRenderOutputs),
  /** The widths to draw; absent — both. */
  widths: z.array(artifactRenderWidthSchema).min(1).max(2).optional(),
  /** `artifact_layout` with every finding, past the 1 500 characters of the report. */
  detail: z.boolean().optional(),
})
export type ArtifactRenderRequest = z.infer<typeof artifactRenderRequestSchema>

const base64 = z.string().max(4 * 1024 * 1024)

export const artifactRenderPictureSchema = z.strictObject({
  width: artifactRenderWidthSchema,
  /** The number of the strip from the top: 0, 1 (`stripPx` each), or 0 for a thumbnail. */
  part: z.number().int().min(0).max(16),
  type: z.literal('image/jpeg'),
  data: base64,
})
export type ArtifactRenderPicture = z.infer<typeof artifactRenderPictureSchema>

export const artifactRenderResponseSchema = z.strictObject({
  title: z.string().max(400),
  /** The English report for the model (`layout`, and a short one with `image`). */
  report: z.string().max(20_000),
  /** One Russian line of what was found, for the client (rule 10). */
  ru: z.string().max(400),
  problems: z.number().int().min(0).max(10_000),
  /** The height of the document at each width; null — not drawn. */
  heights: z.array(
    z.strictObject({
      width: artifactRenderWidthSchema,
      height: z.number().int().min(0).nullable(),
    }),
  ),
  pictures: z.array(artifactRenderPictureSchema).max(16),
  /** Only for canvas thumbnails: the revision key of the actual render source. */
  thumbKey: z
    .string()
    .regex(/^[0-9a-f]{26}$/)
    .optional(),
})
export type ArtifactRenderResponse = z.infer<typeof artifactRenderResponseSchema>

/** The refusals of the renderer, as `{ code }` of the worker's API. */
export const artifactRenderCodes = [
  'RENDER_NOT_FOUND',
  'RENDER_NOT_A_FRAME',
  'RENDER_UNAVAILABLE',
  'RENDER_BUSY',
] as const
export type ArtifactRenderCode = (typeof artifactRenderCodes)[number]

/** How long one call may take: two widths in parallel within the call of `artifact_layout`. */
export const artifactRenderCallMs = artifactRenderLimits.layoutCallMs
