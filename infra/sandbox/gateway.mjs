/* global AbortController, Buffer, URL, clearTimeout, console, process, setTimeout */
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { writeFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// No dynamic target selection, redirects, CONNECT, upgrades or arbitrary forwarded headers.
export function createGateway({ listenHost, clientIp, routes, llmUpstream, mcpUpstream }) {
  if (isIP(listenHost) !== 4 || isIP(clientIp) !== 4) throw new Error('Invalid gateway address')
  const targets = new Map()
  const target = (base, path) => {
    const url = new URL(base)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid gateway target')
    if (url.pathname !== '/' && url.pathname !== '')
      throw new Error('Gateway target must be an origin')
    return new URL(path, url)
  }
  if (routes.includes('llm')) {
    for (const path of ['/v1/responses', '/v1/chat/completions'])
      targets.set(path, { url: target(llmUpstream, path), methods: ['POST'] })
  }
  if (routes.includes('mcp'))
    targets.set('/mcp', { url: target(mcpUpstream, '/mcp'), methods: ['GET', 'POST', 'DELETE'] })
  let active = 0
  const server = createServer(async (req, res) => {
    const route = targets.get(req.url)
    if (
      req.socket.remoteAddress !== clientIp ||
      !['sandbox-gw', 'sandbox-gw:8080'].includes(req.headers.host ?? '') ||
      !route ||
      !route.methods.includes(req.method) ||
      active >= 8
    ) {
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
      res.end('Request is not allowed\n')
      return
    }
    active += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20 * 60 * 1000)
    const headers = { host: route.url.host }
    for (const name of [
      'authorization',
      'content-type',
      'accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'last-event-id',
    ])
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
    const abort = () => controller.abort()
    req.on('aborted', abort)
    res.on('close', abort)
    try {
      const request = route.url.protocol === 'https:' ? httpsRequest : httpRequest
      await new Promise((resolve, reject) => {
        const upstream = request(
          route.url,
          { method: req.method, headers, signal: controller.signal },
          async (response) => {
            if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
              response.destroy()
              reject(new Error('Upstream redirects are not allowed'))
              return
            }
            const outputHeaders = {}
            for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version'])
              if (typeof response.headers[name] === 'string')
                outputHeaders[name] = response.headers[name]
            res.writeHead(response.statusCode ?? 502, outputHeaders)
            try {
              await pipeline(response, limit(64 * 1024 * 1024), res)
              resolve()
            } catch (error) {
              reject(error)
            }
          },
        )
        upstream.on('error', reject)
        void pipeline(req, limit(16 * 1024 * 1024), upstream).catch(reject)
      })
    } catch {
      controller.abort()
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Gateway request failed\n')
      } else res.destroy()
    } finally {
      active -= 1
      clearTimeout(timer)
      req.removeListener('aborted', abort)
      res.removeListener('close', abort)
    }
  })
  server.on('connect', (_req, socket) => socket.destroy())
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  server.headersTimeout = 10_000
  server.requestTimeout = 60_000
  server.maxHeadersCount = 64
  return server
}

function limit(max) {
  let bytes = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > max ? new Error('Gateway stream limit exceeded') : null, chunk)
    },
  })
}

if (process.argv[1]?.endsWith('/gateway.mjs')) {
  try {
    const server = createGateway({
      listenHost: process.env.LISTEN_HOST,
      clientIp: process.env.CLIENT_IPV4,
      routes: JSON.parse(process.env.ALLOWED_ROUTES ?? '[]'),
      llmUpstream: process.env.LLM_UPSTREAM,
      mcpUpstream: process.env.MCP_UPSTREAM,
    })
    server.listen(8080, process.env.LISTEN_HOST, () =>
      writeFileSync('/run/raditi-gateway/ready', 'ready\n', { mode: 0o600 }),
    )
    server.on('error', () => {
      console.error('Gateway listener failed')
      process.exitCode = 1
    })
  } catch {
    console.error('Gateway configuration failed')
    process.exitCode = 1
  }
}
