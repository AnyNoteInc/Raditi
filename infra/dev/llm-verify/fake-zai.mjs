import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Synthetic Z.ai, the GLM Coding Plan only: the chat path and the quota path, in the shapes of
// the recorded exchanges (docs/research/2026-10-opencode-glm/samples; the adapter's fixtures are
// copies of them) and with the error codes of the provider's documentation. It makes no outbound
// request and keeps what it received in memory only. A request record never holds a credential:
// it says whether the plan key came, and the names of the headers.
export const SYNTHETIC_ZAI_KEY = 'zai-synthetic-plan-key-for-stands-only'
/** Stands in every text a real provider would write: it must never reach a sandbox or a log. */
export const SYNTHETIC_ZAI_MARKER = 'synthetic-zai-provider-text-canary'
export const ZAI_PATHS = Object.freeze({
  chat: '/api/coding/paas/v4/chat/completions',
  quota: '/api/monitor/usage/quota/limit',
})
/** What the coding path listed for the probe's key (sample 24). */
export const ZAI_MODELS = Object.freeze([
  'glm-4.5',
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.3-flashx',
  'glm-5-turbo',
])

/**
 * The codes of decision 9 of the pivot plan with the status the fake answers them with. Measured:
 * 401 (HTTP 401), 1001 (401), 1113 (429), 1210 and 1211 (400). The statuses of the other codes
 * were not observed and are assumptions; the adapter reads the code, whatever the status.
 */
export const ZAI_ERROR_STATUS = Object.freeze({
  401: 401,
  1001: 401,
  1113: 429,
  1210: 400,
  1211: 400,
  1261: 400,
  1301: 400,
  1302: 429,
  1305: 429,
  1308: 429,
  1309: 429,
  1310: 429,
  1311: 403,
  1313: 429,
  1316: 429,
  1317: 429,
})
/** The six values of the documentation, and `content_filter` of the common protocol. */
const FINISH_REASONS = new Set([
  'stop',
  'tool_calls',
  'length',
  'sensitive',
  'network_error',
  'model_context_window_exceeded',
  'content_filter',
])
// How a chat request is answered. The hostile ones are for the gateway's own tests.
const SCENARIOS = new Set([
  // A stream: reasoning, text, the last chunk with finish_reason and usage, DONE.
  'text',
  // The first answer calls the given tools (two calls in one answer when two are given); once
  // the request ends with a tool result, the answer is the text.
  'tools',
  // A stream that ends with the given finish_reason.
  'finish',
  // An error with a status: `code` of ZAI_ERROR_STATUS, or any `code` with a `status`.
  'error',
  // An error object inside a started stream.
  'stream_error',
  // HTTP 200, application/json, `{code, msg, success: false}`: how the monitor paths answer.
  'envelope200',
  // HTTP 200, application/json, a finished `chat.completion` with usage instead of a stream.
  'plain200',
  // Streams that break the protocol.
  'no_usage',
  'no_done',
  'done_only',
  'no_finish',
  'no_finish_no_done',
  'empty',
  'cut',
])
const DEFAULT_USAGE = Object.freeze({ prompt: 7105, cached: 6784, completion: 94, reasoning: 54 })
const WINDOWS = Object.freeze([
  Object.freeze({ name: 'fiveHour', unit: 3, number: 5, usage: 2000, lengthMs: 5 * 3_600_000 }),
  Object.freeze({ name: 'week', unit: 6, number: 1, usage: 10_000, lengthMs: 7 * 86_400_000 }),
])

const invalid = (what) => new Error(`Invalid ${what}`)
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const whole = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max

function scenarioOptions(value = {}) {
  if (!isRecord(value)) throw invalid('scenario')
  const known = new Set([
    'scenario',
    'text',
    'reasoning',
    'calls',
    'finish',
    'code',
    'status',
    'retryAfter',
    'failures',
    'usage',
    'delayMs',
  ])
  for (const name of Object.keys(value)) if (!known.has(name)) throw invalid('scenario')
  const scenario = value.scenario ?? 'text'
  if (!SCENARIOS.has(scenario)) throw invalid('scenario')
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 16_384))
    throw invalid('text')
  if (
    value.reasoning !== undefined &&
    (typeof value.reasoning !== 'string' || value.reasoning.length > 16_384)
  )
    throw invalid('reasoning')
  if (value.calls !== undefined) {
    if (
      scenario !== 'tools' ||
      !Array.isArray(value.calls) ||
      value.calls.length < 1 ||
      value.calls.length > 8 ||
      !value.calls.every(
        (call) =>
          isRecord(call) &&
          typeof call.name === 'string' &&
          /^[A-Za-z0-9_.-]{1,64}$/.test(call.name) &&
          isRecord(call.arguments),
      )
    )
      throw invalid('calls')
  }
  if (value.finish !== undefined) {
    // Any value: the gateway must also cope with one nobody has documented.
    if (
      scenario !== 'finish' ||
      typeof value.finish !== 'string' ||
      !/^[A-Za-z_]{1,64}$/.test(value.finish)
    )
      throw invalid('finish')
  } else if (scenario === 'finish') throw invalid('finish')
  const failing = ['error', 'stream_error', 'envelope200'].includes(scenario)
  if (value.code !== undefined || failing) {
    if (!failing || !whole(value.code, 999_999)) throw invalid('code')
    if (scenario === 'error' && value.status === undefined && !ZAI_ERROR_STATUS[value.code])
      throw invalid('status')
  }
  if (
    value.status !== undefined &&
    (scenario !== 'error' ||
      !Number.isInteger(value.status) ||
      value.status < 400 ||
      value.status > 599)
  )
    throw invalid('status')
  if (
    value.retryAfter !== undefined &&
    (typeof value.retryAfter !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(value.retryAfter))
  )
    throw invalid('retry-after')
  if (value.failures !== undefined && (!whole(value.failures, 100) || value.failures < 1))
    throw invalid('failure count')
  if (value.delayMs !== undefined && !whole(value.delayMs, 120_000)) throw invalid('delay')
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw invalid('usage')
    for (const [name, count] of Object.entries(value.usage))
      if (!Object.hasOwn(DEFAULT_USAGE, name) || !whole(count, 1_000_000_000))
        throw invalid('usage')
    const usage = { ...DEFAULT_USAGE, ...value.usage }
    if (usage.cached > usage.prompt || usage.reasoning > usage.completion) throw invalid('usage')
  }
  return { ...value, scenario }
}

function quotaOptions(value = {}) {
  if (!isRecord(value)) throw invalid('quota')
  for (const name of Object.keys(value))
    if (!['mode', 'code', 'level', 'credits', 'fiveHour', 'week'].includes(name))
      throw invalid('quota')
  // live: the windows follow the chat requests. broken: an answer that cannot be read.
  // envelope: `{code, msg, success: false}` with HTTP 200.
  if (value.mode !== undefined && !['live', 'broken', 'envelope'].includes(value.mode))
    throw invalid('quota mode')
  if (value.mode === 'envelope' ? !whole(value.code, 999_999) : value.code !== undefined)
    throw invalid('quota code')
  if (value.level !== undefined && !/^[a-z0-9_-]{1,32}$/.test(String(value.level)))
    throw invalid('quota level')
  if (value.credits !== undefined && !whole(value.credits, 10_000)) throw invalid('quota credits')
  for (const name of ['fiveHour', 'week']) {
    const window = value[name]
    if (window === undefined) continue
    if (!isRecord(window)) throw invalid('quota window')
    for (const field of Object.keys(window))
      if (!['currentValue', 'remaining', 'resetInMs', 'idle', 'exhausted'].includes(field))
        throw invalid('quota window')
    for (const field of ['currentValue', 'remaining'])
      if (window[field] !== undefined && !Number.isSafeInteger(window[field]))
        throw invalid('quota window')
    if (window.resetInMs !== undefined && !Number.isSafeInteger(window.resetInMs))
      throw invalid('quota window')
  }
  return value
}

/** The state of one synthetic plan key: its scenario, its windows and what it was asked. */
export function createFakeZaiState(initial = {}) {
  const state = {
    requests: [],
    counters: { chat: 0, quota: 0, generated: 0 },
    config: {},
    attempts: 0,
    quota: {},
    setScenario(options = {}) {
      state.config = scenarioOptions(options)
      state.attempts = 0
      return state.snapshot()
    },
    /**
     * `idle` puts a window back where nobody has started it, `exhausted` spends it whole; the
     * numbers of a window may also be given one by one, `resetInMs` from now (negative: a reset
     * that has passed).
     */
    setQuota(options = {}) {
      const parsed = quotaOptions(options)
      const quota = state.quota
      if (parsed.mode !== undefined) quota.mode = parsed.mode
      quota.code = parsed.mode === 'envelope' ? parsed.code : undefined
      if (parsed.level !== undefined) quota.level = String(parsed.level)
      if (parsed.credits !== undefined) quota.credits = parsed.credits
      for (const { name, usage, lengthMs } of WINDOWS) {
        const given = parsed[name]
        if (!given) continue
        const window = quota[name]
        if (given.idle) Object.assign(window, { currentValue: 0, remaining: usage, reset: null })
        if (given.exhausted)
          Object.assign(window, {
            currentValue: usage,
            remaining: 0,
            reset: Date.now() + Math.floor(lengthMs / 2),
          })
        if (given.currentValue !== undefined) window.currentValue = given.currentValue
        if (given.remaining !== undefined) window.remaining = given.remaining
        if (given.resetInMs !== undefined) window.reset = Date.now() + given.resetInMs
      }
      return state.snapshot()
    },
    reset(options = {}) {
      if (!isRecord(options)) throw invalid('reset')
      state.requests.length = 0
      state.counters = { chat: 0, quota: 0, generated: 0 }
      // After a night without requests: the five-hour window is not started, the week runs.
      state.quota = {
        mode: 'live',
        code: undefined,
        level: 'lite',
        credits: 1,
        fiveHour: { currentValue: 0, remaining: 2000, reset: null },
        week: { currentValue: 25, remaining: 9974, reset: Date.now() + 6 * 86_400_000 },
      }
      state.setScenario(options.scenario ?? {})
      if (options.quota !== undefined) state.setQuota(options.quota)
      return state.snapshot()
    },
    /** `{reset?, scenario?, quota?}`: the one message of the control port. */
    configure(options = {}) {
      if (!isRecord(options)) throw invalid('configuration')
      for (const name of Object.keys(options))
        if (!['reset', 'scenario', 'quota'].includes(name)) throw invalid('configuration')
      if (options.reset) state.reset({})
      if (options.scenario !== undefined) state.setScenario(options.scenario)
      if (options.quota !== undefined) state.setQuota(options.quota)
      return state.snapshot()
    },
    snapshot() {
      return {
        requests: state.requests,
        counters: state.counters,
        config: state.config,
        quota: state.quota,
      }
    },
  }
  state.reset(initial)
  return state
}

/** A generation was counted by the provider: the windows move as the records show. */
function spend(state) {
  const quota = state.quota
  for (const { name, usage, lengthMs } of WINDOWS) {
    const window = quota[name]
    if (window.reset === null || window.reset <= Date.now()) {
      // The first request starts the window: `remaining` drops by one, `currentValue` stays 0
      // (samples 60 and 62).
      Object.assign(window, { currentValue: 0, remaining: usage - 1, reset: Date.now() + lengthMs })
    } else {
      window.currentValue += quota.credits
      window.remaining -= quota.credits
    }
  }
}
const exhausted = (state) =>
  WINDOWS.some(({ name }) => {
    const window = state.quota[name]
    return window.reset !== null && window.reset > Date.now() && window.remaining <= 0
  })

const providerHeaders = (sequence) => ({
  'x-log-id': `synthetic-zai-log-${sequence}`,
  'x-request-id': `synthetic-zai-request-${sequence}`,
  'ga-traceid': `synthetic-zai-trace-${sequence}`,
  'set-cookie': `acw_tc=synthetic-zai-cookie-${sequence};path=/;HttpOnly;Max-Age=1800`,
  vary: 'Origin',
  'alt-svc': 'h3=":443"; ma=3600',
})
function json(res, status, body, headers = {}, contentType = 'application/json') {
  res.writeHead(status, { ...(contentType ? { 'content-type': contentType } : {}), ...headers })
  res.end(JSON.stringify(body))
}
const providerText = (text) => `${text} ${SYNTHETIC_ZAI_MARKER}`
function chatError(res, sequence, code, status, retryAfter) {
  // The recorded 400 answers carry no content-type; 401 and 429 name application/json.
  json(
    res,
    status,
    { error: { code: String(code), message: providerText('Synthetic provider refusal.') } },
    { ...providerHeaders(sequence), ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
    status === 400 ? null : 'application/json',
  )
}

const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const usageOf = (config) => {
  const usage = { ...DEFAULT_USAGE, ...config.usage }
  return {
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    total_tokens: usage.prompt + usage.completion,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  }
}

/**
 * The frames of one answer in the recorded order: reasoning, text or tool calls (each call
 * whole in one chunk), the last chunk with finish_reason and usage together, DONE.
 */
export function zaiFrames(body, config, sequence) {
  const base = {
    id: `2026010100000000000000${String(sequence).padStart(8, '0')}`,
    created: Math.floor(Date.now() / 1000),
    object: 'chat.completion.chunk',
    model: body.model,
  }
  const chunk = (delta, finish, usage) => ({
    ...base,
    choices: [{ index: 0, ...(finish ? { finish_reason: finish } : {}), delta }],
    ...(usage ? { usage } : {}),
  })
  const answered = Array.isArray(body.messages) && body.messages.at(-1)?.role === 'tool'
  const calling = config.scenario === 'tools' && !answered
  const calls = config.calls ?? [{ name: 'bash', arguments: { command: 'echo synthetic' } }]
  const frames = []
  const reasoning = config.reasoning ?? 'Synthetic reasoning.'
  for (const word of reasoning.split(/(?<= )/).filter(Boolean))
    frames.push(frame(chunk({ role: 'assistant', reasoning_content: word })))
  if (calling)
    calls.forEach((call, index) =>
      frames.push(
        frame(
          chunk({
            tool_calls: [
              {
                id: `call_${String(sequence * 100 + index + 1).padStart(24, '0')}`,
                index,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }),
        ),
      ),
    )
  else
    for (const word of (config.text ?? 'Synthetic Z.ai answer.').split(/(?<= )/).filter(Boolean))
      frames.push(frame(chunk({ role: 'assistant', content: word })))
  const finish = config.scenario === 'finish' ? config.finish : calling ? 'tool_calls' : 'stop'
  return {
    body: frames,
    last: frame(chunk({ role: 'assistant', content: '' }, finish, usageOf(config))),
    lastWithoutUsage: frame(chunk({ role: 'assistant', content: '' }, finish)),
    done: frame('[DONE]'),
  }
}

async function readJson(req, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw invalid('body')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

/** Which credential a request carried, without its value. The quota path takes a bare key too. */
function credentialOf(req, bare) {
  const value = req.headers.authorization
  if (value === undefined) return 'none'
  if (value === `Bearer ${SYNTHETIC_ZAI_KEY}` || (bare && value === SYNTHETIC_ZAI_KEY))
    return 'plan-key'
  return 'other'
}

export const isZaiRequest = (req) =>
  Object.values(ZAI_PATHS).includes(new URL(req.url, 'https://synthetic.invalid').pathname)

/** Answers a request to one of the two Z.ai paths; the caller has checked `isZaiRequest`. */
export async function handleZai(req, res, state) {
  const path = new URL(req.url, 'https://synthetic.invalid').pathname
  const quotaPath = path === ZAI_PATHS.quota
  const record = {
    method: req.method,
    path,
    credential: credentialOf(req, quotaPath),
    headerNames: Object.keys(req.headers).sort(),
    // Values that are no secret and that the gateway's checks compare.
    userAgent: req.headers['user-agent'] ?? null,
    accept: req.headers.accept ?? null,
    acceptEncoding: req.headers['accept-encoding'] ?? null,
    contentType: req.headers['content-type'] ?? null,
    body: null,
    status: null,
    completed: false,
    aborted: false,
  }
  if (state.requests.length < 1000) state.requests.push(record)
  res.on('finish', () => {
    record.completed = true
    record.status = res.statusCode
  })
  res.on('close', () => {
    if (!res.writableFinished) record.aborted = true
  })
  if (quotaPath) return answerQuota(req, res, state, record)
  if (req.method !== 'POST') {
    req.resume()
    return json(res, 405, { error: { code: '1222', message: providerText('Synthetic.') } })
  }
  const body = await readJson(req)
  record.body = body
  const sequence = ++state.counters.chat
  if (record.credential !== 'plan-key')
    return chatError(res, sequence, record.credential === 'none' ? 1001 : 401, 401)
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0)
    return chatError(res, sequence, 1210, 400)
  if (!ZAI_MODELS.includes(body.model)) return chatError(res, sequence, 1211, 400)
  if (
    body.max_tokens !== undefined &&
    (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 131_072)
  )
    return chatError(res, sequence, 1210, 400)
  const config = state.config
  const failing = ++state.attempts <= (config.failures ?? Infinity)
  const scenario = failing || config.failures === undefined ? config.scenario : 'text'
  if (scenario === 'error')
    return chatError(
      res,
      sequence,
      config.code,
      config.status ?? ZAI_ERROR_STATUS[config.code],
      config.retryAfter,
    )
  // A spent window refuses before any generation, with the code of the documentation.
  if (exhausted(state)) return chatError(res, sequence, 1308, 429)
  if (scenario === 'envelope200')
    return json(
      res,
      200,
      { code: config.code, msg: providerText('Synthetic envelope.'), success: false },
      providerHeaders(sequence),
    )
  state.counters.generated++
  spend(state)
  const effective = scenario === config.scenario ? config : { ...config, scenario }
  const frames = zaiFrames(body, effective, sequence)
  if (scenario === 'plain200' || body.stream !== true) {
    // The whole answer as one object: what a request without `stream` gets (sample 61).
    return json(
      res,
      200,
      {
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {
              content: effective.text ?? 'Synthetic Z.ai answer.',
              reasoning_content: effective.reasoning ?? 'Synthetic reasoning.',
              role: 'assistant',
            },
          },
        ],
        created: Math.floor(Date.now() / 1000),
        id: `2026010100000000000000${String(sequence).padStart(8, '0')}`,
        model: body.model,
        object: 'chat.completion',
        request_id: `2026010100000000000000${String(sequence).padStart(8, '0')}`,
        usage: usageOf(effective),
      },
      providerHeaders(sequence),
      'application/json; charset=UTF-8',
    )
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream;charset=UTF-8',
    ...providerHeaders(sequence),
    ...(config.retryAfter ? { 'retry-after': config.retryAfter } : {}),
  })
  if (config.delayMs) {
    const cancelled = new AbortController()
    const onClose = () => cancelled.abort()
    res.once('close', onClose)
    try {
      await delay(config.delayMs, undefined, { signal: cancelled.signal })
    } catch {
      return
    } finally {
      res.off('close', onClose)
    }
  }
  const text = frames.body.join('')
  if (scenario === 'stream_error')
    return res.end(
      frames.body[0] +
        frame({
          error: {
            code: String(config.code),
            message: providerText('Synthetic stream refusal.'),
          },
        }),
    )
  if (scenario === 'empty') return res.end()
  if (scenario === 'done_only') return res.end(frames.done)
  if (scenario === 'no_finish') return res.end(text + frames.done)
  if (scenario === 'no_finish_no_done') return res.end(text)
  if (scenario === 'no_usage') return res.end(text + frames.lastWithoutUsage + frames.done)
  if (scenario === 'no_done') return res.end(text + frames.last)
  if (scenario === 'cut') {
    res.write(text)
    // Let the bytes leave before the socket goes.
    await delay(20)
    return res.destroy()
  }
  res.end(text + frames.last + frames.done)
}

function answerQuota(req, res, state, record) {
  req.resume()
  const sequence = ++state.counters.quota
  const headers = providerHeaders(`quota-${sequence}`)
  const type = 'application/json;charset=UTF-8'
  if (req.method !== 'GET')
    return json(
      res,
      200,
      { code: 500, msg: '405 METHOD_NOT_ALLOWED', success: false },
      headers,
      type,
    )
  // The monitor paths answer every error with HTTP 200 (samples 10, 10b, 14).
  if (record.credential === 'none')
    return json(
      res,
      200,
      {
        code: 1001,
        msg: 'Authentication parameter not received in Header, unable to authenticate',
        success: false,
      },
      headers,
      type,
    )
  if (record.credential !== 'plan-key')
    return json(
      res,
      200,
      { code: 401, msg: 'token expired or incorrect', success: false },
      headers,
      type,
    )
  const quota = state.quota
  if (quota.mode === 'envelope')
    return json(
      res,
      200,
      { code: quota.code, msg: providerText('Synthetic envelope.'), success: false },
      headers,
      type,
    )
  if (quota.mode === 'broken')
    return json(
      res,
      200,
      { code: 200, msg: 'Operation successful', data: { limits: 'synthetic' }, success: true },
      headers,
      type,
    )
  json(
    res,
    200,
    {
      code: 200,
      msg: 'Operation successful',
      data: {
        limits: WINDOWS.map(({ name, unit, number, usage }) => {
          const window = quota[name]
          const spent = usage - window.remaining
          return {
            type: 'CREDIT_LIMIT',
            unit,
            number,
            usage,
            currentValue: window.currentValue,
            remaining: window.remaining,
            // Rounded up to a whole percent, as the provider does (1 for 0.05 %).
            percentage: Math.min(100, Math.max(0, Math.ceil((spent * 100) / usage))),
            // A window nobody has started names no reset.
            ...(window.reset === null ? {} : { nextResetTime: window.reset }),
          }
        }),
        level: quota.level,
      },
      success: true,
    },
    headers,
    type,
  )
}

/** The control port's one message and the state, shared with fake-subscriptions.mjs. */
export async function handleZaiControl(req, res, state) {
  if (req.method === 'GET') {
    req.resume()
    return json(res, 200, state.snapshot())
  }
  if (req.method !== 'POST') {
    req.resume()
    return json(res, 405, { error: 'method_not_allowed' })
  }
  let options
  try {
    options = (await readJson(req, 256 * 1024)) ?? {}
    return json(res, 200, state.configure(options))
  } catch {
    return json(res, 400, { error: 'invalid_configuration' })
  }
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

/** Z.ai alone: a TLS provider and an HTTP control port (`GET /`, `POST /`), both on loopback. */
export async function startFakeZai({
  host = '127.0.0.1',
  port = 0,
  key,
  cert,
  controlHost = '127.0.0.1',
  controlPort = 0,
  ...initial
} = {}) {
  if (!key || !cert) throw new Error('Synthetic provider requires TLS key and certificate')
  const state = createFakeZaiState(initial)
  const provider = createHttpsServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    if (!isZaiRequest(req)) {
      req.resume()
      // An unknown path of the provider: HTTP 200 with the envelope (sample 14).
      return json(res, 200, { code: 500, msg: '404 NOT_FOUND', success: false })
    }
    handleZai(req, res, state).catch(() => {
      if (res.headersSent) res.destroy()
      else json(res, 400, { error: { code: '1210', message: providerText('Synthetic.') } })
    })
  })
  const control = createHttpServer((req, res) => {
    handleZaiControl(req, res, state).catch(() => {
      if (res.headersSent) res.destroy()
      else json(res, 400, { error: 'invalid_control' })
    })
  })
  try {
    await listen(provider, port, host)
    await listen(control, controlPort, controlHost)
  } catch (error) {
    await Promise.all([provider, control].map(close))
    throw error
  }
  return {
    state,
    address: address(provider, host, 'https'),
    controlAddress: address(control, controlHost, 'http'),
    close: async () => {
      await Promise.all([provider, control].map(close))
    },
  }
}

async function main(args) {
  const names = {
    '--host': 'host',
    '--port': 'port',
    '--control-host': 'controlHost',
    '--control-port': 'controlPort',
    '--tls-key': 'tlsKey',
    '--tls-cert': 'tlsCert',
  }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]]
    if (!name || !args[i + 1] || Object.hasOwn(options, name)) throw new Error('Invalid arguments')
    const port = ['port', 'controlPort'].includes(name)
    options[name] = port ? Number(args[i + 1]) : args[i + 1]
    if (port && (!Number.isInteger(options[name]) || options[name] < 0 || options[name] > 65535))
      throw new Error('Invalid port')
  }
  if (!options.tlsKey || !options.tlsCert) throw new Error('Invalid arguments')
  const { tlsKey, tlsCert, ...listenOptions } = options
  const fake = await startFakeZai({
    ...listenOptions,
    key: readFileSync(tlsKey),
    cert: readFileSync(tlsCert),
  })
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: fake.address.port, controlPort: fake.controlAddress.port })}\n`,
  )
  let closing = false
  const stop = () => {
    if (closing) return
    closing = true
    void fake.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Synthetic Z.ai failed.\n')
    process.exitCode = 1
  })
