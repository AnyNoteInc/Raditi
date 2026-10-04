import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { adapterVerificationPassed, runLocalSpike, summarizeExchange } from './local-spike.mjs'

test('adapter verification cannot pass on passthrough, partial streams or mismatched counts', () => {
  const call = {
    path: '/codex/responses',
    status: 200,
    usage: {
      input_tokens: 9,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
    adapter: {
      normalized: true,
      outcome: 'completed',
      signal: 'ok',
      usage_issue: null,
      usage: { input: 9, output: 4, cacheRead: 3, cacheWrite: 0, reasoning: 2 },
    },
  }
  const report = () => ({
    steps: Array.from({ length: 2 }, () => ({
      phase: 'usage_probe',
      adapter: true,
      status: 'ok',
      windows: [{ name: '5h', usedPct: 5 }],
    })),
    exchanges: [structuredClone(call), structuredClone(call)],
  })
  assert.equal(adapterVerificationPassed(report()), true)
  const weeklyOnly = report()
  weeklyOnly.steps.forEach((step) => {
    step.windows[0].name = 'week'
  })
  assert.equal(adapterVerificationPassed(weeklyOnly), true)
  const unreadableHeaders = report()
  unreadableHeaders.exchanges[0].response_header_names = ['x-codex-primary-window-minutes']
  assert.equal(adapterVerificationPassed(unreadableHeaders), false)
  unreadableHeaders.exchanges[0].adapter.windows_parsed = true
  assert.equal(adapterVerificationPassed(unreadableHeaders), true)
  for (const mutate of [
    (r) => {
      delete r.exchanges[0].adapter
    },
    (r) => {
      r.exchanges[0].adapter.outcome = 'incomplete'
    },
    (r) => {
      r.exchanges[0].adapter.usage.reasoning = 0
    },
    (r) => {
      r.exchanges[0].adapter.usage_issue = 'invalid_usage'
    },
    (r) => {
      r.exchanges[0].status = 401
    },
    (r) => {
      r.steps[1].status = 'auth'
    },
    (r) => {
      r.steps[1].windows = null
    },
    (r) => {
      r.exchanges.pop()
    },
  ]) {
    const changed = report()
    mutate(changed)
    assert.equal(adapterVerificationPassed(changed), false)
  }
  assert.equal(adapterVerificationPassed({}), false)
})

test('adapter report keeps numeric metering but never provider or credential diagnostics', () => {
  const marker = 'private-synthetic-provider-message'
  const summary = summarizeExchange({
    adapter: {
      normalized: false,
      error: marker,
      meter: {
        outcome: 'failed',
        usageIssue: 'invalid_usage',
        signal: { reason: marker },
        usage: { input: 4, output: marker, account: marker },
        deltaTextBytes: 9,
      },
      signal: { kind: 'account_risk', reason: marker },
      windows: { private: marker },
    },
  })
  assert.ok(!JSON.stringify(summary).includes(marker))
  assert.equal(summary.adapter.usage.input, 4)
  assert.equal(summary.adapter.signal, 'account_risk')
  assert.equal(summary.adapter.usage.output, undefined)
})

test('the adapter report keeps every signal kind of the LlmBackend port and nothing else', async () => {
  // The list is the port's own: a kind added there must not vanish from the spike report.
  const { callSignalSchema } = await import('../../../packages/domain/src/ports/llm-backend.ts')
  const kinds = callSignalSchema.options.map((option) => option.shape.kind.value)
  assert.ok(kinds.length >= 10 && kinds.every((kind) => /^[a-z_]+$/.test(kind)))
  // A request the provider rejected is a final turn outcome, not an account or profile failure.
  assert.ok(kinds.includes('request_rejected'))
  for (const kind of kinds)
    assert.equal(
      summarizeExchange({ adapter: { signal: { kind, code: 'synthetic' } } }).adapter.signal,
      kind,
    )
  for (const kind of ['private-synthetic-kind', undefined, 7])
    assert.equal(summarizeExchange({ adapter: { signal: { kind } } }).adapter.signal, undefined)
})

test('the local report retains protocol shape and usage without payloads or identifiers', () => {
  const privateValues = [
    'synthetic-prompt-content',
    'synthetic-header-value',
    'synthetic-thread-id',
    'synthetic-response-id',
    'synthetic-provider-error-content',
    'synthetic-query-secret',
    'synthetic-usage-attribution-id',
  ]
  const summary = summarizeExchange({
    method: 'POST',
    path: `/codex/responses?private=${privateValues[5]}`,
    request: {
      body: {
        input: privateValues[0],
        store: false,
        text: { format: { type: 'json_schema' } },
        metadata: { thread_id: privateValues[2] },
      },
      headers: { 'x-synthetic': privateValues[1] },
      stripped: ['client_metadata'],
    },
    response: {
      status: 200,
      headers: { 'x-synthetic-response': privateValues[1] },
      body: { id: privateValues[3], error: { message: privateValues[4] } },
      events: [
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: privateValues[3],
              output: [{ content: privateValues[0] }],
              usage: {
                input_tokens: 7,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens_details: { reasoning_tokens: 1 },
                provider_note: privateValues[4],
                attribution: { items: { [privateValues[6]]: { input_tokens: 7 } } },
              },
            },
          },
        },
      ],
    },
  })
  const serialized = JSON.stringify(summary)
  for (const value of privateValues) assert.ok(!serialized.includes(value))
  assert.equal(summary.path, '/codex/responses')
  assert.equal(summary.status, 200)
  assert.equal(summary.store_false, true)
  assert.equal(summary.structured_output, true)
  assert.deepEqual(summary.response_header_names, ['x-synthetic-response'])
  assert.deepEqual(summary.event_types, ['response.completed'])
  assert.deepEqual(summary.usage, {
    input_tokens: 7,
    output_tokens: 3,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  })
})

test('the local report never copies arbitrary transport or provider error messages', () => {
  const privateMessage = 'synthetic-private-error-with-thread-id-and-prompt'
  const summary = summarizeExchange({
    method: 'POST',
    path: '/codex/responses',
    error: privateMessage,
    refused: privateMessage,
    response: {
      status: 500,
      transport_end: privateMessage,
      outcome: privateMessage,
      terminal_event: privateMessage,
      body: { error: { message: privateMessage } },
      events: [
        { data: { type: 'response.failed', response: { error: { message: privateMessage } } } },
      ],
    },
  })
  assert.ok(!JSON.stringify(summary).includes(privateMessage))
  assert.equal(summary.status, 500)
  assert.deepEqual(summary.event_types, ['response.failed'])
})

test('invalid models fail before attempting to read authentication', async () => {
  for (const model of [undefined, '', '../../invalid', 'model"\nunsafe']) {
    await assert.rejects(
      runLocalSpike({
        model,
        authFile: '/nonexistent-raditi-synthetic-auth/auth.json',
        confirmLive: true,
      }),
      /--model must name the model to test/,
    )
  }
})

test('a live run needs an explicit login file and a confirmation before anything is read', async (t) => {
  const fake = syntheticRun(t)
  const missing = '/nonexistent-raditi-synthetic-auth/auth.json'
  // No default path: the owner's ~/.codex/auth.json is never picked up implicitly. HOME points
  // at the synthetic root meanwhile, so even a regression to a default cannot open the real one.
  const home = process.env.HOME
  process.env.HOME = dirname(fake.authFile)
  try {
    for (const authFile of [undefined, '', 'relative/auth.json'])
      await assert.rejects(
        runLocalSpike({
          model: 'synthetic-model',
          binary: fake.binary,
          authFile,
          confirmLive: true,
        }),
        { code: 'AUTH_FILE_REQUIRED' },
      )
  } finally {
    process.env.HOME = home
  }
  // A missing confirmation stops before the file is opened (no ENOENT for a missing file).
  for (const authFile of [fake.authFile, missing])
    for (const confirmLive of [undefined, false, 'yes'])
      await assert.rejects(
        runLocalSpike({ model: 'synthetic-model', binary: fake.binary, authFile, confirmLive }),
        { code: 'LIVE_CONFIRMATION_REQUIRED' },
      )
  assert.equal(fake.probeCount(), 0)
  assert.deepEqual(fake.calls(), [])
  assert.equal(readFileSync(fake.authFile, 'utf8'), fake.auth)
})

test('CLI argument errors require an explicit valid model before any live run', () => {
  const script = fileURLToPath(new URL('./local-spike.mjs', import.meta.url))
  for (const args of [[], ['--confirm-live-subscription', '--model']]) {
    const run = spawnSync(process.execPath, [script, ...args], {
      env: { HOME: '/nonexistent-raditi-synthetic-home' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(run.status, 1)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /--model must name the model to test|missing value for --model/)
    assert.doesNotMatch(run.stderr, /ENOENT|auth\.json/)
  }
})

test('the launcher reads the login only from RECORD_CODEX_AUTH and only with a confirmation', () => {
  const script = fileURLToPath(new URL('./local-spike.mjs', import.meta.url))
  const missing = '/nonexistent-raditi-synthetic-auth/auth.json'
  for (const [args, env, expected] of [
    [['--model', 'synthetic-model', '--confirm-live-subscription'], {}, /RECORD_CODEX_AUTH/],
    [['--model', 'synthetic-model'], { RECORD_CODEX_AUTH: missing }, /--confirm-live-subscription/],
    [
      ['--model', 'synthetic-model', '--auth-file', missing, '--confirm-live-subscription'],
      {},
      /unknown argument: --auth-file/,
    ],
  ]) {
    const run = spawnSync(process.execPath, [script, ...args], {
      // A synthetic HOME: a regression to a default login path cannot reach the real one.
      env: { ...env, HOME: '/nonexistent-raditi-synthetic-home' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(run.status, 1)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, expected)
    assert.doesNotMatch(run.stderr, /ENOENT|auth\.json/)
  }
})

test('unknown paths and non-protocol event values cannot disclose identifiers', () => {
  const marker = 'synthetic-private-path-or-event-id'
  const summary = summarizeExchange({
    method: { value: marker },
    path: `/disabled/threads/${marker}`,
    request: { stripped: [marker, 'client_metadata'] },
    response: {
      status: { value: marker },
      bytes: marker,
      events: [{ data: { type: { value: marker } } }, { event: marker }],
    },
  })
  assert.ok(!JSON.stringify(summary).includes(marker))
  assert.equal(summary.path, '[other path]')
  assert.deepEqual(summary.stripped, ['client_metadata'])
  assert.deepEqual(summary.event_types, [])
})

// Every login, executable and reply below is synthetic. fetch is intercepted before
// starting the launcher, so these tests can never contact a subscription provider.
function syntheticRun(
  t,
  { mode = 'success', probeStatus = 200, expires = Date.now() / 1000 + 3600 } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'raditi-local-spike-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const authFile = join(root, 'auth.json')
  const jwt = (claims) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
  const auth = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({
        iat: expires - 3600,
        exp: expires,
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      }),
      account_id: 'synthetic-account-id-private',
      refresh_token: 'synthetic-refresh-token-private',
      id_token: 'synthetic-id-token-private',
    },
  })
  writeFileSync(authFile, auth, { mode: 0o600 })
  const callsFile = join(root, 'calls.jsonl')
  const binary = join(root, 'fake-codex.mjs')
  writeFileSync(
    binary,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
const root = dirname(process.env.CODEX_HOME)
const phase = args[0] === '--version' ? 'version' : args.includes('resume') ? 'resume' : 'create'
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ root, phase, home: process.env.HOME }) + '\\n')
if (phase === 'version') {
  if (${JSON.stringify(mode)} === 'version-failure') {
    console.error('synthetic-private-version-error')
    process.exit(1)
  }
  console.log('codex-cli 0.0.0-synthetic')
} else {
  writeFileSync(join(process.cwd(), 'marker.txt'), phase === 'create' ? 'LOCAL_CODEX_OK\\n' : 'LOCAL_CODEX_OK\\nRESUME_OK\\n')
  writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ ok: true, stage: phase === 'create' ? 'created' : 'resumed' }))
  if (${JSON.stringify(mode)} === 'side-channel-401')
    appendFileSync(join(root, 'exchanges.jsonl'), JSON.stringify({ method: 'GET', path: '/disabled/plugins/featured', refused: '401 local key required' }) + '\\n')
  appendFileSync(join(root, 'exchanges.jsonl'), ${JSON.stringify(mode)} === 'malformed-journal'
    ? 'synthetic-private-malformed-journal\\n'
    : JSON.stringify({ method: 'POST', path: '/codex/responses', response: { status: ${mode === 'model-401' ? 401 : 200} } }) + '\\n')
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-private-thread-id' }))
  console.log(JSON.stringify({ type: 'turn.completed' }))
}
`,
    { mode: 0o700 },
  )
  let probes = 0
  t.mock.method(globalThis, 'fetch', async () => {
    probes++
    return {
      status: probeStatus,
      json: async () => ({
        rate_limit: { primary_window: { used_percent: 1 }, secondary_window: { used_percent: 2 } },
      }),
    }
  })
  return {
    auth,
    authFile,
    binary,
    probeCount: () => probes,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  }
}

test('a 401 usage probe stops before every model step and preserves the existing login', async (t) => {
  const fake = syntheticRun(t, { probeStatus: 401 })
  const report = await runLocalSpike({
    model: 'synthetic-model',
    authFile: fake.authFile,
    binary: fake.binary,
    confirmLive: true,
  })
  assert.equal(report.error, 'USAGE_PROBE_FAILED')
  assert.equal(fake.probeCount(), 1)
  assert.deepEqual(
    fake.calls().map((call) => call.phase),
    ['version'],
  )
  assert.deepEqual(
    report.steps.map((step) => step.phase),
    ['usage_probe'],
  )
  assert.equal(report.auth_file_unchanged, true)
  assert.equal(report.test_home_has_no_auth, true)
  assert.equal(readFileSync(fake.authFile, 'utf8'), fake.auth)
  assert.ok(fake.calls().every((call) => !existsSync(call.root)))
})

test('a recorded model 401 prevents resume even when the CLI reports success', async (t) => {
  const fake = syntheticRun(t, { mode: 'model-401' })
  const report = await runLocalSpike({
    model: 'synthetic-model',
    authFile: fake.authFile,
    binary: fake.binary,
    confirmLive: true,
  })
  assert.equal(fake.probeCount(), 2)
  assert.deepEqual(
    fake.calls().map((call) => call.phase),
    ['version', 'create'],
  )
  assert.equal(report.steps.find((step) => step.phase === 'create').passed, false)
  assert.equal(report.steps.find((step) => step.phase === 'create').authentication_failed, true)
  assert.ok(!report.steps.some((step) => step.phase === 'resume'))
  assert.equal(report.auth_file_unchanged, true)
  assert.ok(fake.calls().every((call) => !existsSync(call.root)))
  assert.ok(!JSON.stringify(report).includes('synthetic-private-thread-id'))
})

test('an unauthorized disabled plugin side request does not stop valid model steps', async (t) => {
  const fake = syntheticRun(t, { mode: 'side-channel-401' })
  const report = await runLocalSpike({
    model: 'synthetic-model',
    authFile: fake.authFile,
    binary: fake.binary,
    confirmLive: true,
  })
  assert.equal(report.error, undefined)
  assert.equal(report.cleanup_error, undefined)
  assert.deepEqual(
    fake.calls().map((call) => call.phase),
    ['version', 'create', 'resume'],
  )
  for (const phase of ['create', 'resume']) {
    const step = report.steps.find((step) => step.phase === phase)
    assert.equal(step.passed, true)
    assert.equal(step.authentication_failed, false)
  }
  assert.equal(
    report.exchanges.filter(
      (exchange) =>
        exchange.path === '/disabled/plugins/featured' && exchange.refusal_status === 401,
    ).length,
    2,
  )
  assert.equal(report.auth_file_unchanged, true)
  assert.equal(report.test_home_has_no_auth, true)
  assert.equal(report.secret_scan_clean, true)
  assert.ok(fake.calls().every((call) => !existsSync(call.root)))
  // The CLI and the commands it runs see a temporary HOME, never the owner's ~/.codex.
  for (const call of fake.calls()) {
    assert.notEqual(call.home, homedir())
    assert.ok(call.home.startsWith(`${call.root}/`), 'CLI HOME must be inside the temporary root')
  }
})

test('malformed exchange records still clean temporary state and return only error codes', async (t) => {
  const fake = syntheticRun(t, { mode: 'malformed-journal' })
  const report = await runLocalSpike({
    model: 'synthetic-model',
    authFile: fake.authFile,
    binary: fake.binary,
    confirmLive: true,
  })
  assert.equal(report.error, 'SPIKE_FAILED')
  assert.equal(report.cleanup_error, 'SPIKE_FAILED')
  assert.ok(!report.steps.some((step) => step.phase === 'resume'))
  assert.ok(fake.calls().every((call) => !existsSync(call.root)))
  assert.equal(readFileSync(fake.authFile, 'utf8'), fake.auth)
  assert.ok(!JSON.stringify(report).includes('synthetic-private-malformed-journal'))
})

test('version failure cleans temporary state without retaining subprocess stderr', async (t) => {
  const fake = syntheticRun(t, { mode: 'version-failure' })
  const report = await runLocalSpike({
    model: 'synthetic-model',
    authFile: fake.authFile,
    binary: fake.binary,
    confirmLive: true,
  })
  assert.equal(report.error, 'SPIKE_FAILED')
  assert.equal(fake.probeCount(), 0)
  assert.deepEqual(
    fake.calls().map((call) => call.phase),
    ['version'],
  )
  assert.ok(fake.calls().every((call) => !existsSync(call.root)))
  assert.ok(!JSON.stringify(report).includes('synthetic-private-version-error'))
})

test('an expired synthetic login stops before CLI execution or any probe', async (t) => {
  const fake = syntheticRun(t, { expires: Date.now() / 1000 - 60 })
  await assert.rejects(
    runLocalSpike({
      model: 'synthetic-model',
      authFile: fake.authFile,
      binary: fake.binary,
      confirmLive: true,
    }),
    { code: 'AUTH_EXPIRED' },
  )
  assert.equal(fake.probeCount(), 0)
  assert.deepEqual(fake.calls(), [])
  assert.equal(readFileSync(fake.authFile, 'utf8'), fake.auth)
})
