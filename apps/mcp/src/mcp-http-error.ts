import { Catch, HttpException, Logger, type ArgumentsHost } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { throttledLogger } from '@repo/observability'
import type { Request, Response } from 'express'

import { mcpErrorId } from './mcp-policy.ts'

/** Only deliberately constructed, content-free errors may pass through unchanged. */
export class McpHttpError extends HttpException {
  constructor(status: number, id: string | number | null, message: string) {
    super({ jsonrpc: '2.0', id, error: { code: -32000, message } }, status)
  }
}

@Catch()
export class McpHttpExceptionFilter extends BaseExceptionFilter {
  readonly #logger = new Logger('McpHttp')
  readonly #fail = throttledLogger((line) => this.#logger.error(line))

  override catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const req = http.getRequest<Request>()
    // Express also routes /mcp/ and /MCP here; their parser errors must stay content-free.
    if (!/^\/mcp\/*$/i.test(req.path)) return super.catch(error, host)
    const res = http.getResponse<Response>()
    if (res.headersSent) return
    res.setHeader('Cache-Control', 'no-store')
    if (error instanceof McpHttpError) {
      res.status(error.getStatus()).json(error.getResponse())
      return
    }
    const rawStatus =
      error instanceof HttpException
        ? error.getStatus()
        : (error as { status?: unknown } | null)?.status
    // A client error stays a client error (MCP clients retry 5xx); its text is always fixed.
    const clientError =
      typeof rawStatus === 'number' &&
      Number.isInteger(rawStatus) &&
      rawStatus >= 400 &&
      rawStatus < 500
    let status = clientError ? rawStatus : 500
    if (status === 404 && !mcpMethods.includes(req.method)) {
      status = 405
      res.setHeader('Allow', mcpMethods.join(', '))
    }
    const message =
      clientMessages[status] ?? (clientError ? 'Invalid MCP request' : 'MCP request failed')
    // Only a server-side failure is logged: client errors are anyone's to trigger.
    if (!clientError) this.#fail('MCP request failed', mcpErrorSummary(error))
    res
      .status(status)
      .json({ jsonrpc: '2.0', id: mcpErrorId(req.body), error: { code: -32000, message } })
  }
}

const errorName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const errorCode = /^[A-Za-z0-9_.-]{1,64}$/
const sqlIdentifier = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/

/**
 * The class and codes of an error for the operator's log, never its message: driver and SDK
 * messages may carry request input. A PrismaPg failure adds its SQLSTATE and kind, and for a
 * missing table or column (a migration not applied) the identifier from our own query.
 */
export function mcpErrorSummary(error: unknown): string {
  if (typeof error !== 'object' || error === null) return `non-error ${typeof error}`
  const source = error as {
    name?: unknown
    code?: unknown
    meta?: { driverAdapterError?: { cause?: Record<string, unknown> } }
  }
  const cause = source.meta?.driverAdapterError?.cause
  const parts = [
    [source.name, errorName],
    [source.code, errorCode],
    [cause?.originalCode, errorCode],
    [cause?.kind, errorName],
    [cause?.kind === 'ColumnNotFound' ? cause.column : undefined, sqlIdentifier],
    [cause?.kind === 'TableDoesNotExist' ? cause.table : undefined, sqlIdentifier],
  ] as const
  const summary = parts
    .filter(([value, pattern]) => typeof value === 'string' && pattern.test(value))
    .map(([value]) => value)
    .join(' ')
  return summary || 'unnamed error'
}

/** The verbs McpHttpController serves; Nest answers any other one with its 404. */
const mcpMethods = ['GET', 'POST', 'DELETE']
const clientMessages: Record<number, string> = {
  404: 'MCP route is not found',
  405: 'MCP method is not allowed',
  413: 'MCP request is too large',
  415: 'Unsupported MCP request encoding',
}
