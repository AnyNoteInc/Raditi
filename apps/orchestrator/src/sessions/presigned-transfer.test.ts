import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { PresignedRequest } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fetchPresignedTransfer } from './presigned-transfer.ts'

const objects = new Map<string, Buffer>()
const seen: { method: string; headers: IncomingMessage['headers'] }[] = []
let origin = ''

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    seen.push({ method: request.method!, headers: request.headers })
    const key = new URL(request.url!, origin).pathname
    if (key === '/redirect') {
      response.writeHead(307, { location: `${origin}/object` }).end()
    } else if (request.method === 'GET') {
      const body = objects.get(key)
      if (body) response.writeHead(200).end(body)
      else response.writeHead(403).end('<Error>signature details</Error>')
    } else if (request.method === 'PUT') {
      if (request.headers['if-none-match'] === '*' && objects.has(key))
        response.writeHead(412).end()
      else {
        objects.set(key, Buffer.concat(chunks))
        response.writeHead(200).end()
      }
    } else response.writeHead(405).end()
  })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const signed = (method: 'GET' | 'PUT', path: string): PresignedRequest => ({
  method,
  url: `${origin}${path}?X-Amz-Signature=synthetic-signature`,
  headers: method === 'PUT' ? { 'if-none-match': '*' } : {},
  expiresAt: new Date(Date.now() + 60_000),
})

describe('presigned transfer', () => {
  const transfer = fetchPresignedTransfer({ timeoutMs: 5_000 })

  it('stores once with the signed headers and reads the object back', async () => {
    await transfer.put(signed('PUT', '/home'), Buffer.from('sealed home'))
    expect(seen.at(-1)?.headers).toMatchObject({ 'if-none-match': '*', 'content-length': '11' })
    await expect(
      transfer.put(signed('PUT', '/home'), Buffer.from('other bytes')),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(Buffer.from(await transfer.get(signed('GET', '/home'), 11))).toEqual(
      Buffer.from('sealed home'),
    )
  })

  it('refuses an object beyond the expected size', async () => {
    objects.set('/large', Buffer.alloc(1024))
    await expect(transfer.get(signed('GET', '/large'), 1023)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it.each([
    ['an error answer', '/missing'],
    ['a redirect', '/redirect'],
  ])('fails on %s without the URL or the answer in the error', async (_, path) => {
    const error: unknown = await transfer.get(signed('GET', path), 1024).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'PRESIGNED_REQUEST_FAILED', httpStatus: 502 })
    expect(JSON.stringify(error) + String(error)).not.toMatch(
      /synthetic-signature|signature details/,
    )
  })

  it('never sends a PUT that could overwrite an object', async () => {
    const requests = seen.length
    await expect(
      transfer.put({ ...signed('PUT', '/home'), headers: {} }, Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      transfer.get({ ...signed('GET', '/home'), method: 'PUT' }, 10),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(seen).toHaveLength(requests)
  })
})
