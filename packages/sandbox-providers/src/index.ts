// Sandbox providers (spec §8): Docker with gVisor now, the `runner` role on sandbox VMs later.
export { sandboxConfigFromEnv, type SandboxConfig } from './config.ts'
export { createDockerSandboxProvider, type DockerSandboxProviderOptions } from './docker.ts'
export type { DockerGatewayManager } from './gateway-types.ts'
export { createDockerGatewayManager } from './gateway/manager.ts'
export { gatewayConfigFromEnv, type GatewayConfig } from './gateway/config.ts'
export { defaultSandboxLimits, type SandboxLimits } from './limits.ts'
