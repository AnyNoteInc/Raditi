// Synthetic provider/MCP only. Owns no credentials beyond generated fixture turn keys.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'

const PRIOR = 'raditi-p4-prior-session-marker'
const MAX_BODY = 8 * 1024 * 1024
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const marker = (turn) => `raditi-p4-shell-ok-turn-${turn}`
const mcpMarker = (turn) => `raditi-p4-mcp-ok-turn-${turn}`
const resultFor = (turn) => ({
  summary: turn === 1 ? PRIOR : 'Синтетический второй ход после восстановления сессии',
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: ['index.php', `turn-${turn}.txt`],
  questions: [],
  needs_approval: false,
  risk: 'low',
})

function declarations(body) {
  return [
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter((item) => item.type === 'additional_tools')
      .flatMap((item) => item.tools ?? []),
  ]
    .flatMap((tool) =>
      tool.type === 'namespace'
        ? (tool.tools ?? []).map((nested) => ({ ...nested, namespace: tool.name }))
        : [tool],
    )
    .map((tool) => (tool.function ? { ...tool.function, namespace: tool.namespace } : tool))
}

function shellCall(body, turn) {
  // What an agent command can see: no credential in its own environment and no credential file.
  // The Codex CLI keeps both keys in the environment of its own processes for the whole turn
  // (env_key, bearer_token_env_var), so /proc/<pid>/environ of the CLI is deliberately not
  // claimed to be clean: the proof states only what holds.
  const source = `const fs=require('node:fs');const assert=require('node:assert/strict');const cp=require('node:child_process');const kernel=cp.execFileSync('uname',['-r'],{encoding:'utf8'}).trim();assert.match(kernel,/gvisor/i);assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);assert.equal(cp.execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),'codex-cli 0.158.0');assert.equal(process.env.RADITI_LLM_TOKEN,undefined);assert.equal(process.env.RADITI_MCP_TOKEN,undefined);assert.equal(fs.existsSync('/run/raditi/secrets/llm'),false);assert.equal(fs.existsSync('/run/raditi/secrets/mcp'),false);${turn === 2 ? "assert.ok(fs.readFileSync('index.php','utf8').endsWith('turn 1\\n'));assert.equal(fs.readFileSync('turn-1.txt','utf8'),'turn 1\\n');" : ''}fs.appendFileSync('index.php','turn ${turn}\\n');fs.writeFileSync('turn-${turn}.txt','turn ${turn}\\n');console.log(JSON.stringify({kernel,uid:process.getuid(),gid:process.getgid(),codex:'0.158.0',childEnvFiltered:true,secretFilesRemoved:true}));console.log('${marker(turn)}');`
  const cmd = `node -e '${source.replaceAll("'", "'\\''")}'`
  const tools = declarations(body)
  const tool = tools.find((item) =>
    /(^|\.)(exec_command|shell_command|shell|bash)$/i.test(item.name),
  )
  const custom =
    !tool &&
    tools.find(
      (item) =>
        item.type === 'custom' &&
        item.name === 'exec' &&
        item.description?.includes('tools.exec_command('),
    )
  check(tool || custom, 'Shell tool was not advertised')
  const chosen = tool || custom
  const properties = tool?.parameters?.properties ?? {}
  const key = Object.hasOwn(properties, 'cmd') ? 'cmd' : 'command'
  const args = {
    [key]: properties[key]?.type === 'array' ? ['sh', '-c', cmd] : cmd,
    ...(Object.hasOwn(properties, 'description')
      ? { description: 'Synthetic runner file change' }
      : {}),
  }
  return {
    type: custom ? 'custom_tool_call' : 'function_call',
    name: chosen.name,
    ...(chosen.namespace ? { namespace: chosen.namespace } : {}),
    [custom ? 'input' : 'arguments']: custom
      ? `text(await tools.exec_command(${JSON.stringify({ cmd })}))`
      : JSON.stringify(args),
  }
}

function toolOutput(body, callId, text) {
  return (body.input ?? []).some(
    (item) =>
      ['function_call_output', 'custom_tool_call_output'].includes(item.type) &&
      item.call_id === callId &&
      JSON.stringify(item.output).includes(text),
  )
}

function frames(model, item) {
  const event = (type, payload) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  const response = {
    id: `resp_${randomUUID()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'in_progress',
    output: [],
  }
  const output = [event('response.created', { response })]
  if (item.type === 'message') {
    const part = item.content[0]
    output.push(
      event('response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      }),
      event('response.content_part.added', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: '' },
      }),
      event('response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: part.text,
      }),
      event('response.output_text.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: part.text,
      }),
      event('response.content_part.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part,
      }),
    )
  } else {
    const custom = item.type === 'custom_tool_call'
    const payload = custom ? 'input' : 'arguments'
    const prefix = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments'
    output.push(
      event('response.output_item.added', {
        output_index: 0,
        item: { ...item, [payload]: '', status: 'in_progress' },
      }),
      event(`${prefix}.delta`, { item_id: item.id, output_index: 0, delta: item[payload] }),
      event(`${prefix}.done`, { item_id: item.id, output_index: 0, [payload]: item[payload] }),
    )
  }
  output.push(
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', {
      response: {
        ...response,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 120,
        },
      },
    }),
  )
  return output.join('')
}

/** No external input, server credentials or .env. addTurn accepts only owned synthetic keys. */
export async function startCodexRunnerFixture() {
  const turns = new Map()
  const problems = []
  const json = (response, status, value) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/disabled/')) {
        response.writeHead(403).end()
        return
      }
      const isMcp = request.url === '/mcp'
      check(isMcp || request.url === '/codex/responses', 'Unexpected fixture route')
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
        throw new Error('Invalid fixture JSON')
      }
      const serialized = JSON.stringify(body)
      check(
        ![...turns.values()].some((item) =>
          [item.llmKey, item.mcpKey].some((key) => serialized.includes(key)),
        ),
        'Credential entered a request body',
      )
      if (isMcp) {
        if (body.id === undefined) {
          response.writeHead(202).end()
          return
        }
        let result
        if (body.method === 'initialize') {
          state.mcpInitialize++
          result = {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'raditi-p4-runner-fixture', version: '1' },
          }
        } else if (body.method === 'tools/list') {
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
          check(body.params?.name === 'site_info', 'Unexpected synthetic MCP tool')
          state.mcpCalls++
          result = { content: [{ type: 'text', text: mcpMarker(state.turn) }], isError: false }
        } else {
          json(response, 200, {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Unknown synthetic method' },
          })
          return
        }
        json(response, 200, { jsonrpc: '2.0', id: body.id, result })
        return
      }
      state.llmRequests++
      check(body.model === state.model, 'Wrong model profile')
      check(body.reasoning?.effort === state.effort, 'Wrong reasoning profile')
      check(
        body.text?.format?.type === 'json_schema' &&
          body.text.format.schema?.properties?.client_message,
        'Turn output schema missing',
      )
      check(serialized.includes(JSON.stringify(state.prompt).slice(1, -1)), 'Turn prompt missing')
      // A resumed session must carry the instructions of this turn, not only those in history.
      check(
        serialized.includes(`RADITI_PLATFORM_TURN_${state.turn}`),
        'Turn current platform instructions missing',
      )
      if (state.turn === 2) {
        check(serialized.includes(PRIOR), 'Prior session marker missing')
        state.continuationSeen = true
      }
      let item
      if (state.phase === 'initial') {
        item = shellCall(body, state.turn)
        state.phase = 'shell'
        state.shellCallId = `call_shell_${state.turn}`
        item.call_id = state.shellCallId
      } else if (state.phase === 'shell') {
        check(
          toolOutput(body, state.shellCallId, marker(state.turn)),
          'Successful shell output missing',
        )
        state.toolOutputSeen = true
        const mcp = declarations(body).find((tool) => /(^|[_.])site_info$/.test(tool.name))
        if (mcp) {
          state.phase = 'mcp'
          state.mcpRequested = true
          state.mcpCallId = `call_mcp_${state.turn}`
          item = {
            type: 'function_call',
            name: mcp.name,
            ...(mcp.namespace ? { namespace: mcp.namespace } : {}),
            arguments: '{}',
            call_id: state.mcpCallId,
          }
        }
      } else if (state.phase === 'mcp') {
        check(
          state.mcpCalls > 0 && toolOutput(body, state.mcpCallId, mcpMarker(state.turn)),
          'Successful MCP output missing',
        )
      } else throw new Error('Unexpected request after turn completion')
      if (!item) {
        state.phase = 'completed'
        item = {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify(resultFor(state.turn)),
              annotations: [],
              logprobs: [],
            },
          ],
        }
      }
      item = { ...item, id: `item_${randomUUID()}`, status: 'completed' }
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames(body.model, item))
    } catch (error) {
      // Every deliberate error above is a fixed label. Parser and runtime errors are not logged.
      problems.push(
        error instanceof Error &&
          /^(Unexpected|Wrong|Turn|Prior|Successful|Fixture|Shell|Credential|Invalid) /.test(
            error.message,
          )
          ? error.message
          : 'Fixture request failed',
      )
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
    addTurn({ turn, llmKey, mcpKey, prompt, effort, model = 'gpt-6-sol' }) {
      check(!closed && (turn === 1 || turn === 2) && !turns.has(turn), 'Unexpected fixture turn')
      check(
        typeof prompt === 'string' &&
          prompt.length > 0 &&
          prompt.length <= 256 * 1024 &&
          !prompt.includes(PRIOR),
        'Invalid fixture prompt',
      )
      check(
        typeof model === 'string' && /^[a-z0-9._-]{1,100}$/i.test(model),
        'Invalid fixture model',
      )
      check(
        ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort),
        'Invalid fixture effort',
      )
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
        check(!state.mcpRequested || state.mcpCalls > 0, 'Turn MCP call was not observed')
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
