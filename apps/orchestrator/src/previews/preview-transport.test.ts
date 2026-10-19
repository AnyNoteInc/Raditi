import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { previewRequest, previewSiteTransport } from './preview-transport.ts'

const hostname = 'site-0f3a9c1b-chat-a1b2c3.localhost'

describe('requests of core to a preview', () => {
  let server: Server
  let port = 0
  const seen: Array<{ host?: string; url?: string; connection?: string; body: string }> = []
  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => (body += chunk.toString()))
      request.on('end', () => {
        seen.push({
          host: request.headers.host,
          url: request.url,
          connection: request.headers.connection,
          body,
        })
        if (request.url === '/large') response.end('x'.repeat(4096))
        else response.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('go to the upstream with the preview as the Host, never to the address named', async () => {
    const transport = previewSiteTransport({ upstream: { host: '127.0.0.1', port }, hostname })
    const answer = await transport({
      method: 'POST',
      url: 'http://203.0.113.9:81/wp-json/raditi/v1/write?x=1',
      headers: {
        host: 'evil.example',
        authorization: 'Basic a',
        'content-type': 'application/json',
      },
      body: '{"a":1}',
      timeoutMs: 5000,
      maxResponseBytes: 1024,
    })
    expect(answer.status).toBe(200)
    expect(seen.at(-1)).toEqual({
      host: hostname,
      url: '/wp-json/raditi/v1/write?x=1',
      connection: 'close',
      body: '{"a":1}',
    })
  })

  it('refuse an address that is not a path and an answer above the limit', async () => {
    const target = { upstream: { host: '127.0.0.1', port }, hostname }
    await expect(
      previewRequest(target, {
        method: 'GET',
        path: '//evil.example/',
        timeoutMs: 1000,
        maxResponseBytes: 10,
      }),
    ).rejects.toThrow()
    await expect(
      previewRequest(target, {
        method: 'GET',
        path: '/large',
        timeoutMs: 5000,
        maxResponseBytes: 100,
      }),
    ).rejects.toThrow('Preview response exceeds its limit')
  })
})
