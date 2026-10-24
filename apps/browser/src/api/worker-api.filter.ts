import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { isDomainError } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import type { Request, Response } from 'express'

import { errorName } from '../common/browser-codes.ts'

/** The code of a refusal the HTTP layer made itself (no route, no token, a bad body). */
const CODE_OF_STATUS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
}

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * Errors of the worker's API (`/v1/…`, §3.5) as `{ code }` with the code's status — the fixed codes
 * of the tools (§3.7) keep theirs — and nothing else: no message, no path, no field. A failure
 * of the worker itself is 500 `INTERNAL`, logged by name. /health and /metrics keep Nest's own.
 */
@Catch()
export class WorkerApiFilter extends BaseExceptionFilter {
  readonly #logger = new Logger('BrowserWorkerApi')
  readonly #fail = throttledLogger((line) => this.#logger.error(line))

  override catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<Request>()
    if (!/^\/v1(?:\/|$)/.test(request.path)) return super.catch(error, host)
    const response = http.getResponse<Response>()
    if (response.headersSent) return
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR
    let code = 'INTERNAL'
    if (isDomainError(error) && CODE.test(error.code)) {
      status = error.httpStatus
      code = error.code
    } else if (error instanceof HttpException && CODE_OF_STATUS[error.getStatus()]) {
      status = error.getStatus()
      code = CODE_OF_STATUS[status] ?? code
    }
    if (status >= 500 && !isDomainError(error))
      this.#fail('browser worker request failed', errorName(error))
    response.setHeader('Cache-Control', 'no-store')
    response.status(status).json({ code })
  }
}
