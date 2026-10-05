import type { ArgumentsHost } from '@nestjs/common'
import { HttpException, Logger } from '@nestjs/common'
import { DomainError } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpHttpExceptionFilter, mcpErrorSummary } from './mcp-http-error.ts'

const token = `mcp_${'a'.repeat(64)}`

function exchange(method = 'POST') {
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  }
  res.status.mockReturnValue(res)
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ path: '/mcp', method, body: { jsonrpc: '2.0', id: 7 } }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost
  return { res, host }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('McpHttpExceptionFilter', () => {
  it('logs an unexpected failure once per window by class and code, never by its message', () => {
    const lines: string[] = []
    vi.spyOn(Logger.prototype, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    const filter = new McpHttpExceptionFilter()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { res, host } = exchange()
      filter.catch(Object.assign(new Error(`private ${token}`), { code: 'ECONNRESET' }), host)
      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32000, message: 'MCP request failed' },
      })
    }
    expect(lines).toEqual(['MCP request failed: Error ECONNRESET'])
  })

  it('does not log client errors that anyone can trigger', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const filter = new McpHttpExceptionFilter()
    const { res, host } = exchange('PUT')
    filter.catch(new HttpException(`Cannot PUT /mcp ${token}`, 404), host)
    expect(res.status).toHaveBeenCalledWith(405)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('mcpErrorSummary', () => {
  it('keeps only names, codes, SQLSTATE, kind and a missing schema identifier', () => {
    const prisma = (cause: Record<string, unknown>) =>
      Object.assign(new Error(`Raw query failed ${token}`), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2010',
        meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
      })
    expect(
      mcpErrorSummary(
        prisma({
          kind: 'ColumnNotFound',
          column: 't.content_retired_at',
          originalCode: '42703',
          originalMessage: `column ${token}`,
        }),
      ),
    ).toBe('PrismaClientKnownRequestError P2010 42703 ColumnNotFound t.content_retired_at')
    expect(
      mcpErrorSummary(
        prisma({
          kind: 'postgres',
          code: '22P02',
          originalCode: '22P02',
          message: `invalid input syntax "${token}"`,
          detail: token,
          column: token,
        }),
      ),
    ).toBe('PrismaClientKnownRequestError P2010 22P02 postgres')
    expect(
      mcpErrorSummary(new DomainError('MCP_ACCESS_SCOPE_INVALID', `private ${token}`, 503)),
    ).toBe('DomainError MCP_ACCESS_SCOPE_INVALID')
    expect(
      mcpErrorSummary(Object.assign(new Error(token), { name: `Bad ${token}`, code: token })),
    ).toBe('unnamed error')
    expect(mcpErrorSummary(token)).toBe('non-error string')
    expect(mcpErrorSummary(null)).toBe('non-error object')
  })
})
