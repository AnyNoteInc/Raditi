/* global fetch */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { startOpencodeRunnerFixture } from './opencode-runner-fixture.mjs'

const PATH = '/zai/v4/chat/completions'
const turn = (number) => ({
  turn: number,
  llmKey: `synthetic-llm-${number}`,
  mcpKey: `synthetic-mcp-${number}`,
  prompt: number === 1 ? '-' : `/init ${'ю'.repeat(99_000)}`,
  effort: number === 1 ? 'low' : 'high',
})
const tools = [
  ...['edit', 'glob', 'grep', 'read', 'todowrite', 'write', 'raditi_site_info'].map((name) => ({
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } },
  })),
  {
    type: 'function',
    function: {
      name: 'bash',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
      },
    },
  },
]
/** What the pinned CLI sends: no reasoning field of any kind, the prompt as the last user text. */
const bodyFor = (number, history = []) => ({
  model: 'glm-5.3',
  max_tokens: 32_000,
  stream: true,
  stream_options: { include_usage: true },
  tool_choice: 'auto',
  tools,
  messages: [
    {
      role: 'system',
      content: `You are the Raditi website agent.\n{"client_message":{"type":"string"}}\nSynthetic runner verification\nRADITI_PLATFORM_TURN_${number}`,
    },
    ...history,
    { role: 'user', content: `Client request:\n${turn(number).prompt}` },
  ],
})
async function open(t) {
  const fixture = await startOpencodeRunnerFixture()
  t.after(() => fixture.close())
  return fixture
}
async function send(fixture, path, key, body, method = 'POST') {
  const response = await fetch(`${fixture.origin}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, text: await response.text() }
}
async function llm(fixture, number, body) {
  const response = await send(fixture, PATH, turn(number).llmKey, body)
  assert.equal(response.status, 200, response.text)
  const frames = response.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
  assert.equal(frames.pop(), '[DONE]')
  const chunks = frames.map((frame) => JSON.parse(frame))
  // The provider reports usage with the chunk that carries the finish reason.
  assert.equal(chunks.at(-1).usage.total_tokens, 7199)
  assert.match(chunks.at(-1).choices[0].finish_reason, /^(stop|tool_calls)$/)
  let content = ''
  let call
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk')
    for (const choice of chunk.choices) {
      content += choice.delta.content ?? ''
      for (const part of choice.delta.tool_calls ?? [])
        call = { id: part.id, type: part.type, function: part.function }
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
/** Runs the fixture's shell command the way the sandbox would, over a stand-in for its world. */
function runShell(message, files, number, overrides = {}) {
  const call = message.tool_calls[0]
  assert.equal(call.function.name, 'bash')
  const command = JSON.parse(call.function.arguments).command
  assert.ok(command.startsWith("node -e '") && command.endsWith("'"))
  // Only digests of the turn's credentials travel inside the command.
  for (const key of [turn(number).llmKey, turn(number).mcpKey]) assert.ok(!command.includes(key))
  const source = command.slice(9, -1).replaceAll("'\\''", "'")
  const stdout = []
  const environment = overrides.env ?? {
    PATH: '/usr/bin',
    HOME: '/agent-home/opencode',
    BUN_ENABLE_CRASH_REPORTING: '0',
  }
  runInNewContext(source, {
    require(name) {
      if (name === 'node:assert/strict') return assert
      if (name === 'node:crypto') return { createHash }
      if (name === 'node:child_process')
        return {
          execFileSync(binary, args, options) {
            assert.deepEqual(Array.from(args), binary === 'uname' ? ['-r'] : ['--version'])
            if (binary === 'uname') return overrides.kernel ?? '4.19.0-gvisor\n'
            assert.equal(binary, 'opencode')
            // A home of its own: the version check must not touch the session of the turn.
            assert.notEqual(options.env.HOME, environment.HOME)
            return overrides.version ?? '1.18.34\n'
          },
        }
      assert.equal(name, 'node:fs')
      return {
        readdirSync(path) {
          if (path === '/run/raditi/secrets') return overrides.secretFiles ?? []
          assert.equal(path, '/proc')
          return ['1', '17', 'self', 'uptime']
        },
        readFileSync(path) {
          if (!path.startsWith('/proc/')) return files.get(path)
          assert.match(path, /^\/proc\/(1|17)\/environ$/)
          return overrides.environ ?? 'PATH=/usr/bin\0HOME=/agent-home/opencode\0'
        },
        appendFileSync: (path, content) => files.set(path, (files.get(path) ?? '') + content),
        writeFileSync: (path, content) => files.set(path, content),
      }
    },
    process: { env: environment, getuid: () => overrides.uid ?? 10001, getgid: () => 10001 },
    console: { log: (line) => stdout.push(line) },
  })
  return { role: 'tool', tool_call_id: call.id, content: `${stdout.join('\n')}\n` }
}
/** One whole turn of the fixture's script: shell, MCP tool, result. */
async function play(fixture, number, files, history = []) {
  // The history of the session, the request of this turn, then what the turn has done so far.
  const body = (steps) => {
    const value = bodyFor(number, history)
    value.messages.push(...steps)
    return value
  }
  const steps = []
  // The wrapper asks the MCP server first, then the CLI connects by itself.
  for (const client of ['raditi-turn', 'opencode'])
    await mcp(fixture, number, 'initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: client },
    })
  const shell = await llm(fixture, number, body(steps))
  steps.push(shell, runShell(shell, files, number))
  assert.deepEqual(
    (await mcp(fixture, number, 'tools/list')).tools.map((tool) => tool.name),
    ['site_info'],
  )
  const tool = await llm(fixture, number, body(steps))
  assert.equal(tool.tool_calls[0].function.name, 'raditi_site_info')
  const called = await mcp(fixture, number, 'tools/call', { name: 'site_info', arguments: {} })
  steps.push(tool, {
    role: 'tool',
    tool_call_id: tool.tool_calls[0].id,
    content: called.content[0].text,
  })
  const final = await llm(fixture, number, body(steps))
  assert.equal(final.tool_calls, undefined)
  return [{ role: 'user', content: `Client request:\n${turn(number).prompt}` }, ...steps, final]
}

test('plays two turns: shell under gVisor, MCP tool, result; the second sees the first', async (t) => {
  const fixture = await open(t)
  const files = new Map([['index.php', "<?php echo 'hello';\n"]])
  assert.deepEqual(fixture.addTurn(turn(1)), fixture.resultFor(1))
  const first = await play(fixture, 1, files)
  assert.deepEqual(JSON.parse(first.at(-1).content), fixture.resultFor(1))
  assert.equal(files.get('index.php'), "<?php echo 'hello';\nturn 1\n")
  assert.equal(files.get('turn-1.txt'), 'turn 1\n')
  fixture.addTurn(turn(2))
  const second = await play(fixture, 2, files, first)
  assert.deepEqual(JSON.parse(second.at(-1).content), fixture.resultFor(2))
  assert.ok(files.get('index.php').endsWith('turn 1\nturn 2\n'))
  fixture.assertComplete()
  const observed = fixture.observations()
  assert.deepEqual(observed.problems, [])
  assert.deepEqual(
    observed.turns.map((item) => [item.turn, item.phase, item.llmRequests, item.mcpCalls]),
    [
      [1, 'completed', 3, 1],
      [2, 'completed', 3, 1],
    ],
  )
  assert.equal(observed.turns[1].continuationSeen, true)
  // Nothing of a credential is kept in what the stand prints.
  assert.ok(!JSON.stringify(observed).includes('synthetic-llm'))
})

test('the shell command refuses a sandbox that is not the one of the product', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  const shell = await llm(fixture, 1, bodyFor(1))
  const files = () => new Map([['index.php', '']])
  const digest = (value) => createHash('sha256').update(value).digest('hex')
  assert.ok(
    JSON.parse(shell.tool_calls[0].function.arguments).command.includes(digest('synthetic-llm-1')),
  )
  for (const overrides of [
    { kernel: '6.12.76-linuxkit\n' },
    { uid: 0 },
    { version: '1.18.35\n' },
    { secretFiles: ['llm'] },
    // The turn key or the MCP token in the command's own environment, or in any process.
    { env: { PATH: '/usr/bin', BUN_ENABLE_CRASH_REPORTING: '0', ANY_NAME: 'synthetic-llm-1' } },
    { env: { PATH: '/usr/bin', BUN_ENABLE_CRASH_REPORTING: '0', AUTH: 'Bearer synthetic-mcp-1' } },
    { environ: 'PATH=/usr/bin\0X=synthetic-mcp-1\0' },
    // The switch of the crash upload, and a request that outranks it.
    { env: { PATH: '/usr/bin' } },
    {
      env: { PATH: '/usr/bin', BUN_ENABLE_CRASH_REPORTING: '0', BUN_CRASH_REPORT_URL: 'http://x' },
    },
  ])
    assert.throws(() => runShell(shell, files(), 1, overrides), JSON.stringify(overrides))
  assert.doesNotThrow(() => runShell(shell, files(), 1))
})

test('refuses what the driver must never send', async (t) => {
  const cases = [
    ['Unexpected fixture route', (body) => ({ path: '/kimi/v1/chat/completions', body })],
    ['Unexpected fixture route', (body) => ({ path: '/zai/v4/models', body })],
    ['Wrong model profile', (body) => ({ body: { ...body, model: 'glm-planted' } })],
    [
      'Unexpected reasoning field',
      (body) => ({ body: { ...body, thinking: { type: 'enabled' } } }),
    ],
    ['Unexpected reasoning field', (body) => ({ body: { ...body, reasoning_effort: 'max' } })],
    ['Turn streaming missing', (body) => ({ body: { ...body, stream: false } })],
    ['Turn usage reporting missing', (body) => ({ body: { ...body, stream_options: {} } })],
    [
      'Turn output limit exceeds the gateway policy',
      (body) => ({ body: { ...body, max_tokens: 32_001 } }),
    ],
    ['Unexpected output schema flag', (body) => ({ body: { ...body, response_format: {} } })],
    [
      'Unexpected advertised tool',
      (body) => ({
        body: {
          ...body,
          tools: [...body.tools, { type: 'function', function: { name: 'webfetch' } }],
        },
      }),
    ],
    [
      'Unexpected advertised tool',
      (body) => ({ body: { ...body, tools: [...body.tools, { type: 'web_search' }] } }),
    ],
    [
      'Shell tool was not advertised',
      (body) => ({
        body: { ...body, tools: body.tools.filter((tool) => tool.function.name !== 'bash') },
      }),
    ],
    [
      'Turn result instructions missing',
      (body) => ({
        body: {
          ...body,
          messages: [{ role: 'system', content: 'RADITI_PLATFORM_TURN_1' }, body.messages[1]],
        },
      }),
    ],
    [
      'Turn current platform instructions missing',
      (body) => ({
        body: {
          ...body,
          messages: [{ role: 'system', content: 'client_message' }, body.messages[1]],
        },
      }),
    ],
    [
      'Unexpected project instructions',
      (body) => ({
        body: {
          ...body,
          messages: [
            { role: 'system', content: `${body.messages[0].content}\nHOSTILE_PROJECT_AGENT` },
            body.messages[1],
          ],
        },
      }),
    ],
    [
      'Unexpected project instructions',
      (body) => ({
        body: {
          ...body,
          messages: [
            { role: 'system', content: `${body.messages[0].content}\nHOSTILE_PROJECT_AGENTS_MD` },
            body.messages[1],
          ],
        },
      }),
    ],
    [
      'Turn prompt missing',
      (body) => ({
        body: {
          ...body,
          messages: [body.messages[0], { role: 'user', content: 'Client request:\nother' }],
        },
      }),
    ],
    [
      'Credential entered a request body',
      (body) => ({
        body: {
          ...body,
          messages: [...body.messages, { role: 'user', content: 'synthetic-mcp-1' }],
        },
      }),
    ],
  ]
  for (const [problem, change] of cases) {
    await t.test(problem, async (subtest) => {
      const fixture = await open(subtest)
      fixture.addTurn(turn(1))
      const { path = PATH, body } = change(bodyFor(1))
      const response = await send(fixture, path, turn(1).llmKey, body)
      assert.equal(response.status, 400)
      // A final refusal in the shape the CLI does not repeat, and no detail of the request.
      assert.deepEqual(JSON.parse(response.text), {
        error: {
          type: 'invalid_request_error',
          message: 'Synthetic runner fixture rejected request',
        },
      })
      assert.deepEqual(fixture.observations().problems, [problem])
      assert.throws(() => fixture.assertComplete())
    })
  }
})

test('refuses a foreign key, a continuation without history and a request out of order', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  for (const [path, key] of [
    [PATH, 'synthetic-llm-2'],
    [PATH, turn(1).mcpKey],
    ['/mcp', turn(1).llmKey],
  ]) {
    const response = await send(fixture, path, key, bodyFor(1))
    assert.equal(response.status, 401)
  }
  assert.deepEqual(fixture.observations().problems, [
    'unauthorized',
    'unauthorized',
    'unauthorized',
  ])

  const order = await open(t)
  order.addTurn(turn(1))
  // The MCP tool before the model asked for it; a method the CLI never calls.
  await mcp(order, 1, 'initialize', { protocolVersion: '2025-11-25' })
  await mcp(order, 1, 'tools/list')
  assert.equal(
    (
      await send(order, '/mcp', turn(1).mcpKey, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'site_info', arguments: {} },
      })
    ).status,
    400,
  )
  assert.equal(
    (await send(order, '/mcp', turn(1).mcpKey, { jsonrpc: '2.0', id: 2, method: 'resources/list' }))
      .status,
    400,
  )
  assert.deepEqual(order.observations().problems, [
    'Unexpected MCP call order',
    'Unexpected MCP method',
  ])
  // The transport's own requests are answered, not judged.
  assert.equal((await send(order, '/mcp', turn(1).mcpKey, null, 'GET')).status, 405)
  assert.equal((await send(order, '/mcp', turn(1).mcpKey, null, 'DELETE')).status, 204)
  for (const method of ['notifications/initialized', 'notifications/cancelled'])
    assert.equal(
      (
        await send(order, '/mcp', turn(1).mcpKey, {
          jsonrpc: '2.0',
          method,
          ...(method.endsWith('cancelled') ? { params: { requestId: 1, reason: 'done' } } : {}),
        })
      ).status,
      202,
    )

  const second = await open(t)
  second.addTurn(turn(1))
  second.addTurn(turn(2))
  assert.equal((await send(second, PATH, turn(2).llmKey, bodyFor(2))).status, 400)
  assert.deepEqual(second.observations().problems, ['Prior session marker missing'])
})

test('accepts only the two turns of the stand, with rotated credentials', async (t) => {
  const fixture = await open(t)
  for (const [change, message] of [
    [{ turn: 3 }, 'Unexpected fixture turn'],
    [{ effort: 'max' }, 'Invalid fixture effort'],
    [{ model: 'glm-planted' }, 'Invalid fixture model'],
    [{ prompt: '' }, 'Invalid fixture prompt'],
    [{ llmKey: 'short' }, 'Invalid fixture credential'],
    [{ mcpKey: turn(1).llmKey }, 'Fixture credentials must rotate between turns'],
  ])
    assert.throws(() => fixture.addTurn({ ...turn(1), ...change }), { message })
  fixture.addTurn(turn(1))
  assert.throws(() => fixture.addTurn(turn(1)), { message: 'Unexpected fixture turn' })
  assert.throws(() => fixture.addTurn({ ...turn(2), llmKey: turn(1).llmKey }), {
    message: 'Fixture credentials must rotate between turns',
  })
  assert.throws(() => fixture.assertComplete(), {
    message: 'Fixture requires two registered turns',
  })
  await fixture.close()
  assert.throws(() => fixture.addTurn(turn(2)), { message: 'Unexpected fixture turn' })
})
