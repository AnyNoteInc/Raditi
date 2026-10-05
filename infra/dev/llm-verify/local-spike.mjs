/* global AbortSignal, URL, clearTimeout, console, fetch, process, setTimeout */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEgressProxy } from '../../egress/llm-egress.mjs'
import { createRecordProxy, egressAgent, inspectCodexAuth, readCodexAuth } from './record-proxy.mjs'

// Explicit, opt-in live smoke test. Only the host proxy reads the existing login, and only the
// file the operator names in RECORD_CODEX_AUTH together with --confirm-live-subscription: there
// is no default path. The CLI gets an empty temporary CODEX_HOME and HOME and a disposable
// localhost key, never a subscription token. No login, token refresh, logout or user-config
// edits. Only a scrubbed shape report survives.
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
const close = (server) =>
  new Promise((resolve) => {
    if (!server?.listening) return resolve()
    server.closeAllConnections?.()
    server.close(resolve)
  })
const numericUsage = (usage) =>
  Object.fromEntries(
    Object.entries(usage ?? {}).flatMap(([key, value]) => {
      if (
        [
          'input_tokens',
          'output_tokens',
          'total_tokens',
          'cached_tokens',
          'cache_write_tokens',
          'reasoning_tokens',
        ].includes(key) &&
        typeof value === 'number' &&
        Number.isFinite(value)
      )
        return [[key, value]]
      if (
        ['input_tokens_details', 'output_tokens_details'].includes(key) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      )
        return [[key, numericUsage(value)]]
      return []
    }),
  )
const allowed = (value, values) => (values.includes(value) ? value : undefined)
const providerEventTypes = [
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'error',
  '[DONE]',
]
const cliEventTypes = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
  'warning',
]
const subscriptionPaths = ['/codex/responses', '/codex/models', '/wham/usage']
const readExchanges = (file) =>
  (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const errorCode = (error) =>
  allowed(error?.code, [
    'ENOENT',
    'EACCES',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EGRESS_TIMEOUT',
    'AUTH_EXPIRED',
    'AUTH_FILE_REQUIRED',
    'LIVE_CONFIRMATION_REQUIRED',
    'USAGE_PROBE_FAILED',
    'ADAPTER_CREDENTIAL_INVALID',
    'ADAPTER_REQUEST_REJECTED',
  ]) ?? 'SPIKE_FAILED'
const windowUsage = (body) => {
  const values = [
    body?.rate_limit?.primary_window?.used_percent,
    body?.rate_limit?.secondary_window?.used_percent,
  ]
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? values
    : null
}

// Fixed numeric quota metadata only; no identifiers or arbitrary header values survive.
function quotaHeaders(headers) {
  const names = ['primary', 'secondary'].flatMap((prefix) =>
    ['used-percent', 'window-minutes', 'reset-at', 'reset-after-seconds'].map(
      (suffix) => `x-codex-${prefix}-${suffix}`,
    ),
  )
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = headers?.[name]
      return typeof value === 'string' &&
        /^\d+(?:\.\d+)?$/.test(value) &&
        Number.isFinite(Number(value))
        ? [[name, Number(value)]]
        : []
    }),
  )
}

/** No ids, prompts, reasoning or provider messages; quota headers are numeric-only. */
export function summarizeExchange(exchange) {
  const response = exchange.response ?? {}
  const events = Array.isArray(response.events) ? response.events : []
  const terminal = events.find((event) => event.data?.type === 'response.completed')
  const body = exchange.request?.body
  const path = typeof exchange.path === 'string' ? exchange.path.split('?')[0] : undefined
  return {
    method: allowed(exchange.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']),
    path: allowed(path, [...subscriptionPaths, '/disabled/plugins/featured']) ?? '[other path]',
    status: Number.isInteger(response.status) ? response.status : undefined,
    refusal_status:
      typeof exchange.refused === 'string' && /^\d{3} /.test(exchange.refused)
        ? Number(exchange.refused.slice(0, 3))
        : undefined,
    error: allowed(exchange.error, [
      'ABORT_ERR',
      'UPSTREAM_ABORTED',
      'UPSTREAM_CLOSED',
      'ECONNRESET',
      'EGRESS_TIMEOUT',
      'ADAPTER_STREAM_INVALID',
      'ADAPTER_RESPONSE_ENCODING',
      'redirect',
      'upstream_error',
    ]),
    transport_end: allowed(response.transport_end, [
      'end',
      'client_close',
      'timeout',
      'error',
      'close',
    ]),
    outcome: allowed(response.outcome, [
      'completed',
      'failed',
      'incomplete',
      'client_aborted',
      'upstream_error',
      'missing_terminal',
      'http_complete',
    ]),
    terminal_event: allowed(response.terminal_event, [
      'response.completed',
      'response.failed',
      'response.incomplete',
      '[DONE]',
    ]),
    bytes: Number.isFinite(response.bytes) ? response.bytes : undefined,
    request_fields: body && typeof body === 'object' ? Object.keys(body) : [],
    input_types: Array.isArray(body?.input)
      ? [
          ...new Set(
            body.input.map((item) =>
              typeof item?.type === 'string' && /^[a-z_]{1,48}$/.test(item.type)
                ? item.type
                : '[other]',
            ),
          ),
        ]
      : [],
    store_false: body?.store === false,
    structured_output: body?.text?.format?.type === 'json_schema',
    stripped: Array.isArray(exchange.request?.stripped)
      ? exchange.request.stripped.filter((field) =>
          ['client_metadata', 'service_tier'].includes(field),
        )
      : undefined,
    response_header_names: Object.keys(response.headers ?? {}),
    quota_headers: quotaHeaders(response.headers),
    event_types: [
      ...new Set(
        events
          .map((event) => allowed(event.data?.type ?? event.event, providerEventTypes))
          .filter(Boolean),
      ),
    ],
    ...(terminal ? { usage: numericUsage(terminal.data.response?.usage) } : {}),
    ...(exchange.adapter ? { adapter: summarizeAdapter(exchange.adapter) } : {}),
  }
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined)
function summarizeAdapter(adapter) {
  const meter = adapter.meter
  return {
    normalized: adapter.normalized === true,
    ...(typeof adapter.policy?.reason === 'string' &&
    /^[a-z_]{1,32}$/.test(adapter.policy.reason) &&
    typeof adapter.policy?.path === 'string' &&
    /^[A-Za-z_.[\]-]{1,64}$/.test(adapter.policy.path)
      ? { policy: { reason: adapter.policy.reason, path: adapter.policy.path } }
      : {}),
    error: allowed(adapter.error, [
      'AUTH_EXPIRED',
      'ADAPTER_CREDENTIAL_INVALID',
      'ADAPTER_REQUEST_REJECTED',
    ]),
    ...(meter
      ? {
          outcome: allowed(meter.outcome, ['completed', 'failed', 'incomplete']),
          usage_issue:
            meter.usageIssue === null
              ? null
              : allowed(meter.usageIssue, ['no_usage', 'invalid_usage']),
          usage: meter.usage
            ? Object.fromEntries(
                ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'].map((key) => [
                  key,
                  count(meter.usage[key]),
                ]),
              )
            : null,
          delta_text_bytes: count(meter.deltaTextBytes),
        }
      : {}),
    // Every kind of callSignalSchema (packages/domain, ports/llm-backend.ts); the test compares.
    signal: allowed(adapter.signal?.kind, [
      'ok',
      'transient',
      'window_exhausted',
      'auth',
      'account_risk',
      'region',
      'unconfirmed_block',
      'policy_flagged',
      'profile',
      'request_rejected',
    ]),
    windows_parsed: adapter.windows !== null && adapter.windows !== undefined,
  }
}

/** Require the real B7 pipeline, complete terminals and matching provider counts. */
export function adapterVerificationPassed(report) {
  const probes = (report.steps ?? []).filter((step) => step.phase === 'usage_probe')
  const calls = (report.exchanges ?? []).filter((exchange) => exchange.path === '/codex/responses')
  return (
    probes.length === 2 &&
    probes.every(
      (probe) => probe.adapter === true && probe.status === 'ok' && probe.windows?.length > 0,
    ) &&
    calls.length >= 2 &&
    calls.every((call) => {
      const adapter = call.adapter,
        usage = call.usage
      return (
        call.status === 200 &&
        adapter?.normalized === true &&
        adapter.outcome === 'completed' &&
        adapter.usage_issue === null &&
        adapter.signal === 'ok' &&
        (!call.response_header_names?.some((name) =>
          /^x-codex-(primary|secondary)-window-minutes$/.test(name),
        ) ||
          adapter.windows_parsed === true) &&
        usage &&
        adapter.usage?.input === usage.input_tokens &&
        adapter.usage?.output === usage.output_tokens &&
        adapter.usage?.cacheRead === (usage.input_tokens_details?.cached_tokens ?? 0) &&
        adapter.usage?.cacheWrite === (usage.input_tokens_details?.cache_write_tokens ?? 0) &&
        adapter.usage?.reasoning === (usage.output_tokens_details?.reasoning_tokens ?? 0)
      )
    })
  )
}

async function runCli(binary, args, prompt, work, env) {
  return new Promise((resolve) => {
    const child = spawn(binary, ['exec', ...args, prompt], {
      cwd: work,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '',
      stderr = '',
      timedOut = false,
      killTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000)
    }, 120_000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.length > 8 * 1024 * 1024) child.kill('SIGTERM')
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, error: error.code })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      const events = output.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      resolve({ code, timedOut, events, stderr })
    })
  })
}

export async function runLocalSpike({
  model,
  binary = 'codex',
  authFile,
  confirmLive,
  localEgress = false,
  backendAdapter = false,
}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(model ?? '')) throw new Error('--model must name the model to test')
  // Both checks precede every read: a live run spends the named subscription.
  if (typeof authFile !== 'string' || !isAbsolute(authFile))
    throw Object.assign(new Error('RECORD_CODEX_AUTH must name the login file'), {
      code: 'AUTH_FILE_REQUIRED',
    })
  if (confirmLive !== true)
    throw Object.assign(new Error('a live run needs --confirm-live-subscription'), {
      code: 'LIVE_CONFIRMATION_REQUIRED',
    })
  const fingerprint = () => createHash('sha256').update(readFileSync(authFile)).digest('hex')
  const before = fingerprint()
  const auth = inspectCodexAuth(authFile)
  if (auth.access_token.expires && Date.parse(auth.access_token.expires) <= Date.now())
    throw Object.assign(new Error('existing login has expired'), { code: 'AUTH_EXPIRED' })
  const localKey = `rdt-spike-${randomBytes(24).toString('hex')}`
  const codexAuth = readCodexAuth(authFile)
  const secrets = [localKey, ...codexAuth.secrets]
  const root = mkdtempSync(join(tmpdir(), 'raditi-local-spike-'))
  const work = join(root, 'work'),
    home = join(root, 'codex'),
    userHome = join(root, 'home'),
    recordFile = join(root, 'exchanges.jsonl')
  // A temporary HOME: neither the CLI nor a command it runs finds the owner's ~/.codex.
  const env = {
    PATH: process.env.PATH,
    HOME: userHome,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    CODEX_HOME: home,
    RADITI_LLM_TOKEN: localKey,
  }
  const report = {
    date: new Date().toISOString(),
    model,
    reasoning_effort: 'low',
    mode: localEgress ? 'local-mtls-egress' : 'local-direct',
    auth: {
      mode: allowed(auth.auth_mode, ['chatgpt', 'apikey']) ?? 'unknown',
      plan:
        allowed(auth.access_token.plan_type, [
          'free',
          'go',
          'plus',
          'pro',
          'business',
          'team',
          'enterprise',
          'edu',
        ]) ?? 'unknown',
      lifetime_hours: auth.access_token.lifetime_hours,
    },
    remote_egress: 'not_tested',
    backend_adapter: backendAdapter,
    kimi: 'no_account',
    steps: [],
  }
  let proxy, egress, agent
  const egressSockets = new Set(),
    egressLog = []
  try {
    mkdirSync(work, { mode: 0o700 })
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(userHome, { mode: 0o700 })
    const version = execFileSync(binary, ['--version'], {
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
    report.cli = /^codex-cli \d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)
      ? version
      : 'unrecognized'
    if (localEgress) {
      const caDir = join(root, 'ca')
      const make = (...args) =>
        execFileSync(
          'sh',
          [fileURLToPath(new URL('../../egress/make-ca.sh', import.meta.url)), ...args],
          { stdio: 'pipe' },
        )
      make('ca', caDir)
      make('server', caDir, 'egress-1.raditi.internal')
      make('client', caDir, 'spike-local', '1')
      const read = (path) => readFileSync(join(caDir, path))
      egress = createEgressProxy({
        tls: {
          cert: read('server/egress-1.raditi.internal.pem'),
          key: read('server/egress-1.raditi.internal-key.pem'),
          root: read('root.pem'),
          clientCa: read('client-ca.pem'),
        },
        allow: new Set(['chatgpt.com:443']),
        clientCns: new Set(['spike-local']),
        log: (entry) => egressLog.push(entry),
      })
      egress.on('connection', (socket) => {
        egressSockets.add(socket)
        socket.once('close', () => egressSockets.delete(socket))
      })
      await listen(egress)
      const tls = {
        ca: read('root.pem'),
        cert: read('clients/spike-local.pem'),
        key: read('clients/spike-local-key.pem'),
      }
      agent = egressAgent({ address: '127.0.0.1', port: egress.address().port, ...tls })
      report.local_probe_bytes = await new Promise((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: egress.address().port,
            servername: 'egress-1.raditi.internal',
            path: '/probe?bytes=1048576',
            ...tls,
          },
          (res) => {
            let bytes = 0
            res.on('data', (chunk) => {
              bytes += chunk.length
            })
            res.on('error', reject)
            res.on('end', () =>
              res.statusCode === 200 ? resolve(bytes) : reject(new Error('local probe refused')),
            )
          },
        )
        req.setTimeout(10_000, () => req.destroy(new Error('local probe timeout')))
        req.on('error', reject)
        req.end()
      })
    }
    const adapter = backendAdapter
      ? (await import('./backend-adapter.mjs')).createCodexAdapter({ model })
      : undefined
    proxy = createRecordProxy({
      localKey,
      codexAuth,
      codexAdapter: adapter,
      recordFile,
      agent,
      print: () => {},
    })
    await listen(proxy)
    const base = `http://127.0.0.1:${proxy.address().port}`
    writeFileSync(
      join(home, 'config.toml'),
      `model = "${model}"
model_provider = "raditi"
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "workspace-write"
check_for_update_on_startup = false
chatgpt_base_url = "${base}/disabled/"
cli_auth_credentials_store = "ephemeral"
web_search = "disabled"
[analytics]
enabled = false
[model_providers.raditi]
name = "Raditi local spike"
base_url = "${base}/codex"
wire_api = "responses"
env_key = "RADITI_LLM_TOKEN"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 45000
`,
      { mode: 0o600 },
    )
    const schema = join(root, 'schema.json')
    writeFileSync(
      schema,
      JSON.stringify({
        type: 'object',
        properties: { ok: { type: 'boolean' }, stage: { enum: ['created', 'resumed'] } },
        required: ['ok', 'stage'],
        additionalProperties: false,
      }),
    )
    let previousLimit
    for (let i = 0; i < 2; i++) {
      if (adapter) {
        const result = await adapter.probe({ credential: codexAuth.credential, agent })
        const limit = result.windows?.map(({ name, usedPct }) => ({ name, usedPct })) ?? null
        report.steps.push({ phase: 'usage_probe', adapter: true, ...result })
        if (i === 1)
          report.usage_probe_percentages_unchanged =
            previousLimit && limit ? JSON.stringify(previousLimit) === JSON.stringify(limit) : null
        previousLimit = limit
        if (result.status !== 'ok' || !result.windows?.length)
          throw Object.assign(new Error('usage probe failed'), { code: 'USAGE_PROBE_FAILED' })
        continue
      }
      const response = await fetch(`${base}/wham/usage`, {
        headers: { authorization: `Bearer ${localKey}` },
        signal: AbortSignal.timeout(20_000),
      })
      const body = await response.json().catch(() => ({}))
      const limit = windowUsage(body)
      report.steps.push({
        phase: 'usage_probe',
        status: response.status,
        body_fields: Object.keys(body),
      })
      if (i === 1)
        report.usage_probe_percentages_unchanged =
          previousLimit && limit ? JSON.stringify(previousLimit) === JSON.stringify(limit) : null
      previousLimit = limit
      if (response.status !== 200)
        throw Object.assign(new Error('usage probe failed'), { code: 'USAGE_PROBE_FAILED' })
    }
    let threadId
    for (const phase of ['create', 'resume']) {
      const last = join(root, `${phase}.json`)
      const args = [
        ...(phase === 'resume' ? ['resume'] : []),
        '--strict-config',
        '--skip-git-repo-check',
        '--json',
        '--output-schema',
        schema,
        '--output-last-message',
        last,
        ...(phase === 'resume' ? [threadId] : []),
      ]
      const prompt =
        phase === 'create'
          ? 'Synthetic test. Do not use network or read outside the current directory. Create only marker.txt containing exactly LOCAL_CODEX_OK followed by a newline. Use a file-writing tool. Final JSON: ok=true, stage="created".'
          : 'Continue the synthetic test: read marker.txt and append RESUME_OK on a second line. Do not use network or read other directories. Final JSON: ok=true, stage="resumed".'
      const run = await runCli(binary, args, prompt, work, env)
      // Do not rely on the CLI exit code to stop after an authentication failure.
      // The existing subscription is read-only: even a successful-looking CLI must not resume.
      const unauthorized = readExchanges(recordFile).some(
        (exchange) =>
          subscriptionPaths.includes(exchange.path?.split('?')[0]) &&
          (exchange.response?.status === 401 || /^401 /.test(exchange.refused ?? '')),
      )
      threadId ??= run.events?.find((event) => event.type === 'thread.started')?.thread_id
      const expected = phase === 'create' ? 'LOCAL_CODEX_OK\n' : 'LOCAL_CODEX_OK\nRESUME_OK\n'
      let output
      try {
        output = JSON.parse(readFileSync(last, 'utf8'))
      } catch {
        /* Report the failed schema check. */
      }
      const passed =
        !unauthorized &&
        run.code === 0 &&
        existsSync(join(work, 'marker.txt')) &&
        readFileSync(join(work, 'marker.txt'), 'utf8') === expected &&
        output?.ok === true &&
        output.stage === (phase === 'create' ? 'created' : 'resumed')
      report.steps.push({
        phase,
        passed,
        exit_code: run.code,
        timed_out: run.timedOut,
        authentication_failed: unauthorized,
        structured_output_valid: output?.ok === true,
        event_types: [
          ...new Set(
            (run.events ?? []).map((event) => allowed(event.type, cliEventTypes)).filter(Boolean),
          ),
        ],
        ...(passed
          ? {}
          : { stderr_present: Boolean(run.stderr), spawn_failed: Boolean(run.error) }),
      })
      if (!passed || !threadId) break
    }
  } catch (error) {
    report.error = errorCode(error)
  } finally {
    try {
      await close(proxy)
      agent?.destroy()
      for (const socket of egressSockets) socket.destroy()
      await close(egress)
      const raw = existsSync(recordFile) ? readFileSync(recordFile, 'utf8') : ''
      report.secret_scan_clean = !secrets
        .filter((value) => typeof value === 'string' && value.length >= 8)
        .some((value) => raw.includes(value))
      report.exchanges = readExchanges(recordFile).map(summarizeExchange)
      report.egress = egressLog.map(({ event, host, result }) => ({ event, host, result }))
      report.auth_file_unchanged = before === fingerprint()
      report.test_home_has_no_auth = !existsSync(join(home, 'auth.json'))
    } catch (error) {
      report.cleanup_error = errorCode(error)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  if (backendAdapter) report.backend_adapter_passed = adapterVerificationPassed(report)
  return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    options = { authFile: process.env.RECORD_CODEX_AUTH }
  try {
    while (args.length) {
      const arg = args.shift()
      if (arg === '--local-egress') options.localEgress = true
      else if (arg === '--backend-adapter') options.backendAdapter = true
      else if (arg === '--confirm-live-subscription') options.confirmLive = true
      else if (['--model', '--codex'].includes(arg)) {
        const value = args.shift()
        if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
        options[{ '--model': 'model', '--codex': 'binary' }[arg]] = value
      } else throw new Error(`unknown argument: ${arg}`)
    }
    const result = await runLocalSpike(options)
    console.log(JSON.stringify(result, null, 2))
    if (
      result.error ||
      result.cleanup_error ||
      !result.steps.find((step) => step.phase === 'resume')?.passed ||
      !result.secret_scan_clean ||
      !result.auth_file_unchanged ||
      !result.test_home_has_no_auth ||
      (result.backend_adapter && !result.backend_adapter_passed)
    )
      process.exitCode = 1
  } catch (error) {
    const argumentError =
      [
        '--model must name the model to test',
        'RECORD_CODEX_AUTH must name the login file',
        'a live run needs --confirm-live-subscription',
      ].includes(error.message) ||
      /^missing value for --(model|codex)$/.test(error.message) ||
      /^unknown argument: --[a-z-]{1,40}$/.test(error.message)
    console.error(`local-spike: ${argumentError ? error.message : errorCode(error)}`)
    process.exitCode = 1
  }
}
