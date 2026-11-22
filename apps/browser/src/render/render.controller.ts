import type { IncomingMessage } from 'node:http'

import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { badRequest } from '@repo/domain'
import {
  artifactDiagramRenderRequestSchema,
  artifactRenderLimits,
  artifactRenderRequestSchema,
  type ArtifactDiagramRenderResponse,
  type ArtifactRenderResponse,
} from '@repo/domain/artifacts'

import { readJsonBody } from '../api/worker-api.controller.ts'
import { WorkerTokenGuard } from '../api/worker-auth.guard.ts'
import type { DiagramService } from './diagram-service.ts'
import type { RenderService } from './render-service.ts'
import { DIAGRAM_SERVICE, RENDER_SERVICE } from './render.tokens.ts'

/**
 * `POST /v1/render` (docs/plan/88-artifacts.md, Ар32, §7.12): a frame of an artifact drawn for mcp
 * (`artifact_layout`, `artifact_render`) and core (the thumbnails of a canvas), behind the worker's
 * token. A refusal is `{ code }` (WorkerApiFilter).
 */
@Controller('v1/render')
@UseGuards(WorkerTokenGuard)
export class RenderController {
  readonly #render: RenderService

  constructor(@Inject(RENDER_SERVICE) render: RenderService) {
    this.#render = render
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async render(@Req() request: IncomingMessage): Promise<ArtifactRenderResponse> {
    const body = artifactRenderRequestSchema.safeParse(await readJsonBody(request))
    if (!body.success) throw badRequest('Invalid render request')
    return this.#render.render(body.data)
  }
}

/** A diagram is 50 000 characters at most: up to 4 bytes each in JSON, and the rest of the body. */
const DIAGRAM_BODY_MAX_BYTES = artifactRenderLimits.diagramChars * 4 + 4096

/**
 * `POST /v1/diagram` (docs/plan/88-artifacts.md, §7.13, 88.24а): the Mermaid text of a block of
 * «Схема» drawn for core and mcp, behind the worker's token. A text that does not parse is an
 * answer (`ok: false` with its line), not a refusal.
 */
@Controller('v1/diagram')
@UseGuards(WorkerTokenGuard)
export class DiagramController {
  readonly #diagrams: DiagramService

  constructor(@Inject(DIAGRAM_SERVICE) diagrams: DiagramService) {
    this.#diagrams = diagrams
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async render(@Req() request: IncomingMessage): Promise<ArtifactDiagramRenderResponse> {
    const body = artifactDiagramRenderRequestSchema.safeParse(
      await readJsonBody(request, DIAGRAM_BODY_MAX_BYTES),
    )
    if (!body.success) throw badRequest('Invalid diagram request')
    return this.#diagrams.render(body.data)
  }
}
