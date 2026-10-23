import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import type { GitCredentialLifecycle } from '@repo/git-providers'

/**
 * Git credentials do not outlive the process they were issued to (spec §10): what an earlier
 * process left is swept at start, what this one issued is revoked once the rest has stopped.
 * Both are best effort — every grant is still preceded by a sweep and ends at its own term.
 */
export class GitCredentialRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly provider: GitCredentialLifecycle | null,
    private readonly background: boolean,
    private readonly logger: { warn(message: string): void } = new Logger('GitCredentials'),
  ) {}

  /** Not awaited: core starts while the provider is down. */
  onApplicationBootstrap(): void {
    if (!this.background) return
    // A fixed message: an error of the provider is not for the log.
    void this.provider
      ?.sweepCredentials()
      .catch(() => this.logger.warn('git_credentials_sweep_failed'))
  }

  /** After onModuleDestroy and beforeApplicationShutdown: no turn is using a grant any more. */
  async onApplicationShutdown(): Promise<void> {
    await this.provider
      ?.revokeCredentials()
      .catch(() => this.logger.warn('git_credentials_revoke_failed'))
  }
}
