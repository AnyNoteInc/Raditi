// Sandbox providers (spec §8): Docker with gVisor now, the `runner` role on sandbox VMs later.
export { sandboxConfigFromEnv, type SandboxConfig } from './config.ts'
export { createDockerSandboxProvider } from './docker.ts'
export * from './browser-session/index.ts'
// What the browser worker pins its session's images and runtime by.
export {
  sessionImageSchema,
  sessionRuntimes,
  type SessionRuntimeKind,
} from './browser-session/kit.ts'
// SANDBOX_EGRESS_REFUSED_SUBNETS: the same variable the sandbox gateway reads.
export { egressRefusedSubnetsVar } from './gateway/config.ts'
