import type { SandboxResources } from '@repo/domain'
import { MAX_SANDBOX_RESOURCES, MAX_SANDBOX_TURN_MS, SANDBOX_GID, SANDBOX_UID } from '@repo/domain'

export interface SandboxLimits {
  readonly resources: Readonly<SandboxResources>
  /** Non-root user inside the container; rootfs is read-only. */
  readonly user: Readonly<{ uid: number; gid: number }>
  /** Hard limit for a whole agent turn. */
  readonly hardTimeoutMs: number
}

/**
 * CLAUDE.md rule 5 and spec §8: 2 vCPU, 4 GiB, 512 processes, uid 10001, 20 minutes a turn.
 * The defaults are the ceilings of sandboxSpecSchema in @repo/domain.
 */
export const defaultSandboxLimits: SandboxLimits = Object.freeze({
  resources: Object.freeze({ ...MAX_SANDBOX_RESOURCES }),
  user: Object.freeze({ uid: SANDBOX_UID, gid: SANDBOX_GID }),
  hardTimeoutMs: MAX_SANDBOX_TURN_MS,
})
