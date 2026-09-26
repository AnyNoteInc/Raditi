import type { SandboxProvider } from '@repo/domain'
import { assertSandboxSpec, badRequest, notImplemented } from '@repo/domain'
import type { SandboxConfig } from './config.ts'

// P2 implements this with dockerode: over the local Docker socket in the PoC (macOS: runc,
// Linux: runsc), later inside the `runner` role on sandbox VMs. The Docker API is never
// exposed over TCP. What P2 must hold to (spec §8, CLAUDE.md rule 5):
// - one container per turn, named raditi-turn-<taskId>-<turn>, labelled for the reconciler;
//   PID 1 is `tini -- sleep infinity`, everything else is exec;
// - bytes move only through exec stdin/stdout — never `docker cp` or the archive API
//   (gVisor overlay changes are invisible to the host, docker cp has a CVE history);
// - --runtime from SandboxSpec.runtime, --read-only, --cap-drop=ALL, no-new-privileges,
//   --user 10001:10001, cpu/memory (swap = memory)/pids limits, tmpfs for HOME and secrets
//   (the rootfs is always read-only: SandboxSpec has no switch for it),
//   an internal network without DNS whose only exit is sandbox-gw, --log-opt max-size.

export function createDockerSandboxProvider(config: SandboxConfig): SandboxProvider {
  const todo = (method: string) => notImplemented(`DockerSandboxProvider.${method} (P2)`)
  return {
    kind: 'docker',
    async create(spec) {
      // The policy is live before the adapter is: every spec is checked first (CLAUDE.md rule 5).
      assertSandboxSpec(spec)
      if (spec.runtime !== config.runtime) {
        throw badRequest(
          `Sandbox runtime ${spec.runtime} differs from SANDBOX_RUNTIME=${config.runtime}`,
        )
      }
      throw todo('create')
    },
    async get() {
      throw todo('get')
    },
    async list() {
      throw todo('list')
    },
  }
}
