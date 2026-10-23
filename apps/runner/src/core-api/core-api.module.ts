import { readFile } from 'node:fs/promises'

import { Module } from '@nestjs/common'

import type { RunnerConfig } from '../config/config.ts'
import { RUNNER_CONFIG } from '../config/config.tokens.ts'
import { VmTokenModule } from '../vm-token/vm-token.module.ts'
import { RUNNER_TOKEN } from '../vm-token/vm-token.tokens.ts'
import { HttpRunnerTransport } from './core-client.ts'

/** Core's runner API (RUNNER_CORE_URL) over HTTP(S), authorized by the VM token. */
@Module({
  imports: [VmTokenModule],
  providers: [
    {
      provide: HttpRunnerTransport,
      useFactory: async (config: RunnerConfig, token: string) =>
        new HttpRunnerTransport({
          coreUrl: config.coreUrl,
          token,
          ca: config.caFile ? await readFile(config.caFile) : null,
        }),
      inject: [RUNNER_CONFIG, RUNNER_TOKEN],
    },
  ],
  exports: [HttpRunnerTransport],
})
export class CoreApiModule {}
