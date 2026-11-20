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
import { artifactRenderRequestSchema, type ArtifactRenderResponse } from '@repo/domain/artifacts'

import { readJsonBody } from '../api/worker-api.controller.ts'
import { WorkerTokenGuard } from '../api/worker-auth.guard.ts'
import type { RenderService } from './render-service.ts'
import { RENDER_SERVICE } from './render.tokens.ts'

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
