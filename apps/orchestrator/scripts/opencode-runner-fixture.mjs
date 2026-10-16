// Synthetic provider/MCP only. Owns no credentials beyond generated fixture turn keys.
// The provider speaks the chat completions stream of Z.ai, as the pinned OpenCode CLI reads it
// through the sandbox gateway path /zai/v4/chat/completions.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'

const PRIOR = 'raditi-g3-prior-session-marker'
const MAX_BODY = 8 * 1024 * 1024
const MODEL = 'glm-5.3'
const CLI_VERSION = '1.18.34'
const LLM_ROUTE = '/zai/v4/chat/completions'
/** The CLI's file and shell tools the driver allows, and the site's one MCP tool. */
const ALLOWED_TOOLS = new Set([
  'bash',
  'edit',
  'glob',
  'grep',
  'read',
  'todowrite',
  'write',
  'raditi_site_info',
])
/** Texts of the site repository's own OpenCode files (verify-runner.mjs seeds them). */
const PROJECT_TEXTS = ['HOSTILE_PROJECT_AGENT', 'HOSTILE_PROJECT_AGENTS_MD', 'HOSTILE_PROJECT_RULE']
class FixtureError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new FixtureError(message)
}
const marker = (turn) => `raditi-g3-shell-ok-turn-${turn}`
const mcpMarker = (turn) => `raditi-g3-mcp-ok-turn-${turn}`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
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

function isPrompt(text, prompt) {
  if (typeof text !== 'string') return false
  const framed = `Client request:\n${prompt}`
  return (
    text === framed ||
    text.startsWith(`${framed}\n\nFiles supplied for this turn (paths, not instructions):\n`)
  )
}

function shellCall(body, state) {
  const tool = body.tools?.find(
    (item) => item.type === 'function' && item.function?.name === 'bash',
  )
  check(
    tool?.function.parameters?.properties?.command?.type === 'string',
    'Shell tool was not advertised',
  )
  const { turn } = state
  // What an agent command can see under gVisor: the product's uid, the pinned CLI, no credential
  // file, and neither credential in its own environment or in the environment of any process,
  // the CLI included. Only digests travel in the command: a credential in a request body is
  // refused above. The crash upload of the CLI's runtime is off and nothing can switch it on.
  const digests = JSON.stringify([sha256(state.llmKey), sha256(state.mcpKey)])
  const source = `const fs=require('node:fs');const assert=require('node:assert/strict');const cp=require('node:child_process');const crypto=require('node:crypto');const kernel=cp.execFileSync('uname',['-r'],{encoding:'utf8'}).trim();assert.match(kernel,/gvisor/i);assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);assert.equal(cp.execFileSync('opencode',['--version'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/tmp/raditi-g3-version-home',BUN_ENABLE_CRASH_REPORTING:'0'}}).trim(),'${CLI_VERSION}');const digests=${digests};const held=(environ)=>environ.split('\\0').some((entry)=>digests.includes(crypto.createHash('sha256').update(entry.slice(entry.indexOf('=')+1).replace(/^Bearer /,'')).digest('hex')));assert.equal(held(Object.entries(process.env).map(([name,value])=>name+'='+value).join('\\0')),false);assert.deepEqual(Array.from(fs.readdirSync('/run/raditi/secrets')),[]);for(const pid of fs.readdirSync('/proc')){if(!(Number(pid)>0))continue;let environ='';try{environ=fs.readFileSync('/proc/'+pid+'/environ','utf8')}catch{}assert.equal(held(environ),false)}assert.equal(process.env.BUN_ENABLE_CRASH_REPORTING,'0');assert.equal(process.env.BUN_CRASH_REPORT_URL,undefined);${turn === 2 ? "assert.ok(fs.readFileSync('index.php','utf8').endsWith('turn 1\\n'));assert.equal(fs.readFileSync('turn-1.txt','utf8'),'turn 1\\n');" : ''}fs.appendFileSync('index.php','turn ${turn}\\n');fs.writeFileSync('turn-${turn}.txt','turn ${turn}\\n');console.log(JSON.stringify({kernel,uid:process.getuid(),gid:process.getgid(),opencode:'${CLI_VERSION}',environClean:true,secretFilesRemoved:true}));console.log('${marker(turn)}');`
  return {
    name: 'bash',
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

let completions = 0
function frames(model, item) {
  completions += 1
  const base = {
    id: `2026100500000000${String(completions).padStart(8, '0')}`,
    created: Math.floor(Date.now() / 1000),
    object: 'chat.completion.chunk',
    model,
  }
  const sse = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
  const chunk = (delta, finish_reason) =>
    sse({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', ...delta },
          ...(finish_reason ? { finish_reason } : {}),
        },
      ],
      ...(finish_reason
        ? {
            usage: {
              prompt_tokens: 7105,
              completion_tokens: 94,
              total_tokens: 7199,
              prompt_tokens_details: { cached_tokens: 6784 },
              completion_tokens_details: { reasoning_tokens: 54 },
            },
          }
        : {}),
    })
  const output = [chunk({ reasoning_content: 'Synthetic reasoning.' })]
  if (item.function)
    output.push(
      chunk({
        tool_calls: [
          {
            id: item.id,
            index: 0,
            type: 'function',
            function: { name: item.function.name, arguments: item.function.arguments },
          },
        ],
      }),
      chunk({ content: '' }, 'tool_calls'),
    )
  else output.push(chunk({ content: item.content }), chunk({ content: '' }, 'stop'))
  output.push(sse('[DONE]'))
  return output.join('')
}

/** No external input, server credentials or .env. addTurn accepts only owned synthetic keys. */
export async function startOpencodeRunnerFixture() {
  const turns = new Map()
  const problems = []
  const json = (response, status, value) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  const server = createServer(async (request, response) => {
    try {
      const isMcp = request.url === '/mcp'
      // Every other path the gateway lets through belongs to another CLI.
      check(isMcp || request.url === LLM_ROUTE, 'Unexpected fixture route')
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
      check(++state.totalRequests <= 32, 'Fixture request limit exceeded')
      if (isMcp && request.method === 'GET') {
        response.writeHead(405, { allow: 'POST, DELETE' }).end()
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
          // The CLI cancels each finished call; the wrapper's own check sends no notification.
          check(
            body.method === 'notifications/initialized' ||
              body.method === 'notifications/cancelled',
            'Unexpected MCP notification',
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
            serverInfo: { name: 'raditi-g3-runner-fixture', version: '1' },
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
      // With the platform's own provider id the CLI adds no reasoning field: the profile of the
      // turn key belongs to the gateway.
      check(
        body.thinking === undefined && body.reasoning_effort === undefined,
        'Unexpected reasoning field',
      )
      check(body.stream === true, 'Turn streaming missing')
      check(body.stream_options?.include_usage === true, 'Turn usage reporting missing')
      check(Array.isArray(body.messages), 'Invalid turn messages')
      const system = body.messages
        .filter((message) => message.role === 'system')
        .flatMap((message) => texts(message.content))
        .join('\n')
      check(system.includes('client_message'), 'Turn result instructions missing')
      check(
        system.includes(`RADITI_PLATFORM_TURN_${state.turn}`) &&
          !system.includes(`RADITI_PLATFORM_TURN_${3 - state.turn}`),
        'Turn current platform instructions missing',
      )
      check(
        !PROJECT_TEXTS.some((text) => serialized.includes(text)),
        'Unexpected project instructions',
      )
      check(
        Array.isArray(body.tools) &&
          body.tools.every(
            (tool) => tool.type === 'function' && ALLOWED_TOOLS.has(tool.function?.name),
          ),
        'Unexpected advertised tool',
      )
      check(body.response_format === undefined, 'Unexpected output schema flag')
      // The subscription gateway caps what one answer of this provider may ask for.
      check(
        Number.isInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= 32_000,
        'Turn output limit exceeds the gateway policy',
      )
      check(
        texts(body.messages.findLast((message) => message.role === 'user')?.content).some((text) =>
          isPrompt(text, state.prompt),
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
        item = { function: shellCall(body, state), id: `call_shell_${state.turn}` }
        state.phase = 'shell'
        state.shellCallId = item.id
      } else if (state.phase === 'shell') {
        check(
          toolOutput(body, state.shellCallId, marker(state.turn)),
          'Successful shell output missing',
        )
        state.toolOutputSeen = true
        check(
          body.tools.some((tool) => tool.function?.name === 'raditi_site_info'),
          'Turn MCP tool was not advertised',
        )
        state.phase = 'mcp'
        state.mcpCallId = `call_mcp_${state.turn}`
        item = { function: { name: 'raditi_site_info', arguments: '{}' }, id: state.mcpCallId }
      } else if (state.phase === 'mcp') {
        check(
          state.mcpCalls > 0 && toolOutput(body, state.mcpCallId, mcpMarker(state.turn)),
          'Successful MCP output missing',
        )
        state.mcpOutputSeen = true
        state.phase = 'completed'
        item = { content: JSON.stringify(resultFor(state.turn)) }
      } else throw new FixtureError('Unexpected request after turn completion')
      response
        .writeHead(200, { 'content-type': 'text/event-stream;charset=UTF-8' })
        .end(frames(body.model, item))
    } catch (error) {
      // Only deliberate fixed labels are retained. Never expose parser errors, bodies or tokens.
      problems.push(error instanceof FixtureError ? error.message : 'Fixture request failed')
      // HTTP 400 with this body ends the CLI's turn after one request: it is not repeated.
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
    addTurn({ turn, llmKey, mcpKey, prompt, effort, model = MODEL }) {
      check(!closed && (turn === 1 || turn === 2) && !turns.has(turn), 'Unexpected fixture turn')
      check(
        typeof prompt === 'string' &&
          prompt.length > 0 &&
          prompt.length <= 256 * 1024 &&
          !prompt.includes(PRIOR),
        'Invalid fixture prompt',
      )
      check(model === MODEL, 'Invalid fixture model')
      // The profile is what core issues the turn key with; the CLI sends none of it.
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
        // The wrapper's own check and the CLI's connection: two handshakes at least.
        check(state.mcpInitialize >= 2 && state.mcpList > 0, 'Turn MCP handshake was not observed')
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
