import { createHash } from 'node:crypto'

import {
  AGENT_TURN_QUEUE,
  ARTIFACT_DIAGRAM_JOB,
  artifactDiagramJobSchema,
  type ArtifactDiagramJob,
} from '@repo/domain'
import {
  artifactNotFound,
  normalizeDiagramSource,
  type ArtifactDiagramRenderResponse,
} from '@repo/domain/artifacts'

import { artifactRole } from './artifacts.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { enqueueOutbox, type OutboxWriter } from './outbox.ts'

// The pictures of «Схема» (docs/plan/88-artifacts.md, §7.13, slice 88.24б): kept by the SHA-256 of
// the normalised text within the artifact — the agent's text before the check has no revision, and
// one key serves its draft, the checked text and every version. mcp draws the agent's text at once;
// the cabinet asks for the checked text and, when no picture is kept, core draws it.

/** The key of a text: what the engine would see, hashed. */
export function diagramSourceKey(source: string): string {
  return createHash('sha256').update(normalizeDiagramSource(source)).digest('hex')
}

type Db = Pick<PrismaClient, 'artifactDiagramRender'>

/** Keeps a picture or an error of a text, once: a second one of the same text is the same. */
export async function saveArtifactDiagram(
  db: Db,
  input: { artifactId: string; source: string; result: ArtifactDiagramRenderResponse },
): Promise<void> {
  const { result } = input
  await db.artifactDiagramRender.createMany({
    data: [
      {
        artifactId: input.artifactId,
        sourceSha256: diagramSourceKey(input.source),
        ok: result.ok,
        ...(result.ok
          ? {
              svg: result.svg,
              width: result.width,
              height: result.height,
              diagramType: result.type,
            }
          : { reason: result.reason, errorLine: result.line, errorMessage: result.message }),
      },
    ],
    skipDuplicates: true,
  })
}

/** The kept picture or error of a text; null — none yet. */
export async function artifactDiagramOf(db: Db, input: { artifactId: string; source: string }) {
  return db.artifactDiagramRender.findUnique({
    where: {
      artifactId_sourceSha256: {
        artifactId: input.artifactId,
        sourceSha256: diagramSourceKey(input.source),
      },
    },
  })
}

export async function enqueueArtifactDiagram(
  tx: OutboxWriter,
  job: ArtifactDiagramJob,
  sourceKey: string,
): Promise<boolean> {
  const payload = artifactDiagramJobSchema.parse(job)
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: ARTIFACT_DIAGRAM_JOB,
    payload,
    dedupeKey: `${ARTIFACT_DIAGRAM_JOB}:${payload.artifactId}:${sourceKey}`,
  })
}

/** What the cabinet shows of a block of «Схема»: for people only the line of an error. */
export type ArtifactDiagramView =
  | { state: 'empty' }
  | { state: 'drawing' }
  | { state: 'drawn'; svg: string; width: number; height: number }
  | { state: 'failed'; line: number | null }

/**
 * The picture of the checked text of a block for a reader of the artifact: kept — shown; none yet —
 * core is asked to draw it, and the cabinet asks again. The agent's text before the check is never
 * drawn for a person.
 */
export async function readArtifactDiagram(
  db: Pick<PrismaClient, '$transaction' | 'artifactDiagramRender' | 'artifactBlock' | '$queryRaw'> &
    Parameters<typeof artifactRole>[0] &
    OutboxWriter,
  input: { artifactId: string; block: string; userId: string },
): Promise<ArtifactDiagramView> {
  if ((await artifactRole(db, { artifactId: input.artifactId, userId: input.userId })) === null)
    throw artifactNotFound()
  const block = await db.artifactBlock.findFirst({
    where: {
      documentId: input.artifactId,
      sectionKey: input.block,
      blockKind: 'diagram',
      deletedRev: null,
    },
    select: { content: true },
  })
  if (!block) throw artifactNotFound()
  if (!block.content || block.content.trim() === '') return { state: 'empty' }
  const kept = await artifactDiagramOf(db, { artifactId: input.artifactId, source: block.content })
  if (kept?.ok && kept.svg && kept.width && kept.height)
    return { state: 'drawn', svg: kept.svg, width: kept.width, height: kept.height }
  if (kept && !kept.ok) return { state: 'failed', line: kept.errorLine }
  await enqueueArtifactDiagram(
    db,
    { artifactId: input.artifactId, block: input.block },
    diagramSourceKey(block.content),
  )
  return { state: 'drawing' }
}

/** What core draws for a job: the checked text of the block and the workspace of its page. */
export async function artifactDiagramJobSource(
  db: Pick<PrismaClient, 'artifact' | 'artifactBlock'>,
  job: ArtifactDiagramJob,
): Promise<{ workspaceId: string; source: string } | null> {
  const artifact = await db.artifact.findUnique({
    where: { id: job.artifactId },
    select: { workspaceId: true, deletedAt: true },
  })
  if (!artifact || artifact.deletedAt !== null) return null
  const block = await db.artifactBlock.findFirst({
    where: {
      documentId: job.artifactId,
      sectionKey: job.block,
      blockKind: 'diagram',
      deletedRev: null,
    },
    select: { content: true },
  })
  if (!block?.content || block.content.trim() === '') return null
  return { workspaceId: artifact.workspaceId, source: block.content }
}
