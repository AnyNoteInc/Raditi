import { Module } from '@nestjs/common'

import type { RunnerConfig } from '../config/config.ts'
import { RUNNER_CONFIG } from '../config/config.tokens.ts'
import { readRunnerToken, runnerIdOf } from './runner-token.ts'
import { RUNNER_ID, RUNNER_TOKEN } from './vm-token.tokens.ts'

/** The VM token from RUNNER_TOKEN_FILE (spec §15), read once at start, and the id it names. */
@Module({
  providers: [
    {
      provide: RUNNER_TOKEN,
      useFactory: (config: RunnerConfig) => readRunnerToken(config.tokenFile, config.appEnv),
      inject: [RUNNER_CONFIG],
    },
    { provide: RUNNER_ID, useFactory: runnerIdOf, inject: [RUNNER_TOKEN] },
  ],
  exports: [RUNNER_TOKEN, RUNNER_ID],
})
export class VmTokenModule {}
