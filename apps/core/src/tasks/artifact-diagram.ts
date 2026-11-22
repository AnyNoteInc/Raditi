import { Logger } from '@nestjs/common'
import {
  artifactDiagramJobSource,
  artifactDiagramOf,
  saveArtifactDiagram,
  type PrismaClient,
} from '@repo/db'
import type { ArtifactDiagramJob } from '@repo/domain'
import type {
  ArtifactDiagramRenderRequest,
  ArtifactDiagramRenderResponse,
} from '@repo/domain/artifacts'

// A picture of «Схема» the cabinet asked for (docs/plan/88-artifacts.md, §7.13, 88.24б): the
// checked text of the block drawn by the browser worker on the page of the artifact's workspace and
// kept by the hash of the text. A picture kept already, or a block gone, is nothing to do; a worker
// that did not answer fails the job, and the queue tries again.

export type DiagramDraw = (
  request: ArtifactDiagramRenderRequest,
) => Promise<ArtifactDiagramRenderResponse>

export class ArtifactDiagram {
  readonly #logger = new Logger('ArtifactDiagram')

  constructor(
    private readonly deps: {
      db: Pick<PrismaClient, 'artifact' | 'artifactBlock' | 'artifactDiagramRender'>
      /** The browser worker; null — not configured: the cabinet keeps saying «рисуем». */
      draw: DiagramDraw | null
    },
  ) {}

  async run(job: ArtifactDiagramJob): Promise<void> {
    const { db, draw } = this.deps
    if (draw === null) {
      this.#logger.warn('A diagram was asked for, and no browser worker draws it')
      return
    }
    const source = await artifactDiagramJobSource(db, job)
    if (source === null) return
    if (await artifactDiagramOf(db, { artifactId: job.artifactId, source: source.source })) return
    const result = await draw({ workspaceId: source.workspaceId, source: source.source })
    await saveArtifactDiagram(db, { artifactId: job.artifactId, source: source.source, result })
  }
}
