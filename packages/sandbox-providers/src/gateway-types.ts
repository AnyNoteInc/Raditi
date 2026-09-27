import type { NetworkPolicy, SandboxLabels } from '@repo/domain'

type GatewayPolicy = Extract<NetworkPolicy, { mode: 'gateway' }>

/** Trusted host infrastructure only; never exposed through the sandbox/domain port. */
export interface DockerGatewayManager {
  prepare(
    input: { labels: SandboxLabels; policy: GatewayPolicy; deadline: number },
    signal?: AbortSignal,
  ): Promise<{ networkMode: string; resourceId: string }>
  /** Inputs come from the main container's already verified labels and host config. */
  validate(input: {
    resourceId: string
    labels: SandboxLabels
    deadline: number
    policy: GatewayPolicy
    networkMode: string | undefined
  }): Promise<boolean>
  release(resourceId: string): Promise<void>
}
