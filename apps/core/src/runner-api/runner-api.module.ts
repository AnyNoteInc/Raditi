import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SiteLeaseStore, TurnAssignmentStore } from '@repo/domain'
import { PRISMA } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { runnerCredentialAddress } from '../config/runner-tokens.ts'
import { LeasesModule } from '../leases/leases.module.ts'
import { SITE_LEASES, TURN_ASSIGNMENTS } from '../leases/leases.tokens.ts'
import { openRunnerTasks } from '../turns/warm-turn-sandboxes.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerApiServer } from './runner-api.server.ts'
import { RunnerAuthenticator } from './runner-auth.ts'
import { RunnerHub } from './runner-hub.ts'

/**
 * The runner API of the core role (TURN_EXECUTOR=runner). startCore opens its listener on
 * RUNNER_API_PORT next to the main port (app.get(RunnerApiServer)); RemoteTurnExecutor is the
 * TurnExecutor it serves, the one the turn engine (TurnsModule) runs turns with.
 */
@Module({
  imports: [LeasesModule],
  providers: [
    {
      provide: RunnerHub,
      useFactory: (
        assignments: TurnAssignmentStore,
        leases: SiteLeaseStore,
        prisma: PrismaClient | null,
      ) =>
        new RunnerHub({
          assignments,
          leases,
          // The warm containers of the runners (docs/plan/93); without the database none waits.
          ...(prisma
            ? { openTasks: (runnerId, taskIds) => openRunnerTasks(prisma, runnerId, taskIds) }
            : {}),
        }),
      inject: [TURN_ASSIGNMENTS, SITE_LEASES, { token: PRISMA, optional: true }],
    },
    {
      provide: RunnerApiServer,
      useFactory: (hub: RunnerHub, config: CoreConfig) => {
        if (!config.runnerApi) throw new Error('The runner API needs RUNNER_TOKENS')
        return new RunnerApiServer(hub, new RunnerAuthenticator(config.runnerApi.tokens))
      },
      inject: [RunnerHub, CORE_CONFIG],
    },
    {
      provide: RemoteTurnExecutor,
      useFactory: (
        hub: RunnerHub,
        leases: SiteLeaseStore,
        assignments: TurnAssignmentStore,
        config: CoreConfig,
      ) =>
        // loadConfig refuses at start a runner bound to no single address (TURN_EXECUTOR=runner).
        new RemoteTurnExecutor(hub, leases, assignments, (id) => {
          if (!config.runnerApi) throw new Error('Runner credential source unavailable')
          return runnerCredentialAddress(config.runnerApi.tokens, id)
        }),
      inject: [RunnerHub, SITE_LEASES, TURN_ASSIGNMENTS, CORE_CONFIG],
    },
  ],
  exports: [RemoteTurnExecutor],
})
export class RunnerApiModule {}
