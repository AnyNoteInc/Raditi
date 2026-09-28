import { Module } from '@nestjs/common'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, SANDBOX_PROVIDER } from '../infra/tokens.ts'

/** Core drives Docker through the local socket only with TURN_EXECUTOR=local (PoC, tests). */
@Module({
  providers: [
    {
      provide: SANDBOX_PROVIDER,
      useFactory: (config: CoreConfig) => {
        if (!config.sandbox) throw new Error('Core drives no Docker with TURN_EXECUTOR=runner')
        return createDockerSandboxProvider(config.sandbox)
      },
      inject: [CORE_CONFIG],
    },
  ],
  exports: [SANDBOX_PROVIDER],
})
export class SandboxModule {}
