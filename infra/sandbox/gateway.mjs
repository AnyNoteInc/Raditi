/* global AbortController, Buffer, URL, clearTimeout, console, process, setTimeout */
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { writeFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const sharedRequestHeaders = ['authorization', 'content-type', 'accept']
const llmRequestHeaders = [
  ...sharedRequestHeaders,
  'user-agent',
  'originator',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-openai-subagent',
  'x-codex-turn-state',
  'x-openai-internal-codex-responses-lite',
]
const mcpRequestHeaders = [
  ...sharedRequestHeaders,
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]
const llmResponseHeaders = ['content-type', 'x-codex-turn-state', 'retry-after']
const mcpResponseHeaders = ['content-type', 'mcp-session-id', 'mcp-protocol-version']

export const gatewayLimits = Object.freeze({
  // A backstop only. The role llm owns the 10-minute request limit and must reach it first:
  // if this proxy closed the socket earlier, the role would journal its own platform limit
  // as a billable client abort.
  llmMs: 11 * 60 * 1000,
  mcpMs: 20 * 60 * 1000,
  requestBytes: 16 * 1024 * 1024,
  responseBytes: 64 * 1024 * 1024,
  lingerMs: 5_000,
})
// The same shape and code as the role llm refusal for a declared oversized body.
const tooLarge = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    code: 'raditi_body',
    message: 'Request body is too large',
  },
})

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
    for (const path of ['/codex/responses', '/kimi/v1/chat/completions'])
      targets.set(path, { url: target(llmUpstream, path), methods: ['POST'], group: 'llm' })
  }
  if (routes.includes('mcp'))
    targets.set('/mcp', {
      url: target(mcpUpstream, '/mcp'),
      methods: ['GET', 'POST', 'DELETE'],
      group: 'mcp',
    })
  let active = 0
  const server = createServer(async (req, res) => {
    const route = targets.get(req.url)
    const allowedRequestHeaders = route?.group === 'llm' ? llmRequestHeaders : mcpRequestHeaders
    if (
      req.socket.remoteAddress !== clientIp ||
      !['sandbox-gw', 'sandbox-gw:8080'].includes(req.headers.host ?? '') ||
      !route ||
      !route.methods.includes(req.method) ||
      active >= 8 ||
      !uniqueHeaders(req, ['host', ...allowedRequestHeaders]) ||
      (route.group === 'llm' && !validLlmHeaders(req))
    ) {
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
      res.end('Request is not allowed\n')
      return
    }
    if (Number(req.headers['content-length']) > gatewayLimits.requestBytes) {
      refuseTooLarge(req, res)
      return
    }
    active += 1
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      route.group === 'llm' ? gatewayLimits.llmMs : gatewayLimits.mcpMs,
    )
    let oversized = false
    // Regenerate framing for every method, including MCP GET/DELETE with a body.
    // Without it Node may send those bytes as another raw HTTP request upstream.
    const headers = { host: route.url.host, 'transfer-encoding': 'chunked' }
    const requestConnectionHeaders = connectionHeaders(req)
    for (const name of allowedRequestHeaders)
      if (!requestConnectionHeaders.has(name) && typeof req.headers[name] === 'string')
        headers[name] = req.headers[name]
    if (route.group === 'llm')
      for (const [name, value] of Object.entries(req.headers))
        if (name.startsWith('x-msh-') && !requestConnectionHeaders.has(name)) headers[name] = value
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
            const allowedResponseHeaders =
              route.group === 'llm' ? llmResponseHeaders : mcpResponseHeaders
            if (!uniqueHeaders(response, allowedResponseHeaders)) {
              response.destroy()
              reject(new Error('Ambiguous upstream response headers'))
              return
            }
            const responseConnectionHeaders = connectionHeaders(response)
            for (const name of allowedResponseHeaders)
              if (
                !responseConnectionHeaders.has(name) &&
                typeof response.headers[name] === 'string'
              )
                outputHeaders[name] = response.headers[name]
            res.writeHead(response.statusCode ?? 502, outputHeaders)
            try {
              await pipeline(response, limit(gatewayLimits.responseBytes), res)
              resolve()
            } catch (error) {
              reject(error)
            }
          },
        )
        upstream.on('error', reject)
        upstream.on('upgrade', (_response, socket) => {
          socket.destroy()
          reject(new Error('Upstream upgrades are not allowed'))
        })
        // The upstream clock starts now, not when the sandbox sends its first body byte.
        upstream.flushHeaders()
        // pipeline() would destroy req and its socket with it; an oversized upload must
        // leave the socket open for the 413 below.
        const body = limit(gatewayLimits.requestBytes, () => {
          oversized = true
        })
        req.on('error', reject)
        req.pipe(body)
        void pipeline(body, upstream).catch(reject)
      })
    } catch {
      controller.abort()
      if (res.headersSent) res.destroy()
      else if (oversized) refuseTooLarge(req, res)
      else {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Gateway request failed\n')
      }
    } finally {
      // An early upstream reply must also stop an unfinished request upload.
      controller.abort()
      if (!req.readableEnded && !(oversized && !res.destroyed)) req.destroy()
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

function connectionHeaders(message) {
  const value = message.headers.connection
  return new Set(
    typeof value === 'string'
      ? value
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
      : [],
  )
}

function uniqueHeaders(message, names) {
  const allowed = new Set(names)
  const seen = new Set()
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index].toLowerCase()
    if (!allowed.has(name)) continue
    if (seen.has(name)) return false
    seen.add(name)
  }
  return true
}

function validLlmHeaders(req) {
  const lite = req.headers['x-openai-internal-codex-responses-lite']
  if (lite !== undefined && lite !== 'true') return false
  const seen = new Set()
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase()
    if (!name.startsWith('x-msh-')) continue
    if (seen.has(name) || seen.size >= 8 || req.rawHeaders[index + 1].length > 256) return false
    seen.add(name)
  }
  return true
}

// A final refusal: 502 would make the CLI upload the same oversized body again.
function refuseTooLarge(req, res) {
  res.writeHead(413, { 'content-type': 'application/json' })
  res.end(tooLarge)
  // A reset under a client that is still uploading can cost it the answer: discard the rest,
  // but only briefly. Node stops timing a request once its response is finished.
  req.resume()
  const linger = setTimeout(() => req.destroy(), gatewayLimits.lingerMs)
  linger.unref()
  req.once('close', () => clearTimeout(linger))
}

function limit(max, exceeded) {
  let bytes = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > max) exceeded?.()
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
