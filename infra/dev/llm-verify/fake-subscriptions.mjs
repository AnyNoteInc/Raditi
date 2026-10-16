import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createFakeZaiState, handleZai, handleZaiControl, isZaiRequest } from './fake-zai.mjs'

// The synthetic services of a stand in one process, on its disposable network only: the
// synthetic provider (fake-zai.mjs) behind TLS, the synthetic MCP server behind sandbox-gw, and
// a separate control port that exposes what both saw. Nothing here makes an outbound request
// or persists request contents.
export const SYNTHETIC_MCP_MARKER = 'synthetic-mcp-site-info-b13'
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const fail = (res, status, code) =>
  json(res, status, { error: { type: code, code, message: 'Synthetic failure.' } })

/** What the process holds: the MCP registration of a turn and the state of the provider. */
export function createFakeSubscriptionState(initial = {}) {
  const state = {
    // The synthetic MCP server behind sandbox-gw: one registered turn token, never echoed.
    mcp: { token: null, tools: [], requests: [] },
    // The provider keeps its own scenario, quota windows and request records (fake-zai.mjs).
    zai: createFakeZaiState(initial),
    reset() {
      state.mcp = { token: null, tools: [], requests: [] }
      state.zai.reset()
      return state.snapshot()
    },
    snapshot() {
      return { mcp: { requests: state.mcp.requests }, zai: state.zai.snapshot() }
    },
    setMcp(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid MCP')
      if (typeof value.token !== 'string' || !/^mcp_[a-f0-9]{64}$/.test(value.token))
        throw new Error('Invalid MCP token')
      if (
        !Array.isArray(value.tools) ||
        value.tools.length > 16 ||
        !value.tools.every(
          (tool) =>
            tool &&
            typeof tool === 'object' &&
            typeof tool.name === 'string' &&
            /^[a-z_][a-z0-9_]{0,63}$/.test(tool.name),
        )
      )
        throw new Error('Invalid MCP tools')
      state.mcp.token = value.token
      state.mcp.tools = value.tools
      return { tools: value.tools.map((tool) => tool.name) }
    },
  }
  return state
}

async function bodyOf(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('Body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

/**
 * Synthetic MCP, shaped like the role mcp's stateless JSON answers (mcp-nest). The tools are the
 * ones the harness registers (the production profile's), so the CLI declares them to the model
 * exactly as it would in a turn. Only the registered turn token is accepted; it is never stored
 * in a request record or answered back.
 */
async function handleMcp(req, res, state) {
  const record = { method: req.method, rpc: null, tool: null, authorized: false }
  const authorized =
    typeof state.mcp.token === 'string' && req.headers.authorization === `Bearer ${state.mcp.token}`
  if (state.mcp.requests.length < 1000) state.mcp.requests.push(record)
  if (new URL(req.url, 'http://synthetic.invalid').pathname !== '/mcp')
    return json(res, 404, { error: 'not_found' })
  if (!authorized) {
    req.resume()
    return json(res, 401, { error: 'unauthorized' })
  }
  record.authorized = true
  if (req.method === 'GET') return (req.resume(), res.writeHead(405).end())
  if (req.method === 'DELETE') return (req.resume(), res.writeHead(204).end())
  if (req.method !== 'POST') return (req.resume(), res.writeHead(405).end())
  const body = await bodyOf(req)
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0')
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid' } })
  record.rpc = typeof body.method === 'string' ? body.method.slice(0, 64) : null
  if (body.id === undefined) return res.writeHead(202).end()
  const answer = (value) => json(res, 200, { jsonrpc: '2.0', id: body.id, ...value })
  if (body.method === 'initialize')
    return answer({
      result: {
        protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'raditi-mcp', version: 'synthetic-b13' },
      },
    })
  if (body.method === 'ping') return answer({ result: {} })
  if (body.method === 'tools/list') return answer({ result: { tools: state.mcp.tools } })
  if (body.method === 'tools/call') {
    const name = typeof body.params?.name === 'string' ? body.params.name.slice(0, 64) : null
    record.tool = name
    if (!state.mcp.tools.some((tool) => tool.name === name))
      return answer({ error: { code: -32602, message: 'Unknown tool' } })
    return answer({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://b13-synthetic.invalid/',
              stack: 'wordpress',
              marker: SYNTHETIC_MCP_MARKER,
            }),
          },
        ],
        isError: false,
      },
    })
  }
  return answer({ error: { code: -32601, message: 'Unknown method' } })
}

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections()
    if (!server.listening) return resolve()
    server.close(resolve)
  })
const address = (server, host, scheme) => ({
  host,
  port: server.address().port,
  url: `${scheme}://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`,
})

/**
 * A TLS provider plus an HTTP control API bound to a separate internal port. With `mcpOnly` there
 * is no provider at all — no TLS listener, no provider control — only the synthetic MCP server
 * and the two control requests it needs: what a stand still runs locally when the provider at
 * the end of its path is the real one (live.mjs).
 */
export async function startFakeSubscriptions({
  host = '127.0.0.1',
  port = 0,
  key,
  cert,
  controlHost = '127.0.0.1',
  controlPort = 0,
  mcpHost = '127.0.0.1',
  mcpPort,
  mcpOnly = false,
  ...options
} = {}) {
  if (mcpOnly && (key || cert)) throw new Error('The MCP side alone takes no TLS material')
  if (mcpOnly && mcpPort === undefined) throw new Error('The MCP side alone needs an MCP port')
  if (!mcpOnly && (!key || !cert))
    throw new Error('Synthetic provider requires TLS key and certificate')
  const state = createFakeSubscriptionState(options)
  const provider = mcpOnly
    ? null
    : createHttpsServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
        if (!isZaiRequest(req)) {
          req.resume()
          // An unknown path of the provider: HTTP 200 with the envelope (sample 14).
          return json(res, 200, { code: 500, msg: '404 NOT_FOUND', success: false })
        }
        handleZai(req, res, state.zai).catch(() => {
          if (res.headersSent) res.destroy()
          else fail(res, 400, 'synthetic_invalid_request')
        })
      })
  const control = createHttpServer((req, res) => {
    ;(async () => {
      if (req.method === 'POST' && req.url === '/mcp')
        return json(res, 200, state.setMcp(await bodyOf(req)))
      if (mcpOnly) {
        // What the MCP side saw, and nothing that belongs to a provider.
        if (req.method === 'GET' && req.url === '/state')
          return json(res, 200, { mcp: state.snapshot().mcp })
        return fail(res, 404, 'synthetic_unknown_control')
      }
      if (req.method === 'GET' && req.url === '/state') return json(res, 200, state.snapshot())
      if (req.method === 'POST' && req.url === '/reset') {
        req.resume()
        return json(res, 200, state.reset())
      }
      // GET reads, POST sets `{reset?, scenario?, quota?}` of the synthetic provider.
      if (req.url === '/zai') return handleZaiControl(req, res, state.zai)
      return fail(res, 404, 'synthetic_unknown_control')
    })().catch(() => fail(res, 400, 'synthetic_invalid_control'))
  })
  // Plain HTTP like the role mcp behind sandbox-gw; only started when a port is given.
  const mcp =
    mcpPort === undefined
      ? null
      : createHttpServer((req, res) => {
          handleMcp(req, res, state).catch(() => {
            if (res.headersSent) res.destroy()
            else json(res, 400, { error: 'invalid' })
          })
        })
  const servers = [...(provider ? [provider] : []), control, ...(mcp ? [mcp] : [])]
  try {
    if (provider) await listen(provider, port, host)
    await listen(control, controlPort, controlHost)
    if (mcp) await listen(mcp, mcpPort, mcpHost)
  } catch (error) {
    await Promise.all(servers.map(close))
    throw error
  }
  return {
    state,
    ...(provider ? { address: address(provider, host, 'https') } : {}),
    controlAddress: address(control, controlHost, 'http'),
    ...(mcp ? { mcpAddress: address(mcp, mcpHost, 'http') } : {}),
    close: async () => {
      await Promise.all(servers.map(close))
    },
  }
}

async function main(args) {
  const options = {}
  // The MCP side alone: no provider, so no TLS option and no provider port either.
  const mcpOnly = args[0] === '--mcp-only'
  if (mcpOnly) args = args.slice(1)
  const names = {
    '--control-host': 'controlHost',
    '--control-port': 'controlPort',
    '--mcp-host': 'mcpHost',
    '--mcp-port': 'mcpPort',
    ...(mcpOnly
      ? {}
      : {
          '--host': 'host',
          '--port': 'port',
          '--tls-dir': 'tlsDir',
          '--tls-key': 'tlsKey',
          '--tls-cert': 'tlsCert',
        }),
  }
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]]
    if (!name || !args[i + 1] || Object.hasOwn(options, name)) throw new Error('Invalid arguments')
    options[name] = ['port', 'controlPort', 'mcpPort'].includes(name)
      ? Number(args[i + 1])
      : args[i + 1]
    if (
      ['port', 'controlPort', 'mcpPort'].includes(name) &&
      (!Number.isInteger(options[name]) || options[name] < 0 || options[name] > 65535)
    )
      throw new Error('Invalid port')
  }
  const { tlsDir, tlsKey, tlsCert, ...listeners } = options
  const fake = await startFakeSubscriptions(
    mcpOnly
      ? { ...listeners, mcpOnly }
      : {
          ...listeners,
          key: readFileSync(tlsKey ?? join(tlsDir, 'server-key.pem')),
          cert: readFileSync(tlsCert ?? join(tlsDir, 'server.pem')),
        },
  )
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      ...(fake.address ? { port: fake.address.port } : {}),
      controlPort: fake.controlAddress.port,
      ...(fake.mcpAddress ? { mcpPort: fake.mcpAddress.port } : {}),
    })}\n`,
  )
  let closing = false
  const stop = async () => {
    if (!closing) {
      closing = true
      await fake.close()
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Synthetic services failed.\n')
    process.exitCode = 1
  })
