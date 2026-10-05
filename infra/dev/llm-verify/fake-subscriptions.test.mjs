import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { codexBackend, kimiCodeBackend } from '../../../packages/llm-backends/src/index.ts'
import {
  createFakeSubscriptionState,
  startFakeSubscriptions,
  SYNTHETIC_KIMI_KEY,
  SYNTHETIC_ERROR_MARKER,
  SYNTHETIC_MCP_MARKER,
} from './fake-subscriptions.mjs'

const temp = mkdtempSync(join(tmpdir(), 'raditi-fake-subscriptions-'))
after(() => rmSync(temp, { recursive: true, force: true }))
const makeCa = fileURLToPath(new URL('../../egress/make-ca.sh', import.meta.url))
execFileSync('sh', [makeCa, 'ca', temp], { stdio: 'pipe' })
execFileSync('sh', [makeCa, 'server', temp, 'fake.raditi.internal'], { stdio: 'pipe' })
const key = readFileSync(join(temp, 'server/fake.raditi.internal-key.pem'))
const cert = readFileSync(join(temp, 'server/fake.raditi.internal.pem'))
const ca = readFileSync(join(temp, 'root.pem'))
const identity = {
  installationId: 'synthetic-installation',
  deviceId: 'synthetic-device',
  deviceName: 'raditi-test',
}
const kimiCredential = { v: '1', kind: 'kimi_api_key', apiKey: SYNTHETIC_KIMI_KEY }

async function start(t, options = {}) {
  const fake = await startFakeSubscriptions({ key, cert, ...options })
  t.after(() => fake.close())
  fake.state.issueTokens()
  return fake
}
function call(
  fake,
  path,
  { method = 'POST', body, headers = {}, token = fake.state.tokens?.access_token } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: fake.address.port,
        servername: 'fake.raditi.internal',
        ca,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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
            headers: new Headers(res.headers),
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}
const decode = (response) => JSON.parse(response.body.toString())
const events = (response) =>
  response.body
    .toString()
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))
function transport(fake) {
  return {
    request: async (input) => {
      const response = await call(fake, new URL(input.url).pathname, {
        method: input.method,
        headers: Object.fromEntries(input.headers),
        body: input.body === undefined ? undefined : Buffer.from(input.body).toString(),
      })
      return response
    },
  }
}
const codexBody = { model: 'gpt-6-sol', stream: true, store: false, input: [] }
const kimiBody = { model: 'k3-256k', stream: true, messages: [] }

test('device start, poll and one-use exchange produce an adapter-valid credential', async (t) => {
  const fake = await start(t)
  const backend = codexBackend
  const first = backend.login.start(identity)
  const startResponse = await call(fake, new URL(first.url).pathname, {
    body: Buffer.from(first.body).toString(),
  })
  const login = backend.login.parseStart(startResponse, new Date())
  const poll = backend.login.poll(login)
  const pollResponse = await call(fake, new URL(poll.url).pathname, {
    body: Buffer.from(poll.body).toString(),
  })
  const exchange = backend.login.parsePoll(pollResponse, login, new Date())
  assert.equal(exchange.kind, 'next')
  const exchanged = await call(fake, new URL(exchange.request.url).pathname, {
    headers: Object.fromEntries(exchange.request.headers),
    body: Buffer.from(exchange.request.body).toString(),
  })
  const complete = backend.login.parsePoll(exchanged, exchange.state, new Date())
  assert.equal(complete.kind, 'complete')
  assert.equal(
    backend.credentialMetadata(complete.credential).externalAccountId,
    fake.state.accountId,
  )
  const replay = await call(fake, new URL(exchange.request.url).pathname, {
    headers: Object.fromEntries(exchange.request.headers),
    body: Buffer.from(exchange.request.body).toString(),
  })
  assert.equal(replay.status, 400)
  assert.equal(fake.state.counters.exchange, 1)
})

test('refresh rotates once and reusing the old token invalidates the whole chain', async (t) => {
  const fake = await start(t)
  const original = fake.state.currentCredential
  const updated = await codexBackend.refresh(original, transport(fake))
  assert.equal(updated.kind, 'ok')
  assert.notEqual(updated.credential.refreshToken, original.refreshToken)
  assert.equal(
    (await codexBackend.probe(updated.credential, identity, transport(fake))).status,
    'ok',
  )
  assert.deepEqual(await codexBackend.refresh(original, transport(fake)), {
    kind: 'final',
    reason: 'auth',
  })
  assert.equal(
    (await codexBackend.probe(updated.credential, identity, transport(fake))).status,
    'auth',
  )
  assert.equal(fake.state.counters.refresh, 2)
})

test('provider revoke invalidates issued access credentials', async (t) => {
  const fake = await start(t)
  await codexBackend.revoke(fake.state.currentCredential, transport(fake))
  assert.equal(fake.state.counters.revoke, 1)
  assert.equal(
    (await codexBackend.probe(fake.state.currentCredential, identity, transport(fake))).status,
    'auth',
  )
})

test('Codex and Kimi probes return valid windows and fake never accepts unknown tokens', async (t) => {
  const fake = await start(t)
  for (const [backend, credential] of [
    [codexBackend, fake.state.currentCredential],
    [kimiCodeBackend, kimiCredential],
  ]) {
    const probe = await backend.probe(credential, identity, transport(fake))
    assert.equal(probe.status, 'ok')
    assert.equal(probe.windows.length, 2)
    assert.equal(probe.windows[0].usedPct, 10)
  }
  assert.equal(
    (await call(fake, '/backend-api/codex/responses', { body: codexBody, token: 'not-issued' }))
      .status,
    401,
  )
  assert.equal(
    (await call(fake, '/coding/v1/chat/completions', { body: kimiBody, token: 'not-issued' }))
      .status,
    401,
  )
})

test('Codex SSE is accepted by production inspector/meter and records request fields in memory', async (t) => {
  const fake = await start(t)
  const response = await call(fake, '/backend-api/codex/responses', {
    body: { ...codexBody, input: [{ role: 'user', content: 'synthetic-prompt-marker' }] },
    headers: { 'chatgpt-account-id': fake.state.accountId },
  })
  const meter = codexBackend.usageMeter()
  meter.push(response.body)
  const measured = meter.end()
  assert.equal(measured.outcome, 'completed')
  assert.equal(measured.usage.input, 100)
  assert.equal(measured.usage.output, 12)
  const completed = events(response).find((event) => event.type === 'response.completed')
  assert.equal(completed.response.output[0].content[0].text, 'Synthetic B13 complete.')
  assert.equal(fake.state.requests[0].body.store, false)
  assert.equal(fake.state.requests[0].headers['chatgpt-account-id'], fake.state.accountId)
})

test('Codex tool scenario advertises two shell calls then a final message', async (t) => {
  const fake = await start(t, { scenario: 'tools' })
  const tools = [
    {
      type: 'function',
      name: 'exec_command',
      parameters: { properties: { cmd: { type: 'string' } } },
    },
  ]
  const results = []
  for (let i = 0; i < 3; i++)
    results.push(
      events(
        await call(fake, '/backend-api/codex/responses', { body: { ...codexBody, tools } }),
      ).at(-1).response.output[0],
    )
  assert.equal(results[0].name, 'exec_command')
  assert.match(JSON.parse(results[0].arguments).cmd, /b13-first\.txt/)
  assert.match(JSON.parse(results[1].arguments).cmd, /b13-second\.txt/)
  assert.equal(results[2].type, 'message')
  assert.equal(fake.state.counters.codex, 3)
})

test('Codex plan, schema and resume scenarios emit their required payloads', async (t) => {
  const fake = await start(t, { scenario: 'plan-then-text' })
  const tools = [{ type: 'function', name: 'update_plan' }]
  const plan = events(
    await call(fake, '/backend-api/codex/responses', { body: { ...codexBody, tools } }),
  ).at(-1).response.output[0]
  assert.equal(plan.name, 'update_plan')
  assert.equal(JSON.parse(plan.arguments).plan[0].status, 'in_progress')
  assert.equal(
    events(await call(fake, '/backend-api/codex/responses', { body: codexBody })).at(-1).response
      .output[0].type,
    'message',
  )
  fake.state.setScenario('schema')
  const schema = {
    type: 'object',
    properties: { status: { enum: ['done'] }, count: { type: 'integer', minimum: 2 } },
    required: ['status', 'count'],
    additionalProperties: false,
  }
  const output = events(
    await call(fake, '/backend-api/codex/responses', {
      body: { ...codexBody, text: { format: { type: 'json_schema', schema } } },
    }),
  ).at(-1).response.output[0].content[0].text
  assert.deepEqual(JSON.parse(output), { status: 'done', count: 2 })
  fake.state.setScenario({ scenario: 'resume', text: 'Synthetic resumed.' })
  assert.match(
    (await call(fake, '/backend-api/codex/responses', { body: codexBody })).body.toString(),
    /Synthetic resumed/,
  )
})

test('Codex Responses Lite discovers declarations inside input.additional_tools', async (t) => {
  const fake = await start(t, { scenario: 'tools' })
  const response = await call(fake, '/backend-api/codex/responses', {
    body: {
      ...codexBody,
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'function',
              name: 'shell',
              parameters: { properties: { command: { type: 'array', items: { type: 'string' } } } },
            },
          ],
        },
      ],
    },
  })
  const item = events(response).at(-1).response.output[0]
  assert.equal(item.name, 'shell')
  assert.deepEqual(JSON.parse(item.arguments).command.slice(0, 2), ['sh', '-c'])
})

test('Codex code mode receives a namespaced custom exec call with streamed JavaScript input', async (t) => {
  const fake = await start(t, { scenario: 'tools' })
  const response = await call(fake, '/backend-api/codex/responses', {
    body: {
      ...codexBody,
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'functions',
              tools: [
                {
                  type: 'custom',
                  name: 'exec',
                  description: 'Call tools.exec_command(...) for shell commands.',
                },
              ],
            },
          ],
        },
      ],
    },
  })
  const parsed = events(response)
  const item = parsed.at(-1).response.output[0]
  assert.equal(item.type, 'custom_tool_call')
  assert.equal(item.namespace, 'functions')
  assert.equal(item.name, 'exec')
  assert.match(item.input, /tools\.exec_command/)
  assert.equal(item.arguments, undefined)
  assert.equal(
    parsed.find((event) => event.type === 'response.custom_tool_call_input.delta').delta,
    item.input,
  )
})

test('Kimi tool rounds preserve advertised name/arguments with usage only in last JSON chunk', async (t) => {
  const fake = await start(t, { scenario: 'tools' })
  const tools = [
    {
      type: 'function',
      function: {
        name: 'Bash',
        parameters: {
          properties: { command: { type: 'string' }, description: { type: 'string' } },
        },
      },
    },
  ]
  for (let i = 0; i < 3; i++) {
    const response = await call(fake, '/coding/v1/chat/completions', {
      token: SYNTHETIC_KIMI_KEY,
      body: { ...kimiBody, tools },
    })
    const parsed = events(response)
    assert.equal(parsed.at(-1).usage.completion_tokens, 12)
    assert.ok(parsed.slice(0, -1).every((event) => event.usage === undefined))
    if (i < 2) {
      assert.equal(parsed[1].choices[0].delta.tool_calls[0].function.name, 'Bash')
      assert.match(
        JSON.parse(parsed[2].choices[0].delta.tool_calls[0].function.arguments).command,
        /b13-/,
      )
      assert.equal(parsed.at(-2).choices[0].finish_reason, 'tool_calls')
    } else assert.equal(parsed.at(-2).choices[0].finish_reason, 'stop')
    const meter = kimiCodeBackend.usageMeter()
    meter.push(response.body)
    assert.equal(meter.end().usage.output, 12)
  }
})

test('mcp scenario calls the advertised MCP tool, then answers with the turn result', async (t) => {
  const fake = await start(t, { scenario: 'mcp', output: { ok: true }, text: '{"ok":true}' })
  // Codex: an MCP tool inside a namespace, as Responses Lite may group it.
  const codexTools = [
    { type: 'function', name: 'exec_command', parameters: { properties: { cmd: {} } } },
    {
      type: 'namespace',
      name: 'mcp__raditi__',
      tools: [{ type: 'function', name: 'site_info', parameters: { type: 'object' } }],
    },
  ]
  const call1 = events(
    await call(fake, '/backend-api/codex/responses', { body: { ...codexBody, tools: codexTools } }),
  ).at(-1).response.output[0]
  assert.deepEqual(
    { type: call1.type, name: call1.name, namespace: call1.namespace, arguments: call1.arguments },
    { type: 'function_call', name: 'site_info', namespace: 'mcp__raditi__', arguments: '{}' },
  )
  const final = events(
    await call(fake, '/backend-api/codex/responses', {
      body: { ...codexBody, text: { format: { type: 'json_schema', schema: { type: 'object' } } } },
    }),
  ).at(-1).response.output[0]
  assert.deepEqual(JSON.parse(final.content[0].text), { ok: true })
  // Kimi: the CLI's own MCP tool name.
  const kimiTools = [
    { type: 'function', function: { name: 'Bash', parameters: {} } },
    { type: 'function', function: { name: 'mcp__raditi__site_info', parameters: {} } },
  ]
  const kimi = events(
    await call(fake, '/coding/v1/chat/completions', {
      token: SYNTHETIC_KIMI_KEY,
      body: { ...kimiBody, tools: kimiTools },
    }),
  )
  assert.equal(kimi[1].choices[0].delta.tool_calls[0].function.name, 'mcp__raditi__site_info')
  assert.equal(kimi[2].choices[0].delta.tool_calls[0].function.arguments, '{}')
  // Codex code mode: no MCP declaration, the call is an exec cell over the nested tools.
  fake.state.setScenario({ scenario: 'mcp', backend: 'codex' })
  const exec = {
    type: 'namespace',
    name: 'functions',
    tools: [
      { type: 'custom', name: 'exec', description: 'Call tools.exec_command(...) and others.' },
    ],
  }
  const cell = events(
    await call(fake, '/backend-api/codex/responses', {
      body: {
        ...codexBody,
        input: [{ type: 'additional_tools', role: 'developer', tools: [exec] }],
      },
    }),
  ).at(-1).response.output[0]
  assert.equal(cell.type, 'custom_tool_call')
  assert.equal(cell.namespace, 'functions')
  assert.match(cell.input, /await tools\.mcp__raditi__site_info\(\{\}\)/)
  // Without an advertised MCP tool the scenario fails instead of inventing one.
  fake.state.setScenario({ scenario: 'mcp', backend: 'codex' })
  const missing = await call(fake, '/backend-api/codex/responses', {
    body: { ...codexBody, tools: [codexTools[0]] },
  })
  assert.equal(missing.status, 400)
})

const contentEdit = {
  scenario: 'content_edit',
  route: '/wp/v2/pages/7',
  idempotencyKey: 'synthetic-edit-1',
  body: { content: '<p>Changed. Write to {{contact}}</p>' },
  output: { ok: true },
  text: '{"ok":true}',
}
const privacyMarker = '[[raditi:email:0190a5c0-1111-7222-8333-444455556666]]'
const kimiContentTools = [
  { type: 'function', function: { name: 'Bash', parameters: {} } },
  { type: 'function', function: { name: 'mcp__raditi__site_info', parameters: {} } },
  { type: 'function', function: { name: 'mcp__raditi__wp_rest', parameters: {} } },
]
const codexExec = {
  type: 'additional_tools',
  role: 'developer',
  tools: [
    {
      type: 'namespace',
      name: 'functions',
      tools: [
        { type: 'custom', name: 'exec', description: 'Call tools.exec_command(...) and others.' },
      ],
    },
  ],
}

test('content_edit reads the page, writes with a key, repeats the same write and answers', async (t) => {
  const fake = await start(t, contentEdit)
  // Kimi: the read's output is a tool message; its privacy marker goes into the write.
  const read = { role: 'tool', content: JSON.stringify({ content: `<p>Old ${privacyMarker}</p>` }) }
  const kimi = async (messages) => {
    const parsed = events(
      await call(fake, '/coding/v1/chat/completions', {
        token: SYNTHETIC_KIMI_KEY,
        body: { ...kimiBody, messages, tools: kimiContentTools },
      }),
    )
    return {
      name: parsed[1].choices[0].delta.tool_calls?.[0].function.name,
      arguments: parsed[2].choices[0].delta.tool_calls?.[0].function.arguments,
      finish: parsed.at(-2).choices[0].finish_reason,
      text: parsed[1].choices[0].delta.content,
    }
  }
  const first = await kimi([])
  assert.equal(first.name, 'mcp__raditi__wp_rest')
  assert.deepEqual(JSON.parse(first.arguments), { method: 'GET', route: contentEdit.route })
  const write = await kimi([read])
  assert.equal(write.name, 'mcp__raditi__wp_rest')
  assert.deepEqual(JSON.parse(write.arguments), {
    method: 'POST',
    route: contentEdit.route,
    body: { content: `<p>Changed. Write to ${privacyMarker}</p>` },
    idempotencyKey: contentEdit.idempotencyKey,
  })
  const repeated = await kimi([read, { role: 'tool', content: '{"updated":true}' }])
  assert.equal(repeated.arguments, write.arguments)
  assert.equal(repeated.finish, 'tool_calls')
  const final = await kimi([read])
  assert.deepEqual([final.finish, final.text], ['stop', contentEdit.text])

  // Codex code mode: the same three calls as exec cells over the nested MCP tool.
  const codex = async (input) =>
    events(
      await call(fake, '/backend-api/codex/responses', {
        body: {
          ...codexBody,
          input: [codexExec, ...input],
          text: { format: { type: 'json_schema', schema: { type: 'object' } } },
        },
      }),
    ).at(-1).response.output[0]
  const output = {
    type: 'custom_tool_call_output',
    // Nested JSON strings, as a cell's text(JSON.stringify(...)) arrives.
    output: JSON.stringify({ content: [{ type: 'text', text: read.content }] }),
  }
  const cell = await codex([])
  assert.equal(cell.type, 'custom_tool_call')
  assert.equal(
    cell.input,
    `text(JSON.stringify(await tools.mcp__raditi__wp_rest(${JSON.stringify({ method: 'GET', route: contentEdit.route })})))`,
  )
  const written = await codex([output])
  assert.ok(written.input.includes(`"idempotencyKey":"${contentEdit.idempotencyKey}"`))
  assert.ok(written.input.includes(`Write to ${privacyMarker}</p>`))
  assert.equal((await codex([output])).input, written.input)
  assert.deepEqual(JSON.parse((await codex([output])).content[0].text), { ok: true })
})

test('content_edit never invents a contact: a template without a marker to copy fails', async (t) => {
  const fake = await start(t, contentEdit)
  const request = (messages) =>
    call(fake, '/coding/v1/chat/completions', {
      token: SYNTHETIC_KIMI_KEY,
      body: { ...kimiBody, messages, tools: kimiContentTools },
    })
  assert.equal((await request([])).status, 200)
  const refused = await request([{ role: 'tool', content: '{"content":"<p>No contact</p>"}' }])
  assert.equal(refused.status, 400)
  // Without the placeholder the body goes as it is.
  fake.state.setScenario({ ...contentEdit, body: { title: 'Plain' }, backend: 'kimi' })
  await request([])
  const plain = events(await request([]))
  assert.deepEqual(JSON.parse(plain[2].choices[0].delta.tool_calls[0].function.arguments).body, {
    title: 'Plain',
  })
})

test('content_forbidden calls wp_rest on the given route once, then answers', async (t) => {
  const fake = await start(t, {
    scenario: 'content_forbidden',
    route: '/wp/v2/comments/1',
    text: '{"ok":true}',
  })
  const request = async () =>
    events(
      await call(fake, '/coding/v1/chat/completions', {
        token: SYNTHETIC_KIMI_KEY,
        body: { ...kimiBody, tools: kimiContentTools },
      }),
    )
  const first = await request()
  assert.equal(first[1].choices[0].delta.tool_calls[0].function.name, 'mcp__raditi__wp_rest')
  assert.deepEqual(JSON.parse(first[2].choices[0].delta.tool_calls[0].function.arguments), {
    method: 'GET',
    route: '/wp/v2/comments/1',
  })
  const second = await request()
  assert.equal(second.at(-2).choices[0].finish_reason, 'stop')
  assert.equal(second[1].choices[0].delta.content, '{"ok":true}')
  const cell = events(
    await call(fake, '/backend-api/codex/responses', {
      body: { ...codexBody, input: [codexExec] },
    }),
  ).at(-1).response.output[0]
  assert.match(
    cell.input,
    /tools\.mcp__raditi__wp_rest\(\{"method":"GET","route":"\/wp\/v2\/comments\/1"\}\)/,
  )
  // With a body the refused call is a write without an idempotency key: a CLI that checks the
  // arguments against the tool's flat input schema still sends it, and the role must refuse.
  fake.state.setScenario({
    scenario: 'content_forbidden',
    route: '/wp/v2/pages/7',
    body: { title: 'Keyless' },
  })
  const keyless = await request()
  assert.deepEqual(JSON.parse(keyless[2].choices[0].delta.tool_calls[0].function.arguments), {
    method: 'POST',
    route: '/wp/v2/pages/7',
    body: { title: 'Keyless' },
  })
  assert.equal((await request()).at(-2).choices[0].finish_reason, 'stop')
  // Without the tool in the CLI's list the scenario fails instead of inventing it.
  fake.state.setScenario({ scenario: 'content_forbidden', route: '/wp/v2/comments/1' })
  const missing = await call(fake, '/coding/v1/chat/completions', {
    token: SYNTHETIC_KIMI_KEY,
    body: { ...kimiBody, tools: kimiContentTools.slice(0, 2) },
  })
  assert.equal(missing.status, 400)
})

test('content scenario options are bounded and belong to the content scenarios only', () => {
  for (const invalid of [
    { scenario: 'content_edit' },
    { ...contentEdit, route: 'wp/v2/pages/7' },
    { ...contentEdit, route: '/wp/v2/pages/7?context=edit' },
    { ...contentEdit, idempotencyKey: '' },
    { ...contentEdit, idempotencyKey: 'has space' },
    { ...contentEdit, body: {} },
    { ...contentEdit, body: { content: 7 } },
    { ...contentEdit, body: { status: 'draft' } },
    { ...contentEdit, body: { content: 'x'.repeat(32 * 1024 + 1) } },
    { scenario: 'content_forbidden' },
    { scenario: 'content_forbidden', route: '/wp/v2/comments/1', body: { status: 'draft' } },
    { scenario: 'content_forbidden', route: '/wp/v2/comments/1', idempotencyKey: 'k' },
    { scenario: 'text', route: '/wp/v2/pages/7' },
    { scenario: 'mcp', body: { title: 'x' } },
  ])
    assert.throws(() => createFakeSubscriptionState(invalid), /Invalid content/)
  assert.equal(createFakeSubscriptionState(contentEdit).config.codex.route, contentEdit.route)
})

test('the synthetic MCP server answers only the registered turn token and lists given tools', async (t) => {
  const fake = await start(t, { mcpPort: 0 })
  const token = `mcp_${'a'.repeat(64)}`
  const tools = [
    {
      name: 'site_info',
      description: 'Read the site.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
  const control = (path, body) =>
    fetch(`${fake.controlAddress.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const rpc = (body, auth = token, method = 'POST') =>
    fetch(`${fake.mcpAddress.url}/mcp`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
  // Nothing registered yet: every request is refused.
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401)
  for (const invalid of [{ token: 'mcp_short', tools }, { token, tools: 'none' }, {}])
    assert.equal((await control('/mcp', invalid)).status, 400)
  const registered = await control('/mcp', { token, tools })
  assert.equal(registered.status, 200)
  assert.equal(JSON.stringify(await registered.json()).includes(token), false)
  assert.equal(
    (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, `mcp_${'b'.repeat(64)}`)).status,
    401,
  )
  const init = await (
    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    })
  ).json()
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.deepEqual(
    (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result,
    { tools },
  )
  const called = await (
    await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'site_info', arguments: {} },
    })
  ).json()
  assert.equal(called.result.isError, false)
  assert.match(called.result.content[0].text, new RegExp(SYNTHETIC_MCP_MARKER))
  const unknown = await (
    await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'other', arguments: {} },
    })
  ).json()
  assert.equal(unknown.error.code, -32602)
  assert.equal((await rpc(undefined, token, 'GET')).status, 405)
  assert.equal((await rpc(undefined, token, 'DELETE')).status, 204)
  const state = await (await fetch(`${fake.controlAddress.url}/state`)).json()
  assert.deepEqual(
    state.mcp.requests.map(({ method, rpc: name, tool, authorized }) => [
      method,
      name,
      tool,
      authorized,
    ]),
    [
      ['POST', null, null, false],
      ['POST', null, null, false],
      ['POST', 'initialize', null, true],
      ['POST', 'notifications/initialized', null, true],
      ['POST', 'tools/list', null, true],
      ['POST', 'tools/call', 'site_info', true],
      ['POST', 'tools/call', 'other', true],
      ['GET', null, null, true],
      ['DELETE', null, null, true],
    ],
  )
  assert.equal(JSON.stringify(state).includes(token), false)
})

test('503 retries once; 401 requires a real token refresh before another generation', async (t) => {
  const fake = await start(t)
  for (const [scenario, status] of [
    ['transient503', 503],
    ['auth_once', 401],
  ]) {
    fake.state.setScenario(scenario)
    assert.equal(
      (await call(fake, '/backend-api/codex/responses', { body: codexBody })).status,
      status,
    )
    if (scenario === 'auth_once') {
      assert.equal(
        (await call(fake, '/backend-api/codex/responses', { body: codexBody })).status,
        401,
      )
      assert.equal(
        (await codexBackend.refresh(fake.state.currentCredential, transport(fake))).kind,
        'ok',
      )
    }
    assert.equal(
      (await call(fake, '/backend-api/codex/responses', { body: codexBody })).status,
      200,
    )
  }
  assert.equal(fake.state.generation, 2)
})

test('failure scenarios map to production classifiers rather than substring guesses', async (t) => {
  const fake = await start(t)
  for (const [scenario, backend, expected] of [
    ['final_quota', 'codex', 'window_exhausted'],
    ['window429', 'codex', 'window_exhausted'],
    ['content_risk', 'codex', 'policy_flagged'],
    ['content_risk', 'kimi', 'policy_flagged'],
    ['final_quota', 'kimi', 'window_exhausted'],
    ['profile401', 'kimi', 'profile'],
    ['concurrent403', 'kimi', 'account_risk'],
    ['payment402', 'kimi', 'transient'],
  ]) {
    fake.state.setScenario(scenario)
    const response = await call(
      fake,
      backend === 'codex' ? '/backend-api/codex/responses' : '/coding/v1/chat/completions',
      {
        body: backend === 'codex' ? codexBody : kimiBody,
        token: backend === 'codex' ? fake.state.tokens.access_token : SYNTHETIC_KIMI_KEY,
      },
    )
    assert.equal(
      (backend === 'codex' ? codexBackend : kimiCodeBackend).classify(
        response.status,
        response.headers,
        decode(response),
      ).kind,
      expected,
      `${scenario}:${backend}`,
    )
    assert.equal(decode(response).error.synthetic_canary, SYNTHETIC_ERROR_MARKER)
  }
})

test('in-stream Codex failures answer 200 and reach the CLI only as codes it does not retry', async (t) => {
  const fake = await start(t)
  // Codes the pinned Codex CLI 0.158.0 ends a turn on after `response.failed` (measured).
  const terminal = ['invalid_prompt', 'insufficient_quota', 'context_length_exceeded']
  for (const [failure, expected] of [
    ['cyber_policy', 'policy_flagged'],
    ['usage_limit_reached', 'window_exhausted'],
    ['insufficient_quota', 'account_risk'],
    // Final for the turn, and no verdict on the account, its limits or the egress.
    ['context_length_exceeded', 'request_rejected'],
  ]) {
    fake.state.setScenario({ scenario: 'stream_failed', backend: 'codex', failure })
    const response = await call(fake, '/backend-api/codex/responses', { body: codexBody })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/event-stream/)
    const sent = events(response)
    assert.deepEqual(
      sent.map((event) => event.type),
      ['response.created', 'response.failed'],
    )
    assert.equal(sent[1].response.error.synthetic_canary, SYNTHETIC_ERROR_MARKER)
    const inspected = codexBackend
      .streamInspector()
      .inspect({ event: 'response.failed', data: JSON.stringify(sent[1]) })
    assert.equal(inspected.kind, 'failure')
    assert.equal(inspected.signal.kind, expected, failure)
    assert.ok(terminal.includes(JSON.parse(inspected.event.data).response.error.code), failure)
    assert.equal(inspected.event.data.includes(SYNTHETIC_ERROR_MARKER), false)
    assert.equal(inspected.event.data.includes('Synthetic stream failure'), false)
  }
  fake.state.setScenario({
    scenario: 'stream_failed',
    backend: 'codex',
    failure: 'rate_limit_exceeded',
    failures: 1,
  })
  const first = events(await call(fake, '/backend-api/codex/responses', { body: codexBody }))
  const retryable = codexBackend
    .streamInspector()
    .inspect({ event: 'response.failed', data: JSON.stringify(first.at(-1)) })
  assert.equal(retryable.signal.kind, 'transient')
  assert.equal(JSON.parse(retryable.event.data).response.error.code, 'raditi_transient')
  const second = events(await call(fake, '/backend-api/codex/responses', { body: codexBody }))
  assert.equal(second.at(-1).type, 'response.completed')
  for (const options of [
    { scenario: 'stream_failed', backend: 'codex' },
    { scenario: 'stream_failed', backend: 'codex', failure: 'Not A Code' },
    { scenario: 'stream_failed', backend: 'kimi', failure: 'cyber_policy' },
    { scenario: 'stream_failed', backend: 'all', failure: 'high_risk' },
    { scenario: 'stream_failed', failure: 'cyber_policy' },
    { scenario: 'stream_failed', backend: 'codex', failure: 'cyber_policy', failures: 0 },
    { scenario: 'text', failure: 'cyber_policy' },
  ])
    assert.throws(() => fake.state.setScenario(options), /Invalid (failure|backend)/)
})

test('in-stream Kimi failures answer 200 and reach the CLI as a filtered choice unless short-lived', async (t) => {
  const fake = await start(t)
  const path = '/coding/v1/chat/completions'
  const filtered = { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }
  for (const [failure, expected, sent] of [
    ['high_risk', 'policy_flagged', filtered],
    ['model_access', 'profile', filtered],
    ['quota_5h', 'window_exhausted', filtered],
    ['overloaded', 'transient', { error: { code: 'raditi_transient' } }],
  ]) {
    fake.state.setScenario({ scenario: 'stream_failed', backend: 'kimi', failure })
    const response = await call(fake, path, { body: kimiBody, token: SYNTHETIC_KIMI_KEY })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/event-stream/)
    const received = events(response)
    assert.equal(received.length, 2, failure)
    assert.equal(received[0].choices[0].delta.role, 'assistant')
    assert.equal(received[1].error.synthetic_canary, SYNTHETIC_ERROR_MARKER)
    assert.equal(response.body.toString().includes('[DONE]'), false)
    const inspected = kimiCodeBackend
      .streamInspector()
      .inspect({ event: 'message', data: JSON.stringify(received[1]) })
    assert.equal(inspected.kind, 'failure')
    assert.equal(inspected.signal.kind, expected, failure)
    assert.partialDeepStrictEqual(JSON.parse(inspected.event.data), sent)
    assert.equal(inspected.event.data.includes(SYNTHETIC_ERROR_MARKER), false)
  }
  fake.state.setScenario({
    scenario: 'stream_failed',
    backend: 'kimi',
    failure: 'overloaded',
    failures: 1,
  })
  const first = events(await call(fake, path, { body: kimiBody, token: SYNTHETIC_KIMI_KEY }))
  assert.ok(first.at(-1).error)
  const second = await call(fake, path, { body: kimiBody, token: SYNTHETIC_KIMI_KEY })
  assert.ok(second.body.toString().includes('data: [DONE]'))
  assert.throws(
    () => fake.state.setScenario({ scenario: 'stream_failed', backend: 'kimi', failure: 'x' }),
    /Invalid failure/,
  )
})

test('missing-usage scenarios complete with no fabricated usage', async (t) => {
  const fake = await start(t, { scenario: 'no_usage' })
  for (const [backend, path, body, token] of [
    [codexBackend, '/backend-api/codex/responses', codexBody, fake.state.tokens.access_token],
    [kimiCodeBackend, '/coding/v1/chat/completions', kimiBody, SYNTHETIC_KIMI_KEY],
  ]) {
    const meter = backend.usageMeter()
    meter.push((await call(fake, path, { body, token })).body)
    const value = meter.end()
    assert.equal(value.outcome, 'completed')
    assert.equal(value.usage, null)
  }
})

test('configured provider usage exercises accounting above request reservations', async (t) => {
  const fake = await start(t, { usage: { output: 6000 } })
  for (const [backend, path, body, token] of [
    [codexBackend, '/backend-api/codex/responses', codexBody, fake.state.tokens.access_token],
    [kimiCodeBackend, '/coding/v1/chat/completions', kimiBody, SYNTHETIC_KIMI_KEY],
  ]) {
    const meter = backend.usageMeter()
    meter.push((await call(fake, path, { body, token })).body)
    const measured = meter.end()
    assert.equal(measured.usage.output, 6000)
    assert.equal(measured.usage.input, 100)
  }
  assert.throws(() => fake.state.setScenario({ usage: { output: -1 } }), /Invalid usage/)
  assert.throws(() => fake.state.setScenario({ usage: { input: 1 } }), /Invalid usage/)
  assert.throws(() => fake.state.setScenario({ usage: { reasoning: 100 } }), /Invalid usage/)
})

test('interrupted streams close before terminal; delayed streams keep usage after delay', async (t) => {
  const fake = await start(t, { scenario: 'interrupted', delayMs: 25 })
  await assert.rejects(
    call(fake, '/backend-api/codex/responses', { body: codexBody }),
    /aborted|reset/i,
  )
  await delay(5)
  assert.equal(fake.state.requests[0].aborted, true)
  fake.state.setScenario({ scenario: 'delayed', delayMs: 30 })
  const started = Date.now()
  const response = await call(fake, '/backend-api/codex/responses', { body: codexBody })
  assert.ok(Date.now() - started >= 25)
  assert.equal(events(response).at(-1).type, 'response.completed')
})

test('control API is separate from provider and reset discards captured requests/tokens', async (t) => {
  const fake = await start(t)
  const original = fake.state.tokens.access_token
  assert.equal((await call(fake, '/state', { method: 'GET' })).status, 404)
  let result = await fetch(`${fake.controlAddress.url}/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: 'credits' }),
  })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).tokens.access_token, original)
  result = await fetch(`${fake.controlAddress.url}/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const reset = await result.json()
  assert.equal(reset.tokens, null)
  assert.equal(reset.requests.length, 0)
  assert.equal(
    (await call(fake, '/backend-api/codex/responses', { body: codexBody, token: original })).status,
    401,
  )
  assert.equal(
    (await fetch(`${fake.controlAddress.url}/scenario`, { method: 'POST', body: '{' })).status,
    400,
  )
})

test('invalid configuration and unadvertised tool scenarios fail safely', async (t) => {
  assert.throws(() => createFakeSubscriptionState({ scenario: 'unknown' }), /Invalid scenario/)
  assert.throws(() => createFakeSubscriptionState({ delayMs: -1 }), /Invalid delay/)
  const fake = await start(t, { scenario: 'tools' })
  const response = await call(fake, '/backend-api/codex/responses', { body: codexBody })
  assert.equal(response.status, 400)
  assert.equal(decode(response).error.code, 'synthetic_invalid_request')
})

test(
  'standalone prints only readiness and shutdown cancels a two-minute stream delay',
  { timeout: 3000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./fake-subscriptions.mjs', import.meta.url)),
        '--tls-key',
        join(temp, 'server/fake.raditi.internal-key.pem'),
        '--tls-cert',
        join(temp, 'server/fake.raditi.internal.pem'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    t.after(() => child.kill('SIGKILL'))
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    for (let i = 0; i < 100 && !output.includes('\n'); i++) await delay(10)
    const ready = JSON.parse(output.trim())
    assert.deepEqual(Object.keys(ready).sort(), ['controlPort', 'port', 'ready'])
    const control = `http://127.0.0.1:${ready.controlPort}`
    const minted = await (await fetch(`${control}/tokens`, { method: 'POST' })).json()
    await fetch(`${control}/scenario`, {
      method: 'POST',
      body: JSON.stringify({ scenario: 'delayed', delayMs: 120_000 }),
    })
    const pending = call(
      { address: { port: ready.port }, state: { tokens: minted.tokens } },
      '/backend-api/codex/responses',
      { body: codexBody },
    ).catch((error) => error)
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(`${control}/state`)).json()).requests.length) break
      await delay(5)
    }
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.ok((await pending) instanceof Error)
    assert.deepEqual(JSON.parse(output.trim()), ready)
    assert.equal(errors, '')
  },
)
