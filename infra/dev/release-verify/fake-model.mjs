// The synthetic Z.ai of the release stand, in the stand's own process: the state and the
// answers of infra/dev/llm-verify/fake-zai.mjs behind a TLS server of the stand's certificate,
// with gates the scenarios hold — the first request of a round of a turn waits until what that
// round needs is in place (the preview of its dialog built), so the scripted turn is the same
// every run. A gate is a precondition of the stand, never a check: what the product does
// without one is a scenario of its own (S6a, the call before the preview is ready).
import { createServer as createHttpsServer } from 'node:https'
import { Readable } from 'node:stream'

import { programAnswer, usableProgram } from '../browser-task-verify/model.mjs'
import { createFakeZaiState, handleZai, isZaiRequest, zaiFrames } from '../llm-verify/fake-zai.mjs'

/** The tool steps a chat request holds since the last message of the user (fake-zai.mjs). */
export function roundOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const turn = messages.slice(messages.findLastIndex((message) => message?.role === 'user') + 1)
  return turn.filter(
    (message) => message?.role === 'assistant' && Array.isArray(message.tool_calls),
  ).length
}

export async function startFakeModel({ key, cert, port }) {
  const state = createFakeZaiState({})
  /** round → what its first request waits for; each opens once. */
  let gates = new Map()
  /** The program of a turn that reads pages (`--browser`, browser-task-verify/programs.mjs). */
  let program = null
  let sequence = 0
  const answerWith = (res, body, config) => {
    sequence += 1
    const frames = zaiFrames(body, config, sequence)
    res.writeHead(200, {
      'content-type': 'text/event-stream;charset=UTF-8',
      'x-request-id': `synthetic-program-${sequence}`,
    })
    res.end(frames.body.join('') + frames.last + frames.done)
  }
  const provider = createHttpsServer({ key, cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    if (!isZaiRequest(req)) {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 500, msg: '404 NOT_FOUND', success: false }))
    }
    try {
      // The quota path answers at once: the role llm probes the windows of the account.
      let request = req
      if (req.method === 'POST' && (gates.size > 0 || program !== null)) {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const bytes = Buffer.concat(chunks)
        let body = null
        try {
          body = JSON.parse(bytes.toString('utf8'))
        } catch {
          // handleZai answers what it cannot read.
        }
        // A request that declares no tool (the CLI's compaction) is no round of the script.
        const declared = Array.isArray(body?.tools) && body.tools.length > 0
        if (declared && program !== null) {
          state.requests.push({ method: req.method, path: req.url, body })
          return answerWith(res, body, programAnswer(program, body))
        }
        const round = declared ? roundOf(body) : null
        const gate = round === null ? undefined : gates.get(round)
        if (gate) {
          gates.delete(round)
          await gate()
        }
        request = Object.assign(Readable.from([bytes]), {
          method: req.method,
          url: req.url,
          headers: req.headers,
          socket: req.socket,
        })
      }
      await handleZai(request, res, state)
    } catch {
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: '1210', message: 'Synthetic.' } }))
      }
    }
  })
  await new Promise((done, reject) => {
    provider.once('error', reject)
    provider.listen(port, '127.0.0.1', done)
  })
  return {
    state,
    port: provider.address().port,
    /**
     * The answers of the next turn (stand.mjs, MODEL_TURNS) and what its rounds wait for:
     * `waitFor` — the first answer, `gates` — `{ [round]: () => Promise }`. A gate must not
     * throw: what it finds is kept for the scenario to check.
     */
    script(turn, { waitFor = null, gates: given = {} } = {}) {
      program = null
      state.setScenario(turn)
      gates = new Map(Object.entries(given).map(([round, gate]) => [Number(round), gate]))
      if (waitFor) gates.set(0, waitFor)
    },
    /** The next turn is `name` of programs.mjs: it reads what the tools answer and decides. */
    program(name, ctx = {}) {
      gates = new Map()
      program = usableProgram(name, ctx)
      state.setScenario({ scenario: 'text', text: 'Задача в браузере' })
      return program
    },
    current: () => program,
    /** Chat requests so far, by the credential they carried. */
    chats: () => state.requests.filter((request) => request.method === 'POST'),
    close: () =>
      new Promise((done) => {
        provider.closeAllConnections()
        provider.close(done)
      }),
  }
}
