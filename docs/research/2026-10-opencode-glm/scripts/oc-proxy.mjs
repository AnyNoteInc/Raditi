// Recording pass-through for the OpenCode CLI probe plus a tiny MCP stub. Host only.
//   /zai-coding/<rest>    -> https://api.z.ai/api/coding/paas/v4/<rest>   (OpenAI-compatible chat completions)
//   /zai-anthropic/<rest> -> https://api.z.ai/api/anthropic/<rest>        (Anthropic messages)
//   /zai-v1/<rest>        -> https://api.z.ai/api/v1/<rest>               (Responses)
//   /mcp                  -> two harmless tools shaped like site_info and wp_rest (streamable HTTP, JSON answers)
//   /__scenario/<name>?fault=…&replay=…&cut=…&after=… (loopback only) -> switch the directory and the fault plan
//   anything else         -> 404, recorded
// The CLI holds dummy tokens; the key never leaves this process except towards https://api.z.ai.
// Usage: PROBE_KEY_FILE=<key file> PROBE_OUT=<directory outside the repository> node oc-proxy.mjs <port-file>
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realKey, scrub, scrubHeaders, SAMPLES, OUT as PROBE_OUT, parseSse } from './zai.mjs'

const ROUTES = {
  '/zai-coding': { upstream: 'https://api.z.ai/api/coding/paas/v4', credential: 'bearer' },
  '/zai-anthropic': { upstream: 'https://api.z.ai/api/anthropic', credential: 'x-api-key' },
  '/zai-v1': { upstream: 'https://api.z.ai/api/v1', credential: 'bearer' },
}
export const DUMMY_LLM = 'raditi-glm-dummy-llm-token-000000000000'
export const DUMMY_MCP = 'raditi-glm-dummy-mcp-token-000000000000'
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'api-key']
const HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'upgrade',
  'content-length',
  'accept-encoding',
  'expect',
  ...CREDENTIAL_HEADERS,
])
const STRIP_BACK = new Set([
  'set-cookie',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'alt-svc',
  'strict-transport-security',
])
const OUT = SAMPLES
const COUNTER = join(PROBE_OUT, 'upstream-count.txt')
const MAX_UPSTREAM = Number(process.env.GLM_MAX_UPSTREAM || 80)

let scenario = 'unsorted'
let sequence = 0
let llmSeen = 0
let options = {}
const log = (line) => console.log(`[proxy ${new Date().toISOString().slice(11, 19)}] ${line}`)
const upstreamCount = () =>
  existsSync(COUNTER) ? Number(readFileSync(COUNTER, 'utf8').trim() || 0) : 0
const bumpUpstream = () => {
  const next = upstreamCount() + 1
  writeFileSync(COUNTER, `${next}\n`)
  return next
}

function clientCredentials(headers) {
  const out = {}
  for (const name of CREDENTIAL_HEADERS) {
    const value = headers[name]
    if (value === undefined) continue
    const bare = String(value).replace(/^Bearer\s+/i, '')
    const scheme = /^Bearer\s+/i.test(String(value)) ? 'Bearer ' : ''
    out[name] =
      bare === DUMMY_LLM
        ? `${scheme}<dummy llm token>`
        : bare === DUMMY_MCP
          ? `${scheme}<dummy mcp token>`
          : `${scheme}<other, ${bare.length} chars>`
  }
  return out
}
const hasDummy = (headers, token) =>
  CREDENTIAL_HEADERS.some(
    (name) => String(headers[name] ?? '').replace(/^Bearer\s+/i, '') === token,
  )

function recordHeaders(headers) {
  const out = scrubHeaders(headers)
  for (const [name, value] of Object.entries(clientCredentials(headers))) out[name] = value
  return out
}

function save(kind, record) {
  const dir = join(OUT, scenario)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sequence += 1
  const name = `${String(sequence).padStart(2, '0')}-${kind}.json`
  writeFileSync(join(dir, name), scrub(JSON.stringify(record, null, 2)) + '\n', { mode: 0o600 })
  return name
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const json = (response, status, body, headers = {}) => {
  const text = JSON.stringify(body)
  response
    .writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...headers,
    })
    .end(text)
}

// ---- MCP stub -------------------------------------------------------------------------------
const mcpCalls = []
const MCP_TOOLS = [
  {
    name: 'site_info',
    description:
      'Returns the public address and the stack of the test stand site. Read-only and harmless.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wp_rest',
    description:
      'Reads one object of the test stand site through its REST API. Read-only on this stand.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET'], description: 'HTTP method' },
        path: { type: 'string', description: 'REST path, for example /wp/v2/pages/7' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
  },
]
async function mcp(request, response) {
  const record = {
    at: new Date().toISOString(),
    request: { method: request.method, url: request.url, headers: recordHeaders(request.headers) },
  }
  if (request.method === 'GET') {
    response.writeHead(405, { allow: 'POST, DELETE' }).end()
    record.response = { status: 405 }
    log(`mcp GET -> 405 -> ${save('mcp-get', record)}`)
    return
  }
  if (request.method === 'DELETE') {
    response.writeHead(204).end()
    record.response = { status: 204 }
    log(`mcp DELETE -> 204 -> ${save('mcp-delete', record)}`)
    return
  }
  const raw = await readBody(request)
  let body
  try {
    body = JSON.parse(raw.toString())
  } catch {
    json(response, 400, { error: 'bad json' })
    return
  }
  record.request.body = body
  if (!hasDummy(request.headers, DUMMY_MCP)) {
    json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
    record.response = { status: 401 }
    log(`mcp ${body.method} -> 401 -> ${save('mcp-unauthorized', record)}`)
    return
  }
  const label = `mcp-${String(body.method).replaceAll('/', '_')}`
  if (body.id === undefined) {
    response.writeHead(202).end()
    record.response = { status: 202 }
    save(label, record)
    log(`mcp ${body.method} (notification) -> 202`)
    return
  }
  const extra = {}
  let result
  if (body.method === 'initialize') {
    result = {
      protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'raditi-glm-stub', version: '1' },
    }
    if (!options.noSession) extra['mcp-session-id'] = 'stub-session-0001'
  } else if (body.method === 'tools/list') {
    result = { tools: MCP_TOOLS }
  } else if (body.method === 'tools/call') {
    mcpCalls.push({ name: body.params?.name, arguments: body.params?.arguments })
    if (body.params?.name === 'site_info')
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://stand.example',
              stack: 'wordpress',
              note: 'STAND-NOTE-7391',
            }),
          },
        ],
        isError: false,
      }
    else if (body.params?.name === 'wp_rest')
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: 7,
              slug: 'stand-page',
              title: { rendered: 'Stand page 4417' },
              status: 'publish',
            }),
          },
        ],
        isError: false,
      }
    else result = { content: [{ type: 'text', text: 'Unknown tool' }], isError: true }
  } else {
    const answer = {
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: 'Method not found' },
    }
    json(response, 200, answer)
    record.response = { status: 200, body: answer }
    log(`mcp ${body.method} -> method not found -> ${save(label, record)}`)
    return
  }
  const answer = { jsonrpc: '2.0', id: body.id, result }
  json(response, 200, answer, extra)
  record.response = { status: 200, headers: extra, body: answer }
  log(
    `mcp ${body.method}${body.method === 'tools/call' ? ` ${body.params?.name} ${JSON.stringify(body.params?.arguments)}` : ''} -> ${save(label, record)}`,
  )
}

// ---- LLM pass-through ------------------------------------------------------------------------
function describeTools(tools) {
  if (!Array.isArray(tools)) return undefined
  return tools.map((tool) => tool.function?.name ?? tool.name ?? tool.type)
}
function summariseRequest(body) {
  if (!body || typeof body !== 'object') return undefined
  const messages = body.messages ?? body.input
  return {
    fields: Object.keys(body),
    model: body.model,
    stream: body.stream,
    stream_options: body.stream_options,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    tool_choice: body.tool_choice,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
    reasoning: body.reasoning,
    response_format: body.response_format,
    tools: describeTools(body.tools),
    systemChars:
      typeof body.system === 'string'
        ? body.system.length
        : Array.isArray(body.system)
          ? body.system.map((part) => part.text?.length)
          : undefined,
    messages: Array.isArray(messages)
      ? messages.map((message) => {
          const content = message.content
          const size =
            typeof content === 'string'
              ? content.length
              : Array.isArray(content)
                ? content
                    .map((part) => `${part.type}${part.text ? `:${part.text.length}` : ''}`)
                    .join('+')
                : content === null
                  ? 'null'
                  : typeof content
          return `${message.role ?? message.type}(${size}${message.tool_calls ? `,tool_calls:${message.tool_calls.map((call) => call.function?.name).join('|')}` : ''}${message.reasoning_content !== undefined ? `,reasoning_content:${String(message.reasoning_content).length}` : ''}${message.tool_call_id ? ',tool_call_id' : ''})`
        })
      : undefined,
  }
}
function summariseStream(events) {
  const out = {
    chunks: events.length,
    finish: undefined,
    usage: undefined,
    text: '',
    reasoningChars: 0,
    toolCalls: [],
    eventTypes: undefined,
    done: events.at(-1)?.raw === '[DONE]',
  }
  const types = {}
  const calls = new Map()
  for (const item of events) {
    const data = item.json
    if (item.event) types[item.event] = (types[item.event] ?? 0) + 1
    if (!data) continue
    if (data.usage) out.usage = data.usage
    for (const choice of data.choices ?? []) {
      if (choice.finish_reason) out.finish = choice.finish_reason
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string') out.text += delta.content
      if (typeof delta.reasoning_content === 'string')
        out.reasoningChars += delta.reasoning_content.length
      for (const call of delta.tool_calls ?? []) {
        const entry = calls.get(call.index) ?? { id: undefined, name: undefined, arguments: '' }
        if (call.id) entry.id = call.id
        if (call.function?.name) entry.name = call.function.name
        if (call.function?.arguments) entry.arguments += call.function.arguments
        calls.set(call.index, entry)
      }
    }
    // Anthropic stream
    if (data.type === 'message_start' && data.message?.usage)
      out.usage = { ...out.usage, start: data.message.usage }
    if (data.type === 'message_delta') {
      out.finish = data.delta?.stop_reason ?? out.finish
      if (data.usage) out.usage = { ...out.usage, delta: data.usage }
    }
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta')
      out.text += data.delta.text
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use')
      out.toolCalls.push({ name: data.content_block.name })
    // Responses stream
    if (
      data.type === 'response.completed' ||
      data.type === 'response.incomplete' ||
      data.type === 'response.failed'
    ) {
      out.finish = data.type
      out.usage = data.response?.usage
      out.responseError = data.response?.error
    }
  }
  out.toolCalls.push(...calls.values())
  out.text = out.text.slice(0, 1200)
  if (Object.keys(types).length) out.eventTypes = types
  return out
}

const CANNED = {
  // What Z.ai answered to a real over-quota key on the pay-per-token endpoint (sample 21): HTTP 429 and this body.
  http429: {
    status: 429,
    type: 'application/json; charset=UTF-8',
    body: JSON.stringify({
      error: {
        code: '1113',
        message: 'Insufficient balance or no resource package. Please recharge.',
      },
    }),
  },
  // The documented form of a plan limit (code 1308) — synthetic, to see what the CLI does with it.
  'http429-1308': {
    status: 429,
    type: 'application/json; charset=UTF-8',
    body: JSON.stringify({
      error: {
        code: '1308',
        message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 03:00:00',
      },
    }),
  },
  http500: {
    status: 500,
    type: 'application/json; charset=UTF-8',
    body: JSON.stringify({ error: { code: '500', message: 'Internal server error (synthetic)' } }),
  },
  http401: {
    status: 401,
    type: 'application/json; charset=UTF-8',
    body: JSON.stringify({
      error: { code: '401', message: 'token expired or incorrect (synthetic)' },
    }),
  },
  // The form seen on /api/v1 and on unknown paths: HTTP 200 with an error object instead of a completion.
  json200: {
    status: 200,
    type: 'application/json',
    body: JSON.stringify({ code: 401, msg: 'token expired or incorrect', success: false }),
  },
  http400: {
    status: 400,
    type: 'application/json; charset=UTF-8',
    body: JSON.stringify({ error: { code: '1210', message: 'Invalid API parameter (synthetic)' } }),
  },
}

async function llm(request, response, prefix, rest) {
  const route = ROUTES[prefix]
  const raw = await readBody(request)
  let body
  try {
    body = raw.length ? JSON.parse(raw.toString()) : undefined
  } catch {
    body = { unparsed: raw.toString().slice(0, 2000) }
  }
  llmSeen += 1
  const record = {
    at: new Date().toISOString(),
    scenario,
    request: {
      method: request.method,
      path: `${prefix}${rest}`,
      upstream: `${route.upstream}${rest}`,
      clientCredentials: clientCredentials(request.headers),
      headers: recordHeaders(request.headers),
      bodyBytes: raw.length,
      summary: summariseRequest(body),
      body,
    },
  }
  const label = `llm-${request.method.toLowerCase()}${rest.split('?')[0].replaceAll('/', '_')}`

  // Faults replayed locally: nothing goes upstream.
  const faultActive =
    options.fault &&
    llmSeen > Number(options.after ?? 0) &&
    (options.times === undefined || llmSeen <= Number(options.after ?? 0) + Number(options.times))
  if (faultActive && CANNED[options.fault]) {
    const canned = CANNED[options.fault]
    response
      .writeHead(canned.status, { 'content-type': canned.type, 'x-log-id': 'synthetic-fault' })
      .end(canned.body)
    record.response = {
      synthetic: options.fault,
      status: canned.status,
      body: JSON.parse(canned.body),
    }
    log(
      `llm ${request.method} ${rest} -> synthetic ${options.fault} -> ${save(`${label}-fault`, record)}`,
    )
    return
  }
  if (
    faultActive &&
    (options.fault === 'cut' || options.fault === 'stall' || options.fault === 'replay')
  ) {
    const source = JSON.parse(readFileSync(join(OUT, options.replay), 'utf8'))
    const sse = source.response.sse
    const cutAt = options.fault === 'replay' ? sse.length : Number(options.cut ?? 600)
    response.writeHead(200, {
      'content-type': 'text/event-stream;charset=UTF-8',
      'x-log-id': 'synthetic-replay',
    })
    response.write(sse.slice(0, cutAt))
    record.response = {
      synthetic: options.fault,
      replayOf: options.replay,
      bytesSent: Math.min(cutAt, sse.length),
      bytesTotal: sse.length,
    }
    if (options.fault === 'cut') setTimeout(() => response.socket?.destroy(), 150)
    else if (options.fault === 'replay') response.end()
    // stall: keep the socket open and silent; the CLI decides when to give up.
    else
      response.on('close', () =>
        log(
          `llm stalled stream closed by the client after ${Date.now() - Date.parse(record.at)} ms`,
        ),
      )
    log(
      `llm ${request.method} ${rest} -> synthetic ${options.fault} (${record.response.bytesSent}/${sse.length} bytes) -> ${save(`${label}-fault`, record)}`,
    )
    return
  }

  if (!hasDummy(request.headers, DUMMY_LLM)) {
    json(response, 401, { error: { message: 'dummy token required', type: 'proxy_unauthorized' } })
    record.response = { status: 401, proxy: 'refused: no dummy token' }
    log(
      `llm ${request.method} ${rest} refused: no dummy token -> ${save(`${label}-refused`, record)}`,
    )
    return
  }
  if (upstreamCount() >= MAX_UPSTREAM) {
    json(response, 429, { error: { message: 'probe budget exhausted', type: 'proxy_budget' } })
    record.response = { status: 429, proxy: 'refused: probe budget' }
    log(`llm ${request.method} ${rest} refused: probe budget -> ${save(`${label}-budget`, record)}`)
    return
  }
  const forward = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP.has(name)) continue
    if (options.drop?.includes(name)) continue
    forward[name] = Array.isArray(value) ? value.join(', ') : value
  }
  if (route.credential === 'bearer') forward.authorization = `Bearer ${realKey()}`
  else forward['x-api-key'] = realKey()
  forward['accept-encoding'] = 'identity'
  record.request.forwardedHeaderNames = Object.keys(forward).sort()
  const started = Date.now()
  const count = bumpUpstream()
  let upstream
  try {
    upstream = await fetch(`${route.upstream}${rest}`, {
      method: request.method,
      headers: forward,
      body: raw.length ? raw : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(300_000),
    })
  } catch (error) {
    record.response = { failure: `${error?.name}: ${error?.message}` }
    json(response, 502, { error: { message: 'upstream request failed', type: 'proxy_error' } })
    log(`llm #${count} ${request.method} ${rest} -> upstream failure -> ${save(label, record)}`)
    return
  }
  const back = {}
  for (const [name, value] of upstream.headers.entries())
    if (!STRIP_BACK.has(name)) back[name] = value
  response.writeHead(upstream.status, back)
  let text = ''
  let firstByteMs
  const decoder = new TextDecoder()
  let clientClosed = false
  response.on('close', () => {
    if (!response.writableEnded) clientClosed = true
  })
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      firstByteMs ??= Date.now() - started
      text += decoder.decode(chunk, { stream: true })
      if (!clientClosed) response.write(chunk)
    }
    text += decoder.decode()
  }
  response.end()
  const type = upstream.headers.get('content-type') ?? ''
  const events = type.includes('text/event-stream') ? parseSse(text) : undefined
  let parsed
  if (!events) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not JSON */
    }
  }
  const stream = events ? summariseStream(events) : undefined
  record.response = {
    status: upstream.status,
    headers: scrubHeaders(upstream.headers),
    elapsedMs: Date.now() - started,
    firstByteMs,
    clientClosedEarly: clientClosed || undefined,
    stream,
    body: events ? undefined : (parsed ?? text),
    sse: events ? text : undefined,
  }
  const name = save(label, record)
  const usage = stream?.usage ?? parsed?.usage
  log(
    `llm #${count} ${request.method} ${prefix}${rest} model=${body?.model} msgs=${(body?.messages ?? body?.input)?.length} tools=${body?.tools?.length ?? 0} -> ${upstream.status} ${type.split(';')[0]} finish=${stream?.finish ?? parsed?.choices?.[0]?.finish_reason ?? parsed?.stop_reason ?? ''} calls=${JSON.stringify(stream?.toolCalls?.map((call) => call.name) ?? [])} usage=${JSON.stringify(usage ?? null)} ${Date.now() - started}ms -> ${name}`,
  )
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://proxy')
    if (url.pathname.startsWith('/__scenario/')) {
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) ||
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? '')
      ) {
        response.writeHead(403).end()
        return
      }
      scenario =
        url.pathname.slice('/__scenario/'.length).replace(/[^a-zA-Z0-9._-]/g, '_') || 'unsorted'
      sequence = 0
      llmSeen = 0
      const list = (name) => url.searchParams.get(name)?.split(',').filter(Boolean)
      options = {
        drop: list('drop'),
        fault: url.searchParams.get('fault') ?? undefined,
        after: url.searchParams.get('after') ?? undefined,
        times: url.searchParams.get('times') ?? undefined,
        replay: url.searchParams.get('replay') ?? undefined,
        cut: url.searchParams.get('cut') ?? undefined,
        noSession: url.searchParams.has('nosession'),
      }
      mcpCalls.length = 0
      log(`scenario ${scenario} ${JSON.stringify(options)} (upstream so far: ${upstreamCount()})`)
      json(response, 200, { scenario, upstream: upstreamCount() })
      return
    }
    if (url.pathname === '/__mcp-calls') {
      json(response, 200, mcpCalls)
      return
    }
    if (url.pathname === '/mcp') {
      await mcp(request, response)
      return
    }
    const prefix = Object.keys(ROUTES).find(
      (candidate) => url.pathname === candidate || url.pathname.startsWith(`${candidate}/`),
    )
    if (prefix) {
      await llm(request, response, prefix, url.pathname.slice(prefix.length) + url.search)
      return
    }
    const raw = await readBody(request)
    const name = save(
      `other-${request.method.toLowerCase()}${url.pathname.replaceAll('/', '_').slice(0, 60)}`,
      {
        at: new Date().toISOString(),
        request: {
          method: request.method,
          url: request.url,
          headers: recordHeaders(request.headers),
          bodyBytes: raw.length,
          body: raw.length && raw.length < 20_000 ? scrub(raw.toString()) : undefined,
        },
        response: { status: 404 },
      },
    )
    json(response, 404, { error: { message: 'not found', type: 'proxy_not_found' } })
    log(`other ${request.method} ${request.url} -> 404 -> ${name}`)
  } catch (error) {
    log(`handler failure: ${error?.name}: ${scrub(String(error?.message))}`)
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})
// A CONNECT or an absolute-URI request means the CLI treats this port as a forward proxy: record and refuse.
server.on('connect', (request, socket) => {
  log(`CONNECT ${request.url} refused`)
  appendFileSync(
    join(PROBE_OUT, 'other-destinations.log'),
    `${new Date().toISOString()} ${scenario} CONNECT ${request.url}\n`,
  )
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
})

realKey() // fail before listening when the key file is not set
mkdirSync(OUT, { recursive: true, mode: 0o700 })
server.listen(Number(process.env.GLM_PROXY_PORT || 0), '127.0.0.1', () => {
  const { port } = server.address()
  if (process.argv[2]) writeFileSync(process.argv[2], String(port), { mode: 0o600 })
  log(
    `listening on 127.0.0.1:${port}; upstream requests so far: ${upstreamCount()} of ${MAX_UPSTREAM}`,
  )
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)))
