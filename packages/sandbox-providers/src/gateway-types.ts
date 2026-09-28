import type { NetworkPolicy, SandboxLabels } from '@repo/domain'
import type Docker from 'dockerode'

type GatewayPolicy = Extract<NetworkPolicy, { mode: 'gateway' }>

/** How the sandbox container joins the attempt network; applied to its create options as is. */
export interface GatewayAttachment {
  resourceId: string
  networkMode: string
  extraHosts: string[]
  /** runsc only: the sandbox joins the attempt network directly at a fixed address. */
  endpoints?: Docker.EndpointsConfig
}

/** Trusted host infrastructure only; never exposed through the sandbox/domain port. */
export interface DockerGatewayManager {
  prepare(
    input: { labels: SandboxLabels; policy: GatewayPolicy; deadline: number },
    signal?: AbortSignal,
  ): Promise<GatewayAttachment>
  /** Inputs come from the main container's already verified labels; `sandbox` is its inspect. */
  validate(input: {
    resourceId: string
    labels: SandboxLabels
    deadline: number
    policy: GatewayPolicy
    sandbox: Docker.ContainerInspectInfo
  }): Promise<boolean>
  release(resourceId: string): Promise<void>
}
