import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  zaiCodingBackend,
  zaiCodingPlan,
} from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import { createVerificationCertificates } from './certificates.mjs'
import { SYNTHETIC_KIMI_KEY, startFakeSubscriptions } from './fake-subscriptions.mjs'
import {
  createFakeZaiState,
  handleZai,
  isZaiRequest,
  startFakeZai,
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_MARKER,
  ZAI_ERROR_STATUS,
  ZAI_PATHS,
} from './fake-zai.mjs'
import { checkSanitized } from './sanitize-samples.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixtures = join(root, 'packages/llm-backends/src/zai-coding/fixtures')
const research = join(root, 'docs/research/2026-10-opencode-glm')
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'raditi-fake-zai-'))
after(() => rmSync(temp, { recursive: true, force: true }))
const makeCa = fileURLToPath(new URL('../../egress/make-ca.sh', import.meta.url))
execFileSync('sh', [makeCa, 'ca', temp], { stdio: 'pipe' })
execFileSync('sh', [makeCa, 'server', temp, 'fake.raditi.internal'], { stdio: 'pipe' })
const keyFile = join(temp, 'server/fake.raditi.internal-key.pem')
const certFile = join(temp, 'server/fake.raditi.internal.pem')
const tls = { key: readFileSync(keyFile), cert: readFileSync(certFile) }
const ca = readFileSync(join(temp, 'root.pem'))

const credential = { v: '1', kind: 'zai_api_key', apiKey: SYNTHETIC_ZAI_KEY }
const userAgent = 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const chatBody = (patch = {}) => ({
  model: 'glm-5.3',
  max_tokens: 32_000,
  messages: [{ role: 'user', content: 'Synthetic request.' }],
  stream: true,
  stream_options: { include_usage: true },
  ...patch,
})

/** The handler alone behind plain HTTP: its answers do not depend on TLS. */
async function plain(t, initial) {
  const state = createFakeZaiState(initial)
  const server = createServer((req, res) => {
    assert.equal(isZaiRequest(req), true)
    handleZai(req, res, state).catch(() => res.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { state, port: server.address().port }
}
function send(target, path, { method = 'POST', body, headers = {}, key = SYNTHETIC_ZAI_KEY } = {}) {
  return new Promise((resolve, reject) => {
    const secure = target.ca !== undefined
    const req = (secure ? httpsRequest : httpRequest)(
      {
        hostname: '127.0.0.1',
        port: target.port,
        ...(secure ? { servername: 'fake.raditi.internal', ca: target.ca } : {}),
        path,
        method,
        agent: false,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key === null ? {} : { authorization: `Bearer ${key}` }),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const chat = (target, body = chatBody(), options = {}) =>
  send(target, ZAI_PATHS.chat, { body, ...options })
const frames = (text) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => block.slice('data: '.length))
const chunks = (text) =>
  frames(text)
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data))
/** The role's view of a stream: the production inspector and meter of the adapter. */
function inspect(text) {
  const inspector = zaiCodingBackend.streamInspector()
  const meter = zaiCodingBackend.usageMeter()
  meter.push(Buffer.from(text))
  const seen = []
  let stopped = false
  for (const data of frames(text)) {
    const item = inspector.inspect({ event: 'message', data })
    seen.push(item)
    if (item.kind === 'failure' || item.terminal) {
      stopped = true
      break
    }
  }
  if (!stopped) {
    const ending = inspector.end()
    if (ending) seen.push(ending)
  }
  return { seen, meter: meter.end(), failure: seen.find((item) => item.kind === 'failure') }
}
/** The adapter's own probe against the fake's quota path. */
const probe = (target, key = SYNTHETIC_ZAI_KEY) =>
  zaiCodingBackend.probe(
    { ...credential, apiKey: key },
    {},
    {
      async request(asked) {
        assert.equal(asked.url, `${zaiCodingPlan.origin}${ZAI_PATHS.quota}`)
        const answer = await send(target, new URL(asked.url).pathname, {
          method: asked.method,
          key: null,
          headers: Object.fromEntries(asked.headers),
        })
        return {
          status: answer.status,
          headers: new Headers(answer.headers),
          body: Buffer.from(answer.text),
        }
      },
    },
  )

/** Names of the keys of a chunk, of its choice and of its delta: the shape without the values. */
const shapeOf = (chunk) =>
  [
    Object.keys(chunk).sort().join(','),
    Object.keys(chunk.choices?.[0] ?? {})
      .sort()
      .join(','),
    Object.keys(chunk.choices?.[0]?.delta ?? {})
      .sort()
      .join(','),
    Object.keys(chunk.choices?.[0]?.delta?.tool_calls?.[0] ?? {})
      .sort()
      .join(','),
  ].join(' | ')
const recordedShapes = new Set(
  [
    '31-run-a-default/01-llm-post_chat_completions.json',
    '31-run-a-default/02-llm-post_chat_completions.json',
    '34-run-c-mcp/12-llm-post_chat_completions.json',
    '43-variant-low/01-llm-post_chat_completions.json',
  ].flatMap((name) => chunks(fixture(name).response.sse).map(shapeOf)),
)

test('the fake serves the addresses the adapter declares and nothing else', () => {
  assert.deepEqual(zaiCodingBackend.egress[0].requests, [
    `POST https://api.z.ai${ZAI_PATHS.chat}`,
    `GET https://api.z.ai${ZAI_PATHS.quota}`,
  ])
  assert.equal(isZaiRequest({ url: `${ZAI_PATHS.chat}?x=1` }), true)
  for (const url of ['/api/paas/v4/chat/completions', '/coding/v1/chat/completions', '/'])
    assert.equal(isZaiRequest({ url }), false)
})

test('text and tool answers have the frames of the recorded streams', async (t) => {
  const target = await plain(t)
  const recorded = fixture('31-run-a-default/01-llm-post_chat_completions.json')
  for (const scenario of [
    { scenario: 'text' },
    {
      scenario: 'tools',
      calls: [
        { name: 'bash', arguments: { command: 'echo one' } },
        { name: 'raditi_wp_rest', arguments: { method: 'GET', path: '/wp/v2/pages/7' } },
      ],
    },
  ]) {
    target.state.setScenario(scenario)
    const answer = await chat(target)
    assert.equal(answer.status, 200)
    assert.equal(answer.headers['content-type'], recorded.response.headers['content-type'])
    // The headers the records had and the sanitiser removed: the gateway must not pass them on.
    for (const name of recorded.response.removedHeaderNames.filter((name) => name !== 'date'))
      assert.ok(answer.headers[name], `${name} is sent`)
    const sent = frames(answer.text)
    assert.equal(sent.at(-1), '[DONE]')
    for (const chunk of chunks(answer.text))
      assert.ok(recordedShapes.has(shapeOf(chunk)), `a recorded shape: ${shapeOf(chunk)}`)
    const last = chunks(answer.text).at(-1)
    const recordedLast = chunks(recorded.response.sse).at(-1)
    assert.deepEqual(Object.keys(last.usage), Object.keys(recordedLast.usage))
    assert.deepEqual(last.choices[0].delta, recordedLast.choices[0].delta)
    assert.equal(
      last.choices[0].finish_reason,
      scenario.scenario === 'tools' ? 'tool_calls' : 'stop',
    )
    // The production inspector forwards every frame and the meter reads the fake's numbers.
    const { seen, meter, failure } = inspect(answer.text)
    assert.equal(failure, undefined)
    assert.equal(seen.length, sent.length)
    assert.deepEqual(meter.usage, {
      input: 7105,
      cacheRead: 6784,
      cacheWrite: 0,
      output: 94,
      reasoning: 54,
    })
    assert.equal(meter.outcome, 'completed')
  }
  // Two calls in one answer, each whole in its own chunk; then the text once a result came.
  const calls = chunks((await chat(target)).text).flatMap(
    (chunk) => chunk.choices[0].delta.tool_calls ?? [],
  )
  assert.deepEqual(
    calls.map((call) => [call.index, call.function.name, JSON.parse(call.function.arguments)]),
    [
      [0, 'bash', { command: 'echo one' }],
      [1, 'raditi_wp_rest', { method: 'GET', path: '/wp/v2/pages/7' }],
    ],
  )
  const answered = await chat(
    target,
    chatBody({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', tool_call_id: calls[0].id, content: 'ok' },
      ],
    }),
  )
  assert.equal(chunks(answered.text).at(-1).choices[0].finish_reason, 'stop')
})

test('usage with and without a cache and reasoning is what the scenario names', async (t) => {
  const target = await plain(t)
  target.state.setScenario({
    scenario: 'text',
    reasoning: '',
    usage: { prompt: 5579, cached: 0, completion: 3, reasoning: 0 },
  })
  const { meter } = inspect((await chat(target)).text)
  assert.deepEqual(meter.usage, {
    input: 5579,
    cacheRead: 0,
    cacheWrite: 0,
    output: 3,
    reasoning: 0,
  })
  assert.throws(() => target.state.setScenario({ usage: { prompt: 1, cached: 2 } }))
  assert.throws(() => target.state.setScenario({ usage: { completion: 1, reasoning: 2 } }))
})

test('a request without the plan key, with an unknown model or a bad parameter gets the recorded refusal', async (t) => {
  const target = await plain(t)
  const cases = [
    ['54-coding-err-no-key-stream.json', chatBody(), { key: null }],
    ['54-coding-err-invalid-key-stream.json', chatBody(), { key: 'another-key' }],
    ['54-coding-err-unknown-model-stream.json', chatBody({ model: 'glm-0-does-not-exist' }), {}],
    ['54-coding-err-bad-param-stream.json', chatBody({ max_tokens: 99_999_999 }), {}],
  ]
  for (const [name, body, options] of cases) {
    const recorded = fixture(name).response
    const answer = await chat(target, body, options)
    assert.equal(answer.status, recorded.status, name)
    assert.equal(answer.headers['content-type'], recorded.headers['content-type'], name)
    assert.equal(JSON.parse(answer.text).error.code, JSON.parse(recorded.body).error.code, name)
    assert.deepEqual(Object.keys(JSON.parse(answer.text).error), ['code', 'message'])
  }
  assert.equal(target.state.counters.generated, 0)
})

test('every documented code is answered with a status and read by the adapter as the plan says', async (t) => {
  const target = await plain(t)
  const kinds = {}
  for (const [code, status] of Object.entries(ZAI_ERROR_STATUS)) {
    target.state.setScenario({ scenario: 'error', code: Number(code) })
    const answer = await chat(target)
    assert.equal(answer.status, status)
    const body = JSON.parse(answer.text)
    assert.equal(body.error.code, code)
    assert.ok(body.error.message.includes(SYNTHETIC_ZAI_MARKER))
    const signal = zaiCodingBackend.classify(answer.status, new Headers(answer.headers), body)
    kinds[code] = signal.kind
    assert.equal(JSON.stringify(signal).includes(SYNTHETIC_ZAI_MARKER), false)
  }
  assert.deepEqual(kinds, {
    401: 'auth',
    1001: 'auth',
    1113: 'account_risk',
    1210: 'request_rejected',
    1211: 'profile',
    1261: 'request_rejected',
    1301: 'policy_flagged',
    1302: 'transient',
    1305: 'transient',
    1308: 'window_exhausted',
    1309: 'account_risk',
    1310: 'window_exhausted',
    1311: 'profile',
    1313: 'account_risk',
    1316: 'window_exhausted',
    1317: 'window_exhausted',
  })
  // A code nobody has documented needs its status, and ends as an unconfirmed block.
  assert.throws(() => target.state.setScenario({ scenario: 'error', code: 4242 }))
  target.state.setScenario({ scenario: 'error', code: 4242, status: 429, retryAfter: '999999' })
  const unknown = await chat(target)
  assert.equal(unknown.headers['retry-after'], '999999')
  assert.deepEqual(
    zaiCodingBackend.classify(429, new Headers(unknown.headers), JSON.parse(unknown.text)),
    { kind: 'unconfirmed_block', code: 'zai_4242' },
  )
  // A pause the provider names never outlives the short one.
  target.state.setScenario({ scenario: 'error', code: 1305, retryAfter: '999999' })
  const busy = await chat(target)
  assert.deepEqual(
    zaiCodingBackend.classify(busy.status, new Headers(busy.headers), JSON.parse(busy.text)),
    { kind: 'transient', retryAfterMs: 30_000 },
  )
})

test('a short-lived failure can be limited to the first requests', async (t) => {
  const target = await plain(t)
  target.state.setScenario({ scenario: 'error', code: 1305, failures: 2 })
  assert.deepEqual(
    [await chat(target), await chat(target), await chat(target)].map((answer) => answer.status),
    [429, 429, 200],
  )
})

test('the three finishing values pass the inspector and every other one becomes a failure', async (t) => {
  const target = await plain(t)
  for (const finish of ['stop', 'tool_calls', 'length']) {
    target.state.setScenario({ scenario: 'finish', finish })
    const { failure, meter } = inspect((await chat(target)).text)
    assert.equal(failure, undefined, finish)
    assert.equal(meter.outcome, 'completed')
  }
  for (const [finish, kind] of [
    ['sensitive', 'policy_flagged'],
    ['content_filter', 'policy_flagged'],
    ['model_context_window_exceeded', 'request_rejected'],
    ['network_error', 'transient'],
    ['synthetic_later_value', 'unconfirmed_block'],
  ]) {
    target.state.setScenario({ scenario: 'finish', finish })
    const answer = await chat(target)
    assert.equal(chunks(answer.text).at(-1).choices[0].finish_reason, finish)
    const { failure, meter } = inspect(answer.text)
    assert.equal(failure.signal.kind, kind, finish)
    // The provider counted the call: its usage is kept.
    assert.equal(meter.usage.input, 7105)
    assert.equal(failure.event.data.includes(finish), false)
  }
  assert.throws(() => target.state.setScenario({ scenario: 'finish' }))
  assert.throws(() => target.state.setScenario({ scenario: 'finish', finish: 'two words' }))
})

test('hostile answers are what their names say, and the adapter stops on each of them', async (t) => {
  const target = await plain(t)
  const ask = async (scenario) => {
    target.state.setScenario(scenario)
    return chat(target)
  }
  // HTTP 200 without a stream: the role refuses it before the inspector (not an event stream).
  const envelope = await ask({ scenario: 'envelope200', code: 500 })
  assert.equal(envelope.status, 200)
  assert.equal(envelope.headers['content-type'], 'application/json')
  assert.deepEqual(Object.keys(JSON.parse(envelope.text)), ['code', 'msg', 'success'])
  assert.equal(JSON.parse(envelope.text).success, false)
  const ready = await ask({ scenario: 'plain200' })
  assert.equal(ready.status, 200)
  assert.equal(ready.headers['content-type'], 'application/json; charset=UTF-8')
  const recorded = JSON.parse(fixture('61-chat-first-after-idle.json').response.body)
  assert.deepEqual(Object.keys(JSON.parse(ready.text)).sort(), Object.keys(recorded).sort())
  assert.deepEqual(
    Object.keys(JSON.parse(ready.text).usage).sort(),
    Object.keys(recorded.usage).sort(),
  )
  // A request that asks for no stream gets the same whole answer.
  target.state.setScenario({ scenario: 'text' })
  assert.equal(
    (await chat(target, chatBody({ stream: false }))).headers['content-type'],
    'application/json; charset=UTF-8',
  )

  const noUsage = await ask({ scenario: 'no_usage' })
  assert.equal(frames(noUsage.text).at(-1), '[DONE]')
  assert.deepEqual(
    [inspect(noUsage.text).meter.outcome, inspect(noUsage.text).meter.usageIssue],
    ['completed', 'no_usage'],
  )
  const noDone = await ask({ scenario: 'no_done' })
  assert.notEqual(frames(noDone.text).at(-1), '[DONE]')
  // Finished, only DONE is missing: a complete answer.
  assert.equal(inspect(noDone.text).failure, undefined)
  assert.equal(inspect(noDone.text).meter.outcome, 'completed')

  // The four streams the CLI answers with a request storm.
  const doneOnly = await ask({ scenario: 'done_only' })
  assert.deepEqual(frames(doneOnly.text), ['[DONE]'])
  const noFinish = await ask({ scenario: 'no_finish' })
  assert.equal(frames(noFinish.text).at(-1), '[DONE]')
  assert.ok(chunks(noFinish.text).every((chunk) => chunk.choices[0].finish_reason === undefined))
  const open = await ask({ scenario: 'no_finish_no_done' })
  assert.ok(open.text.length > 0 && !open.text.includes('[DONE]'))
  const empty = await ask({ scenario: 'empty' })
  assert.equal(empty.status, 200)
  assert.equal(empty.headers['content-type'], 'text/event-stream;charset=UTF-8')
  assert.equal(empty.text, '')
  for (const answer of [doneOnly, noFinish, open, empty]) {
    const { failure, meter } = inspect(answer.text)
    assert.deepEqual(failure.signal, { kind: 'unconfirmed_block', code: 'zai_stream_unfinished' })
    assert.notEqual(meter.outcome, 'completed')
  }

  const inStream = await ask({ scenario: 'stream_error', code: 1308 })
  assert.equal(inStream.status, 200)
  assert.ok(inStream.text.includes(SYNTHETIC_ZAI_MARKER))
  const refused = inspect(inStream.text).failure
  assert.deepEqual(refused.signal, { kind: 'window_exhausted', until: null })
  assert.equal(refused.event.data.includes(SYNTHETIC_ZAI_MARKER), false)

  target.state.setScenario({ scenario: 'cut' })
  await assert.rejects(chat(target))
  target.state.setScenario({ scenario: 'text', retryAfter: '999999' })
  assert.equal((await chat(target)).headers['retry-after'], '999999')
})

test('the quota follows the requests the way the records show', async (t) => {
  const target = await plain(t)
  // After a night without requests: sample 60.
  const idle = JSON.parse((await send(target, ZAI_PATHS.quota, { method: 'GET' })).text)
  const recordedIdle = fixture('60-quota-idle-before.json').response.body
  assert.deepEqual(idle.data.limits[0], recordedIdle.data.limits[0])
  assert.deepEqual(Object.keys(idle), Object.keys(recordedIdle))
  assert.deepEqual(Object.keys(idle.data), Object.keys(recordedIdle.data))
  assert.deepEqual(Object.keys(idle.data.limits[1]), Object.keys(recordedIdle.data.limits[1]))
  assert.deepEqual(await probe(target), {
    status: 'ok',
    plan: null,
    creditsBalance: null,
    windows: [
      { name: '5h', usedPct: 0, resetsAt: null },
      { name: 'week', usedPct: 0.26, resetsAt: (await probe(target)).windows[1].resetsAt },
    ],
  })
  // The first request starts the five-hour window: sample 62.
  const before = Date.now()
  await chat(target)
  const started = JSON.parse((await send(target, ZAI_PATHS.quota, { method: 'GET' })).text)
  const recordedStarted = fixture('62-quota-idle-after.json').response.body.data.limits[0]
  const { nextResetTime, ...numbers } = started.data.limits[0]
  const { nextResetTime: _, ...recordedNumbers } = recordedStarted
  assert.deepEqual(numbers, recordedNumbers)
  assert.ok(nextResetTime >= before + 5 * 3_600_000 && nextResetTime <= Date.now() + 5 * 3_600_000)
  assert.deepEqual((await probe(target)).windows[0], {
    name: '5h',
    usedPct: 0.05,
    resetsAt: new Date(nextResetTime),
  })
  // Every further request is one credit in both counters of both windows.
  for (let i = 0; i < 3; i++) await chat(target)
  const later = JSON.parse((await send(target, ZAI_PATHS.quota, { method: 'GET' })).text)
  assert.deepEqual(
    later.data.limits.map((limit) => [limit.currentValue, limit.remaining]),
    [
      [3, 1996],
      [29, 9970],
    ],
  )
  assert.equal((await probe(target)).windows[0].usedPct, 0.2)
  // A request the provider refused spends nothing.
  target.state.setScenario({ scenario: 'error', code: 1305 })
  await chat(target)
  assert.equal(target.state.quota.fiveHour.remaining, 1996)
})

test('an exhausted window refuses generation and reads as full; a passed reset as a new window', async (t) => {
  const target = await plain(t)
  target.state.setQuota({ fiveHour: { exhausted: true } })
  const refused = await chat(target)
  assert.equal(refused.status, 429)
  assert.equal(JSON.parse(refused.text).error.code, '1308')
  assert.equal(target.state.counters.generated, 0)
  assert.deepEqual(
    zaiCodingBackend.classify(429, new Headers(refused.headers), JSON.parse(refused.text)),
    { kind: 'window_exhausted', until: null },
  )
  const windows = (await probe(target)).windows
  assert.equal(windows[0].usedPct, 100)
  assert.ok(windows[0].resetsAt > new Date())
  // The reset has passed and nobody has asked since: the adapter takes the window for free,
  // and the next request starts it.
  target.state.setQuota({ fiveHour: { resetInMs: -60_000 } })
  assert.deepEqual((await probe(target)).windows[0], { name: '5h', usedPct: 0, resetsAt: null })
  assert.equal((await chat(target)).status, 200)
  assert.deepEqual(
    [target.state.quota.fiveHour.currentValue, target.state.quota.fiveHour.remaining],
    [0, 1999],
  )
  target.state.setQuota({ fiveHour: { idle: true } })
  assert.deepEqual((await probe(target)).windows[0], { name: '5h', usedPct: 0, resetsAt: null })
  // 91 % of the window: a new task is refused by the pool without any refusal of the provider.
  target.state.setQuota({ fiveHour: { currentValue: 1820, remaining: 179, resetInMs: 3_600_000 } })
  assert.equal((await probe(target)).windows[0].usedPct, 91.05)
})

test('a broken quota answer and the HTTP 200 envelopes never read as capacity', async (t) => {
  const target = await plain(t)
  target.state.setQuota({ mode: 'broken' })
  assert.deepEqual(await probe(target), {
    status: 'unknown',
    windows: null,
    plan: null,
    creditsBalance: null,
  })
  target.state.setQuota({ mode: 'envelope', code: 500 })
  await assert.rejects(probe(target))
  target.state.setQuota({ mode: 'envelope', code: 1309 })
  assert.equal((await probe(target)).status, 'suspended')
  target.state.setQuota({ mode: 'live' })
  assert.equal((await probe(target)).status, 'ok')
  // A refused key and a request without one: the recorded envelopes, with HTTP 200.
  const wrong = await send(target, ZAI_PATHS.quota, { method: 'GET', key: 'another-key' })
  assert.equal(wrong.status, 200)
  assert.deepEqual(JSON.parse(wrong.text), fixture('10-err-invalid-key.json').response.body)
  assert.equal((await probe(target, 'another-key')).status, 'auth')
  const none = await send(target, ZAI_PATHS.quota, { method: 'GET', key: null })
  assert.deepEqual(JSON.parse(none.text), fixture('10b-err-no-key.json').response.body)
  // The bare key is accepted on this path, as the probe saw.
  const bare = await send(target, ZAI_PATHS.quota, {
    method: 'GET',
    key: null,
    headers: { authorization: SYNTHETIC_ZAI_KEY },
  })
  assert.equal(JSON.parse(bare.text).success, true)
  assert.equal(
    (await chat(target, chatBody(), { key: null, headers: { authorization: SYNTHETIC_ZAI_KEY } }))
      .status,
    401,
  )
  for (const options of [
    { mode: 'later' },
    { mode: 'envelope' },
    { code: 500 },
    { fiveHour: { extra: 1 } },
    { month: {} },
  ])
    assert.throws(() => target.state.setQuota(options))
})

test('a request record names the credential and the headers and holds neither', async (t) => {
  const target = await plain(t)
  const turnKey = `sk-rdt-${'a'.repeat(43)}`
  await chat(target, chatBody(), {
    headers: {
      'user-agent': userAgent,
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
    },
  })
  await chat(target, chatBody(), {
    key: turnKey,
    headers: { cookie: 'acw_tc=client', 'x-session-id': 'ses_1' },
  })
  await send(target, ZAI_PATHS.quota, { method: 'GET' })
  const [first, second, third] = target.state.requests
  assert.deepEqual(
    [first.credential, second.credential, third.credential],
    ['plan-key', 'other', 'plan-key'],
  )
  assert.deepEqual(first.headerNames, [
    'accept',
    'accept-encoding',
    'authorization',
    'connection',
    'content-length',
    'content-type',
    'host',
    'user-agent',
  ])
  assert.ok(second.headerNames.includes('cookie') && second.headerNames.includes('x-session-id'))
  assert.deepEqual(
    [first.userAgent, first.accept, first.acceptEncoding, first.contentType],
    [userAgent, 'text/event-stream', 'identity', 'application/json'],
  )
  assert.deepEqual(first.body, chatBody())
  assert.deepEqual(
    [first.status, first.completed, second.status, third.path],
    [200, true, 401, ZAI_PATHS.quota],
  )
  const written = JSON.stringify(target.state.snapshot())
  for (const secret of [SYNTHETIC_ZAI_KEY, turnKey, 'acw_tc=client'])
    assert.equal(written.includes(secret), false)
  assert.deepEqual(target.state.counters, { chat: 2, quota: 1, generated: 1 })
  target.state.reset()
  assert.deepEqual(target.state.requests, [])
  assert.deepEqual(target.state.counters, { chat: 0, quota: 0, generated: 0 })
})

test('scenario options are closed', () => {
  const state = createFakeZaiState()
  for (const options of [
    { scenario: 'later' },
    { extra: 1 },
    { scenario: 'error' },
    { scenario: 'text', code: 1305 },
    { scenario: 'text', status: 500 },
    { scenario: 'error', code: 1305, status: 200 },
    { scenario: 'text', calls: [{ name: 'bash', arguments: {} }] },
    { scenario: 'tools', calls: [] },
    { scenario: 'tools', calls: [{ name: 'two words', arguments: {} }] },
    { failures: 0 },
    { delayMs: -1 },
    { retryAfter: 'line\nbreak' },
    { text: 7 },
    'text',
    [],
  ])
    assert.throws(() => state.setScenario(options), JSON.stringify(options))
  assert.throws(() => state.configure({ later: 1 }))
  assert.equal(
    state.configure({ reset: true, scenario: { scenario: 'empty' } }).config.scenario,
    'empty',
  )
})

test('the stand fake answers Z.ai next to Codex and Kimi and resets it with the rest', async (t) => {
  const fake = await startFakeSubscriptions({ ...tls })
  t.after(() => fake.close())
  const target = { port: fake.address.port, ca }
  const answer = await chat(target)
  assert.equal(answer.status, 200)
  assert.equal(frames(answer.text).at(-1), '[DONE]')
  assert.equal((await probe(target)).status, 'ok')
  // Its requests are not among the records that keep whole headers.
  assert.equal(fake.state.requests.length, 0)
  assert.equal(fake.state.zai.requests.length, 2)
  // Kimi's path is answered as before.
  const kimi = await send(target, '/coding/v1/usages', { method: 'GET', key: SYNTHETIC_KIMI_KEY })
  assert.equal(kimi.status, 200)
  assert.ok(JSON.parse(kimi.text).usages)
  // The control port: read, set, and the common reset.
  const control = { port: fake.controlAddress.port }
  const state = JSON.parse((await send(control, '/state', { method: 'GET', key: null })).text)
  assert.equal(state.zai.counters.chat, 1)
  assert.equal(JSON.stringify(state.zai).includes(SYNTHETIC_ZAI_KEY), false)
  const set = await send(control, '/zai', {
    key: null,
    body: { scenario: { scenario: 'error', code: 1308 }, quota: { fiveHour: { exhausted: true } } },
  })
  assert.equal(JSON.parse(set.text).config.code, 1308)
  assert.equal((await chat(target)).status, 429)
  assert.equal(
    (await send(control, '/zai', { key: null, body: { scenario: { scenario: 'later' } } })).status,
    400,
  )
  assert.equal(
    JSON.parse((await send(control, '/zai', { method: 'GET', key: null })).text).counters.chat,
    2,
  )
  await send(control, '/reset', { key: null, body: {} })
  assert.deepEqual(fake.state.zai.counters, { chat: 0, quota: 0, generated: 0 })
  assert.equal(fake.state.zai.config.scenario, 'text')
  assert.equal((await chat(target)).status, 200)
})

test('the fake runs alone as a process and stops on a signal', async (t) => {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fake-zai.mjs', import.meta.url)),
      '--tls-key',
      keyFile,
      '--tls-cert',
      certFile,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  t.after(() => child.kill('SIGKILL'))
  const ready = await new Promise((resolve, reject) => {
    let text = ''
    child.stdout.on('data', (chunk) => {
      text += chunk
      if (text.includes('\n')) resolve(JSON.parse(text))
    })
    child.once('exit', () => reject(new Error('The fake exited before it was ready')))
  })
  assert.equal(ready.ready, true)
  const target = { port: ready.port, ca }
  assert.equal((await chat(target)).status, 200)
  // An unknown path of the provider: the recorded HTTP 200 envelope.
  const unknown = await send(target, '/api/v1/does-not-exist', { method: 'GET' })
  assert.deepEqual(
    [unknown.status, JSON.parse(unknown.text)],
    [200, fixture('14-err-unknown-path.json').response.body],
  )
  const control = { port: ready.controlPort }
  assert.equal(
    (await send(control, '/', { key: null, body: { scenario: { scenario: 'empty' } } })).status,
    200,
  )
  assert.equal((await chat(target)).text, '')
  assert.equal(
    JSON.parse((await send(control, '/', { method: 'GET', key: null })).text).counters.chat,
    2,
  )
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  child.kill('SIGTERM')
  assert.equal(await exited, 0)
  // Without TLS files it does not start.
  await assert.rejects(startFakeZai())
})

test('the stand names api.z.ai in the certificate, the aliases and the proxy list', async () => {
  const directory = mkdtempSync(join(temp, 'stand-'))
  const { fake } = await createVerificationCertificates(root, directory)
  const certificate = new X509Certificate(readFileSync(join(fake, 'server.pem')))
  assert.ok(certificate.subjectAltName.split(', ').includes('DNS:api.z.ai'))
  for (const name of ['chatgpt.com', 'auth.openai.com', 'api.kimi.ai', 'localhost'])
    assert.ok(certificate.subjectAltName.includes(`DNS:${name}`), name)
  const here = fileURLToPath(new URL('./', import.meta.url))
  assert.match(readFileSync(join(here, 'egress.mjs'), 'utf8'), /'api\.z\.ai:443'/)
  assert.match(
    readFileSync(join(here, 'compose.yml'), 'utf8'),
    /aliases: \[chatgpt\.com, auth\.openai\.com, api\.kimi\.ai, api\.z\.ai\]/,
  )
  // The host is the adapter's origin.
  assert.equal(new URL(zaiCodingPlan.origin).host, 'api.z.ai')
})

const walk = (directory) =>
  readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })

test('every fixture of the adapter is a sanitised copy of a record of the research directory', () => {
  const copied = walk(fixtures).filter((file) => /\.(json|txt)$/.test(file))
  assert.equal(copied.length, 24)
  let headers = 0
  for (const file of copied) {
    const name = relative(fixtures, file)
    const text = readFileSync(file, 'utf8')
    // The sanitiser would change nothing: no header outside its list, no key, no raw identifier.
    assert.deepEqual(checkSanitized(text, { json: file.endsWith('.json') }), [], name)
    const source = name.startsWith('opencode-1.18.34/')
      ? join(research, 'opencode-cli/strings', name.slice('opencode-1.18.34/'.length))
      : join(research, 'samples', name)
    const original = readFileSync(source, 'utf8')
    // Formatted by prettier after the copy: the same JSON, the same text.
    if (file.endsWith('.json')) assert.deepEqual(JSON.parse(text), JSON.parse(original), name)
    else assert.equal(text, original, name)
    if (!file.endsWith('.json')) continue
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit)
      if (value === null || typeof value !== 'object') return
      for (const [key, item] of Object.entries(value)) {
        if (key === 'headers') {
          headers += 1
          for (const header of Object.keys(item))
            assert.ok(['content-type', 'retry-after'].includes(header), `${name}: ${header}`)
        } else visit(item)
      }
    }
    visit(JSON.parse(text))
  }
  assert.ok(headers >= 40, 'the fixtures keep their header objects')
  // Only the support modules were written by hand.
  assert.deepEqual(
    walk(fixtures)
      .filter((file) => !/\.(json|txt)$/.test(file))
      .map((file) => relative(fixtures, file)),
    ['opencode-cli.ts', 'samples.ts'],
  )
})
