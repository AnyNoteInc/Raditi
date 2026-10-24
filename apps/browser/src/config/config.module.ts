import { Global, Module, type DynamicModule } from '@nestjs/common'

import type { BrowserWorkerConfig } from './config.ts'

/** The configuration of the worker (loadBrowserConfig, or one a test builds by hand). */
export const BROWSER_CONFIG = Symbol('BROWSER_CONFIG')

/**
 * The configuration for every module of the worker: parsed before Nest exists, so a refusal is
 * printed before the app is built. Called once, by AppModule.forRoot.
 */
@Global()
@Module({})
export class BrowserConfigModule {
  static forRoot(config: BrowserWorkerConfig): DynamicModule {
    return {
      module: BrowserConfigModule,
      providers: [{ provide: BROWSER_CONFIG, useValue: config }],
      exports: [BROWSER_CONFIG],
    }
  }
}
