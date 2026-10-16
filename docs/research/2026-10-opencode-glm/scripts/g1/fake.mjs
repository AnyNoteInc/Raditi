// Stand container of the G1 spike: a scripted provider, an MCP stub and a sink. It holds no secret and
// has no upstream: the CLI's credentials are recognised by their SHA-256, so a record cannot carry them.
//   :8080  POST /s/<run>/zai/v4/chat/completions   answers by the steps of the run's scenario
//          *    /s/<run>/mcp                        MCP stub (streamable HTTP, JSON answers)
//          anything else                            404, recorded under the run `unsorted`
//   :53 (udp and tcp), :80, :443                    sink: the name, the Host or the SNI of whatever else is wanted
//   127.0.0.1:9090                                  control, reachable only from inside this container
//          PUT /runs/<run>  the scenario     GET /runs/<run>  its records     GET /sink  the sink's records
// `node fake.mjs ctl put <run>` (scenario on stdin), `ctl get <run>` and `ctl sink` talk to the control port.
//
// A scenario: { llmKeySha256, mcpTokenSha256, otherSha256: {label: sha256}, enforceAuth, cap, steps, mcp }.
// A step answers one chat request, in order; the last step repeats when the steps run out:
//   { kind: 'sse', events: [object | '[DONE]'], end: 'end' | 'destroy' | 'hang', status, headers, gapMs }
//   { kind: 'http', status, headers, contentType, body }
// `cap` (default 40) bounds a request storm: later requests get HTTP 401, which the CLI never repeats.
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import { createServer, request as httpRequest } from 'node:http'
import net from 'node:net'

const CONTROL_PORT = 9090
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const runs = new Map()
const sink = []
const log = (line) => console.log(`[fake ${new Date().toISOString().slice(11, 23)}] ${line}`)

function runOf(id) {
  if (!runs.has(id))
    runs.set(id, {
      scenario: { steps: [] },
      startedAt: Date.now(),
      llm: 0,
      mcpInitialize: 0,
      records: [],
    })
  return runs.get(id)
}

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'api-key']
/** What a credential is, never its value: the labels the sanitiser of the repository understands. */
function classify(run, raw) {
  if (raw === undefined) return { kind: 'none' }
  const text = String(raw)
  const scheme = /^Bearer\s+/i.test(text) ? 'Bearer ' : ''
  const bare = text.replace(/^Bearer\s+/i, '')
  const digest = sha256(bare)
  const { llmKeySha256, mcpTokenSha256, otherSha256 = {} } = run.scenario
  if (digest === llmKeySha256) return { kind: 'turn-key', shown: `${scheme}<dummy llm token>` }
  if (digest === mcpTokenSha256) return { kind: 'mcp-token', shown: `${scheme}<dummy mcp token>` }
  const label = Object.entries(otherSha256).find(([, value]) => value === digest)?.[0]
  return { kind: label ?? 'other', shown: `${scheme}<${label ?? 'other'}, ${bare.length} chars>` }
}
function recordHeaders(run, headers) {
  const out = { ...headers }
  const credentials = {}
  const kinds = {}
  for (const name of CREDENTIAL_HEADERS) {
    if (headers[name] === undefined) continue
    const { kind, shown } = classify(run, headers[name])
    out[name] = shown
    credentials[name] = shown
    kinds[name] = kind
  }
  return { headers: out, clientCredentials: credentials, credentialKinds: kinds }
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}
const sendJson = (response, status, body, headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  response
    .writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...headers,
    })
    .end(text)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- scripted provider -----------------------------------------------------------------------
function summarise(body) {
  if (!body || typeof body !== 'object') return undefined
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages.find((message) => message.role === 'system')
  const systemText =
    typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? '')
  const lastUser = messages.findLast((message) => message.role === 'user')
  return {
    fields: Object.keys(body),
    model: body.model,
    stream: body.stream,
    stream_options: body.stream_options,
    max_tokens: body.max_tokens,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
    tool_choice: body.tool_choice,
    tools: Array.isArray(body.tools)
      ? body.tools.map((tool) => tool.function?.name ?? tool.type)
      : undefined,
    systemChars: systemText.length,
    systemSha256: sha256(systemText),
    systemHead: systemText.slice(0, 160),
    messages: messages.map((message) => {
      const size =
        typeof message.content === 'string'
          ? message.content.length
          : JSON.stringify(message.content ?? '').length
      const calls = message.tool_calls
        ? `,tool_calls:${message.tool_calls.map((call) => call.function?.name).join('|')}`
        : ''
      return `${message.role}(${size}${calls})`
    }),
    lastUser:
      typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 600) : lastUser?.content,
  }
}

async function chat(run, request, response, path) {
  const raw = await readBody(request)
  let body
  try {
    body = JSON.parse(raw.toString())
  } catch {
    body = { unparsed: raw.toString().slice(0, 2000) }
  }
  run.llm += 1
  const seen = recordHeaders(run, request.headers)
  const record = {
    kind: 'llm',
    n: run.llm,
    at: new Date().toISOString(),
    ms: Date.now() - run.startedAt,
    from: request.socket.remoteAddress,
    request: {
      method: request.method,
      path,
      ...seen,
      bodyBytes: raw.length,
      summary: summarise(body),
      body,
    },
  }
  run.records.push(record)
  const { steps = [], enforceAuth = true, cap = 40 } = run.scenario
  if (run.llm > cap) {
    record.response = { capped: true, status: 401 }
    sendJson(response, 401, { error: { code: '401', message: 'spike cap reached' } })
    return
  }
  if (enforceAuth && seen.credentialKinds.authorization !== 'turn-key') {
    record.response = { refused: 'not the turn key', status: 401 }
    sendJson(response, 401, { error: { code: '401', message: 'token expired or incorrect' } })
    return
  }
  // Steps are consumed by position; `repeat` keeps a step for that many requests.
  let position = run.llm
  let step = steps.at(-1)
  for (const candidate of steps) {
    const times = candidate.repeat === 'forever' ? Infinity : (candidate.repeat ?? 1)
    if (position <= times) {
      step = candidate
      break
    }
    position -= times
  }
  if (!step) {
    record.response = { status: 500, note: 'no step' }
    sendJson(response, 500, { error: { code: '500', message: 'the scenario has no step' } })
    return
  }
  record.response = {
    step: steps.indexOf(step),
    kind: step.kind,
    status: step.status ?? 200,
    label: step.label,
  }
  if (step.kind === 'http') {
    const text = typeof step.body === 'string' ? step.body : JSON.stringify(step.body)
    record.response.headers = {
      'content-type': step.contentType ?? 'application/json; charset=UTF-8',
      ...step.headers,
    }
    record.response.body = step.body
    response.writeHead(step.status, record.response.headers).end(text)
    return
  }
  record.response.headers = { 'content-type': 'text/event-stream;charset=UTF-8', ...step.headers }
  record.response.events = step.events
  record.response.end = step.end ?? 'end'
  response.writeHead(step.status ?? 200, record.response.headers)
  response.flushHeaders()
  for (const event of step.events ?? []) {
    response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    if (step.gapMs) await sleep(step.gapMs)
  }
  if (record.response.end === 'destroy') setTimeout(() => response.socket?.destroy(), 100)
  else if (record.response.end === 'hang')
    response.on('close', () => {
      record.response.closedByClientAfterMs = Date.now() - run.startedAt - record.ms
    })
  else response.end()
}

// ---- MCP stub --------------------------------------------------------------------------------
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
async function mcp(run, request, response, path) {
  const seen = recordHeaders(run, request.headers)
  const record = {
    kind: 'mcp',
    at: new Date().toISOString(),
    ms: Date.now() - run.startedAt,
    request: { method: request.method, path, ...seen },
  }
  run.records.push(record)
  if (request.method === 'GET') {
    record.response = { status: 405 }
    response.writeHead(405, { allow: 'POST, DELETE' }).end()
    return
  }
  if (request.method === 'DELETE') {
    record.response = { status: 204 }
    response.writeHead(204).end()
    return
  }
  const raw = await readBody(request)
  let body
  try {
    body = JSON.parse(raw.toString())
  } catch {
    record.response = { status: 400 }
    sendJson(response, 400, { error: 'bad json' })
    return
  }
  record.request.body = body
  record.rpc = body.method
  if (seen.credentialKinds.authorization !== 'mcp-token') {
    record.response = { status: 401 }
    sendJson(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
    return
  }
  if (body.id === undefined) {
    record.response = { status: 202 }
    response.writeHead(202).end()
    return
  }
  const options = run.scenario.mcp ?? {}
  const extra = {}
  let result
  if (body.method === 'initialize') {
    run.mcpInitialize += 1
    record.initialize = run.mcpInitialize
    record.client = body.params?.clientInfo
    const fail = options.failInitialize
    if (fail && run.mcpInitialize >= (fail.from ?? 1)) {
      record.response = { failed: fail.how }
      if (fail.how === 'destroy') request.socket.destroy()
      else if (fail.how === 'hang')
        response.on('close', () => (record.response.closedByClient = true))
      else if (fail.how === 'rpc-error')
        sendJson(response, 200, {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'Session refused' },
        })
      else sendJson(response, fail.how, { error: 'refused by the stand' })
      return
    }
    result = {
      protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'raditi-oc-stub', version: '1' },
    }
    if (!options.noSession)
      extra['mcp-session-id'] = `stub-session-${String(run.mcpInitialize).padStart(4, '0')}`
  } else if (body.method === 'tools/list') {
    result = { tools: MCP_TOOLS }
  } else if (body.method === 'tools/call') {
    record.call = { name: body.params?.name, arguments: body.params?.arguments }
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
    record.response = { status: 200, body: answer }
    sendJson(response, 200, answer)
    return
  }
  const answer = { jsonrpc: '2.0', id: body.id, result }
  record.response = { status: 200, headers: extra, body: answer }
  sendJson(response, 200, answer, extra)
}

// ---- sink ------------------------------------------------------------------------------------
const SELF = process.env.SINK_IP ?? '127.0.0.1'
const sunk = (record) => {
  sink.push({ at: new Date().toISOString(), ...record })
  log(`sink ${JSON.stringify(record)}`)
}
function parseQuestion(message) {
  let offset = 12
  const labels = []
  while (offset < message.length) {
    const length = message[offset]
    if (length === 0) {
      offset += 1
      break
    }
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString('latin1'))
    offset += 1 + length
  }
  return { name: labels.join('.'), type: message.readUInt16BE(offset), end: offset + 4 }
}
/** Every A question gets this container's address, so the next step of the client shows up too. */
function dnsAnswer(message) {
  const question = parseQuestion(message)
  const header = Buffer.from(message.subarray(0, 12))
  header[2] = 0x81
  header[3] = 0x80
  header.writeUInt16BE(1, 4)
  let answers = Buffer.alloc(0)
  if (question.type === 1) {
    answers = Buffer.concat([
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4]),
      Buffer.from(SELF.split('.').map(Number)),
    ])
    header.writeUInt16BE(1, 6)
  } else header.writeUInt16BE(0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  return { question, reply: Buffer.concat([header, message.subarray(12, question.end), answers]) }
}
function sni(data) {
  try {
    if (data[0] !== 0x16) return undefined
    let offset = 5 + 4 + 2 + 32
    offset += 1 + data[offset]
    offset += 2 + data.readUInt16BE(offset)
    offset += 1 + data[offset]
    const end = offset + 2 + data.readUInt16BE(offset)
    offset += 2
    while (offset + 4 <= end) {
      const type = data.readUInt16BE(offset)
      const length = data.readUInt16BE(offset + 2)
      if (type === 0)
        return data
          .subarray(offset + 9, offset + 9 + data.readUInt16BE(offset + 7))
          .toString('latin1')
      offset += 4 + length
    }
  } catch {
    /* not a ClientHello */
  }
  return undefined
}
function startSink() {
  const udp = dgram.createSocket('udp4')
  udp.on('message', (message, remote) => {
    try {
      const { question, reply } = dnsAnswer(message)
      sunk({ kind: 'dns', name: question.name, type: question.type, from: remote.address })
      udp.send(reply, remote.port, remote.address)
    } catch (error) {
      sunk({ kind: 'dns-error', error: String(error?.message) })
    }
  })
  udp.bind(53, '0.0.0.0')
  net
    .createServer((socket) => {
      socket.once('data', (data) => {
        try {
          const { question, reply } = dnsAnswer(data.subarray(2))
          sunk({
            kind: 'dns-tcp',
            name: question.name,
            type: question.type,
            from: socket.remoteAddress,
          })
          const length = Buffer.alloc(2)
          length.writeUInt16BE(reply.length)
          socket.end(Buffer.concat([length, reply]))
        } catch {
          socket.destroy()
        }
      })
      socket.on('error', () => {})
    })
    .listen(53, '0.0.0.0')
  net
    .createServer((socket) => {
      socket.once('data', (data) => {
        sunk({ kind: 'tls', port: 443, sni: sni(data) ?? '(none)', from: socket.remoteAddress })
        socket.destroy()
      })
      socket.on('error', () => {})
    })
    .listen(443, '0.0.0.0')
  net
    .createServer((socket) => {
      socket.once('data', (data) => {
        const head = data.toString('latin1').split('\r\n')
        const host = head
          .find((line) => /^host:/i.test(line))
          ?.slice(5)
          .trim()
        sunk({
          kind: 'http',
          port: 80,
          line: head[0]?.slice(0, 200),
          host,
          from: socket.remoteAddress,
        })
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      })
      socket.on('error', () => {})
    })
    .listen(80, '0.0.0.0')
}

// ---- servers ---------------------------------------------------------------------------------
function serve() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fake')
      const match = /^\/s\/([A-Za-z0-9._-]+)(\/.*)$/.exec(url.pathname)
      const run = runOf(match?.[1] ?? 'unsorted')
      const rest = match?.[2] ?? url.pathname
      if (match && rest === '/zai/v4/chat/completions' && request.method === 'POST')
        return await chat(run, request, response, rest)
      if (match && rest === '/mcp') return await mcp(run, request, response, rest)
      const raw = await readBody(request)
      run.records.push({
        kind: 'other',
        at: new Date().toISOString(),
        ms: Date.now() - run.startedAt,
        request: {
          method: request.method,
          path: url.pathname,
          ...recordHeaders(run, request.headers),
          bodyBytes: raw.length,
        },
        response: { status: 404 },
      })
      sendJson(response, 404, { error: { message: 'not found', type: 'stand_not_found' } })
    } catch (error) {
      log(`handler failure: ${error?.name}: ${error?.message}`)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  // A CONNECT means the CLI treats this port as a forward proxy: record and refuse.
  server.on('connect', (request, socket) => {
    sunk({ kind: 'connect', target: request.url, from: socket.remoteAddress })
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  server.listen(8080, '0.0.0.0', () => log('provider and MCP stub on :8080'))

  createServer(async (request, response) => {
    const url = new URL(request.url, 'http://control')
    const id = /^\/runs\/([A-Za-z0-9._-]+)$/.exec(url.pathname)?.[1]
    if (id && request.method === 'PUT') {
      const scenario = JSON.parse((await readBody(request)).toString())
      runs.set(id, { scenario, startedAt: Date.now(), llm: 0, mcpInitialize: 0, records: [] })
      log(`run ${id}: ${scenario.steps?.length ?? 0} steps`)
      return sendJson(response, 200, { run: id })
    }
    if (id && request.method === 'GET') {
      const run = runOf(id)
      return sendJson(response, 200, {
        run: id,
        startedAt: run.startedAt,
        llm: run.llm,
        records: run.records,
      })
    }
    if (url.pathname === '/sink') return sendJson(response, 200, sink)
    sendJson(response, 404, { error: 'unknown control path' })
  }).listen(CONTROL_PORT, '127.0.0.1', () => log(`control on 127.0.0.1:${CONTROL_PORT}`))
  startSink()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0))
}

function control(verb, id) {
  const method = verb === 'put' ? 'PUT' : 'GET'
  const path = verb === 'sink' ? '/sink' : `/runs/${id}`
  const request = httpRequest(
    { host: '127.0.0.1', port: CONTROL_PORT, method, path },
    (response) => {
      // No process.exit here: stdout is a pipe, and an exit would cut a long answer at the pipe's buffer.
      process.exitCode = response.statusCode === 200 ? 0 : 1
      response.pipe(process.stdout)
    },
  )
  request.on('error', (error) => {
    console.error(`control: ${error.message}`)
    process.exit(1)
  })
  if (verb === 'put') process.stdin.pipe(request)
  else request.end()
}

if (process.argv[2] === 'ctl') control(process.argv[3], process.argv[4])
else serve()
