import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { contentCall, contentOptions } from './content-scenario.mjs'

// Synthetic Z.ai: the GLM Coding Plan — its chat path and the quota path — and the pay-per-token
// API on its own chat path, in the shapes of the recorded exchanges (docs/research/
// 2026-10-opencode-glm/samples; the adapter's fixtures are copies of them) and with the error
// codes of the provider's documentation. It makes no outbound request and keeps what it received
// in memory only. A request record never holds a credential: it says which of the keys came, and
// the names of the headers.
export const SYNTHETIC_ZAI_KEY = 'zai-synthetic-plan-key-for-stands-only'
/** The key an operator issues instead of the first one; the fake takes one of the two at a time. */
export const SYNTHETIC_ZAI_ROTATED_KEY = 'zai-synthetic-rotated-plan-key-for-stands-only'
const PLAN_KEYS = Object.freeze({ first: SYNTHETIC_ZAI_KEY, rotated: SYNTHETIC_ZAI_ROTATED_KEY })
/**
 * A key of the pay-per-token API, and the one issued instead of it: one of the two is taken at a
 * time. The synthetic world keeps the keys of the two offers apart, so that a key on the path of
 * the other offer is answered as sample 21 shows (a key without money there); a real key of Z.ai
 * works on both paths, and the owner's one has a balance (decision of 17.10.2026, П83).
 */
export const SYNTHETIC_ZAI_API_KEY = 'zai-synthetic-api-key-for-stands-only'
export const SYNTHETIC_ZAI_ROTATED_API_KEY = 'zai-synthetic-rotated-api-key-for-stands-only'
const API_KEYS = Object.freeze({
  first: SYNTHETIC_ZAI_API_KEY,
  rotated: SYNTHETIC_ZAI_ROTATED_API_KEY,
})
/** Stands in every text a real provider would write: it must never reach a sandbox or a log. */
export const SYNTHETIC_ZAI_MARKER = 'synthetic-zai-provider-text-canary'
export const ZAI_PATHS = Object.freeze({
  chat: '/api/coding/paas/v4/chat/completions',
  apiChat: '/api/paas/v4/chat/completions',
  quota: '/api/monitor/usage/quota/limit',
})
const CHAT_PATHS = new Set([ZAI_PATHS.chat, ZAI_PATHS.apiChat])
/** The text of sample 21: the answer of the API path to an account without money. */
const NO_BALANCE = 'Insufficient balance or no resource package. Please recharge.'
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
  // The answer calls the given tools (two calls in one answer when two are given): `calls` is
  // one round, `rounds` a list of them. The round is the number of tool steps the request holds
  // since the last message of the user; past the last round, and for a request that declares
  // no tool (the CLI's context compaction), the answer is the text. With `beside` an answer
  // that calls says that sentence first, in the same answer: the form the real model showed
  // (sample 81-g6-live-content/02). With `filler` an answer that calls thinks that many bytes
  // first: the CLI sends the reasoning of a step back with the next request of the turn, which
  // is how a stand gets a request larger than the gateway takes.
  'tools',
  // The agent-content stand: the model drives the platform MCP tool `wp_rest`, one call an
  // answer, by the name the CLI declared for it. The rounds are those of `tools`; what each
  // one calls is content-scenario.mjs.
  'content_edit',
  'content_forbidden',
  // A stream that ends with the given finish_reason.
  'finish',
  // An error with a status: `code` of ZAI_ERROR_STATUS, or any `code` with a `status`, or a
  // `status` alone — an error object that names no code.
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
/** The most an answer thinks as filler, and the size of one chunk of it. */
const MAX_FILLER_BYTES = 32 * 1024 * 1024
const FILLER_CHUNK_BYTES = 64 * 1024
const WINDOWS = Object.freeze([
  Object.freeze({ name: 'fiveHour', unit: 3, number: 5, usage: 2000, lengthMs: 5 * 3_600_000 }),
  Object.freeze({ name: 'week', unit: 6, number: 1, usage: 10_000, lengthMs: 7 * 86_400_000 }),
])

const invalid = (what) => new Error(`Invalid ${what}`)
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const whole = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max

const SCENARIO_OPTIONS = new Set([
  'scenario',
  'text',
  'reasoning',
  'calls',
  'rounds',
  'beside',
  'filler',
  'finish',
  'code',
  'status',
  'retryAfter',
  'failures',
  'usage',
  'delayMs',
  'route',
  'idempotencyKey',
  'body',
])
const longText = (value) => typeof value !== 'string' || value.length > 16_384
const callList = (calls) =>
  Array.isArray(calls) &&
  calls.length >= 1 &&
  calls.length <= 8 &&
  calls.every(
    (call) =>
      isRecord(call) &&
      typeof call.name === 'string' &&
      /^[A-Za-z0-9_.-]{1,64}$/.test(call.name) &&
      isRecord(call.arguments),
  )

function scenarioOptions(value = {}) {
  if (!isRecord(value)) throw invalid('scenario')
  for (const name of Object.keys(value)) if (!SCENARIO_OPTIONS.has(name)) throw invalid('scenario')
  const scenario = value.scenario ?? 'text'
  if (!SCENARIOS.has(scenario)) throw invalid('scenario')
  contentOptions(scenario, value)
  if (value.text !== undefined && longText(value.text)) throw invalid('text')
  if (value.reasoning !== undefined && longText(value.reasoning)) throw invalid('reasoning')
  toolOptions(scenario, value)
  finishOption(scenario, value)
  codeOption(scenario, value)
  refusalOptions(scenario, value)
  // How long a stream is held after its first frame: a call the role keeps open meanwhile.
  if (value.delayMs !== undefined && !whole(value.delayMs, 120_000)) throw invalid('delay')
  usageOption(value)
  return { ...value, scenario }
}

/** The calls of the model, one list or a list per answer, the text beside them and a filler. */
function toolOptions(scenario, value) {
  const tools = scenario === 'tools'
  if (value.calls !== undefined && (!tools || !callList(value.calls))) throw invalid('calls')
  if (
    value.rounds !== undefined &&
    (!tools ||
      value.calls !== undefined ||
      !Array.isArray(value.rounds) ||
      value.rounds.length < 1 ||
      value.rounds.length > 32 ||
      !value.rounds.every(callList))
  )
    throw invalid('rounds')
  if (
    value.beside !== undefined &&
    (!tools ||
      typeof value.beside !== 'string' ||
      value.beside.length < 1 ||
      longText(value.beside))
  )
    throw invalid('text beside the calls')
  if (
    value.filler !== undefined &&
    (!tools || !whole(value.filler, MAX_FILLER_BYTES) || value.filler < 1)
  )
    throw invalid('filler')
}

function finishOption(scenario, value) {
  if (value.finish === undefined) {
    if (scenario === 'finish') throw invalid('finish')
    return
  }
  // Any value: the gateway must also cope with one nobody has documented.
  if (
    scenario !== 'finish' ||
    typeof value.finish !== 'string' ||
    !/^[A-Za-z_]{1,64}$/.test(value.finish)
  )
    throw invalid('finish')
}

function codeOption(scenario, value) {
  const failing = ['error', 'stream_error', 'envelope200'].includes(scenario)
  // An error that names no code needs the status it comes with.
  const codeless = scenario === 'error' && value.code === undefined && value.status !== undefined
  if ((value.code === undefined && !failing) || codeless) return
  if (!failing || !whole(value.code, 999_999)) throw invalid('code')
  if (scenario === 'error' && value.status === undefined && !ZAI_ERROR_STATUS[value.code])
    throw invalid('status')
}

/** The status of an error, its retry-after and how many requests it refuses. */
function refusalOptions(scenario, value) {
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
}

function usageOption(value) {
  if (value.usage === undefined) return
  if (!isRecord(value.usage)) throw invalid('usage')
  for (const [name, count] of Object.entries(value.usage))
    if (!Object.hasOwn(DEFAULT_USAGE, name) || !whole(count, 1_000_000_000)) throw invalid('usage')
  const usage = { ...DEFAULT_USAGE, ...value.usage }
  if (usage.cached > usage.prompt || usage.reasoning > usage.completion) throw invalid('usage')
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

/**
 * The state of the synthetic accounts: the plan key with its windows, the API key with its
 * balance, the scenario both chat paths answer by and what they were asked. `counters.chat`
 * counts the requests of both chat paths; a record names its path.
 */
export function createFakeZaiState(initial = {}) {
  const state = {
    requests: [],
    counters: { chat: 0, quota: 0, generated: 0 },
    config: {},
    attempts: 0,
    quota: {},
    // Which of the two synthetic plan keys the provider takes; the other one is refused.
    key: 'first',
    // The same for the two API keys, and whether the API account has money: `empty` answers
    // every request of the API path with 1113, as sample 21 shows.
    apiKey: 'first',
    balance: 'funded',
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
      state.key = 'first'
      state.apiKey = 'first'
      state.balance = 'funded'
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
    /**
     * `{reset?, scenario?, quota?, key?, apiKey?, balance?}`: the one message of the control
     * port.
     */
    configure(options = {}) {
      configurationOptions(options)
      if (options.reset) state.reset({})
      if (options.scenario !== undefined) state.setScenario(options.scenario)
      if (options.quota !== undefined) state.setQuota(options.quota)
      if (options.key !== undefined) state.key = options.key
      if (options.apiKey !== undefined) state.apiKey = options.apiKey
      if (options.balance !== undefined) state.balance = options.balance
      return state.snapshot()
    },
    snapshot() {
      return {
        requests: state.requests,
        counters: state.counters,
        config: state.config,
        quota: state.quota,
        key: state.key,
        apiKey: state.apiKey,
        balance: state.balance,
      }
    },
  }
  state.reset(initial)
  return state
}

/** The control message as `configure` takes it: known fields and keys, a known balance. */
function configurationOptions(options) {
  if (!isRecord(options)) throw invalid('configuration')
  for (const name of Object.keys(options))
    if (!['reset', 'scenario', 'quota', 'key', 'apiKey', 'balance'].includes(name))
      throw invalid('configuration')
  if (options.key !== undefined && !Object.hasOwn(PLAN_KEYS, options.key)) throw invalid('key')
  if (options.apiKey !== undefined && !Object.hasOwn(API_KEYS, options.apiKey)) throw invalid('key')
  if (options.balance !== undefined && !['funded', 'empty'].includes(options.balance))
    throw invalid('balance')
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
function chatError(res, sequence, code, status, retryAfter, text = 'Synthetic provider refusal.') {
  // The recorded 400 answers carry no content-type; 401 and 429 name application/json. Without
  // a code the error object holds the message alone (not recorded: a throttle of the provider
  // that names no code, as a third party reported it).
  json(
    res,
    status,
    {
      error: {
        ...(code === undefined ? {} : { code: String(code) }),
        message: providerText(text),
      },
    },
    { ...providerHeaders(sequence), ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
    status === 400 ? null : 'application/json',
  )
}
/** Sample 21: 1113 under HTTP 429, with the content type the provider gave it. */
function noBalance(res, sequence) {
  json(
    res,
    429,
    { error: { code: '1113', message: providerText(NO_BALANCE) } },
    providerHeaders(sequence),
    'application/json; charset=UTF-8',
  )
}

const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`

/**
 * The function the CLI declared for a tool of the platform MCP server. The pinned OpenCode names
 * it `<server>_<tool>` (sample 34-run-c-mcp: `raditi_wp_rest`); the name of the server is the
 * driver's, not the provider's to know. Nothing is called that the request does not declare.
 */
function declaredMcpTool(body, tool) {
  const names = body.tools
    .map((item) => item?.function?.name)
    .filter((name) => typeof name === 'string' && name.endsWith(`_${tool}`))
  if (names.length !== 1) throw new Error('Synthetic scenario requires one advertised MCP tool')
  return names[0]
}
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
 * whole in one chunk; with `beside`, that sentence before them), the last chunk with
 * finish_reason and usage together, DONE.
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
  const messages = Array.isArray(body.messages) ? body.messages : []
  // The tool steps of this turn: what the request holds after the last message of the user.
  const turn = messages.slice(messages.findLastIndex((message) => message?.role === 'user') + 1)
  const round = turn.filter(
    (message) => message?.role === 'assistant' && Array.isArray(message.tool_calls),
  ).length
  const rounds = config.rounds ?? [
    config.calls ?? [{ name: 'bash', arguments: { command: 'echo synthetic' } }],
  ]
  const declared = Array.isArray(body.tools) && body.tools.length > 0
  // A content scenario's own call of this round, by the name the request declares.
  const content = declared ? contentCall(body, config, round) : null
  const calling =
    declared && (content !== null || (config.scenario === 'tools' && round < rounds.length))
  const calls = content
    ? [{ name: declaredMcpTool(body, 'wp_rest'), arguments: content }]
    : rounds[Math.min(round, rounds.length - 1)]
  const frames = []
  const reasoning = config.reasoning ?? 'Synthetic reasoning.'
  for (const word of reasoning.split(/(?<= )/).filter(Boolean))
    frames.push(frame(chunk({ role: 'assistant', reasoning_content: word })))
  const say = (text) => {
    for (const word of text.split(/(?<= )/).filter(Boolean))
      frames.push(frame(chunk({ role: 'assistant', content: word })))
  }
  if (calling) {
    for (let left = config.filler ?? 0; left > 0; left -= FILLER_CHUNK_BYTES)
      frames.push(
        frame(
          chunk({
            role: 'assistant',
            reasoning_content: 'x'.repeat(Math.min(left, FILLER_CHUNK_BYTES)),
          }),
        ),
      )
    if (config.beside !== undefined) say(config.beside)
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
  } else say(config.text ?? 'Synthetic Z.ai answer.')
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

/**
 * Which credential a request carried, without its value: the plan key the provider takes now,
 * the API key it takes now, another one or none. The quota path takes a bare key too.
 */
function credentialOf(req, bare, state) {
  const value = req.headers.authorization
  if (value === undefined) return 'none'
  const is = (key) => value === `Bearer ${key}` || (bare && value === key)
  if (is(PLAN_KEYS[state.key])) return 'plan-key'
  if (is(API_KEYS[state.apiKey])) return 'api-key'
  return 'other'
}

export const isZaiRequest = (req) =>
  Object.values(ZAI_PATHS).includes(new URL(req.url, 'https://synthetic.invalid').pathname)

/** Answers a request to one of the Z.ai paths; the caller has checked `isZaiRequest`. */
export async function handleZai(req, res, state) {
  const path = new URL(req.url, 'https://synthetic.invalid').pathname
  const quotaPath = path === ZAI_PATHS.quota
  // The pay-per-token API: no windows, a balance instead.
  const apiPath = path === ZAI_PATHS.apiChat
  const record = recorded(req, res, state, path, quotaPath)
  if (quotaPath) return answerQuota(req, res, state, record)
  if (req.method !== 'POST') {
    req.resume()
    return json(res, 405, { error: { code: '1222', message: providerText('Synthetic.') } })
  }
  const body = await readJson(req)
  record.body = body
  const sequence = ++state.counters.chat
  if (refusedChat(res, sequence, { state, record, body, apiPath })) return
  const config = state.config
  const scenario = attemptScenario(state)
  if (scenario === 'error')
    return chatError(
      res,
      sequence,
      config.code,
      config.status ?? ZAI_ERROR_STATUS[config.code],
      config.retryAfter,
    )
  // A spent window refuses before any generation, with the code of the documentation. The API
  // has none.
  if (!apiPath && exhausted(state)) return chatError(res, sequence, 1308, 429)
  if (scenario === 'envelope200')
    return json(
      res,
      200,
      { code: config.code, msg: providerText('Synthetic envelope.'), success: false },
      providerHeaders(sequence),
    )
  state.counters.generated++
  if (!apiPath) spend(state)
  // Past its `failures` a scenario leaves plain answers with its text and the usual numbers.
  const effective =
    scenario === config.scenario ? config : { ...config, scenario, usage: undefined }
  const frames = zaiFrames(body, effective, sequence)
  // The whole answer as one object: what a request without `stream` gets (sample 61).
  if (scenario === 'plain200' || body.stream !== true)
    return answerWhole(res, { body, effective, sequence })
  return streamAnswer(res, { scenario, config, frames, sequence })
}

/** The record of a request in the state, without a secret; it learns its status at the end. */
function recorded(req, res, state, path, quotaPath) {
  const header = (name) => req.headers[name] ?? null
  const record = {
    method: req.method,
    path,
    credential: credentialOf(req, quotaPath, state),
    headerNames: Object.keys(req.headers).sort(),
    // Values that are no secret and that the gateway's checks compare.
    userAgent: header('user-agent'),
    accept: header('accept'),
    acceptEncoding: header('accept-encoding'),
    contentType: header('content-type'),
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
  return record
}

/** Refuses a generation the provider would not start: true when a refusal has been sent. */
function refusedChat(res, sequence, { state, record, body, apiPath }) {
  if (record.credential === 'none' || record.credential === 'other') {
    chatError(res, sequence, record.credential === 'none' ? 1001 : 401, 401)
    return true
  }
  // A key the provider knows, on the path of the other offer: it has no resource there. Sample
  // 21 is the plan key on the API path; the API key on the plan path is answered the same way
  // by assumption (not recorded). Before the body is read, as the recorded valid body was.
  const owned = apiPath ? 'api-key' : 'plan-key'
  if (record.credential !== owned || (apiPath && state.balance === 'empty')) {
    noBalance(res, sequence)
    return true
  }
  const code = chatBodyRefusal(body)
  if (code === null) return false
  chatError(res, sequence, code, 400)
  return true
}

/** The code of the provider's refusal of a request body, or null for a body it takes. */
function chatBodyRefusal(body) {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) return 1210
  if (!ZAI_MODELS.includes(body.model)) return 1211
  if (
    body.max_tokens !== undefined &&
    (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 131_072)
  )
    return 1210
  return null
}

/** The scenario of this attempt: past its `failures` a scenario answers plain text. */
function attemptScenario(state) {
  const config = state.config
  const failing = ++state.attempts <= (config.failures ?? Infinity)
  return failing || config.failures === undefined ? config.scenario : 'text'
}

function answerWhole(res, { body, effective, sequence }) {
  const id = `2026010100000000000000${String(sequence).padStart(8, '0')}`
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
      id,
      model: body.model,
      object: 'chat.completion',
      request_id: id,
      usage: usageOf(effective),
    },
    providerHeaders(sequence),
    'application/json; charset=UTF-8',
  )
}

async function streamAnswer(res, { scenario, config, frames, sequence }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream;charset=UTF-8',
    ...providerHeaders(sequence),
    ...(config.retryAfter ? { 'retry-after': config.retryAfter } : {}),
  })
  // What is still to be sent of the frames before the last one.
  let text = frames.body.join('')
  if (config.delayMs) {
    // A held answer has started: its first frame leaves, then the provider is silent. The two
    // streams that hold no answer at all are only late.
    if (scenario !== 'empty' && scenario !== 'done_only') {
      res.write(frames.body[0])
      text = frames.body.slice(1).join('')
    }
    if (!(await held(res, config.delayMs))) return
  }
  return endStream(res, { scenario, config, frames, text })
}

/** Holds a started answer for `ms`: false when the client went away meanwhile. */
async function held(res, ms) {
  const cancelled = new AbortController()
  const onClose = () => cancelled.abort()
  res.once('close', onClose)
  try {
    await delay(ms, undefined, { signal: cancelled.signal })
    return true
  } catch {
    return false
  } finally {
    res.off('close', onClose)
  }
}

/** The rest of a stream as its scenario shapes it: whole, or broken in its own way. */
async function endStream(res, { scenario, config, frames, text }) {
  if (scenario === 'stream_error')
    return res.end(
      (config.delayMs ? '' : frames.body[0]) +
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
  if (record.credential === 'other')
    return json(
      res,
      200,
      { code: 401, msg: 'token expired or incorrect', success: false },
      headers,
      type,
    )
  // A key of an account without a plan, on the plan's quota: an envelope of the monitor path
  // (samples 10, 10b, 14) with the code and the text of sample 21. Not recorded, and an
  // assumption the API offer's probe needs only in its weakest form: an envelope that names no
  // refused key reads as a key the provider takes. The live run with --api asserts what Z.ai
  // really answers.
  if (record.credential === 'api-key')
    return json(
      res,
      200,
      { code: 1113, msg: providerText(NO_BALANCE), success: false },
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
