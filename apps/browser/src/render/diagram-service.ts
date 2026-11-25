import { Buffer } from 'node:buffer'

import { cleanDiagramSvg } from '@repo/browser-providers/render'
import {
  artifactRenderLimits,
  diagramErrorLine,
  normalizeDiagramSource,
  type ArtifactDiagramRenderRequest,
  type ArtifactDiagramRenderResponse,
} from '@repo/domain/artifacts'

import type { RenderPool } from './render-pool.ts'

// The diagrams of chat answers (docs/plan/91-chat-diagrams.md; spike 7 of plan 88; the «Схема»
// artifact was removed in plan 93, АТ3): the text normalised, drawn by Mermaid on the page of its
// workspace in the render pool, cleaned for `<img>`, at most 512 KiB. Plain class: the stand loads it from its sources.

export class DiagramService {
  readonly #pool: Pick<RenderPool, 'run'>

  constructor(pool: Pick<RenderPool, 'run'>) {
    this.#pool = pool
  }

  async render(request: ArtifactDiagramRenderRequest): Promise<ArtifactDiagramRenderResponse> {
    const source = normalizeDiagramSource(request.source)
    if (source.trim() === '')
      return { ok: false, reason: 'parse', line: null, message: 'The diagram is empty' }
    const raw = await this.#pool.run((renderer) =>
      renderer.diagram({ workspaceId: request.workspaceId, source }),
    )
    if (!raw.ok)
      return {
        ok: false,
        reason: raw.reason,
        line: raw.reason === 'parse' ? diagramErrorLine(raw.message) : null,
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
