import { Buffer } from 'node:buffer'

import {
  RENDER_FILES_ORIGIN,
  layoutReport,
  renderFontCss,
  type FrameRenderFile,
  type FrameRenderResult,
} from '@repo/browser-providers/render'
import { artifactFilesByIds, readArtifact, type ArtifactActor, type PrismaClient } from '@repo/db'
import { DomainError, isDomainError, type ObjectStorage } from '@repo/domain'
import {
  artifactFileRefsOf,
  artifactFrameBlocksOf,
  artifactFrameDocument,
  artifactFramePartMark,
  artifactFramePolicy,
  artifactKindSpecOf,
  artifactRenderLimits,
  canvasThumbKey,
  canvasThumbMaxCssPx,
  canvasThumbScale,
  withArtifactFileAddresses,
  type ArtifactRenderPicture,
  type ArtifactRenderRequest,
  type ArtifactRenderResponse,
  artifactFrameSizeOf,
} from '@repo/domain/artifacts'

import type { RenderPool } from './render-pool.ts'

// The renderer of frames (docs/plan/88-artifacts.md, Ар32, §7.12; slices 88.15, 88.15б, 88.15в):
// the document of a frame assembled by the one function of web (`artifactFrameBlocksOf`,
// `artifactFrameDocument`) from the blocks as the caller sees them, its files from the artifacts
// bucket, drawn by the pool at the widths of a computer and of a phone. Each part of the body is
// marked by its block, so the report names the block of an element. Plain class: the stand loads
// it from its sources.

/** The reader of the files of artifacts: the artifacts bucket, read only. */
export type ArtifactFilesReader = Pick<ObjectStorage, 'get'>

export interface RenderServiceDeps {
  db: Pick<PrismaClient, '$transaction' | 'artifact' | 'artifactBlock' | 'artifactFile'>
  files: ArtifactFilesReader
  pool: Pick<RenderPool, 'run'>
}

const heightOf = (width: number) =>
  width === artifactRenderLimits.viewportWidths.phone
    ? artifactRenderLimits.viewportHeights.phone
    : artifactRenderLimits.viewportHeights.desktop

/** A thumbnail of a fixed frame is about 640 px wide: a slide at a half, a story at a little more. */
const fixedThumbScale = (width: number) => Math.min(1, 640 / width)

const notFound = () => new DomainError('RENDER_NOT_FOUND', 'No such artifact or frame', 404)

async function bytesOf(stream: AsyncIterable<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.byteLength
    if (length > max) return null
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks, length))
}

/**
 * A fixed frame taller than its size is cut (88.25, 88.26): the first problem of its report, in the
 * agent's words and the client's — a slide in the show, a picture in its file.
 */
export function withSlideHeight(
  report: ReturnType<typeof layoutReport>,
  height: number | null,
  limit: number = artifactRenderLimits.viewportHeights.slide,
  what: 'slide' | 'picture' = 'slide',
): ReturnType<typeof layoutReport> {
  if (height === null || height <= limit) return report
  const [en, ru] = what === 'slide' ? ['slide', 'Слайд'] : ['picture', 'Изображение']
  return {
    ...report,
    text: `The ${en} is ${height} px tall, over its ${limit}: shorten the text or make it smaller.\n${report.text}`,
    ru: `${ru} не помещается: ${height} px при высоте ${limit}. ${report.ru}`.trim(),
    problems: report.problems + 1,
  }
}

export class RenderService {
  readonly #deps: RenderServiceDeps

  constructor(deps: RenderServiceDeps) {
    this.#deps = deps
  }

  /** The document of the frame, its policy and its files, as the viewer sees it. */
  async source(request: Pick<ArtifactRenderRequest, 'artifactId' | 'frame' | 'viewer'>) {
    const actor: ArtifactActor =
      request.viewer.kind === 'agent'
        ? { kind: 'agent', taskId: request.viewer.taskId, turnNo: request.viewer.turnNo }
        : { kind: 'user', userId: request.viewer.userId }
    let artifact: Awaited<ReturnType<typeof readArtifact>>
    try {
      artifact = await readArtifact(this.#deps.db as PrismaClient, {
        artifactId: request.artifactId,
        actor,
      })
    } catch (error) {
      if (isDomainError(error)) throw notFound()
      throw error
    }
    const spec = artifactKindSpecOf(artifact.kind)
    if (spec === null || spec.view !== 'canvas')
      throw new DomainError('RENDER_NOT_A_FRAME', 'This artifact has no frame', 409)
    const parts = artifactFrameBlocksOf({ blocks: artifact.blocks, frame: request.frame })
    if (parts === null) throw notFound()
    const used = [
      ...parts.html,
      ...parts.style,
      ...parts.script,
      ...(parts.settings ? [parts.settings] : []),
    ]
    const ids = new Set(used.flatMap((block) => artifactFileRefsOf(block.content ?? '')))
    const rows = await artifactFilesByIds(this.#deps.db as PrismaClient, {
      artifactId: artifact.id,
      ids: [...ids],
    })
    const files = new Map<string, FrameRenderFile>()
    const address = new Map<string, string>()
    for (const row of rows) {
      const stream = await this.#deps.files.get('artifacts', row.objectKey)
      const bytes = stream === null ? null : await bytesOf(stream, row.bytes)
      if (bytes === null) continue
      const url = `${RENDER_FILES_ORIGIN}/v/f-${row.id}`
      files.set(url, { type: row.contentType, bytes })
      address.set(row.id, url)
    }
    const addressed = (text: string) =>
      withArtifactFileAddresses(text, (id) => address.get(id) ?? null)
    const fonts = renderFontCss(RENDER_FILES_ORIGIN)
    // A slide or a picture has a size of its own; a screen of a canvas is adaptive (88.25, 88.26).
    const frameBlock = artifact.blocks.find((block) => block.key === request.frame)
    const fixed = artifactFrameSizeOf(artifact.kind, frameBlock?.props)
    const html = artifactFrameDocument({
      title: artifact.title,
      platformCss:
        fonts.css +
        // A fixed frame clipped by its own style still has its height measured (88.25, 88.26):
        // the renderer takes the clip off the document; its pictures are cut at its size.
        (fixed
          ? `html,body{height:auto!important;min-height:${fixed.height}px;overflow:visible!important}`
          : ''),
      bridge: false,
      parts: {
        html: parts.html.map(
          (block) => artifactFramePartMark(block.key) + addressed(block.content!),
        ),
        style: parts.style.map((block) => addressed(block.content!)),
        script: parts.script.map((block) => addressed(block.content!)),
        settings: parts.settings?.content ?? null,
      },
    })
    const fileUrls = [...files.entries()]
    const policy = artifactFramePolicy("'none'", {
      scripts: [],
      styles: [],
      images: fileUrls.filter(([, file]) => !file.type.startsWith('font/')).map(([url]) => url),
      fonts: [
        ...fonts.urls,
        ...fileUrls.filter(([, file]) => file.type.startsWith('font/')).map(([url]) => url),
      ],
    })
    const thumbKey = canvasThumbKey({
      blocks: artifact.blocks,
      frame: request.frame,
      title: artifact.title,
    })
    return {
      title: artifact.title,
      html,
      policy,
      files,
      thumbKey,
      fixed,
      slides: artifact.kind === 'slides',
    }
  }

  async render(request: ArtifactRenderRequest): Promise<ArtifactRenderResponse> {
    const source = await this.source(request)
    const fixed = source.fixed
    // A fixed frame is one view of its size, whatever was asked (88.25, 88.26).
    const asked: number[] = fixed
      ? [fixed.width]
      : (request.widths ?? [
          artifactRenderLimits.viewportWidths.desktop,
          artifactRenderLimits.viewportWidths.phone,
        ])
    if ((request.output === 'slide' || request.output === 'png') && !fixed)
      throw new DomainError('RENDER_NOT_A_FRAME', 'Only a fixed frame is drawn for a file', 409)
    const outputs = (width: number) =>
      request.output === 'slide'
        ? // A slide for its PDF and PPTX: 1920×1080, sharp enough to read (88.25в).
          { thumb: { scale: 1.5, maxCssPx: fixed!.height, quality: 90 } }
        : request.output === 'png'
          ? // A picture in its own size, lossless, for «Скачать PNG» (88.26).
            { thumb: { scale: 1, maxCssPx: fixed!.height, format: 'png' as const } }
          : request.output === 'layout'
            ? { map: true }
            : request.output === 'image'
              ? // Four pictures a check (Ар32): two strips a width at most.
                {
                  map: true,
                  strips: Math.floor(artifactRenderLimits.picturesPerLook / asked.length),
                }
              : {
                  thumb: fixed
                    ? // A fixed frame is its size and nothing below.
                      { scale: fixedThumbScale(fixed.width), maxCssPx: fixed.height }
                    : {
                        // The board shows thumbnails at half the CSS pixels; the phone list at 2× (Ар49).
                        scale:
                          width === artifactRenderLimits.viewportWidths.phone
                            ? 1
                            : canvasThumbScale,
                        maxCssPx: canvasThumbMaxCssPx,
                      },
                }
    const results = await Promise.all(
      asked.map((width) =>
        this.#deps.pool.run((renderer) =>
          renderer.render({
            html: source.html,
            policy: source.policy,
            files: source.files,
            width,
            height: fixed ? fixed.height : heightOf(width),
            outputs: outputs(width),
          }),
        ),
      ),
    )
    const byWidth = new Map<number, FrameRenderResult>(
      asked.map((width, at) => [width, results[at]!]),
    )
    const report =
      request.output === 'thumbs' || request.output === 'slide' || request.output === 'png'
        ? null
        : withSlideHeight(
            layoutReport({ title: source.title, byWidth, detail: request.detail === true }),
            fixed ? (byWidth.get(asked[0]!)?.docHeight ?? null) : null,
            fixed?.height,
            source.slides ? 'slide' : 'picture',
          )
    const pictures: ArtifactRenderPicture[] = []
    for (const [width, result] of byWidth) {
      const w = width
      if (result.thumb)
        pictures.push({
          width: w,
          part: 0,
          type: request.output === 'png' ? 'image/png' : 'image/jpeg',
          data: Buffer.from(result.thumb).toString('base64'),
        })
      result.strips.forEach((strip, part) =>
        pictures.push({
          width: w,
          part,
          type: 'image/jpeg',
          data: Buffer.from(strip).toString('base64'),
        }),
      )
    }
    return {
      title: source.title.slice(0, 400),
      report: report?.text ?? '',
      ru: report?.ru ?? '',
      problems: report?.problems ?? 0,
      heights: asked.map((width) => ({ width, height: byWidth.get(width)?.docHeight ?? null })),
      pictures,
      ...(request.output !== 'layout' && request.output !== 'image'
        ? { thumbKey: source.thumbKey }
        : {}),
    }
  }
}
