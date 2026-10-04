import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { readBodyWithin, withBodyLimit } from './body-limit'

const ENDPOINT = 'http://localhost:3000/api/anything'
const LIMIT = 1024

/** A body sent in chunks, without Content-Length; counts what the reader pulled. */
function chunkedRequest(chunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false }
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled === chunks) return controller.close()
        state.pulled += 1
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20))
      },
      cancel() {
        state.cancelled = true
      },
    }),
    duplex: 'half',
  } as RequestInit)
  return { request, state }
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

describe('readBodyWithin', () => {
  it('returns a body up to the limit, to the byte', async () => {
    const body = await readBodyWithin(post('x'.repeat(LIMIT)), LIMIT)
    expect(body?.byteLength).toBe(LIMIT)
    expect(await readBodyWithin(post('x'.repeat(LIMIT + 1)), LIMIT)).toBeNull()
  })

  it('counts bytes, not UTF-16 characters', async () => {
    // Cyrillic takes two bytes a letter: under the limit in characters, over it in bytes.
    const text = 'я'.repeat(LIMIT / 2 + 1)
    expect(text.length).toBeLessThan(LIMIT)
    expect(await readBodyWithin(post(text), LIMIT)).toBeNull()
  })

  it('refuses a declared oversize body without reading it', async () => {
    const request = post('{}', { 'content-length': String(LIMIT + 1) })
    expect(await readBodyWithin(request, LIMIT)).toBeNull()
    expect(request.bodyUsed).toBe(false)
  })

  it('stops reading a body without Content-Length as soon as it passes the limit', async () => {
    // Endless for the purpose: reading it whole would take 64 MiB.
    const { request, state } = chunkedRequest(1024, 64 * 1024)
    expect(request.headers.get('content-length')).toBeNull()
    expect(await readBodyWithin(request, LIMIT)).toBeNull()
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeLessThanOrEqual(3)
  })

  it('joins a body that arrives in several chunks', async () => {
    const { request } = chunkedRequest(4, 100)
    expect((await readBodyWithin(request, LIMIT))?.byteLength).toBe(400)
  })

  it('reads a request without a body as empty', async () => {
    const body = await readBodyWithin(new Request(ENDPOINT, { method: 'POST' }), LIMIT)
    expect(body?.byteLength).toBe(0)
  })
})

describe('withBodyLimit', () => {
  it('hands the handler the same request with its body already read', async () => {
    const handler = vi.fn(async (request: Request) => Response.json(await request.json()))
    const controller = new AbortController()
    const original = new Request(`${ENDPOINT}?x=1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: 'session=abc', origin: 'http://x' },
      body: JSON.stringify({ name: 'Анна' }),
      signal: controller.signal,
    })

    const response = await withBodyLimit(LIMIT, handler)(original)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'Анна' })
    const [passed] = handler.mock.calls[0]!
    expect(passed.url).toBe(`${ENDPOINT}?x=1`)
    expect(passed.method).toBe('PUT')
    expect(Object.fromEntries(passed.headers)).toEqual(Object.fromEntries(original.headers))
    // A client that goes away still aborts the handler's work.
    controller.abort()
    expect(passed.signal.aborted).toBe(true)
  })

  it('passes a request without a body through untouched', async () => {
    const handler = vi.fn(async () => new Response('ok'))
    const request = new Request(ENDPOINT)
    await withBodyLimit(LIMIT, handler)(request)
    expect(handler).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('answers 413 in Russian without calling the handler', async () => {
    const handler = vi.fn(async () => new Response('ok'))
    const limited = withBodyLimit(LIMIT, handler)
    const declared = post('{}', { 'content-length': String(LIMIT + 1) })
    const { request: streamed, state } = chunkedRequest(1024, 64 * 1024)

    for (const request of [declared, streamed]) {
      const response = await limited(request)
      expect(response.status).toBe(413)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ message: 'Запрос слишком большой.' })
    }
    expect(declared.bodyUsed).toBe(false)
    expect(state.cancelled).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers 400 without calling the handler when the body breaks off', async () => {
    // A client that went away mid-upload: the read fails, there is nothing to hand on.
    const handler = vi.fn(async () => new Response('ok'))
    let sent = false
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.error(new Error('aborted'))
          sent = true
          controller.enqueue(new TextEncoder().encode('{"name":"Ан'))
        },
      }),
      duplex: 'half',
    } as RequestInit)

    const response = await withBodyLimit(LIMIT, handler)(request)

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      message: 'Не удалось прочитать запрос. Попробуйте ещё раз.',
    })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('API routes', () => {
  // How each route that can receive a body keeps it within a limit. A new route with such a
  // method fails here until its limit is recorded.
  const limited: Record<string, RegExp> = {
    'auth/[...all]': /withBodyLimit\(MAX_AUTH_BODY_BYTES,/,
    'trpc/[trpc]': /withBodyLimit\(MAX_TRPC_BODY_BYTES,/,
    // avatar.ts reads the file after the session, the origin and the upload limit: 5 MiB.
    'profile/avatar': /uploadAvatar\(request, avatarDependencies\)/,
    'webhooks/yookassa': /handleYookassaWebhook\(request,/,
  }

  // Every way a route file exports a method that carries a body.
  const methods = '(?:POST|PUT|PATCH|DELETE)'
  const exportsBodyMethod = new RegExp(
    [
      `export\\s+(?:async\\s+)?function\\s+${methods}\\b`,
      `export\\s+(?:const|let|var)\\s+${methods}\\b`,
      // A list in braces, on however many lines the formatter puts it.
      `export\\s*(?:(?:const|let|var)\\s*)?\\{[^}]*\\b${methods}\\b`,
    ].join('|'),
  )

  it('recognise every form of exporting such a method', () => {
    for (const source of [
      'export async function POST() {}',
      'export function DELETE() {}',
      'export const PUT = handler',
      'export { handler as GET, handler as POST }',
      'export {\n  handler as GET,\n  handler as PATCH,\n}',
      'export const { GET, POST } = handlers',
    ])
      expect(source).toMatch(exportsBodyMethod)
    for (const source of [
      'export function GET() {}',
      'export { handler as GET, handler as HEAD }',
      '// POST is not served here\nexport const GET = handler',
      'export const dynamic = "force-dynamic" // no DELETE',
    ])
      expect(source).not.toMatch(exportsBodyMethod)
  })

  it('limit the body of every method that carries one', () => {
    const api = fileURLToPath(new URL('../app/api', import.meta.url))
    const routes = readdirSync(api, { recursive: true, encoding: 'utf8' })
      .filter((file) => /(^|[\\/])route\.ts$/.test(file))
      .map((file) => ({
        name: relative(api, dirname(join(api, file))).replaceAll('\\', '/'),
        source: readFileSync(join(api, file), 'utf8'),
      }))
    expect(routes.length).toBeGreaterThanOrEqual(Object.keys(limited).length)

    const withBody = routes.filter(({ source }) => exportsBodyMethod.test(source))
    expect(withBody.map((route) => route.name).sort()).toEqual(Object.keys(limited).sort())
    for (const route of withBody) expect(route.source, route.name).toMatch(limited[route.name]!)
  })
})
