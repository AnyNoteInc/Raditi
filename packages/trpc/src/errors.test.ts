import {
  badRequest,
  conflict,
  DomainError,
  forbidden,
  notFound,
  notImplemented,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  clientMessage,
  formatError,
  INTERNAL_ERROR_MESSAGE,
  INVALID_INPUT_MESSAGE,
  mapDomain,
  trpcCodeForStatus,
} from './errors.ts'
import { createCallerFactory, publicProcedure, router, type Context } from './trpc.ts'

describe('mapDomain', () => {
  it.each([
    [notFound('Site not found'), 'NOT_FOUND', 'Не нашли то, что вы ищете'],
    [forbidden('Not the owner'), 'FORBIDDEN', 'Недостаточно прав'],
    [conflict('Task is running'), 'CONFLICT', 'Действие сейчас недоступно'],
    [notImplemented('Bitrix'), 'NOT_IMPLEMENTED', 'Эта возможность ещё в разработке'],
    [badRequest('Bad site URL'), 'BAD_REQUEST', INVALID_INPUT_MESSAGE],
    [
      new DomainError('QUOTA_EXCEEDED', 'Quota exceeded', 402),
      'PAYMENT_REQUIRED',
      'Для этого действия нужна оплата',
    ],
    [new DomainError('TEAPOT', 'Teapot', 418), 'BAD_REQUEST', INVALID_INPUT_MESSAGE],
    [new DomainError('BROKEN', 'Broken', 599), 'INTERNAL_SERVER_ERROR', INTERNAL_ERROR_MESSAGE],
  ])('maps %s to %s with a Russian message', async (domainError, code, message) => {
    const error = await mapDomain(async () => {
      throw domainError
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({ code, message, cause: domainError })
  })

  it('passes results and other errors through', async () => {
    await expect(mapDomain(async () => 42)).resolves.toBe(42)
    const other = new Error('boom')
    await expect(
      mapDomain(async () => {
        throw other
      }),
    ).rejects.toBe(other)
  })

  it('falls back by status class', () => {
    expect(trpcCodeForStatus(451)).toBe('BAD_REQUEST')
    expect(trpcCodeForStatus(507)).toBe('INTERNAL_SERVER_ERROR')
  })
})

describe('domain errors in procedures', () => {
  const testRouter = router({
    missing: publicProcedure.query(() => {
      throw notFound('Site not found')
    }),
    wrapped: publicProcedure.query(() =>
      mapDomain(async () => {
        throw conflict('Task is running')
      }),
    ),
    crash: publicProcedure.query(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
    }),
  })
  const ctx = { headers: new Headers(), session: null, user: null } as unknown as Context
  const caller = createCallerFactory(testRouter)(ctx)

  it('get the matching code without mapDomain', async () => {
    await expect(caller.missing()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Не нашли то, что вы ищете',
    })
  })

  it('keep the code set by mapDomain', async () => {
    await expect(caller.wrapped()).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('leave other failures internal', async () => {
    await expect(caller.crash()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})

describe('formatError', () => {
  const shape = (code: string, httpStatus: number, message: string) => ({
    message,
    code: -32000,
    data: { code, httpStatus, path: 'site.get', stack: 'Error: at secret.ts:1' },
  })

  it('shows the Russian text of the domain code, never the domain message or the stack', () => {
    const cause = notImplemented('Bitrix adapter')
    const error = new TRPCError({ code: 'NOT_IMPLEMENTED', message: cause.message, cause })

    const formatted = formatError(shape('NOT_IMPLEMENTED', 501, cause.message), error, false)

    expect(formatted.message).toBe('Эта возможность ещё в разработке')
    expect(formatted.data).toEqual({
      code: 'NOT_IMPLEMENTED',
      httpStatus: 501,
      path: 'site.get',
      domainCode: 'NOT_IMPLEMENTED',
    })
  })

  it('falls back to the text of the tRPC code for an unlisted domain code', () => {
    const cause = new DomainError('QUOTA_EXCEEDED', 'Daily quota exceeded', 402)
    const error = new TRPCError({ code: 'PAYMENT_REQUIRED', cause })

    const formatted = formatError(shape('PAYMENT_REQUIRED', 402, cause.message), error, false)

    expect(formatted.message).toBe('Для этого действия нужна оплата')
    expect(formatted.data.domainCode).toBe('QUOTA_EXCEEDED')
  })

  it('hides the text of unexpected errors outside dev', () => {
    const error = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      cause: new Error('password=hunter2'),
    })
    const formatted = formatError(
      shape('INTERNAL_SERVER_ERROR', 500, 'password=hunter2'),
      error,
      false,
    )

    expect(formatted.message).toBe(INTERNAL_ERROR_MESSAGE)
    expect(formatted.data).not.toHaveProperty('stack')
    expect(formatted.data).not.toHaveProperty('details')
    expect(formatted.data.domainCode).toBeNull()
  })

  it('replaces zod messages with a generic text and keeps the issues for dev only', () => {
    const zodError = z.object({ url: z.url() }).safeParse({ url: 'nope' }).error
    const error = new TRPCError({ code: 'BAD_REQUEST', cause: zodError })

    const prod = formatError(shape('BAD_REQUEST', 400, error.message), error, false)
    expect(prod.message).toBe(INVALID_INPUT_MESSAGE)
    expect(prod.data).not.toHaveProperty('details')

    const dev = formatError(shape('BAD_REQUEST', 400, error.message), error, true)
    expect(dev.message).toBe(INVALID_INPUT_MESSAGE)
    expect(dev.data.details?.message).toBe(error.message)
    expect(dev.data.details?.issues).toEqual(zodError?.issues)
  })

  it('replaces the English messages of tRPC itself', () => {
    const error = new TRPCError({ code: 'NOT_FOUND', message: 'No procedure found on path "x"' })
    expect(clientMessage(error)).toBe('Не нашли то, что вы ищете')
  })

  it('keeps the Russian text and adds the details for the developer in dev', () => {
    const cause = notFound('Site 42 not found')
    const error = new TRPCError({ code: 'NOT_FOUND', cause })
    const formatted = formatError(shape('NOT_FOUND', 404, 'Site 42 not found'), error, true)

    expect(formatted.message).toBe('Не нашли то, что вы ищете')
    expect(formatted.data.details).toEqual({ message: 'Site 42 not found' })
    expect(formatted.data.stack).toBe('Error: at secret.ts:1')
  })
})

describe('errors over HTTP', () => {
  const testRouter = router({
    missing: publicProcedure.query(() => {
      throw notFound('Site 42 not found')
    }),
    echo: publicProcedure.input(z.object({ url: z.url() })).query(({ input }) => input.url),
  })
  const ctx = { headers: new Headers(), session: null, user: null } as unknown as Context
  const call = (path: string) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request(`http://localhost:3000/api/trpc/${path}`),
      router: testRouter,
      createContext: () => ctx,
    })
  const errorOf = async (response: Response) =>
    ((await response.json()) as { error: { json: { message: string; data: object } } }).error.json

  it.each([
    ['a domain error', 'missing', 404, 'Не нашли то, что вы ищете', 'Site 42'],
    [
      'invalid input',
      `echo?input=${encodeURIComponent(JSON.stringify({ json: { url: 'nope' } }))}`,
      400,
      INVALID_INPUT_MESSAGE,
      'Invalid URL',
    ],
    ['an unknown procedure', 'nothing.here', 404, 'Не нашли то, что вы ищете', 'No procedure'],
  ])('answer %s in Russian only', async (_case, path, status, message, raw) => {
    const response = await call(path)

    expect(response.status).toBe(status)
    const body = await errorOf(response)
    expect(body.message).toBe(message)
    expect(JSON.stringify(body)).not.toContain(raw)
  })
})
