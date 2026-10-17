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
  zaiApiBackend,
  zaiApiOffer,
  zaiCodingBackend,
  zaiCodingPlan,
} from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import { createVerificationCertificates } from './certificates.mjs'
import { startFakeSubscriptions } from './fake-subscriptions.mjs'
import {
  createFakeZaiState,
  handleZai,
  isZaiRequest,
  startFakeZai,
  SYNTHETIC_ZAI_API_KEY,
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_MARKER,
  SYNTHETIC_ZAI_ROTATED_API_KEY,
  SYNTHETIC_ZAI_ROTATED_KEY,
  ZAI_ERROR_STATUS,
  ZAI_PATHS,
} from './fake-zai.mjs'
import { streamSummary } from './live.mjs'
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

/** The CLI declares its tools in every request a model may answer with a call. */
const withTools = (patch = {}) =>
  chatBody({
    tool_choice: 'auto',
    tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
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
/** The fake as the TLS server it is alone: there a scenario that cannot be answered is HTTP 400. */
async function served(t, initial) {
  const fake = await startFakeZai({ ...tls, ...initial })
  t.after(() => fake.close())
  return { state: fake.state, port: fake.address.port, ca }
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
function inspect(text, backend = zaiCodingBackend) {
  const inspector = backend.streamInspector()
  const meter = backend.usageMeter()
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
/** The adapter's own probe against the fake's quota path; the plan's unless another is named. */
const probe = (target, key = SYNTHETIC_ZAI_KEY, backend = zaiCodingBackend) =>
  backend.probe(
    { ...credential, apiKey: key },
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

test('the fake serves the addresses the adapters declare and nothing else', () => {
  assert.deepEqual(zaiCodingBackend.egress[0].requests, [
    `POST https://api.z.ai${ZAI_PATHS.chat}`,
    `GET https://api.z.ai${ZAI_PATHS.quota}`,
  ])
  // The API asks the monitor path of the plan as its probe of the key.
  assert.deepEqual(zaiApiBackend.egress[0].requests, [
    `POST https://api.z.ai${ZAI_PATHS.apiChat}`,
    `GET https://api.z.ai${ZAI_PATHS.quota}`,
  ])
  assert.equal(zaiApiOffer.origin, zaiCodingPlan.origin)
  for (const path of Object.values(ZAI_PATHS))
    assert.equal(isZaiRequest({ url: `${path}?x=1` }), true)
  for (const url of [
    '/api/paas/v4/models',
    '/api/paas/v4/chat/completions/',
    '/coding/v1/chat/completions',
    '/',
  ])
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
    const answer = await chat(target, withTools())
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
  const calls = chunks((await chat(target, withTools())).text).flatMap(
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
    withTools({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', tool_call_id: calls[0].id, content: 'ok' },
      ],
    }),
  )
  assert.equal(chunks(answered.text).at(-1).choices[0].finish_reason, 'stop')
})

test('tool rounds follow the history of the request, and a request without tools gets text', async (t) => {
  const target = await plain(t)
  const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }]
  const round = (name) => [{ name, arguments: { command: `echo ${name}` } }]
  target.state.setScenario({
    scenario: 'tools',
    rounds: [round('first'), [...round('second'), ...round('third')]],
    text: 'Synthetic result.',
  })
  const called = async (messages, patch = {}) => {
    const answer = await chat(target, chatBody({ messages, tools, tool_choice: 'auto', ...patch }))
    assert.equal(answer.status, 200)
    const sent = chunks(answer.text)
    return {
      names: sent.flatMap((chunk) =>
        (chunk.choices[0].delta.tool_calls ?? []).map((call) => call.function.name),
      ),
      text: sent.map((chunk) => chunk.choices[0].delta.content ?? '').join(''),
      finish: sent.at(-1).choices[0].finish_reason,
    }
  }
  const user = { role: 'user', content: 'Synthetic request.' }
  const step = (id) => [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: {} }] },
    { role: 'tool', tool_call_id: id, content: 'done' },
  ]
  // The number of tool steps since the last message of the user picks the round.
  assert.deepEqual(await called([user]), { names: ['first'], text: '', finish: 'tool_calls' })
  assert.deepEqual(await called([user, ...step('a')]), {
    names: ['second', 'third'],
    text: '',
    finish: 'tool_calls',
  })
  assert.deepEqual(await called([user, ...step('a'), ...step('b')]), {
    names: [],
    text: 'Synthetic result.',
    finish: 'stop',
  })
  // A new message of the user starts over: the steps of an earlier turn are history.
  assert.deepEqual((await called([user, ...step('a'), ...step('b'), user])).names, ['first'])
  // A request that declares no tool (the CLI's context compaction) is answered with text.
  assert.deepEqual(await called([user], { tools: undefined, tool_choice: undefined }), {
    names: [],
    text: 'Synthetic result.',
    finish: 'stop',
  })
  // One list of calls is one round, as before.
  target.state.setScenario({ scenario: 'tools', calls: round('only') })
  assert.deepEqual((await called([user])).names, ['only'])
  assert.deepEqual((await called([user, ...step('a')])).names, [])
})

// The form the real model showed and no scripted answer had (docs/plan/45-zai-live.md): the
// stand's observer recorded it in front of the role, so its events carry the role's `event:` line.
const besideRun = fixture('81-g6-live-content/02-llm-post_chat_completions.json')
const observedChunks = (text) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => block.slice('event: message\ndata: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data))
/** What an answer is made of, in its order: runs of chunks of one kind, then how it finished. */
const kindsOf = (parsed) => {
  const kinds = []
  for (const chunk of parsed) {
    const { delta, finish_reason: finish } = chunk.choices[0]
    const kind = finish
      ? `finish ${finish}`
      : delta.tool_calls
        ? 'tool_calls'
        : (delta.content ?? '') !== ''
          ? 'content'
          : (delta.reasoning_content ?? '') !== ''
            ? 'reasoning'
            : 'empty'
    if (kinds.at(-1) !== kind) kinds.push(kind)
  }
  return kinds
}

test('a tool answer can say a sentence beside its call, in the order the real model gave', async (t) => {
  const target = await plain(t)
  const sentence = 'The page was read. Now one write follows.'
  const call = { name: 'raditi_wp_rest', arguments: { method: 'GET', path: '/wp/v2/pages/7' } }
  target.state.setScenario({
    scenario: 'tools',
    calls: [call],
    beside: sentence,
    text: 'Synthetic result.',
  })
  const answer = await chat(target, withTools())
  assert.equal(answer.status, 200)
  const sent = chunks(answer.text)
  // The record and the fake: reasoning, the sentence, the call, the finish with the usage.
  const order = ['reasoning', 'content', 'tool_calls', 'finish tool_calls']
  assert.deepEqual(kindsOf(observedChunks(besideRun.response.sse)), order)
  assert.deepEqual(kindsOf(sent), order)
  const recorded = new Set(observedChunks(besideRun.response.sse).map(shapeOf))
  for (const chunk of sent)
    assert.ok(recorded.has(shapeOf(chunk)), `a recorded shape: ${shapeOf(chunk)}`)
  assert.equal(sent.map((chunk) => chunk.choices[0].delta.content ?? '').join(''), sentence)
  assert.deepEqual(
    sent
      .flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
      .map((item) => [item.function.name, JSON.parse(item.function.arguments)]),
    [[call.name, call.arguments]],
  )
  // The stand's own reading names the form in the record and in the fake's answer alike.
  assert.deepEqual(streamSummary(besideRun.response.sse).forms, ['text_beside_tool_call'])
  assert.deepEqual(streamSummary(answer.text).forms, ['text_beside_tool_call'])
  // The production inspector forwards every frame and the meter reads the fake's numbers.
  const { seen, meter, failure } = inspect(answer.text)
  assert.equal(failure, undefined)
  assert.equal(seen.length, frames(answer.text).length)
  assert.equal(meter.outcome, 'completed')
  assert.deepEqual(meter.usage, {
    input: 7105,
    cacheRead: 6784,
    cacheWrite: 0,
    output: 94,
    reasoning: 54,
  })
  // Past the round the answer is the text alone, and so is one to a request without tools.
  for (const body of [
    withTools({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: sentence, tool_calls: [] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    }),
    chatBody(),
  ]) {
    const later = chunks((await chat(target, body)).text)
    assert.deepEqual(kindsOf(later), ['reasoning', 'content', 'finish stop'])
    assert.equal(
      later.map((chunk) => chunk.choices[0].delta.content ?? '').join(''),
      'Synthetic result.',
    )
  }
  // Every round of a list says it; an answer without the option says nothing beside its call.
  target.state.setScenario({ scenario: 'tools', rounds: [[call], [call]], beside: sentence })
  for (const history of [[], [{ role: 'assistant', content: '', tool_calls: [] }]])
    assert.deepEqual(
      kindsOf(
        chunks(
          (
            await chat(
              target,
              withTools({ messages: [{ role: 'user', content: 'x' }, ...history] }),
            )
          ).text,
        ),
      ),
      order,
    )
  target.state.setScenario({ scenario: 'tools', calls: [call] })
  assert.deepEqual(kindsOf(chunks((await chat(target, withTools())).text)), [
    'reasoning',
    'tool_calls',
    'finish tool_calls',
  ])
})

test('a tool answer can think a given number of bytes first, and only an answer that calls does', async (t) => {
  const target = await plain(t)
  const call = { name: 'bash', arguments: { command: 'echo synthetic' } }
  const bytes = 3 * 64 * 1024 + 5
  target.state.setScenario({ scenario: 'tools', calls: [call], filler: bytes, reasoning: 'Why.' })
  const thought = (text) =>
    chunks(text)
      .map((chunk) => chunk.choices[0].delta.reasoning_content ?? '')
      .join('')
  const answer = await chat(target, withTools())
  // The reasoning of the scenario, the filler in chunks, then the call and the end.
  assert.equal(thought(answer.text) === `Why.${'x'.repeat(bytes)}`, true)
  assert.deepEqual(
    [...new Set(kindsOf(chunks(answer.text)))],
    ['reasoning', 'tool_calls', 'finish tool_calls'],
  )
  assert.ok(Buffer.byteLength(answer.text) > bytes)
  assert.equal(streamSummary(answer.text).usage !== null, true)
  // Past the round, and for a request without tools, nothing is added.
  const later = await chat(
    target,
    withTools({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    }),
  )
  assert.equal(thought(later.text), 'Why.')
  assert.equal(thought((await chat(target, chatBody())).text), 'Why.')
})

// What the pinned CLI sent with the platform MCP server in its configuration, and what the real
// model answered: the record of that run. Its request declares the tools, its history holds one
// tool step, its answer calls the MCP tool by the name the CLI gave it.
const mcpRun = fixture('34-run-c-mcp/12-llm-post_chat_completions.json')
const recordedCall = chunks(mcpRun.response.sse)
  .flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
  .at(0)
const contentEdit = {
  scenario: 'content_edit',
  route: '/wp/v2/pages/7',
  idempotencyKey: 'synthetic-edit-1',
  body: { content: '<p>Changed. Write to {{contact}}</p>' },
  text: '{"ok":true}',
}
const privacyMarker = '[[raditi:email:0190a5c0-1111-7222-8333-444455556666]]'
/** A request of the recorded run with the given tool steps after the message of the user. */
function contentRequest(outputs, patch = {}) {
  const { tools, messages } = mcpRun.request.body
  const [system, user, called, result] = messages
  assert.deepEqual(
    [system.role, user.role, called.role, result.role],
    ['system', 'user', 'assistant', 'tool'],
  )
  return chatBody({
    messages: [system, user, ...outputs.flatMap((content) => [called, { ...result, content }])],
    tools,
    tool_choice: 'auto',
    ...patch,
  })
}
/** The one answer of the fake to a content request: its call, its text and how it finished. */
async function contentAnswer(target, outputs, patch) {
  const answer = await chat(target, contentRequest(outputs, patch))
  if (answer.status !== 200) return { status: answer.status }
  const sent = chunks(answer.text)
  for (const chunk of sent)
    assert.ok(recordedShapes.has(shapeOf(chunk)), `a recorded shape: ${shapeOf(chunk)}`)
  assert.equal(inspect(answer.text).failure, undefined)
  const calls = sent.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
  return {
    status: 200,
    calls,
    arguments: calls.map((call) => JSON.parse(call.function.arguments)),
    text: sent.map((chunk) => chunk.choices[0].delta.content ?? '').join(''),
    finish: sent.at(-1).choices[0].finish_reason,
  }
}

test('content_edit calls the tool the CLI declared for wp_rest: read, write with a key, the same write, the answer', async (t) => {
  const target = await plain(t)
  target.state.setScenario(contentEdit)
  // The record: the CLI names an MCP tool <server>_<tool>, and the model called it by that name.
  assert.deepEqual(
    mcpRun.request.body.tools
      .map((tool) => tool.function.name)
      .filter((name) => name.startsWith('raditi_')),
    ['raditi_site_info', 'raditi_wp_rest'],
  )
  assert.equal(recordedCall.function.name, 'raditi_wp_rest')
  const read = await contentAnswer(target, [])
  assert.equal(read.calls.length, 1)
  assert.equal(read.calls[0].function.name, recordedCall.function.name)
  assert.deepEqual(Object.keys(read.calls[0]), Object.keys(recordedCall))
  assert.deepEqual(read.arguments, [{ method: 'GET', route: contentEdit.route }])
  assert.equal(read.finish, 'tool_calls')
  // The output of the read is a tool message; its privacy marker goes into the write.
  const page = JSON.stringify({ content: `<p>Old ${privacyMarker}</p>` })
  const write = await contentAnswer(target, [page])
  assert.equal(write.calls[0].function.name, 'raditi_wp_rest')
  assert.deepEqual(write.arguments, [
    {
      method: 'POST',
      route: contentEdit.route,
      body: { content: `<p>Changed. Write to ${privacyMarker}</p>` },
      idempotencyKey: contentEdit.idempotencyKey,
    },
  ])
  // The very same write again, then the answer of the turn.
  const repeated = await contentAnswer(target, [page, '{"updated":true}'])
  assert.deepEqual(repeated.arguments, write.arguments)
  assert.equal(repeated.finish, 'tool_calls')
  assert.deepEqual(await contentAnswer(target, [page, '{"updated":true}', '{"updated":true}']), {
    status: 200,
    calls: [],
    arguments: [],
    text: contentEdit.text,
    finish: 'stop',
  })
  // A request that declares no tool (the CLI's context compaction) is answered with the text.
  const compaction = await contentAnswer(target, [], { tools: undefined, tool_choice: undefined })
  assert.deepEqual([compaction.calls, compaction.text], [[], contentEdit.text])
})

test('content_edit never invents a contact, and no content scenario invents a tool', async (t) => {
  const target = await served(t)
  target.state.setScenario(contentEdit)
  // A template with the placeholder and a conversation without a marker to copy.
  assert.equal((await contentAnswer(target, ['{"content":"<p>No contact</p>"}'])).status, 400)
  // Without the placeholder the body goes as it is.
  target.state.setScenario({ ...contentEdit, body: { title: 'Plain' } })
  assert.deepEqual((await contentAnswer(target, ['{}'])).arguments[0].body, { title: 'Plain' })
  // The MCP tool is not among the declared ones: the CLI lost its connection to the platform.
  const builtin = mcpRun.request.body.tools.filter((tool) => !/wp_rest$/.test(tool.function.name))
  assert.equal((await contentAnswer(target, [], { tools: builtin })).status, 400)
  target.state.setScenario({ scenario: 'content_forbidden', route: '/wp/v2/comments/1' })
  assert.equal((await contentAnswer(target, [], { tools: builtin })).status, 400)
  // Two servers that both declare a wp_rest: the scenario does not choose between them.
  const twice = [
    ...mcpRun.request.body.tools,
    { type: 'function', function: { name: 'other_wp_rest', parameters: { type: 'object' } } },
  ]
  assert.equal((await contentAnswer(target, [], { tools: twice })).status, 400)
})

test('content_forbidden calls wp_rest once, on the given route or as a write without a key, then answers', async (t) => {
  const target = await plain(t)
  target.state.setScenario({
    scenario: 'content_forbidden',
    route: '/wp/v2/comments/1',
    text: '{"ok":true}',
  })
  const first = await contentAnswer(target, [])
  assert.equal(first.calls[0].function.name, 'raditi_wp_rest')
  assert.deepEqual(first.arguments, [{ method: 'GET', route: '/wp/v2/comments/1' }])
  assert.equal(first.finish, 'tool_calls')
  // Whatever the CLI told the model about the refused call, the next answer is the result.
  const second = await contentAnswer(target, ['Synthetic tool error.'])
  assert.deepEqual([second.calls, second.text, second.finish], [[], '{"ok":true}', 'stop'])
  // With a body the refused call is a write without an idempotency key.
  target.state.setScenario({
    scenario: 'content_forbidden',
    route: '/wp/v2/pages/7',
    body: { title: 'Keyless' },
  })
  assert.deepEqual((await contentAnswer(target, [])).arguments, [
    { method: 'POST', route: '/wp/v2/pages/7', body: { title: 'Keyless' } },
  ])
  assert.equal((await contentAnswer(target, ['Synthetic tool error.'])).finish, 'stop')
})

test('content options are bounded and belong to the content scenarios only', () => {
  const state = createFakeZaiState()
  for (const options of [
    { scenario: 'content_edit' },
    { ...contentEdit, route: 'wp/v2/pages/7' },
    { ...contentEdit, route: '/wp/v2/pages/7?context=edit' },
    { ...contentEdit, idempotencyKey: '' },
    { ...contentEdit, idempotencyKey: 'has space' },
    { ...contentEdit, body: {} },
    { ...contentEdit, body: { content: 7 } },
    { ...contentEdit, body: { status: 'draft' } },
    { ...contentEdit, body: { content: 'x'.repeat(32 * 1024 + 1) } },
    { ...contentEdit, calls: [{ name: 'bash', arguments: {} }] },
    { scenario: 'content_forbidden' },
    { scenario: 'content_forbidden', route: '/wp/v2/comments/1', body: { status: 'draft' } },
    { scenario: 'content_forbidden', route: '/wp/v2/comments/1', idempotencyKey: 'k' },
    { scenario: 'text', route: '/wp/v2/pages/7' },
    { scenario: 'tools', body: { title: 'x' } },
  ])
    assert.throws(() => state.setScenario(options), JSON.stringify(options))
  assert.equal(state.setScenario(contentEdit).config.route, contentEdit.route)
})

test('the plan key can be replaced: the old one is then refused on both paths', async (t) => {
  const target = await plain(t)
  assert.notEqual(SYNTHETIC_ZAI_ROTATED_KEY, SYNTHETIC_ZAI_KEY)
  const quota = (key) => send(target, ZAI_PATHS.quota, { method: 'GET', key })
  assert.equal((await chat(target)).status, 200)
  assert.equal(JSON.parse((await quota(SYNTHETIC_ZAI_KEY)).text).success, true)
  // Before the change the new key is nobody's.
  assert.equal((await chat(target, chatBody(), { key: SYNTHETIC_ZAI_ROTATED_KEY })).status, 401)
  assert.equal(target.state.configure({ key: 'rotated' }).key, 'rotated')
  const refused = await chat(target)
  assert.equal(refused.status, 401)
  assert.deepEqual(
    zaiCodingBackend.classify(refused.status, new Headers(), JSON.parse(refused.text)),
    { kind: 'auth' },
  )
  // The monitor path says the same inside HTTP 200, as the records show.
  assert.deepEqual(JSON.parse((await quota(SYNTHETIC_ZAI_KEY)).text), {
    code: 401,
    msg: 'token expired or incorrect',
    success: false,
  })
  assert.equal((await chat(target, chatBody(), { key: SYNTHETIC_ZAI_ROTATED_KEY })).status, 200)
  assert.equal(JSON.parse((await quota(SYNTHETIC_ZAI_ROTATED_KEY)).text).success, true)
  // The record still says only whether the current plan key came, never a value.
  assert.deepEqual(
    target.state.requests.map((request) => request.credential),
    ['plan-key', 'plan-key', 'other', 'other', 'other', 'plan-key', 'plan-key'],
  )
  assert.equal(JSON.stringify(target.state.snapshot()).includes(SYNTHETIC_ZAI_ROTATED_KEY), false)
  // A reset puts the first key back.
  assert.equal(target.state.reset().key, 'first')
  assert.equal((await chat(target)).status, 200)
  assert.throws(() => target.state.configure({ key: 'another' }))
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
  // The numbers a limited scenario names are its own: the plain answers after it keep its
  // text and count as usual. A step that fills the context is then followed by ordinary ones.
  target.state.setScenario({
    scenario: 'tools',
    calls: [{ name: 'bash', arguments: { command: 'echo one' } }],
    text: 'Synthetic result.',
    usage: { prompt: 990_000 },
    failures: 1,
  })
  const answers = [await chat(target, withTools()), await chat(target), await chat(target)]
  assert.deepEqual(
    answers.map((answer) => chunks(answer.text).at(-1).usage.prompt_tokens),
    [990_000, 7105, 7105],
  )
  assert.deepEqual(
    answers.map((answer) => chunks(answer.text).at(-1).choices[0].finish_reason),
    ['tool_calls', 'stop', 'stop'],
  )
  assert.ok(answers[2].text.includes('result.'))
})

test('a held answer has started: its first frame leaves at once, the rest after the delay', async (t) => {
  const target = await plain(t)
  const whole = await chat(target)
  target.state.setScenario({ scenario: 'text', delayMs: 400 })
  // The moments the first bytes and the end of the answer reach the client.
  const held = await new Promise((resolve, reject) => {
    const started = Date.now()
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: ZAI_PATHS.chat,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_ZAI_KEY}`,
        },
      },
      (res) => {
        const parts = []
        let firstMs
        res.on('data', (chunk) => {
          firstMs ??= Date.now() - started
          parts.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            first: parts[0].toString('utf8'),
            firstMs,
            endMs: Date.now() - started,
            text: Buffer.concat(parts).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(chatBody()))
  })
  // A stream that has begun: one whole frame of the answer, well before the delay is over …
  assert.equal(frames(held.first).length, 1)
  assert.ok(chunks(held.first)[0].choices[0].delta.reasoning_content)
  assert.ok(held.firstMs < 300, `the first frame came after ${held.firstMs} ms`)
  // … and then the same answer as without a delay, no frame twice and none lost.
  assert.ok(held.endMs >= 400, `the answer ended after ${held.endMs} ms`)
  assert.deepEqual(chunks(held.text).map(shapeOf), chunks(whole.text).map(shapeOf))
  assert.equal(frames(held.text).at(-1), '[DONE]')
  assert.equal(inspect(held.text).meter.outcome, 'completed')
  // The protocol-breaking streams keep their shape when held: nothing but DONE, an error
  // object after the first frame.
  target.state.setScenario({ scenario: 'done_only', delayMs: 50 })
  assert.deepEqual(frames((await chat(target)).text), ['[DONE]'])
  target.state.setScenario({ scenario: 'stream_error', code: 1301, delayMs: 50 })
  const failed = frames((await chat(target)).text)
  assert.equal(failed.length, 2)
  assert.equal(JSON.parse(failed[1]).error.code, '1301')
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

const apiChat = (target, body = chatBody(), options = {}) =>
  send(target, ZAI_PATHS.apiChat, { body, key: SYNTHETIC_ZAI_API_KEY, ...options })

test('the API path answers its funded key with a stream and the usage of the plan path, and moves no window', async (t) => {
  // The API account has money from the start: only the scenarios of 1113 empty it.
  assert.equal(createFakeZaiState().balance, 'funded')
  const target = await plain(t)
  assert.equal(target.state.balance, 'funded')
  const windows = JSON.stringify(target.state.quota)
  target.state.setScenario({
    scenario: 'text',
    usage: { prompt: 5084, cached: 4928, completion: 436, reasoning: 266 },
  })
  const answer = await apiChat(target)
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'text/event-stream;charset=UTF-8')
  // The usage comes in the chunk that names the finish reason, as on the plan path.
  const last = chunks(answer.text).at(-1)
  assert.equal(last.choices[0].finish_reason, 'stop')
  assert.deepEqual(last.usage, {
    prompt_tokens: 5084,
    completion_tokens: 436,
    total_tokens: 5520,
    prompt_tokens_details: { cached_tokens: 4928 },
    completion_tokens_details: { reasoning_tokens: 266 },
  })
  const { meter, failure } = inspect(answer.text, zaiApiBackend)
  assert.equal(failure, undefined)
  assert.deepEqual(meter.usage, {
    input: 5084,
    cacheRead: 4928,
    cacheWrite: 0,
    output: 436,
    reasoning: 266,
  })
  assert.equal(streamSummary(answer.text).usage.reasoning, 266)
  // Tool rounds and every other scenario answer on the API path as on the plan path.
  target.state.setScenario({ scenario: 'tools', calls: [{ name: 'bash', arguments: {} }] })
  const called = await apiChat(target, withTools())
  assert.equal(chunks(called.text).at(-1).choices[0].finish_reason, 'tool_calls')
  // A generation of the API spends no credit of a plan window.
  assert.equal(JSON.stringify(target.state.quota), windows)
  assert.deepEqual(target.state.counters, { chat: 2, quota: 0, generated: 2 })
  assert.deepEqual(
    target.state.requests.map((request) => [request.path, request.credential, request.status]),
    [
      [ZAI_PATHS.apiChat, 'api-key', 200],
      [ZAI_PATHS.apiChat, 'api-key', 200],
    ],
  )
  // Not even a spent window of the plan stops the API.
  target.state.setQuota({ fiveHour: { exhausted: true } })
  target.state.setScenario({ scenario: 'text' })
  assert.equal((await apiChat(target)).status, 200)
  assert.equal((await chat(target)).status, 429)
})

test('an empty balance answers the API key with 1113 under HTTP 429, as sample 21 shows', async (t) => {
  const target = await plain(t)
  const recorded = fixture('21-paas-chat.json').response
  assert.equal(target.state.configure({ balance: 'empty' }).balance, 'empty')
  const refused = await apiChat(target)
  assert.equal(refused.status, recorded.status)
  assert.equal(refused.headers['content-type'], recorded.headers['content-type'])
  const body = JSON.parse(refused.text)
  assert.deepEqual(Object.keys(body.error), Object.keys(JSON.parse(recorded.body).error))
  assert.equal(body.error.code, JSON.parse(recorded.body).error.code)
  assert.ok(body.error.message.includes(SYNTHETIC_ZAI_MARKER))
  // The same answer is the API's empty balance and, to a plan key, a plan it lacks.
  assert.deepEqual(zaiApiBackend.classify(429, new Headers(refused.headers), body), {
    kind: 'balance_exhausted',
  })
  assert.deepEqual(zaiCodingBackend.classify(429, new Headers(refused.headers), body), {
    kind: 'account_risk',
    reason: 'zai_1113',
  })
  // The plan path does not look at the balance of the API account.
  assert.equal((await chat(target)).status, 200)
  // Before the body is read, as the recorded valid body was refused.
  assert.equal((await apiChat(target, { model: 'glm-0-does-not-exist' })).status, 429)
  assert.equal(target.state.counters.generated, 1)
  // A top-up: the next request is answered.
  target.state.configure({ balance: 'funded' })
  assert.equal((await apiChat(target)).status, 200)
  assert.equal(target.state.reset().balance, 'funded')
  assert.throws(() => target.state.configure({ balance: 'low' }))
})

test('a key of one offer on the path of the other gets 1113, a refused key 401, none 1001', async (t) => {
  const target = await plain(t)
  // Sample 21: the plan key on the API path.
  const planOnApi = await apiChat(target, chatBody(), { key: SYNTHETIC_ZAI_KEY })
  assert.deepEqual([planOnApi.status, JSON.parse(planOnApi.text).error.code], [429, '1113'])
  const apiOnPlan = await chat(target, chatBody(), { key: SYNTHETIC_ZAI_API_KEY })
  assert.deepEqual([apiOnPlan.status, JSON.parse(apiOnPlan.text).error.code], [429, '1113'])
  for (const [key, code] of [
    [SYNTHETIC_ZAI_ROTATED_API_KEY, '401'],
    ['another-key', '401'],
    [null, '1001'],
  ]) {
    const answer = await apiChat(target, chatBody(), { key })
    assert.equal(answer.status, 401)
    assert.equal(JSON.parse(answer.text).error.code, code)
    assert.deepEqual(
      zaiApiBackend.classify(401, new Headers(answer.headers), JSON.parse(answer.text)),
      { kind: 'auth' },
    )
  }
  // The operator's new key: the old one is refused from now on, the plan key is not touched.
  assert.equal(target.state.configure({ apiKey: 'rotated' }).apiKey, 'rotated')
  assert.equal((await apiChat(target)).status, 401)
  assert.equal(
    (await apiChat(target, chatBody(), { key: SYNTHETIC_ZAI_ROTATED_API_KEY })).status,
    200,
  )
  assert.equal((await chat(target)).status, 200)
  assert.deepEqual(
    target.state.requests.map((request) => request.credential),
    ['plan-key', 'api-key', 'other', 'other', 'none', 'other', 'api-key', 'plan-key'],
  )
  assert.equal(target.state.counters.generated, 2)
  const written = JSON.stringify(target.state.snapshot())
  for (const key of [SYNTHETIC_ZAI_API_KEY, SYNTHETIC_ZAI_ROTATED_API_KEY])
    assert.equal(written.includes(key), false)
  assert.equal(target.state.reset().apiKey, 'first')
  assert.throws(() => target.state.configure({ apiKey: 'another' }))
})

test('the API reads 1302 and 1305 as short-lived and a 429 without a code as a throttle', async (t) => {
  const target = await plain(t)
  for (const code of [1302, 1305]) {
    target.state.setScenario({ scenario: 'error', code, retryAfter: '2' })
    const answer = await apiChat(target)
    assert.equal(answer.status, 429)
    assert.deepEqual(
      zaiApiBackend.classify(429, new Headers(answer.headers), JSON.parse(answer.text)),
      { kind: 'transient', retryAfterMs: 2000 },
    )
  }
  // An error object that names no code: the API's own throttle; to the plan, an unconfirmed block.
  target.state.setScenario({ scenario: 'error', status: 429, retryAfter: '1', failures: 1 })
  const codeless = await apiChat(target)
  assert.equal(codeless.status, 429)
  const body = JSON.parse(codeless.text)
  assert.deepEqual(Object.keys(body.error), ['message'])
  assert.ok(body.error.message.includes(SYNTHETIC_ZAI_MARKER))
  assert.deepEqual(zaiApiBackend.classify(429, new Headers(codeless.headers), body), {
    kind: 'transient',
    retryAfterMs: 1000,
  })
  assert.deepEqual(zaiCodingBackend.classify(429, new Headers(codeless.headers), body), {
    kind: 'unconfirmed_block',
  })
  // Past its one failure the scenario answers.
  assert.equal((await apiChat(target)).status, 200)
  // A status is what such an error needs: without one it is no scenario.
  assert.throws(() => target.state.setScenario({ scenario: 'error' }))
  assert.throws(() => target.state.setScenario({ scenario: 'error', status: 200 }))
})

test('the monitor path answers the API key with an envelope that names no refused key: the API probe reads it as a key the provider takes', async (t) => {
  const target = await plain(t)
  const answer = await send(target, ZAI_PATHS.quota, { method: 'GET', key: SYNTHETIC_ZAI_API_KEY })
  assert.equal(answer.status, 200)
  const body = JSON.parse(answer.text)
  // The envelope of samples 10, 10b and 14 with the code of sample 21.
  assert.deepEqual(Object.keys(body), Object.keys(fixture('10-err-invalid-key.json').response.body))
  assert.deepEqual([body.code, body.success], [1113, false])
  assert.deepEqual(await probe(target, SYNTHETIC_ZAI_API_KEY, zaiApiBackend), {
    status: 'ok',
    windows: null,
    plan: null,
  })
  // An empty balance changes nothing there: the probe cannot see it.
  target.state.configure({ balance: 'empty' })
  assert.equal((await probe(target, SYNTHETIC_ZAI_API_KEY, zaiApiBackend)).status, 'ok')
  // A refused key and no key: the recorded auth envelopes.
  assert.equal((await probe(target, SYNTHETIC_ZAI_ROTATED_API_KEY, zaiApiBackend)).status, 'auth')
  assert.equal((await probe(target, 'another-key', zaiApiBackend)).status, 'auth')
  // The plan key passes the API's probe as well (one account may hold both): nothing tells the
  // import that a key was given to the wrong offer.
  assert.equal((await probe(target, SYNTHETIC_ZAI_KEY, zaiApiBackend)).status, 'ok')
  // The API probe spends nothing: no generation, no window moved.
  assert.deepEqual(target.state.counters, { chat: 0, quota: 6, generated: 0 })
  // The plan's probe does not take an API key for a plan.
  assert.equal((await probe(target, SYNTHETIC_ZAI_API_KEY)).status, 'suspended')
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
    { scenario: 'text', rounds: [[{ name: 'bash', arguments: {} }]] },
    { scenario: 'tools', rounds: [] },
    { scenario: 'tools', rounds: [[]] },
    { scenario: 'tools', rounds: [{ name: 'bash', arguments: {} }] },
    {
      scenario: 'tools',
      calls: [{ name: 'bash', arguments: {} }],
      rounds: [[{ name: 'bash', arguments: {} }]],
    },
    { scenario: 'text', beside: 'A sentence.' },
    { scenario: 'content_edit', beside: 'A sentence.' },
    { scenario: 'tools', beside: '' },
    { scenario: 'tools', beside: 7 },
    { scenario: 'tools', beside: 'x'.repeat(16_385) },
    { scenario: 'text', filler: 1024 },
    { scenario: 'tools', filler: 0 },
    { scenario: 'tools', filler: 1.5 },
    { scenario: 'tools', filler: '1024' },
    { scenario: 'tools', filler: 32 * 1024 * 1024 + 1 },
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

test('the stand process answers as the fake alone does and resets it with the rest', async (t) => {
  const fake = await startFakeSubscriptions({ ...tls })
  t.after(() => fake.close())
  const target = { port: fake.address.port, ca }
  const answer = await chat(target)
  assert.equal(answer.status, 200)
  assert.equal(frames(answer.text).at(-1), '[DONE]')
  assert.equal((await probe(target)).status, 'ok')
  assert.equal(fake.state.zai.requests.length, 2)
  // A path of another provider is an unknown path of this one: the recorded HTTP 200 envelope.
  const other = await send(target, '/coding/v1/usages', { method: 'GET' })
  assert.deepEqual(
    [other.status, JSON.parse(other.text)],
    [200, fixture('14-err-unknown-path.json').response.body],
  )
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
  // The content scenarios of the agent-content stand are set by the same message.
  const content = await send(control, '/zai', { key: null, body: { scenario: contentEdit } })
  assert.equal(JSON.parse(content.text).config.idempotencyKey, contentEdit.idempotencyKey)
  assert.equal(
    (await send(control, '/zai', { key: null, body: { scenario: { scenario: 'content_edit' } } }))
      .status,
    400,
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
  // The provider's name and the loopback name a role without a proxy reaches it by, and no other.
  assert.equal(certificate.subjectAltName, 'DNS:api.z.ai, DNS:localhost')
  const here = fileURLToPath(new URL('./', import.meta.url))
  assert.match(
    readFileSync(join(here, 'egress.mjs'), 'utf8'),
    /allow: new Set\(\['api\.z\.ai:443'\]\)/,
  )
  assert.match(readFileSync(join(here, 'compose.yml'), 'utf8'), /aliases: \[api\.z\.ai\]/)
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
  assert.equal(copied.length, 25)
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
