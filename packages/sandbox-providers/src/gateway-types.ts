import type { NetworkPolicy, SandboxLabels } from '@repo/domain'
import type Docker from 'dockerode'

/** Trusted host infrastructure only; never exposed through the sandbox/domain port. */
export interface DockerGatewayManager {
  prepare(
    input: {
      name: string
      labels: SandboxLabels
      policy: Extract<NetworkPolicy, { mode: 'gateway' }>
      deadline: number
    },
    signal?: AbortSignal,
  ): Promise<{ networkMode: string; resourceId: string; release(): Promise<void> }>
  validate(
    inspect: Docker.ContainerInspectInfo,
    policy: Extract<NetworkPolicy, { mode: 'gateway' }>,
  ): Promise<boolean>
  release(inspect: Docker.ContainerInspectInfo): Promise<void>
}
