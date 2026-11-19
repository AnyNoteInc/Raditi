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
/**
 * Texts of the OpenCode files a site repository of verify-runner.mjs held until plan 83 took the
 * repositories of its turns away: none may reach a request still (the repository of a project of
 * plan 84 holds none of them).
 */
const PROJECT_TEXTS = ['HOSTILE_PROJECT_AGENT', 'HOSTILE_PROJECT_AGENTS_MD', 'HOSTILE_PROJECT_RULE']
class FixtureError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new FixtureError(message)
}
const marker = (turn) => `raditi-g3-shell-ok-turn-${turn}`
const mcpMarker = (turn) => `raditi-g3-mcp-ok-turn-${turn}`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const rewindResult = (answer) => ({
  summary: 'Синтетический ход без репозитория',
  change_type: 'none',
  client_message: answer,
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
})
const inboxResult = (answer) => ({
  summary: 'Синтетический ход с файлом клиента',
  change_type: 'none',
  client_message: answer,
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
})
const repositoryResult = (answer, files) => ({
  summary: 'Синтетический ход чата проекта с репозиторием',
  change_type: files.length ? 'code' : 'none',
  client_message: answer,
  files_changed: files,
  questions: [],
  needs_approval: false,
  risk: 'low',
})
/** What the shell command of a repository turn prints for the first check it failed. */
const FAILED_CHECK = /raditi-check-failed:([a-z0-9-]{1,40})/
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
  // file — of the secrets only the script bash sources before each command, which the wrapper
  // writes on every turn (spec §20, «Инструменты песочницы», ИП4) —, and neither credential in
  // its own environment or in the environment of any process, the CLI included. Only digests
  // travel in the command: a credential in a request body is refused above. The crash upload of
  // the CLI's runtime is off and nothing can switch it on.
  // The working copy of a chat without a repository starts empty at every turn (rule 5): what the
  // first turn wrote there is gone in the second, which goes on from the session alone.
  const digests = JSON.stringify([sha256(state.llmKey), sha256(state.mcpKey)])
  const source = `const fs=require('node:fs');const assert=require('node:assert/strict');const cp=require('node:child_process');const crypto=require('node:crypto');const kernel=cp.execFileSync('uname',['-r'],{encoding:'utf8'}).trim();assert.match(kernel,/gvisor/i);assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);assert.equal(cp.execFileSync('opencode',['--version'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/tmp/raditi-g3-version-home',BUN_ENABLE_CRASH_REPORTING:'0'}}).trim(),'${CLI_VERSION}');const digests=${digests};const held=(environ)=>environ.split('\\0').some((entry)=>digests.includes(crypto.createHash('sha256').update(entry.slice(entry.indexOf('=')+1).replace(/^Bearer /,'')).digest('hex')));assert.equal(held(Object.entries(process.env).map(([name,value])=>name+'='+value).join('\\0')),false);assert.deepEqual(Array.from(fs.readdirSync('/run/raditi/secrets')),['shell-env.sh']);for(const pid of fs.readdirSync('/proc')){if(!(Number(pid)>0))continue;let environ='';try{environ=fs.readFileSync('/proc/'+pid+'/environ','utf8')}catch{}assert.equal(held(environ),false)}assert.equal(process.env.BUN_ENABLE_CRASH_REPORTING,'0');assert.equal(process.env.BUN_CRASH_REPORT_URL,undefined);${turn === 2 ? "assert.equal(fs.existsSync('index.php'),false);assert.equal(fs.existsSync('turn-1.txt'),false);" : ''}fs.appendFileSync('index.php','turn ${turn}\\n');fs.writeFileSync('turn-${turn}.txt','turn ${turn}\\n');console.log(JSON.stringify({kernel,uid:process.getuid(),gid:process.getgid(),opencode:'${CLI_VERSION}',environClean:true,secretFilesRemoved:true}));console.log('${marker(turn)}');`
  return {
    name: 'bash',
    arguments: JSON.stringify({
      command: `node -e '${source.replaceAll("'", "'\\''")}'`,
      description: 'Synthetic runner file change',
    }),
  }
}

/**
 * The turn of a chat of a project with a repository (docs/plan/84-projects.md, ПР12): its one
 * shell command is the stand's — it checks /workspace/repo and /workspace/project, makes the
 * turn's change and prints the marker of the turn last; a check that fails prints its name
 * (FAILED_CHECK) and stops.
 */
function repositoryShellCall(body, state) {
  const tool = body.tools?.find(
    (item) => item.type === 'function' && item.function?.name === 'bash',
  )
  check(Boolean(tool), 'Shell tool was not advertised')
  const command = `${state.repository.command}\necho ${marker(state.turn)}`
  return {
    name: 'bash',
    arguments: JSON.stringify({ command, description: 'Synthetic repository change' }),
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
      if (state.compaction) {
        // The summary of a session (docs/plan/61-chats-first.md, §5.14): no tool, no instructions
        // of the platform, and the history it is there to replace.
        check(state.phase === 'initial', 'Unexpected request after turn completion')
        check(body.tools === undefined, 'A compaction was offered tools')
        check(
          state.compaction.remembered.every((text) => serialized.includes(text)),
          'The compaction lost words of the session',
        )
        state.phase = 'completed'
        response
          .writeHead(200, { 'content-type': 'text/event-stream;charset=UTF-8' })
          .end(frames(body.model, { content: state.compaction.summary }))
        return
      }
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
      if (state.turn === 2 && !state.rewind && !state.repository && !state.inbox) {
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
      if (state.inbox) {
        // The CLI is told where the file is, reads it with its own tool, and gets its bytes.
        if (state.phase === 'initial') {
          check(serialized.includes(state.inbox.path), 'The turn was not told where the file is')
          check(!serialized.includes(state.inbox.words), 'The file came with the words of the turn')
          state.phase = 'shell'
          state.shellCallId = `call_inbox_${state.turn}`
          item = {
            function: {
              name: 'read',
              arguments: JSON.stringify({ filePath: state.inbox.path }),
            },
            id: state.shellCallId,
          }
        } else {
          check(state.phase === 'shell', 'Unexpected request after turn completion')
          check(
            toolOutput(body, state.shellCallId, state.inbox.words),
            'The file of the client did not reach the agent',
          )
          state.toolOutputSeen = true
          state.phase = 'completed'
          item = { content: JSON.stringify(inboxResult(state.inbox.answer)) }
        }
      } else if (state.rewind) {
        // What the session behind this request holds: the stand asks it of each turn of its chat.
        const { todos } = state.rewind
        check(
          state.phase === 'initial' || (todos && state.phase === 'todo'),
          'Unexpected request after turn completion',
        )
        check(
          state.rewind.remembered.every((text) => serialized.includes(text)),
          'The restored session lost words of an earlier turn',
        )
        check(
          !state.rewind.forgotten.some((text) => serialized.includes(text)),
          'The words of an undone turn reached the provider',
        )
        if (todos && state.phase === 'initial') {
          // The agent's to-do list first (docs/plan/87-agent-todos.md, 87.6): the CLI's own tool.
          check(
            body.tools.some((tool) => tool.function?.name === 'todowrite'),
            'The to-do tool was not advertised',
          )
          state.phase = 'todo'
          state.todoCallId = `call_todo_${state.turn}`
          item = {
            function: { name: 'todowrite', arguments: JSON.stringify({ todos }) },
            id: state.todoCallId,
          }
        } else {
          if (todos) {
            check(
              toolOutput(body, state.todoCallId, todos[0].content),
              'The to-do list did not come back to the model',
            )
            state.toolOutputSeen = true
          }
          state.phase = 'completed'
          item = { content: JSON.stringify(rewindResult(state.rewind.answer)) }
        }
      } else if (state.repository) {
        // The session behind this request, as for a turn without a repository, and its one command.
        check(
          state.repository.remembered.every((text) => serialized.includes(text)),
          'The restored session lost words of an earlier turn',
        )
        if (state.phase === 'initial') {
          state.phase = 'shell'
          state.shellCallId = `call_repo_${state.repository.id}_${state.turn}`
          item = { function: repositoryShellCall(body, state), id: state.shellCallId }
        } else {
          check(state.phase === 'shell', 'Unexpected request after turn completion')
          if (!toolOutput(body, state.shellCallId, marker(state.turn))) {
            // The name of the check the command printed, a fixed word of the stand: never output.
            const failed = body.messages
              .filter(
                (message) => message.role === 'tool' && message.tool_call_id === state.shellCallId,
              )
              .flatMap((message) => texts(message.content))
              .map((text) => FAILED_CHECK.exec(text)?.[1])
              .find(Boolean)
            throw new FixtureError(
              `The working copy is not the one the turn starts from${failed ? ` (${failed})` : ''}`,
            )
          }
          state.toolOutputSeen = true
          state.phase = 'completed'
          item = {
            content: JSON.stringify(
              repositoryResult(state.repository.answer, state.repository.files),
            ),
          }
        }
      } else if (state.phase === 'initial') {
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
  const assertRotated = (llmKey, mcpKey) => {
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
  }
  const freshTurn = (identity) => ({
    ...identity,
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
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    resultFor,
    /**
     * One turn of the chat without a repository whose last request is undone
     * (docs/plan/61-chats-first.md, §5.14): no tool, an answer, and the check of what its session
     * held — `remembered` must stand in the request and `forgotten` must not, or the request is
     * refused and the turn fails. No turn of the chat with the repository is one of these. With
     * `todos` the model first writes that to-do list with the CLI's `todowrite`
     * (docs/plan/87-agent-todos.md, 87.6) and answers once the list came back to it.
     */
    addRewindTurn({ turn, llmKey, mcpKey, prompt, effort, answer, remembered, forgotten, todos }) {
      const key = `rewind-${turn}`
      check(!closed && Number.isInteger(turn) && !turns.has(key), 'Unexpected rewind turn')
      check(
        [prompt, answer, ...remembered, ...forgotten].every(
          (text) => typeof text === 'string' && text.length > 0,
        ),
        'Invalid rewind turn',
      )
      check(
        todos === undefined ||
          (Array.isArray(todos) &&
            todos.length > 0 &&
            todos.every(
              (item) =>
                typeof item?.content === 'string' &&
                item.content.length > 0 &&
                ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) &&
                ['high', 'medium', 'low'].includes(item.priority),
            )),
        'Invalid rewind turn',
      )
      check(effort === (turn === 1 ? 'low' : 'high'), 'Invalid fixture effort')
      assertRotated(llmKey, mcpKey)
      turns.set(key, {
        ...freshTurn({ turn, llmKey, mcpKey, prompt, effort, model: MODEL }),
        rewind: { answer, remembered, forgotten, ...(todos ? { todos } : {}) },
      })
      return rewindResult(answer)
    },
    /**
     * One turn of a chat of a project with a repository (docs/plan/84-projects.md, ПР12): what its
     * session held — `remembered` must stand in each request —, its one shell command `command`
     * (the stand's checks of the working copy and the files of the project, and its change), then
     * an answer that names `files`.
     */
    addRepositoryTurn({
      id,
      turn,
      llmKey,
      mcpKey,
      prompt,
      effort,
      answer,
      command,
      files,
      remembered = [],
    }) {
      const key = `repository-${id}-${turn}`
      check(!closed && Number.isInteger(turn) && !turns.has(key), 'Unexpected repository turn')
      check(
        [id, prompt, answer, command, ...remembered].every(
          (text) => typeof text === 'string' && text.length > 0,
        ),
        'Invalid repository turn',
      )
      check(
        Array.isArray(files) && files.every((file) => typeof file === 'string' && file.length > 0),
        'Invalid repository turn',
      )
      check(effort === (turn === 1 ? 'low' : 'high'), 'Invalid fixture effort')
      assertRotated(llmKey, mcpKey)
      turns.set(key, {
        ...freshTurn({ turn, llmKey, mcpKey, prompt, effort, model: MODEL }),
        repository: { id, answer, command, files, remembered },
      })
      return repositoryResult(answer, files)
    },
    /**
     * The turn of a chat without a project that holds a file of the client (docs/plan/61-chats-first.md,
     * К16): its CLI reads `path`, and only its tool answer may bring `words` to the provider.
     */
    addInboxTurn({ turn, llmKey, mcpKey, prompt, effort, path, words, answer }) {
      const key = `inbox-${turn}`
      check(!closed && Number.isInteger(turn) && !turns.has(key), 'Unexpected inbox turn')
      check(
        [prompt, path, words, answer].every((text) => typeof text === 'string' && text.length > 0),
        'Invalid inbox turn',
      )
      check(effort === (turn === 1 ? 'low' : 'high'), 'Invalid fixture effort')
      assertRotated(llmKey, mcpKey)
      turns.set(key, {
        ...freshTurn({ turn, llmKey, mcpKey, prompt, effort, model: MODEL }),
        inbox: { path, words, answer },
      })
    },
    /** The turn that compacts that chat's session: its one request is answered with `summary`. */
    addCompactionTurn({ turn, llmKey, mcpKey, prompt, effort, summary, remembered }) {
      const key = `compaction-${turn}`
      check(!closed && Number.isInteger(turn) && !turns.has(key), 'Unexpected compaction turn')
      check(effort === 'high', 'Invalid fixture effort')
      assertRotated(llmKey, mcpKey)
      turns.set(key, {
        ...freshTurn({ turn, llmKey, mcpKey, prompt, effort, model: MODEL }),
        compaction: { summary, remembered },
      })
    },
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
      assertRotated(llmKey, mcpKey)
      turns.set(turn, freshTurn({ turn, llmKey, mcpKey, prompt, effort, model }))
      return resultFor(turn)
    },
    observations() {
      return {
        problems: [...problems],
        turns: [...turns.values()].map(
          ({
            rewind,
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
            ...(rewind ? { rewind: true } : {}),
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
      const planned = [...turns.values()].filter(
        (state) => !state.rewind && !state.compaction && !state.repository && !state.inbox,
      )
      check(planned.length === 2, 'Fixture requires two registered turns')
      for (const state of planned) {
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
    /** Every compaction so far: its one request, and no tool. */
    assertCompacted() {
      for (const state of [...turns.values()].filter((item) => item.compaction))
        check(
          state.phase === 'completed' && state.llmRequests === 1 && state.mcpList === 0,
          'A compaction did not answer its one request, or reached for the tools',
        )
    },
    /** The turn with a file of the client: it read the file and answered, nothing else. */
    assertInboxComplete() {
      check(!problems.length, `Fixture recorded ${problems.length} failed requests`)
      const read = [...turns.values()].filter((item) => item.inbox)
      check(read.length === 1, 'Fixture has not the turn with a file')
      check(
        read[0].phase === 'completed' && read[0].toolOutputSeen && read[0].llmRequests === 2,
        'The turn with a file did not read it and answer',
      )
    },
    /** The turns of a chat with a repository: their one command and their answer, nothing else. */
    assertRepositoryComplete(id, count) {
      check(!problems.length, `Fixture recorded ${problems.length} failed requests`)
      const chat = [...turns.values()].filter((item) => item.repository?.id === id)
      check(chat.length === count, 'Fixture has not the turns of this chat')
      for (const state of chat)
        check(
          state.phase === 'completed' && state.toolOutputSeen && state.llmRequests === 2,
          'A turn of the chat did not run its one command and answer',
        )
    },
    /**
     * The turns of the chat without a repository, each answered once by a checked request; one
     * with a to-do list, after the request its list came back in.
     */
    assertRewindComplete(count = 3) {
      check(!problems.length, `Fixture recorded ${problems.length} failed requests`)
      const rewound = [...turns.values()].filter((state) => state.rewind)
      check(rewound.length === count, 'Fixture requires three turns without a repository')
      this.assertCompacted()
      for (const state of rewound)
        check(
          state.phase === 'completed' &&
            (state.rewind.todos
              ? state.llmRequests === 2 && state.toolOutputSeen
              : state.llmRequests === 1),
          'A turn without a repository did not answer its one request',
        )
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
