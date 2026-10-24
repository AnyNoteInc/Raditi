import { Module } from '@nestjs/common'

import type { BrowserWorkerConfig } from '../config/config.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { WorkerModule } from '../worker/worker.module.ts'
import { WORKER_TOKEN } from './api.tokens.ts'
import { WorkerApiController } from './worker-api.controller.ts'
import { WorkerTokenGuard } from './worker-auth.guard.ts'

/**
 * The internal API of the sessions (`/v1/sessions`, docs/plan/57-browser-tasks.md, §3.5) for core
 * and mcp, behind BROWSER_WORKER_TOKEN. Its refusals take their shape from WorkerApiFilter, which
 * startBrowser sets for the whole app.
 */
@Module({
  imports: [WorkerModule],
  controllers: [WorkerApiController],
  providers: [
    {
      provide: WORKER_TOKEN,
      useFactory: (config: BrowserWorkerConfig): string => config.token,
      inject: [BROWSER_CONFIG],
    },
    WorkerTokenGuard,
  ],
})
export class ApiModule {}
