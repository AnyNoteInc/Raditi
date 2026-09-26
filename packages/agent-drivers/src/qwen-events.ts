import { agentOutputLimits, type AgentEvent } from '@repo/domain'

import {
  count,
  events,
  failed,
  message,
  nativeSessionId,
  object,
  optionalCount,
  parseJsonObject,
  text,
} from './jsonl.ts'

/** Qwen stream-json message envelopes; partial stream_event fragments are intentionally ignored. */
export function parseQwenEvent(line: string): AgentEvent[] {
  const row = parseJsonObject(line)
  if (!row || (row.parent_tool_use_id !== undefined && row.parent_tool_use_id !== null)) return []
  if (row.type === 'system' && (row.subtype === 'init' || row.subtype === 'session_start')) {
    const id = nativeSessionId(row.session_id)
    return id ? events({ type: 'started', nativeSessionId: id }) : []
  }
  if (row.type === 'assistant') {
    const content = object(row.message)?.content
    if (!Array.isArray(content)) return []
    return content.slice(0, 500).flatMap((value) => {
      const block = object(value)
      if (block?.type === 'text') return message(block.text)
      if (block?.type === 'tool_use' && block.name === 'run_shell_command') {
        const command = text(object(block.input)?.command, agentOutputLimits.command)
        return command === undefined ? [] : events({ type: 'command', command, exitCode: null })
      }
      return []
    })
  }
  if (row.type !== 'result' || typeof row.is_error !== 'boolean') return []
  if (row.is_error) return failed(object(row.error)?.message ?? 'Агент не смог завершить действие.')
  if (row.subtype !== 'success') return []
  const usage = object(row.usage)
  const input = count(usage?.input_tokens)
  const cacheRead = optionalCount(usage?.cache_read_input_tokens)
  const output = count(usage?.output_tokens)
  return [
    ...message(row.result),
    ...events(
      input !== undefined && cacheRead !== undefined && output !== undefined
        ? {
            type: 'usage',
            usage: {
              inputUncached: input - cacheRead,
              cacheRead,
              cacheWrite: 0,
              output,
              reasoning: 0,
            },
          }
        : undefined,
      { type: 'completed' },
    ),
  ]
}
