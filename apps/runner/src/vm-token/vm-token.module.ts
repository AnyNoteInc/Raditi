import { Module } from '@nestjs/common'

import type { RunnerConfig } from '../config/config.ts'
import { RUNNER_CONFIG } from '../config/config.tokens.ts'
import { readRunnerToken } from './runner-token.ts'
import { RUNNER_TOKEN } from './vm-token.tokens.ts'

/** The VM token from RUNNER_TOKEN_FILE (spec §15), read once at start. */
@Module({
  providers: [
    {
      provide: RUNNER_TOKEN,
      useFactory: (config: RunnerConfig) => readRunnerToken(config.tokenFile, config.appEnv),
      inject: [RUNNER_CONFIG],
    },
  ],
  exports: [RUNNER_TOKEN],
})
export class VmTokenModule {}
