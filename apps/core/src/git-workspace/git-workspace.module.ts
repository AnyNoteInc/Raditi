import { Module } from '@nestjs/common'
import type { ManagedGitProvider } from '@repo/git-providers'

import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { configuredGitProvider, gitWorkspaceOptions } from './git-config.ts'
import { GitCredentialRuntime } from './git-credential-runtime.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { GIT_PROVIDER } from './git-workspace.tokens.ts'
import { StaleClonesSweep } from './stale-clones.ts'

/**
 * Git of site repositories for the core role (spec §10). Both providers are null while
 * CoreConfig.git is: core starts, and whoever runs turns must not start without them. Every
 * module that clones imports this one, and Nest initialises an imported module before the modules
 * that import it: the sweep of stale clones (StaleClonesSweep, at module init) has run before
 * anything can clone.
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
    {
      provide: StaleClonesSweep,
      useFactory: (config: CoreConfig) => new StaleClonesSweep(config.appEnv),
      inject: [CORE_CONFIG],
    },
  ],
  exports: [GIT_PROVIDER, GitWorkspaceService],
})
export class GitWorkspaceModule {}
