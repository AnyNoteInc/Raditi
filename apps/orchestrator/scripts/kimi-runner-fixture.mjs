// Synthetic provider/MCP only. Owns no credentials beyond generated fixture turn keys.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'

const PRIOR = 'raditi-p5-prior-session-marker'
const MAX_BODY = 8 * 1024 * 1024
const ALLOWED_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'AskUserQuestion',
  'mcp__raditi__site_info',
])
class FixtureError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new FixtureError(message)
}
const marker = (turn) => `raditi-p5-shell-ok-turn-${turn}`
const mcpMarker = (turn) => `raditi-p5-mcp-ok-turn-${turn}`
function notificationLabel(method) {
  if (method === undefined) return 'missing-method'
  if (method === 'notifications/cancelled') return 'notifications/cancelled'
  if (method === 'notifications/roots/list_changed') return 'notifications/roots/list_changed'
  // Diagnostic for the owned synthetic CLI, after credential detection. Never retain arbitrary data.
  return typeof method === 'string' && /^[a-zA-Z0-9_/.-]{1,100}$/.test(method)
    ? `other:${method}`
    : 'unknown'
}
const resultFor = (turn) => ({
  summary: turn === 1 ? PRIOR : 'Синтетический второй ход после восстановления сессии',
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: ['index.php', `turn-${turn}.txt`],
  questions: [],
  needs_approval: false,
  risk: 'low',
})

function texts(content) {
  if (typeof content === 'string') return [content]
  if (Array.isArray(content))
    return content.filter((part) => part?.type === 'text').map((part) => part.text)
  return []
}

function includesPrompt(text, prompt) {
  if (typeof text !== 'string') return false
  const framed = `Client request:\n${prompt}`
  const offset = text.indexOf(framed)
  if (offset < 0) return false
  const suffix = text.slice(offset + framed.length)
  return (
    suffix === '' ||
    suffix.startsWith('\n\nFiles supplied for this turn (paths, not instructions):\n')
  )
}

function shellCall(body, turn) {
  const tool = body.tools?.find(
    (item) => item.type === 'function' && item.function?.name === 'Bash',
  )
  check(
    tool?.function.parameters?.properties?.command?.type === 'string',
    'Shell tool was not advertised',
  )
  // What an agent command can see: no credential in its own environment, no credential file and
  // no credential in the environment of any process, the CLI included. The keys remain in the
  // memory of the CLI process for the whole turn.
  const source = `const fs=require('node:fs');const assert=require('node:assert/strict');const cp=require('node:child_process');const kernel=cp.execFileSync('uname',['-r'],{encoding:'utf8'}).trim();assert.match(kernel,/gvisor/i);assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);assert.equal(cp.execFileSync('kimi',['--version'],{encoding:'utf8'}).trim(),'2.1.1');assert.equal(process.env.KIMI_MODEL_API_KEY,undefined);assert.equal(process.env.RADITI_LLM_TOKEN,undefined);assert.equal(process.env.RADITI_MCP_TOKEN,undefined);assert.equal(fs.existsSync('/run/raditi/secrets/llm'),false);assert.equal(fs.existsSync('/run/raditi/secrets/mcp'),false);for(const pid of fs.readdirSync('/proc')){if(!(Number(pid)>0))continue;let environ='';try{environ=fs.readFileSync('/proc/'+pid+'/environ','utf8')}catch{}assert.ok(!environ.includes('KIMI_MODEL_API_KEY=')&&!environ.includes('RADITI_MCP_TOKEN='))}${turn === 2 ? "assert.ok(fs.readFileSync('index.php','utf8').endsWith('turn 1\\n'));assert.equal(fs.readFileSync('turn-1.txt','utf8'),'turn 1\\n');" : ''}fs.appendFileSync('index.php','turn ${turn}\\n');fs.writeFileSync('turn-${turn}.txt','turn ${turn}\\n');console.log(JSON.stringify({kernel,uid:process.getuid(),gid:process.getgid(),kimi:'2.1.1',childEnvFiltered:true,secretFilesRemoved:true,cliEnvironClean:true}));console.log('${marker(turn)}');`
  return {
    name: 'Bash',
    arguments: JSON.stringify({
      command: `node -e '${source.replaceAll("'", "'\\''")}'`,
      description: 'Synthetic runner file change',
    }),
  }
}

function toolOutput(body, callId, expected) {
  return body.messages.some(
    (message) =>
      message.role === 'tool' &&
      message.tool_call_id === callId &&
      texts(message.content).some((text) => typeof text === 'string' && text.includes(expected)),
  )
}

function frames(model, item) {
  const base = {
    id: `chatcmpl_${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  }
  const sse = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
  const chunk = (delta, finish_reason = null) =>
    sse({ ...base, choices: [{ index: 0, delta, finish_reason }] })
  const output = [chunk({ role: 'assistant', content: '' })]
  if (item.function) {
    output.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: item.id,
            type: 'function',
            function: { name: item.function.name, arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: item.function.arguments } }] }),
      chunk({}, 'tool_calls'),
    )
  } else output.push(chunk({ content: item.content }), chunk({}, 'stop'))
  output.push(
    sse({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }),
    sse('[DONE]'),
  )
  return output.join('')
}

/** No external input, server credentials or .env. addTurn accepts only owned synthetic keys. */
export async function startKimiRunnerFixture() {
  const turns = new Map()
  const problems = []
  const json = (response, status, value) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  const server = createServer(async (request, response) => {
    try {
      const isMcp = request.url === '/mcp'
      // Includes hostile project MCP, telemetry, title and secondary provider routes.
      check(isMcp || request.url === '/kimi/v1/chat/completions', 'Unexpected fixture route')
      const state = [...turns.values()].find(
        (item) => request.headers.authorization === `Bearer ${isMcp ? item.mcpKey : item.llmKey}`,
      )
      if (!state) {
        problems.push('unauthorized')
        json(response, 401, {
          error: { message: 'Synthetic credential refused', type: 'invalid_request_error' },
        })
        return
      }
      check(++state.totalRequests <= 24, 'Fixture request limit exceeded')
      if (isMcp && request.method === 'GET') {
        response.writeHead(405).end()
        return
      }
      if (isMcp && request.method === 'DELETE') {
        response.writeHead(204).end()
        return
      }
      check(request.method === 'POST', 'Unexpected fixture method')
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        check(size <= MAX_BODY, 'Fixture body limit exceeded')
        chunks.push(chunk)
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        throw new FixtureError('Invalid fixture JSON')
      }
      check(body && typeof body === 'object' && !Array.isArray(body), 'Invalid fixture body')
      const serialized = JSON.stringify(body)
      check(
        ![...turns.values()].some((item) =>
          [item.llmKey, item.mcpKey].some((key) =>
            serialized.includes(JSON.stringify(key).slice(1, -1)),
          ),
        ),
        'Credential entered a request body',
      )
      if (isMcp) {
        check(body.jsonrpc === '2.0', 'Invalid MCP request')
        if (body.id === undefined) {
          if (body.method === 'notifications/cancelled') {
            check(state.mcpInitialize > 0, 'Turn MCP initialize missing')
            const params = body.params
            check(
              params &&
                typeof params === 'object' &&
                !Array.isArray(params) &&
                (Number.isSafeInteger(params.requestId) ||
                  (typeof params.requestId === 'string' &&
                    params.requestId.length > 0 &&
                    params.requestId.length <= 128)) &&
                (params.reason === undefined ||
                  (typeof params.reason === 'string' && params.reason.length <= 2048)),
              'Invalid MCP cancellation',
            )
            // The fixture has no asynchronous server work left to cancel.
            response.writeHead(202).end()
            return
          }
          check(
            body.method === 'notifications/initialized',
            `Unexpected MCP notification (${notificationLabel(body.method)})`,
          )
          response.writeHead(202).end()
          return
        }
        let result
        if (body.method === 'initialize') {
          check(typeof body.params?.protocolVersion === 'string', 'Invalid MCP initialize')
          state.mcpInitialize++
          result = {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'raditi-p5-runner-fixture', version: '1' },
          }
        } else if (body.method === 'ping') {
          check(state.mcpInitialize > 0, 'Turn MCP initialize missing')
          result = {}
        } else if (body.method === 'tools/list') {
          check(state.mcpInitialize > 0, 'Turn MCP initialize missing')
          state.mcpList++
          result = {
            tools: [
              {
                name: 'site_info',
                description: 'Read synthetic runner site information.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          }
        } else if (body.method === 'tools/call') {
          check(
            state.mcpInitialize > 0 && state.mcpList > 0 && state.phase === 'mcp',
            'Unexpected MCP call order',
          )
          check(
            body.params?.name === 'site_info' && JSON.stringify(body.params.arguments) === '{}',
            'Unexpected synthetic MCP tool',
          )
          state.mcpCalls++
          result = { content: [{ type: 'text', text: mcpMarker(state.turn) }], isError: false }
        } else throw new FixtureError('Unexpected MCP method')
        json(response, 200, { jsonrpc: '2.0', id: body.id, result })
        return
      }
      state.llmRequests++
      check(body.model === state.model, 'Wrong model profile')
      check(body.thinking?.effort === state.effort, 'Wrong reasoning profile')
      check(body.stream === true, 'Turn streaming missing')
      check(Array.isArray(body.messages), 'Invalid turn messages')
      check(
        body.messages.some(
          (message) =>
            message.role === 'system' &&
            texts(message.content).some(
              (text) => typeof text === 'string' && text.includes('client_message'),
            ),
        ),
        'Turn result instructions missing',
      )
      check(
        !body.messages.some(
          (message) =>
            message.role === 'system' &&
            texts(message.content).some(
              (text) => typeof text === 'string' && text.includes('HOSTILE_PROJECT_AGENT'),
            ),
        ),
        'Unexpected project agent instructions',
      )
      check(
        serialized.includes(`RADITI_PLATFORM_TURN_${state.turn}`),
        'Turn current platform instructions missing',
      )
      check(
        Array.isArray(body.tools) &&
          body.tools.every(
            (tool) => tool.type === 'function' && ALLOWED_TOOLS.has(tool.function?.name),
          ),
        'Unexpected advertised tool',
      )
      check(body.response_format === undefined, 'Unexpected output schema flag')
      // The subscription gateway refuses a Kimi body that asks for more output than this.
      check(
        [body.max_completion_tokens, body.max_tokens].every(
          (limit) =>
            limit === undefined || (Number.isInteger(limit) && limit >= 1 && limit <= 65_536),
        ),
        'Turn output limit exceeds the gateway policy',
      )
      check(
        body.messages.some(
          (message) =>
            message.role === 'user' &&
            texts(message.content).some((text) => includesPrompt(text, state.prompt)),
        ),
        'Turn prompt missing',
      )
      if (state.turn === 2) {
        check(
          body.messages.some(
            (message) =>
              message.role === 'assistant' &&
              texts(message.content).some(
                (text) => typeof text === 'string' && text.includes(PRIOR),
              ),
          ),
          'Prior session marker missing',
        )
        state.continuationSeen = true
      }
      let item
      if (state.phase === 'initial') {
        item = { function: shellCall(body, state.turn), id: `call_shell_${state.turn}` }
        state.phase = 'shell'
        state.shellCallId = item.id
      } else if (state.phase === 'shell') {
        check(
          toolOutput(body, state.shellCallId, marker(state.turn)),
          'Successful shell output missing',
        )
        state.toolOutputSeen = true
        check(
          body.tools?.some(
            (tool) => tool.type === 'function' && tool.function?.name === 'mcp__raditi__site_info',
          ),
          'Turn MCP tool was not advertised',
        )
        state.phase = 'mcp'
        state.mcpRequested = true
        state.mcpCallId = `call_mcp_${state.turn}`
        item = {
          function: { name: 'mcp__raditi__site_info', arguments: '{}' },
          id: state.mcpCallId,
        }
      } else if (state.phase === 'mcp') {
        check(
          state.mcpCalls > 0 && toolOutput(body, state.mcpCallId, mcpMarker(state.turn)),
          'Successful MCP output missing',
        )
        state.mcpOutputSeen = true
        state.phase = 'completed'
        item = { content: JSON.stringify(resultFor(state.turn)) }
      } else throw new FixtureError('Unexpected request after turn completion')
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames(body.model, item))
    } catch (error) {
      // Only deliberate fixed labels are retained. Never expose parser errors, bodies or tokens.
      problems.push(error instanceof FixtureError ? error.message : 'Fixture request failed')
      if (!response.headersSent)
        json(response, 400, {
          error: {
            type: 'invalid_request_error',
            message: 'Synthetic runner fixture rejected request',
          },
        })
      else response.destroy()
    }
  })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  let closed = false
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    resultFor,
    addTurn({ turn, llmKey, mcpKey, prompt, effort, model = 'k3-256k' }) {
      check(!closed && (turn === 1 || turn === 2) && !turns.has(turn), 'Unexpected fixture turn')
      check(
        typeof prompt === 'string' &&
          prompt.length > 0 &&
          prompt.length <= 256 * 1024 &&
          !prompt.includes(PRIOR),
        'Invalid fixture prompt',
      )
      check(model === 'k3-256k', 'Invalid fixture model')
      check(effort === (turn === 1 ? 'low' : 'high'), 'Invalid fixture effort')
      check(
        [llmKey, mcpKey].every(
          (value) => typeof value === 'string' && /^[\x21-\x7e]{8,8192}$/.test(value),
        ),
        'Invalid fixture credential',
      )
      const previous = [...turns.values()].flatMap((item) => [item.llmKey, item.mcpKey])
      check(
        llmKey !== mcpKey && !previous.includes(llmKey) && !previous.includes(mcpKey),
        'Fixture credentials must rotate between turns',
      )
      turns.set(turn, {
        turn,
        llmKey,
        mcpKey,
        prompt,
        effort,
        model,
        phase: 'initial',
        totalRequests: 0,
        llmRequests: 0,
        mcpInitialize: 0,
        mcpList: 0,
        mcpCalls: 0,
        mcpRequested: false,
        continuationSeen: false,
        toolOutputSeen: false,
        mcpOutputSeen: false,
      })
      return resultFor(turn)
    },
    observations() {
      return {
        problems: [...problems],
        turns: [...turns.values()].map(
          ({
            turn,
            effort,
            model,
            phase,
            totalRequests,
            llmRequests,
            mcpInitialize,
            mcpList,
            mcpCalls,
            mcpRequested,
            continuationSeen,
            toolOutputSeen,
            mcpOutputSeen,
          }) => ({
            turn,
            effort,
            model,
            phase,
            totalRequests,
            llmRequests,
            mcpInitialize,
            mcpList,
            mcpCalls,
            mcpRequested,
            continuationSeen,
            toolOutputSeen,
            mcpOutputSeen,
          }),
        ),
      }
    },
    assertComplete() {
      check(!problems.length, `Fixture recorded ${problems.length} failed requests`)
      check(turns.size === 2, 'Fixture requires two registered turns')
      for (const state of turns.values()) {
        check(
          state.phase === 'completed' && state.toolOutputSeen,
          'Turn did not complete its real shell action',
        )
        check(state.mcpInitialize > 0 && state.mcpList > 0, 'Turn MCP handshake was not observed')
        check(state.mcpCalls > 0 && state.mcpOutputSeen, 'Turn MCP call was not observed')
        check(state.turn === 1 || state.continuationSeen, 'Prior session was not observed')
      }
    },
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      turns.clear()
    },
  }
}
