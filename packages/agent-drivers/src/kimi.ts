import type { AgentDriver } from '@repo/domain'
import { notImplemented, SANDBOX_AGENT_HOME } from '@repo/domain'
import { parseAgentDriverConfig, type AgentDriverConfig } from './config.ts'
import { extractJsonResult } from './jsonl.ts'
import { parseKimiEvent } from './kimi-events.ts'
import { KIMI_WORKDIR_KEY, requireNativeSessionId } from './session-paths.ts'

// Kimi Code CLI (@moonshot-ai/kimi-code 2.1), the second driver — spec §8, §9; verified in P5.
//   kimi -p <prompt> --output-format stream-json [--session <id>]
//   never -p with --yolo, --auto or --plan: -p already runs in auto mode
//   KIMI_CODE_HOME=/agent-home/kimi; sessions/<workDirKey>/<sessionId>/ and session_index.jsonl,
//     workDirKey derives from the cwd, so the cwd is always /workspace/repo
//   model via KIMI_MODEL_NAME, KIMI_MODEL_BASE_URL, KIMI_MODEL_PROVIDER_TYPE=openai and
//     KIMI_MODEL_API_KEY — the per-turn LiteLLM key, so it goes only through PreparedRun.secrets
//     (a tmpfs file the wrapper exports) or the env of the agent exec itself (ExecSpec.env), never
//     PreparedRun.env or SandboxSpec.env: those are container-wide, and sandboxSpecSchema refuses
//     *KEY* names there anyway
//   KIMI_DISABLE_TELEMETRY=1, KIMI_CODE_NO_AUTO_UPDATE=1; rg and fd ship in the image
//   stream-json carries no usage: spend comes from LiteLLM only

const home = `${SANDBOX_AGENT_HOME}/kimi`
const todo = (method: string) => notImplemented(`kimi.${method} (P5)`)

export function createKimiDriver(config: AgentDriverConfig): AgentDriver {
  const { imagePrefix } = parseAgentDriverConfig(config)
  return {
    id: 'kimi',
    image: `${imagePrefix}-kimi`,
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    async prepare() {
      throw todo('prepare')
    },
    command() {
      throw todo('command')
    },
    parseEvent: parseKimiEvent,
    sessionState(run) {
      const session = `sessions/${KIMI_WORKDIR_KEY}/${requireNativeSessionId(run)}`
      // The index is outside sessions/. Capture conversation state and per-agent journals,
      // never session logs, background process state, credentials or provider/MCP config.
      return {
        root: home,
        include: ['session_index.jsonl', `${session}/state.json`, `${session}/agents`],
        exclude: [],
      }
    },
    extractResult: extractJsonResult,
  }
}
