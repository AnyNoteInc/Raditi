import { Buffer } from 'node:buffer'

import { cleanDiagramSvg } from '@repo/browser-providers/render'
import {
  artifactRenderLimits,
  diagramErrorLine,
  diagramSourceFor,
  type ArtifactDiagramRenderRequest,
  type ArtifactDiagramRenderResponse,
} from '@repo/domain/artifacts'

import type { RenderPool } from './render-pool.ts'

// The diagrams of «Схема» (docs/plan/88-artifacts.md, §7.13, slice 88.24а; spike 7) and of the
// answers of the chat (docs/plan/91-chat-diagrams.md, Д2): the text normalised, drawn by Mermaid or
// PlantUML on the page of its workspace and engine in the render pool, cleaned for `<img>`, at most
// 512 KiB. Plain class: the stand loads it from its sources.

/** The author's line of an error: the engine counts the lines the platform added. */
function authorLine(line: number | null, added: number): number | null {
  return line !== null && line - added > 0 ? line - added : null
}

export class DiagramService {
  readonly #pool: Pick<RenderPool, 'run'>

  constructor(pool: Pick<RenderPool, 'run'>) {
    this.#pool = pool
  }

  async render(request: ArtifactDiagramRenderRequest): Promise<ArtifactDiagramRenderResponse> {
    const engine = request.engine ?? 'mermaid'
    const { text: source, addedLines, empty } = diagramSourceFor(engine, request.source)
    if (empty) return { ok: false, reason: 'parse', line: null, message: 'The diagram is empty' }
    const raw = await this.#pool.run((renderer) =>
      renderer.diagram({ workspaceId: request.workspaceId, source, engine }),
    )
    if (!raw.ok)
      return {
        ok: false,
        reason: raw.reason,
        line: raw.reason === 'parse' ? authorLine(diagramErrorLine(raw.message), addedLines) : null,
        message: raw.message.slice(0, 300),
      }
    const clean = cleanDiagramSvg(raw.svg)
    if (clean === null)
      return { ok: false, reason: 'render', line: null, message: 'The engine drew no picture' }
    if (Buffer.byteLength(clean.svg) > artifactRenderLimits.diagramSvgBytes)
      return {
        ok: false,
        reason: 'too_large',
        line: null,
        message: 'The picture is over 512 KiB: split the diagram',
      }
    return { ok: true, svg: clean.svg, width: clean.width, height: clean.height, type: raw.type }
  }
}
