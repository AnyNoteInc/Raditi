// Step 1: plain HTTP probes of https://api.z.ai/api/v1. Usage: PROBE_KEY_FILE=… PROBE_OUT=… node probe1.mjs <probe> [<probe>...]
import { call, eventOrder, show, interestingHeaders, leakCheck } from './zai.mjs'

const MODEL = 'glm-5.3'
const input = (text) => [{ role: 'user', content: [{ type: 'input_text', text }] }]
const TOOL = {
  type: 'function',
  name: 'get_weather',
  description: 'Returns the weather of a city. Always call it when the user asks about weather.',
  strict: false,
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
}

function usageOf(result) {
  if (result.json?.usage) return result.json.usage
  if (!result.events) return undefined
  const found = []
  for (const item of result.events) {
    const usage = item.json?.response?.usage ?? item.json?.usage
    if (usage) found.push({ in: item.event ?? item.json?.type ?? item.json?.object, usage })
  }
  return found
}

function report(result, { body = 900 } = {}) {
  console.log(
    `status=${result.status} elapsedMs=${result.elapsedMs} failure=${result.failure ?? ''} sample=${result.file.split('/').pop()}`,
  )
  show('headers', interestingHeaders(result.headers), 2500)
  if (result.events) {
    show('event order', eventOrder(result.events), 3000)
    show('usage', usageOf(result), 1500)
  } else show('body', result.json ?? result.text, body)
}

const probes = {
  async models() {
    const result = await call('01-models', { method: 'GET', path: '/models' })
    report(result, { body: 4000 })
  },
  async 'responses-plain'() {
    const result = await call('02-responses-plain', {
      path: '/responses',
      body: {
        model: MODEL,
        input: input('Reply with the single word: pong'),
        max_output_tokens: 64,
      },
    })
    report(result, { body: 3500 })
  },
  async 'responses-stream'() {
    const result = await call('03-responses-stream', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        input: input('Reply with the single word: pong'),
        max_output_tokens: 64,
        stream: true,
      },
    })
    report(result)
    if (result.events) {
      const first = result.events[0]
      const last = result.events.filter((item) => item.json).at(-1)
      show('first event', first?.json ?? first?.raw, 1500)
      show('last event', last?.json, 3000)
      show('tail raw', result.text.slice(-200))
    }
  },
  async 'responses-tool'() {
    const result = await call('04-responses-tool', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        input: input('What is the weather in Kazan? Use the tool.'),
        tools: [TOOL],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_output_tokens: 256,
        stream: true,
      },
    })
    report(result)
    if (result.events) {
      for (const item of result.events) {
        const type = item.event ?? item.json?.type
        if (/function_call|output_item/.test(type ?? '')) show(type, item.json, 700)
      }
      show('last event', result.events.filter((item) => item.json).at(-1)?.json, 2500)
    }
  },
  async 'responses-reasoning'() {
    const result = await call('05-responses-reasoning', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        input: input('What is 17 * 23? Answer with the number only.'),
        reasoning: { effort: 'low', summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        max_output_tokens: 512,
        stream: true,
      },
    })
    report(result)
    if (result.events) {
      const seen = new Set()
      for (const item of result.events) {
        const type = item.event ?? item.json?.type
        if (/reasoning/.test(type ?? '') && !seen.has(type)) {
          seen.add(type)
          show(type, item.json, 500)
        }
        if (type === 'response.output_item.done') show(type, item.json, 900)
      }
      show('last event', result.events.filter((item) => item.json).at(-1)?.json, 2500)
    }
  },
  async 'responses-extras'() {
    const result = await call('06-responses-extras', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        input: input('Reply with the single word: pong'),
        instructions: 'You are terse.',
        store: false,
        prompt_cache_key: 'rdt_probe_0001',
        raditi_unknown_field: { a: 1 },
        max_output_tokens: 64,
        stream: true,
      },
    })
    report(result)
    if (result.events)
      show('last event', result.events.filter((item) => item.json).at(-1)?.json, 2500)
  },
  async 'chat-stream'() {
    const result = await call('07-chat-stream', {
      path: '/chat/completions',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 64,
        stream: true,
        stream_options: { include_usage: true },
      },
    })
    report(result)
    if (result.events) {
      show('first event', result.events[0]?.json ?? result.events[0]?.raw, 900)
      const withJson = result.events.filter((item) => item.json)
      show('second to last', withJson.at(-2)?.json, 1200)
      show('last json event', withJson.at(-1)?.json, 1500)
      show('tail raw', result.text.slice(-120))
    }
  },
  async 'chat-plain'() {
    const result = await call('07b-chat-plain', {
      path: '/chat/completions',
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 64,
      },
    })
    report(result, { body: 2500 })
  },
  async 'chat-tool'() {
    const result = await call('07c-chat-tool-stream', {
      path: '/chat/completions',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: 'What is the weather in Kazan? Use the tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: TOOL.name,
              description: TOOL.description,
              parameters: TOOL.parameters,
            },
          },
        ],
        max_tokens: 256,
        stream: true,
        stream_options: { include_usage: true },
      },
    })
    report(result)
    if (result.events) {
      const withJson = result.events.filter((item) => item.json)
      for (const item of withJson)
        if (item.json.choices?.[0]?.delta?.tool_calls) show('tool delta', item.json, 700)
      show('last json event', withJson.at(-1)?.json, 1500)
    }
  },
  async 'err-key'() {
    const result = await call('10-err-invalid-key', {
      path: '/responses',
      auth: 'invalid',
      body: { model: MODEL, input: input('ping'), max_output_tokens: 16 },
    })
    report(result, { body: 1500 })
    show('all headers', result.headers, 3000)
  },
  async 'err-nokey'() {
    const result = await call('10b-err-no-key', {
      path: '/responses',
      auth: 'none',
      body: { model: MODEL, input: input('ping'), max_output_tokens: 16 },
    })
    report(result, { body: 1500 })
  },
  async 'err-model'() {
    const result = await call('11-err-unknown-model', {
      path: '/responses',
      body: { model: 'glm-does-not-exist', input: input('ping'), max_output_tokens: 16 },
    })
    report(result, { body: 1500 })
  },
  async 'err-model-stream'() {
    const result = await call('11b-err-unknown-model-stream', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: {
        model: 'glm-does-not-exist',
        input: input('ping'),
        max_output_tokens: 16,
        stream: true,
      },
    })
    report(result, { body: 1500 })
    if (result.events) show('events', result.text, 1500)
  },
  async 'err-body'() {
    const result = await call('12-err-malformed-body', {
      path: '/responses',
      rawBody: '{"model": "glm-5.3", "input": [',
    })
    report(result, { body: 1500 })
  },
  async 'err-shape'() {
    const result = await call('12b-err-wrong-shape', {
      path: '/responses',
      body: { model: MODEL, input: 42, max_output_tokens: 'many' },
    })
    report(result, { body: 1500 })
  },
  async 'err-max'() {
    const result = await call('13-err-max-output', {
      path: '/responses',
      body: { model: MODEL, input: input('ping'), max_output_tokens: 100000000 },
    })
    report(result, { body: 1500 })
  },
  async 'err-max-stream'() {
    const result = await call('13b-err-max-output-stream', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: { model: MODEL, input: input('ping'), max_output_tokens: 100000000, stream: true },
    })
    report(result, { body: 1500 })
    if (result.events) show('events', result.text, 1500)
  },
  async 'err-path'() {
    const result = await call('14-err-unknown-path', { method: 'GET', path: '/does-not-exist' })
    report(result, { body: 1500 })
  },
  async 'err-key-stream'() {
    const result = await call('10c-err-invalid-key-stream', {
      path: '/responses',
      auth: 'invalid',
      headers: { accept: 'text/event-stream' },
      body: { model: MODEL, input: input('ping'), max_output_tokens: 16, stream: true },
    })
    report(result, { body: 1500 })
    if (result.events) show('events', result.text, 1500)
  },
  async 'err-key-models'() {
    const result = await call('10d-err-invalid-key-models', {
      method: 'GET',
      path: '/models',
      auth: 'invalid',
    })
    report(result, { body: 1500 })
  },
  async 'stream-incomplete'() {
    const result = await call('03b-responses-stream-incomplete', {
      path: '/responses',
      headers: { accept: 'text/event-stream' },
      body: {
        model: MODEL,
        input: input('Count from 1 to 200, one number per line.'),
        reasoning: { effort: 'low' },
        max_output_tokens: 24,
        stream: true,
      },
    })
    report(result)
    if (result.events) {
      const withJson = result.events.filter((item) => item.json)
      const last = withJson.at(-1)?.json
      if (last?.response?.output)
        for (const item of last.response.output)
          if (item.content)
            for (const part of item.content)
              if (typeof part.text === 'string') part.text = part.text.slice(0, 80) + '…'
      show('last event', last, 2500)
    }
  },
  async 'models-identity'() {
    const result = await call('01b-models-identity', {
      method: 'GET',
      path: '/models',
      headers: { 'accept-encoding': 'identity' },
    })
    console.log(
      `status=${result.status} content-encoding=${result.headers['content-encoding'] ?? '(none)'} content-length=${result.headers['content-length'] ?? '(none)'} transfer-encoding=${result.headers['transfer-encoding'] ?? '(none)'}`,
    )
  },
  async 'chat-flash'() {
    const result = await call('07d-chat-plain-flash', {
      path: '/chat/completions',
      body: {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 64,
      },
    })
    report(result, { body: 2500 })
  },
  async 'chat-turbo'() {
    const result = await call('07e-chat-plain-turbo', {
      path: '/chat/completions',
      body: {
        model: 'glm-5-turbo',
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 64,
      },
    })
    report(result, { body: 2500 })
  },
  leak() {
    console.log(`samples contain key material: ${leakCheck()}`)
  },
}

for (const name of process.argv.slice(2)) {
  if (!probes[name]) {
    console.log(`unknown probe ${name}`)
    continue
  }
  console.log(`\n===== ${name}`)
  await probes[name]()
}
