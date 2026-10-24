import { Buffer } from 'node:buffer'
import type { IncomingMessage } from 'node:http'

import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import {
  badRequest,
  browserActionRequestSchema,
  browserCloseRequestSchema,
  browserEnsureRequestSchema,
  browserVerifyRequestSchema,
  type BrowserActionResponse,
  type BrowserListResponse,
  type BrowserSessionState,
  type BrowserVerifyResponse,
} from '@repo/domain'
import { z } from 'zod'

import { SessionManager } from '../sessions/session-manager.ts'
import { WorkerTokenGuard } from './worker-auth.guard.ts'

/** A body of the API is small: an action carries at most 10 000 characters of text. */
export const WORKER_BODY_MAX_BYTES = 64 * 1024

const sessionIdSchema = z.uuid()

/**
 * The JSON body of a call, read here (the app has no body parser): at most
 * `WORKER_BODY_MAX_BYTES`, JSON only. A bad one is 400 and a large one 413, without a word
 * of what it held.
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > WORKER_BODY_MAX_BYTES)
    throw new HttpException('Payload too large', HttpStatus.PAYLOAD_TOO_LARGE)
  const type = request.headers['content-type'] ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(type))
    throw new HttpException('Unsupported media type', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength
    if (bytes > WORKER_BODY_MAX_BYTES)
      throw new HttpException('Payload too large', HttpStatus.PAYLOAD_TOO_LARGE)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw badRequest('Invalid JSON body')
  }
}

/** The body as the contract has it; a field it does not know or a value out of bounds is 400. */
async function parsed<S extends z.ZodType>(
  request: IncomingMessage,
  schema: S,
): Promise<z.output<S>> {
  const result = schema.safeParse(await readJsonBody(request))
  if (!result.success) throw badRequest('Invalid browser worker request')
  return result.data
}

function sessionIdOf(value: string): string {
  const id = sessionIdSchema.safeParse(value)
  if (!id.success) throw badRequest('Invalid browser session id')
  return id.data.toLowerCase()
}

/**
 * The internal API of the worker (docs/plan/57-browser-tasks.md, §3.5) for core and mcp: HTTP
 * JSON behind the worker's token. Answers carry no cache; a refusal is `{ code }` with its status
 * (WorkerApiFilter).
 */
@Controller('v1/sessions')
@UseGuards(WorkerTokenGuard)
export class WorkerApiController {
  readonly #sessions: SessionManager

  constructor(@Inject(SessionManager) sessions: SessionManager) {
    this.#sessions = sessions
  }

  @Post('ensure')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async ensure(@Req() request: IncomingMessage): Promise<BrowserSessionState> {
    return this.#sessions.ensure(await parsed(request, browserEnsureRequestSchema))
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(): BrowserListResponse {
    return this.#sessions.list()
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async close(@Param('id') id: string, @Req() request: IncomingMessage) {
    const sessionId = sessionIdOf(id)
    const { reason } = await parsed(request, browserCloseRequestSchema)
    return this.#sessions.close(sessionId, reason)
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async verify(
    @Param('id') id: string,
    @Req() request: IncomingMessage,
  ): Promise<BrowserVerifyResponse> {
    const sessionId = sessionIdOf(id)
    await parsed(request, browserVerifyRequestSchema)
    return this.#sessions.verify(sessionId)
  }

  @Post(':id/actions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async actions(
    @Param('id') id: string,
    @Req() request: IncomingMessage,
  ): Promise<BrowserActionResponse> {
    const sessionId = sessionIdOf(id)
    const body = await parsed(request, browserActionRequestSchema)
    // A refusal is thrown with its fixed code and status (§3.7), so every failure is one shape.
    return { ok: true, result: await this.#sessions.act(sessionId, body) }
  }
}
