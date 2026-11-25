import { Buffer } from 'node:buffer'

import { cleanDiagramSvg } from '@repo/browser-providers/render'
import {
  artifactRenderLimits,
  diagramErrorLine,
  normalizeDiagramFor,
  type ArtifactDiagramRenderRequest,
  type ArtifactDiagramRenderResponse,
} from '@repo/domain/artifacts'

import type { RenderPool } from './render-pool.ts'

// The diagrams of «Схема» (docs/plan/88-artifacts.md, §7.13, slice 88.24а; spike 7) and of the
// answers of the chat (docs/plan/91-chat-diagrams.md, Д2): the text normalised, drawn by Mermaid or
// PlantUML on the page of its workspace and engine in the render pool, cleaned for `<img>`, at most
// 512 KiB. Plain class: the stand loads it from its sources.

/** PlantUML counts the `@startuml` the platform added: the author's line is one less. */
function authorLine(line: number | null, added: number): number | null {
  if (line === null) return null
  return line - added > 0 ? line - added : null
}

export class DiagramService {
  readonly #pool: Pick<RenderPool, 'run'>

  constructor(pool: Pick<RenderPool, 'run'>) {
    this.#pool = pool
  }

  async render(request: ArtifactDiagramRenderRequest): Promise<ArtifactDiagramRenderResponse> {
    const engine = request.engine ?? 'mermaid'
    const source = normalizeDiagramFor(engine, request.source)
    const body = engine === 'plantuml' ? source.replace(/^\s*@(?:start|end)\w+.*$/gm, '') : source
    if (body.trim() === '')
      return { ok: false, reason: 'parse', line: null, message: 'The diagram is empty' }
    const added = engine === 'plantuml' && !/^\s*@start\w+/m.test(request.source) ? 1 : 0
    const raw = await this.#pool.run((renderer) =>
      renderer.diagram({ workspaceId: request.workspaceId, source, engine }),
    )
    if (!raw.ok)
      return {
        ok: false,
        reason: raw.reason,
        line: raw.reason === 'parse' ? authorLine(diagramErrorLine(raw.message), added) : null,
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
