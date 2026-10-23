import { Global, Module, type DynamicModule } from '@nestjs/common'

import type { CoreConfig } from './config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from './config.tokens.ts'

export interface AppModuleOptions {
  config: CoreConfig
  /** Start BullMQ workers and polling loops; false in tests. */
  background: boolean
}

/**
 * The configuration for every module of the role: parsed before Nest exists (loadConfig), so a
 * refusal is printed before the app is built. Called once, by AppModule.forRoot.
 */
@Global()
@Module({})
export class CoreConfigModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: CoreConfigModule,
      providers: [
        { provide: CORE_CONFIG, useValue: options.config },
        { provide: BACKGROUND_JOBS, useValue: options.background },
      ],
      exports: [CORE_CONFIG, BACKGROUND_JOBS],
    }
  }
}
