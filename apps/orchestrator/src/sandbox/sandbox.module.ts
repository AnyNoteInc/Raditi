import { Module } from '@nestjs/common'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, SANDBOX_PROVIDER } from '../infra/tokens.ts'

/** In the PoC core drives Docker through the local socket; the runner role replaces it (P2). */
@Module({
  providers: [
    {
      provide: SANDBOX_PROVIDER,
      useFactory: (config: CoreConfig) => createDockerSandboxProvider(config.sandbox),
      inject: [CORE_CONFIG],
    },
  ],
  exports: [SANDBOX_PROVIDER],
})
export class SandboxModule {}
