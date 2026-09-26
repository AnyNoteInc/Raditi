import { agentOutputLimits, SANDBOX_WORKDIR, type AgentEvent } from '@repo/domain'

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

/** codex exec JSONL, pinned upstream shape: see fixtures/README.md. Stateless across runs. */
export function parseCodexEvent(line: string): AgentEvent[] {
  const row = parseJsonObject(line)
  if (!row) return []
  if (row.type === 'thread.started') {
    const id = nativeSessionId(row.thread_id)
    return id ? events({ type: 'started', nativeSessionId: id }) : []
  }
  if (row.type === 'turn.failed') return failed(object(row.error)?.message)
  if (row.type === 'error') return failed(row.message)
  if (row.type === 'turn.completed') {
    const usage = object(row.usage)
    const input = count(usage?.input_tokens)
    const cacheRead = optionalCount(usage?.cached_input_tokens)
    const cacheWrite = optionalCount(usage?.cache_write_input_tokens)
    const output = count(usage?.output_tokens)
    const reasoning = optionalCount(usage?.reasoning_output_tokens)
    return events(
      input !== undefined &&
        cacheRead !== undefined &&
        cacheWrite !== undefined &&
        output !== undefined &&
        reasoning !== undefined &&
        reasoning <= output
        ? {
            type: 'usage',
            usage: {
              inputUncached: input - cacheRead - cacheWrite,
              cacheRead,
              cacheWrite,
              output,
              reasoning,
            },
          }
        : undefined,
      { type: 'completed' },
    )
  }
  const item = object(row.item)
  if (!item || row.type !== 'item.completed') return []
  if (item.type === 'agent_message') return message(item.text)
  if (item.type === 'command_execution') {
    const command = text(item.command, agentOutputLimits.command)
    if (
      command === undefined ||
      (item.status !== 'completed' && item.status !== 'failed' && item.status !== 'declined')
    )
      return []
    return events({ type: 'command', command, exitCode: item.exit_code })
  }
  if (item.type === 'mcp_tool_call' || item.type === 'collab_tool_call') {
    const tool = text(item.tool, agentOutputLimits.tool)
    if (tool === undefined || (item.status !== 'completed' && item.status !== 'failed')) return []
    return events({ type: 'tool_call', tool, ok: item.status === 'completed' })
  }
  if (item.type === 'file_change' && item.status === 'completed' && Array.isArray(item.changes)) {
    return events(
      ...item.changes.slice(0, 500).flatMap((change) => {
        const entry = object(change)
        if (typeof entry?.path !== 'string') return []
        const path = entry.path.startsWith(`${SANDBOX_WORKDIR}/`)
          ? entry.path.slice(SANDBOX_WORKDIR.length + 1)
          : entry.path
        if (
          path.length === 0 ||
          path.length > agentOutputLimits.path ||
          path.startsWith('/') ||
          path.includes('\\') ||
          [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
          path.split('/').some((part) => part === '..' || part === '.' || part === '')
        )
          return []
        return [{ type: 'file_change', path, change: entry.kind }]
      }),
    )
  }
  // Reasoning, todo updates and non-fatal item errors are not client messages or turn failures.
  return []
}
