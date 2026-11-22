import { Buffer } from 'node:buffer'

import { artifactBrandOf, readArtifact, type PrismaClient } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import {
  artifactKindSpecOf,
  canvasScreensOf,
  canvasThumbKey,
  canvasThumbObjectKey,
  artifactFrameViewsOf,
  type ArtifactRenderRequest,
  type ArtifactRenderResponse,
} from '@repo/domain/artifacts'

// The thumbnails of a canvas (docs/plan/88-artifacts.md, §7.7, Ар49; spike 3; slice 88.15): drawn in
// the background, not when the board opens — ten screens in two views are some thirteen seconds of
// one render container. For each screen and view whose key has no picture yet the renderer of the
// browser worker draws the checked document as the owner sees it, and the JPEG goes under the key
// in the artifacts bucket. A key names the revisions of its document: nothing is ever drawn twice.

export interface ArtifactThumbsDeps {
  db: Pick<PrismaClient, '$transaction' | 'artifact' | 'artifactBlock'>
  storage: Pick<ObjectStorage, 'exists' | 'put'>
  /** The renderer of the browser worker; null — not configured: nothing is drawn. */
  render: ((request: ArtifactRenderRequest) => Promise<ArtifactRenderResponse>) | null
  logger?: { log(line: string): void; warn(line: string): void }
}

export class ArtifactThumbs {
  readonly #deps: ArtifactThumbsDeps

  constructor(deps: ArtifactThumbsDeps) {
    this.#deps = deps
  }

  /** The missing thumbnails of one canvas; how many were drawn. */
  async draw(artifactId: string): Promise<number> {
    const { db, storage, render } = this.#deps
    if (render === null) return 0
    const row = await db.artifact.findUnique({
      where: { id: artifactId },
      select: {
        workspaceId: true,
        ownerUserId: true,
        kind: true,
        deletedAt: true,
        takenDownAt: true,
      },
    })
    if (
      row === null ||
      row.ownerUserId === null ||
      row.deletedAt !== null ||
      row.takenDownAt !== null ||
      artifactKindSpecOf(row.kind)?.view !== 'canvas'
    )
      return 0
    const viewer = { kind: 'user' as const, userId: row.ownerUserId }
    const snapshot = async () => {
      const artifact = await readArtifact(db as PrismaClient, { artifactId, actor: viewer })
      const brand = await artifactBrandOf(db as PrismaClient, artifactId)
      return {
        screens: canvasScreensOf(artifact.blocks),
        keyOf: (frame: string) =>
          canvasThumbKey({
            blocks: artifact.blocks,
            frame,
            title: artifact.title,
            brand: brand && { id: brand.id, seq: brand.seq },
          }),
      }
    }
    const initial = await snapshot()
    let drawn = 0
    for (const screen of initial.screens) {
      const key = initial.keyOf(screen.key)
      // A screen of a canvas at both widths, a slide of «Презентация» once at 1280 (88.25).
      for (const view of artifactFrameViewsOf(row.kind)) {
        const objectKey = canvasThumbObjectKey({
          workspaceId: row.workspaceId,
          artifactId,
          key,
          width: view.width,
        })
        if (await storage.exists('artifacts', objectKey)) continue
        const answer = await render({
          artifactId,
          frame: screen.key,
          viewer,
          output: 'thumbs',
          widths: [view.width],
        })
        if (answer.thumbKey !== key) {
          // An edit can advance the key, but an unchanged key means an incompatible renderer.
          // Fail the job so the queue retries while the browser worker is being replaced.
          if ((await snapshot()).keyOf(screen.key) === key)
            throw new Error('Artifact thumbnail renderer returned an incompatible key')
          continue
        }
        const picture = answer.pictures.find((each) => each.width === view.width)
        if (!picture) {
          this.#deps.logger?.warn(`artifact_thumb_not_drawn width=${view.width}`)
          continue
        }
        const bytes = Buffer.from(picture.data, 'base64')
        await storage.put('artifacts', objectKey, bytes, { contentType: 'image/jpeg' })
        drawn += 1
      }
    }
    if (drawn > 0) this.#deps.logger?.log(`artifact_thumbs_drawn count=${drawn}`)
    return drawn
  }
}
