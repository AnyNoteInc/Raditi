import type { AgentDriver } from '@repo/domain'
import { notImplemented, SANDBOX_AGENT_HOME } from '@repo/domain'
import { parseAgentDriverConfig, type AgentDriverConfig } from './config.ts'

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
    parseEvent() {
      throw todo('parseEvent')
    },
    sessionState() {
      // An allowlist, not the whole home minus credentials/, logs/, bin/, updates/: config files
      // that may carry per-turn tokens never reach the snapshot.
      // TODO(P5): confirm where session_index.jsonl lives and include it if it is outside sessions/.
      return { root: home, include: ['sessions'], exclude: [] }
    },
    extractResult() {
      throw todo('extractResult')
    },
  }
}
