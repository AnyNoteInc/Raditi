/* global AbortController, Buffer, Headers, URL, clearTimeout, console, process, setTimeout */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'

// The recording pass-through for the P3.0 spike (README.md here; p3-design.md §0.1). It runs on
// the throwaway VM spike-1 next to Codex CLI or Kimi Code CLI, with synthetic prompts only, and
// never on egress-1 or a platform VM. The CLI calls it with a local key, like the sandbox's turn
// key; it puts the subscription token in, forwards to the fixed provider origin exactly as the
// subscription gateway will (scheme A), and writes every exchange, refused ones too, to
// RECORD_DIR/exchanges.jsonl without tokens, emails, or the ids of an account, installation,
// thread or turn. With RECORD_EGRESS it goes out through egress-1 like the gateway: CONNECT inside
// mutual TLS, the provider's TLS inside the tunnel, so the provider sees the node's address and
// the node never sees a token.

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
  const expiry = claims(tokens.access_token).exp
  const expiresAt = Number.isSafeInteger(expiry) ? new Date(expiry * 1000) : null
  return {
    token: tokens.access_token,
    accountId,
    secrets: [...secrets, accountId],
    // Host memory only. The optional B7 harness validates this before any network call.
    credential: {
      v: '1',
      kind: 'chatgpt_oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      chatgptAccountId: accountId,
      accessExpiresAt:
        expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      refreshedAt: auth.last_refresh,
    },
  }
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

// A UUID names an installation, thread, turn or account wherever it stands: a field, a header,
// a path or a body that is not JSON.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// A provider's prefixed object id inside a longer text: an error message that quotes the
// organisation, a path, a stream line that is not JSON. The tail must look generated (a digit or
// a capital), so field names and plain words such as `user_instructions` stay.
const QUOTED_ID = /\b(?:user|org|acct|resp|req)[-_](?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{8,}/g

/** Replaces known secrets, any JWT, any email, any UUID and any quoted provider id in a line. */
export function scrub(text, secrets) {
  let out = text
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.replaceAll(JSON.stringify(secret).slice(1, -1), '[secret]')
      out = out.replaceAll(secret, '[secret]')
    }
  return out
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[jwt]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(UUID, '[id]')
    .replace(QUOTED_ID, '[id]')
}

// The record leaves the VM as P3.0 material: it keeps the protocol shape (field and header
// names, plan, numeric quota and usage), never whose account, user, organisation or object it is.
// Fields that name one are replaced whole, nested values included: `id`, `*_id` and `*-id`,
// `*identifier`, the thread id in `prompt_cache_key`, and client metadata, whose values carry the
// installation and turn ids, workspace paths and git remotes.
const snakeIdentity =
  /^(users?|user_?name|e?mail|.+_e?mail|accounts?|orgs?|organi[sz]ations?|workspaces?|prompt_cache_key)$|(^|[_-])(ids?|identifiers?|metadata)$/i
// The camelCase spelling of the same (`userId`, `accountID`, `sessionIds`): case matters here, or
// `valid` and `paid` would count.
const camelIdentity = /[a-z0-9](Ids?|IDs?|Identifiers?)$/
const identityField = { test: (name) => snakeIdentity.test(name) || camelIdentity.test(name) }
// The same by the shape of a value under any name: a provider's prefixed object id. UUIDs and
// such ids quoted inside a longer text are replaced in the whole record line (scrub).
const prefixedId = /^(user|org|acct|resp|req)[-_][\w-]{6,}$/i
// Request header values of an installation, device, session, account or user, or opaque state.
const identityHeader =
  /(^|-)(ids?|installation|device|session|thread|state|account|user|org|organi[sz]ation|workspace|name)(-|$)/i
// Request header values kept as they are: the protocol's own and the client's product identity.
// Any other value leaves only its header name, as x-codex-turn-metadata does.
const REQUEST_VALUES = new Set([
  'content-type',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'accept',
  'accept-encoding',
  'connection',
  'keep-alive',
  'user-agent',
  'originator',
  'x-openai-subagent',
  'x-msh-platform',
  'x-msh-version',
])
// Response header values kept as they are; any other value leaves only its header name.
const RESPONSE_VALUES = new Set([
  'content-type',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'retry-after',
  'cache-control',
  'connection',
  'keep-alive',
  'date',
])

const masked = (value) => {
  if (Array.isArray(value)) return value.map(masked)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, masked(item)]))
  return value === null ? null : '[id]'
}

const requestHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      REQUEST_VALUES.has(name)
        ? value
        : identityHeader.test(name)
          ? '[id]'
          : /^x-/.test(name) && /^(\d+(\.\d+)?|true|false)$/.test(String(value))
            ? value
            : '[value]',
    ]),
  )

const responseHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      RESPONSE_VALUES.has(name) ||
      (/^x-(codex|ratelimit)-/.test(name) && /^(\d+(\.\d+)?|true|false)$/.test(String(value)))
        ? value
        : '[value]',
    ]),
  )

/** JSON for the record: encrypted reasoning and data URLs become their lengths. */
function shorten(value, key) {
  if (
    /^(access_token|refresh_token|id_token|api_key|openai_api_key|account_id|chatgpt_account_id)$/i.test(
      key ?? '',
    )
  )
    return '[secret]'
  if (identityField.test(key ?? '')) return masked(value)
  if (typeof value === 'string') {
    if (key === 'encrypted_content') return `[encrypted_content: ${value.length} chars]`
    if (value.startsWith('data:') && value.length > 64) return `[data URL: ${value.length} chars]`
    return prefixedId.test(value) ? '[id]' : value
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
function readBody(buffer, contentType, inferSse = false) {
  const text = buffer.toString('utf8')
  if (!(contentType?.includes('text/event-stream') || (!contentType && inferSse)))
    return { body: json(text) }
  const events = []
  // Only a blank line dispatches an SSE event. A disconnected or truncated tail
  // must not invent a terminal event even if its JSON happens to be complete.
  const blocks = text.split(/\r?\n\r?\n/)
  blocks.pop()
  for (const block of blocks) {
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

function terminalOf(record) {
  for (const { data } of [...(record.events ?? [])].reverse()) {
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(data?.type))
      return data.type
    if (data === '[DONE]') return '[DONE]'
  }
  return null
}

/** The token usage the provider reported, as the gateway will read it. */
function usageOf(record) {
  for (const { data } of [...(record.events ?? [])].reverse()) {
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(data?.type))
      return data.response?.usage ?? null
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
export function egressAgent(
  { address, port = 443, ca, cert, key, connectTimeoutMs = 10_000 },
  providerCa,
) {
  const agent = new Agent({ keepAlive: true, maxSockets: 4 })
  agent.createConnection = (options, callback) => {
    let called = false
    const done = (error, socket) => {
      if (called) return
      called = true
      clearTimeout(timer)
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
    // HTTPS Agent does not yet own this socket, so the request's abort/timeout alone cannot
    // close a stalled outer TLS handshake, CONNECT response or provider TLS handshake.
    const timer = setTimeout(() => fail(refused('TIMEOUT')), connectTimeoutMs)
    proxy.once('close', () => {
      if (!called) fail(refused('CLOSED'))
    })
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      if (head.length > 8192) return fail(refused('GARBAGE'))
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
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
      socket.once('error', fail)
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

function decodeBody(buffer, encoding, limit) {
  if (!encoding || encoding === 'identity') return buffer
  if (!Object.hasOwn(DECODERS, encoding))
    throw Object.assign(new Error('unsupported content encoding'), { code: 'UNSUPPORTED_ENCODING' })
  return DECODERS[encoding](buffer, { maxOutputLength: limit })
}

export function createRecordProxy({
  localKey,
  codexAuthFile,
  codexAuth,
  codexAdapter,
  kimiKeyFile,
  keep = [],
  recordFile,
  origins = ORIGINS,
  agent,
  print = console.log,
}) {
  if (codexAdapter && keep.length) throw new Error('adapter verification cannot use RECORD_KEEP')
  for (const name of keep)
    if (![...STRIPPED.headers, ...STRIPPED.fields].includes(name))
      throw new Error(`RECORD_KEEP: ${name} is not stripped by the gateway`)
  const expected = Buffer.from(`Bearer ${localKey}`)
  let count = 0

  const credentials = (backend) => {
    if (backend === 'codex')
      return codexAuth ?? (codexAuthFile ? readCodexAuth(codexAuthFile) : null)
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
    const secrets = [localKey]
    const available = new Map()
    const unreadable = new Set()
    // Refused routes and unauthorized requests are recorded too. Load the redaction set
    // independently of routing, and never include a credential file's parse error in a reply.
    for (const backend of ['codex', 'kimi']) {
      try {
        const credential = credentials(backend)
        available.set(backend, credential)
        if (credential) secrets.push(...credential.secrets)
      } catch {
        unreadable.add(backend)
      }
    }
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
      const received = requestHeaders(req.headers)
      for (const name of ['cookie', 'proxy-authorization', 'x-api-key', 'chatgpt-account-id'])
        if (received[name]) received[name] = '[redacted]'
      if (received.authorization)
        received.authorization =
          req.headers.authorization === expected.toString() ? '[local key]' : '[other]'
      record.request = { headers: received, bytes: size }
      if (size > REQUEST_LIMIT) return answer(413, 'request too large')
      const presented = Buffer.from(req.headers.authorization ?? '')
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
        return answer(401, 'local key required')
      let decoded
      try {
        decoded = decodeBody(body, req.headers['content-encoding'], REQUEST_LIMIT)
      } catch (error) {
        if (error.code === 'UNSUPPORTED_ENCODING')
          return answer(415, 'unsupported content encoding')
        if (error.code === 'ERR_BUFFER_TOO_LARGE') return answer(413, 'decoded request too large')
        return answer(400, 'invalid compressed request')
      }
      // Decode before stripping fields: compressed CLI requests follow the same policy.
      // What the CLI sent, refused paths included: finding those is half of the spike.
      if (decoded.length > 0) record.request.body = json(decoded.toString('utf8'))
      const [path, query = ''] = req.url.split(/\?(.*)/s)
      const route = ROUTES.get(`${req.method} ${path}`)
      const local = req.socket.localPort
      if (![`127.0.0.1:${local}`, `localhost:${local}`].includes(req.headers.host))
        return answer(403, 'host not allowed')
      if (!route) return answer(403, 'path not allowed')
      if (codexAdapter && (route.backend !== 'codex' || path !== '/codex/responses'))
        return answer(403, 'adapter route not allowed')
      if (query && (req.method !== 'GET' || !/^[\w.=&%+-]{1,256}$/.test(query)))
        return answer(403, 'query not allowed')
      if (unreadable.has(route.backend))
        return answer(503, `${route.backend} credentials unavailable`)
      const credential = available.get(route.backend)
      if (!credential) return answer(503, `${route.backend} credentials are not configured`)

      let headers = {}
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
      if (
        route.backend === 'codex' &&
        req.headers['x-openai-internal-codex-responses-lite'] === 'true'
      )
        headers['x-openai-internal-codex-responses-lite'] = 'true'
      if (route.path.endsWith('/codex/responses')) headers.accept = 'text/event-stream'
      headers['accept-encoding'] = 'identity'

      let payload = decoded
      let prepared
      let target = new URL(`${route.path}${query ? `?${query}` : ''}`, origins[route.backend])
      if (codexAdapter) {
        try {
          const clientHeaders = new Headers()
          for (const [name, value] of Object.entries(req.headers))
            if (typeof value === 'string') clientHeaders.set(name, value)
          prepared = codexAdapter.prepare({
            body: decoded,
            headers: clientHeaders,
            credential: credential.credential,
          })
          if (
            prepared.url !== `${ORIGINS.codex}/backend-api/codex/responses` ||
            prepared.method !== 'POST'
          )
            throw new Error('unexpected adapter target')
          // Default uses exactly the adapter's fixed URL. `origins` is a synthetic test seam.
          target = origins.codex === ORIGINS.codex ? new URL(prepared.url) : target
          payload = Buffer.from(prepared.body)
          headers = Object.fromEntries(prepared.headers)
          record.request.stripped = STRIPPED.fields.filter((field) =>
            Object.hasOwn(record.request.body ?? {}, field),
          )
          record.adapter = { normalized: true }
        } catch (error) {
          record.adapter = {
            normalized: false,
            ...(error.policy ? { policy: error.policy } : {}),
            error: [
              'AUTH_EXPIRED',
              'ADAPTER_CREDENTIAL_INVALID',
              'ADAPTER_REQUEST_REJECTED',
            ].includes(error.code)
              ? error.code
              : 'ADAPTER_REQUEST_REJECTED',
          }
          return answer(error.code === 'AUTH_EXPIRED' ? 401 : 400, 'adapter rejected request')
        }
      } else if (route.backend === 'codex' && decoded.length > 0) {
        let parsed = null
        try {
          parsed = JSON.parse(decoded.toString('utf8'))
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
        ...requestHeaders(headers),
        authorization: '[subscription]',
        ...(headers['chatgpt-account-id'] ? { 'chatgpt-account-id': '[account]' } : {}),
      }

      const controller = new AbortController()
      let transportEnd
      let capture = () => {}
      const abort = (reason) => {
        transportEnd ??= reason
        controller.abort()
      }
      const clientClose = () => {
        if (!res.writableFinished) abort('client_close')
      }
      const timer = setTimeout(() => abort('timeout'), 10 * 60 * 1000)
      res.on('close', clientClose)
      try {
        await new Promise((resolve, reject) => {
          const fail = (error, reason = 'error') => {
            transportEnd ??= reason
            reject(error)
          }
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
              response.on('error', (error) => fail(error))
              const status = response.statusCode ?? 502
              const upstreamHeaders = { ...response.headers }
              delete upstreamHeaders['set-cookie']
              record.response = { status, headers: responseHeaders(upstreamHeaders) }
              if (
                prepared &&
                response.headers['content-encoding'] &&
                response.headers['content-encoding'] !== 'identity'
              ) {
                response.destroy()
                fail(
                  Object.assign(new Error('unexpected encoding'), {
                    code: 'ADAPTER_RESPONSE_ENCODING',
                  }),
                )
                return
              }
              if (status >= 300 && status < 400) {
                response.destroy()
                fail(new Error('redirect'))
                return
              }
              const back = {}
              for (const name of BACK)
                if (typeof response.headers[name] === 'string') back[name] = response.headers[name]
              res.writeHead(status, back)
              const saved = []
              let savedBytes = 0
              response.on('data', (chunk) => {
                try {
                  prepared?.meter.push(chunk)
                } catch {
                  const error = Object.assign(new Error('invalid adapter stream'), {
                    code: 'ADAPTER_STREAM_INVALID',
                  })
                  fail(error)
                  response.destroy(error)
                  return
                }
                const remaining = RECORD_LIMIT - savedBytes
                if (remaining > 0) saved.push(chunk.subarray(0, remaining))
                savedBytes += chunk.length
              })
              capture = () => {
                Object.assign(record.response, {
                  bytes: savedBytes,
                  ms: Date.now() - started,
                  transport_end: transportEnd,
                })
                if (savedBytes > RECORD_LIMIT) record.response.truncated = true
                try {
                  const raw = decodeBody(
                    Buffer.concat(saved),
                    response.headers['content-encoding'],
                    RECORD_LIMIT,
                  )
                  const streamRoute =
                    route.path.endsWith('/codex/responses') ||
                    route.path.endsWith('/chat/completions')
                  const inferSse =
                    status >= 200 &&
                    status < 300 &&
                    streamRoute &&
                    (headers.accept?.includes('text/event-stream') ||
                      record.request.body?.stream === true)
                  Object.assign(
                    record.response,
                    readBody(raw, response.headers['content-type'], inferSse),
                  )
                } catch (error) {
                  // Recording must not crash the proxy on malformed or oversized replies.
                  // Keep only the code; a decompressor's message can contain provider data.
                  record.response.decode_error = error.code ?? 'decode_failed'
                }
                const terminal = terminalOf(record.response)
                record.response.terminal_event = terminal
                record.response.usage = usageOf(record.response)
                record.response.outcome = terminal
                  ? terminal === '[DONE]' || terminal === 'response.completed'
                    ? 'completed'
                    : terminal === 'response.failed'
                      ? 'failed'
                      : 'incomplete'
                  : transportEnd === 'client_close'
                    ? 'client_aborted'
                    : transportEnd !== 'end'
                      ? 'upstream_error'
                      : record.response.events
                        ? 'missing_terminal'
                        : 'http_complete'
              }
              response.on('aborted', () =>
                fail(Object.assign(new Error('upstream aborted'), { code: 'UPSTREAM_ABORTED' })),
              )
              response.on('close', () => {
                if (!response.complete)
                  fail(
                    Object.assign(new Error('upstream closed'), { code: 'UPSTREAM_CLOSED' }),
                    'close',
                  )
              })
              response.on('end', () => {
                transportEnd ??= 'end'
                resolve()
              })
              // pipe applies backpressure when a CLI stops reading the provider's stream.
              response.pipe(res)
            },
          )
          upstream.on('error', (error) => fail(error))
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
        res.off('close', clientClose)
        capture()
        if (prepared) {
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(record.response?.headers ?? {}))
            if (typeof value === 'string') responseHeaders.set(name, value)
          record.adapter.meter = prepared.meter.end()
          record.adapter.signal = codexAdapter.classify(
            record.response?.status ?? 502,
            responseHeaders,
            record.response?.body ?? null,
          )
          record.adapter.windows = codexAdapter.windowsFromHeaders(responseHeaders)
        }
        // Codex closes the HTTP stream as soon as it receives response.completed.
        // This is a completed provider response, not an abandoned model call.
        if (transportEnd === 'client_close' && record.response?.terminal_event) delete record.error
      }
      write()
    })
  })
}

/**
 * Where the record goes. An unreviewed live record must never sit next to the sources (rule 1),
 * and `.gitignore` covers only the old default name. So the directory may not be inside a git
 * working copy: neither an explicit RECORD_DIR nor, without it, the fresh private directory
 * made in the system's temporary directory.
 */
export function recordDirectory(configured) {
  // The nearest existing ancestor, through symbolic links, plus the part still to be created.
  const wanted = resolve(configured || tmpdir())
  let existing = wanted
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  const directory = join(realpathSync(existing), relative(existing, wanted))
  for (let at = directory; ; at = dirname(at)) {
    // `.git` is a directory in a clone and a file in a linked worktree or a submodule.
    if (existsSync(join(at, '.git')))
      throw new Error(
        configured
          ? 'RECORD_DIR is inside a git working copy: name a directory outside it, or leave RECORD_DIR unset'
          : 'the temporary directory is inside a git working copy: set RECORD_DIR to a directory outside it',
      )
    if (dirname(at) === at) break
  }
  if (!configured) return mkdtempSync(join(directory, 'raditi-spike-records-'))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
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
      const recordDir = recordDirectory(env.RECORD_DIR)
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
