import type {
  ArtifactDiagramRenderRequest,
  ArtifactDiagramRenderResponse,
} from '@repo/domain/artifacts'

/** One Mermaid or PlantUML picture drawn by the browser worker (`POST /v1/diagram`). */
export type DiagramDraw = (
  request: ArtifactDiagramRenderRequest,
) => Promise<ArtifactDiagramRenderResponse>
