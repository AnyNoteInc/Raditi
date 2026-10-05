/* global fetch */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { startKimiRunnerFixture } from './kimi-runner-fixture.mjs'

const turn = (number) => ({
  turn: number,
  llmKey: `synthetic-llm-${number}`,
  mcpKey: `synthetic-mcp-${number}`,
  prompt: number === 1 ? '-' : 'ю'.repeat(100_000),
  effort: number === 1 ? 'low' : 'high',
})
const tools = [
  ...['Read', 'Write', 'Edit', 'Glob', 'Grep', 'AskUserQuestion'].map((name) => ({
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } },
  })),
  {
    type: 'function',
    function: {
      name: 'Bash',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: { name: 'mcp__raditi__site_info', parameters: { type: 'object', properties: {} } },
  },
]
const bodyFor = (number, history = []) => ({
  model: 'k3-256k',
  thinking: { effort: turn(number).effort },
  stream: true,
  tools,
  messages: [
    {
      role: 'system',
      content:
        'Synthetic runner verification\nRADITI_PLATFORM_TURN_1\n{"client_message":{"type":"string"}}',
    },
    ...history,
    {
      role: 'user',
      content:
        number === 1
          ? `Client request:\n${turn(number).prompt}`
          : `RADITI_PLATFORM_TURN_2\n\nClient request:\n${turn(number).prompt}`,
    },
  ],
})
async function open(t) {
  const fixture = await startKimiRunnerFixture()
  t.after(() => fixture.close())
  return fixture
}
async function send(fixture, path, key, body) {
  const response = await fetch(`${fixture.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}
async function llm(fixture, number, body) {
  const response = await send(fixture, '/kimi/v1/chat/completions', turn(number).llmKey, body)
  assert.equal(response.status, 200, response.text)
  const frames = response.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
  assert.equal(frames.pop(), '[DONE]')
  const chunks = frames.map((frame) => JSON.parse(frame))
  assert.equal(chunks.at(-1).usage.total_tokens, 120)
  let content = ''
  let call
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk')
    for (const choice of chunk.choices) {
      content += choice.delta.content ?? ''
      for (const part of choice.delta.tool_calls ?? []) {
        if (part.id)
          call = {
            id: part.id,
            type: part.type,
            function: { name: part.function.name, arguments: '' },
          }
        call.function.arguments += part.function.arguments ?? ''
      }
    }
  }
  return call ? { role: 'assistant', content, tool_calls: [call] } : { role: 'assistant', content }
}
async function mcp(fixture, number, method, params = {}) {
  const response = await send(fixture, '/mcp', turn(number).mcpKey, {
    jsonrpc: '2.0',
    id: 0,
    method,
    params,
  })
  assert.equal(response.status, 200, response.text)
  return JSON.parse(response.text).result
}
function runShell(message, files, overrides = {}) {
  const call = message.tool_calls[0]
  assert.equal(call.function.name, 'Bash')
  const command = JSON.parse(call.function.arguments).command
  assert.ok(command.startsWith("node -e '") && command.endsWith("'"))
  const source = command.slice(9, -1).replaceAll("'\\''", "'")
  const stdout = []
  runInNewContext(source, {
    require(name) {
      if (name === 'node:assert/strict') return assert
      if (name === 'node:child_process')
        return {
          execFileSync(binary, args) {
            assert.deepEqual(Array.from(args), binary === 'uname' ? ['-r'] : ['--version'])
            if (binary === 'uname') return overrides.kernel ?? '4.19.0-gvisor\n'
            assert.equal(binary, 'kimi')
            return overrides.version ?? '2.1.1\n'
          },
        }
      assert.equal(name, 'node:fs')
      return {
        existsSync: (path) => (overrides.secretFiles ?? []).includes(path),
        readdirSync(path) {
          assert.equal(path, '/proc')
          return ['1', '17', 'self', 'uptime']
        },
        readFileSync(path) {
          if (!path.startsWith('/proc/')) return files.get(path)
          assert.match(path, /^\/proc\/(1|17)\/environ$/)
          return overrides.environ ?? 'PATH=/usr/bin\0KIMI_MODEL_NAME=k3-256k\0'
        },
        appendFileSync: (path, content) => files.set(path, (files.get(path) ?? '') + content),
        writeFileSync: (path, content) => files.set(path, content),
      }
    },
    process: {
      getuid: () => overrides.uid ?? 10001,
      getgid: () => overrides.gid ?? 10001,
      env: overrides.env ?? {},
    },
    console: { log: (value) => stdout.push(value) },
  })
  return stdout.join('\n')
}
async function firstShell(fixture) {
  fixture.addTurn(turn(1))
  const body = bodyFor(1)
  const shell = await llm(fixture, 1, body)
  body.messages.push(shell, {
    role: 'tool',
    tool_call_id: shell.tool_calls[0].id,
    content: runShell(shell, new Map([['index.php', 'initial\n']])),
  })
  return body
}

test('two turns prove exact prompts, file restoration, rotated profiles, actual MCP calls and native history', async (t) => {
  const fixture = await open(t)
  const files = new Map([['index.php', '<?php echo "hello";\n']])
  let history = []
  for (const number of [1, 2]) {
    const expected = fixture.addTurn(turn(number))
    assert.deepEqual(expected, fixture.resultFor(number))
    assert.equal(
      (await mcp(fixture, number, 'initialize', { protocolVersion: '2025-03-26' })).serverInfo.name,
      'raditi-p5-runner-fixture',
    )
    assert.equal((await mcp(fixture, number, 'tools/list')).tools[0].name, 'site_info')
    const body = bodyFor(number, history)
    const shell = await llm(fixture, number, body)
    body.messages.push(shell, {
      role: 'tool',
      tool_call_id: shell.tool_calls[0].id,
      content: runShell(shell, files),
    })
    const call = await llm(fixture, number, body)
    assert.equal(call.tool_calls[0].function.name, 'mcp__raditi__site_info')
    const answer = await mcp(fixture, number, 'tools/call', { name: 'site_info', arguments: {} })
    body.messages.push(call, {
      role: 'tool',
      tool_call_id: call.tool_calls[0].id,
      content: JSON.stringify(answer),
    })
    const final = await llm(fixture, number, body)
    assert.deepEqual(JSON.parse(final.content), expected)
    history = [...body.messages.filter((message) => message.role !== 'system'), final]
  }
  fixture.assertComplete()
  assert.equal(files.get('index.php'), '<?php echo "hello";\nturn 1\nturn 2\n')
  assert.equal(files.get('turn-1.txt'), 'turn 1\n')
  assert.equal(files.get('turn-2.txt'), 'turn 2\n')
  assert.deepEqual(
    fixture
      .observations()
      .turns.map((row) => [row.llmRequests, row.mcpCalls, row.toolOutputSeen, row.mcpOutputSeen]),
    [
      [3, 1, true, true],
      [3, 1, true, true],
    ],
  )
  for (const number of [1, 2])
    for (const key of [turn(number).llmKey, turn(number).mcpKey])
      assert.ok(!JSON.stringify(fixture.observations()).includes(key))
  assert.ok(!JSON.stringify(fixture.observations()).includes(turn(2).prompt))
})

test('the framed dash and long resumed prompt must be intact', async (t) => {
  for (const number of [1, 2]) {
    const fixture = await open(t)
    fixture.addTurn(turn(number))
    const body = bodyFor(number, [{ role: 'assistant', content: fixture.resultFor(1).summary }])
    body.messages.at(-1).content =
      number === 1
        ? 'Client request:\n-unexpected'
        : `RADITI_PLATFORM_TURN_2\n\nClient request:\n${turn(2).prompt.slice(1)}`
    assert.equal(
      (await send(fixture, '/kimi/v1/chat/completions', turn(number).llmKey, body)).status,
      400,
    )
    assert.deepEqual(fixture.observations().problems, ['Turn prompt missing'])
  }
})

test('a new user message cannot impersonate the restored assistant history', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(2))
  const body = bodyFor(2, [{ role: 'user', content: fixture.resultFor(1).summary }])
  assert.equal((await send(fixture, '/kimi/v1/chat/completions', turn(2).llmKey, body)).status, 400)
  assert.deepEqual(fixture.observations().problems, ['Prior session marker missing'])
})

test('only a matching tool result proves shell success', async (t) => {
  for (const changed of [
    { role: 'assistant' },
    { tool_call_id: 'wrong-call' },
    { content: 'shell failed' },
  ]) {
    const fixture = await open(t)
    const body = await firstShell(fixture)
    Object.assign(body.messages.at(-1), changed)
    assert.equal(
      (await send(fixture, '/kimi/v1/chat/completions', turn(1).llmKey, body)).status,
      400,
    )
    assert.deepEqual(fixture.observations().problems, ['Successful shell output missing'])
  }
})

test('the shell proof rejects wrong isolation, CLI, inherited or readable credentials and credential files before writing', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  const shell = await llm(fixture, 1, bodyFor(1))
  for (const overrides of [
    { kernel: '6.8.0-linux' },
    { uid: 0 },
    { gid: 0 },
    { version: '2.1.0' },
    ...['KIMI_MODEL_API_KEY', 'RADITI_LLM_TOKEN', 'RADITI_MCP_TOKEN'].map((key) => ({
      env: { [key]: 'synthetic' },
    })),
    { secretFiles: ['/run/raditi/secrets/llm'] },
    { secretFiles: ['/run/raditi/secrets/mcp'] },
    { environ: 'PATH=/usr/bin\0KIMI_MODEL_API_KEY=synthetic\0' },
    { environ: 'RADITI_MCP_TOKEN=synthetic\0' },
  ]) {
    const files = new Map([['index.php', 'initial']])
    assert.throws(() => runShell(shell, files, overrides))
    assert.equal(files.get('index.php'), 'initial')
  }
})

test('MCP must be advertised and actually called before a claimed result is accepted', async (t) => {
  const missing = await open(t)
  const missingBody = await firstShell(missing)
  missingBody.tools = tools.filter((tool) => tool.function.name !== 'mcp__raditi__site_info')
  assert.equal(
    (await send(missing, '/kimi/v1/chat/completions', turn(1).llmKey, missingBody)).status,
    400,
  )
  assert.deepEqual(missing.observations().problems, ['Turn MCP tool was not advertised'])
  const fixture = await open(t)
  const body = await firstShell(fixture)
  const call = await llm(fixture, 1, body)
  body.messages.push(call, {
    role: 'tool',
    tool_call_id: call.tool_calls[0].id,
    content: 'raditi-p5-mcp-ok-turn-1',
  })
  assert.equal((await send(fixture, '/kimi/v1/chat/completions', turn(1).llmKey, body)).status, 400)
  assert.deepEqual(fixture.observations().problems, ['Successful MCP output missing'])
})

test('MCP output needs its own matching tool call id after handshake and call', async (t) => {
  const fixture = await open(t)
  const body = await firstShell(fixture)
  const call = await llm(fixture, 1, body)
  await mcp(fixture, 1, 'initialize', { protocolVersion: '2025-03-26' })
  await mcp(fixture, 1, 'tools/list')
  const answer = await mcp(fixture, 1, 'tools/call', { name: 'site_info', arguments: {} })
  body.messages.push(call, {
    role: 'tool',
    tool_call_id: 'wrong-id',
    content: JSON.stringify(answer),
  })
  assert.equal((await send(fixture, '/kimi/v1/chat/completions', turn(1).llmKey, body)).status, 400)
  assert.deepEqual(fixture.observations().problems, ['Successful MCP output missing'])
})

test('MCP liveness ping returns an empty result preserving request id zero after initialize', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  await mcp(fixture, 1, 'initialize', { protocolVersion: '2025-03-26' })
  const response = await send(fixture, '/mcp', turn(1).mcpKey, {
    jsonrpc: '2.0',
    id: 0,
    method: 'ping',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.text), { jsonrpc: '2.0', id: 0, result: {} })
  assert.deepEqual(fixture.observations().problems, [])
  assert.equal((await mcp(fixture, 1, 'tools/list')).tools[0].name, 'site_info')
  assert.equal(fixture.observations().turns[0].mcpCalls, 0)
})

test('MCP ping requires initialize and does not admit unknown RPC methods', async (t) => {
  const early = await open(t)
  early.addTurn(turn(1))
  assert.equal(
    (
      await send(early, '/mcp', turn(1).mcpKey, {
        jsonrpc: '2.0',
        id: 0,
        method: 'ping',
      })
    ).status,
    400,
  )
  assert.deepEqual(early.observations().problems, ['Turn MCP initialize missing'])
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  await mcp(fixture, 1, 'initialize', { protocolVersion: '2025-03-26' })
  assert.equal(
    (
      await send(fixture, '/mcp', turn(1).mcpKey, {
        jsonrpc: '2.0',
        id: 0,
        method: 'unknown',
      })
    ).status,
    400,
  )
  assert.deepEqual(fixture.observations().problems, ['Unexpected MCP method'])
})

test('unhandled MCP notifications expose only bounded method classifications after credential checks', async (t) => {
  for (const [method, label] of [
    [undefined, 'missing-method'],
    ['notifications/roots/list_changed', 'notifications/roots/list_changed'],
    ['notifications/other', 'other:notifications/other'],
    ['untrusted body with spaces and newlines\n', 'unknown'],
    ['x'.repeat(101), 'unknown'],
  ]) {
    const fixture = await open(t)
    fixture.addTurn(turn(1))
    const response = await send(fixture, '/mcp', turn(1).mcpKey, { jsonrpc: '2.0', method })
    assert.equal(response.status, 400)
    assert.deepEqual(fixture.observations().problems, [`Unexpected MCP notification (${label})`])
    assert.equal(
      JSON.parse(response.text).error.message,
      'Synthetic runner fixture rejected request',
    )
  }
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  assert.equal(
    (
      await send(fixture, '/mcp', turn(1).mcpKey, {
        jsonrpc: '2.0',
        method: turn(1).llmKey,
      })
    ).status,
    400,
  )
  assert.deepEqual(fixture.observations().problems, ['Credential entered a request body'])
})

test('MCP cancellation acknowledges numeric zero and string request ids after initialize without executing tools', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  await mcp(fixture, 1, 'initialize', { protocolVersion: '2025-03-26' })
  for (const params of [
    { requestId: 0 },
    { requestId: 'completed-request', reason: 'Client closed' },
  ]) {
    const response = await send(fixture, '/mcp', turn(1).mcpKey, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params,
    })
    assert.equal(response.status, 202)
    assert.equal(response.text, '')
  }
  assert.deepEqual(fixture.observations().problems, [])
  assert.equal(fixture.observations().turns[0].mcpCalls, 0)
  assert.equal((await mcp(fixture, 1, 'tools/list')).tools[0].name, 'site_info')
})

test('MCP cancellation requires initialize and bounded request ids and reasons', async (t) => {
  const early = await open(t)
  early.addTurn(turn(1))
  assert.equal(
    (
      await send(early, '/mcp', turn(1).mcpKey, {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 0 },
      })
    ).status,
    400,
  )
  assert.deepEqual(early.observations().problems, ['Turn MCP initialize missing'])
  for (const params of [
    undefined,
    null,
    [],
    {},
    { requestId: null },
    { requestId: true },
    { requestId: 0.5 },
    { requestId: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: '' },
    { requestId: 'x'.repeat(129) },
    { requestId: 0, reason: null },
    { requestId: 0, reason: 'x'.repeat(2049) },
  ]) {
    const fixture = await open(t)
    fixture.addTurn(turn(1))
    await mcp(fixture, 1, 'initialize', { protocolVersion: '2025-03-26' })
    const response = await send(fixture, '/mcp', turn(1).mcpKey, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params,
    })
    assert.equal(response.status, 400)
    assert.deepEqual(fixture.observations().problems, ['Invalid MCP cancellation'])
  }
})

test('hostile project routes, telemetry and auxiliary endpoints are recorded as failures', async (t) => {
  for (const path of [
    '/disabled/project-mcp',
    '/telemetry',
    '/kimi/v1/models',
    '/secondary',
    '/kimi/v1/chat/completions?title=1',
  ]) {
    const fixture = await open(t)
    fixture.addTurn(turn(1))
    assert.equal((await send(fixture, path, turn(1).llmKey, {})).status, 400)
    assert.deepEqual(fixture.observations().problems, ['Unexpected fixture route'])
    assert.throws(() => fixture.assertComplete(), /failed requests/)
  }
})

test('wrong profiles, hostile system settings, output flags and subagents fail closed', async (t) => {
  for (const mutate of [
    (body) => {
      body.model = 'foreign-model'
    },
    (body) => {
      body.thinking.effort = 'high'
    },
    (body) => {
      body.stream = false
    },
    (body) => {
      body.messages[0].content = 'No output contract RADITI_PLATFORM_TURN_1'
    },
    (body) => {
      body.messages[0].content += ' HOSTILE_PROJECT_AGENT'
    },
    (body) => {
      body.messages[0].content = 'client_message'
    },
    (body) => {
      body.response_format = { type: 'json_schema' }
    },
    // Above the gateway policy for Kimi bodies (65 536): every real request would be refused.
    (body) => {
      body.max_completion_tokens = 65_537
    },
    (body) => {
      body.max_tokens = 131_072
    },
    ...['Agent', 'AgentSwarm', '$web_search', 'CreateGoal', 'WebSearch', 'Skill', 'Cron'].map(
      (name) => (body) => {
        body.tools = [...tools, { type: 'function', function: { name } }]
      },
    ),
  ]) {
    const fixture = await open(t)
    fixture.addTurn(turn(1))
    const body = bodyFor(1)
    mutate(body)
    assert.equal(
      (await send(fixture, '/kimi/v1/chat/completions', turn(1).llmKey, body)).status,
      400,
    )
    assert.equal(fixture.observations().problems.length, 1)
  }
})

test('known body credentials and unknown authorization never reach diagnostics', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  assert.equal(
    (await send(fixture, '/kimi/v1/chat/completions', 'unknown-secret-marker', bodyFor(1))).status,
    401,
  )
  for (const key of [turn(1).llmKey, turn(1).mcpKey]) {
    const body = bodyFor(1)
    body.messages.push({ role: 'user', content: key })
    const response = await send(fixture, '/kimi/v1/chat/completions', turn(1).llmKey, body)
    assert.equal(response.status, 400)
    assert.ok(!response.text.includes(key))
    assert.ok(!JSON.stringify(fixture.observations()).includes(key))
  }
  assert.ok(!JSON.stringify(fixture.observations()).includes('unknown-secret-marker'))
})

test('registration requires rotating keys, expected profiles and an unspoofed new prompt', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  for (const overrides of [
    { llmKey: turn(1).llmKey },
    { llmKey: turn(2).mcpKey },
    { model: 'k3' },
    { effort: 'low' },
    { prompt: fixture.resultFor(1).summary },
  ])
    assert.throws(() => fixture.addTurn({ ...turn(2), ...overrides }))
  assert.throws(() => fixture.assertComplete(), /two registered turns/)
  await fixture.close()
  await fixture.close()
  assert.throws(() => fixture.addTurn(turn(2)), /Unexpected fixture turn/)
})

test('authenticated request counts are bounded', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  for (let i = 0; i < 25; i++) {
    const response = await send(fixture, '/mcp', turn(1).mcpKey, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    assert.equal(response.status, i < 24 ? 202 : 400)
  }
  assert.deepEqual(fixture.observations().problems, ['Fixture request limit exceeded'])
})
