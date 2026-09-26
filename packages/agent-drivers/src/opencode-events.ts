import { agentOutputLimits, type AgentEvent } from '@repo/domain'

import {
  count,
  events,
  failed,
  message,
  nativeSessionId,
  object,
  parseJsonObject,
  text,
} from './jsonl.ts'

/** OpenCode run --format json. A step ending in tool-calls is not a completed turn. */
export function parseOpencodeEvent(line: string): AgentEvent[] {
  const row = parseJsonObject(line)
  if (!row) return []
  const part = object(row.part)
  if (row.type === 'error')
    return failed(object(object(row.error)?.data)?.message ?? object(row.error)?.name)
  if (row.type === 'step_start') {
    const id = nativeSessionId(row.sessionID)
    return id ? events({ type: 'started', nativeSessionId: id }) : []
  }
  if (row.type === 'text' && part?.type === 'text') return message(part.text)
  if (row.type === 'tool_use' && part?.type === 'tool') {
    const state = object(part.state)
    const tool = text(part.tool, agentOutputLimits.tool)
    if (tool === undefined || !state || (state.status !== 'completed' && state.status !== 'error'))
      return []
    const result = events({ type: 'tool_call', tool, ok: state.status === 'completed' })
    if (tool === 'bash') {
      const command = text(object(state.input)?.command, agentOutputLimits.command)
      const exitCode = object(state.metadata)?.exit
      if (command !== undefined)
        result.push(...events({ type: 'command', command, exitCode: exitCode ?? null }))
    }
    return result
  }
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
  if (part.reason === 'error' || part.reason === 'length' || part.reason === 'content-filter') {
    result.push(...failed('Агент не смог завершить действие.'))
  }
  return result
}
