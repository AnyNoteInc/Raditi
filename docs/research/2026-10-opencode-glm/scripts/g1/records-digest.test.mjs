// node --test docs/research/2026-10-opencode-glm/scripts/g1/records-digest.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digestRecords } from './records-digest.mjs'

const request = (n, ms, messages, extra = {}) => ({
  kind: 'llm',
  n,
  ms,
  request: {
    bodyBytes: 100 + n,
    headers: { authorization: 'Bearer <dummy llm token>' },
    summary: {
      fields: ['model', 'messages', ...(extra.tools ? ['tools'] : [])],
      model: 'glm-5.3',
      tools: extra.tools,
      systemHead: `${'S'.repeat(90)} tail that is cut`,
      messages: messages.map((message) => `${message.role}(${String(message.content).length})`),
    },
    body: { model: 'glm-5.3', messages },
  },
  response: extra.response ?? { kind: 'sse', status: 200 },
})

test('a digest keeps what a request looked like and drops its body and headers', () => {
  const digest = digestRecords({
    run: 'p4-x',
    records: [
      request(1, 3000, [{ role: 'user', content: 'do it' }], { tools: ['bash', 'read'] }),
      { kind: 'mcp', ms: 3100, request: { method: 'POST' }, response: { status: 200 } },
      request(
        2,
        3400,
        [
          { role: 'user', content: 'do it' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
          { role: 'tool', tool_call_id: 'call_1', content: `bash-ran /\n${'x'.repeat(400)}` },
        ],
        { response: { kind: 'http', status: 400 } },
      ),
      request(3, 3401, [{ role: 'user', content: 'again' }], {
        response: { capped: true, status: 401 },
      }),
    ],
  })
  assert.deepEqual(
    digest.requests.map((item) => [item.n, item.ms, item.bodyBytes, item.tools, item.answer]),
    [
      [1, 3000, 101, 2, 'sse 200'],
      [2, 3400, 102, 0, 'http 400'],
      [3, 3401, 103, 0, 'cap of the stand, 401'],
    ],
  )
  assert.equal(digest.requests[0].fields, 'model,messages,tools')
  assert.equal(digest.requests[1].messages, 'user(5) assistant(0) tool(411)')
  assert.equal(digest.requests[0].system, 'S'.repeat(80))
  // What the tools answered, as the model saw it in the request that carried the most of it.
  assert.deepEqual(digest.toolResults, [`bash-ran /\n${'x'.repeat(189)}`])
  const text = JSON.stringify(digest)
  for (const gone of ['authorization', 'call_1', '"body"', 'headers'])
    assert.ok(!text.includes(gone))
})

test('a run without model requests gives an empty digest', () => {
  assert.deepEqual(digestRecords({ records: [] }), { requests: [], toolResults: [] })
})
