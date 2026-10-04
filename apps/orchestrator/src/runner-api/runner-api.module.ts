import { Module } from '@nestjs/common'
import type { SiteLeaseStore, TurnAssignmentStore } from '@repo/domain'

import type { CoreConfig } from '../config/config.ts'
import { runnerCredentialAddress } from '../config/runner-tokens.ts'
import { CORE_CONFIG, SITE_LEASES, TURN_ASSIGNMENTS } from '../infra/tokens.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerApiServer } from './runner-api.server.ts'
import { RunnerAuthenticator } from './runner-auth.ts'
import { RunnerHub } from './runner-hub.ts'

/**
 * The runner API of the core role (TURN_EXECUTOR=runner). startCore opens its listener on
 * RUNNER_API_PORT next to the main port; RemoteTurnExecutor is the TurnExecutor it serves.
 */
@Module({
  providers: [
    {
      provide: RunnerHub,
      useFactory: (assignments: TurnAssignmentStore, leases: SiteLeaseStore) =>
        new RunnerHub({ assignments, leases }),
      inject: [TURN_ASSIGNMENTS, SITE_LEASES],
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
  exports: [RunnerHub, RunnerApiServer, RemoteTurnExecutor],
})
export class RunnerApiModule {}
