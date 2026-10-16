import { agentOutputLimits, SANDBOX_WORKDIR, type AgentEvent } from '@repo/domain'

import {
  count,
  events,
  failed,
  message,
  nativeSessionId,
  object,
  parseJsonObject,
  text,
  type JsonObject,
} from './jsonl.ts'
import { platformToolName } from './opencode-mcp.ts'

// `opencode run --format json` of the pinned 1.18.34: one row per finished part.
//   step_start, text, tool_use (a tool part that is completed or failed), step_finish, error
// The CLI prints no end-of-turn row. A step that ends with `stop` is followed by more steps when
// the CLI compacts the context, and between them the CLI prints a line of its own as `text`
// outside any step; a run cut on a rejected permission request exits 0 after a `tool-calls`
// step. So `completed` here means «an answer step ended», and whether the turn has a result is
// decided over all events of the turn (extractOpencodeResult in opencode.ts).

const WORD = /^[A-Za-z]{1,40}$/
const REFUSAL_CODE = /^[a-z0-9_]{1,64}$/

/**
 * The code and the message of a refusal the gateway or the provider answered with. It reaches
 * the row as JSON text: the response body of a refused request, or the `error` object of a
 * stream. Nothing else of that text is read.
 */
function refusal(value: unknown): { code?: string; message?: string } {
  if (typeof value !== 'string' || !value.startsWith('{')) return {}
  const parsed = parseJsonObject(value)
  const body = object(parsed?.error) ?? parsed
  return {
    ...(typeof body?.code === 'string' && REFUSAL_CODE.test(body.code) ? { code: body.code } : {}),
    ...(typeof body?.message === 'string' ? { message: body.message } : {}),
  }
}

/**
 * An `error` row: APIError (a refused request, with the response body), UnknownError (an error
 * object inside the stream, as JSON in the message), ContentFilterError, ContextOverflowError.
 * The reason names the kind, the HTTP status and the refusal code for the operator; the address
 * of the gateway, response headers and the body itself stay out of it.
 */
function failure(error: JsonObject | undefined): AgentEvent[] {
  const data = object(error?.data)
  const name = typeof error?.name === 'string' && WORD.test(error.name) ? error.name : undefined
  const status = count(data?.statusCode)
  const fromBody = refusal(data?.responseBody)
  const fromStream = refusal(data?.message)
  const code = fromBody.code ?? fromStream.code
  const detail =
    fromBody.message ??
    fromStream.message ??
    (typeof data?.message === 'string' ? data.message : '')
  const head = [name, status, code].filter((part) => part !== undefined).join(' ')
  return failed([head, detail].filter((part) => part !== '').join(': '))
}

/** A path inside the working copy, relative to it; anything else is not a change of the site. */
function workspaceFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(`${SANDBOX_WORKDIR}/`)) return
  const path = value.slice(SANDBOX_WORKDIR.length + 1)
  if (
    path.length === 0 ||
    path.length > agentOutputLimits.path ||
    path.includes('\\') ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split('/').some((part) => part === '..' || part === '.' || part === '')
  )
    return
  return path
}

function toolEvents(part: JsonObject): AgentEvent[] {
  const state = object(part.state)
  const tool = text(part.tool, agentOutputLimits.tool)
  if (tool === undefined || !state || (state.status !== 'completed' && state.status !== 'error'))
    return []
  const input = object(state.input)
  // The model called a tool the CLI does not have: the CLI answers it through a tool of its own
  // named `invalid`, marked completed, and the turn goes on.
  if (tool === 'invalid')
    return events({
      type: 'tool_call',
      tool: platformToolName(text(input?.tool, agentOutputLimits.tool) || tool),
      ok: false,
    })
  const ok = state.status === 'completed'
  // Only the reported name: what a tool of the CLI itself did is read by the name of the row.
  const result = events({ type: 'tool_call', tool: platformToolName(tool), ok })
  if (tool === 'bash') {
    const command = text(input?.command, agentOutputLimits.command)
    const exitCode = object(state.metadata)?.exit
    if (command !== undefined)
      result.push(...events({ type: 'command', command, exitCode: exitCode ?? null }))
  }
  if (ok && (tool === 'write' || tool === 'edit')) {
    const path = workspaceFile(input?.filePath)
    // `write` says whether the file was there before; `edit` only changes an existing file.
    const created = tool === 'write' && object(state.metadata)?.exists === false
    if (path !== undefined)
      result.push(...events({ type: 'file_change', path, change: created ? 'add' : 'update' }))
  }
  return result
}

export function parseOpencodeEvent(line: string): AgentEvent[] {
  const row = parseJsonObject(line)
  if (!row) return []
  const part = object(row.part)
  if (row.type === 'error') return failure(object(row.error))
  if (row.type === 'step_start') {
    const id = nativeSessionId(row.sessionID)
    return id ? events({ type: 'started', nativeSessionId: id }) : []
  }
  if (row.type === 'text' && part?.type === 'text') return message(part.text)
  if (row.type === 'tool_use' && part?.type === 'tool') return toolEvents(part)
  if (row.type !== 'step_finish' || part?.type !== 'step-finish') return []
  const tokens = object(part.tokens)
  const cache = object(tokens?.cache)
  const inputUncached = count(tokens?.input)
  const cacheRead = count(cache?.read)
  const cacheWrite = count(cache?.write)
  const output = count(tokens?.output)
  const reasoning = count(tokens?.reasoning)
  const result = events(
    inputUncached !== undefined &&
      cacheRead !== undefined &&
      cacheWrite !== undefined &&
      output !== undefined &&
      reasoning !== undefined
      ? // OpenCode getUsage subtracts reasoning from output; the common schema includes it.
        {
          type: 'usage',
          usage: { inputUncached, cacheRead, cacheWrite, output: output + reasoning, reasoning },
        }
      : undefined,
  )
  if (part.reason === 'stop') result.push(...events({ type: 'completed' }))
  // `tool-calls` goes on to the next step. Every other reason ends the answer without a result:
  // `length` cut it, `content-filter` blocked it, and `unknown` is what the CLI writes — and
  // repeats at once — for a stream without a finish reason it knows.
  else if (typeof part.reason === 'string' && part.reason !== 'tool-calls')
    result.push(
      ...failed(
        /^[a-z-]{1,32}$/.test(part.reason)
          ? `OpenCode step ended with reason ${part.reason}`
          : 'OpenCode step ended with an unexpected reason',
      ),
    )
  return result
}
