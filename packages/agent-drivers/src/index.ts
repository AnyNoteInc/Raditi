// CLI agent drivers (spec §8): every CLI-specific detail stays in its driver file.
export { agentDriverConfigFromEnv, type AgentDriverConfig } from './config.ts'
export { createOpencodeDriver } from './opencode.ts'
export {
  agentEventParser,
  createAgentDriverRegistry,
  createAgentDrivers,
  type AgentDriverRegistry,
} from './registry.ts'
