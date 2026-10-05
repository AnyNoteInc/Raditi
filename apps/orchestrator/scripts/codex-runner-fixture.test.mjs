/* global fetch */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { startCodexRunnerFixture } from './codex-runner-fixture.mjs'

const turn = (number) => ({
  turn: number,
  llmKey: `synthetic-llm-${number}`,
  mcpKey: `synthetic-mcp-${number}`,
  prompt: `Synthetic runner turn ${number}.`,
  effort: number === 1 ? 'medium' : 'high',
})
const tools = [
  {
    type: 'function',
    name: 'exec_command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'mcp__raditi__site_info',
    parameters: { type: 'object', properties: {} },
  },
]
// Codex 0.158.0 sends the platform AGENTS.md as a user message, again when it changed on resume.
const instructions = (number) => ({
  type: 'message',
  role: 'user',
  content: [
    { type: 'input_text', text: `# AGENTS.md instructions\nRADITI_PLATFORM_TURN_${number}` },
  ],
})
const bodyFor = (number, history = []) => ({
  model: 'gpt-6-sol',
  reasoning: { effort: turn(number).effort },
  text: {
    format: { type: 'json_schema', schema: { properties: { client_message: { type: 'string' } } } },
  },
  tools,
  input: [
    ...history,
    instructions(number),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn(number).prompt }] },
  ],
})
async function open(t) {
  const fixture = await startCodexRunnerFixture()
  t.after(() => fixture.close())
  return fixture
}
async function send(fixture, path, key, body) {
  const response = await fetch(`${fixture.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}
async function llm(fixture, number, body) {
  const response = await send(fixture, '/codex/responses', turn(number).llmKey, body)
  assert.equal(response.status, 200, response.text)
  return response.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === 'response.completed').response.output[0]
}
async function mcp(fixture, number, method, params = {}) {
  const response = await send(fixture, '/mcp', turn(number).mcpKey, {
    jsonrpc: '2.0',
    id: 0,
    method,
    params,
  })
  assert.equal(response.status, 200)
  return JSON.parse(response.text).result
}
function runShell(item, files, overrides = {}) {
  const command = JSON.parse(item.arguments).cmd
  assert.ok(command.startsWith("node -e '") && command.endsWith("'"))
  const source = command.slice(9, -1).replaceAll("'\\''", "'")
  const stdout = []
  runInNewContext(source, {
    require(name) {
      if (name === 'node:assert/strict') return assert
      if (name === 'node:child_process')
        return {
          execFileSync: (binary) =>
            binary === 'uname'
              ? (overrides.kernel ?? '4.4.0-gvisor\n')
              : (overrides.version ?? 'codex-cli 0.158.0\n'),
        }
      assert.equal(name, 'node:fs')
      return {
        existsSync: (path) => (overrides.secretFiles ?? []).includes(path),
        readFileSync: (path) => files.get(path),
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

test('two rounds require shell changes, actual MCP calls, rotated keys and prior assistant history', async (t) => {
  const fixture = await open(t)
  const files = new Map([['index.php', '<?php echo "hello";\n']])
  let history = []
  for (const number of [1, 2]) {
    const expected = fixture.addTurn(turn(number))
    assert.equal(
      (await mcp(fixture, number, 'initialize', { protocolVersion: '2025-03-26' })).serverInfo.name,
      'raditi-p4-runner-fixture',
    )
    assert.equal((await mcp(fixture, number, 'tools/list')).tools[0].name, 'site_info')
    const body = bodyFor(number, history)
    const shell = await llm(fixture, number, body)
    const output = runShell(shell, files)
    body.input.push(shell, { type: 'function_call_output', call_id: shell.call_id, output })
    const call = await llm(fixture, number, body)
    assert.equal(call.name, 'mcp__raditi__site_info')
    const answer = await mcp(fixture, number, 'tools/call', { name: 'site_info', arguments: {} })
    body.input.push(call, {
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify(answer),
    })
    const final = await llm(fixture, number, body)
    assert.deepEqual(JSON.parse(final.content[0].text), expected)
    history = [...body.input, final]
  }
  fixture.assertComplete()
  assert.equal(files.get('index.php'), '<?php echo "hello";\nturn 1\nturn 2\n')
  assert.equal(files.get('turn-1.txt'), 'turn 1\n')
  assert.equal(files.get('turn-2.txt'), 'turn 2\n')
  assert.deepEqual(
    fixture.observations().turns.map((row) => [row.llmRequests, row.mcpCalls, row.toolOutputSeen]),
    [
      [3, 1, true],
      [3, 1, true],
    ],
  )
  for (const number of [1, 2])
    for (const key of [turn(number).llmKey, turn(number).mcpKey, turn(number).prompt])
      assert.ok(!JSON.stringify(fixture.observations()).includes(key))
})

test('a new turn without the previous native conversation fails closed', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(2))
  const response = await send(fixture, '/codex/responses', turn(2).llmKey, bodyFor(2))
  assert.equal(response.status, 400)
  assert.deepEqual(fixture.observations().problems, ['Prior session marker missing'])
})

test('a resumed turn that carries only the previous platform instructions fails closed', async (t) => {
  const fixture = await open(t)
  const expected = fixture.addTurn(turn(1))
  fixture.addTurn(turn(2))
  const body = bodyFor(2, [
    instructions(1),
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: expected.summary }],
    },
  ])
  body.input = body.input.filter((item) => item !== body.input.at(-2))
  const response = await send(fixture, '/codex/responses', turn(2).llmKey, body)
  assert.equal(response.status, 400)
  assert.deepEqual(fixture.observations().problems, ['Turn current platform instructions missing'])
})

test('a marker inside command arguments cannot impersonate a successful shell output', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  const body = bodyFor(1)
  const shell = await llm(fixture, 1, body)
  body.input.push(shell, {
    type: 'function_call_output',
    call_id: 'wrong-call',
    output: 'raditi-p4-shell-ok-turn-1',
  })
  const response = await send(fixture, '/codex/responses', turn(1).llmKey, body)
  assert.equal(response.status, 400)
  assert.deepEqual(fixture.observations().problems, ['Successful shell output missing'])
})

test('the emitted shell proof rejects the wrong kernel, uid, gid, CLI, inherited credentials and credential files left on disk', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  const shell = await llm(fixture, 1, bodyFor(1))
  for (const overrides of [
    { kernel: '6.8.0-linux' },
    { uid: 0 },
    { gid: 0 },
    { version: 'codex-cli other' },
    { env: { RADITI_LLM_TOKEN: 'synthetic' } },
    { env: { RADITI_MCP_TOKEN: 'synthetic' } },
    { secretFiles: ['/run/raditi/secrets/llm'] },
    { secretFiles: ['/run/raditi/secrets/mcp'] },
  ]) {
    const files = new Map([['index.php', 'initial']])
    assert.throws(() => runShell(shell, files, overrides))
    assert.equal(files.get('index.php'), 'initial')
  }
})

test('wrong profiles and credentials are rejected without exposing secret values', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  assert.equal(
    (await send(fixture, '/codex/responses', 'unknown-secret-marker', bodyFor(1))).status,
    401,
  )
  for (const body of [
    { ...bodyFor(1), model: 'foreign-model' },
    { ...bodyFor(1), reasoning: { effort: 'low' } },
    { ...bodyFor(1), input: [{ type: 'message', role: 'user', content: turn(1).llmKey }] },
  ]) {
    const response = await send(fixture, '/codex/responses', turn(1).llmKey, body)
    assert.equal(response.status, 400)
    assert.ok(!response.text.includes(turn(1).llmKey))
  }
  assert.ok(!JSON.stringify(fixture.observations()).includes('unknown-secret-marker'))
  assert.throws(() => fixture.assertComplete(), /failed requests/)
})

test('registration rejects reused keys and hiding the history marker in a new prompt', async (t) => {
  const fixture = await open(t)
  const expected = fixture.addTurn(turn(1))
  assert.throws(() => fixture.addTurn({ ...turn(2), llmKey: turn(1).llmKey }), /rotate/)
  assert.throws(
    () => fixture.addTurn({ ...turn(2), prompt: expected.summary }),
    /Invalid fixture prompt/,
  )
  assert.throws(() => fixture.addTurn({ ...turn(2), llmKey: turn(2).mcpKey }), /rotate/)
})

test('authenticated request counts are bounded', async (t) => {
  const fixture = await open(t)
  fixture.addTurn(turn(1))
  for (let i = 0; i < 24; i++) {
    const response = await send(fixture, '/mcp', turn(1).mcpKey, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    assert.equal(response.status, 202)
  }
  assert.equal(
    (
      await send(fixture, '/mcp', turn(1).mcpKey, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
    ).status,
    400,
  )
  assert.deepEqual(fixture.observations().problems, ['Fixture request limit exceeded'])
})
