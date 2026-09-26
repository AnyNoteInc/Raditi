import { agentOutputLimits, type AgentEvent } from '@repo/domain'

import { events, message, nativeSessionId, object, parseJsonObject, text } from './jsonl.ts'

/** Kimi 2.1 print JSONL carries neither usage nor an authoritative terminal event. */
export function parseKimiEvent(line: string): AgentEvent[] {
  const row = parseJsonObject(line)
  if (!row) return []
  if (row.role === 'meta' && row.type === 'session.resume_hint') {
    const id = nativeSessionId(row.session_id)
    return id ? events({ type: 'started', nativeSessionId: id }) : []
  }
  if (row.role !== 'assistant') return []
  const result = message(row.content)
  for (const value of Array.isArray(row.tool_calls) ? row.tool_calls.slice(0, 100) : []) {
    const call = object(value)
    const fn = object(call?.function)
    if (call?.type !== 'function' || typeof fn?.arguments !== 'string') continue
    const args = parseJsonObject(fn.arguments)
    if (!args) continue
    if (fn.name === 'Bash') {
      const command = text(args.command, agentOutputLimits.command)
      if (command !== undefined)
        result.push(...events({ type: 'command', command, exitCode: null }))
    }
    if (fn.name === 'AskUserQuestion' && Array.isArray(args.questions)) {
      for (const item of args.questions.slice(0, agentOutputLimits.questions)) {
        const question = object(item)
        const questionText = text(question?.question, agentOutputLimits.questionText)
        if (questionText === undefined || !Array.isArray(question?.options)) continue
        const options = question.options
          .slice(0, agentOutputLimits.questionOptions)
          .flatMap((option) => {
            const label = text(object(option)?.label, agentOutputLimits.questionOption)
            return label === undefined ? [] : [label]
          })
        result.push(...events({ type: 'question', text: questionText, options }))
      }
    }
  }
  // The role=tool line contains only call id + output, no tool name or reliable success flag.
  // Do not invent a successful tool_call, or retain a cross-run mutable id→tool map.
  return result.slice(0, 500)
}
