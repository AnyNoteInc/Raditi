import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createPoolProbeClient, poolControlOrigin } from './pool-probe-client.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

describe('private pool snapshot control client', () => {
  it.each([
    'http://10.1.2.3:8084',
    'https://192.168.1.2',
    'http://[fd00::1]:8084',
    'http://[::1]:8084',
    'http://127.0.0.1:8084',
  ])('accepts private/loopback origin %s', (origin) => {
    expect(poolControlOrigin(origin)).toBe(origin)
  })
  it('uses a literal loopback address for localhost without a DNS lookup', () => {
    expect(poolControlOrigin('http://localhost:8084')).toBe('http://127.0.0.1:8084')
  })
  it.each([
    'http://example.com',
    'https://8.8.8.8',
    'http://100.64.1.1',
    'http://169.254.169.254',
    'http://10.0.0.1/path',
    'http://secret:password@10.0.0.1',
    'http://10.0.0.1?private=secret',
    'http://10.0.0.1/#secret',
    'ftp://10.0.0.1',
    'http://[::ffff:8.8.8.8]',
    'invalid-secret',
  ])('rejects unsafe control address %s without revealing it', (origin) => {
    expect(() => poolControlOrigin(origin)).toThrow('Subscription pool probe unavailable')
  })
  it('sends only unique account ids in batches of ten to the exact control route', async () => {
    const seen: { method?: string; path?: string; authorization?: string; body: unknown }[] = []
    const origin = await fixture((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        seen.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(body),
        })
        response.writeHead(204)
        response.end()
      })
    })
    const ids = Array.from({ length: 23 }, () => randomUUID())
    await createPoolProbeClient(origin, 'synthetic-control-token')([...ids, ids[0]!])
    expect(seen).toEqual(
      [0, 10, 20].map((index) => ({
        method: 'POST',
        path: '/internal/subscriptions/probe',
        authorization: 'Bearer synthetic-control-token',
        body: { accountIds: ids.slice(index, index + 10) },
      })),
    )
  })
  it.each([200, 301, 302, 401, 503])(
    'accepts only empty 204 and refuses status %s without redirects',
    async (status) => {
      let requests = 0
      const origin = await fixture((request, response) => {
        requests += 1
        request.resume()
        response.writeHead(status, { location: '/alternate' })
        response.end('private provider response')
      })
      await expect(
        createPoolProbeClient(origin, 'synthetic-control-token')([randomUUID()]),
      ).rejects.toThrow('Subscription pool probe unavailable')
      expect(requests).toBe(1)
    },
  )
  it('bounds a stalled response and closes its socket', async () => {
    let closed!: () => void
    const stopped = new Promise<void>((resolve) => {
      closed = resolve
    })
    const origin = await fixture((request) => {
      request.resume()
      request.socket.once('close', closed)
    })
    await expect(
      createPoolProbeClient(origin, 'synthetic-control-token', { timeoutMs: 100 })([randomUUID()]),
    ).rejects.toThrow('Subscription pool probe unavailable')
    await stopped
  })
  it('skips empty lists and rejects invalid identifiers or header tokens before transport', async () => {
    const client = createPoolProbeClient('http://127.0.0.1:1', 'synthetic-control-token')
    await client([])
    await expect(client(['private-account-not-a-uuid'])).rejects.toThrow(
      'Subscription pool probe unavailable',
    )
    for (const token of ['', 'secret\r\nheader: value', 'secret with spaces'])
      expect(() => createPoolProbeClient('http://127.0.0.1:1', token)).toThrow(
        'Subscription pool probe unavailable',
      )
  })
})
