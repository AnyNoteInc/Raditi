/* global AbortController, Buffer, URL, clearTimeout, console, process, setTimeout */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'

// The recording pass-through for the P3.0 spike (README.md here; p3-design.md §0.1). It runs on
// the throwaway VM spike-1 next to Codex CLI or Kimi Code CLI, with synthetic prompts only, and
// never on egress-1 or a platform VM. The CLI calls it with a local key, like the sandbox's turn
// key; it puts the subscription token in, forwards to the fixed provider origin exactly as the
// subscription gateway will (scheme A), and writes every exchange, refused ones too, to
// RECORD_DIR/exchanges.jsonl without tokens, account ids or emails. With RECORD_EGRESS it goes
// out through egress-1 like the gateway: CONNECT inside mutual TLS, the provider's TLS inside the
// tunnel, so the provider sees the node's address and the node never sees a token.

export const ORIGINS = Object.freeze({ codex: 'https://chatgpt.com', kimi: 'https://api.kimi.ai' })
const ROUTES = new Map([
  ['POST /codex/responses', { backend: 'codex', path: '/backend-api/codex/responses' }],
  ['GET /codex/models', { backend: 'codex', path: '/backend-api/codex/models' }],
  ['GET /wham/usage', { backend: 'codex', path: '/backend-api/wham/usage' }],
  ['POST /kimi/v1/chat/completions', { backend: 'kimi', path: '/coding/v1/chat/completions' }],
  ['GET /kimi/v1/usages', { backend: 'kimi', path: '/coding/v1/usages' }],
  ['GET /kimi/v1/models', { backend: 'kimi', path: '/coding/v1/models' }],
])
// Client headers the gateway forwards to each provider (p3-design.md §3.4). Codex's own
// installation id passes here; the gateway will set the account's instead.
const FORWARD = {
  codex: [
    'content-type',
    'user-agent',
    'originator',
    'session-id',
    'thread-id',
    'x-client-request-id',
    'x-openai-subagent',
    'x-codex-turn-state',
    'x-codex-installation-id',
  ],
  kimi: ['content-type', 'accept', 'user-agent'],
}
// What the gateway strips; RECORD_KEEP lets one through to see whether the backend needs it.
export const STRIPPED = Object.freeze({
  headers: ['x-codex-turn-metadata', 'x-codex-window-id', 'x-codex-routing-hint'],
  fields: ['client_metadata', 'service_tier'],
})
const BACK = ['content-type', 'content-encoding', 'x-codex-turn-state', 'retry-after']
const REQUEST_LIMIT = 16 * 1024 * 1024
const RECORD_LIMIT = 32 * 1024 * 1024

/** Payload claims of a JWT, unverified: only for inspect and for the account id. */
const claims = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString())
  } catch {
    return {}
  }
}

/** A JSON file without V8's parse message: it quotes the start of the input, here a token. */
function readJson(file) {
  const text = readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${file} is not JSON`)
  }
}

/** The Codex login of `codex login --device-auth`: `$CODEX_HOME/auth.json`, read on each call. */
export function readCodexAuth(file) {
  const auth = readJson(file)
  const tokens = auth?.tokens ?? {}
  const accountId =
    tokens.account_id ?? claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof tokens.access_token !== 'string' || typeof accountId !== 'string')
    throw new Error(`${file} has no ChatGPT access token or account id`)
  const secrets = [tokens.access_token, tokens.refresh_token, tokens.id_token, auth.OPENAI_API_KEY]
  return { token: tokens.access_token, accountId, secrets: [...secrets, accountId] }
}

/** What P3.0 needs from the login: token lifetimes and the plan, without tokens or emails. */
export function inspectCodexAuth(file) {
  const auth = readJson(file)
  const time = (seconds) =>
    Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
  const access = claims(auth?.tokens?.access_token)
  const id = claims(auth?.tokens?.id_token)
  const plan = (payload) => payload['https://api.openai.com/auth']?.chatgpt_plan_type ?? null
  return {
    auth_mode: auth?.auth_mode ?? null,
    last_refresh: auth?.last_refresh ?? null,
    access_token: {
      issued: time(access.iat),
      expires: time(access.exp),
      lifetime_hours:
        Number.isFinite(access.exp) && Number.isFinite(access.iat)
          ? Math.round(((access.exp - access.iat) / 3600) * 10) / 10
          : null,
      plan_type: plan(access),
    },
    id_token: { issued: time(id.iat), expires: time(id.exp), plan_type: plan(id) },
    has_refresh_token: typeof auth?.tokens?.refresh_token === 'string',
    has_openai_api_key: typeof auth?.OPENAI_API_KEY === 'string',
  }
}

/** Replaces known secrets, any JWT and any email in a record line. */
export function scrub(text, secrets) {
  let out = text
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 8) out = out.replaceAll(secret, '[secret]')
  return out
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[jwt]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
}

/** JSON for the record: encrypted reasoning and data URLs become their lengths. */
function shorten(value, key) {
  if (typeof value === 'string') {
    if (key === 'encrypted_content') return `[encrypted_content: ${value.length} chars]`
    if (value.startsWith('data:') && value.length > 64) return `[data URL: ${value.length} chars]`
    return value
  }
  if (Array.isArray(value)) return value.map((item) => shorten(item))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, shorten(item, name)]),
    )
  return value
}

const json = (text) => {
  try {
    return shorten(JSON.parse(text))
  } catch {
    return text
  }
}

/** An SSE body as a list of events; anything else as JSON or text. */
function readBody(buffer, contentType) {
  const text = buffer.toString('utf8')
  if (!contentType?.includes('text/event-stream')) return { body: json(text) }
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim()
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (event || data) events.push({ ...(event ? { event } : {}), data: json(data) })
  }
  return { events }
}

/** The token usage the provider reported, as the gateway will read it. */
function usageOf(record) {
  for (const { data } of [...(record.events ?? [])].reverse()) {
    if (data?.type === 'response.completed') return data.response?.usage ?? null
    if (data?.usage) return data.usage
    if (data?.choices?.[0]?.usage) return data.choices[0].usage
  }
  return null
}

/**
 * An HTTPS agent whose connections go through the egress proxy (infra/egress). `egress`:
 * the node's address and port, and the root, client certificate and key of make-ca.sh.
 * `providerCa` replaces Node's CA set for the provider only in tests.
 */
export function egressAgent({ address, port = 443, ca, cert, key }, providerCa) {
  const agent = new Agent({ keepAlive: true, maxSockets: 4 })
  agent.createConnection = (options, callback) => {
    let called = false
    const done = (error, socket) => {
      if (called) return
      called = true
      callback(error, socket)
    }
    const proxy = tlsConnect({
      host: address,
      port,
      servername: 'egress-1.raditi.internal',
      ca,
      cert,
      key,
      minVersion: 'TLSv1.3',
    })
    const target = `${options.host}:${options.port}`
    let head = Buffer.alloc(0)
    const fail = (error) => {
      proxy.destroy()
      done(error)
    }
    const refused = (answer) =>
      Object.assign(new Error('egress refused'), { code: `EGRESS_${answer}` })
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return head.length > 8192 ? fail(refused('GARBAGE')) : undefined
      proxy.removeListener('data', onData)
      proxy.pause()
      const status = /^HTTP\/1\.1 (\d{3}) /.exec(head.toString('latin1'))?.[1]
      if (status !== '200' || end + 4 !== head.length) return fail(refused(status ?? 'GARBAGE'))
      const socket = tlsConnect({
        socket: proxy,
        servername: options.servername || options.host,
        ALPNProtocols: ['http/1.1'],
        ...(providerCa ? { ca: providerCa } : {}),
      })
      // The tunnel's failures end the provider's socket; the HTTP client sees them there.
      proxy.removeListener('error', fail)
      proxy.on('error', (error) => socket.destroy(error))
      socket.once('secureConnect', () => done(null, socket))
      socket.once('error', (error) => done(error))
    }
    proxy.on('error', fail)
    proxy.on('data', onData)
    proxy.once('secureConnect', () =>
      proxy.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`),
    )
  }
  return agent
}

const DECODERS = {
  gzip: gunzipSync,
  br: brotliDecompressSync,
  deflate: inflateSync,
  zstd: zstdDecompressSync,
}

export function createRecordProxy({
  localKey,
  codexAuthFile,
  kimiKeyFile,
  keep = [],
  recordFile,
  origins = ORIGINS,
  agent,
  print = console.log,
}) {
  for (const name of keep)
    if (![...STRIPPED.headers, ...STRIPPED.fields].includes(name))
      throw new Error(`RECORD_KEEP: ${name} is not stripped by the gateway`)
  const expected = Buffer.from(`Bearer ${localKey}`)
  let count = 0

  const credentials = (backend) => {
    if (backend === 'codex') return codexAuthFile ? readCodexAuth(codexAuthFile) : null
    if (!kimiKeyFile) return null
    const key = readFileSync(kimiKeyFile, 'utf8').trim()
    return key ? { token: key, secrets: [key] } : null
  }

  return createServer((req, res) => {
    const started = Date.now()
    const n = ++count
    const record = { n, at: new Date(started).toISOString(), method: req.method, path: req.url }
    const chunks = []
    let size = 0
    let secrets = [localKey]
    const write = () => {
      appendFileSync(recordFile, `${scrub(JSON.stringify(record), secrets)}\n`, { mode: 0o600 })
      const outcome =
        record.refused ?? (record.error ? `error ${record.error}` : record.response?.status)
      const usage = record.response && usageOf(record.response)
      const line = `#${n} ${req.method} ${req.url} → ${outcome} ${Date.now() - started} ms`
      print(scrub(usage ? `${line} usage ${JSON.stringify(usage)}` : line, secrets))
    }
    const answer = (status, reason) => {
      record.refused = `${status} ${reason}`
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(`${reason}\n`)
      write()
    }

    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= REQUEST_LIMIT) chunks.push(chunk)
    })
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const received = { ...req.headers }
      if (received.authorization)
        received.authorization =
          received.authorization === expected.toString() ? '[local key]' : '[other]'
      record.request = { headers: received, bytes: size }
      if (size > REQUEST_LIMIT) return answer(413, 'request too large')
      const presented = Buffer.from(req.headers.authorization ?? '')
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
        return answer(401, 'local key required')
      // What the CLI sent, refused paths included: finding those is half of the spike.
      if (req.headers['content-encoding'])
        record.request.body = `[${req.headers['content-encoding']}: ${size} bytes]`
      else if (body.length > 0) record.request.body = json(body.toString('utf8'))
      const [path, query = ''] = req.url.split(/\?(.*)/s)
      const route = ROUTES.get(`${req.method} ${path}`)
      const local = req.socket.localPort
      if (![`127.0.0.1:${local}`, `localhost:${local}`].includes(req.headers.host))
        return answer(403, 'host not allowed')
      if (!route) return answer(403, 'path not allowed')
      if (query && (req.method !== 'GET' || !/^[\w.=&%+-]{1,256}$/.test(query)))
        return answer(403, 'query not allowed')
      let credential
      try {
        credential = credentials(route.backend)
      } catch (error) {
        return answer(503, error.message)
      }
      if (!credential) return answer(503, `${route.backend} credentials are not configured`)
      secrets = [localKey, ...credential.secrets]

      const headers = {}
      for (const name of FORWARD[route.backend])
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
      if (route.backend === 'kimi') {
        const msh = Object.keys(req.headers).filter((name) => name.startsWith('x-msh-'))
        for (const name of msh.slice(0, 8))
          if (req.headers[name].length <= 256) headers[name] = req.headers[name]
      }
      for (const name of keep)
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
      headers.authorization = `Bearer ${credential.token}`
      if (route.backend === 'codex') headers['chatgpt-account-id'] = credential.accountId
      if (route.path.endsWith('/codex/responses')) headers.accept = 'text/event-stream'
      headers['accept-encoding'] = 'identity'

      let payload = body
      if (req.headers['content-encoding'])
        headers['content-encoding'] = req.headers['content-encoding']
      else if (route.backend === 'codex' && body.length > 0) {
        let parsed = null
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          // Not JSON: forwarded as it came; the record shows it.
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const removed = STRIPPED.fields.filter(
            (field) => !keep.includes(field) && field in parsed,
          )
          for (const field of removed) delete parsed[field]
          payload = Buffer.from(JSON.stringify(parsed))
          record.request.stripped = removed
        }
      }
      record.request.sent = {
        ...headers,
        authorization: '[subscription]',
        ...(headers['chatgpt-account-id'] ? { 'chatgpt-account-id': '[account]' } : {}),
      }

      const target = new URL(`${route.path}${query ? `?${query}` : ''}`, origins[route.backend])
      const controller = new AbortController()
      const abort = () => controller.abort()
      const timer = setTimeout(abort, 10 * 60 * 1000)
      res.on('close', abort)
      try {
        await new Promise((resolve, reject) => {
          const send = target.protocol === 'https:' ? httpsRequest : httpRequest
          const upstream = send(
            target,
            {
              method: req.method,
              headers,
              signal: controller.signal,
              ...(agent && target.protocol === 'https:' ? { agent } : {}),
            },
            (response) => {
              const status = response.statusCode ?? 502
              const upstreamHeaders = { ...response.headers }
              delete upstreamHeaders['set-cookie']
              record.response = { status, headers: upstreamHeaders }
              if (status >= 300 && status < 400) {
                response.resume()
                reject(new Error('redirect'))
                return
              }
              const back = {}
              for (const name of BACK)
                if (typeof response.headers[name] === 'string') back[name] = response.headers[name]
              res.writeHead(status, back)
              const saved = []
              let savedBytes = 0
              response.on('data', (chunk) => {
                savedBytes += chunk.length
                if (savedBytes <= RECORD_LIMIT) saved.push(chunk)
                res.write(chunk)
              })
              response.on('error', reject)
              response.on('end', () => {
                res.end()
                let raw = Buffer.concat(saved)
                const encoding = response.headers['content-encoding']
                if (encoding && DECODERS[encoding]) raw = DECODERS[encoding](raw)
                Object.assign(record.response, readBody(raw, response.headers['content-type']), {
                  bytes: savedBytes,
                  ms: Date.now() - started,
                  ...(savedBytes > RECORD_LIMIT ? { truncated: true } : {}),
                })
                resolve()
              })
            },
          )
          upstream.on('error', reject)
          upstream.end(payload.length > 0 ? payload : undefined)
        })
      } catch (error) {
        record.error = error.message === 'redirect' ? 'redirect' : (error.code ?? 'upstream_error')
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('upstream request failed\n')
        } else res.destroy()
      } finally {
        clearTimeout(timer)
        res.off('close', abort)
      }
      write()
    })
  })
}

if (process.argv[1]?.endsWith('/record-proxy.mjs')) {
  const env = process.env
  try {
    if (process.argv[2] === 'inspect') {
      if (!env.RECORD_CODEX_AUTH) throw new Error('RECORD_CODEX_AUTH is not set')
      console.log(JSON.stringify(inspectCodexAuth(env.RECORD_CODEX_AUTH), null, 2))
    } else {
      const port = Number(env.RECORD_PORT || 8090)
      const localKey = env.RECORD_LOCAL_KEY || `rdt-spike-${randomBytes(24).toString('hex')}`
      if (localKey.length < 32) throw new Error('RECORD_LOCAL_KEY must have at least 32 characters')
      const recordDir = env.RECORD_DIR || join(process.cwd(), 'spike-records')
      mkdirSync(recordDir, { recursive: true, mode: 0o700 })
      const tlsDir = env.RECORD_EGRESS_TLS_DIR
      if (env.RECORD_EGRESS && !tlsDir) throw new Error('RECORD_EGRESS_TLS_DIR is not set')
      const proxy = createRecordProxy({
        localKey,
        codexAuthFile: env.RECORD_CODEX_AUTH,
        kimiKeyFile: env.RECORD_KIMI_KEY_FILE,
        keep: (env.RECORD_KEEP ?? '').split(',').filter(Boolean),
        recordFile: join(recordDir, 'exchanges.jsonl'),
        agent:
          env.RECORD_EGRESS &&
          egressAgent({
            address: env.RECORD_EGRESS,
            ca: readFileSync(join(tlsDir, 'root.pem')),
            cert: readFileSync(join(tlsDir, 'client.pem')),
            key: readFileSync(join(tlsDir, 'client-key.pem')),
          }),
      })
      proxy.listen(port, '127.0.0.1', () => {
        const via = env.RECORD_EGRESS ? ` through egress ${env.RECORD_EGRESS}` : ' directly'
        console.log(`record-proxy on http://127.0.0.1:${port}, out${via}, records in ${recordDir}`)
        console.log(`export RADITI_LLM_TOKEN=${localKey} KIMI_MODEL_API_KEY=${localKey}`)
      })
      proxy.on('error', (error) => {
        console.error(`record-proxy failed: ${error.code ?? error.message}`)
        process.exitCode = 1
      })
    }
  } catch (error) {
    console.error(`record-proxy: ${error.message}`)
    process.exitCode = 1
  }
}
