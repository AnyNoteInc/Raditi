import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Synthetic providers only. Run on the disposable verification network: the separate
// control port intentionally exposes in-memory requests and synthetic credentials.
// Neither server makes outbound requests or persists request contents.
export const SYNTHETIC_KIMI_KEY = 'sk-kimi-synthetic-b13-only'
export const SYNTHETIC_ACCOUNT_ID = 'synthetic-b13-account'
export const SYNTHETIC_ERROR_MARKER = 'synthetic-provider-error-canary-b13'
export const SYNTHETIC_MCP_MARKER = 'synthetic-mcp-site-info-b13'
const authClaim = 'https://api.openai.com/auth'
const scenarios = new Set([
  'text',
  'plan-then-text',
  'tools',
  'mcp',
  'schema',
  'resume',
  'transient503',
  'final_quota',
  'auth_once',
  'window429',
  'content_risk',
  'no_usage',
  'interrupted',
  'delayed',
  'profile401',
  'html403',
  'concurrent403',
  'payment402',
  'credits',
  'stream_failed',
  // The agent-content stand: the platform MCP tool `wp_rest` driven by the model.
  'content_edit',
  'content_forbidden',
])
const paths = {
  codex: '/backend-api/codex/responses',
  codexUsage: '/backend-api/wham/usage',
  kimi: '/coding/v1/chat/completions',
  kimiUsage: '/coding/v1/usages',
  start: '/api/accounts/deviceauth/usercode',
  poll: '/api/accounts/deviceauth/token',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
}
// Kimi error events inside a stream, by name: exact error-reference texts, and one text no
// reference lists (a short-lived failure).
const KIMI_STREAM_FAILURES = Object.freeze({
  high_risk: 'The request was rejected because it was considered high risk',
  model_access:
    'Your current plan supports only k3 up to 256K context. 1M context is available on higher-tier Kimi Code plans. Upgrade: https://www.kimi.com/code?from=server_k3_error#pricing',
  quota_5h:
    "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
  overloaded: 'Synthetic engine overload.',
})
const nowSeconds = () => Math.floor(Date.now() / 1000)
const jwt = (payload) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    Buffer.from('synthetic-never-valid-at-provider').toString('base64url'),
  ].join('.')
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}
const fail = (res, status, type, message = 'Synthetic provider failure.', headers = {}) =>
  json(
    res,
    status,
    { error: { type, code: type, message, synthetic_canary: SYNTHETIC_ERROR_MARKER } },
    headers,
  )

// What the content scenarios send to `wp_rest`. The route is not checked against the tool's own
// schema on purpose: `content_forbidden` names one the role mcp must refuse.
const CONTENT_FIELDS = ['title', 'content', 'excerpt']
const CONTACT_PLACEHOLDER = '{{contact}}'
const PRIVACY_MARKER = /\[\[raditi:(?:email|phone):[a-f0-9-]{36}\]\]/
function contentOptions(scenario, options) {
  const invalid = () => new Error('Invalid content')
  const given = ['route', 'idempotencyKey', 'body'].filter((name) => options[name] !== undefined)
  if (scenario !== 'content_edit' && scenario !== 'content_forbidden') {
    if (given.length > 0) throw invalid()
    return
  }
  if (typeof options.route !== 'string' || !/^\/[A-Za-z0-9/_-]{1,127}$/.test(options.route))
    throw invalid()
  const edit = scenario === 'content_edit'
  // The refused call never carries a key: with a body it is a write without one.
  if (
    edit
      ? typeof options.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey)
      : options.idempotencyKey !== undefined
  )
    throw invalid()
  if (!edit && options.body === undefined) return
  const body = options.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
  const fields = Object.entries(body)
  if (
    fields.length === 0 ||
    !fields.every(
      ([name, value]) =>
        CONTENT_FIELDS.includes(name) && typeof value === 'string' && value.length <= 32 * 1024,
    )
  )
    throw invalid()
}

function scenarioOptions(value = {}) {
  const options = typeof value === 'string' ? { scenario: value } : value
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Invalid scenario')
  const scenario = options.scenario ?? 'text'
  if (!scenarios.has(scenario)) throw new Error('Invalid scenario')
  if (
    options.delayMs !== undefined &&
    (!Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 120_000)
  )
    throw new Error('Invalid delay')
  if (
    options.text !== undefined &&
    (typeof options.text !== 'string' || options.text.length > 16_384)
  )
    throw new Error('Invalid text')
  if (options.backend !== undefined && !['codex', 'kimi', 'all'].includes(options.backend))
    throw new Error('Invalid backend')
  // A provider failure inside a started stream: a Codex `response.failed` with `failure` as its
  // code, or a Kimi error event with the reference text named by `failure`. `failures` limits it
  // to the first attempts.
  if (scenario === 'stream_failed') {
    if (options.backend !== 'codex' && options.backend !== 'kimi')
      throw new Error('Invalid backend')
    if (
      typeof options.failure !== 'string' ||
      !(options.backend === 'kimi'
        ? Object.hasOwn(KIMI_STREAM_FAILURES, options.failure)
        : /^[a-z_]{1,64}$/.test(options.failure))
    )
      throw new Error('Invalid failure')
    if (
      options.failures !== undefined &&
      (!Number.isInteger(options.failures) || options.failures < 1 || options.failures > 100)
    )
      throw new Error('Invalid failure count')
  } else if (options.failure !== undefined || options.failures !== undefined)
    throw new Error('Invalid failure')
  contentOptions(scenario, options)
  if (options.usage !== undefined) {
    if (!options.usage || typeof options.usage !== 'object' || Array.isArray(options.usage))
      throw new Error('Invalid usage')
    for (const [key, count] of Object.entries(options.usage)) {
      if (
        !['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'].includes(key) ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 1_000_000_000
      )
        throw new Error('Invalid usage')
    }
    const usage = {
      input: 100,
      cacheRead: 20,
      cacheWrite: 0,
      output: 12,
      reasoning: 3,
      ...options.usage,
    }
    if (usage.cacheRead + usage.cacheWrite > usage.input || usage.reasoning > usage.output)
      throw new Error('Invalid usage')
  }
  return { scenario, delayMs: 250, text: 'Synthetic B13 complete.', ...options }
}

/** Reset scenarios independently from OAuth tokens, so auth_once can test refresh. */
export function createFakeSubscriptionState(initial = {}) {
  const state = {
    requests: [],
    counters: {},
    tokens: null,
    currentCredential: null,
    accountId: SYNTHETIC_ACCOUNT_ID,
    plan: 'plus',
    revoked: false,
    refreshTokens: new Map(),
    accessTokens: new Set(),
    deviceCodes: new Map(),
    config: {},
    rounds: {},
    attempts: {},
    generation: 0,
    // The synthetic MCP server behind sandbox-gw: one registered turn token, never echoed.
    mcp: { token: null, tools: [], requests: [] },
    reset(options = {}) {
      const parsed = scenarioOptions(options)
      if (parsed.accountId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.accountId))
        throw new Error('Invalid account')
      if (parsed.plan !== undefined && !/^[a-z0-9_-]{1,32}$/.test(parsed.plan))
        throw new Error('Invalid plan')
      state.requests.length = 0
      state.counters = {
        codex: 0,
        kimi: 0,
        refresh: 0,
        revoke: 0,
        deviceStart: 0,
        devicePoll: 0,
        exchange: 0,
      }
      state.accountId = parsed.accountId ?? SYNTHETIC_ACCOUNT_ID
      state.plan = parsed.plan ?? 'plus'
      state.revoked = false
      state.tokens = null
      state.currentCredential = null
      state.refreshTokens.clear()
      state.accessTokens.clear()
      state.deviceCodes.clear()
      state.generation = 0
      state.mcp = { token: null, tools: [], requests: [] }
      state.setScenario({ ...parsed, backend: 'all' })
      return state.snapshot()
    },
    setScenario(options = {}) {
      const parsed = scenarioOptions(options)
      for (const backend of parsed.backend && parsed.backend !== 'all'
        ? [parsed.backend]
        : ['codex', 'kimi']) {
        state.config[backend] = { ...parsed }
        state.rounds[backend] = 0
        state.attempts[backend] = 0
      }
      return state.snapshot()
    },
    issueTokens() {
      const issued = nowSeconds()
      const generation = ++state.generation
      const identity = { chatgpt_account_id: state.accountId, chatgpt_plan_type: state.plan }
      const access_token = jwt({
        iat: issued,
        exp: issued + 3600,
        jti: `synthetic-${generation}`,
        [authClaim]: identity,
      })
      const refresh_token = `rt-synthetic-b13-${generation}`
      const id_token = jwt({ iat: issued, exp: issued + 3600, [authClaim]: identity })
      state.revoked = false
      state.accessTokens.add(access_token)
      state.refreshTokens.set(refresh_token, false)
      state.tokens = {
        access_token,
        refresh_token,
        id_token,
        token_type: 'Bearer',
        expires_in: 3600,
      }
      state.currentCredential = {
        v: '1',
        kind: 'chatgpt_oauth',
        accessToken: access_token,
        refreshToken: refresh_token,
        idToken: id_token,
        chatgptAccountId: state.accountId,
        accessExpiresAt: new Date((issued + 3600) * 1000).toISOString(),
        refreshedAt: new Date().toISOString(),
      }
      return state.tokens
    },
    snapshot() {
      return {
        requests: state.requests,
        counters: state.counters,
        tokens: state.tokens,
        currentCredential: state.currentCredential,
        accountId: state.accountId,
        plan: state.plan,
        revoked: state.revoked,
        config: state.config,
        rounds: state.rounds,
        mcp: { requests: state.mcp.requests },
      }
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
  state.reset(initial)
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
  if (!text) return null
  return req.headers['content-type']?.includes('application/x-www-form-urlencoded')
    ? Object.fromEntries(new URLSearchParams(text))
    : JSON.parse(text)
}

function quotaHeaders(config) {
  return {
    'x-codex-primary-used-percent': config.scenario === 'window429' ? '100' : '10',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': String(nowSeconds() + 3600),
    'x-codex-secondary-used-percent': '15',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-at': String(nowSeconds() + 86400),
    'x-codex-credits-balance': config.scenario === 'credits' ? '1.25' : '0',
  }
}
function usageProbe(backend, state, res) {
  const config = state.config[backend]
  if (config.scenario === 'concurrent403')
    return fail(
      res,
      403,
      'forbidden',
      "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
    )
  const exhausted = ['window429', 'final_quota'].includes(config.scenario)
  if (backend === 'kimi') {
    return json(res, 200, {
      usages: {
        limit_5h: {
          used_ratio: exhausted ? 1 : 0.1,
          reset_time: new Date(Date.now() + 3600_000).toISOString(),
        },
        limit_7d: { used_ratio: 0.15, reset_time: new Date(Date.now() + 86400_000).toISOString() },
      },
    })
  }
  json(
    res,
    200,
    {
      plan_type: state.plan,
      rate_limit: {
        allowed: !exhausted,
        limit_reached: exhausted,
        primary_window: {
          used_percent: exhausted ? 100 : 10,
          limit_window_seconds: 18000,
          reset_at: nowSeconds() + 3600,
        },
        secondary_window: {
          used_percent: 15,
          limit_window_seconds: 604800,
          reset_at: nowSeconds() + 86400,
        },
      },
      credits: { balance: config.scenario === 'credits' ? '1.25' : '0' },
    },
    quotaHeaders(config),
  )
}

function schemaValue(schema, depth = 0) {
  if (!schema || depth > 12) return null
  if (Object.hasOwn(schema, 'const')) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if (Array.isArray(schema.anyOf)) return schemaValue(schema.anyOf[0], depth + 1)
  if (schema.type === 'object' || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        schemaValue(value, depth + 1),
      ]),
    )
  if (schema.type === 'array')
    return Array.from({ length: Math.min(schema.minItems ?? 0, 3) }, () =>
      schemaValue(schema.items, depth + 1),
    )
  if (schema.type === 'boolean') return true
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1
  if (schema.type === 'null') return null
  return 'Synthetic B13 complete.'
}

function selectTool(body, plan, round) {
  // Responses Lite moves declarations from root.tools to input.additional_tools.
  const declared = [
    ...(body?.tools ?? []),
    ...(body?.input ?? [])
      .filter((item) => item.type === 'additional_tools')
      .flatMap((item) => item.tools ?? []),
  ]
  const tools = declared
    .flatMap((tool) =>
      tool.type === 'namespace'
        ? (tool.tools ?? []).map((nested) => ({ ...nested, namespace: tool.name }))
        : [tool],
    )
    .map((tool) => tool.function ?? tool)
  const tool = tools.find((item) =>
    plan
      ? /(^|\.)(update_plan|plan)$/.test(item.name)
      : /(^|\.)(exec_command|shell_command|shell|bash)$/i.test(item.name),
  )
  const command =
    round === 0
      ? "printf 'synthetic-one\\n' > b13-first.txt"
      : "cat b13-first.txt && printf 'synthetic-two\\n' > b13-second.txt"
  if (!tool) {
    const exec = tools.find(
      (item) =>
        item.type === 'custom' &&
        item.name === 'exec' &&
        (plan || item.description?.includes('tools.exec_command(')),
    )
    if (!exec) throw new Error('Synthetic scenario requires advertised tool')
    return {
      type: 'custom_tool_call',
      name: exec.name,
      namespace: exec.namespace,
      input: plan
        ? 'text("Synthetic plan: verify local files, then report completion.")'
        : `text(await tools.exec_command(${JSON.stringify({ cmd: command })}))`,
    }
  }
  if (plan)
    return {
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      arguments: JSON.stringify({
        plan: [{ step: 'Verify synthetic response', status: 'in_progress' }],
      }),
    }
  const properties = tool.parameters?.properties ?? {}
  const key = Object.hasOwn(properties, 'cmd') ? 'cmd' : 'command'
  const value = properties[key]?.type === 'array' ? ['sh', '-c', command] : command
  const args = { [key]: value }
  // Current Codex and Kimi advertise these names; retain their own parameter shape.
  if (Object.hasOwn(properties, 'description')) args.description = 'Verify synthetic B13 fixture'
  return {
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(args),
  }
}

/**
 * A call of a platform MCP tool (`site_info` by default). Kimi declares it as a function under the
 * CLI's own prefix. Codex 0.158 in code mode declares no MCP tool at all: its nested tools, MCP ones
 * included, live in the `exec` JavaScript tool as `tools.mcp__<server>__<tool>` (listed in
 * ALL_TOOLS), so the call is an `exec` cell; a directly declared tool is still preferred if a CLI
 * ever declares one.
 */
function selectMcpTool(body, backend, name = 'site_info', args = {}) {
  const declared =
    backend === 'codex'
      ? [
          ...(body?.tools ?? []),
          ...(body?.input ?? [])
            .filter((item) => item.type === 'additional_tools')
            .flatMap((item) => item.tools ?? []),
        ].flatMap((tool) =>
          tool.type === 'namespace'
            ? (tool.tools ?? []).map((nested) => ({ ...nested, namespace: tool.name }))
            : [tool],
        )
      : (body?.tools ?? []).map((tool) => tool.function ?? tool)
  const suffix = new RegExp(`(^|[_.])${name}$`)
  const tool = declared.find((item) => suffix.test(item.name ?? ''))
  if (tool)
    return {
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      arguments: JSON.stringify(args),
    }
  const exec =
    backend === 'codex' &&
    declared.find(
      (item) =>
        item.type === 'custom' &&
        item.name === 'exec' &&
        item.description?.includes('tools.exec_command('),
    )
  if (!exec) throw new Error('Synthetic scenario requires an advertised MCP tool')
  return {
    type: 'custom_tool_call',
    name: exec.name,
    namespace: exec.namespace,
    input: `text(JSON.stringify(await tools.mcp__raditi__${name}(${JSON.stringify(args)})))`,
  }
}

/**
 * The `wp_rest` call of a content scenario's round, or null when the round is the final answer.
 * `content_edit`: read, write with the idempotency key, the very same write again. A body value
 * may hold `{{contact}}`: it becomes the first privacy marker the conversation carries (the read's
 * output), the way a model keeps an opaque marker in place. Nothing is invented without one.
 * `content_forbidden`: one call the role must refuse — a read of the given route, or, with a
 * body, a write without an idempotency key.
 */
function contentCall(body, config, round) {
  if (config.scenario === 'content_forbidden') {
    if (round > 0) return null
    return config.body
      ? { method: 'POST', route: config.route, body: config.body }
      : { method: 'GET', route: config.route }
  }
  if (config.scenario !== 'content_edit' || round > 2) return null
  if (round === 0) return { method: 'GET', route: config.route }
  const marker = PRIVACY_MARKER.exec(JSON.stringify(body))?.[0]
  const fields = Object.fromEntries(
    Object.entries(config.body).map(([name, value]) => {
      if (!value.includes(CONTACT_PLACEHOLDER)) return [name, value]
      if (!marker) throw new Error('Synthetic scenario requires a privacy marker to copy')
      return [name, value.replaceAll(CONTACT_PLACEHOLDER, marker)]
    }),
  )
  return {
    method: 'POST',
    route: config.route,
    body: fields,
    idempotencyKey: config.idempotencyKey,
  }
}

function wireUsage(backend, config) {
  const usage = {
    input: 100,
    cacheRead: 20,
    cacheWrite: 0,
    output: 12,
    reasoning: 3,
    ...config.usage,
  }
  return backend === 'codex'
    ? {
        input_tokens: usage.input,
        input_tokens_details: {
          cached_tokens: usage.cacheRead,
          cache_write_tokens: usage.cacheWrite,
        },
        output_tokens: usage.output,
        output_tokens_details: { reasoning_tokens: usage.reasoning },
        total_tokens: usage.input + usage.output,
      }
    : {
        prompt_tokens: usage.input,
        prompt_tokens_details: { cached_tokens: usage.cacheRead },
        completion_tokens: usage.output,
        completion_tokens_details: { reasoning_tokens: usage.reasoning },
        total_tokens: usage.input + usage.output,
      }
}
const sse = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const codexEvent = (type, values) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`

function codexFrames(body, config, round, sequence) {
  const id = `resp_synthetic_${sequence}`
  const response = {
    id,
    object: 'response',
    created_at: nowSeconds(),
    model: body.model ?? 'gpt-6-sol',
    status: 'in_progress',
    output: [],
  }
  const frames = [codexEvent('response.created', { response })]
  const content = contentCall(body, config, round)
  const isTool =
    content !== null ||
    (config.scenario === 'tools' && round < 2) ||
    (config.scenario === 'mcp' && round === 0) ||
    (config.scenario === 'plan-then-text' && round === 0)
  if (isTool) {
    const tool = content
      ? selectMcpTool(body, 'codex', 'wp_rest', content)
      : config.scenario === 'mcp'
        ? selectMcpTool(body, 'codex')
        : selectTool(body, config.scenario === 'plan-then-text', round)
    const item = {
      type: 'function_call',
      id: `fc_synthetic_${sequence}`,
      call_id: `call_synthetic_${sequence}`,
      ...tool,
      status: 'completed',
    }
    const custom = item.type === 'custom_tool_call'
    const payload = custom ? 'input' : 'arguments'
    const event = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments'
    frames.push(
      codexEvent('response.output_item.added', {
        output_index: 0,
        item: { ...item, [payload]: '', status: 'in_progress' },
      }),
      codexEvent(`${event}.delta`, {
        item_id: item.id,
        output_index: 0,
        delta: item[payload],
      }),
      codexEvent(`${event}.done`, {
        item_id: item.id,
        output_index: 0,
        [payload]: item[payload],
      }),
      codexEvent('response.output_item.done', { output_index: 0, item }),
    )
    response.output = [item]
  } else {
    const text =
      body.text?.format?.type === 'json_schema'
        ? JSON.stringify(config.output ?? schemaValue(body.text.format.schema))
        : config.text
    const part = { type: 'output_text', text, annotations: [], logprobs: [] }
    const item = {
      id: `msg_synthetic_${sequence}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      phase: 'final_answer',
      content: [part],
    }
    frames.push(
      codexEvent('response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      }),
      codexEvent('response.content_part.added', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: '' },
      }),
      codexEvent('response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      }),
      codexEvent('response.output_text.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
      }),
      codexEvent('response.content_part.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part,
      }),
      codexEvent('response.output_item.done', { output_index: 0, item }),
    )
    response.output = [item]
  }
  frames.push(
    codexEvent('response.completed', {
      response: {
        ...response,
        status: 'completed',
        ...(config.scenario === 'no_usage' ? {} : { usage: wireUsage('codex', config) }),
      },
    }),
  )
  return frames
}

function kimiFrames(body, config, round, sequence) {
  const base = {
    id: `chatcmpl_synthetic_${sequence}`,
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: body.model ?? 'k3-256k',
  }
  const chunk = (delta, finish_reason = null) =>
    sse({ ...base, choices: [{ index: 0, delta, finish_reason }] })
  const frames = [chunk({ role: 'assistant', content: '' })]
  const content = contentCall(body, config, round)
  if (
    content !== null ||
    (config.scenario === 'tools' && round < 2) ||
    (config.scenario === 'mcp' && round === 0)
  ) {
    const tool = content
      ? selectMcpTool(body, 'kimi', 'wp_rest', content)
      : config.scenario === 'mcp'
        ? selectMcpTool(body, 'kimi')
        : selectTool(body, false, round)
    frames.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_synthetic_${sequence}`,
            type: 'function',
            function: { name: tool.name, arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: tool.arguments } }] }),
      chunk({}, 'tool_calls'),
    )
  } else
    frames.push(
      chunk({ content: config.text, reasoning_content: 'Synthetic reasoning.' }),
      chunk({}, 'stop'),
    )
  if (config.scenario !== 'no_usage')
    frames.push(sse({ ...base, choices: [], usage: wireUsage('kimi', config) }))
  frames.push(sse('[DONE]'))
  return frames
}

function failureScenario(backend, state, res) {
  const scenario = state.config[backend].scenario
  const attempt = ++state.attempts[backend]
  if (scenario === 'transient503' && attempt === 1)
    return (fail(res, 503, 'server_error', undefined, { 'retry-after': '0' }), true)
  if (scenario === 'auth_once' && attempt === 1) {
    if (backend === 'codex') state.accessTokens.clear()
    fail(res, 401, 'invalid_token', 'Invalid Authentication')
    return true
  }
  if (scenario === 'profile401')
    return (
      fail(
        res,
        401,
        'invalid_request_error',
        'Your current plan supports only k3 up to 256K context. 1M context is available on higher-tier Kimi Code plans. Upgrade: https://www.kimi.com/code?from=server_k3_error#pricing',
      ),
      true
    )
  if (scenario === 'html403') {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end(`<p>Cloudflare blocked</p><span>${SYNTHETIC_ERROR_MARKER}</span>`)
    return true
  }
  if (scenario === 'payment402') return (fail(res, 402, 'payment_required'), true)
  if (scenario === 'concurrent403')
    return (
      fail(
        res,
        403,
        'forbidden',
        "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
      ),
      true
    )
  if (scenario === 'final_quota' || scenario === 'window429') {
    if (backend === 'kimi')
      fail(
        res,
        scenario === 'window429' ? 429 : 403,
        'exceeded_current_quota_error',
        "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
        { 'retry-after': '0' },
      )
    else
      json(
        res,
        429,
        {
          error: {
            type: 'usage_limit_reached',
            code: 'usage_limit_reached',
            message: 'Synthetic quota.',
            synthetic_canary: SYNTHETIC_ERROR_MARKER,
            resets_at: nowSeconds() + 3600,
          },
        },
        quotaHeaders(state.config.codex),
      )
    return true
  }
  if (scenario === 'content_risk')
    return (
      fail(
        res,
        400,
        backend === 'codex' ? 'cyber_policy' : 'invalid_request_error',
        backend === 'kimi'
          ? 'The request was rejected because it was considered high risk'
          : 'Synthetic content refusal.',
      ),
      true
    )
  return false
}

async function handleProvider(req, res, state) {
  const body = await bodyOf(req)
  const path = new URL(req.url, 'https://synthetic.invalid').pathname
  if (state.requests.length >= 1000) return fail(res, 503, 'synthetic_request_limit')
  const record = {
    method: req.method,
    path,
    headers: { ...req.headers },
    body,
    completed: false,
    aborted: false,
  }
  state.requests.push(record)
  res.on('finish', () => {
    record.completed = true
  })
  res.on('close', () => {
    if (!res.writableFinished) record.aborted = true
  })
  if (req.method === 'POST' && path === paths.start) {
    const id = `synthetic-device-${++state.counters.deviceStart}`
    state.deviceCodes.set(id, {
      code: `SYNTHETIC-${state.counters.deviceStart}`,
      polled: false,
      exchanged: false,
    })
    return json(res, 200, {
      device_auth_id: id,
      user_code: state.deviceCodes.get(id).code,
      interval: 1,
    })
  }
  if (req.method === 'POST' && path === paths.poll) {
    state.counters.devicePoll++
    const device = state.deviceCodes.get(body?.device_auth_id)
    if (!device || body.user_code !== device.code) return fail(res, 403, 'authorization_pending')
    device.polled = true
    return json(res, 200, {
      authorization_code: body.device_auth_id,
      code_verifier: 'synthetic-verifier',
      code_challenge: 'synthetic-challenge',
    })
  }
  if (req.method === 'POST' && path === paths.token) {
    if (body?.grant_type === 'authorization_code') {
      const device = state.deviceCodes.get(body.code)
      if (!device?.polled || device.exchanged || body.code_verifier !== 'synthetic-verifier')
        return fail(res, 400, 'invalid_grant')
      device.exchanged = true
      state.counters.exchange++
      return json(res, 200, state.issueTokens())
    }
    if (body?.grant_type === 'refresh_token') {
      state.counters.refresh++
      if (state.revoked || !state.refreshTokens.has(body.refresh_token))
        return fail(res, 401, 'refresh_token_invalidated')
      if (state.refreshTokens.get(body.refresh_token)) {
        state.revoked = true
        state.accessTokens.clear()
        return fail(res, 401, 'refresh_token_reused')
      }
      state.refreshTokens.set(body.refresh_token, true)
      return json(res, 200, state.issueTokens())
    }
    return fail(res, 400, 'unsupported_grant_type')
  }
  if (req.method === 'POST' && path === paths.revoke) {
    state.counters.revoke++
    if (!state.refreshTokens.has(body?.token)) return fail(res, 400, 'invalid_token')
    state.revoked = true
    state.accessTokens.clear()
    return json(res, 200, {})
  }
  const backend = [paths.codex, paths.codexUsage].includes(path)
    ? 'codex'
    : [paths.kimi, paths.kimiUsage].includes(path)
      ? 'kimi'
      : null
  if (!backend) return fail(res, 404, 'synthetic_unknown_route')
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (
    backend === 'codex'
      ? state.revoked || !state.accessTokens.has(token)
      : token !== SYNTHETIC_KIMI_KEY
  )
    return fail(res, 401, 'invalid_token', 'Invalid Authentication')
  if (path === paths.codexUsage || path === paths.kimiUsage) {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed')
    return usageProbe(backend, state, res)
  }
  if (req.method !== 'POST' || !body || typeof body !== 'object' || Array.isArray(body))
    return fail(res, 400, 'invalid_request')
  state.counters[backend]++
  if (failureScenario(backend, state, res)) return
  const config = state.config[backend]
  const round = state.rounds[backend]++
  const sequence = state.counters[backend]
  const frames =
    backend === 'codex'
      ? codexFrames(body, config, round, sequence)
      : kimiFrames(body, config, round, sequence)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    ...(backend === 'codex' ? quotaHeaders(config) : {}),
  })
  if (
    config.scenario === 'stream_failed' &&
    state.attempts[backend] <= (config.failures ?? Infinity)
  ) {
    // The provider has already answered 200: only the stream can carry the failure.
    res.end(
      frames[0] +
        (backend === 'kimi'
          ? sse({
              error: {
                type: 'invalid_request_error',
                message: KIMI_STREAM_FAILURES[config.failure],
                synthetic_canary: SYNTHETIC_ERROR_MARKER,
              },
            })
          : codexEvent('response.failed', {
              response: {
                id: `resp_synthetic_${sequence}`,
                object: 'response',
                status: 'failed',
                error: {
                  code: config.failure,
                  message: 'Synthetic stream failure.',
                  synthetic_canary: SYNTHETIC_ERROR_MARKER,
                  ...(config.failure === 'usage_limit_reached'
                    ? { resets_at: nowSeconds() + 3600 }
                    : {}),
                },
              },
            })),
    )
  } else if (config.scenario === 'delayed' || config.scenario === 'interrupted') {
    // Include a real text delta before delaying or cutting the stream.
    const first = backend === 'codex' ? 4 : 2
    res.write(frames.slice(0, first).join(''))
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
    if (res.destroyed) return
    if (config.scenario === 'interrupted') return res.destroy()
    res.end(frames.slice(first).join(''))
  } else res.end(frames.join(''))
}

/**
 * Synthetic MCP, shaped like the role mcp's stateless JSON answers (mcp-nest). The tools are the
 * ones the harness registers (the production profile's), so the CLIs declare them to the model
 * exactly as they would in a turn. Only the registered turn token is accepted; it is never stored
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

/** A TLS provider plus an HTTP control API bound to a separate internal port. */
export async function startFakeSubscriptions({
  host = '127.0.0.1',
  port = 0,
  key,
  cert,
  controlHost = '127.0.0.1',
  controlPort = 0,
  mcpHost = '127.0.0.1',
  mcpPort,
  ...options
} = {}) {
  if (!key || !cert) throw new Error('Synthetic provider requires TLS key and certificate')
  const state = createFakeSubscriptionState(options)
  const provider = createHttpsServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    handleProvider(req, res, state).catch(() => {
      if (res.headersSent) res.destroy()
      else fail(res, 400, 'synthetic_invalid_request')
    })
  })
  const control = createHttpServer((req, res) => {
    ;(async () => {
      if (req.method === 'GET' && req.url === '/state') return json(res, 200, state.snapshot())
      if (req.method === 'POST' && req.url === '/reset')
        return json(res, 200, state.reset((await bodyOf(req)) ?? {}))
      if (req.method === 'POST' && req.url === '/scenario')
        return json(res, 200, state.setScenario((await bodyOf(req)) ?? {}))
      if (req.method === 'POST' && req.url === '/tokens')
        return json(res, 200, { tokens: state.issueTokens(), credential: state.currentCredential })
      if (req.method === 'POST' && req.url === '/mcp')
        return json(res, 200, state.setMcp(await bodyOf(req)))
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
  const servers = [provider, control, ...(mcp ? [mcp] : [])]
  try {
    await listen(provider, port, host)
    await listen(control, controlPort, controlHost)
    if (mcp) await listen(mcp, mcpPort, mcpHost)
  } catch (error) {
    await Promise.all(servers.map(close))
    throw error
  }
  return {
    state,
    address: address(provider, host, 'https'),
    controlAddress: address(control, controlHost, 'http'),
    ...(mcp ? { mcpAddress: address(mcp, mcpHost, 'http') } : {}),
    close: async () => {
      await Promise.all(servers.map(close))
    },
  }
}

async function main(args) {
  const options = {}
  const names = {
    '--host': 'host',
    '--port': 'port',
    '--control-host': 'controlHost',
    '--control-port': 'controlPort',
    '--mcp-host': 'mcpHost',
    '--mcp-port': 'mcpPort',
    '--tls-dir': 'tlsDir',
    '--tls-key': 'tlsKey',
    '--tls-cert': 'tlsCert',
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
  const fake = await startFakeSubscriptions({
    ...options,
    key: readFileSync(options.tlsKey ?? join(options.tlsDir, 'server-key.pem')),
    cert: readFileSync(options.tlsCert ?? join(options.tlsDir, 'server.pem')),
  })
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      port: fake.address.port,
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
    process.stderr.write('Synthetic provider failed.\n')
    process.exitCode = 1
  })
