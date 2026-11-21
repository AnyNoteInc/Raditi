import { Buffer } from 'node:buffer'

import {
  RENDER_FILES_ORIGIN,
  layoutReport,
  renderFontCss,
  type FrameRenderFile,
  type FrameRenderResult,
} from '@repo/browser-providers/render'
import {
  artifactBrandOf,
  artifactFilesByIds,
  readArtifact,
  type ArtifactActor,
  type PrismaClient,
} from '@repo/db'
import { DomainError, isDomainError, type ObjectStorage } from '@repo/domain'
import {
  artifactFileRefsOf,
  artifactFrameBlocksOf,
  artifactFrameDocument,
  artifactFramePartMark,
  artifactFramePolicy,
  artifactKindSpecOf,
  artifactRenderLimits,
  brandCss,
  brandTokensOf,
  canvasThumbMaxCssPx,
  canvasThumbScale,
  withArtifactFileAddresses,
  type ArtifactRenderPicture,
  type ArtifactRenderRequest,
  type ArtifactRenderResponse,
  type ArtifactRenderWidth,
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

const heightOf = (width: ArtifactRenderWidth) =>
  width === artifactRenderLimits.viewportWidths.phone
    ? artifactRenderLimits.viewportHeights.phone
    : artifactRenderLimits.viewportHeights.desktop

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
    if (spec === null || (spec.view !== 'frame' && spec.view !== 'canvas'))
      throw new DomainError('RENDER_NOT_A_FRAME', 'This artifact has no frame', 409)
    const parts = artifactFrameBlocksOf({
      framed: spec.framed,
      blocks: artifact.blocks,
      frame: request.frame,
    })
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
    const brand = await artifactBrandOf(this.#deps.db as PrismaClient, artifact.id)
    const html = artifactFrameDocument({
      title: artifact.title,
      platformCss: fonts.css + (brand ? brandCss(brandTokensOf(brand.settings)) : ''),
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
    return { title: artifact.title, html, policy, files }
  }

  async render(request: ArtifactRenderRequest): Promise<ArtifactRenderResponse> {
    const source = await this.source(request)
    const asked: ArtifactRenderWidth[] = request.widths ?? [
      artifactRenderLimits.viewportWidths.desktop,
      artifactRenderLimits.viewportWidths.phone,
    ]
    const outputs = (width: ArtifactRenderWidth) =>
      request.output === 'layout'
        ? { map: true }
        : request.output === 'image'
          ? // Four pictures a check (Ар32): two strips a width at most.
            { map: true, strips: Math.floor(artifactRenderLimits.picturesPerLook / asked.length) }
          : {
              thumb: {
                // The board shows thumbnails at half the CSS pixels; the phone list at 2× (Ар49).
                scale: width === artifactRenderLimits.viewportWidths.phone ? 1 : canvasThumbScale,
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
            height: heightOf(width),
            outputs: outputs(width),
          }),
        ),
      ),
    )
    const byWidth = new Map<number, FrameRenderResult>(
      asked.map((width, at) => [width, results[at]!]),
    )
    const report =
      request.output === 'thumbs'
        ? null
        : layoutReport({ title: source.title, byWidth, detail: request.detail === true })
    const pictures: ArtifactRenderPicture[] = []
    for (const [width, result] of byWidth) {
      const w = width as ArtifactRenderWidth
      if (result.thumb)
        pictures.push({
          width: w,
          part: 0,
          type: 'image/jpeg',
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
    }
  }
}
