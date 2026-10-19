import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { HostLookup } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPinnedSiteTransport } from './site-http.ts'

// The transport the deploy job checks a site with (plan 53, Р30): one request to one pinned
// literal, no redirect followed, the answer bounded. A local server on loopback stands for the
// site; loopback is an address the rule allows only outside production.

let server: Server
let port = 0
const seen: { host?: string; path?: string }[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ host: request.headers.host, path: request.url })
    if (request.url === '/moved') {
      response.writeHead(302, { location: 'https://elsewhere.example/' })
      response.end()
      return
    }
    if (request.url === '/large') {
      response.end('x'.repeat(2048))
      return
    }
    response.end('<html>Магазин</html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A lookup that answers a name with loopback, and counts how often it is asked. */
function lookupTo(address: string) {
  const asked: string[] = []
  const lookup: HostLookup = async (name) => {
    asked.push(name)
    return [{ address, family: 4 }]
  }
  return { asked, lookup }
}

const request = (url: string, maxResponseBytes = 1024) => ({
  url,
  method: 'GET' as const,
  headers: { accept: 'text/html' },
  timeoutMs: 5_000,
  maxResponseBytes,
})

describe('the pinned transport to a site', () => {
  it('dials the address the name resolved to and keeps the name as Host', async () => {
    const { asked, lookup } = lookupTo('127.0.0.1')
    const transport = createPinnedSiteTransport({ lookup, appEnv: 'development' })
    const answer = await transport(request(`http://shop.example.ru:${port}/`))
    expect(answer.status).toBe(200)
    expect(Buffer.from(answer.body).toString()).toBe('<html>Магазин</html>')
    expect(asked).toEqual(['shop.example.ru'])
    expect(seen.at(-1)).toEqual({ host: `shop.example.ru:${port}`, path: '/' })
  })

  it('returns a redirect as it is and follows nothing', async () => {
    const transport = createPinnedSiteTransport({
      lookup: lookupTo('127.0.0.1').lookup,
      appEnv: 'development',
    })
    const answer = await transport(request(`http://127.0.0.1:${port}/moved`))
    expect(answer.status).toBe(302)
    // The Location comes back for the caller to decide; nothing went there.
    expect(answer.location).toBe('https://elsewhere.example/')
    const plain = await transport(request(`http://127.0.0.1:${port}/`))
    expect(plain.location).toBeUndefined()
  })

  it('refuses an address the rule does not allow, before any connection', async () => {
    const count = seen.length
    const production = createPinnedSiteTransport({
      lookup: lookupTo('127.0.0.1').lookup,
      appEnv: 'production',
    })
    await expect(production(request(`http://127.0.0.1:${port}/`))).rejects.toThrow(
      'Site address refused',
    )
    // A public name that resolves to loopback is refused too.
    await expect(production(request(`https://shop.example.ru:${port}/`))).rejects.toThrow()
    expect(seen.length).toBe(count)
  })

  it('refuses credentials in the address, another scheme and a large answer', async () => {
    const transport = createPinnedSiteTransport({
      lookup: lookupTo('127.0.0.1').lookup,
      appEnv: 'development',
    })
    await expect(transport(request(`http://u:p@127.0.0.1:${port}/`))).rejects.toThrow(
      'Site request refused',
    )
    await expect(transport(request(`ftp://127.0.0.1:${port}/`))).rejects.toThrow(
      'Site request refused',
    )
    await expect(transport(request(`http://127.0.0.1:${port}/large`, 1024))).rejects.toThrow(
      'Site request failed',
    )
  })
})
