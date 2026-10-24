import { Module } from '@nestjs/common'
import { createPlaywrightCloudBrowser } from '@repo/browser-providers'
import type { BrowserSessionRuntime, CloudBrowserFactory } from '@repo/domain'
import { createDockerBrowserSessionRuntime } from '@repo/sandbox-providers'

import type { BrowserWorkerConfig } from '../config/config.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { CLOUD_BROWSERS, SESSION_RUNTIME } from './sessions.tokens.ts'

/**
 * What a session runs on: the containers of its Chromium (Docker, under runsc in production) and
 * Playwright, which connects to it. The session manager itself is the worker's (WorkerModule).
 */
@Module({
  providers: [
    {
      provide: SESSION_RUNTIME,
      useFactory: (config: BrowserWorkerConfig): BrowserSessionRuntime | null =>
        config.runtime && createDockerBrowserSessionRuntime(config.runtime),
      inject: [BROWSER_CONFIG],
    },
    {
      provide: CLOUD_BROWSERS,
      useFactory: (): CloudBrowserFactory => createPlaywrightCloudBrowser(),
    },
  ],
  exports: [SESSION_RUNTIME, CLOUD_BROWSERS],
})
export class SessionsModule {}
