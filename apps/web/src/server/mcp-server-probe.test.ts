import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { createMcpServerProbe } = await import('./mcp-server-probe')

const KEY = 'sk_live_0123456789'
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

/** A synthetic MCP server on loopback: answers by its mode, records every request. */
async function mcpServer(mode: 'keyed' | 'login' | 'stream' | 'html' | 'redirect') {
  const seen: { method?: string; headers: IncomingMessage['headers']; body: string }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      seen.push({ method: req.method, headers: req.headers, body })
      if (mode === 'redirect') return res.writeHead(302, { location: 'http://10.0.0.1/' }).end()
      if (mode === 'html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>')
      if (mode === 'login')
        return res
          .writeHead(401, {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
          })
          .end()
      if (req.headers['x-api-key'] !== KEY) return res.writeHead(401).end()
      if (req.method === 'DELETE') return res.writeHead(204).end()
      const message = JSON.parse(body) as { id?: number; method: string }
      if (message.id === undefined) return res.writeHead(202).end()
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'x', version: '1' },
            }
          : { tools: [{ name: 'get_menu' }, { name: 'update_price' }] }
      const json = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
      if (mode === 'stream')
        return res
          .writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1' })
          .end(`event: message\ndata: ${json}\n\n`)
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' }).end(json)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://mcp.example.com:${(server.address() as AddressInfo).port}/v1/mcp`, seen }
}

const probe = (options: { allowLoopback?: boolean; resolveTo?: string } = {}) =>
  createMcpServerProbe({
    refusedSubnets: [],
    allowLoopback: options.allowLoopback ?? true,
    resolve: async () => [{ address: options.resolveTo ?? '127.0.0.1', family: 4 }],
  })

const header = { name: 'X-Api-Key', value: KEY }

describe('createMcpServerProbe', () => {
  it('finds the tools of a server with the key, and ends its session', async () => {
    const { url, seen } = await mcpServer('keyed')
    expect(await probe()({ url, header })).toEqual({ ok: true, tools: 2 })
    expect(seen.map((entry) => entry.method)).toEqual(['POST', 'POST', 'POST', 'DELETE'])
    // The session the server named, and the protocol it agreed, go with each following request.
    expect(seen[2]!.headers).toMatchObject({
      'mcp-session-id': 's-1',
      'mcp-protocol-version': '2025-06-18',
    })
    expect(seen[0]!.headers.host).toMatch(/^mcp\.example\.com:\d+$/)
  })

  it('reads the answer of a stream as well', async () => {
    const { url } = await mcpServer('stream')
    expect(await probe()({ url, header })).toEqual({ ok: true, tools: 2 })
  })

  it('tells a wrong key from a server that wants a sign-in, and both from no server at all', async () => {
    const keyed = await mcpServer('keyed')
    expect(
      await probe()({ url: keyed.url, header: { name: 'X-Api-Key', value: 'wrong-key-123' } }),
    ).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    const login = await mcpServer('login')
    expect(await probe()({ url: login.url, header })).toEqual({ ok: false, reason: 'needs_login' })
    const html = await mcpServer('html')
    expect(await probe()({ url: html.url, header })).toEqual({ ok: false, reason: 'not_mcp' })
    const redirect = await mcpServer('redirect')
    expect(await probe()({ url: redirect.url, header })).toEqual({
      ok: false,
      reason: 'unreachable',
    })
    expect(redirect.seen).toHaveLength(1)
  })

  it('never connects where the address is not public', async () => {
    const { url, seen } = await mcpServer('keyed')
    expect(await probe({ resolveTo: '10.10.0.10' })({ url, header })).toEqual({
      ok: false,
      reason: 'address_refused',
    })
    expect(
      await probe({ allowLoopback: false })({ url: url.replace('http:', 'https:'), header }),
    ).toEqual({
      ok: false,
      reason: 'address_refused',
    })
    // Plain http is a test's, beside loopback alone.
    expect(await probe({ allowLoopback: false })({ url, header })).toEqual({
      ok: false,
      reason: 'unreachable',
    })
    expect(seen).toEqual([])
  })
})
