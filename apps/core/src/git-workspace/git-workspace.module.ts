import { Module } from '@nestjs/common'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { gitWorkerSocketPath } from '../git-worker/protocol.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { GIT_WORKSPACE } from './git-workspace.tokens.ts'
import { StaleOperationsSweep } from './stale-operations.ts'
import { GitWorkerClient } from './worker-client.ts'

/**
 * The trusted git of core (docs/plan/84-projects.md, ПР12, ПР33): the service that keeps the
 * mirrors and builds bundles and candidates, talking to the git worker over its socket on the
 * volume of GIT_MIRROR_DIR. Core runs no git itself. Imported by the sections that fetch and
 * publish (84.17, 84.18).
 */
@Module({
  providers: [
    {
      provide: GIT_WORKSPACE,
      inject: [CORE_CONFIG],
      useFactory: (config: CoreConfig) =>
        new GitWorkspaceService({
          runner: new GitWorkerClient(gitWorkerSocketPath(config.git.mirrorDir)),
          mirrorDir: config.git.mirrorDir,
          transport: { kind: 'https' },
        }),
    },
    {
      provide: StaleOperationsSweep,
      inject: [CORE_CONFIG],
      useFactory: (config: CoreConfig) =>
        new StaleOperationsSweep(config.appEnv, config.git.mirrorDir),
    },
  ],
  exports: [GIT_WORKSPACE],
})
export class GitWorkspaceModule {}
