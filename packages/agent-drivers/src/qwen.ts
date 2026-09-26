import type { AgentDriver } from '@repo/domain'
import { notImplemented, SANDBOX_AGENT_HOME } from '@repo/domain'
import { parseAgentDriverConfig, type AgentDriverConfig } from './config.ts'

// Qwen Code (@qwen-code/qwen-code 0.24), a fallback — spec §8, §9; verified in P5.
//   qwen -p <prompt> --output-format stream-json --approval-mode yolo [--resume <id>]
//   the first event system/session_start carries session_id; `result` carries usage
//   limits: --max-wall-time, --max-session-turns, --max-tool-calls; QWEN_CODE_UNATTENDED_RETRY=1
//   HOME=/agent-home/qwen; chats in ~/.qwen/projects/<sanitized cwd>/chats, so the cwd is
//     always /workspace/repo; OpenAI-compatible models via modelProviders

const home = `${SANDBOX_AGENT_HOME}/qwen`
const todo = (method: string) => notImplemented(`qwen.${method} (P5)`)

export function createQwenDriver(config: AgentDriverConfig): AgentDriver {
  const { imagePrefix } = parseAgentDriverConfig(config)
  return {
    id: 'qwen',
    image: `${imagePrefix}-qwen`,
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    async prepare() {
      throw todo('prepare')
    },
    command() {
      throw todo('command')
    },
    parseEvent() {
      throw todo('parseEvent')
    },
    sessionState() {
      return { root: home, include: ['.qwen/projects'], exclude: [] }
    },
    extractResult() {
      throw todo('extractResult')
    },
  }
}
