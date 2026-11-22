import {
  artifactBrandOf,
  artifactRole,
  enqueueOutbox,
  readArtifact,
  type PrismaClient,
} from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import {
  ARTIFACT_QUEUE,
  ARTIFACT_THUMBS_JOB,
  CANVAS_RENDER_VERSION,
  artifactKindSpecOf,
  artifactNotFound,
  canvasScreensOf,
  canvasThumbKey,
  canvasThumbObjectKey,
  artifactFrameViewsOf,
} from '@repo/domain/artifacts'

// The thumbnails of a canvas (docs/plan/88-artifacts.md, Ар8, Ар49, §7.7; slice 88.15): the board
// shows each view of a screen as a picture the renderer of the browser worker drew, keyed by the
// revisions its document is made of (`canvasThumbKey`). Deduplicate each revision and render
// version for a minute: if a job exhausts its retries, an open board can ask again.
const thumbRetryWindowMs = 60_000

export interface CanvasThumb {
  frame: string
  width: number
  /** `/api/artifact-thumbs/<artifactId>/<key>-<width>.jpg`; null — not drawn yet. */
  url: string | null
}

export async function canvasThumbs(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'exists'>,
  input: { userId: string; artifactId: string },
): Promise<{ thumbs: CanvasThumb[]; pending: boolean }> {
  if ((await artifactRole(db, input)) === null) throw artifactNotFound()
  const artifact = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: { kind: 'user', userId: input.userId },
  })
  if (artifactKindSpecOf(artifact.kind)?.view !== 'canvas') throw artifactNotFound()
  const owner = await db.artifact.findUniqueOrThrow({
    where: { id: artifact.id },
    select: { workspaceId: true },
  })
  const brand = await artifactBrandOf(db, artifact.id)
  const thumbs: CanvasThumb[] = []
  let pending = false
  for (const screen of canvasScreensOf(artifact.blocks)) {
    const key = canvasThumbKey({
      blocks: artifact.blocks,
      frame: screen.key,
      title: artifact.title,
      brand: brand && { id: brand.id, seq: brand.seq },
    })
    for (const view of artifactFrameViewsOf(artifact.kind)) {
      const ready = await storage.exists(
        'artifacts',
        canvasThumbObjectKey({
          workspaceId: owner.workspaceId,
          artifactId: artifact.id,
          key,
          width: view.width,
        }),
      )
      if (!ready) pending = true
      thumbs.push({
        frame: screen.key,
        width: view.width,
        url: ready ? `/api/artifact-thumbs/${artifact.id}/${key}-${view.width}.jpg` : null,
      })
    }
  }
  if (pending) {
    const window = Math.floor(Date.now() / thumbRetryWindowMs)
    await enqueueOutbox(db, {
      topic: ARTIFACT_QUEUE,
      type: ARTIFACT_THUMBS_JOB,
      payload: { artifactId: artifact.id },
      dedupeKey: `${ARTIFACT_THUMBS_JOB}:${artifact.id}:${artifact.seq}:${brand?.id ?? '-'}:${brand?.seq ?? 0}:v${CANVAS_RENDER_VERSION}:${window}`,
    })
  }
  return { thumbs, pending }
}

/** The bytes of a thumbnail for a viewer who may open the artifact; null — none. */
export async function canvasThumbFile(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; artifactId: string; file: string },
): Promise<Uint8Array | null> {
  const match = /^([0-9a-f]{26})-(1440|390|1280)\.jpg$/.exec(input.file)
  if (!match) return null
  if ((await artifactRole(db, input)) === null) return null
  const row = await db.artifact.findUnique({
    where: { id: input.artifactId },
    select: { workspaceId: true, kind: true },
  })
  if (row === null || artifactKindSpecOf(row.kind)?.view !== 'canvas') return null
  const object = await storage.get(
    'artifacts',
    canvasThumbObjectKey({
      workspaceId: row.workspaceId,
      artifactId: input.artifactId,
      key: match[1]!,
      width: Number(match[2]),
    }),
  )
  if (object === null) return null
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of object) {
    length += chunk.byteLength
    // A thumbnail is at most a few hundred KiB; anything near 8 MiB is not one.
    if (length > 8 * 1024 * 1024) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}
