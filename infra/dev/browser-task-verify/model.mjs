// The synthetic Z.ai of the browser-task stand, in the stand's own process, behind a TLS server of
// the stand's certificate. The paths of the account (the quota the role llm probes) answer as
// infra/dev/llm-verify/fake-zai.mjs answers them; a chat request is answered by the program of the
// turn (programs.mjs): the program runs again from the start over the tool calls and answers this
// request carries, and its next call — or its final answer — is streamed back as Z.ai streams.
// Every chat request is kept whole (`requests`): the stand looks there for what must never reach
// a model — the password of the site and its cookies (scenario D, L).
import { appendFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'

import {
  createFakeZaiState,
  handleZai,
  isZaiRequest,
  ZAI_PATHS,
  zaiFrames,
} from '../llm-verify/fake-zai.mjs'
import { attachmentsOf, PROGRAMS, ScriptBroken } from './programs.mjs'

const CHAT_PATHS = new Set([ZAI_PATHS.chat, ZAI_PATHS.apiChat])

/** The text of a message as the CLI sends it: a string, or parts of text. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '',
      )
      .join('')
  return ''
}

/**
 * The answer of a platform tool as the request carries it: the JSON the tool wrote (a refusal is
 * `{code, message}`), or `{text}` when it is no JSON. An MCP envelope (`{content: [...]}`) is
 * opened first.
 */
export function toolAnswerOf(content) {
  const text = textOf(content)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { text }
  }
  if (parsed && Array.isArray(parsed.content)) return toolAnswerOf(parsed.content)
  return parsed && typeof parsed === 'object' ? parsed : { text }
}

/**
 * The turn of a request: the words of its last user message and, after it, every call of the
 * model with the answer the CLI got. Calls without an answer yet are cut off.
 */
export function turnOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages.findLastIndex((message) => message?.role === 'user')
  const prompt = last >= 0 ? textOf(messages[last].content) : ''
  const answers = new Map()
  for (const message of messages.slice(last + 1))
    if (message?.role === 'tool' && typeof message.tool_call_id === 'string')
      answers.set(message.tool_call_id, message.content)
  const steps = []
  for (const message of messages.slice(last + 1)) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const toolCall of message.tool_calls) {
      let args = {}
      try {
        args = JSON.parse(toolCall?.function?.arguments ?? '{}')
      } catch {
        args = null
      }
      if (!answers.has(toolCall.id)) return { prompt, steps, open: true }
      steps.push({
        name: toolCall?.function?.name ?? '',
        args,
        answer: toolAnswerOf(answers.get(toolCall.id)),
      })
    }
  }
  return { prompt, steps, open: false }
}

const sameArgs = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The next move of a program over the calls already made: `{ call }`, `{ final }` or
 * `{ broken }`. The facts are those of this run of the program.
 */
export function nextMove(program, ctx, steps) {
  const facts = {}
  const iterator = program(ctx, facts)
  let step
  try {
    step = iterator.next()
    for (const done of steps) {
      if (step.done) return { broken: 'the program ended before the calls the CLI made', facts }
      const expected = step.value
      if (!done.name.endsWith(`_${expected.tool}`) || !sameArgs(done.args, expected.args))
        return {
          broken: `the CLI made ${done.name} where the program called ${expected.tool}`,
          facts,
        }
      step = iterator.next(done.answer)
    }
  } catch (error) {
    if (error instanceof ScriptBroken) return { broken: error.message, facts }
    throw error
  }
  if (step.done) return { final: step.value.final, facts }
  return { call: step.value, facts }
}

/** The function the CLI declared for a platform tool (`raditi_web_open`), by its own name. */
function declaredName(body, tool) {
  const names = (Array.isArray(body?.tools) ? body.tools : [])
    .map((item) => item?.function?.name)
    .filter((name) => typeof name === 'string' && name.endsWith(`_${tool}`))
  return names.length === 1 ? names[0] : null
}

const USAGE = Object.freeze({ prompt: 12_000, cached: 6_000, completion: 300, reasoning: 40 })

export async function startModel({ key, cert, port, logFile = null }) {
  const state = createFakeZaiState({})
  const requests = []
  const moves = []
  let current = null
  let sequence = 0

  const answer = (res, body, config) => {
    sequence += 1
    const frames = zaiFrames(body, { usage: USAGE, ...config }, sequence)
    res.writeHead(200, {
      'content-type': 'text/event-stream;charset=UTF-8',
      'x-request-id': `synthetic-browser-${sequence}`,
    })
    res.end(frames.body.join('') + frames.last + frames.done)
  }

  const chat = (req, res, body) => {
    requests.push(JSON.stringify(body))
    const declared = Array.isArray(body?.tools) && body.tools.length > 0
    // The CLI's own requests without tools (the title of the session, a compaction).
    if (!declared || current === null)
      return answer(res, body, { scenario: 'text', text: 'Задача в браузере' })
    const turn = turnOf(body)
    const ctx = { ...current.ctx, prompt: turn.prompt, attachments: attachmentsOf(turn.prompt) }
    const move = nextMove(current.program, ctx, turn.steps)
    current.facts = move.facts
    const last = turn.steps.at(-1)?.answer
    const entry = {
      at: new Date().toISOString(),
      program: current.name,
      steps: turn.steps.length,
      answered:
        typeof last?.code === 'string'
          ? last.code
          : (last?.tool ?? (last ? `keys:${Object.keys(last).slice(0, 4).join(',')}` : null)),
      move: move.call?.tool ?? (move.final !== undefined ? 'final' : `broken: ${move.broken}`),
    }
    moves.push(entry)
    // Names and codes only: never an argument or an answer of a tool.
    if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    if (move.broken !== undefined) {
      current.broken = move.broken
      return answer(res, body, {
        scenario: 'text',
        text: JSON.stringify({
          summary: 'The script of the stand broke',
          change_type: 'none',
          client_message: 'Не получилось выполнить задачу.',
          files_changed: [],
          questions: [],
          needs_approval: false,
          risk: 'low',
        }),
      })
    }
    if (move.final !== undefined) {
      current.finished = true
      return answer(res, body, { scenario: 'text', text: move.final })
    }
    const name = declaredName(body, move.call.tool)
    if (name === null) {
      current.broken = `the request declares no ${move.call.tool}`
      return answer(res, body, {
        scenario: 'text',
        text: 'Синтетическая модель: инструмент не объявлен.',
      })
    }
    return answer(res, body, {
      scenario: 'tools',
      rounds: [
        ...Array.from({ length: roundOf(body) }, () => []),
        [{ name, arguments: move.call.args }],
      ],
    })
  }

  const server = createHttpsServer({ key, cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      const path = new URL(req.url, 'https://synthetic.invalid').pathname
      if (!isZaiRequest(req) || !CHAT_PATHS.has(path) || req.method !== 'POST')
        return await handleZai(req, res, state)
      if (req.headers.authorization === undefined) {
        req.resume()
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: '1001', message: 'Synthetic.' } }))
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      chat(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
      if (current) current.broken = `the model failed: ${error?.message ?? error}`
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: '1210', message: 'Synthetic.' } }))
      }
    }
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', done)
  })
  return {
    state,
    requests,
    moves,
    /** The program of the next turn (programs.mjs, by name) and what it is told besides the prompt. */
    script(name, ctx = {}) {
      const program = PROGRAMS[name]
      if (!program) throw new Error(`No program ${name}`)
      current = { name, program, ctx, facts: {}, finished: false, broken: null }
      return current
    },
    current: () => current,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      }),
  }
}

/** The tool steps a chat request holds since the last message of the user (fake-zai.mjs). */
function roundOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const turn = messages.slice(messages.findLastIndex((message) => message?.role === 'user') + 1)
  return turn.filter(
    (message) => message?.role === 'assistant' && Array.isArray(message.tool_calls),
  ).length
}
