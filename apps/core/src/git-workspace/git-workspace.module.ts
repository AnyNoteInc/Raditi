import {
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import type { GitCredentialLifecycle, ManagedGitProvider } from '@repo/git-providers'
import { BACKGROUND_JOBS } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, GIT_PROVIDER } from '../infra/tokens.ts'
import { configuredGitProvider, gitWorkspaceOptions } from './git-config.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'

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

/**
 * Git of site repositories for the core role (spec §10). Both providers are null while
 * CoreConfig.git is: core starts, and whoever runs turns must not start without them.
 */
@Module({
  providers: [
    {
      provide: GIT_PROVIDER,
      useFactory: (config: CoreConfig): ManagedGitProvider | null =>
        config.git ? configuredGitProvider(config.git) : null,
      inject: [CORE_CONFIG],
    },
    {
      provide: GitWorkspaceService,
      useFactory: (
        provider: ManagedGitProvider | null,
        config: CoreConfig,
      ): GitWorkspaceService | null =>
        provider && config.git
          ? new GitWorkspaceService(provider, gitWorkspaceOptions(config.git))
          : null,
      inject: [GIT_PROVIDER, CORE_CONFIG],
    },
    {
      provide: GitCredentialRuntime,
      useFactory: (provider: ManagedGitProvider | null, background: boolean) =>
        new GitCredentialRuntime(provider, background),
      inject: [GIT_PROVIDER, BACKGROUND_JOBS],
    },
  ],
  exports: [GIT_PROVIDER, GitWorkspaceService],
})
export class GitWorkspaceModule {}
