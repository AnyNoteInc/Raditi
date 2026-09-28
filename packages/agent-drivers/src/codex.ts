import type { AgentDriver } from '@repo/domain'
import { notImplemented, SANDBOX_AGENT_HOME } from '@repo/domain'
import { parseAgentDriverConfig, type AgentDriverConfig } from './config.ts'
import { parseCodexEvent } from './codex-events.ts'
import { extractJsonResult } from './jsonl.ts'

// Codex CLI (@openai/codex), the main driver — spec §8, §9; verified in P4.
//   codex exec --json --output-schema <file> -o <last-message file> <prompt>
//   resume: codex exec resume <thread_id>; flag order before or after `resume` differs
//     between the docs and the SDK — check in P4
//   --dangerously-bypass-approvals-and-sandbox: the container is the sandbox
//   never --ephemeral: the rollout file in $CODEX_HOME/sessions is the session
//   `-p` is --profile, not a prompt
//   config.toml: wire_api = "responses" (chat was removed), check_for_update_on_startup = false,
//     [analytics] enabled = false; Cloud.ru and GigaChat go through the LiteLLM /responses bridge

const home = `${SANDBOX_AGENT_HOME}/codex`
const todo = (method: string) => notImplemented(`codex.${method} (P4)`)

export function createCodexDriver(config: AgentDriverConfig): AgentDriver {
  const { imagePrefix } = parseAgentDriverConfig(config)
  return {
    id: 'codex',
    image: `${imagePrefix}-codex`,
    capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: true, images: true },
    async prepare() {
      throw todo('prepare')
    },
    command() {
      throw todo('command')
    },
    parseEvent: parseCodexEvent,
    sessionState() {
      // CODEX_HOME=/agent-home/codex; sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl
      return { root: home, include: ['sessions'], exclude: [] }
    },
    extractResult: extractJsonResult,
  }
}
